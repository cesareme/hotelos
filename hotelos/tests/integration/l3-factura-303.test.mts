/**
 * Tanda L3 · lote C/D — factura ↔ Modelo 303 de extremo a extremo (Postgres; tenant AISLADO).
 *
 * Emite por SERVICIO (createInvoiceFromFolio + issueInvoice) dos facturas en un tenant
 * `org_l2_<run>` creado con helpers/l2-tenant.mts, anula una (cancelInvoice → contrafilas
 * `#anulacion`), rectifica la otra por sustitución (createRectifyingInvoice «S» → filas de la
 * sustitutiva + contrafilas `#sustituida` de la original) y comprueba que el Modelo 303 del
 * periodo sale de los LIBROS con las cuotas netas y cuadra con el diario. Después materializa
 * los libros con rebuildVatBooks y exige el MISMO libro fila a fila (idempotencia: la
 * convención única `#anulacion` / `#sustituida`, 0 filas `:anulacion`, sin duplicados) y las
 * mismas casillas; una fila `:anulacion` heredada fuera del rango se purga en el rebuild.
 *
 * Fixtures (hoy, Europe/Madrid → trimestre en curso):
 *   · A: folio con «Habitación» 110,00 (alojamiento 10 %: base 100,00 · cuota 10,00) → FAC → ANULADA
 *   · B: folio con «Minibar (bebidas alcohólicas)» 24,20 (tipo general 21 %: base 20,00 · cuota 4,20)
 *        → FAC → sustituida por REC «S» de 12,10 (base 10,00 · cuota 2,10)
 *   Libro esperado (5 filas): +10,00 (A) − 10,00 (A#anulacion) + 4,20 (B) − 4,20 (B#sustituida) + 2,10 (REC)
 *   303: 06 = 0,00 · 07 = 10,00 · 09 = 2,10 · 27 = 2,10 · 45 = 0,00 · 71 = 2,10 · cuadra = true.
 *
 * Faranda es SOLO LECTURA: invariantes (helpers) y recuento de vat_book_entries por sourceType
 * idénticos antes y después. Nunca reinicia ni necesita el API :3000.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/l3-factura-303.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { IsolatedTenant, TenantUserKey } from "./helpers/l2-tenant.mts";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

// El helper fija DATABASE_URL (connection_limit), JWT_SECRET y ENCRYPTION_KEY antes de cargar Prisma: va primero.
const helper = await import("./helpers/l2-tenant.mts");
const { prisma } = await import("@hotelos/database");
const invoicing = await import("../../apps/api/src/modules/invoicing/invoice.service.js");
const { buildModelo303 } = await import("../../apps/api/src/modules/accounting/modelo-303.service.js");
const vatBooks = await import("../../apps/api/src/modules/accounting/vat-books.service.js");
const { flushVerifactuQueue } = await import("../../apps/api/src/modules/invoicing/verifactu-submission.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type Report = Awaited<ReturnType<typeof buildModelo303>>;
type BookRow = { book: string; sourceType: string; sourceId: string; rate: number; base: number; quota: number; total: number; date: string; period: string };

const RUN = helper.newRunId();
const CUSTOMER_NIF = "B12345674";
const periodo = vatBooks.fiscalPeriodForDate(vatBooks.madridDay(new Date()), "quarterly");

let tenant: IsolatedTenant;
let folioA = "";
let folioB = "";
let invoiceA = "";
let invoiceB = "";
let rectificationId = "";
let farandaBefore: Awaited<ReturnType<typeof helper.farandaInvariants>>;
let farandaBooksBefore: Record<string, number>;
let reportBefore: Report;
let bookBefore: BookRow[];

const ctxOf = (user: TenantUserKey, permissions: string[], extra: Record<string, unknown> = {}): UserContext =>
  ({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, userId: tenant.users[user].id, fullName: tenant.users[user].fullName, deviceId: `l3c-${RUN}`, permissions, orgScope: true, ...extra }) as unknown as UserContext;
/** Quien emite (recepción del hotel A). */
const issuer = (): UserContext => ctxOf("receptionist", ["invoice.issue", "invoice.read", "folio.charge.post"]);
/** Tanda 8a §4.7: la anulación la registra OTRA persona (emisor ≠ anulador) con la autorización del motor L1; aquí la vía privilegiada (plataforma), auditada, como structure-l3-fixes. */
const canceller = (): UserContext => ctxOf("systems", ["invoice.cancel"], { isPlatformAdmin: true });
/** Quien lee el 303 de toda la sociedad y materializa los libros. */
const accountant = (): UserContext => ctxOf("owner", ["accounting.read", "accounting.entity.read", "accounting.configure"]);

const casilla = (report: Report, code: string): number => {
  const box = report.casillas.find((entry) => entry.casilla === code);
  assert.ok(box, `casilla ${code} missing`);
  return box.importe;
};

async function farandaBookCounts(): Promise<Record<string, number>> {
  const groups = await prisma.vatBookEntry.groupBy({ by: ["sourceType"], where: { organizationId: helper.FARANDA_ORG }, _count: { _all: true }, orderBy: { sourceType: "asc" } });
  return Object.fromEntries(groups.map((group) => [group.sourceType, group._count._all]));
}

/** El libro de emitidas del tenant, normalizado y ordenado: lo que un rebuild debe reproducir fila a fila. */
async function tenantBook(): Promise<BookRow[]> {
  const rows = await prisma.vatBookEntry.findMany({ where: { organizationId: tenant.organizationId }, orderBy: [{ sourceId: "asc" }, { rate: "asc" }] });
  return rows.map((row) => ({ book: row.book, sourceType: row.sourceType, sourceId: row.sourceId, rate: Number(row.rate), base: Number(row.base), quota: Number(row.quota), total: Number(row.total), date: row.date.toISOString().slice(0, 10), period: row.period }));
}

async function newFolio(code: string): Promise<string> {
  const reservation = await prisma.reservation.create({
    data: { propertyId: tenant.propertyA, code, channel: "direct", status: "checked_in", arrivalDate: new Date("2026-10-01T00:00:00Z"), departureDate: new Date("2026-10-02T00:00:00Z"), bookerName: `Prueba L3 ${code}`, currency: "EUR" },
    select: { id: true }
  });
  const folio = await prisma.folio.create({ data: { reservationId: reservation.id, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } });
  return folio.id;
}

before(async () => {
  farandaBefore = await helper.farandaInvariants();
  farandaBooksBefore = await farandaBookCounts();
  tenant = await helper.createIsolatedTenant(RUN);
  folioA = await newFolio(`L3C-A-${RUN}`);
  folioB = await newFolio(`L3C-B-${RUN}`);
  // Cargos del folio por Prisma (sin eventos): el tipo de línea decide la categoría fiscal salvo override explícito
  // (FolioLine.taxCategory, contrato Tanda 3): las bebidas alcohólicas del minibar tributan al tipo general (21 %).
  await prisma.folioLine.create({ data: { folioId: folioA, type: "room", description: "Habitación", quantity: 1, unitPrice: "110.00", total: "110.00", taxCategory: "accommodation", postedBy: tenant.users.receptionist.id } });
  await prisma.folioLine.create({ data: { folioId: folioB, type: "minibar", description: "Minibar (bebidas alcohólicas)", quantity: 1, unitPrice: "24.20", total: "24.20", taxCategory: "general_services", postedBy: tenant.users.receptionist.id } });
});

after(async () => {
  try {
    await flushVerifactuQueue();
    await flushAuditQueues();
    if (tenant) await helper.cleanupTenant(tenant.organizationId);
    if (tenant) assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "la organización aislada se ha borrado (sin residuos propios)");
    // Faranda: idéntica antes y después (las suites hermanas de test:integration escriben y limpian Faranda en
    // paralelo: se espera ≤ 10 s a que vuelvan a las cifras de partida, como en las suites L2).
    let current = await helper.farandaInvariants();
    for (let attempt = 0; attempt < 20 && JSON.stringify(current) !== JSON.stringify(farandaBefore); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      current = await helper.farandaInvariants();
    }
    assert.deepEqual(current, farandaBefore, "Faranda no cambia");
    assert.deepEqual(await farandaBookCounts(), farandaBooksBefore, "vat_book_entries de Faranda idéntico antes y después");
  } finally {
    await prisma.$disconnect();
  }
});

describe("L3 · factura ↔ Modelo 303 (tenant aislado, libros vivos + rebuild)", () => {
  it("emite dos facturas desde folio (10 % alojamiento · 21 % minibar): libro de emitidas vivo y asiento de cada una", async () => {
    const draftA = await invoicing.createInvoiceFromFolio({ context: issuer(), folioId: folioA, customerType: "company", customerTaxId: CUSTOMER_NIF, customerName: "Cliente Norte SL", correlationId: `l3c-draft-a-${RUN}` });
    assert.equal(draftA.status, "draft");
    const issuedA = await invoicing.issueInvoice({ context: issuer(), invoiceId: draftA.id, correlationId: `l3c-issue-a-${RUN}` });
    invoiceA = issuedA.id;
    assert.equal(issuedA.status, "issued");
    assert.ok(issuedA.invoiceNumber, "numbered");
    assert.deepEqual([issuedA.total, issuedA.taxTotal], [110, 10]);

    const draftB = await invoicing.createInvoiceFromFolio({ context: issuer(), folioId: folioB, customerType: "company", customerTaxId: CUSTOMER_NIF, customerName: "Cliente Sur SL", correlationId: `l3c-draft-b-${RUN}` });
    const issuedB = await invoicing.issueInvoice({ context: issuer(), invoiceId: draftB.id, correlationId: `l3c-issue-b-${RUN}` });
    invoiceB = issuedB.id;
    assert.equal(issuedB.status, "issued");
    assert.deepEqual([issuedB.total, issuedB.taxTotal], [24.2, 4.2]);

    const book = await tenantBook();
    assert.deepEqual(
      book.map((row) => [row.sourceType, row.sourceId, row.rate, row.base, row.quota]),
      [
        ["invoice", invoiceA, 10, 100, 10],
        ["invoice", invoiceB, 21, 20, 4.2]
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    );
    assert.ok(book.every((row) => row.period === periodo.code && row.date >= periodo.from && row.date <= periodo.to), "filas del trimestre en curso");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: tenant.organizationId, sourceType: "invoice", sourceId: { in: [invoiceA, invoiceB] }, status: "posted" } }), 2);
  });

  it("anula la del 10 %: contrafilas #anulacion (misma convención que el emisor) y reverso marcado del asiento", async () => {
    const cancelled = await invoicing.cancelInvoice({ context: canceller(), invoiceId: invoiceA, reason: "prueba L3-C", correlationId: `l3c-cancel-${RUN}` });
    assert.equal(cancelled.status, "cancelled");
    const counter = await prisma.vatBookEntry.findMany({ where: { organizationId: tenant.organizationId, sourceId: vatBooks.cancellationSourceId(invoiceA) } });
    assert.equal(counter.length, 1);
    assert.deepEqual([counter[0]!.sourceType, Number(counter[0]!.rate), Number(counter[0]!.base), Number(counter[0]!.quota)], ["invoice", 10, -100, -10]);
    assert.equal(await prisma.vatBookEntry.count({ where: { organizationId: tenant.organizationId, sourceId: vatBooks.legacyCancellationSourceId(invoiceA) } }), 0, "nunca se escribe :anulacion");
    const original = await prisma.journalEntry.findFirst({ where: { organizationId: tenant.organizationId, sourceType: "invoice", sourceId: invoiceA }, select: { status: true, reversedById: true } });
    assert.equal(original?.status, "reversed");
    assert.ok(original?.reversedById, "reverso enlazado");
  });

  it("rectifica la del 21 % por sustitución («S»): filas de la sustitutiva + contrafilas #sustituida de la original", async () => {
    const rect = await invoicing.createRectifyingInvoice({
      context: issuer(),
      originalInvoiceId: invoiceB,
      reasonCode: "R1",
      rectificationType: "S",
      substituteLines: [{ description: "Minibar (bebidas alcohólicas, corregido)", quantity: 1, unitPrice: 12.1, lineType: "minibar", taxCategory: "general_services" }],
      correlationId: `l3c-rect-${RUN}`
    });
    rectificationId = rect.id;
    assert.equal(rect.rectification.idempotent, false);
    assert.deepEqual([rect.status, rect.rectificationType, rect.total, rect.taxTotal], ["issued", "S", 12.1, 2.1]);
    assert.equal((await prisma.invoice.findUnique({ where: { id: invoiceB }, select: { status: true } }))?.status, "rectified");
    const rows = await prisma.vatBookEntry.findMany({ where: { organizationId: tenant.organizationId, sourceId: { in: [rect.id, vatBooks.supersededSourceId(invoiceB)] } }, orderBy: { sourceId: "asc" } });
    assert.deepEqual(
      rows.map((row) => [row.sourceType, row.sourceId, Number(row.rate), Number(row.base), Number(row.quota)]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      [
        ["invoice", vatBooks.supersededSourceId(invoiceB), 21, -20, -4.2],
        ["rectification", rect.id, 21, 10, 2.1]
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    );
  });

  it("Modelo 303 del periodo desde los libros: 27 = Σ cuotas netas (emitida − anulada + rectificativa − original), origen libros, cuadra con el diario", async () => {
    reportBefore = await buildModelo303({ context: accountant(), period: periodo.code });
    const report = reportBefore;
    assert.equal(report.periodo.code, periodo.code);
    assert.equal(report.fuentes.origen, "libros");
    assert.equal(report.fuentes.registros, 5, "5 filas: A, A#anulacion, B, B#sustituida, REC");
    assert.equal(report.fuentes.libros?.emitidas?.filas, 5);
    // 10 %: 100 − 100 = 0 base, 10 − 10 = 0 cuota · 21 %: 20 − 20 + 10 = 10 base, 4,20 − 4,20 + 2,10 = 2,10 cuota.
    assert.deepEqual([casilla(report, "04"), casilla(report, "06")], [0, 0]);
    assert.deepEqual([casilla(report, "07"), casilla(report, "09")], [10, 2.1]);
    assert.deepEqual([casilla(report, "27"), casilla(report, "45"), casilla(report, "46"), casilla(report, "71")], [2.1, 0, 2.1, 2.1]);
    assert.deepEqual([report.totales.cuotaDevengada, report.totales.aIngresar], [2.1, 2.1]);
    assert.ok(report.fuentes.diario, "cotejo con el diario presente");
    assert.deepEqual(report.fuentes.diario.diferencias, [], report.avisos.join("\n"));
    assert.equal(report.fuentes.diario.cuadra, true, "libros y diario coinciden: la anulación y la sustitución netean igual en ambos");
    assert.equal(report.fuentes.diario.cuotaRepercutida, 2.1);
    assert.equal(report.fuentes.diario.cuotaSoportada, 0);
    assert.equal(report.avisos.some((aviso) => /sin contrafilas #sustituida/.test(aviso)), false, "el libro vivo ya lleva las contrafilas de la original sustituida");
    assert.equal(report.avisos.some((aviso) => /excluid/.test(aviso)), false, "sin exclusiones: no hay sombra OPERA ni liquidaciones de Sage en el tenant");
    bookBefore = await tenantBook();
    assert.equal(bookBefore.length, 5);
  });

  it("rebuild del rango: el libro se reproduce fila a fila (0 :anulacion, #anulacion y #sustituida presentes, sin duplicados) y el 303 no cambia; segundo rebuild idempotente", async () => {
    const first = await vatBooks.rebuildVatBooks({ context: accountant(), from: periodo.from, to: periodo.to });
    assert.deepEqual([first.deleted, first.created], [5, { emitidas: 5, recibidas: 0, bienes_inversion: 0 }]);
    assert.deepEqual(first.documentos, { facturas: 3, anulaciones: 2, facturasRecibidas: 0, gastos: 0 }, "3 documentos (A, B, REC) + 2 contrafilas (anulación, sustitución)");
    const bookAfter = await tenantBook();
    assert.equal(bookAfter.length, bookBefore.length, "mismo número de filas");
    assert.deepEqual(bookAfter, bookBefore, "el rebuild reproduce el libro vivo fila a fila (convención única)");
    assert.equal(bookAfter.filter((row) => row.sourceId.endsWith(":anulacion")).length, 0);
    assert.ok(bookAfter.some((row) => row.sourceId === vatBooks.cancellationSourceId(invoiceA)));
    assert.ok(bookAfter.some((row) => row.sourceId === vatBooks.supersededSourceId(invoiceB)));
    assert.equal(new Set(bookAfter.map((row) => `${row.book}|${row.sourceType}|${row.sourceId}|${row.rate}`)).size, bookAfter.length, "sin duplicados por clave");
    assert.equal(bookAfter.filter((row) => vatBooks.vatBookDocumentId(row.sourceId) === invoiceA).length, 2, "A: fila + contrafila");
    assert.equal(bookAfter.filter((row) => vatBooks.vatBookDocumentId(row.sourceId) === invoiceB).length, 2, "B: fila + contrafila");
    assert.equal(bookAfter.filter((row) => row.sourceId === rectificationId).length, 1);

    const report = await buildModelo303({ context: accountant(), period: periodo.code });
    assert.deepEqual(report.casillas, reportBefore.casillas, "mismas casillas tras materializar");
    assert.deepEqual([report.fuentes.origen, report.fuentes.registros, report.fuentes.diario?.cuadra], ["libros", 5, true]);

    const second = await vatBooks.rebuildVatBooks({ context: accountant(), from: periodo.from, to: periodo.to });
    assert.deepEqual([second.deleted, second.created.emitidas], [5, 5], "idempotente");
    assert.deepEqual(await tenantBook(), bookBefore);
  });

  it("una fila :anulacion heredada (convención anterior, fuera del rango) se purga en el rebuild y deja de contar dos veces", async () => {
    // Fila heredada de un rebuild anterior a L3-C: misma anulación de A con la convención `:anulacion`, fechada FUERA
    // del rango (el trimestre anterior), donde el borrado por fechas del rebuild no la alcanzaría.
    const legacyDay = new Date(`${periodo.from}T00:00:00.000Z`);
    legacyDay.setUTCDate(legacyDay.getUTCDate() - 1);
    const legacyPeriod = vatBooks.periodCodeForDate(legacyDay.toISOString().slice(0, 10), "quarterly");
    await prisma.vatBookEntry.create({
      data: { organizationId: tenant.organizationId, propertyId: tenant.propertyA, book: "emitidas", date: legacyDay, series: "FAC", number: "LEGADO", counterpartyNif: CUSTOMER_NIF, counterpartyName: "Cliente Norte SL", base: "-100.00", rate: "10.00", quota: "-10.00", total: "-110.00", retention: "0.00", taxFigure: "IVA", sourceType: "invoice", sourceId: vatBooks.legacyCancellationSourceId(invoiceA), period: legacyPeriod, deductible: true }
    });
    const previous = await buildModelo303({ context: accountant(), period: legacyPeriod });
    assert.equal(casilla(previous, "06"), -10, "con la fila heredada el trimestre anterior descuenta la anulación por segunda vez");

    const rebuilt = await vatBooks.rebuildVatBooks({ context: accountant(), from: periodo.from, to: periodo.to });
    assert.deepEqual([rebuilt.deleted, rebuilt.created.emitidas], [6, 5], "5 del rango + 1 heredada fuera del rango");
    assert.ok(rebuilt.avisos.some((aviso) => /convención anterior/.test(aviso)), rebuilt.avisos.join("\n"));
    assert.equal(await prisma.vatBookEntry.count({ where: { organizationId: tenant.organizationId, sourceId: { endsWith: ":anulacion" } } }), 0);
    assert.deepEqual(await tenantBook(), bookBefore, "el libro vuelve a ser el vivo, fila a fila");
    assert.equal(casilla(await buildModelo303({ context: accountant(), period: legacyPeriod }), "06"), 0);
    assert.deepEqual((await buildModelo303({ context: accountant(), period: periodo.code })).casillas, reportBefore.casillas);
  });

  it("Faranda solo lectura: invariantes y libros idénticos mientras la suite escribe en su tenant", async () => {
    assert.deepEqual(await helper.farandaInvariants(), farandaBefore);
    assert.deepEqual(await farandaBookCounts(), farandaBooksBefore);
  });
});
