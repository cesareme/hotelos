/**
 * Tanda L2 · L2-03 — motor genérico Prisma-only (app.inject, Postgres real).
 *
 * Dos organizaciones aisladas (helpers/l2-tenant.mts): A ejercita cada familia
 * (POST → GET lista en `items` → PATCH transición → Prisma lo confirma → un
 * `buildApiServer()` nuevo lo sigue leyendo; OJO: la «instancia nueva» vive en
 * el mismo proceso y comparte el demoStore hidratado, así que prueba que la
 * lectura sale de Prisma, no un reinicio real — ese lo hace el integrador con
 * la instancia :3901) y B comprueba que no ve nada
 * (lista vacía, transición 404). RBAC_STRICT=true, auth real, sin unión de
 * permisos de demo. Usuarios adicionales por plantilla (manager,
 * maintenance_manager) porque las cinco cuentas del helper no tienen las
 * claves de escritura del motor. Tanda RRHH (RRHH-4): la persona de un turno,
 * fichaje o ausencia es una FICHA (StaffProfile) del tenant aislado —
 * `staffProfileId` o alias por código de empleado —, nunca un nombre libre
 * (400 HR_EMPLOYEE_REQUIRED); la ausencia la aprueba otro usuario que quien la
 * solicitó (409 APPROVAL_SELF_DECISION). Al terminar borra las dos organizaciones.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-motor-generico.test.mts
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
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json };

const MODULES = [
  "workforce_labor",
  "safety_incident_management",
  "reputation_quality",
  "guest_data_crm_loyalty",
  "groups_events_sales",
  "procurement_inventory",
  "energy_sustainability",
  "hotel_intelligence_platform"
] as const;

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

const items = (reply: Reply): Json[] => (Array.isArray(reply.body.items) ? (reply.body.items as Json[]) : []);
const ids = (reply: Reply): string[] => items(reply).map((item) => String(item.id));
const created = (reply: Reply, label: string): string => {
  assert.ok([200, 201].includes(reply.status), `${label}: ${reply.status} ${JSON.stringify(reply.body).slice(0, 300)}`);
  assert.equal(typeof reply.body.id, "string", `${label}: sin id en la respuesta`);
  return reply.body.id as string;
};
const detailsCode = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;

/** Usuario extra con una o varias plantillas en las propiedades dadas (barrido por cleanupTenant: cuelga de la organización). */
async function addUser(tenant: IsolatedTenant, key: string, templateKeys: string[], propertyIds: string[]): Promise<{ id: string; email: string }> {
  const id = `usr_l2m_${key}_${tenant.run}`;
  const email = `${key}.l2m.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L2M ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  for (const templateKey of templateKeys) {
    const roleId = tenant.roles[templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
    for (const propertyId of propertyIds) {
      await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId, organizationId: tenant.organizationId, reason: `l2-motor ${key}` } });
    }
  }
  resetRbacScopeCacheForTests();
  return { id, email };
}

describe("L2-03 · motor genérico Prisma-only por tabla propia", () => {
  let app: ApiApp;
  let A: IsolatedTenant;
  let B: IsolatedTenant;
  let manager: Session; // plantilla manager (T3): escrituras del motor + purchase_orders.approve
  let requester: Session; // maintenance_manager (T2): purchase_orders.create/receive, incidentes, energía
  let dual: Session; // manager + maintenance_manager: crea y aprueba → SoD
  let receptionist: Session; // solo workforce.timeclock.use + lecturas
  let accountant: Session; // organización: purchase_orders.receive
  let managerB: Session; // organización B
  let twoHotels: Session; // manager en A.propertyA y A.propertyB (SEC-L2-03: la propiedad de la entidad gana a la cabecera)
  let managerId = "";
  let twoHotelsId = "";
  let requesterId = "";
  /** Ficha de la recepcionista de A en A.propertyA (código REC-001); cuelga de la propiedad → cleanupTenant la barre. */
  let receptionistProfileId = "";
  let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
  const created_: Record<string, string> = {};

  before(async () => {
    invariantsBefore = await farandaInvariants();
    app = await buildApiServer();
    A = await createIsolatedTenant(`m${newRunId()}`);
    B = await createIsolatedTenant(`n${newRunId()}`);
    await enableModules(A.propertyA, MODULES);
    await enableModules(A.propertyB, MODULES);
    await enableModules(B.propertyA, MODULES);
    const managerUser = await addUser(A, "manager", ["manager"], [A.propertyA]);
    const twoHotelsUser = await addUser(A, "twohotels", ["manager"], [A.propertyA, A.propertyB]);
    const requesterUser = await addUser(A, "requester", ["maintenance_manager"], [A.propertyA]);
    const dualUser = await addUser(A, "dual", ["manager", "maintenance_manager"], [A.propertyA]);
    const managerBUser = await addUser(B, "manager", ["manager"], [B.propertyA]);
    managerId = managerUser.id;
    twoHotelsId = twoHotelsUser.id;
    requesterId = requesterUser.id;
    receptionistProfileId = `sp_l2m_rec_${A.run}`;
    await prisma.staffProfile.create({ data: { id: receptionistProfileId, userId: A.users.receptionist.id, propertyId: A.propertyA, employeeCode: "REC-001", active: true } });
    await strict(async () => {
      manager = await loginOrThrow(app, managerUser.email, A.password);
      requester = await loginOrThrow(app, requesterUser.email, A.password);
      dual = await loginOrThrow(app, dualUser.email, A.password);
      receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
      accountant = await loginOrThrow(app, A.users.accountant.email, A.password);
      managerB = await loginOrThrow(app, managerBUser.email, B.password);
      twoHotels = await loginOrThrow(app, twoHotelsUser.email, A.password);
    });
  });

  after(async () => {
    try {
      if (A) await cleanupTenant(A.organizationId);
      if (B) await cleanupTenant(B.organizationId);
    } finally {
      await app?.close();
    }
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
    // Solo las DOS organizaciones de esta suite: otras suites L2 corren en paralelo con el mismo prefijo.
    assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
  });

  it("workforce: turno por alias de ficha → lista en items → transición con máquina de estados → Prisma; fichaje de recepción; ausencia aprobada por otro usuario", async () =>
    strict(async () => {
      const startAt = "2026-10-01T09:00:00.000Z";
      // Alias por código de empleado (insensible a mayúsculas) → id real de la ficha; el nombre visible sale del usuario.
      const shift = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, manager, A.propertyA, { staffName: "rec-001", role: "recepción", startAt, endAt: "2026-10-01T17:00:00.000Z" });
      const shiftId = created(shift, "POST shifts");
      created_.shift = shiftId;
      assert.equal((shift.body.payload as Json).staffProfileId, receptionistProfileId, "el alias se resuelve al id real de la ficha");
      assert.equal((shift.body.payload as Json).staffName, A.users.receptionist.fullName);
      assert.ok(Array.isArray(shift.body.warnings), "el turno devuelve warnings del motor de reglas (vacío si cumple)");
      assert.equal((await prisma.shift.findUnique({ where: { id: shiftId }, select: { staffProfileId: true } }))?.staffProfileId, receptionistProfileId);
      const extra = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, manager, A.propertyA, { staffProfileId: receptionistProfileId, startAt, endAt: "2026-10-01T17:00:00.000Z", foo: 1 });
      assert.equal(extra.status, 400, "campo no admitido → 400");
      assert.match(String(extra.body.message), /campos no admitidos/);
      const unknownAlias = await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, manager, A.propertyA, { staffName: "sin-ficha-000", startAt, endAt: "2026-10-01T17:00:00.000Z" });
      assert.equal(unknownAlias.status, 400, `alias sin ficha → 400: ${JSON.stringify(unknownAlias.body)}`);
      assert.equal(detailsCode(unknownAlias), "HR_EMPLOYEE_REQUIRED");
      assert.equal(await prisma.shift.count({ where: { propertyId: A.propertyA, staffProfileId: "sin-ficha-000" } }), 0, "el texto nunca se guarda como id");

      const list = await call(app, "GET", `/workforce/properties/${A.propertyA}/schedule`, manager, A.propertyA);
      assert.equal(list.status, 200);
      assert.ok(ids(list).includes(shiftId), "el turno aparece en items");
      assert.equal(list.body.recordType, "schedule");
      assert.equal(typeof list.body.total, "number");
      assert.equal(list.body.nextCursor, null);
      assert.equal("nextAction" in list.body, false, "el envelope pierde nextAction");

      const confirmed = await call(app, "PATCH", `/workforce/shifts/${shiftId}`, manager, A.propertyA, { status: "confirmed" });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.equal(confirmed.body.status, "confirmed");
      const row = await prisma.shift.findUnique({ where: { id: shiftId }, select: { status: true, propertyId: true } });
      assert.equal(row?.status, "confirmed");
      assert.equal(row?.propertyId, A.propertyA);
      const backwards = await call(app, "PATCH", `/workforce/shifts/${shiftId}`, manager, A.propertyA, { status: "scheduled" });
      assert.equal(backwards.status, 409, "confirmed → scheduled no está en la máquina");
      assert.equal(detailsCode(backwards), "INVALID_TRANSITION");

      const clockIn = await call(app, "POST", "/workforce/time-clock/clock-in", receptionist, A.propertyA, { propertyId: A.propertyA, staffProfileId: receptionistProfileId, action: "in", at: new Date().toISOString() });
      const clockInId = created(clockIn, "POST clock-in");
      assert.equal((clockIn.body.payload as Json).staffProfileId, receptionistProfileId);
      const clockRow = await prisma.timeClockEntry.findUnique({ where: { id: clockInId }, select: { staffProfileId: true, metadataJson: true } });
      assert.equal(clockRow?.staffProfileId, receptionistProfileId);
      assert.equal("staffName" in ((clockRow?.metadataJson ?? {}) as Json), false, "metadataJson sin nombre (solo action)");
      const clocks = await call(app, "GET", `/workforce/properties/${A.propertyA}/time-clock`, manager, A.propertyA);
      assert.equal(clocks.status, 200);
      assert.equal((items(clocks)[0]?.payload as Json | undefined)?.action, "in");
      assert.equal((items(clocks)[0]?.payload as Json | undefined)?.staffName, A.users.receptionist.fullName, "el nombre visible sale de la ficha");
      // Un propertyId ajeno en el cuerpo lo corta el preHandler de ámbito de
      // server.ts (404 opaco, fuera del ámbito del usuario); si la ruta dejara
      // de leerlo del cuerpo, el esquema del motor lo rechaza con 400.
      const mismatch = await call(app, "POST", "/workforce/time-clock/clock-in", receptionist, A.propertyA, { propertyId: B.propertyA, staffName: "X", action: "in" });
      assert.ok([400, 404].includes(mismatch.status), `propertyId ajeno en el cuerpo: ${mismatch.status}`);
      assert.equal(await prisma.timeClockEntry.count({ where: { propertyId: B.propertyA } }), 0, "nada se fichó en la propiedad ajena");

      const absence = await call(app, "POST", "/workforce/absences", manager, A.propertyA, { staffProfileId: receptionistProfileId, absenceType: "vacation", startDate: "2026-11-02", endDate: "2026-11-06", reason: "Vacaciones de noviembre" });
      const absenceId = created(absence, "POST absences");
      assert.equal(absence.body.status, "pending");
      assert.equal((absence.body.payload as Json).requestedBy, managerId, "requestedBy = actor de la petición");
      assert.equal((absence.body.payload as Json).reason, "Vacaciones de noviembre");
      // SoD: quien solicita no aprueba (409 APPROVAL_SELF_DECISION); otro usuario con la clave sí (decidedAt).
      const selfDecision = await call(app, "PATCH", `/workforce/absences/${absenceId}`, manager, A.propertyA, {});
      assert.equal(selfDecision.status, 409, JSON.stringify(selfDecision.body));
      assert.equal(detailsCode(selfDecision), "APPROVAL_SELF_DECISION");
      const approved = await call(app, "PATCH", `/workforce/absences/${absenceId}`, twoHotels, A.propertyA, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.status, "approved");
      assert.equal((approved.body.payload as Json).approvedBy, twoHotelsId);
      assert.equal(typeof (approved.body.payload as Json).decidedAt, "string");
      const absenceRow = await prisma.absenceRequest.findUnique({ where: { id: absenceId }, select: { approvedBy: true, requestedBy: true, decidedAt: true } });
      assert.equal(absenceRow?.approvedBy, twoHotelsId);
      assert.equal(absenceRow?.requestedBy, managerId);
      assert.ok(absenceRow?.decidedAt instanceof Date);
      assert.equal((await call(app, "PATCH", `/workforce/absences/${absenceId}`, twoHotels, A.propertyA, {})).status, 409);
      assert.equal((await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, receptionist, A.propertyA, { staffProfileId: receptionistProfileId, startAt, endAt: "2026-10-01T17:00:00.000Z" })).status, 403, "sin workforce.schedule.manage → 403");
    }));

  it("paginación keyset: limit=1 devuelve nextCursor que encadena y termina en null", async () =>
    strict(async () => {
      created(await call(app, "POST", `/workforce/properties/${A.propertyA}/shifts`, manager, A.propertyA, { staffProfileId: receptionistProfileId, startAt: "2026-10-02T09:00:00.000Z", endAt: "2026-10-02T17:00:00.000Z" }), "POST shifts #2");
      const first = await listAdvancedRecords(A.propertyA, "workforce_labor", "schedule", { limit: 1 });
      assert.equal(first.items.length, 1);
      assert.equal(first.total, 2);
      assert.equal(typeof first.nextCursor, "string");
      const second = await listAdvancedRecords(A.propertyA, "workforce_labor", "schedule", { limit: 1, cursor: first.nextCursor });
      assert.equal(second.items.length, 1);
      assert.notEqual((second.items[0] as Json).id, (first.items[0] as Json).id);
      assert.equal(second.nextCursor, null);
      await assert.rejects(listAdvancedRecords(A.propertyA, "workforce_labor", "schedule", { limit: 1, cursor: "no-es-un-cursor" }), (error: { statusCode?: number }) => error.statusCode === 400);
      await assert.rejects(listAdvancedRecords(A.propertyA, "workforce_labor", "labor_forecast"), (error: { statusCode?: number; message: string }) => error.statusCode === 400 && /Tipo de registro no soportado/.test(error.message));
      const all = await listAdvancedRecords(A.propertyA, "workforce_labor", "schedule");
      assert.equal(all.items.length, 2, "sin page → primera página con el límite por defecto");
    }));

  it("seguridad: incidente + evidencia → lista → «Marcar gestionado» → Prisma; recepción sin clave 403; padre ajeno 404", async () =>
    strict(async () => {
      const incident = await call(app, "POST", `/safety/properties/${A.propertyA}/incidents`, manager, A.propertyA, { title: "Suelo mojado", severity: "high", location: "Pasillo 2", description: "Resbalón", occurredAt: new Date().toISOString() });
      const incidentId = created(incident, "POST incidents");
      created_.incident = incidentId;
      assert.equal(incident.body.status, "open");
      assert.equal((incident.body.payload as Json).location, "Pasillo 2");
      const evidence = await call(app, "POST", `/safety/incidents/${incidentId}/evidence`, manager, A.propertyA, { incidentId, evidenceType: "note", notes: "Foto pendiente" });
      created(evidence, "POST evidence");
      assert.equal(await prisma.incidentEvidence.count({ where: { incidentId } }), 1);

      const list = await call(app, "GET", `/safety/properties/${A.propertyA}/incidents`, manager, A.propertyA);
      assert.equal(list.status, 200);
      const live = items(list).find((item) => item.id === incidentId);
      assert.ok(live, "el incidente aparece en items");
      assert.equal((live.payload as Json).title, "Suelo mojado");

      const handled = await call(app, "PATCH", `/safety/incidents/${incidentId}`, manager, A.propertyA, { status: "resolved", handledAt: new Date().toISOString() });
      assert.equal(handled.status, 200, JSON.stringify(handled.body));
      assert.equal(handled.body.status, "resolved");
      const row = await prisma.safetyIncident.findUnique({ where: { id: incidentId }, select: { status: true, resolvedAt: true } });
      assert.equal(row?.status, "resolved");
      assert.ok(row?.resolvedAt instanceof Date);
      assert.equal((await call(app, "PATCH", `/safety/incidents/${incidentId}`, manager, A.propertyA, { status: "in_progress" })).status, 409);
      assert.equal((await call(app, "POST", `/safety/properties/${A.propertyA}/incidents`, receptionist, A.propertyA, { title: "X" })).status, 403);

      const check = await call(app, "POST", `/safety/properties/${A.propertyA}/checks`, manager, A.propertyA, { name: "Extintores planta 1", frequency: "monthly" });
      const checkId = created(check, "POST checks");
      created(await call(app, "POST", `/safety/checks/${checkId}/results`, manager, A.propertyA, { safetyCheckId: checkId, status: "passed" }), "POST check results");
      assert.ok(ids(await call(app, "GET", `/safety/properties/${A.propertyA}/checks`, manager, A.propertyA)).includes(checkId));

      // Padre ajeno (SEC-L2-04, corrector): el padre de la fila hija es SIEMPRE el id del path
      // (el que pasó el guard de tenencia). En el path → 404 opaco y nada escrito; en el
      // cuerpo se ignora (la evidencia cuelga del incidente del path); sin él en el cuerpo → 200.
      const foreign = await prisma.safetyIncident.create({ data: { propertyId: B.propertyA, incidentType: "other", severity: "low", title: "Ajeno" }, select: { id: true } });
      const attach = await call(app, "POST", `/safety/incidents/${foreign.id}/evidence`, manager, A.propertyA, { notes: "x" });
      assert.equal(attach.status, 404, JSON.stringify(attach.body));
      assert.equal(await prisma.incidentEvidence.count({ where: { incidentId: foreign.id } }), 0);
      const smuggled = await call(app, "POST", `/safety/incidents/${incidentId}/evidence`, manager, A.propertyA, { incidentId: foreign.id, notes: "cuerpo ignorado" });
      assert.equal(smuggled.status, 200, JSON.stringify(smuggled.body));
      assert.equal((smuggled.body.payload as Json).incidentId, incidentId, "el padre es el del path, no el del cuerpo");
      assert.equal(await prisma.incidentEvidence.count({ where: { incidentId: foreign.id } }), 0);
      const bare = await call(app, "POST", `/safety/checks/${checkId}/results`, manager, A.propertyA, { status: "failed", notes: "sin safetyCheckId en el cuerpo" });
      assert.equal(bare.status, 200, JSON.stringify(bare.body));
      assert.equal((bare.body.payload as Json).safetyCheckId, checkId);

      // SEC-L2-03 (corrector): la propiedad de la ENTIDAD gana a la cabecera x-property-id.
      // Un manager de A.propertyA y A.propertyB edita un incidente del hotel B con la cabecera
      // del hotel A → 200 (antes 404 «Registro no encontrado.»), y la fila sigue en B.
      const incidentB = await call(app, "POST", `/safety/properties/${A.propertyB}/incidents`, twoHotels, A.propertyB, { title: "Fuga en la 201", severity: "medium" });
      const incidentBId = created(incidentB, "POST incidents (hotel B)");
      const crossHeader = await call(app, "PATCH", `/safety/incidents/${incidentBId}`, twoHotels, A.propertyA, { status: "in_progress" });
      assert.equal(crossHeader.status, 200, JSON.stringify(crossHeader.body));
      assert.equal((await prisma.safetyIncident.findUnique({ where: { id: incidentBId }, select: { propertyId: true, status: true } }))?.propertyId, A.propertyB);
      const evidenceB = await call(app, "POST", `/safety/incidents/${incidentBId}/evidence`, twoHotels, A.propertyA, { notes: "desde la cabecera de A" });
      assert.equal(evidenceB.status, 200, JSON.stringify(evidenceB.body));
      assert.equal((evidenceB.body as Json).propertyId, A.propertyB, "la fila hija se crea en la propiedad de la entidad");
      // El manager solo de A sigue sin ver el hotel B: 404 opaco.
      assert.equal((await call(app, "PATCH", `/safety/incidents/${incidentBId}`, manager, A.propertyA, { status: "resolved" })).status, 404);
    }));

  it("calidad y encuestas: caso → cierre; encuesta → respuesta", async () =>
    strict(async () => {
      const qcase = await call(app, "POST", `/quality/properties/${A.propertyA}/cases`, manager, A.propertyA, { title: "Ruido en la 102", priority: "high" });
      const caseId = created(qcase, "POST cases");
      assert.ok(ids(await call(app, "GET", `/quality/properties/${A.propertyA}/cases`, manager, A.propertyA)).includes(caseId));
      const closed = await call(app, "PATCH", `/quality/cases/${caseId}`, manager, A.propertyA, { status: "closed", rootCause: "Obras" });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal((await prisma.qualityCase.findUnique({ where: { id: caseId }, select: { status: true, rootCause: true } }))?.rootCause, "Obras");
      assert.equal((await call(app, "PATCH", `/quality/cases/${caseId}`, manager, A.propertyA, { status: "in_progress" })).status, 409);

      const survey = await call(app, "POST", `/surveys/properties/${A.propertyA}`, manager, A.propertyA, { name: "Post estancia", surveyType: "post_stay", questions: [{ id: "q1", text: "¿Limpieza?" }] });
      const surveyId = created(survey, "POST surveys");
      // SEC-L2-04 (corrector): el surveyId lo aporta el path; el cuerpo no lo necesita.
      const response = await call(app, "POST", `/surveys/${surveyId}/responses`, manager, A.propertyA, { score: 9, answers: { q1: "muy bien" } });
      created(response, "POST survey responses");
      assert.equal((response.body.payload as Json).surveyId, surveyId);
      assert.equal(await prisma.surveyResponse.count({ where: { surveyId } }), 1);
      assert.ok(ids(await call(app, "GET", `/surveys/properties/${A.propertyA}`, manager, A.propertyA)).includes(surveyId));
    }));

  it("CRM (caso Carmen): segmento y campaña de la organización del usuario, nunca del contexto de demo; fidelización con membresías", async () =>
    strict(async () => {
      const segment = await call(app, "POST", "/crm/segments", manager, A.propertyA, { name: "Repetidores", rulesJson: { criteria: [{ field: "stays", op: ">=", value: 2 }] } });
      const segmentId = created(segment, "POST segments");
      created_.segment = segmentId;
      assert.equal(segment.body.organizationId, A.organizationId);
      const listA = await call(app, "GET", "/crm/segments", manager, A.propertyA);
      assert.equal(listA.status, 200);
      assert.ok(ids(listA).includes(segmentId), "GET /crm/segments lista el segmento de la organización A");
      const listB = await call(app, "GET", "/crm/segments", managerB, B.propertyA);
      assert.equal(listB.status, 200);
      assert.deepEqual(ids(listB), [], "la organización B no ve los segmentos de A");
      const updated = await call(app, "PATCH", `/crm/segments/${segmentId}`, manager, A.propertyA, { active: false, description: "Huéspedes con dos o más estancias" });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal((await prisma.crmSegment.findUnique({ where: { id: segmentId }, select: { active: true, organizationId: true } }))?.active, false);
      assert.equal((await call(app, "PATCH", `/crm/segments/${segmentId}`, managerB, B.propertyA, { active: true })).status, 404, "transición desde B → 404 opaco");

      const campaign = await call(app, "POST", "/crm/campaigns", manager, A.propertyA, { name: "Otoño", campaignType: "newsletter", channel: "email", segmentId });
      const campaignId = created(campaign, "POST campaigns");
      assert.equal(campaign.body.status, "draft");
      assert.equal((await call(app, "PATCH", `/crm/campaigns/${campaignId}`, manager, A.propertyA, { status: "scheduled" })).body.status, "scheduled");
      assert.equal((await call(app, "PATCH", `/crm/campaigns/${campaignId}`, manager, A.propertyA, { status: "sent" })).body.status, "sent");
      assert.equal((await call(app, "PATCH", `/crm/campaigns/${campaignId}`, manager, A.propertyA, { status: "draft" })).status, 409);
      assert.equal((await prisma.crmCampaign.findUnique({ where: { id: campaignId }, select: { status: true } }))?.status, "sent");
      const foreignSegment = await call(app, "POST", "/crm/campaigns", managerB, B.propertyA, { name: "Robo", campaignType: "x", channel: "email", segmentId });
      assert.equal(foreignSegment.status, 404, "segmento de otra organización en el cuerpo → 404");

      const program = await call(app, "POST", "/crm/loyalty/programs", manager, A.propertyA, { name: "Club Faranda", configurationJson: { tiers: ["oro"] } });
      const programId = created(program, "POST loyalty programs");
      const loyalty = await call(app, "GET", "/crm/loyalty", manager, A.propertyA);
      const stored = items(loyalty).find((item) => item.id === programId);
      assert.ok(stored, "el programa aparece en /crm/loyalty");
      assert.deepEqual(stored.memberships, []);
      assert.deepEqual(ids(await call(app, "GET", "/crm/loyalty", managerB, B.propertyA)), []);
    }));

  it("compras: pedido con líneas → aprobación con SoD y tramo → recepción; organización B 404", async () =>
    strict(async () => {
      const order = await call(app, "POST", `/procurement/properties/${A.propertyA}/purchase-orders`, requester, A.propertyA, { lines: [{ description: "Bombillas LED", quantity: 10, unitPrice: 12 }], promisedDate: "2026-10-15" });
      const orderId = created(order, "POST purchase-orders");
      assert.equal(order.body.status, "draft");
      assert.equal(order.body.total, 120);
      assert.equal(order.body.createdByUserId, requesterId);
      assert.equal((order.body.lines as Json[]).length, 1);
      assert.equal(await prisma.purchaseOrderLine.count({ where: { purchaseOrderId: orderId } }), 1);
      await flushAuditQueues();
      const list = await call(app, "GET", `/procurement/properties/${A.propertyA}/purchase-orders`, manager, A.propertyA);
      const listed = items(list).find((item) => item.id === orderId);
      assert.ok(listed, "el pedido aparece en items");
      assert.equal(listed.createdByUserId, requesterId, "autor resuelto desde la auditoría en la lista");

      assert.equal((await call(app, "POST", `/procurement/purchase-orders/${orderId}/approve`, requester, A.propertyA, {})).status, 403, "sin purchase_orders.approve → 403");
      const ownReceive = await call(app, "POST", `/procurement/purchase-orders/${orderId}/receive`, requester, A.propertyA, {});
      assert.equal(ownReceive.status, 409, `solicitante recibe su pedido: ${JSON.stringify(ownReceive.body)}`);
      assert.equal((ownReceive.body.details as Json).rule, "requester_ne_receiver");
      assert.equal((await call(app, "POST", `/procurement/purchase-orders/${orderId}/approve`, managerB, B.propertyA, {})).status, 404, "organización B → 404");

      const approved = await call(app, "POST", `/procurement/purchase-orders/${orderId}/approve`, manager, A.propertyA, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.status, "approved");
      assert.equal(approved.body.approvedBy, managerId);
      assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: orderId }, select: { status: true } }))?.status, "approved");
      const received = await call(app, "POST", `/procurement/purchase-orders/${orderId}/receive`, accountant, A.propertyA, { receivedDate: "2026-10-16" });
      assert.equal(received.status, 200, JSON.stringify(received.body));
      assert.equal(received.body.status, "received");
      assert.equal((await call(app, "POST", `/procurement/purchase-orders/${orderId}/approve`, manager, A.propertyA, {})).status, 409, "received → approved no está en la máquina");

      const own = await call(app, "POST", `/procurement/properties/${A.propertyA}/purchase-orders`, dual, A.propertyA, { total: 80 });
      const ownId = created(own, "POST purchase-orders (dual)");
      await flushAuditQueues();
      const selfApprove = await call(app, "POST", `/procurement/purchase-orders/${ownId}/approve`, dual, A.propertyA, {});
      assert.equal(selfApprove.status, 409, `mismo usuario crea y aprueba: ${JSON.stringify(selfApprove.body)}`);
      assert.equal((selfApprove.body.details as Json).rule, "creator_ne_approver");

      const big = await call(app, "POST", `/procurement/properties/${A.propertyA}/purchase-orders`, requester, A.propertyA, { total: 5000 });
      const bigId = created(big, "POST purchase-orders (5.000 €)");
      await flushAuditQueues();
      const overTier = await call(app, "POST", `/procurement/purchase-orders/${bigId}/approve`, manager, A.propertyA, {});
      assert.equal(overTier.status, 403, `tramo T4 > T3 del manager: ${JSON.stringify(overTier.body)}`);
      assert.equal(detailsCode(overTier), "RBAC_LEVEL_EXCEEDED");
      assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: bigId }, select: { status: true } }))?.status, "draft");
    }));

  it("energía: contador → lectura (padre en la propiedad) → lista; acción de sostenibilidad", async () =>
    strict(async () => {
      const meter = await call(app, "POST", `/energy/properties/${A.propertyA}/meters`, manager, A.propertyA, { meterType: "electricity", name: "General", unit: "kWh" });
      const meterId = created(meter, "POST meters");
      const reading = await call(app, "POST", `/energy/properties/${A.propertyA}/readings`, manager, A.propertyA, { meterId, readingDate: "2026-09-18", value: 1234.5 });
      created(reading, "POST readings");
      assert.equal(reading.body.value, 1234.5);
      assert.equal((await prisma.utilityReading.findFirst({ where: { meterId }, select: { propertyId: true } }))?.propertyId, A.propertyA);
      assert.ok(ids(await call(app, "GET", `/energy/properties/${A.propertyA}/meters`, manager, A.propertyA)).includes(meterId));
      const foreignMeter = await prisma.utilityMeter.create({ data: { propertyId: B.propertyA, meterType: "water", name: "Ajeno", unit: "m3" }, select: { id: true } });
      assert.equal((await call(app, "POST", `/energy/properties/${A.propertyA}/readings`, manager, A.propertyA, { meterId: foreignMeter.id, readingDate: "2026-09-18", value: 1 })).status, 404);
      const action = await call(app, "POST", `/sustainability/properties/${A.propertyA}/actions`, manager, A.propertyA, { title: "LED en pasillos", estimatedCost: 900, estimatedSavings: 300 });
      created(action, "POST sustainability actions");
      assert.equal(action.body.status, "planned");
      assert.equal((await prisma.sustainabilityAction.findUnique({ where: { id: action.body.id as string }, select: { propertyId: true } }))?.propertyId, A.propertyA);
    }));

  it("analítica: métrica (única por organización), anomalía con transición y organización B 404, informe programado", async () =>
    strict(async () => {
      const metric = await call(app, "POST", "/analytics/metrics", manager, A.propertyA, { metricCode: "revpar_l2", name: "RevPAR" });
      const metricId = created(metric, "POST metrics");
      assert.equal(metric.body.organizationId, A.organizationId);
      assert.equal((await call(app, "POST", "/analytics/metrics", manager, A.propertyA, { metricCode: "revpar_l2", name: "RevPAR bis" })).status, 409, "código repetido → 409");
      assert.ok(ids(await call(app, "GET", `/analytics/properties/${A.propertyA}/metrics`, manager, A.propertyA)).includes(metricId));
      assert.deepEqual(ids(await call(app, "GET", `/analytics/properties/${B.propertyA}/metrics`, managerB, B.propertyA)), []);

      const anomaly = await prisma.anomalyEvent.create({ data: { organizationId: A.organizationId, propertyId: A.propertyA, anomalyType: "occupancy", severity: "high", title: "Ocupación anómala" }, select: { id: true } });
      assert.ok(ids(await call(app, "GET", `/analytics/properties/${A.propertyA}/anomalies`, manager, A.propertyA)).includes(anomaly.id));
      const ack = await call(app, "PATCH", `/analytics/anomalies/${anomaly.id}`, manager, A.propertyA, { status: "acknowledged" });
      assert.equal(ack.status, 200, JSON.stringify(ack.body));
      assert.equal((await prisma.anomalyEvent.findUnique({ where: { id: anomaly.id }, select: { status: true } }))?.status, "acknowledged");
      assert.equal((await call(app, "PATCH", `/analytics/anomalies/${anomaly.id}`, manager, A.propertyA, { status: "open" })).status, 400, "estado fuera del esquema → 400");
      assert.equal((await call(app, "PATCH", `/analytics/anomalies/${anomaly.id}`, managerB, B.propertyA, { status: "resolved" })).status, 404);
      assert.equal((await call(app, "PATCH", `/analytics/anomalies/${anomaly.id}`, manager, A.propertyA, { status: "resolved" })).body.status, "resolved");
      assert.equal((await call(app, "PATCH", `/analytics/anomalies/${anomaly.id}`, manager, A.propertyA, { status: "acknowledged" })).status, 409);

      const report = await call(app, "POST", `/analytics/properties/${A.propertyA}/reports`, manager, A.propertyA, { name: "Flash diario", reportType: "daily_flash", recipients: ["direccion@faranda.test"] });
      const reportId = created(report, "POST reports");
      assert.ok(ids(await call(app, "GET", `/analytics/properties/${A.propertyA}/reports`, manager, A.propertyA)).includes(reportId));
      assert.equal((await prisma.scheduledReport.findUnique({ where: { id: reportId }, select: { organizationId: true, propertyId: true } }))?.propertyId, A.propertyA);
    }));

  it("eventos: calendario desde events y BEO (event_order) colgado del evento de la propiedad", async () =>
    strict(async () => {
      const event = await prisma.event.create({ data: { propertyId: A.propertyA, name: "Boda Rial", startAt: new Date("2026-10-10T12:00:00.000Z"), endAt: new Date("2026-10-10T23:00:00.000Z") }, select: { id: true } });
      assert.ok(ids(await call(app, "GET", `/events/properties/${A.propertyA}/calendar`, manager, A.propertyA)).includes(event.id));
      const beo = await call(app, "POST", `/events/${event.id}/generate-beo`, manager, A.propertyA, { content: { menu: "Degustación" }, notes: "Sin gluten" });
      const beoId = created(beo, "POST generate-beo");
      assert.equal(beo.body.orderType, "beo");
      assert.equal(beo.body.status, "draft");
      assert.equal((await prisma.eventOrder.findUnique({ where: { id: beoId }, select: { eventId: true } }))?.eventId, event.id);
      const foreignEvent = await prisma.event.create({ data: { propertyId: B.propertyA, name: "Ajeno", startAt: new Date(), endAt: new Date() }, select: { id: true } });
      assert.equal((await call(app, "POST", `/events/${foreignEvent.id}/generate-beo`, manager, A.propertyA, { content: {} })).status, 404);
    }));

  it("reputación: respuesta a reseña (responseBody/respondedAt) una sola vez", async () =>
    strict(async () => {
      const review = await prisma.guestReview.create({ data: { propertyId: A.propertyA, source: "google", rating: 4.5, body: "Muy buena estancia" }, select: { id: true } });
      const responded = await call(app, "POST", `/reputation/reviews/${review.id}/respond`, manager, A.propertyA, { responseBody: "Gracias por su visita" });
      assert.equal(responded.status, 200, JSON.stringify(responded.body));
      assert.equal(responded.body.status, "responded");
      const row = await prisma.guestReview.findUnique({ where: { id: review.id }, select: { responseBody: true, respondedAt: true } });
      assert.equal(row?.responseBody, "Gracias por su visita");
      assert.ok(row?.respondedAt instanceof Date);
      assert.equal((await call(app, "POST", `/reputation/reviews/${review.id}/respond`, manager, A.propertyA, { responseBody: "Otra vez" })).status, 409);
      assert.equal((await call(app, "POST", `/reputation/reviews/${review.id}/respond`, managerB, B.propertyA, { responseBody: "Ajeno" })).status, 404);
      const list = await call(app, "GET", `/reputation/properties/${A.propertyA}/reviews`, manager, A.propertyA);
      assert.equal(items(list).find((item) => item.id === review.id)?.responseBody, "Gracias por su visita");
    }));

  it("rutas retiradas (L2-02): cuadro por módulo y previsión laboral ya no existen → 404 «Not Found» de Fastify, fuera del manifiesto", async () =>
    strict(async () => {
      // L2-01 dejó un stub «Ruta retirada; usa /dashboards/*» y L2-02 borró la
      // ruta del todo (server.ts + manifiesto): la respuesta es el 404 genérico
      // del router, nunca el 403 del manifiesto ni un 500.
      for (const path of [`/reputation/properties/${A.propertyA}/dashboard`, `/workforce/properties/${A.propertyA}/labor-forecast`]) {
        const retired = await call(app, "GET", path, manager, A.propertyA);
        assert.equal(retired.status, 404, JSON.stringify(retired.body));
        assert.match(String(retired.body.message), /not found/i);
        assert.doesNotMatch(String(retired.body.message), /Ruta retirada|permiso/);
      }
      assert.equal(routePermissionManifest.some((route) => /\/(dashboard|labor-forecast)$/.test(route.path) && /^\/(reputation|workforce)\//.test(route.path)), false, "las rutas retiradas no figuran en el manifiesto");
    }));

  it("un buildApiServer() nuevo sigue leyendo lo persistido (nada vive en memoria)", async () => {
    // Se construye con el entorno ambiente (NODE_ENV=production exige el
    // contrato de variables de producción en assertEnv); las peticiones van en estricto.
    const app2 = await buildApiServer();
    await strict(async () => {
      try {
        const session = await loginOrThrow(app2, manager.email, A.password, "l2-motor-restart");
        const incidents = await call(app2, "GET", `/safety/properties/${A.propertyA}/incidents`, session, A.propertyA);
        assert.equal(incidents.status, 200);
        assert.ok(ids(incidents).includes(created_.incident), "el incidente persiste tras reconstruir el API");
        assert.ok(ids(await call(app2, "GET", `/workforce/properties/${A.propertyA}/schedule`, session, A.propertyA)).includes(created_.shift));
        assert.ok(ids(await call(app2, "GET", "/crm/segments", session, A.propertyA)).includes(created_.segment));
      } finally {
        await app2.close();
      }
    });
  });
});
