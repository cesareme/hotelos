/**
 * Tanda ACT · lote L2 · integración (Postgres): tributos locales (IBI / IAE /
 * tasas), recibos, calendario y asiento 631 propuesto EN BORRADOR sobre un
 * tenant AISLADO (helpers/l2-tenant.mts, organización `org_l2_act…`) con un
 * usuario `asset_manager` asignado a la SOCIEDAD (scopeType legal_entity), auth
 * real y RBAC_STRICT; ejercicio 2026 abierto y 2025 cerrado creados con Prisma
 * en el tenant; Faranda y org_123 solo se leen (invariantes antes y después).
 * Las 9 rutas van cableadas en real-estate.register.ts → server.ts.
 *
 * Casos: alta de IBI y generación de previstos 2026 (anual y PAC 3 plazos suman
 * el importe) · recibido → pagado (bank) → propose-entry crea JournalEntry draft
 * D 631 / H 572 y guarda journalEntryId · segundo propose-entry 409
 * RECEIPT_ENTRY_EXISTS · taxpayer propietario_tercero 409 TAXPAYER_NOT_ENTITY ·
 * previsto sin importe 409 RECEIPT_NOT_PAYABLE · asset_manager no puede POST
 * /journal-entries/:id/post (403) · accountant contabiliza el borrador con POST
 * /journal-entries/:id/post y el DTO pasa a journalEntryStatus posted (+ enlace
 * manual y 409 FISCAL_YEAR_CLOSED propagado) · recibo de centro ajeno 404 ·
 * calendario y RBAC · auditoría.
 *
 * Sin nombres de personas: administraciones y sociedades ficticias.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/real-estate-taxes.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH", url: string, session: Session, payload?: unknown): Promise<Reply> {
  const res = await strict(() => app.inject({ method, url, headers: { ...session.headers }, ...(payload === undefined ? {} : { payload }) }));
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body };
}

const codeOf = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;

/** Usuario extra con una plantilla asignada a la SOCIEDAD del tenant (cubre los dos hoteles; barrido por cleanupTenant). */
async function addEntityUser(tenant: IsolatedTenant, key: string, templateKey: string): Promise<{ id: string; email: string }> {
  const id = `usr_act_${key}_${tenant.run}`;
  const email = `${key}.act.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `ACT ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: { userId: id, roleId, scopeType: "legal_entity", legalEntityId: tenant.legalEntityId, organizationId: tenant.organizationId, reason: `act ${key}` }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

const RUN_A = `acttx${newRunId()}`;
const RUN_B = `${RUN_A}b`;
const YEAR = 2026;
const TODAY = new Date().toISOString().slice(0, 10);
const isPast = (day: string): boolean => day < TODAY;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let assetManagerA: Session;
let receptionistA: Session;
let accountantA: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

const base = (propertyId: string) => `/properties/${propertyId}/real-estate`;

let ibiTaxId: string;
let ibiReceiptId: string;
let iaeTaxId: string;
let iaeReceiptIds: string[] = [];
let vadosReceiptId: string;
let draftEntryId: string;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  assert.ok(routePermissionManifest.some((entry) => entry.path === "/properties/:propertyId/real-estate/taxes" && entry.method === "GET"), "las rutas de tributos van cableadas en server.ts");
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  // Ejercicios de la sociedad: 2026 abierto (los borradores), 2025 cerrado (409 FISCAL_YEAR_CLOSED).
  await prisma.fiscalYear.createMany({
    data: [
      { organizationId: tenantA.organizationId, propertyId: null, code: String(YEAR), startDate: new Date(`${YEAR}-01-01T00:00:00.000Z`), endDate: new Date(`${YEAR}-12-31T00:00:00.000Z`), status: "open" },
      { organizationId: tenantA.organizationId, propertyId: null, code: String(YEAR - 1), startDate: new Date(`${YEAR - 1}-01-01T00:00:00.000Z`), endDate: new Date(`${YEAR - 1}-12-31T00:00:00.000Z`), status: "closed", closedAt: new Date() }
    ]
  });
  const manager = await addEntityUser(tenantA, "activos", "asset_manager");
  assetManagerA = await strict(() => loginOrThrow(app, manager.email, tenantA.password));
  receptionistA = await strict(() => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  accountantA = await strict(() => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
  ownerB = await strict(() => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
  const asset = await call(app, "POST", base(tenantA.propertyA), assetManagerA, { name: "Hotel de prueba ACT-L2", roomsCount: 120, cadastralValueTotal: "3250000.00", cadastralValueYear: 2025 });
  assert.equal(asset.status, 201, JSON.stringify(asset.body));
});

after(async () => {
  try {
    await flushAuditQueues();
    if (tenantA) await cleanupTenant(tenantA.organizationId);
    if (tenantB) await cleanupTenant(tenantB.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: { in: [tenantA?.organizationId ?? "", tenantB?.organizationId ?? ""] } } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
  }
});

describe("ACT-L2 · tributos y recibos previstos", () => {
  it("alta de IBI y generación de previstos 2026 (anual y PAC 3 plazos suman el importe)", async () => {
    const empty = await call(app, "GET", `${base(tenantA.propertyA)}/taxes`, assetManagerA);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body, []);

    const ibi = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, { kind: "ibi", authorityName: "Ayuntamiento de prueba", fiscalReference: "IBI-0001234", taxBase: "3250000.00", ratePct: "0.4525", expectedAnnualAmount: "12000.00", legalBasis: "Ordenanza fiscal de prueba" });
    assert.equal(ibi.status, 201, JSON.stringify(ibi.body));
    ibiTaxId = ibi.body.id;
    assert.equal(ibi.body.propertyId, tenantA.propertyA);
    assert.equal(ibi.body.organizationId, tenantA.organizationId);
    assert.equal(ibi.body.taxpayer, "sociedad", "contribuyente por defecto: la sociedad");
    assert.equal(ibi.body.accountCode, "631", "cuenta por defecto");
    assert.equal(ibi.body.capitalizable, false);
    assert.equal(ibi.body.periodicity, "anual");
    assert.equal(ibi.body.status, "activo");
    assert.equal(ibi.body.ratePct, "0.4525", "tipo de gravamen con cuatro decimales");
    assert.equal(ibi.body.expectedAnnualAmount, "12000.00");
    assert.equal(ibi.body.ineMunicipalityCode, null, "el centro de prueba no tiene INE → supletorio LGT 62.3");
    assert.deepEqual(ibi.body.receipts, []);

    const generated = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${ibiTaxId}/receipts/generate`, assetManagerA, { year: YEAR });
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    assert.equal(generated.body.year, YEAR);
    assert.equal(generated.body.existing, 0);
    assert.equal(generated.body.created.length, 1, "anual: un previsto");
    const anual = generated.body.created[0];
    ibiReceiptId = anual.id;
    assert.equal(anual.taxId, ibiTaxId);
    assert.equal(anual.period, "anual");
    assert.equal(anual.status, "previsto");
    assert.equal(anual.amount, "12000.00");
    assert.equal(anual.surchargeAmount, "0.00");
    assert.equal(anual.dueFrom, `${YEAR}-09-01`, "supletorio: 1 de septiembre");
    assert.equal(anual.dueTo, `${YEAR}-11-20`, "supletorio: 20 de noviembre");
    assert.equal(anual.overdue, isPast(`${YEAR}-11-20`));
    assert.equal(anual.journalEntryId, null);
    assert.equal(anual.journalEntryStatus, null);

    const again = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${ibiTaxId}/receipts/generate`, assetManagerA, { year: YEAR });
    assert.equal(again.status, 200, "idempotente: nada nuevo");
    assert.deepEqual(again.body.created, []);
    assert.equal(again.body.existing, 1);
    assert.equal(again.body.receipts.length, 1);
    assert.equal((await prisma.propertyTaxReceipt.count({ where: { taxId: ibiTaxId } })), 1, "@@unique([taxId, fiscalYear, period])");

    const iae = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, {
      kind: "iae",
      authorityName: "Ayuntamiento de prueba",
      fiscalReference: "IAE-987",
      expectedAnnualAmount: "1000.00",
      installmentsJson: [
        { label: "PAC-01", dueFrom: "03-01", dueTo: "03-31", pct: "33.33" },
        { label: "PAC-02", dueFrom: "06-01", dueTo: "06-30", pct: "33.33" },
        { label: "PAC-03", dueFrom: "09-01", dueTo: "09-30", pct: "33.34" }
      ]
    });
    assert.equal(iae.status, 201, JSON.stringify(iae.body));
    iaeTaxId = iae.body.id;
    assert.deepEqual(
      iae.body.installmentsJson.map((item: Json) => item.pct),
      ["33.33", "33.33", "33.34"],
      "los plazos se guardan como JSON plano con pct de dos decimales"
    );
    const pac = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${iaeTaxId}/receipts/generate`, assetManagerA, { year: YEAR });
    assert.equal(pac.status, 201, JSON.stringify(pac.body));
    assert.equal(pac.body.created.length, 3, "PAC: tres previstos");
    const byPeriod = new Map<string, Json>(pac.body.receipts.map((receipt: Json) => [receipt.period, receipt]));
    assert.deepEqual([...byPeriod.keys()].sort(), ["PAC-01", "PAC-02", "PAC-03"]);
    assert.equal(byPeriod.get("PAC-01")?.amount, "333.30");
    assert.equal(byPeriod.get("PAC-02")?.amount, "333.30");
    assert.equal(byPeriod.get("PAC-03")?.amount, "333.40", "el último plazo absorbe los céntimos");
    const sum = pac.body.receipts.reduce((acc: number, receipt: Json) => acc + Math.round(Number(receipt.amount) * 100), 0);
    assert.equal(sum, 100000, "los tres plazos suman exactamente el importe anual");
    assert.equal(byPeriod.get("PAC-01")?.dueTo, `${YEAR}-03-31`);
    assert.equal(byPeriod.get("PAC-01")?.overdue, isPast(`${YEAR}-03-31`));
    assert.equal(byPeriod.get("PAC-03")?.overdue, isPast(`${YEAR}-09-30`));
    iaeReceiptIds = ["PAC-01", "PAC-02", "PAC-03"].map((period) => byPeriod.get(period)!.id as string);

    const listed = await call(app, "GET", `${base(tenantA.propertyA)}/taxes?year=${YEAR}`, assetManagerA);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.length, 2);
    assert.equal(listed.body.find((tax: Json) => tax.id === ibiTaxId).receipts.length, 1);
    assert.equal(listed.body.find((tax: Json) => tax.id === iaeTaxId).receipts.length, 3);
    const onlyIbi = await call(app, "GET", `${base(tenantA.propertyA)}/taxes?kind=ibi`, assetManagerA);
    assert.equal(onlyIbi.body.length, 1);
    const otherYear = await call(app, "GET", `${base(tenantA.propertyA)}/taxes?year=${YEAR - 3}`, assetManagerA);
    assert.equal(otherYear.body.length, 2, "el año filtra los recibos, no los tributos");
    assert.ok(otherYear.body.every((tax: Json) => tax.receipts.length === 0));

    const receipts = await call(app, "GET", `${base(tenantA.propertyA)}/receipts?year=${YEAR}`, assetManagerA);
    assert.equal(receipts.status, 200, JSON.stringify(receipts.body));
    assert.equal(receipts.body.length, 4);
    assert.ok(receipts.body.every((receipt: Json) => receipt.tax && ["ibi", "iae"].includes(receipt.tax.kind)), "cada recibo lleva el resumen de su tributo");

    const badYear = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${ibiTaxId}/receipts/generate`, assetManagerA, { year: "2026" });
    assert.equal(badYear.status, 400);
    assert.equal(codeOf(badYear), "VALIDATION_ERROR");
    const halfWindow = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, { kind: "residuos", authorityName: "Ayuntamiento de prueba", voluntaryFrom: "04-01" });
    assert.equal(halfWindow.status, 400, "voluntaryFrom y voluntaryTo van juntos");
    const patched = await call(app, "PATCH", `${base(tenantA.propertyA)}/taxes/${ibiTaxId}`, assetManagerA, { directDebit: true, directDebitBonusPct: "5" });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.directDebit, true);
    assert.equal(patched.body.directDebitBonusPct, "5.00");
    assert.equal(patched.body.receipts.length, 1, "el PATCH devuelve el tributo con sus recibos");
    const unknownTax = await call(app, "PATCH", `${base(tenantA.propertyA)}/taxes/ptx_no_existe`, assetManagerA, { directDebit: false });
    assert.equal(unknownTax.status, 404);
  });
});

describe("ACT-L2 · asiento 631 propuesto en borrador (§6)", () => {
  it("recibido → pagado (bank) → propose-entry crea JournalEntry draft D 631 / H 572 y guarda journalEntryId", async () => {
    const received = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${ibiReceiptId}`, assetManagerA, { status: "recibido", issuedAt: `${YEAR}-09-15` });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.status, "recibido");
    assert.equal(received.body.issuedAt, `${YEAR}-09-15`);
    assert.equal(received.body.paidAt, null);

    const paid = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${ibiReceiptId}`, assetManagerA, { status: "pagado", paidAt: `${YEAR}-10-15`, paidWith: "bank" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "pagado");
    assert.equal(paid.body.paidAt, `${YEAR}-10-15`);
    assert.equal(paid.body.paidWith, "bank");
    assert.equal(paid.body.overdue, false);
    assert.equal(paid.body.journalEntryId, null, "pagar no contabiliza nada");
    assert.equal((await prisma.journalEntry.count({ where: { organizationId: tenantA.organizationId } })), 0, "ningún asiento hasta proponerlo");

    const proposed = await call(app, "POST", `${base(tenantA.propertyA)}/receipts/${ibiReceiptId}/propose-entry`, assetManagerA);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    assert.equal(typeof proposed.body.journalEntryId, "string");
    assert.equal(proposed.body.journalEntryStatus, "draft");
    assert.equal(proposed.body.status, "pagado");
    draftEntryId = proposed.body.journalEntryId;

    const entry = await prisma.journalEntry.findUnique({ where: { id: draftEntryId } });
    assert.ok(entry, "el borrador existe");
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: draftEntryId }, orderBy: { accountCode: "asc" } });
    assert.equal(entry.status, "draft");
    assert.equal(entry.entryNumber, null, "un borrador no se numera");
    assert.equal(entry.organizationId, tenantA.organizationId);
    assert.equal(entry.propertyId, tenantA.propertyA, "el centro va en propertyId");
    assert.equal(entry.sourceType, "property_tax_receipt");
    assert.equal(entry.sourceId, ibiReceiptId);
    assert.equal(entry.entryDate.toISOString().slice(0, 10), `${YEAR}-10-15`, "fecha contable = paidAt");
    assert.equal(entry.description, `IBI ${YEAR} · L2A · IBI-0001234`);
    assert.equal(entry.reference, "IBI-0001234");
    assert.deepEqual(
      lines.map((line) => [line.accountCode, Number(line.debit).toFixed(2), Number(line.credit).toFixed(2)]),
      [
        ["572", "0.00", "12000.00"],
        ["631", "12000.00", "0.00"]
      ],
      "D 631 / H 572 por 12.000,00"
    );

    const listed = await call(app, "GET", `${base(tenantA.propertyA)}/receipts?year=${YEAR}`, assetManagerA);
    const stored = listed.body.find((receipt: Json) => receipt.id === ibiReceiptId);
    assert.equal(stored.journalEntryId, draftEntryId, "journalEntryId guardado en el recibo");
    assert.equal(stored.journalEntryStatus, "draft");

    const frozen = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${ibiReceiptId}`, assetManagerA, { amount: "12500.00" });
    assert.equal(frozen.status, 409, "con asiento enlazado los importes quedan congelados");
    assert.equal(codeOf(frozen), "RECEIPT_ENTRY_EXISTS");
    const notes = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${ibiReceiptId}`, assetManagerA, { notes: "Recibo domiciliado en la cuenta principal." });
    assert.equal(notes.status, 200, "los campos descriptivos siguen editables");
    const final = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${ibiReceiptId}`, assetManagerA, { status: "recibido" });
    assert.equal(final.status, 409, "pagado no vuelve atrás");
    assert.equal(codeOf(final), "RECEIPT_NOT_PAYABLE");
    assert.deepEqual(final.body.details.allowed, ["recurrido"], "ACT-REV-10: desde pagado solo «Recurrir»");
  });

  it("segundo propose-entry 409 RECEIPT_ENTRY_EXISTS", async () => {
    const twice = await call(app, "POST", `${base(tenantA.propertyA)}/receipts/${ibiReceiptId}/propose-entry`, assetManagerA);
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
    assert.equal(codeOf(twice), "RECEIPT_ENTRY_EXISTS");
    assert.equal(twice.body.details.journalEntryId, draftEntryId);
    assert.equal((await prisma.journalEntry.count({ where: { organizationId: tenantA.organizationId, sourceType: "property_tax_receipt", sourceId: ibiReceiptId } })), 1, "un solo asiento por recibo");
  });

  it("taxpayer propietario_tercero 409 TAXPAYER_NOT_ENTITY", async () => {
    const tax = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, { kind: "residuos", taxpayer: "propietario_tercero", authorityName: "Ayuntamiento de prueba", expectedAnnualAmount: "420.00" });
    assert.equal(tax.status, 201, JSON.stringify(tax.body));
    assert.equal(tax.body.taxpayer, "propietario_tercero");
    const manual = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${tax.body.id}/receipts`, assetManagerA, { fiscalYear: YEAR, amount: "420.00", status: "recibido", issuedAt: `${YEAR}-09-10` });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    assert.equal(manual.body.period, "anual", "periodo por defecto");
    assert.equal(manual.body.status, "recibido");
    assert.equal(manual.body.dueFrom, `${YEAR}-09-01`, "sin ventana en el cuerpo: la del calendario del tributo");
    assert.equal(manual.body.dueTo, `${YEAR}-11-20`);
    const duplicate = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${tax.body.id}/receipts`, assetManagerA, { fiscalYear: YEAR, amount: "1.00" });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(codeOf(duplicate), "RECEIPT_ALREADY_EXISTS");
    assert.equal(duplicate.body.details.receiptId, manual.body.id);
    const proposed = await call(app, "POST", `${base(tenantA.propertyA)}/receipts/${manual.body.id}/propose-entry`, assetManagerA);
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.equal(codeOf(proposed), "TAXPAYER_NOT_ENTITY");
    assert.equal(proposed.body.details.taxpayer, "propietario_tercero");
    assert.equal((await prisma.journalEntry.count({ where: { organizationId: tenantA.organizationId, sourceId: manual.body.id } })), 0, "nada escrito");
  });

  it("previsto sin importe 409 RECEIPT_NOT_PAYABLE", async () => {
    const vados = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, { kind: "vados", authorityName: "Ayuntamiento de prueba" });
    assert.equal(vados.status, 201, JSON.stringify(vados.body));
    const generated = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${vados.body.id}/receipts/generate`, assetManagerA, { year: YEAR });
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    assert.equal(generated.body.created.length, 1);
    vadosReceiptId = generated.body.created[0].id;
    assert.equal(generated.body.created[0].amount, "0.00", "sin importe anual previsto");
    assert.equal(generated.body.created[0].status, "previsto");

    const proposed = await call(app, "POST", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}/propose-entry`, assetManagerA);
    assert.equal(proposed.status, 409, JSON.stringify(proposed.body));
    assert.equal(codeOf(proposed), "RECEIPT_NOT_PAYABLE");
    const pay = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}`, assetManagerA, { status: "pagado" });
    assert.equal(pay.status, 409, "no se paga sin importe");
    assert.equal(codeOf(pay), "RECEIPT_NOT_PAYABLE");
    assert.equal((await prisma.propertyTaxReceipt.findUnique({ where: { id: vadosReceiptId }, select: { status: true } }))?.status, "previsto", "sin cambio");

    const received = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}`, assetManagerA, { status: "recibido" });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    const stillZero = await call(app, "POST", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}/propose-entry`, assetManagerA);
    assert.equal(stillZero.status, 409, "recibido pero sin importe");
    assert.equal(codeOf(stillZero), "RECEIPT_NOT_PAYABLE");

    // Recurrir no impide pagar: recibido → recurrido → pagado (con importe, paidAt y paidWith por defecto).
    const appealed = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}`, assetManagerA, { status: "recurrido", appealRef: "REC-2026-001", amount: "180.00" });
    assert.equal(appealed.status, 200, JSON.stringify(appealed.body));
    assert.equal(appealed.body.status, "recurrido");
    assert.equal(appealed.body.appealRef, "REC-2026-001");
    const paidAnyway = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}`, assetManagerA, { status: "pagado" });
    assert.equal(paidAnyway.status, 200, JSON.stringify(paidAnyway.body));
    assert.equal(paidAnyway.body.status, "pagado");
    assert.equal(paidAnyway.body.paidAt, TODAY, "paidAt por defecto: hoy");
    assert.equal(paidAnyway.body.paidWith, "bank", "paidWith por defecto: banco");
    // ACT-REV-10 (diseño §5.1): «Recurrir» también desde pagado; conserva paidAt / paidWith y no está vencido.
    const back = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}`, assetManagerA, { status: "recurrido", appealRef: "REC-2026-002" });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.status, "recurrido");
    assert.equal(back.body.paidAt, TODAY, "el pago no se pierde al recurrir");
    assert.equal(back.body.paidWith, "bank");
    assert.equal(back.body.overdue, false);
    const backAgain = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${vadosReceiptId}`, assetManagerA, { status: "recibido" });
    assert.equal(backAgain.status, 409, "recurrido → recibido no está en la máquina");
    assert.equal(codeOf(backAgain), "RECEIPT_NOT_PAYABLE");
    const inactive = await call(app, "PATCH", `${base(tenantA.propertyA)}/taxes/${vados.body.id}`, assetManagerA, { status: "baja" });
    assert.equal(inactive.status, 200);
    const noGenerate = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${vados.body.id}/receipts/generate`, assetManagerA, { year: YEAR + 1 });
    assert.equal(noGenerate.status, 409, "un tributo de baja no genera previstos");
    assert.equal(codeOf(noGenerate), "PROPERTY_TAX_INACTIVE");
  });

  it("asset_manager no puede POST /journal-entries/:id/post (403)", async () => {
    const forbidden = await call(app, "POST", `/journal-entries/${draftEntryId}/post`, assetManagerA);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    assert.equal((await prisma.journalEntry.findUnique({ where: { id: draftEntryId }, select: { status: true } }))?.status, "draft", "sigue en borrador");
  });

  it("accountant contabiliza el borrador con POST /journal-entries/:id/post (server.ts) y el DTO pasa a journalEntryStatus posted", async () => {
    const posted = await call(app, "POST", `/journal-entries/${draftEntryId}/post`, accountantA);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.status, "posted");
    const row = await prisma.journalEntry.findUnique({ where: { id: draftEntryId }, select: { status: true, entryNumber: true, fiscalYearCode: true } });
    assert.equal(row?.status, "posted");
    assert.ok((row?.entryNumber ?? 0) > 0, "numerado al contabilizar");
    assert.equal(row?.fiscalYearCode, String(YEAR));

    const listed = await call(app, "GET", `${base(tenantA.propertyA)}/receipts?year=${YEAR}`, assetManagerA);
    const stored = listed.body.find((receipt: Json) => receipt.id === ibiReceiptId);
    assert.equal(stored.journalEntryId, draftEntryId);
    assert.equal(stored.journalEntryStatus, "posted", "estado leído de JournalEntry.status");
    const taxes = await call(app, "GET", `${base(tenantA.propertyA)}/taxes?year=${YEAR}&kind=ibi`, assetManagerA);
    assert.equal(taxes.body[0].receipts[0].journalEntryStatus, "posted");

    // Ejercicio cerrado: el 409 FISCAL_YEAR_CLOSED del motor se propaga tal cual; el enlace manual admite un asiento contabilizado.
    const previous = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${iaeTaxId}/receipts`, assetManagerA, { fiscalYear: YEAR - 1, amount: "900.00", status: "recibido", dueFrom: `${YEAR - 1}-09-01`, dueTo: `${YEAR - 1}-11-20` });
    assert.equal(previous.status, 201, JSON.stringify(previous.body));
    assert.equal(previous.body.overdue, true, "vencido sin pagar");
    const closed = await call(app, "POST", `${base(tenantA.propertyA)}/receipts/${previous.body.id}/propose-entry`, assetManagerA);
    assert.equal(closed.status, 409, JSON.stringify(closed.body));
    assert.equal(codeOf(closed), "FISCAL_YEAR_CLOSED");
    assert.equal(closed.body.details.yearCode, String(YEAR - 1));
    assert.equal((await prisma.propertyTaxReceipt.findUnique({ where: { id: previous.body.id }, select: { journalEntryId: true } }))?.journalEntryId, null, "sin asiento");
    const unknownEntry = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${previous.body.id}`, assetManagerA, { journalEntryId: "je_no_existe" });
    assert.equal(unknownEntry.status, 404, "asiento inexistente: 404 opaco");
    const linked = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${previous.body.id}`, assetManagerA, { journalEntryId: draftEntryId });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.journalEntryId, draftEntryId);
    assert.equal(linked.body.journalEntryStatus, "posted");
    const unlinked = await call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${previous.body.id}`, assetManagerA, { journalEntryId: null });
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
    assert.equal(unlinked.body.journalEntryId, null);
    assert.equal(unlinked.body.journalEntryStatus, null);
  });
});

describe("ACT-L2 · tenencia, calendario, RBAC y auditoría", () => {
  it("recibo de centro ajeno 404", async () => {
    // Ids del centro A bajo el centro B (misma sociedad, sin ficha): nunca se resuelven fuera del centro.
    const crossPatch = await call(app, "PATCH", `${base(tenantA.propertyB)}/receipts/${ibiReceiptId}`, assetManagerA, { notes: "x" });
    assert.equal(crossPatch.status, 404, JSON.stringify(crossPatch.body));
    const crossPropose = await call(app, "POST", `${base(tenantA.propertyB)}/receipts/${iaeReceiptIds[1]}/propose-entry`, assetManagerA);
    assert.equal(crossPropose.status, 404, JSON.stringify(crossPropose.body));
    const crossGenerate = await call(app, "POST", `${base(tenantA.propertyB)}/taxes/${ibiTaxId}/receipts/generate`, assetManagerA, { year: YEAR });
    assert.equal(crossGenerate.status, 404, JSON.stringify(crossGenerate.body));
    const noAsset = await call(app, "GET", `${base(tenantA.propertyB)}/taxes`, assetManagerA);
    assert.equal(noAsset.status, 404);
    assert.equal(codeOf(noAsset), "ASSET_NOT_FOUND");
    // Organización B sobre el centro A: la guardia global de tenencia.
    const foreign = await call(app, "GET", `${base(tenantA.propertyA)}/taxes`, ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(foreign.body.message, "Propiedad no encontrada.");
    assert.equal((await prisma.propertyTaxReceipt.findUnique({ where: { id: ibiReceiptId }, select: { notes: true } }))?.notes, "Recibo domiciliado en la cuenta principal.", "nada escrito");
  });

  it("calendario del ejercicio: periodos voluntarios, vencimientos y pendientes de generar", async () => {
    const terrazas = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, { kind: "terrazas", authorityName: "Ayuntamiento de prueba", expectedAnnualAmount: "600.00" });
    assert.equal(terrazas.status, 201);
    const calendar = await call(app, "GET", `${base(tenantA.propertyA)}/tax-calendar?year=${YEAR}`, assetManagerA);
    assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
    assert.equal(calendar.body.year, YEAR);
    const events: Json[] = calendar.body.events;
    const ibiEnd = events.find((event) => event.entityId === ibiReceiptId && event.dueAt === `${YEAR}-11-20`);
    assert.ok(ibiEnd, "fin del periodo voluntario del IBI");
    assert.equal(ibiEnd.kind, "TAX_DUE");
    assert.equal(ibiEnd.label, `Pagado el 15/10/${YEAR} · IBI ${YEAR}`);
    assert.equal(ibiEnd.entityType, "property_tax_receipt");
    assert.equal(ibiEnd.propertyId, tenantA.propertyA);
    const pac1End = events.find((event) => event.entityId === iaeReceiptIds[0] && event.dueAt === `${YEAR}-03-31`);
    assert.ok(pac1End);
    assert.equal(pac1End.kind, isPast(`${YEAR}-03-31`) ? "TAX_OVERDUE" : "TAX_DUE");
    assert.ok(events.every((event, index) => index === 0 || events[index - 1]!.dueAt <= event.dueAt), "ordenado por fecha");
    assert.deepEqual(calendar.body.pending, [{ taxId: terrazas.body.id, kind: "terrazas", period: "anual", dueFrom: `${YEAR}-09-01`, dueTo: `${YEAR}-11-20`, amount: "600.00" }], "solo el tributo sin recibos generados queda pendiente");
    const emptyYear = await call(app, "GET", `${base(tenantA.propertyA)}/tax-calendar?year=${YEAR - 3}`, assetManagerA);
    assert.equal(emptyYear.body.events.length, 0);
    assert.equal(emptyYear.body.pending.length, 6, "los cuatro tributos activos (IBI 1 + IAE 3 plazos + residuos 1 + terrazas 1; vados de baja) tienen calendario en cualquier ejercicio");
    const badQuery = await call(app, "GET", `${base(tenantA.propertyA)}/tax-calendar?year=abc`, assetManagerA);
    assert.equal(badQuery.status, 400);
  });

  it("RBAC: receptionist 403; accountant lee (real_estate.read) y no escribe (property_tax.manage)", async () => {
    for (const attempt of [call(app, "GET", `${base(tenantA.propertyA)}/taxes`, receptionistA), call(app, "GET", `${base(tenantA.propertyA)}/receipts?year=${YEAR}`, receptionistA), call(app, "GET", `${base(tenantA.propertyA)}/tax-calendar`, receptionistA)]) {
      const reply = await attempt;
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
    }
    const read = await call(app, "GET", `${base(tenantA.propertyA)}/taxes?year=${YEAR}`, accountantA);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.length, 5);
    const receipts = await call(app, "GET", `${base(tenantA.propertyA)}/receipts?year=${YEAR}`, accountantA);
    assert.equal(receipts.status, 200);
    assert.equal(receipts.body.length, 6);
    for (const attempt of [
      call(app, "POST", `${base(tenantA.propertyA)}/taxes`, accountantA, { kind: "ibi", authorityName: "x" }),
      call(app, "PATCH", `${base(tenantA.propertyA)}/taxes/${ibiTaxId}`, accountantA, { directDebit: false }),
      call(app, "POST", `${base(tenantA.propertyA)}/taxes/${ibiTaxId}/receipts`, accountantA, { fiscalYear: YEAR + 1 }),
      call(app, "POST", `${base(tenantA.propertyA)}/taxes/${ibiTaxId}/receipts/generate`, accountantA, { year: YEAR + 1 }),
      call(app, "PATCH", `${base(tenantA.propertyA)}/receipts/${iaeReceiptIds[1]}`, accountantA, { status: "recibido" }),
      call(app, "POST", `${base(tenantA.propertyA)}/receipts/${iaeReceiptIds[1]}/propose-entry`, accountantA)
    ]) {
      const reply = await attempt;
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
    }
    assert.equal((await prisma.propertyTaxReceipt.count({ where: { tax: { propertyId: tenantA.propertyA } } })), 7, "nada escrito");
  });

  it("auditoría: toda escritura deja su evento property_tax* con el actor", async () => {
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, entityType: { in: ["property_tax", "property_tax_receipt"] } }, select: { action: true, entityType: true, entityId: true, actorUserId: true } });
    const actions = new Set(events.map((event) => event.action));
    for (const expected of ["PROPERTY_TAX_CREATED", "PROPERTY_TAX_UPDATED", "PROPERTY_TAX_RECEIPTS_GENERATED", "PROPERTY_TAX_RECEIPT_CREATED", "PROPERTY_TAX_RECEIPT_UPDATED", "RECEIPT_STATUS_CHANGED", "RECEIPT_ENTRY_PROPOSED", "RECEIPT_ENTRY_LINKED"]) {
      assert.ok(actions.has(expected), `falta ${expected} en ${[...actions].join(", ")}`);
    }
    assert.ok(events.every((event) => event.actorUserId === assetManagerA.userId), "todas las escrituras las hizo el asset_manager");
    assert.ok(events.some((event) => event.action === "RECEIPT_ENTRY_PROPOSED" && event.entityId === ibiReceiptId));
    assert.ok(events.some((event) => event.action === "PROPERTY_TAX_RECEIPTS_GENERATED" && event.entityType === "property_tax" && event.entityId === iaeTaxId));
  });
});

describe("ACT-REV · asiento, estado y tenencia (correcciones de revisión)", () => {
  const receiptsUrl = () => `${base(tenantA.propertyA)}/receipts`;
  const journalCount = (receiptId: string, sourceType = "property_tax_receipt") => prisma.journalEntry.count({ where: { organizationId: tenantA.organizationId, sourceType, sourceId: receiptId } });
  let residuosTaxId: string;
  let regeneratedReceiptId: string;
  let postedReceiptId: string;
  let overdueReceiptId: string;

  it("ACT-REV-04 · pagar con borrador propio enlazado regenera el borrador (H 572 en vez de H 475); ACT-REV-03 · desenlazar descarta el borrador propio y volver a proponer no duplica el 631", async () => {
    const tax = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, { kind: "residuos", authorityName: "Ayuntamiento de prueba", fiscalReference: "RES-0001", expectedAnnualAmount: "1200.00" });
    assert.equal(tax.status, 201, JSON.stringify(tax.body));
    residuosTaxId = tax.body.id;
    const receipt = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${residuosTaxId}/receipts`, assetManagerA, { fiscalYear: YEAR, period: "1", amount: "600.00", status: "recibido", dueFrom: `${YEAR}-09-01`, dueTo: `${YEAR}-11-20` });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    regeneratedReceiptId = receipt.body.id;

    const proposed = await call(app, "POST", `${receiptsUrl()}/${regeneratedReceiptId}/propose-entry`, assetManagerA);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const firstDraftId = proposed.body.journalEntryId as string;
    const firstLines = await prisma.journalLine.findMany({ where: { journalEntryId: firstDraftId }, select: { accountCode: true, credit: true } });
    assert.ok(firstLines.some((line) => line.accountCode === "475" && Number(line.credit) === 600), "recibido: H 475");

    const paid = await call(app, "PATCH", `${receiptsUrl()}/${regeneratedReceiptId}`, assetManagerA, { status: "pagado" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "pagado");
    assert.equal(paid.body.paidAt, TODAY);
    assert.equal(paid.body.journalEntryStatus, "draft");
    const secondDraftId = paid.body.journalEntryId as string;
    assert.notEqual(secondDraftId, firstDraftId, "el borrador se regenera");
    assert.equal(await prisma.journalEntry.findUnique({ where: { id: firstDraftId } }), null, "el borrador anterior (H 475) se descarta");
    const secondLines = await prisma.journalLine.findMany({ where: { journalEntryId: secondDraftId }, orderBy: { accountCode: "asc" } });
    assert.deepEqual(secondLines.map((line) => [line.accountCode, Number(line.debit).toFixed(2), Number(line.credit).toFixed(2)]), [["572", "0.00", "600.00"], ["631", "600.00", "0.00"]], "pagado por banco: D 631 / H 572");
    assert.equal((await prisma.journalEntry.findUnique({ where: { id: secondDraftId }, select: { entryDate: true } }))?.entryDate.toISOString().slice(0, 10), TODAY, "fecha contable = paidAt");
    assert.equal(await journalCount(regeneratedReceiptId), 1, "un solo asiento vivo por recibo");

    const unlinked = await call(app, "PATCH", `${receiptsUrl()}/${regeneratedReceiptId}`, assetManagerA, { journalEntryId: null });
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
    assert.equal(unlinked.body.journalEntryId, null);
    assert.equal(await prisma.journalEntry.findUnique({ where: { id: secondDraftId } }), null, "desenlazar un borrador propio lo descarta");
    assert.equal(await journalCount(regeneratedReceiptId), 0);

    const again = await call(app, "POST", `${receiptsUrl()}/${regeneratedReceiptId}/propose-entry`, assetManagerA);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.journalEntryStatus, "draft");
    assert.equal(await journalCount(regeneratedReceiptId), 1, "volver a proponer no deja borradores huérfanos ni duplica el gasto");
    const thirdLines = await prisma.journalLine.findMany({ where: { journalEntryId: again.body.journalEntryId }, select: { accountCode: true } });
    assert.ok(thirdLines.some((line) => line.accountCode === "572"), "el recibo ya está pagado: H 572");

    await flushAuditQueues();
    const linkEvents = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, entityType: "property_tax_receipt", entityId: regeneratedReceiptId, action: "RECEIPT_ENTRY_LINKED" }, select: { afterJson: true } });
    assert.ok(linkEvents.some((event) => (event.afterJson as Json)?.source === "regenerated" && (event.afterJson as Json)?.discardedDraftId === firstDraftId), JSON.stringify(linkEvents.map((e) => e.afterJson)));
  });

  it("ACT-REV-03 · con asiento propio contabilizado: desenlazar 409 y propose-entry 409 aunque el recibo hubiera perdido el enlace (nunca un segundo 631)", async () => {
    const receipt = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${residuosTaxId}/receipts`, assetManagerA, { fiscalYear: YEAR, period: "2", amount: "600.00", status: "recibido", dueFrom: `${YEAR}-09-01`, dueTo: `${YEAR}-11-20` });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    postedReceiptId = receipt.body.id;
    const proposed = await call(app, "POST", `${receiptsUrl()}/${postedReceiptId}/propose-entry`, assetManagerA);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const accrualId = proposed.body.journalEntryId as string;
    const posted = await call(app, "POST", `/journal-entries/${accrualId}/post`, accountantA);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    const unlink = await call(app, "PATCH", `${receiptsUrl()}/${postedReceiptId}`, assetManagerA, { journalEntryId: null });
    assert.equal(unlink.status, 409, JSON.stringify(unlink.body));
    assert.equal(codeOf(unlink), "RECEIPT_ENTRY_EXISTS");
    assert.equal(unlink.body.details.journalEntryStatus, "posted");
    assert.equal((await prisma.propertyTaxReceipt.findUnique({ where: { id: postedReceiptId }, select: { journalEntryId: true } }))?.journalEntryId, accrualId, "sigue enlazado");

    // Aunque el recibo perdiera el enlace (datos), el asiento contabilizado del mismo recibo bloquea una segunda propuesta.
    await prisma.propertyTaxReceipt.update({ where: { id: postedReceiptId }, data: { journalEntryId: null } });
    const duplicate = await call(app, "POST", `${receiptsUrl()}/${postedReceiptId}/propose-entry`, assetManagerA);
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(codeOf(duplicate), "RECEIPT_ENTRY_EXISTS");
    assert.equal(duplicate.body.details.journalEntryId, accrualId);
    assert.equal(duplicate.body.details.journalEntryStatus, "posted");
    assert.equal(await journalCount(postedReceiptId), 1, "ningún segundo asiento D 631");
    await prisma.propertyTaxReceipt.update({ where: { id: postedReceiptId }, data: { journalEntryId: accrualId } });
  });

  it("ACT-REV-04 · pagar con asiento propio contabilizado (H 475) propone el asiento de pago D 475 / H 572 como segundo borrador", async () => {
    const before = await journalCount(postedReceiptId, "property_tax_receipt_payment");
    assert.equal(before, 0);
    const paid = await call(app, "PATCH", `${receiptsUrl()}/${postedReceiptId}`, assetManagerA, { status: "pagado" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "pagado");
    assert.equal(paid.body.journalEntryStatus, "posted", "el recibo conserva el asiento de devengo");
    const payment = await prisma.journalEntry.findFirst({ where: { organizationId: tenantA.organizationId, sourceType: "property_tax_receipt_payment", sourceId: postedReceiptId } });
    assert.ok(payment, "borrador de pago creado");
    assert.equal(payment.status, "draft");
    assert.equal(payment.propertyId, tenantA.propertyA);
    assert.equal(payment.entryDate.toISOString().slice(0, 10), TODAY);
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: payment.id }, orderBy: { accountCode: "asc" } });
    assert.deepEqual(lines.map((line) => [line.accountCode, Number(line.debit).toFixed(2), Number(line.credit).toFixed(2)]), [["475", "600.00", "0.00"], ["572", "0.00", "600.00"]]);
    assert.equal(await journalCount(postedReceiptId), 1, "el devengo sigue siendo uno");
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, entityType: "property_tax_receipt", entityId: postedReceiptId, action: "RECEIPT_PAYMENT_ENTRY_PROPOSED" }, select: { afterJson: true, actorUserId: true } });
    assert.equal(events.length, 1);
    assert.equal((events[0].afterJson as Json).journalEntryId, payment.id);
    assert.equal(events[0].actorUserId, assetManagerA.userId);
    // Contabilizado el pago, un segundo cambio de estado no vuelve a proponerlo (pagado solo admite recurrir, y recurrir no paga).
    const appealed = await call(app, "PATCH", `${receiptsUrl()}/${postedReceiptId}`, assetManagerA, { status: "recurrido", appealRef: "REC-2026-003" });
    assert.equal(appealed.status, 200, JSON.stringify(appealed.body));
    assert.equal(await journalCount(postedReceiptId, "property_tax_receipt_payment"), 1);
  });

  it("ACT-REV-09 · un recibo vencido que pasa a recurrido sigue en el motor de alertas («(recurrido)»); pagarlo la quita", async () => {
    const receipt = await call(app, "POST", `${base(tenantA.propertyA)}/taxes/${residuosTaxId}/receipts`, assetManagerA, { fiscalYear: YEAR, period: "3", amount: "600.00", status: "recibido", dueFrom: `${YEAR}-01-01`, dueTo: `${YEAR}-01-31` });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    overdueReceiptId = receipt.body.id;
    assert.equal(receipt.body.overdue, true);
    const alerts = await call(app, "GET", `${base(tenantA.propertyA)}/alerts`, assetManagerA);
    assert.equal(alerts.status, 200, JSON.stringify(alerts.body));
    assert.ok((alerts.body as Json[]).some((alert) => alert.kind === "TAX_OVERDUE" && alert.entityId === overdueReceiptId), "vencido sin pagar");

    const appealed = await call(app, "PATCH", `${receiptsUrl()}/${overdueReceiptId}`, assetManagerA, { status: "recurrido", appealRef: "REC-2026-004" });
    assert.equal(appealed.status, 200, JSON.stringify(appealed.body));
    assert.equal(appealed.body.overdue, true, "el recurso no suspende el vencimiento");
    const afterAppeal = await call(app, "GET", `${base(tenantA.propertyA)}/alerts`, assetManagerA);
    const alert = (afterAppeal.body as Json[]).find((row) => row.kind === "TAX_OVERDUE" && row.entityId === overdueReceiptId);
    assert.ok(alert, "sigue en el motor tras recurrir");
    assert.match(alert.message, /\(recurrido\)/);
    const calendar = await call(app, "GET", `${base(tenantA.propertyA)}/calendar?year=${YEAR}`, assetManagerA);
    assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
    const january = (calendar.body.months as Json[])[0].events as Json[];
    assert.ok(january.some((event) => event.kind === "TAX_OVERDUE" && event.entityId === overdueReceiptId), "también en el calendario");

    const paid = await call(app, "PATCH", `${receiptsUrl()}/${overdueReceiptId}`, assetManagerA, { status: "pagado", paidAt: `${YEAR}-06-15`, paidWith: "bank" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.overdue, false);
    const afterPay = await call(app, "GET", `${base(tenantA.propertyA)}/alerts`, assetManagerA);
    assert.ok(!(afterPay.body as Json[]).some((row) => row.entityId === overdueReceiptId), "pagado: sin alerta");
    // ACT-REV-15: etiqueta del calendario con la fecha de pago DD/MM/AAAA.
    const paidCalendar = await call(app, "GET", `${base(tenantA.propertyA)}/calendar?year=${YEAR}`, assetManagerA);
    const paidEvent = ((paidCalendar.body.months as Json[])[0].events as Json[]).find((event) => event.entityId === overdueReceiptId && event.dueAt === `${YEAR}-01-31`);
    assert.equal(paidEvent?.label, `Pagado el 15/06/${YEAR} · Tasa de residuos ${YEAR} (3)`);
  });

  it("ACT-REV-13 · el periodo previsto sin recibo enlaza al tributo (entityType property_tax) con importe formateado", async () => {
    const tax = await call(app, "POST", `${base(tenantA.propertyA)}/taxes`, assetManagerA, { kind: "terrazas", authorityName: "Ayuntamiento de prueba", expectedAnnualAmount: "1500.00" });
    assert.equal(tax.status, 201, JSON.stringify(tax.body));
    const calendar = await call(app, "GET", `${base(tenantA.propertyA)}/calendar?year=${YEAR}`, assetManagerA);
    assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
    const events = (calendar.body.months as Json[]).flatMap((month) => month.events as Json[]).filter((event) => event.entityId === tax.body.id);
    assert.equal(events.length, 2, "inicio y fin del periodo voluntario previsto");
    assert.ok(events.every((event) => event.entityType === "property_tax"));
    assert.ok(events.some((event) => event.label === `Fin del periodo voluntario previsto · Terrazas ${YEAR} · 1.500,00 € (sin recibo)`), JSON.stringify(events));
    const baja = await call(app, "PATCH", `${base(tenantA.propertyA)}/taxes/${tax.body.id}`, assetManagerA, { status: "baja" });
    assert.equal(baja.status, 200);
  });

  it("ACT-REV-08 · activar una tenencia (o cambiar kind / ibiPayer de la vigente) propone el taxpayer de los IBI activos de la ficha", async () => {
    const ibiTaxpayer = async () => (await prisma.propertyTax.findUnique({ where: { id: ibiTaxId }, select: { taxpayer: true } }))?.taxpayer;
    assert.equal(await ibiTaxpayer(), "sociedad");
    const tenures = await call(app, "GET", `${base(tenantA.propertyA)}/tenures`, assetManagerA);
    assert.equal(tenures.status, 200, JSON.stringify(tenures.body));
    const ownership = (tenures.body as Json[]).find((tenure) => tenure.kind === "propiedad");
    assert.ok(ownership, "la tenencia propiedad del alta");

    const burdenBefore = Number((await call(app, "GET", base(tenantA.propertyA), assetManagerA)).body.kpis.annualTaxBurden);
    assert.ok(burdenBefore >= 12000, `la carga fiscal incluye el IBI de la sociedad: ${burdenBefore}`);
    const lease = await call(app, "POST", `${base(tenantA.propertyA)}/tenures`, assetManagerA, { kind: "arrendamiento_industria", counterpartyName: "Inmuebles de prueba SL", startDate: `${YEAR}-01-01`, endDate: `${YEAR + 9}-12-31`, noticeMonths: 12, ibiPayer: "propietario" });
    assert.equal(lease.status, 201, JSON.stringify(lease.body));
    const activated = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${lease.body.id}`, assetManagerA, { action: "activar" });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(await ibiTaxpayer(), "propietario_tercero", "inmueble de un tercero: el IBI lo paga el propietario");
    const repercuted = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${lease.body.id}`, assetManagerA, { ibiPayer: "arrendatario" });
    assert.equal(repercuted.status, 200, JSON.stringify(repercuted.body));
    assert.equal(await ibiTaxpayer(), "propietario_tercero", "la repercusión llega por factura del arrendador, no por el recibo municipal");
    const detail = await call(app, "GET", base(tenantA.propertyA), assetManagerA);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.ok((detail.body.taxes as Json[]).some((tax) => tax.id === ibiTaxId && tax.taxpayer === "propietario_tercero"), "la ficha lista los tributos (ACT-REV-06)");
    assert.equal(detail.body.kpis.annualTaxBurden, (burdenBefore - 12000).toFixed(2), "el IBI (12.000) ya no carga a la sociedad");

    const resolved = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${lease.body.id}`, assetManagerA, { action: "resolver" });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const owned = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${ownership.id}`, assetManagerA, { action: "activar" });
    assert.equal(owned.status, 200, JSON.stringify(owned.body));
    assert.equal(await ibiTaxpayer(), "sociedad", "propietaria: la sociedad es el sujeto pasivo");
    const passedOn = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${ownership.id}`, assetManagerA, { ibiPayer: "arrendatario" });
    assert.equal(passedOn.status, 200, JSON.stringify(passedOn.body));
    assert.equal(await ibiTaxpayer(), "arrendatario", "propietaria que repercute el IBI a su inquilino");
    const restored = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${ownership.id}`, assetManagerA, { ibiPayer: "propietario" });
    assert.equal(restored.status, 200);
    assert.equal(await ibiTaxpayer(), "sociedad");

    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, entityType: "property_tax", entityId: ibiTaxId, action: "PROPERTY_TAX_UPDATED" }, select: { afterJson: true } });
    const byTenure = events.filter((event) => (event.afterJson as Json)?.source === "tenure");
    assert.equal(byTenure.length, 4, JSON.stringify(events.map((e) => e.afterJson)));
    assert.deepEqual(byTenure.map((event) => (event.afterJson as Json).taxpayer), ["propietario_tercero", "sociedad", "arrendatario", "sociedad"]);
  });
});
