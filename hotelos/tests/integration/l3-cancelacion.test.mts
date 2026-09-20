/**
 * Tanda L3 · lote B — cancelación y no-show con política (Postgres; tenant AISLADO).
 * Corrector L3 ronda 1: guardas de estado, idempotencia, renuncia por tramos y factura de la penalización.
 *
 * app.inject sobre Postgres real en una organización `org_l2_<run>` (helpers/l2-tenant.mts) con
 * cuatro políticas creadas por Prisma en el hotel A: FLEX (24 h, primera noche, POR DEFECTO), SEMI
 * (72 h), NREF (0 h, estancia completa) y FIXW (0 h, 20 € fijos). Las reservas las crea la
 * recepcionista por HTTP con `totalAmount` explícito (sin depender del lote A «precio desde
 * tarifa»). STRICT_ENV: auth real, sin unión de permisos de demo, RBAC_STRICT=true.
 *
 *   · cancelar > 24 h antes → 0 €, folio (vacío) cerrado, respuesta `cancellation`;
 *   · cancelar el día de llegada (< 24 h) → línea `cancellation_fee` `not_subject` = total/noches,
 *     folio abierto con saldo → el preflight NO bloquea por él (reserva cancelada) → cobro por
 *     POST /folios/:id/payments (payment.capture) → POST /folios/:id/close responde 409
 *     FOLIO_UNINVOICED_LINES (FC-2) → POST /folios/:id/invoice (F2) + POST /invoices/:id/issue
 *     asientan D 4300 / H 705.3 sin cuota → POST /folios/:id/close;
 *   · `applyPolicy: false` sin motivo → 400 sin efectos; renunciar al 100 % de la estancia por
 *     recepción → 409 APPROVAL_REQUIRED (kind discount) sin efectos (DS-02); la dirección general
 *     (pms.reservation.override) sí renuncia (autorización implícita, tramo «above»); una renuncia
 *     ≤ T1 (20 € de 300 €, 6,67 %) la hace recepción con la clave y el motivo;
 *   · SoD ANTES de escribir: un contexto con pms.reservation.modify pero sin folio.charge.post
 *     (plantilla `sales`) recibe 403 y la reserva sigue confirmada; contabilidad → 403 en /cancel;
 *   · GET /cancellation-charge?mode=no_show (y 400 con otro modo); POST /no-show → `no_show_fee`;
 *   · idempotencia (DS-01 / FC-1): un segundo POST /cancel y un POST /no-show sobre una cancelada
 *     responden 409 RESERVATION_NOT_ACTIVE y el folio conserva UNA línea; las rutas heredadas
 *     /apply-cancellation-fee · /apply-no-show-fee exigen el estado correspondiente (409
 *     RESERVATION_STATUS_MISMATCH sobre una confirmada) y nunca duplican (`alreadyApplied`) ni
 *     abren un folio secundario (DS-03);
 *   · depósito capturado antes de cancelar → folio a saldo 0 pero `pendingInvoice: true` (no se
 *     cierra sin factura);
 *   · processNoShows (paso del cierre del día) con la identidad de dirección general y las claves
 *     de jefatura de recepción (tiene modify) y con las claves de `night_auditor` (SIN modify) →
 *     no_show, RESERVATION_NO_SHOW + compañero con `autoNoShow`, línea `no_show_fee`;
 *   · política por defecto: una sola por hotel (PATCH/POST desmarcan la anterior; la lista la
 *     devuelve primero).
 *
 * Faranda es SOLO LECTURA: `farandaInvariants()` idénticos antes y después; `cleanupTenant` al final.
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l3-cancelacion.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { IsolatedTenant, Session } from "./helpers/l2-tenant.mts";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

// El helper fija DATABASE_URL (connection_limit), JWT_SECRET y ENCRYPTION_KEY antes de cargar Prisma: va primero.
const helper = await import("./helpers/l2-tenant.mts");
const { prisma } = await import("@hotelos/database");
const { ROLE_PERMISSION_MAP } = await import("@hotelos/shared");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const lifecycle = await import("../../apps/api/src/modules/cancellation-policy/reservation-lifecycle.service.js");
const { buildPreflight } = await import("../../apps/api/src/modules/night-audit/night-audit-preflight.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushVerifactuQueue } = await import("../../apps/api/src/modules/invoicing/verifactu-submission.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `c${helper.newRunId()}`;
const MADRID = "Europe/Madrid";

let app: ApiApp;
let tenant: IsolatedTenant;
let reception: Session;
let accountant: Session;
let generalManager: Session;
let farandaBefore: Awaited<ReturnType<typeof helper.farandaInvariants>>;
let flexId = "";
let semiId = "";

/** Día natural en la zona del hotel (Europe/Madrid), desplazado `offsetDays`. */
function madridDay(offsetDays: number): string {
  const instant = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: MADRID, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown } = {}): Promise<Reply> {
  const res = await helper.withEnv(helper.STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), "x-property-id": tenant.propertyA },
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
}

function expect409(reply: Reply, code: string): void {
  assert.equal(reply.status, 409, reply.raw.slice(0, 400));
  assert.equal(reply.body?.details?.code, code, reply.raw.slice(0, 400));
}

const ctxOf = (userId: string, permissions: readonly string[]): UserContext =>
  ({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, userId, fullName: "L3-B", deviceId: `l3b-${RUN}`, permissions: [...permissions], orgScope: true }) as unknown as UserContext;

/**
 * Reserva confirmada del hotel A creada por recepción por HTTP con importe explícito.
 * `allowPastArrival`: desde UX-1 (corrector L-02) una llegada anterior a hoy se rechaza
 * con 400 PAST_ARRIVAL_DATE salvo confirmación explícita (la ruta la admite porque
 * recepción tiene pms.reservation.modify); solo lo usan los casos de no-show.
 */
async function newReservation(input: { arrivalDate: string; departureDate: string; totalAmount: number; label: string; cancellationPolicyCode?: string; allowPastArrival?: boolean }): Promise<{ id: string; code: string }> {
  const created = await call("POST", `/properties/${tenant.propertyA}/reservations`, reception, {
    payload: {
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      adults: 1,
      roomTypeId: tenant.roomTypeA,
      ratePlanId: tenant.ratePlanA,
      totalAmount: input.totalAmount,
      bookerName: `L3-B ${input.label} ${RUN}`,
      ...(input.cancellationPolicyCode ? { cancellationPolicyCode: input.cancellationPolicyCode } : {}),
      // UX-1 (corrector L-02): una llegada anterior a hoy es 400 PAST_ARRIVAL_DATE salvo confirmación
      // explícita con pms.reservation.modify (la plantilla receptionist la tiene): las candidatas a
      // no-show del cierre del día llegaron hace días y se registran confirmadas. Se acepta la marca
      // explícita del caso (main) o, como red de la Tanda CHK, cualquier llegada anterior a hoy.
      ...(input.allowPastArrival || input.arrivalDate < madridDay(0) ? { allowPastArrival: true } : {})
    }
  });
  assert.ok(created.status === 200 || created.status === 201, created.raw.slice(0, 400));
  assert.equal(created.body.status, "confirmed");
  return { id: created.body.id, code: created.body.code };
}

async function feeLines(reservationId: string) {
  return prisma.folioLine.findMany({ where: { folio: { reservationId }, deletedAt: null }, orderBy: { postedAt: "asc" } });
}

async function foliosOf(reservationId: string) {
  return prisma.folio.findMany({ where: { reservationId, deletedAt: null }, orderBy: { id: "asc" }, select: { id: true, status: true, isPrimary: true } });
}

async function statusOf(reservationId: string): Promise<string> {
  return (await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { status: true } })).status;
}

async function auditOf(action: string, entityId: string) {
  await flushAuditQueues();
  return prisma.auditEvent.findFirst({ where: { organizationId: tenant.organizationId, action, entityId }, orderBy: { createdAt: "desc" } });
}

/** Emite la factura simplificada del folio (recepción tiene invoice.issue) y devuelve la emitida. */
async function issueFolioInvoice(folioId: string) {
  const draft = await call("POST", `/folios/${folioId}/invoice`, reception, { payload: { invoiceType: "F2", customerType: "guest" } });
  assert.ok(draft.status === 200 || draft.status === 201, draft.raw.slice(0, 400));
  assert.equal(draft.body.status, "draft");
  const issued = await call("POST", `/invoices/${draft.body.id}/issue`, reception, { payload: {} });
  assert.equal(issued.status, 200, issued.raw.slice(0, 400));
  assert.equal(issued.body.status, "issued");
  return issued.body as { id: string; invoiceNumber: string; total: number; taxTotal: number };
}

before(async () => {
  farandaBefore = await helper.farandaInvariants();
  app = await buildApiServer();
  tenant = await helper.createIsolatedTenant(RUN);
  const flex = await prisma.cancellationPolicy.create({
    data: { propertyId: tenant.propertyA, code: "FLEX", name: "Flexible", freeCancelHours: 24, penaltyType: "first_night", noShowPenaltyType: "first_night", active: true, isDefault: true }
  });
  const semi = await prisma.cancellationPolicy.create({
    data: { propertyId: tenant.propertyA, code: "SEMI", name: "Semi-flexible", freeCancelHours: 72, penaltyType: "first_night", noShowPenaltyType: "first_night", active: true }
  });
  await prisma.cancellationPolicy.create({
    data: { propertyId: tenant.propertyA, code: "NREF", name: "No reembolsable", freeCancelHours: 0, penaltyType: "all_stay", noShowPenaltyType: "all_stay", active: true }
  });
  await prisma.cancellationPolicy.create({
    data: { propertyId: tenant.propertyA, code: "FIXW", name: "Gastos de gestión", freeCancelHours: 0, penaltyType: "fixed_amount", penaltyValue: 20, noShowPenaltyType: "fixed_amount", noShowPenaltyValue: 20, active: true }
  });
  flexId = flex.id;
  semiId = semi.id;
  await helper.withEnv(helper.STRICT_ENV, async () => {
    reception = await helper.loginOrThrow(app, tenant.users.receptionist.email, tenant.password, "l3b-reception");
    accountant = await helper.loginOrThrow(app, tenant.users.accountant.email, tenant.password, "l3b-accountant");
    generalManager = await helper.loginOrThrow(app, tenant.users.generalManager.email, tenant.password, "l3b-gm");
  });
});

after(async () => {
  try {
    await flushVerifactuQueue();
    await flushAuditQueues();
    if (tenant) await helper.cleanupTenant(tenant.organizationId);
  } finally {
    await app?.close();
  }
  if (tenant) assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "la organización aislada se ha borrado");
  assert.deepEqual(await helper.farandaInvariants(), farandaBefore, "las cifras de Faranda no cambian");
});

describe("L3-B · políticas: la lista devuelve primero la política por defecto", () => {
  it("GET /properties/:id/cancellation-policies (recepción) → FLEX primera con isDefault=true; el resto sin marcar", async () => {
    const list = await call("GET", `/properties/${tenant.propertyA}/cancellation-policies`, reception);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    const codes = list.body.items.map((p: { code: string }) => p.code);
    assert.deepEqual(codes, ["FLEX", "FIXW", "NREF", "SEMI"], "por defecto primero, luego activas por código");
    assert.equal(list.body.items[0].isDefault, true);
    assert.ok(list.body.items.slice(1).every((p: { isDefault: boolean }) => p.isDefault === false));
  });
});

describe("L3-B · cancelación con política por HTTP", () => {
  it("> 24 h antes de la llegada (FLEX por defecto): preview 0 €, cancelada, folio vacío cerrado, respuesta `cancellation`", async () => {
    const r = await newReservation({ arrivalDate: "2026-10-01", departureDate: "2026-10-03", totalAmount: 200, label: "libre" });
    const preview = await call("GET", `/reservations/${r.id}/cancellation-charge`, reception);
    assert.equal(preview.status, 200, preview.raw.slice(0, 300));
    assert.deepEqual([preview.body.amount, preview.body.withinFreeWindow, preview.body.policyCode], [0, true, "FLEX"]);
    assert.equal(preview.body.cutoffAt, "2026-10-01T12:00:00.000Z", "ventana medida a las 14:00 de Madrid (CEST) del día de llegada");

    const cancelled = await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { reason: "Cambio de planes" } });
    assert.equal(cancelled.status, 200, cancelled.raw.slice(0, 400));
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal(cancelled.body.code, r.code, "la respuesta sigue siendo el registro de la reserva");
    const c = cancelled.body.cancellation;
    assert.deepEqual([c.mode, c.applied, c.policyWaived, c.waivedAmount, c.waiver, c.line, c.charge.amount, c.charge.policyCode], ["cancellation", true, false, 0, null, null, 0, "FLEX"]);
    assert.deepEqual([c.folio?.status, c.folio?.balanceDue, c.folio?.pendingInvoice], ["closed", 0, false]);

    const folios = await prisma.folio.findMany({ where: { reservationId: r.id } });
    assert.equal(folios.length, 1);
    assert.equal(folios[0]!.status, "closed", "folio a saldo 0 cerrado al cancelar");
    assert.equal((await feeLines(r.id)).length, 0);
    assert.ok(await auditOf("RESERVATION_CANCELLED", r.id), "auditoría RESERVATION_CANCELLED (transitionReservation)");

    // Idempotencia (DS-01): la segunda cancelación es un 409 sin efectos, no una repetición silenciosa.
    expect409(await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { reason: "otra vez" } }), "RESERVATION_NOT_ACTIVE");
    // La ruta heredada sobre una cancelada sin penalización no abre folios nuevos (DS-03 / R5).
    const legacy = await call("POST", `/reservations/${r.id}/apply-cancellation-fee`, reception);
    assert.equal(legacy.status, 200, legacy.raw.slice(0, 300));
    assert.deepEqual([legacy.body.breakdown.amount, legacy.body.line, legacy.body.alreadyApplied], [0, null, false]);
    assert.equal((await foliosOf(r.id)).length, 1, "sin folio secundario");
  });

  it("el día de llegada (< 24 h): línea cancellation_fee not_subject = total/noches, folio abierto con saldo, el preflight no bloquea, cobro, factura (FC-2) y cierre", async () => {
    const r = await newReservation({ arrivalDate: madridDay(0), departureDate: madridDay(1), totalAmount: 150, label: "tardía" });
    const cancelled = await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { reason: "No viaja" } });
    assert.equal(cancelled.status, 200, cancelled.raw.slice(0, 400));
    assert.equal(cancelled.body.status, "cancelled");
    const c = cancelled.body.cancellation;
    assert.deepEqual([c.charge.amount, c.charge.basis, c.charge.withinFreeWindow, c.policyWaived], [150, "first_night", false, false]);
    assert.equal(c.line?.type, "cancellation_fee");
    assert.equal(c.line?.taxCategory, "not_subject");
    assert.equal(c.line?.total, 150);
    assert.deepEqual([c.folio?.status, c.folio?.balanceDue, c.folio?.pendingInvoice], ["open", 150, false], "con saldo el folio permanece abierto y se devuelve balanceDue");

    const lines = await feeLines(r.id);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]!.type, lines[0]!.taxCategory, Number(lines[0]!.total)], ["cancellation_fee", "not_subject", 150]);
    const folioId = lines[0]!.folioId;
    assert.equal(c.folio?.id, folioId);
    assert.equal((await prisma.folio.findUniqueOrThrow({ where: { id: folioId } })).status, "open");

    // Preflight: el folio con saldo de una reserva cancelada se cuenta aparte como aviso, no bloquea.
    const preflight = await buildPreflight({ propertyId: tenant.propertyA });
    const check = preflight.checks.find((x) => x.id === "open_folios_with_balance");
    assert.ok(check, "check open_folios_with_balance");
    assert.notEqual(check.status, "blocker");
    assert.equal(check.count, 0, "ningún folio de reserva viva con saldo");
    assert.match(check.detail, /canceladas o no presentadas/);
    assert.match(check.detail, /150,00 €/);

    // Cobro del saldo (payment.capture).
    const paid = await call("POST", `/folios/${folioId}/payments`, reception, { payload: { amount: 150, method: "cash" } });
    assert.equal(paid.status, 201, paid.raw.slice(0, 400));
    assert.deepEqual([paid.body.status, paid.body.amount, paid.body.method], ["captured", 150, "cash"]);

    // FC-2: el folio saldado con la penalización SIN factura no se cierra: hay que emitir el documento.
    const refused = await call("POST", `/folios/${folioId}/close`, reception);
    expect409(refused, "FOLIO_UNINVOICED_LINES");
    assert.deepEqual([refused.body.details.lines, refused.body.details.total], [1, 150]);
    assert.match(String(refused.body.message), /sin facturar/);
    assert.equal((await prisma.folio.findUniqueOrThrow({ where: { id: folioId } })).status, "open");

    const invoice = await issueFolioInvoice(folioId);
    assert.deepEqual([invoice.total, invoice.taxTotal], [150, 0], "indemnización no sujeta: total 150, cuota 0");
    const entry = await prisma.journalEntry.findFirst({ where: { organizationId: tenant.organizationId, sourceType: "invoice", sourceId: invoice.id, status: "posted" }, select: { id: true } });
    assert.ok(entry, "la factura asienta en el diario");
    const journal = (await prisma.journalLine.findMany({ where: { journalEntryId: entry.id }, orderBy: [{ accountCode: "asc" }], select: { accountCode: true, debit: true, credit: true } })).map((l) => [l.accountCode, Number(l.debit), Number(l.credit)]);
    assert.deepEqual(journal, [["4300", 150, 0], ["705.3", 0, 150]], "D 4300 / H 705.3 sin 477: el ingreso por indemnización se devenga");
    const tenantEntries = (await prisma.journalEntry.findMany({ where: { organizationId: tenant.organizationId, status: "posted" }, select: { id: true } })).map((e) => e.id);
    const customer = await prisma.journalLine.aggregate({ where: { journalEntryId: { in: tenantEntries }, accountCode: "4300" }, _sum: { debit: true, credit: true } });
    assert.equal(Number(customer._sum.debit) - Number(customer._sum.credit), 0, "la subcuenta de clientes queda saldada (factura 150 D / cobro 150 H)");

    const closed = await call("POST", `/folios/${folioId}/close`, reception);
    assert.equal(closed.status, 200, closed.raw.slice(0, 400));
    assert.equal(closed.body.status, "closed");
    assert.equal((await prisma.folio.findUniqueOrThrow({ where: { id: folioId } })).status, "closed");
  });

  it("applyPolicy:false sin motivo → 400 sin efectos; renunciar al 100 % por recepción → 409 APPROVAL_REQUIRED sin efectos; dirección general (override) sí; ≤ T1 recepción sí", async () => {
    const r = await newReservation({ arrivalDate: madridDay(0), departureDate: madridDay(1), totalAmount: 150, label: "renuncia" });
    const noReason = await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { applyPolicy: false } });
    assert.equal(noReason.status, 400, noReason.raw.slice(0, 300));
    assert.match(String(noReason.body?.message ?? ""), /motivo/);
    assert.equal(await statusOf(r.id), "confirmed", "sin efectos secundarios");
    assert.equal((await feeLines(r.id)).length, 0);

    // DS-02: 150 € de 150 € (100 % de la estancia) está por encima de T2 → aprobación explícita; recepción no la tiene.
    const denied = await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { applyPolicy: false, reason: "Cliente habitual, cortesía" } });
    expect409(denied, "APPROVAL_REQUIRED");
    assert.deepEqual([denied.body.details.kind, denied.body.details.tier], ["discount", "T2"], "kind discount; tramo por importe (150 € ≤ T2)");
    assert.equal(await statusOf(r.id), "confirmed", "la reserva sigue confirmada");
    assert.equal((await feeLines(r.id)).length, 0);
    assert.equal(await prisma.approvalRequest.count({ where: { organizationId: tenant.organizationId } }), 0, "sin solicitudes creadas por la ruta");

    // La dirección general tiene pms.reservation.override en el hotel (plantilla general_manager, asignada en A): la
    // autorización implícita del motor la decide su asignación en BD, no el contexto. Su plantilla no lleva
    // pms.reservation.modify (403 en /cancel por diseño), así que el caso entra por el servicio con la identidad de
    // dirección general y las claves de jefatura de recepción (modify + discount), como el paso del cierre del día.
    const gm = ROLE_PERMISSION_MAP.general_manager as readonly string[];
    const fom = ROLE_PERMISSION_MAP.front_office_manager as readonly string[];
    assert.ok(gm.includes("pms.reservation.override") && !gm.includes("pms.reservation.modify"));
    expect403(await call("POST", `/reservations/${r.id}/cancel`, generalManager, { payload: { applyPolicy: false, reason: "cortesía" } }), "pms.reservation.modify");
    const waivedResult = await lifecycle.cancelReservationWithPolicy({
      context: ctxOf(tenant.users.generalManager.id, fom),
      reservationId: r.id,
      reason: "Cliente habitual, cortesía de dirección",
      applyPolicy: false,
      correlationId: `corr_l3b_waive_${RUN}`
    });
    const waived = { status: 200, body: waivedResult as unknown as { status: string; cancellation: any }, raw: "" };
    assert.equal(waived.body.status, "cancelled");
    const c = waived.body.cancellation;
    assert.deepEqual([c.applied, c.policyWaived, c.waivedAmount, c.line, c.charge.amount], [false, true, 150, null, 150]);
    assert.deepEqual([c.waiver.band, c.waiver.pct, c.waiver.tier, c.waiver.authorization.mode], ["above", 100, "T2", "implicit"]);
    assert.deepEqual([c.folio?.status, c.folio?.pendingInvoice], ["closed", false], "folio vacío a saldo 0 cerrado");
    assert.equal((await feeLines(r.id)).length, 0, "ninguna penalización cargada");

    const companion = await auditOf("RESERVATION_CANCELLATION_POLICY", r.id);
    assert.ok(companion, "auditoría RESERVATION_CANCELLATION_POLICY");
    const after = companion.afterJson as { policyWaived?: boolean; waivedAmount?: number; reason?: string; status?: string; waiver?: { band?: string } };
    assert.deepEqual([after.policyWaived, after.waivedAmount, after.status, after.waiver?.band], [true, 150, "cancelled", "above"]);
    assert.match(String(after.reason), /Cliente habitual/);
    assert.ok(await auditOf("APPROVAL_DECIDED", r.id), "el motor de aprobaciones audita la autorización implícita");
    const transition = await auditOf("RESERVATION_CANCELLED", r.id);
    assert.ok(transition, "RESERVATION_CANCELLED (transitionReservation) con el motivo");
    assert.match(String((transition.afterJson as { reason?: string }).reason), /Cliente habitual/);

    // ≤ T1: 20 € fijos de una estancia de 300 € (6,67 %) — recepción con la clave de descuento y el motivo.
    const small = await newReservation({ arrivalDate: madridDay(0), departureDate: madridDay(1), totalAmount: 300, label: "renuncia-t1", cancellationPolicyCode: "FIXW" });
    const preview = await call("GET", `/reservations/${small.id}/cancellation-charge`, reception);
    assert.deepEqual([preview.body.amount, preview.body.basis, preview.body.policyCode], [20, "fixed_amount", "FIXW"]);
    const t1 = await call("POST", `/reservations/${small.id}/cancel`, reception, { payload: { applyPolicy: false, reason: "Gastos de gestión condonados" } });
    assert.equal(t1.status, 200, t1.raw.slice(0, 400));
    assert.deepEqual([t1.body.cancellation.policyWaived, t1.body.cancellation.waivedAmount, t1.body.cancellation.waiver], [true, 20, { band: "T1", pct: 6.67, tier: "T1", authorization: null }]);
    assert.equal((await feeLines(small.id)).length, 0);
  });
});

describe("L3-B · separación de funciones antes de escribir, preview no-show y no-show manual", () => {
  let r: { id: string; code: string };

  before(async () => {
    r = await newReservation({ arrivalDate: madridDay(0), departureDate: madridDay(1), totalAmount: 150, label: "sod" });
  });

  it("pms.reservation.modify sin folio.charge.post (plantilla sales) → 403 en el servicio y la reserva sigue confirmada sin líneas", async () => {
    const sales = ROLE_PERMISSION_MAP.sales as readonly string[];
    assert.ok(sales.includes("pms.reservation.modify") && !sales.includes("folio.charge.post"), "sales: modify sin charge.post");
    await assert.rejects(
      lifecycle.cancelReservationWithPolicy({ context: ctxOf(tenant.users.owner.id, sales), reservationId: r.id, reason: "Comercial", correlationId: `corr_l3b_${RUN}` }),
      (error: { statusCode?: number; message: string; missing?: string[] }) =>
        error.statusCode === 403 && (error.missing?.includes("folio.charge.post") || /folio\.charge\.post/.test(error.message))
    );
    assert.equal(await statusOf(r.id), "confirmed");
    assert.equal((await feeLines(r.id)).length, 0);
    assert.equal((await prisma.folio.count({ where: { reservationId: r.id, status: "open" } })), 1, "el folio sigue abierto");
  });

  it("contabilidad (sin pms.reservation.modify) → 403 en POST /cancel", async () => {
    expect403(await call("POST", `/reservations/${r.id}/cancel`, accountant, { payload: { reason: "x" } }), "pms.reservation.modify");
    assert.equal(await statusOf(r.id), "confirmed");
  });

  it("GET /cancellation-charge?mode=no_show → primera noche; ?mode=otro → 400", async () => {
    const preview = await call("GET", `/reservations/${r.id}/cancellation-charge?mode=no_show`, reception);
    assert.equal(preview.status, 200, preview.raw.slice(0, 300));
    assert.deepEqual([preview.body.amount, preview.body.basis, preview.body.withinFreeWindow, preview.body.cutoffAt], [150, "first_night", false, null]);
    assert.match(preview.body.label, /^No-show/);
    const bad = await call("GET", `/reservations/${r.id}/cancellation-charge?mode=otro`, reception);
    assert.equal(bad.status, 400, bad.raw.slice(0, 300));
  });

  it("las rutas heredadas sobre una reserva CONFIRMADA → 409 RESERVATION_STATUS_MISMATCH sin cargar nada (DS-03)", async () => {
    expect409(await call("POST", `/reservations/${r.id}/apply-cancellation-fee`, reception), "RESERVATION_STATUS_MISMATCH");
    expect409(await call("POST", `/reservations/${r.id}/apply-no-show-fee`, reception), "RESERVATION_STATUS_MISMATCH");
    assert.equal((await feeLines(r.id)).length, 0);
    assert.equal(await statusOf(r.id), "confirmed");
  });

  it("POST /no-show (recepción) → no_show con línea no_show_fee not_subject y folio abierto con saldo; repetir → 409; /apply-no-show-fee → idempotente", async () => {
    const marked = await call("POST", `/reservations/${r.id}/no-show`, reception, { payload: { reason: "No se presentó" } });
    assert.equal(marked.status, 200, marked.raw.slice(0, 400));
    assert.equal(marked.body.status, "no_show");
    const c = marked.body.cancellation;
    assert.deepEqual([c.mode, c.charge.amount, c.line?.type, c.line?.taxCategory, c.folio?.status, c.folio?.balanceDue], ["no_show", 150, "no_show_fee", "not_subject", "open", 150]);
    const lines = await feeLines(r.id);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]!.type, lines[0]!.taxCategory], ["no_show_fee", "not_subject"]);
    assert.ok(await auditOf("RESERVATION_NO_SHOW", r.id));

    expect409(await call("POST", `/reservations/${r.id}/no-show`, reception, { payload: { reason: "de nuevo" } }), "RESERVATION_NOT_ACTIVE");
    expect409(await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { reason: "ahora cancelar" } }), "RESERVATION_NOT_ACTIVE");
    const again = await call("POST", `/reservations/${r.id}/apply-no-show-fee`, reception);
    assert.equal(again.status, 200, again.raw.slice(0, 300));
    assert.deepEqual([again.body.alreadyApplied, again.body.line?.id, again.body.breakdown.amount], [true, lines[0]!.id, 150], "misma línea, nada nuevo");
    expect409(await call("POST", `/reservations/${r.id}/apply-cancellation-fee`, reception), "RESERVATION_STATUS_MISMATCH");
    assert.equal((await feeLines(r.id)).length, 1, "una sola penalización");
    assert.equal(await statusOf(r.id), "no_show");
  });
});

describe("corrector L3 · idempotencia de la penalización y depósito previo", () => {
  it("cancelar dos veces y luego no-show: una sola cancellation_fee, 409 en las repeticiones, la heredada devuelve alreadyApplied", async () => {
    const r = await newReservation({ arrivalDate: madridDay(0), departureDate: madridDay(2), totalAmount: 300, label: "doble" });
    const first = await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { reason: "primera" } });
    assert.equal(first.status, 200, first.raw.slice(0, 400));
    assert.deepEqual([first.body.cancellation.charge.amount, first.body.cancellation.folio?.balanceDue], [150, 150]);
    expect409(await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { reason: "segunda" } }), "RESERVATION_NOT_ACTIVE");
    expect409(await call("POST", `/reservations/${r.id}/no-show`, reception, { payload: { reason: "no-show" } }), "RESERVATION_NOT_ACTIVE");
    const legacy = await call("POST", `/reservations/${r.id}/apply-cancellation-fee`, reception);
    assert.equal(legacy.status, 200, legacy.raw.slice(0, 300));
    assert.equal(legacy.body.alreadyApplied, true);
    expect409(await call("POST", `/reservations/${r.id}/apply-no-show-fee`, reception), "RESERVATION_STATUS_MISMATCH");
    const lines = await feeLines(r.id);
    assert.deepEqual(lines.map((l) => [l.type, Number(l.total)]), [["cancellation_fee", 150]], "UNA línea de 150 € (total/noches), nunca 300 ni 450");
    assert.equal((await foliosOf(r.id)).length, 1, "sin folio secundario");
    assert.equal(await statusOf(r.id), "cancelled");
    assert.equal(Number((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).totalAmount), 300, "el importe de la reserva no cambia");
  });

  it("depósito capturado antes de cancelar: la penalización queda saldada pero el folio permanece abierto con pendingInvoice hasta emitir la factura (FC-2)", async () => {
    const r = await newReservation({ arrivalDate: madridDay(0), departureDate: madridDay(1), totalAmount: 150, label: "deposito" });
    const folio = (await foliosOf(r.id))[0]!;
    const deposit = await call("POST", `/folios/${folio.id}/payments`, reception, { payload: { amount: 150, method: "card" } });
    assert.equal(deposit.status, 201, deposit.raw.slice(0, 300));
    const cancelled = await call("POST", `/reservations/${r.id}/cancel`, reception, { payload: { reason: "No viaja; depósito retenido" } });
    assert.equal(cancelled.status, 200, cancelled.raw.slice(0, 400));
    const c = cancelled.body.cancellation;
    assert.deepEqual([c.charge.amount, c.line?.type, c.folio?.id, c.folio?.status, c.folio?.balanceDue, c.folio?.pendingInvoice], [150, "cancellation_fee", folio.id, "open", 0, true]);
    assert.equal((await prisma.folio.findUniqueOrThrow({ where: { id: folio.id } })).status, "open", "no se cierra sin documento");
    expect409(await call("POST", `/folios/${folio.id}/close`, reception), "FOLIO_UNINVOICED_LINES");
    const invoice = await issueFolioInvoice(folio.id);
    assert.deepEqual([invoice.total, invoice.taxTotal], [150, 0]);
    const closed = await call("POST", `/folios/${folio.id}/close`, reception);
    assert.equal(closed.status, 200, closed.raw.slice(0, 300));
    assert.equal(closed.body.status, "closed");
  });
});

describe("L3-B · processNoShows (paso del cierre del día)", () => {
  const businessDate = () => new Date(`${madridDay(0)}T00:00:00.000Z`);

  it("con la identidad de dirección general y las claves de jefatura de recepción (con modify): marca no_show, carga no_show_fee y audita autoNoShow", async () => {
    const fom = ROLE_PERMISSION_MAP.front_office_manager as readonly string[];
    assert.ok(fom.includes("pms.reservation.modify") && fom.includes("folio.charge.post") && fom.includes("night_audit.run"));
    const r = await newReservation({ arrivalDate: madridDay(-3), departureDate: madridDay(-2), totalAmount: 80, label: "noshow-1", allowPastArrival: true });
    const result = await lifecycle.processNoShows({ context: ctxOf(tenant.users.generalManager.id, fom), propertyId: tenant.propertyA, businessDate: businessDate(), correlationId: `corr_l3b_na1_${RUN}` });
    assert.equal(result.processedCount, 1);
    assert.equal(result.totalChargedEur, 80);
    assert.deepEqual(result.results.map((x) => [x.reservationId, x.code, x.charge, x.basis, x.folioStatus]), [[r.id, r.code, 80, "first_night", "open"]]);
    assert.equal(await statusOf(r.id), "no_show");
    const lines = await feeLines(r.id);
    assert.deepEqual(lines.map((l) => [l.type, l.taxCategory, Number(l.total)]), [["no_show_fee", "not_subject", 80]]);

    const transition = await auditOf("RESERVATION_NO_SHOW", r.id);
    assert.ok(transition, "RESERVATION_NO_SHOW (transitionReservation: SES baja, evento)");
    assert.match(String((transition.afterJson as { reason?: string }).reason), /cierre del día/);
    const companion = await auditOf("RESERVATION_CANCELLATION_POLICY", r.id);
    assert.ok(companion);
    const after = companion.afterJson as { autoNoShow?: boolean; source?: string; businessDate?: string; status?: string };
    assert.deepEqual([after.autoNoShow, after.source, after.businessDate, after.status], [true, "night_audit", madridDay(0), "no_show"]);
    assert.equal(companion.actorUserId, tenant.users.generalManager.id);
  });

  it("con las claves de night_auditor (SIN pms.reservation.modify): la autoridad de night_audit.run deriva modify solo para el paso", async () => {
    const nightAuditor = ROLE_PERMISSION_MAP.night_auditor as readonly string[];
    assert.ok(!nightAuditor.includes("pms.reservation.modify") && nightAuditor.includes("night_audit.run") && nightAuditor.includes("folio.charge.post"));
    const r = await newReservation({ arrivalDate: madridDay(-5), departureDate: madridDay(-4), totalAmount: 90, label: "noshow-2", allowPastArrival: true });
    const ctx = ctxOf(tenant.users.systems.id, nightAuditor);
    const actor = lifecycle.nightAuditActor(ctx);
    assert.ok(actor.permissions.includes("pms.reservation.modify") && !ctx.permissions.includes("pms.reservation.modify"), "el contexto original no cambia");
    const result = await lifecycle.processNoShows({ context: ctx, propertyId: tenant.propertyA, businessDate: businessDate(), correlationId: `corr_l3b_na2_${RUN}` });
    assert.equal(result.processedCount, 1, "solo la reserva pendiente: la anterior ya es no_show");
    assert.equal(result.results[0]?.reservationId, r.id);
    assert.equal(await statusOf(r.id), "no_show");
    assert.deepEqual((await feeLines(r.id)).map((l) => [l.type, Number(l.total)]), [["no_show_fee", 90]]);
    assert.ok(await auditOf("RESERVATION_NO_SHOW", r.id));
    const companion = await auditOf("RESERVATION_CANCELLATION_POLICY", r.id);
    assert.equal((companion?.afterJson as { autoNoShow?: boolean } | null)?.autoNoShow, true);
    assert.equal(await prisma.reservation.count({ where: { propertyId: tenant.propertyA, status: { in: ["draft", "confirmed"] }, arrivalDate: { lt: businessDate() } } }), 0, "sin candidatas pendientes");
  });
});

describe("L3-B · política por defecto: una sola por hotel", () => {
  it("PATCH SEMI isDefault=true (recepción) desmarca FLEX; la lista devuelve SEMI primera; POST con isDefault desmarca SEMI", async () => {
    const patched = await call("PATCH", `/cancellation-policies/${semiId}`, reception, { payload: { isDefault: true } });
    assert.equal(patched.status, 200, patched.raw.slice(0, 300));
    assert.equal(patched.body.isDefault, true);
    assert.equal((await prisma.cancellationPolicy.findUniqueOrThrow({ where: { id: flexId } })).isDefault, false);
    assert.equal(await prisma.cancellationPolicy.count({ where: { propertyId: tenant.propertyA, isDefault: true } }), 1);
    const list = await call("GET", `/properties/${tenant.propertyA}/cancellation-policies`, reception);
    assert.equal(list.body.items[0].code, "SEMI");

    const created = await call("POST", `/properties/${tenant.propertyA}/cancellation-policies`, reception, {
      payload: { code: `ESTR-${RUN}`, name: "Estricta", freeCancelHours: 48, penaltyType: "percent", penaltyValue: 50, isDefault: true }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    assert.equal(created.body.isDefault, true);
    assert.equal((await prisma.cancellationPolicy.findUniqueOrThrow({ where: { id: semiId } })).isDefault, false);
    assert.equal(await prisma.cancellationPolicy.count({ where: { propertyId: tenant.propertyA, isDefault: true } }), 1);
    assert.equal(await prisma.cancellationPolicy.count({ where: { propertyId: tenant.propertyB, isDefault: true } }), 0, "el hotel B no se toca");
  });
});
