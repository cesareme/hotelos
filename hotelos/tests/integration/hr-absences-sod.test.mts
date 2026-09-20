/**
 * Tanda RRHH · RRHH-4 — turnos, fichajes y ausencias por FICHA con separación
 * de funciones (app.inject, Postgres real, tenant aislado de helpers/l2-tenant.mts).
 *
 *   · la persona es siempre una ficha (StaffProfile) de la propiedad: `staffProfileId`
 *     o alias (`staffName` = código de empleado o nombre completo del usuario,
 *     insensible a mayúsculas) → id real; sin ficha → 400 HR_EMPLOYEE_REQUIRED y
 *     nada se guarda; el fichaje no guarda nombres en metadataJson;
 *   · la ausencia persiste requestedBy (= actor), reason y tipo tasado; quien la
 *     solicitó no la aprueba ni la rechaza (409 APPROVAL_SELF_DECISION, la fila no
 *     cambia); otro usuario con workforce.schedule.manage sí (200, approvedBy y
 *     decidedAt); el solicitante puede cancelarla (decidedAt sin approvedBy);
 *   · la lista `workforce_labor:absence_requests` filtra por estado (400 si no es
 *     un estado de la máquina);
 *   · el motor de reglas (hr/rules.engine.ts) devuelve `warnings` al crear un
 *     turno (descanso < 12 h, tope diario) sin bloquear;
 *   · corrector RRHH (RF-01): con solo workforce.timeclock.use se ficha SIEMPRE con la
 *     ficha propia y con la hora del servidor (otra ficha → 403 HR_TIMECLOCK_SELF_ONLY;
 *     `at` se ignora); con workforce.timeclock.manage se ficha por terceros y con `at`;
 *   · corrector RRHH (RF-03): GET /hr/absences y GET …/time-clock con solo workforce.read
 *     devuelven únicamente las filas de las fichas del actor; POST /workforce/me/absences
 *     (workforce.timeclock.use) solicita la ausencia propia sin nombrar a nadie.
 *
 * Usuarios ficticios del tenant aislado; Faranda no cambia; al terminar borra la
 * organización. Sin nombres de personas reales.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/hr-absences-sod.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { listAdvancedRecords } = await import("../../apps/api/src/modules/advanced/advanced-modules.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH", url: string, session: Session, propertyId: string, payload?: unknown): Promise<Reply> {
  const res = await app.inject({ method, url, headers: { ...session.headers, "x-property-id": propertyId }, ...(payload === undefined ? {} : { payload }) });
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body };
}

const payloadOf = (reply: Reply): Json => (reply.body.payload as Json | undefined) ?? {};
const detailsCode = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
const created = (reply: Reply, label: string): string => {
  assert.ok([200, 201].includes(reply.status), `${label}: ${reply.status} ${JSON.stringify(reply.body).slice(0, 300)}`);
  assert.equal(typeof reply.body.id, "string", `${label}: sin id en la respuesta`);
  return reply.body.id as string;
};

/** Usuario extra con una plantilla (`manager`: workforce.schedule.manage; `housekeeper`: workforce.read + timeclock.use) en A.propertyA; cuelga de la organización → cleanupTenant lo barre. */
async function addManager(tenant: IsolatedTenant, key: string, templateKey = "manager"): Promise<{ id: string; email: string; fullName: string }> {
  const id = `usr_hrsod_${key}_${tenant.run}`;
  const email = `${key}.hrsod.${tenant.run}@faranda.test`;
  const fullName = `HR SoD ${key} ${tenant.run}`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId: tenant.propertyA, organizationId: tenant.organizationId, reason: `hr-absences-sod ${key}` } });
  resetRbacScopeCacheForTests();
  return { id, email, fullName };
}

describe("RRHH-4 · turnos, fichajes y ausencias por ficha con separación de funciones", () => {
  let app: ApiApp;
  let A: IsolatedTenant;
  let requester: Session; // manager 1: solicita la ausencia y crea turnos
  let decider: Session; // manager 2: decide
  let receptionist: Session; // workforce.timeclock.use
  let housekeeper: Session; // housekeeper: workforce.read + workforce.timeclock.use (RF-01 / RF-03)
  let requesterId = "";
  let deciderId = "";
  let deciderFullName = "";
  let housekeeperId = "";
  /** Ficha de la recepcionista (código EMP-042) en A.propertyA. */
  let profileId = "";
  /** Ficha del manager 2 (sin código): resoluble solo por el nombre del usuario. */
  let deciderProfileId = "";
  /** Ficha de la camarera de pisos (código HSK-007) en A.propertyA. */
  let housekeeperProfileId = "";
  let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

  before(async () => {
    invariantsBefore = await farandaInvariants();
    app = await buildApiServer();
    A = await createIsolatedTenant(`h${newRunId()}`);
    await enableModules(A.propertyA, ["workforce_labor"]);
    await enableModules(A.propertyB, ["workforce_labor"]);
    const requesterUser = await addManager(A, "req");
    const deciderUser = await addManager(A, "dec");
    const housekeeperUser = await addManager(A, "hsk", "housekeeper");
    requesterId = requesterUser.id;
    deciderId = deciderUser.id;
    deciderFullName = deciderUser.fullName;
    housekeeperId = housekeeperUser.id;
    profileId = `sp_hrsod_rec_${A.run}`;
    deciderProfileId = `sp_hrsod_dec_${A.run}`;
    housekeeperProfileId = `sp_hrsod_hsk_${A.run}`;
    await prisma.staffProfile.create({ data: { id: profileId, userId: A.users.receptionist.id, propertyId: A.propertyA, employeeCode: "EMP-042", active: true } });
    await prisma.staffProfile.create({ data: { id: deciderProfileId, userId: deciderUser.id, propertyId: A.propertyA, employeeCode: null, active: true } });
    await prisma.staffProfile.create({ data: { id: housekeeperProfileId, userId: housekeeperUser.id, propertyId: A.propertyA, employeeCode: "HSK-007", active: true } });
    await strict(async () => {
      requester = await loginOrThrow(app, requesterUser.email, A.password);
      decider = await loginOrThrow(app, deciderUser.email, A.password);
      receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
      housekeeper = await loginOrThrow(app, housekeeperUser.email, A.password);
    });
  });

  after(async () => {
    try {
      if (A) await cleanupTenant(A.organizationId);
    } finally {
      await app?.close();
    }
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
    assert.equal(await prisma.organization.count({ where: { id: A.organizationId } }), 0, "sin organización residual de esta suite");
  });

  it("un alias sin ficha es un 400 HR_EMPLOYEE_REQUIRED y no se guarda nada (turno, fichaje, ausencia)", async () =>
    strict(async () => {
      const before = { shifts: await prisma.shift.count({ where: { propertyId: A.propertyA } }), clocks: await prisma.timeClockEntry.count({ where: { propertyId: A.propertyA } }), absences: await prisma.absenceRequest.count({ where: { propertyId: A.propertyA } }) };
      const shift = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, requester, A.propertyA, { staffName: "nadie-000", startAt: "2026-10-05T09:00:00.000Z", endAt: "2026-10-05T17:00:00.000Z" });
      assert.equal(shift.status, 400, JSON.stringify(shift.body));
      assert.equal(detailsCode(shift), "HR_EMPLOYEE_REQUIRED");
      assert.match(String(shift.body.message), /ficha de personal/);
      const clock = await call(app, "POST", "/workforce/time-clock/clock-in", receptionist, A.propertyA, { propertyId: A.propertyA, staffName: "nadie-000", action: "in" });
      assert.equal(clock.status, 400);
      assert.equal(detailsCode(clock), "HR_EMPLOYEE_REQUIRED");
      const absence = await call(app, "POST", "/workforce/absences", requester, A.propertyA, { staffName: "nadie-000", absenceType: "vacation", startDate: "2026-11-02", endDate: "2026-11-06" });
      assert.equal(absence.status, 400);
      assert.equal(detailsCode(absence), "HR_EMPLOYEE_REQUIRED");
      // Un id de ficha inexistente (o de otra propiedad) sigue siendo el 404 opaco del motor.
      assert.equal((await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, requester, A.propertyA, { staffProfileId: "sp_no_existe", startAt: "2026-10-05T09:00:00.000Z", endAt: "2026-10-05T17:00:00.000Z" })).status, 404);
      const after_ = { shifts: await prisma.shift.count({ where: { propertyId: A.propertyA } }), clocks: await prisma.timeClockEntry.count({ where: { propertyId: A.propertyA } }), absences: await prisma.absenceRequest.count({ where: { propertyId: A.propertyA } }) };
      assert.deepEqual(after_, before, "nada se persiste con un alias sin ficha");
    }));

  it("alias por código de empleado (insensible a mayúsculas) y por nombre de usuario → id real; el fichaje no guarda nombres en metadataJson", async () =>
    strict(async () => {
      const byCode = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, requester, A.propertyA, { staffName: "emp-042", role: "recepción", startAt: "2026-10-05T09:00:00.000Z", endAt: "2026-10-05T17:00:00.000Z" });
      const shiftId = created(byCode, "POST shifts (alias código)");
      assert.equal(payloadOf(byCode).staffProfileId, profileId);
      assert.equal(payloadOf(byCode).staffName, A.users.receptionist.fullName, "el nombre visible sale del usuario de la ficha");
      assert.deepEqual(byCode.body.warnings, [], "un turno de 8 h sin vecinos no tiene avisos");
      const shiftRow = await prisma.shift.findUnique({ where: { id: shiftId }, select: { staffProfileId: true, propertyId: true } });
      assert.equal(shiftRow?.staffProfileId, profileId, "SELECT: staff_profile_id es el id real");
      assert.equal(shiftRow?.propertyId, A.propertyA);

      const byName = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, requester, A.propertyA, { staffName: deciderFullName.toUpperCase(), startAt: "2026-10-06T09:00:00.000Z", endAt: "2026-10-06T17:00:00.000Z" });
      created(byName, "POST shifts (alias nombre de usuario)");
      assert.equal(payloadOf(byName).staffProfileId, deciderProfileId, "el nombre completo del usuario (mayúsculas) resuelve a su ficha");

      const clock = await call(app, "POST", "/workforce/time-clock/clock-in", receptionist, A.propertyA, { propertyId: A.propertyA, staffName: "EMP-042", action: "in", at: "2026-10-05T08:58:00.000Z" });
      const clockId = created(clock, "POST clock-in (alias)");
      assert.equal(payloadOf(clock).staffProfileId, profileId);
      assert.equal(payloadOf(clock).staffName, A.users.receptionist.fullName);
      const clockRow = await prisma.timeClockEntry.findUnique({ where: { id: clockId }, select: { staffProfileId: true, metadataJson: true, clockType: true } });
      assert.equal(clockRow?.staffProfileId, profileId);
      assert.equal(clockRow?.clockType, "in");
      assert.deepEqual(clockRow?.metadataJson, { action: "in" }, "metadataJson sin staffName");
      const clockOut = await call(app, "POST", "/workforce/time-clock/clock-out", receptionist, A.propertyA, { propertyId: A.propertyA, staffProfileId: profileId, at: "2026-10-05T17:02:00.000Z" });
      created(clockOut, "POST clock-out (ficha)");
      assert.equal(payloadOf(clockOut).action, "out");
    }));

  it("el motor de reglas avisa (sin bloquear) de un descanso < 12 h y de una jornada > 9 h", async () =>
    strict(async () => {
      // 2026-10-05 09:00-17:00 ya existe (test anterior); 2026-10-06 03:00-11:00 deja 10 h de descanso.
      const tight = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, requester, A.propertyA, { staffProfileId: profileId, startAt: "2026-10-06T03:00:00.000Z", endAt: "2026-10-06T11:00:00.000Z" });
      created(tight, "POST shifts (descanso corto)");
      const warnings = tight.body.warnings as Array<{ rule: string; code: string; value: number; limit: number; shiftIds: string[] }>;
      assert.ok(Array.isArray(warnings) && warnings.length >= 1, `sin warnings: ${JSON.stringify(tight.body)}`);
      const rest = warnings.find((warning) => warning.rule === "rest_between_shifts");
      assert.ok(rest, `sin aviso rest_between_shifts: ${JSON.stringify(warnings)}`);
      assert.equal(rest.code, "HR_RULE_VIOLATION");
      assert.equal(rest.value, 10);
      assert.equal(rest.limit, 12);
      assert.ok(rest.shiftIds.includes(tight.body.id as string));
      assert.equal((await prisma.shift.findUnique({ where: { id: tight.body.id as string }, select: { status: true } }))?.status, "scheduled", "el aviso no bloquea el alta");

      const long = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, requester, A.propertyA, { staffProfileId: profileId, startAt: "2026-10-20T08:00:00.000Z", endAt: "2026-10-20T18:00:00.000Z" });
      created(long, "POST shifts (10 h)");
      const daily = (long.body.warnings as Array<{ rule: string; value: number; limit: number; period: string }>).find((warning) => warning.rule === "max_daily_hours");
      assert.ok(daily, `sin aviso max_daily_hours: ${JSON.stringify(long.body.warnings)}`);
      assert.equal(daily.value, 10);
      assert.equal(daily.limit, 9, "sin convenio asignado, tope del ET");
      assert.equal(daily.period, "2026-10-20");
    }));

  it("ausencia: requestedBy = actor y motivo; el solicitante no aprueba ni rechaza (409 APPROVAL_SELF_DECISION); otro usuario aprueba (decidedAt)", async () =>
    strict(async () => {
      const absence = await call(app, "POST", "/workforce/absences", requester, A.propertyA, { staffName: "EMP-042", absenceType: "permit_paid", startDate: "2026-11-02", endDate: "2026-11-03", reason: "Mudanza" });
      const absenceId = created(absence, "POST absences");
      assert.equal(absence.body.status, "pending");
      assert.equal(payloadOf(absence).staffProfileId, profileId);
      assert.equal(payloadOf(absence).requestedBy, requesterId);
      assert.equal(payloadOf(absence).reason, "Mudanza");
      assert.equal(payloadOf(absence).absenceType, "permit_paid");
      assert.equal("decidedAt" in payloadOf(absence), false, "sin decisión no hay decidedAt en el payload (boardItem omite nulos)");
      assert.equal("approvedBy" in payloadOf(absence), false);
      const stored = await prisma.absenceRequest.findUnique({ where: { id: absenceId }, select: { requestedBy: true, approvedBy: true, decidedAt: true, reason: true, staffProfileId: true } });
      assert.deepEqual(stored, { requestedBy: requesterId, approvedBy: null, decidedAt: null, reason: "Mudanza", staffProfileId: profileId }, "SELECT: requested_by es el actor");

      const selfApprove = await call(app, "PATCH", `/workforce/absences/${absenceId}`, requester, A.propertyA, {});
      assert.equal(selfApprove.status, 409, JSON.stringify(selfApprove.body));
      assert.equal(detailsCode(selfApprove), "APPROVAL_SELF_DECISION");
      const selfReject = await call(app, "PATCH", `/workforce/absences/${absenceId}`, requester, A.propertyA, { status: "rejected" });
      assert.equal(selfReject.status, 409);
      assert.equal(detailsCode(selfReject), "APPROVAL_SELF_DECISION");
      const untouched = await prisma.absenceRequest.findUnique({ where: { id: absenceId }, select: { status: true, approvedBy: true, decidedAt: true } });
      assert.deepEqual(untouched, { status: "pending", approvedBy: null, decidedAt: null }, "la fila no cambia tras el 409");

      const approved = await call(app, "PATCH", `/workforce/absences/${absenceId}`, decider, A.propertyA, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.status, "approved");
      assert.equal(payloadOf(approved).approvedBy, deciderId);
      assert.equal(payloadOf(approved).requestedBy, requesterId);
      assert.equal(typeof payloadOf(approved).decidedAt, "string");
      const decided = await prisma.absenceRequest.findUnique({ where: { id: absenceId }, select: { status: true, approvedBy: true, requestedBy: true, decidedAt: true } });
      assert.equal(decided?.status, "approved");
      assert.equal(decided?.approvedBy, deciderId);
      assert.equal(decided?.requestedBy, requesterId);
      assert.ok(decided?.decidedAt instanceof Date && decided.decidedAt.getTime() > 0);
      assert.equal((await call(app, "PATCH", `/workforce/absences/${absenceId}`, decider, A.propertyA, {})).status, 409, "no se aprueba dos veces");

      // Tipo no tasado → 400 (esquema estricto); el solicitante sí puede cancelar la suya (decidedAt sin approvedBy).
      assert.equal((await call(app, "POST", "/workforce/absences", requester, A.propertyA, { staffProfileId: profileId, absenceType: "sick", startDate: "2026-11-09", endDate: "2026-11-10" })).status, 400);
      const own = await call(app, "POST", "/workforce/absences", requester, A.propertyA, { staffProfileId: profileId, absenceType: "vacation", startDate: "2026-12-01", endDate: "2026-12-05" });
      const ownId = created(own, "POST absences (para cancelar)");
      const cancelled = await call(app, "PATCH", `/workforce/absences/${ownId}`, requester, A.propertyA, { status: "cancelled" });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.status, "cancelled");
      const cancelledRow = await prisma.absenceRequest.findUnique({ where: { id: ownId }, select: { approvedBy: true, decidedAt: true } });
      assert.equal(cancelledRow?.approvedBy, null);
      assert.ok(cancelledRow?.decidedAt instanceof Date);
    }));

  it("la lista workforce_labor:absence_requests filtra por estado (400 si no es un estado de la máquina)", async () =>
    strict(async () => {
      const pendingId = created(await call(app, "POST", "/workforce/absences", decider, A.propertyA, { staffProfileId: profileId, absenceType: "compensatory_rest", startDate: "2026-12-10", endDate: "2026-12-10" }), "POST absences (pending)");
      const expected = {
        all: await prisma.absenceRequest.count({ where: { propertyId: A.propertyA } }),
        pending: await prisma.absenceRequest.count({ where: { propertyId: A.propertyA, status: "pending" } }),
        approved: await prisma.absenceRequest.count({ where: { propertyId: A.propertyA, status: "approved" } })
      };
      assert.deepEqual(expected, { all: 3, pending: 1, approved: 1 }, "aprobada + cancelada + pendiente (SELECT)");
      const all = await listAdvancedRecords(A.propertyA, "workforce_labor", "absence_requests");
      assert.equal(all.total, expected.all);
      assert.equal(all.nextCursor, null);
      const pending = await listAdvancedRecords(A.propertyA, "workforce_labor", "absence_requests", { status: "pending" });
      assert.equal(pending.total, expected.pending);
      assert.deepEqual(pending.items.map((item) => (item as Json).id), [pendingId]);
      assert.equal(((pending.items[0] as Json).payload as Json).requestedBy, deciderId);
      const approved = await listAdvancedRecords(A.propertyA, "workforce_labor", "absence_requests", { status: "approved" });
      assert.equal(approved.total, expected.approved);
      assert.equal(((approved.items[0] as Json).payload as Json).approvedBy, deciderId);
      assert.equal(typeof ((approved.items[0] as Json).payload as Json).decidedAt, "string");
      const paged = await listAdvancedRecords(A.propertyA, "workforce_labor", "absence_requests", { limit: 1 });
      assert.equal(paged.items.length, 1);
      assert.equal(typeof paged.nextCursor, "string");
      await assert.rejects(listAdvancedRecords(A.propertyA, "workforce_labor", "absence_requests", { status: "bogus" }), (error: { statusCode?: number; message: string }) => error.statusCode === 400 && /El estado debe ser uno de/.test(error.message));
      assert.equal((await listAdvancedRecords(A.propertyB, "workforce_labor", "absence_requests")).total, 0, "otra propiedad no ve nada");
    }));

  it("RF-01 · fichaje solo propio con workforce.timeclock.use: otra ficha (id o alias) → 403 HR_TIMECLOCK_SELF_ONLY sin escribir; `at` se ignora (hora del servidor); timeclock.manage ficha por terceros y fija `at`", async () =>
    strict(async () => {
      const clocksBefore = await prisma.timeClockEntry.count({ where: { propertyId: A.propertyA } });
      const byId = await call(app, "POST", "/workforce/time-clock/clock-in", housekeeper, A.propertyA, { propertyId: A.propertyA, staffProfileId: profileId, action: "in" });
      assert.equal(byId.status, 403, JSON.stringify(byId.body));
      assert.equal(detailsCode(byId), "HR_TIMECLOCK_SELF_ONLY");
      const byAlias = await call(app, "POST", "/workforce/time-clock/clock-out", receptionist, A.propertyA, { propertyId: A.propertyA, staffName: deciderFullName, at: "2026-09-20T05:00:00.000Z" });
      assert.equal(byAlias.status, 403, JSON.stringify(byAlias.body));
      assert.equal(detailsCode(byAlias), "HR_TIMECLOCK_SELF_ONLY");
      assert.equal(await prisma.timeClockEntry.count({ where: { propertyId: A.propertyA } }), clocksBefore, "nada se persiste tras el 403");
      // Un alias que no resuelve sigue siendo 400 HR_EMPLOYEE_REQUIRED (antes que la comprobación de propiedad).
      assert.equal(detailsCode(await call(app, "POST", "/workforce/time-clock/clock-in", housekeeper, A.propertyA, { propertyId: A.propertyA, staffName: "nadie-999" })), "HR_EMPLOYEE_REQUIRED");

      // Sin ficha en el cuerpo: la del actor; `at` retroactivo se ignora → clockAt ≈ ahora.
      const before = Date.now();
      const own = await call(app, "POST", "/workforce/time-clock/clock-in", housekeeper, A.propertyA, { propertyId: A.propertyA, action: "in", at: "2026-01-01T05:00:00.000Z" });
      const ownId = created(own, "POST clock-in (propia, sin ficha en el cuerpo)");
      assert.equal(payloadOf(own).staffProfileId, housekeeperProfileId);
      const ownRow = await prisma.timeClockEntry.findUnique({ where: { id: ownId }, select: { staffProfileId: true, clockAt: true } });
      assert.equal(ownRow?.staffProfileId, housekeeperProfileId);
      assert.ok(ownRow!.clockAt.getTime() >= before - 1000 && ownRow!.clockAt.getTime() <= Date.now() + 1000, `clockAt ${ownRow!.clockAt.toISOString()} no es la hora del servidor`);

      // El manager (workforce.timeclock.manage) sí ficha por la recepcionista y con `at` (corrección manual).
      const byManager = await call(app, "POST", "/workforce/time-clock/clock-out", decider, A.propertyA, { propertyId: A.propertyA, staffProfileId: profileId, at: "2026-10-05T17:30:00.000Z" });
      const managerId = created(byManager, "POST clock-out (manager por tercero)");
      const managerRow = await prisma.timeClockEntry.findUnique({ where: { id: managerId }, select: { staffProfileId: true, clockAt: true, clockType: true } });
      assert.equal(managerRow?.staffProfileId, profileId);
      assert.equal(managerRow?.clockType, "out");
      assert.equal(managerRow?.clockAt.toISOString(), "2026-10-05T17:30:00.000Z");
    }));

  it("RF-03 · el empleado solo ve lo suyo: GET /hr/absences y GET …/time-clock con workforce.read se ciñen a sus fichas; POST /workforce/me/absences solicita la ausencia propia (201) y rechaza nombrar a otra persona (400)", async () =>
    strict(async () => {
      // Una ausencia de la camarera (para que vea algo suyo) y otra de OTRA persona (la recepcionista) que no debe ver.
      const hers = created(await call(app, "POST", "/workforce/absences", requester, A.propertyA, { staffProfileId: housekeeperProfileId, absenceType: "permit_paid", startDate: "2026-12-16", endDate: "2026-12-16", reason: "Consulta médica de un familiar" }), "POST absences (camarera)");
      const foreign = created(await call(app, "POST", "/workforce/absences", requester, A.propertyA, { staffProfileId: profileId, absenceType: "permit_unpaid", startDate: "2026-12-14", endDate: "2026-12-15", reason: "Asunto propio de recepción" }), "POST absences (otra persona)");
      const ownList = await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}`, housekeeper, A.propertyA);
      assert.equal(ownList.status, 200, JSON.stringify(ownList.body));
      const ownItems = ownList.body.items as Json[];
      assert.ok(ownItems.some((item) => item.id === hers), "la camarera ve su propia ausencia");
      assert.ok(ownItems.every((item) => (item.payload as Json).staffProfileId === housekeeperProfileId), "solo sus fichas");
      assert.equal(ownItems.some((item) => item.id === foreign), false, "la ausencia de la recepcionista no aparece");
      assert.equal(ownList.body.total, ownItems.length);
      assert.doesNotMatch(JSON.stringify(ownList.body), /Asunto propio de recepción/);
      const managerList = await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}`, decider, A.propertyA);
      assert.ok((managerList.body.items as Json[]).some((item) => item.id === foreign), "workforce.schedule.manage ve todo el centro");
      const ownClocks = await call(app, "GET", `/workforce/properties/${A.propertyA}/time-clock`, housekeeper, A.propertyA);
      assert.equal(ownClocks.status, 200, JSON.stringify(ownClocks.body));
      assert.ok((ownClocks.body.items as Json[]).length >= 1, "su fichaje del test anterior");
      assert.ok((ownClocks.body.items as Json[]).every((item) => (item.payload as Json).staffProfileId === housekeeperProfileId), "solo sus fichajes");
      // La recepcionista (solo timeclock.use, sin workforce.read) no lista ausencias ni fichajes: 403 como antes.
      assert.equal((await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}`, receptionist, A.propertyA)).status, 403);

      // Solicitud propia: la ficha es la del actor; el cuerpo no puede nombrar a nadie.
      const named = await call(app, "POST", "/workforce/me/absences", housekeeper, A.propertyA, { staffProfileId: deciderProfileId, absenceType: "vacation", startDate: "2027-01-10", endDate: "2027-01-12" });
      assert.equal(named.status, 400, JSON.stringify(named.body));
      const mine = await call(app, "POST", "/workforce/me/absences", housekeeper, A.propertyA, { absenceType: "vacation", startDate: "2027-01-10", endDate: "2027-01-12", reason: "Vacaciones de invierno" });
      assert.equal(mine.status, 201, JSON.stringify(mine.body));
      assert.equal(payloadOf(mine).staffProfileId, housekeeperProfileId);
      assert.equal(payloadOf(mine).requestedBy, housekeeperId);
      assert.equal(mine.body.status, "pending");
      // La recepcionista (timeclock.use) también solicita la suya.
      const rec = await call(app, "POST", "/workforce/me/absences", receptionist, A.propertyA, { absenceType: "compensatory_rest", startDate: "2027-01-20", endDate: "2027-01-20" });
      assert.equal(rec.status, 201, JSON.stringify(rec.body));
      assert.equal(payloadOf(rec).staffProfileId, profileId);
      // Sin ficha en el centro (el manager 1 tiene timeclock.use pero ninguna StaffProfile) → 400 HR_EMPLOYEE_REQUIRED; la decisión sigue siendo de otra persona.
      const noProfile = await call(app, "POST", "/workforce/me/absences", requester, A.propertyA, { absenceType: "vacation", startDate: "2027-02-01", endDate: "2027-02-02" });
      assert.equal(noProfile.status, 400, JSON.stringify(noProfile.body));
      assert.equal(detailsCode(noProfile), "HR_EMPLOYEE_REQUIRED");
      assert.equal((await call(app, "PATCH", `/workforce/absences/${mine.body.id as string}`, decider, A.propertyA, {})).status, 200, "otra persona decide la solicitud propia");
    }));
});
