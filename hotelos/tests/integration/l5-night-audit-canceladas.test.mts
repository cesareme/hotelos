/**
 * Tanda L5 · lote L5-D · cierre del día: preflight sobre la FECHA DE NEGOCIO,
 * puerta de preflight con `force` auditado, paso close_settled_folios (folios
 * de reservas canceladas / no presentadas / con salida hecha) y las acciones
 * T8a de revisión y reapertura — integración sobre Postgres real con una
 * organización AISLADA (helpers/l2-tenant.mts) y STRICT_ENV (auth real, sin
 * unión de permisos de demo, RBAC_STRICT=true).
 *
 * Usuarios (plantillas T8a, packages/shared/src/permissions.ts):
 *   · receptionist (hotel A, del helper): crea reservas, hace check-in / check-out,
 *     carga líneas y cobra (pms.reservation.create / pms.checkin.execute /
 *     pms.checkout.execute / folio.charge.post / payment.capture);
 *   · night_auditor (usuario extra, hotel A): lee el preflight (analytics.read) y
 *     corre el cierre (night_audit.run); NO tiene night_audit.review;
 *   · admin_clerk (usuario extra, hotel A): revisa (night_audit.review);
 *   · manager (usuario extra, hotel A): cancela (pms.reservation.modify) y reabre
 *     (night_audit.reopen).
 *
 * Casos:
 *   · business_dates del hotel = AYER (medianoche UTC): el preflight cuenta la
 *     llegada y la salida de ayer, no las del día natural;
 *   · cancelada por HTTP (L3) con folio vacío → L3 lo cierra al cancelar; una
 *     cancelada HISTÓRICA (anterior a L3, como las 42 de Rías Altas) con folio
 *     vacío abierto → el preflight la anuncia («se cerrará en el cierre») y el
 *     paso close_settled_folios la cierra;
 *   · cancelada con cargo sin cobrar → aviso (no bloquea), folio abierto;
 *   · cancelada cobrada sin factura → liquidada pero sin facturar: abierta, aviso;
 *   · con salida hecha y saldo → aviso del paso, folio abierto;
 *   · confirmada con llegada < fecha de negocio → run sin force 409
 *     NIGHT_AUDIT_PREFLIGHT_BLOCKED; force sin motivo → 400; recepción → 403;
 *   · run con force + motivo → completed, NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN en
 *     audit_events, report.preflightOverride, no-show procesado por L3;
 *   · segundo run (día siguiente) idempotente: settledFolios.closed = 0;
 *   · review por quien corrió → 409 runner_ne_reviewer; por admin_clerk → reviewed;
 *   · reopen por manager con reasonCode válido → reopened (entriesReversed false);
 *   · invariantes de Faranda (invoices / verifactuSubmissions / reservations) y
 *     business_dates / night_audit_runs de prop_123 intactas.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l5-night-audit-canceladas.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `n${newRunId()}`;
const DEMO_PROPERTY = "prop_123";
const FORCE_REASON = `prueba de integración L5-D ${RUN}: cierre forzado sobre bloqueos conocidos`;

let app: ApiApp;
let A: IsolatedTenant;
let reception: Session;
let auditor: Session;
let clerk: Session;
let manager: Session;
let auditorId = "";
let clerkId = "";
let managerId = "";
let invariantsBefore: { invoices: number; verifactuSubmissions: number; reservations: number };
let demoBefore: { businessDate: string | null; runs: number };

/** Local (Europe/Madrid) calendar day + offset as YYYY-MM-DD — reservation dates are that day at UTC midnight. */
function madridDay(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
const dayUtc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const TODAY = madridDay(0);
const YESTERDAY = madridDay(-1);
const TWO_DAYS_AGO = madridDay(-2);
const THREE_DAYS_AGO = madridDay(-3);

/** Fixtures (reservation ids / folio ids) by case. */
const fx = {
  cancelledViaHttp: { reservationId: "", folioId: "" },
  cancelledHistorical: { reservationId: "", folioId: "" },
  cancelledWithCharge: { reservationId: "", folioId: "" },
  cancelledPaidUninvoiced: { reservationId: "", folioId: "" },
  checkedOutWithBalance: { reservationId: "", folioId: "" },
  noShowCandidate: { reservationId: "", folioId: "" },
  arrivalYesterday: { reservationId: "", folioId: "" },
  arrivalToday: { reservationId: "", folioId: "" },
  departureYesterday: { reservationId: "", folioId: "" }
};
let firstRunId = "";

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), "x-property-id": A.propertyA },
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

async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId: string }): Promise<{ id: string; email: string }> {
  const id = `usr_l2_${spec.local}_${tenant.run}`;
  const email = `${spec.local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L5-D ${spec.local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[spec.templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: { userId: id, roleId, scopeType: "property", propertyId: spec.propertyId, organizationId: tenant.organizationId, reason: `l5-d ${spec.local}` }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

/** Reservation through the product route (confirmed; createReservation opens the primary folio). */
async function createReservation(label: string, arrival: string, departure: string): Promise<{ reservationId: string; folioId: string; code: string }> {
  const created = await call("POST", `/properties/${A.propertyA}/reservations`, reception, {
    payload: { arrivalDate: arrival, departureDate: departure, adults: 1, roomTypeId: A.roomTypeA, bookerName: `L5-D ${label} ${RUN}` }
  });
  assert.ok(created.status === 200 || created.status === 201, `${label}: ${created.raw.slice(0, 400)}`);
  assert.equal(created.body.status, "confirmed");
  const folio = await prisma.folio.findFirst({ where: { reservationId: created.body.id, status: "open", deletedAt: null }, orderBy: { isPrimary: "desc" }, select: { id: true } });
  assert.ok(folio, `${label}: la reserva nace con folio abierto`);
  return { reservationId: created.body.id, folioId: folio.id, code: created.body.code };
}

/** Historical row (before L3 / imported): status given, dates given, ONE open empty folio — like the 42 cancelled folios of the pilot. */
async function createHistoricalReservation(label: string, status: string, arrival: string, departure: string): Promise<{ reservationId: string; folioId: string; code: string }> {
  const code = `L5D-${RUN}-${label}`.toUpperCase();
  const reservation = await prisma.reservation.create({
    data: { propertyId: A.propertyA, code, channel: "direct", status, arrivalDate: dayUtc(arrival), departureDate: dayUtc(departure), adults: 1, bookerName: `L5-D ${label} ${RUN}`, currency: "EUR", roomTypeId: A.roomTypeA, totalAmount: 100 },
    select: { id: true }
  });
  const folio = await prisma.folio.create({ data: { reservationId: reservation.id, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } });
  return { reservationId: reservation.id, folioId: folio.id, code };
}

async function postLine(folioId: string, unitPrice: number, description: string): Promise<void> {
  const line = await call("POST", `/folios/${folioId}/lines`, reception, { payload: { type: "room", description, quantity: 1, unitPrice } });
  assert.ok(line.status === 200 || line.status === 201, `line on ${folioId}: ${line.raw.slice(0, 300)}`);
}

async function capture(folioId: string, amount: number, tag: string): Promise<void> {
  const res = await call("POST", `/folios/${folioId}/payments`, reception, { payload: { amount, method: "cash", clientRequestId: `l5d-${RUN}-${tag}` } });
  assert.ok(res.status === 200 || res.status === 201, `capture ${tag}: ${res.raw.slice(0, 300)}`);
}

async function cancel(reservationId: string, label: string): Promise<Reply> {
  const res = await call("POST", `/reservations/${reservationId}/cancel`, manager, { payload: { reason: `L5-D ${label}` } });
  assert.equal(res.status, 200, `${label}: ${res.raw.slice(0, 400)}`);
  assert.equal(res.body.status, "cancelled");
  return res;
}

async function folioStatus(folioId: string): Promise<string> {
  return (await prisma.folio.findUniqueOrThrow({ where: { id: folioId }, select: { status: true } })).status;
}

async function businessDateOf(propertyId: string): Promise<string | null> {
  const row = await prisma.businessDate.findUnique({ where: { propertyId }, select: { currentDate: true } });
  return row ? row.currentDate.toISOString().slice(0, 10) : null;
}

async function demoFootprint(): Promise<{ businessDate: string | null; runs: number }> {
  return { businessDate: await businessDateOf(DEMO_PROPERTY), runs: await prisma.nightAuditRun.count({ where: { propertyId: DEMO_PROPERTY } }) };
}

function check(reply: Reply, id: string): { id: string; status: string; count: number | null; detail: string; items?: Array<{ ref: string; label: string }> } {
  const found = (reply.body?.checks as Array<any>).find((c) => c.id === id);
  assert.ok(found, `check ${id} in ${reply.raw.slice(0, 300)}`);
  return found;
}

before(async () => {
  const all = await farandaInvariants();
  invariantsBefore = { invoices: all.invoices, verifactuSubmissions: all.verifactuSubmissions, reservations: all.reservations };
  demoBefore = await demoFootprint();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  await prisma.room.updateMany({ where: { propertyId: A.propertyA }, data: { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true } });

  const auditorUser = await addTenantUser(A, { local: "auditor", templateKey: "night_auditor", propertyId: A.propertyA });
  // The night_auditor template never holds night_audit.review (static SoD
  // pair: a runner without the key gets 403 from the manifest). To exercise
  // the DYNAMIC rule «quien corre ≠ quien revisa» (409 runner_ne_reviewer) the
  // runner also gets the admin_clerk template, seeded directly as rbac-sod does.
  await prisma.userRoleAssignment.create({
    data: { userId: auditorUser.id, roleId: A.roles.admin_clerk!, scopeType: "property", propertyId: A.propertyA, organizationId: A.organizationId, reason: "l5-d runner with review key (dynamic SoD)" }
  });
  resetRbacScopeCacheForTests();
  const clerkUser = await addTenantUser(A, { local: "clerk", templateKey: "admin_clerk", propertyId: A.propertyA });
  const managerUser = await addTenantUser(A, { local: "manager", templateKey: "manager", propertyId: A.propertyA });
  auditorId = auditorUser.id;
  clerkId = clerkUser.id;
  managerId = managerUser.id;
  await withEnv(STRICT_ENV, async () => {
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l5-d-reception");
    auditor = await loginOrThrow(app, auditorUser.email, A.password, "l5-d-auditor");
    clerk = await loginOrThrow(app, clerkUser.email, A.password, "l5-d-clerk");
    manager = await loginOrThrow(app, managerUser.email, A.password, "l5-d-manager");
  });

  // The hotel's business date is YESTERDAY (UTC midnight of the calendar day, like every reservation date).
  await prisma.businessDate.upsert({
    where: { propertyId: A.propertyA },
    update: { currentDate: dayUtc(YESTERDAY), closedAt: null, closedBy: null },
    create: { propertyId: A.propertyA, currentDate: dayUtc(YESTERDAY) }
  });

  // --- fixtures ------------------------------------------------------------
  // (1) cancelled through the L3 route with an empty folio: L3 closes the folio at 0.
  const viaHttp = await createReservation("cancel-http", madridDay(5), madridDay(7));
  fx.cancelledViaHttp = viaHttp;
  const cancelled = await cancel(viaHttp.reservationId, "cancel-http");
  assert.equal(cancelled.body.cancellation?.folio?.status, "closed", `L3 closes the empty folio at cancel: ${JSON.stringify(cancelled.body.cancellation)}`);

  // (2) historical cancellation (pre-L3): cancelled with an OPEN empty folio.
  fx.cancelledHistorical = await createHistoricalReservation("hist-cancel", "cancelled", THREE_DAYS_AGO, YESTERDAY);

  // (3) cancelled with an uncollected charge: folio stays open with a balance.
  const withCharge = await createReservation("cancel-charge", madridDay(5), madridDay(7));
  fx.cancelledWithCharge = withCharge;
  await postLine(withCharge.folioId, 80, "Suplemento no cobrado");
  const cancelledWithCharge = await cancel(withCharge.reservationId, "cancel-charge");
  assert.equal(cancelledWithCharge.body.cancellation?.folio?.status, "open");

  // (4) cancelled, charged and paid but never invoiced: settled, pendingInvoice.
  const paid = await createReservation("cancel-paid", madridDay(5), madridDay(7));
  fx.cancelledPaidUninvoiced = paid;
  await postLine(paid.folioId, 60, "Suplemento cobrado sin factura");
  await capture(paid.folioId, 60, "paid");
  const cancelledPaid = await cancel(paid.reservationId, "cancel-paid");
  assert.equal(cancelledPaid.body.cancellation?.folio?.status, "open");
  assert.equal(cancelledPaid.body.cancellation?.folio?.pendingInvoice, true, JSON.stringify(cancelledPaid.body.cancellation?.folio));

  // (5) checked out today with an acknowledged balance: folio open with 50 €.
  const out = await createReservation("checkout-balance", TODAY, madridDay(1));
  fx.checkedOutWithBalance = out;
  const room = await prisma.room.findFirst({ where: { propertyId: A.propertyA, number: "101" }, select: { id: true } });
  assert.ok(room);
  const checkIn = await call("POST", `/reservations/${out.reservationId}/check-in`, reception, { payload: { roomId: room.id } });
  assert.equal(checkIn.status, 200, checkIn.raw.slice(0, 400));
  await postLine(out.folioId, 50, "Minibar sin cobrar");
  const checkOut = await call("POST", `/reservations/${out.reservationId}/check-out`, reception, { payload: { acknowledgeBalance: true } });
  assert.equal(checkOut.status, 200, checkOut.raw.slice(0, 400));
  assert.equal(checkOut.body.reservation?.status, "checked_out");
  assert.equal(await folioStatus(out.folioId), "open", "an acknowledged balance keeps the folio open");

  // (6) confirmed with arrival BEFORE the business date: unresolved no-show (blocker).
  fx.noShowCandidate = await createHistoricalReservation("noshow", "confirmed", TWO_DAYS_AGO, YESTERDAY);
  // (7) confirmed arriving on the business date (yesterday): arrivals_pending counts it.
  fx.arrivalYesterday = await createHistoricalReservation("arr-yday", "confirmed", YESTERDAY, madridDay(2));
  // (8) confirmed arriving TODAY (calendar day): NOT an arrival of the business date.
  fx.arrivalToday = await createReservation("arr-today", TODAY, madridDay(2));
  // (9) in house with departure on the business date: departures_not_checked_out counts it.
  fx.departureYesterday = await createHistoricalReservation("dep-yday", "checked_in", THREE_DAYS_AGO, YESTERDAY);
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
  } finally {
    await app?.close();
  }
  const all = await farandaInvariants();
  assert.deepEqual({ invoices: all.invoices, verifactuSubmissions: all.verifactuSubmissions, reservations: all.reservations }, invariantsBefore, "las cifras de Faranda no cambian");
  assert.deepEqual(await demoFootprint(), demoBefore, "business_dates y night_audit_runs de prop_123 intactas");
  assert.equal(await prisma.organization.count({ where: { id: A.organizationId } }), 0, "sin organización residual de esta suite");
});

// ---------------------------------------------------------------------------
// preflight sobre la fecha de negocio
// ---------------------------------------------------------------------------

describe("L5-D · preflight medido sobre la fecha de negocio (ayer)", () => {
  it("expone businessDate = ayer y cuenta la llegada y la salida de AYER, no las del día natural; anuncia el folio liquidado que se cerrará", async () => {
    const preflight = await call("GET", `/properties/${A.propertyA}/night-audit/preflight`, auditor);
    assert.equal(preflight.status, 200, preflight.raw.slice(0, 300));
    assert.equal(preflight.body.businessDate, YESTERDAY);
    assert.equal(preflight.body.canClose, false);

    const arrivals = check(preflight, "arrivals_pending");
    assert.equal(arrivals.count, 1, JSON.stringify(arrivals));
    assert.equal(arrivals.status, "warning");
    assert.deepEqual(arrivals.items?.map((i) => i.ref), [fx.arrivalYesterday.reservationId], "solo la llegada de la fecha de negocio (la de hoy natural no cuenta)");

    const noShows = check(preflight, "unresolved_no_shows");
    assert.equal(noShows.status, "blocker");
    assert.deepEqual(noShows.items?.map((i) => i.ref), [fx.noShowCandidate.reservationId]);

    const departures = check(preflight, "departures_not_checked_out");
    assert.equal(departures.status, "blocker");
    assert.deepEqual(departures.items?.map((i) => i.ref), [fx.departureYesterday.reservationId]);

    const folios = check(preflight, "open_folios_with_balance");
    assert.equal(folios.status, "blocker", "the checked-out folio with a balance still blocks (count and status unchanged)");
    assert.equal(folios.count, 1);
    assert.deepEqual(folios.items?.map((i) => i.ref), [fx.checkedOutWithBalance.reservationId]);
    assert.match(folios.detail, /1 folio de reservas canceladas o no presentadas conserva 80,00 € sin cobrar: no bloquea el cierre\./);
    assert.match(folios.detail, /1 folio liquidado de reservas canceladas, no presentadas o con salida hecha se cerrará en el cierre del día\./, folios.detail);
    assert.doesNotMatch(folios.detail, /2 folios liquidados/, "the paid-but-uninvoiced folio is settled but NOT closable: never announced");
  });
});

// ---------------------------------------------------------------------------
// puerta de preflight
// ---------------------------------------------------------------------------

describe("L5-D · puerta de preflight en POST …/night-audit/run", () => {
  it("sin force → 409 NIGHT_AUDIT_PREFLIGHT_BLOCKED con los bloqueos; force sin motivo → 400; recepción → 403 antes de la puerta; nada se escribe", async () => {
    const blocked = await call("POST", `/properties/${A.propertyA}/night-audit/run`, auditor, { payload: {} });
    assert.equal(blocked.status, 409, blocked.raw.slice(0, 400));
    assert.equal(blocked.body.details?.code, "NIGHT_AUDIT_PREFLIGHT_BLOCKED");
    assert.equal(blocked.body.details?.businessDate, YESTERDAY);
    const blockerIds = (blocked.body.details?.blockers as Array<{ id: string }>).map((b) => b.id).sort();
    assert.deepEqual(blockerIds, ["departures_not_checked_out", "open_folios_with_balance", "unresolved_no_shows"]);
    assert.match(String(blocked.body.message), /^No se puede ejecutar el cierre: /);

    const noBody = await call("POST", `/properties/${A.propertyA}/night-audit/run`, auditor);
    assert.equal(noBody.status, 409, "an absent body is the plain close");

    const noReason = await call("POST", `/properties/${A.propertyA}/night-audit/run`, auditor, { payload: { force: true } });
    assert.equal(noReason.status, 400, noReason.raw.slice(0, 300));
    assert.match(String(noReason.body.message), /Indica el motivo para cerrar con bloqueos/);
    const shortReason = await call("POST", `/properties/${A.propertyA}/night-audit/run`, auditor, { payload: { force: true, reasonText: "corto" } });
    assert.equal(shortReason.status, 400, shortReason.raw.slice(0, 300));

    const byReception = await call("POST", `/properties/${A.propertyA}/night-audit/run`, reception, { payload: { force: true, reasonText: FORCE_REASON } });
    assert.equal(byReception.status, 403, byReception.raw.slice(0, 300));

    assert.equal(await prisma.nightAuditRun.count({ where: { propertyId: A.propertyA } }), 0, "a refused close writes no run row");
    assert.equal(await businessDateOf(A.propertyA), YESTERDAY, "the business date did not move");
    assert.equal(await folioStatus(fx.cancelledHistorical.folioId), "open", "nothing closed before the run");
  });

  it("con force + motivo → completed, NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN auditado, report.preflightOverride, no-show procesado por L3 y close_settled_folios cierra solo el folio vacío", async () => {
    const forced = await call("POST", `/properties/${A.propertyA}/night-audit/run`, auditor, { payload: { force: true, reasonText: FORCE_REASON } });
    assert.equal(forced.status, 200, forced.raw.slice(0, 600));
    const run = forced.body;
    firstRunId = String(run.id);
    assert.equal(run.status, "completed", run.errorMessage);
    assert.equal(run.businessDate, YESTERDAY);
    assert.equal(run.startedBy, auditorId);

    // The override in the report and in the audit chain.
    assert.equal(run.report?.preflightOverride?.reasonText, FORCE_REASON);
    assert.deepEqual(
      (run.report?.preflightOverride?.blockers as Array<{ id: string }>).map((b) => b.id).sort(),
      ["departures_not_checked_out", "open_folios_with_balance", "unresolved_no_shows"]
    );
    await flushAuditQueues();
    const overridden = await prisma.auditEvent.findFirst({ where: { action: "NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN", entityType: "night_audit_run", entityId: run.id } });
    assert.ok(overridden, "NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN in audit_events");
    const after = overridden.afterJson as { reasonText?: string; businessDate?: string; blockers?: Array<{ id: string }> };
    assert.equal(after.reasonText, FORCE_REASON);
    assert.equal(after.businessDate, YESTERDAY);
    assert.equal(after.blockers?.length, 3);
    assert.equal(overridden.actorUserId, auditorId);

    // L3 processed the no-show (policy: none → 0 €) and closed its empty folio.
    assert.equal(run.report?.noShows?.processed, 1, JSON.stringify(run.report?.noShows));
    const noShow = await prisma.reservation.findUniqueOrThrow({ where: { id: fx.noShowCandidate.reservationId }, select: { status: true } });
    assert.equal(noShow.status, "no_show");
    assert.equal(await folioStatus(fx.noShowCandidate.folioId), "closed", "L3 closes the empty folio of the no-show");

    // close_settled_folios: the historical empty folio closes; the ones with a
    // balance (cancelled 80 €, checked-out 50 €) and the paid-but-uninvoiced one stay open as warnings.
    const step = run.stepResults.find((s: { step: string }) => s.step === "close_settled_folios");
    assert.ok(step, "close_settled_folios step");
    assert.equal(step.status, "ok", JSON.stringify(step));
    assert.deepEqual(run.report?.settledFolios, { closed: 1, pendingInvoice: 1, withBalance: 2, totalWithBalance: "130.00" });
    assert.equal(await folioStatus(fx.cancelledHistorical.folioId), "closed", "the historical empty folio is closed by the run");
    assert.equal(await folioStatus(fx.cancelledWithCharge.folioId), "open");
    assert.equal(await folioStatus(fx.cancelledPaidUninvoiced.folioId), "open");
    assert.equal(await folioStatus(fx.checkedOutWithBalance.folioId), "open");
    assert.ok((run.report?.warnings as string[]).includes("2 folios de reservas cerradas conservan 130,00 € sin cobrar."), (run.report?.warnings as string[]).join(" | "));
    assert.ok((run.report?.warnings as string[]).includes("1 folio liquidado de reservas cerradas conserva cargos sin facturar: emite la factura para cerrarlo."));
    const closedAudit = await prisma.auditEvent.count({ where: { action: "FOLIO_CLOSED", entityType: "folio", entityId: fx.cancelledHistorical.folioId } });
    assert.equal(closedAudit, 1, "FOLIO_CLOSED audited by the folio engine");

    // The steps keep their order; the business date advanced to today.
    const order = run.stepResults.map((s: { step: string }) => s.step);
    assert.ok(order.indexOf("process_no_shows") < order.indexOf("close_settled_folios") && order.indexOf("close_settled_folios") < order.indexOf("revenue_snapshot"), order.join(" > "));
    assert.equal(await businessDateOf(A.propertyA), TODAY);
    assert.equal(run.report?.nextBusinessDate, TODAY);
  });

  it("segundo run (fecha de negocio = hoy) es idempotente: settledFolios.closed = 0 y los mismos avisos; sin bloqueos nuevos que forzar no se audita override", async () => {
    // Yesterday's arrival is now an unresolved no-show and the in-house departure still blocks: force again.
    const preflight = await call("GET", `/properties/${A.propertyA}/night-audit/preflight`, auditor);
    assert.equal(preflight.body.businessDate, TODAY);
    assert.equal(check(preflight, "arrivals_pending").count, 1, "today's arrival is now the pending one");
    assert.deepEqual(check(preflight, "arrivals_pending").items?.map((i) => i.ref), [fx.arrivalToday.reservationId]);
    assert.doesNotMatch(check(preflight, "open_folios_with_balance").detail, /se cerrarán? en el cierre del día/, "nothing settled left to close");

    const second = await call("POST", `/properties/${A.propertyA}/night-audit/run`, auditor, { payload: { force: true, reasonText: FORCE_REASON } });
    assert.equal(second.status, 200, second.raw.slice(0, 600));
    assert.equal(second.body.status, "completed", second.body.errorMessage);
    assert.equal(second.body.businessDate, TODAY);
    assert.deepEqual(second.body.report?.settledFolios, { closed: 0, pendingInvoice: 1, withBalance: 2, totalWithBalance: "130.00" });
    assert.equal(second.body.report?.noShows?.processed, 1, "yesterday's arrival became a no-show");
    assert.equal(await prisma.folio.count({ where: { reservation: { propertyId: A.propertyA, status: { in: ["cancelled", "no_show", "checked_out"] } }, status: "open", deletedAt: null } }), 3, "the three folios with balance / uninvoiced charges stay open");
    assert.equal(await prisma.nightAuditRun.count({ where: { propertyId: A.propertyA, status: "completed" } }), 2);
  });
});

// ---------------------------------------------------------------------------
// revisión y reapertura (T8a) sobre el primer cierre
// ---------------------------------------------------------------------------

describe("L5-D · revisión y reapertura del cierre", () => {
  it("review por quien corrió → 409 runner_ne_reviewer; por administración → reviewed (campos en el wire)", async () => {
    assert.ok(firstRunId, "first run exists");
    const self = await call("POST", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}/review`, auditor, { payload: { note: "yo mismo" } });
    assert.equal(self.status, 409, self.raw.slice(0, 300));
    assert.equal(self.body.details?.rule, "runner_ne_reviewer");

    const reviewed = await call("POST", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}/review`, clerk, { payload: { note: "Revisión de ingresos correcta" } });
    assert.equal(reviewed.status, 200, reviewed.raw.slice(0, 300));
    assert.equal(reviewed.body.reviewedByUserId, clerkId);
    assert.ok(reviewed.body.reviewedAt, "reviewedAt on the wire");
    assert.equal(reviewed.body.reopenedByUserId, null);

    const detail = await call("GET", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}`, auditor);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.reviewedByUserId, clerkId);
    assert.equal(detail.body.report?.preflightOverride?.reasonText, FORCE_REASON, "the persisted report keeps the override");

    const again = await call("POST", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}/review`, clerk, { payload: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.details?.code, "NIGHT_AUDIT_ALREADY_REVIEWED");
  });

  it("reopen por dirección con reasonCode válido → reopened (entriesReversed false); código inválido → 400; recepción → 403", async () => {
    const bad = await call("POST", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}/reopen`, manager, { payload: { reasonCode: "invented" } });
    assert.equal(bad.status, 400, bad.raw.slice(0, 300));

    const byReception = await call("POST", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}/reopen`, reception, { payload: { reasonCode: "other", reasonText: "no debería poder" } });
    assert.equal(byReception.status, 403, byReception.raw.slice(0, 300));

    const reopened = await call("POST", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}/reopen`, manager, { payload: { reasonCode: "audit_finding", reasonText: "Hallazgo de la revisión de ingresos" } });
    assert.equal(reopened.status, 200, reopened.raw.slice(0, 400));
    assert.equal(reopened.body.status, "reopened");
    assert.equal(reopened.body.reopenedByUserId, managerId);
    assert.equal(reopened.body.reopenReasonCode, "audit_finding");
    assert.ok(reopened.body.reopenedAt);
    assert.equal(reopened.body.reviewedByUserId, clerkId, "the review trace survives the reopening");
    assert.ok(reopened.body.daysSinceBusinessDate <= 7);
    assert.equal(reopened.body.authorization, null, "within the window the key suffices");

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "NIGHT_AUDIT_REOPENED", entityType: "night_audit_run", entityId: firstRunId } });
    assert.ok(audit);
    assert.equal((audit.afterJson as { entriesReversed?: boolean }).entriesReversed, false);
    assert.equal(await folioStatus(fx.cancelledHistorical.folioId), "closed", "reopening reverses nothing");

    const twice = await call("POST", `/properties/${A.propertyA}/night-audit/runs/${firstRunId}/reopen`, manager, { payload: { reasonCode: "other", reasonText: "segunda vez" } });
    assert.equal(twice.status, 409, "only a completed run reopens");
    assert.equal(twice.body.details?.code, "NIGHT_AUDIT_NOT_COMPLETED");
  });
});
