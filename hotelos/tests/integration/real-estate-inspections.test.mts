/**
 * Tanda ACT · lote L5 · integración (Postgres): inspecciones obligatorias,
 * pólizas y motor de alertas sobre un tenant AISLADO (helpers/l2-tenant.mts,
 * organización `org_l2_act5…`) más un usuario con la plantilla `asset_manager`
 * asignado a la SOCIEDAD (scopeType legal_entity), auth real y RBAC_STRICT; el
 * activo se crea por API (POST /properties/:id/real-estate). Faranda y org_123
 * solo se leen (invariantes antes y después). Las 7 rutas van cableadas en
 * real-estate.register.ts (registerRealEstateInspectionRoutes).
 *
 * Casos: alta oca_ascensor sin base legal toma el catálogo (24 meses) · acta
 * negativa → con_defectos y alerta INSPECTION_NEGATIVE_OPEN alta · subsanar
 * todos los defectos → cerrada y nace la siguiente programada con scheduledAt =
 * nextDueAt · ascensor con nextDueAt ayer → INSPECTION_OVERDUE alta · póliza
 * que vence en 40 días → INSURANCE_EXPIRING media · inspección con
 * complianceRequirementCode actualiza ComplianceItem.expiryDate · receptionist
 * 403 · accountant lee y no escribe · centro sin ficha 404 opaco · auditoría.
 *
 * Sin nombres de personas: aseguradoras y proveedores son sociedades ficticias.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/real-estate-inspections.test.mts
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
const { addMonths, toIsoDay, addDays } = await import("../../apps/api/src/modules/real-estate/vigencias.js");

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

/** Usuario extra con una plantilla asignada a la SOCIEDAD del tenant (barrido por cleanupTenant). */
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

const RUN = `act5${newRunId()}`;
const TODAY = toIsoDay(new Date());
const day = (offset: number) => addDays(TODAY, offset);
/** Códigos del catálogo de cumplimiento creados por la suite (tabla global sin organización: se borran en `after`). */
const REQ_ELEVATOR = `ACT-INS-${RUN}`;
const REQ_CEE = `ACT-CEE-${RUN}`;
const REQ_UNKNOWN = `ACT-NOPE-${RUN}`;

let app: ApiApp;
let tenant: IsolatedTenant;
let assetManager: Session;
let receptionist: Session;
let accountant: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

const base = (propertyId: string) => `/properties/${propertyId}/real-estate`;
let inspectionsUrl: string;
let insurancesUrl: string;
let alertsUrl: string;

let assetId: string;
let elevatorId: string;
let elevatorNextDueAt: string;
let ceeId: string;
let rcPolicyId: string;
let expiredPolicyId: string;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  for (const [method, path] of [
    ["GET", "/properties/:propertyId/real-estate/inspections"],
    ["POST", "/properties/:propertyId/real-estate/inspections"],
    ["PATCH", "/properties/:propertyId/real-estate/inspections/:inspectionId"],
    ["GET", "/properties/:propertyId/real-estate/insurances"],
    ["POST", "/properties/:propertyId/real-estate/insurances"],
    ["PATCH", "/properties/:propertyId/real-estate/insurances/:insuranceId"],
    ["GET", "/properties/:propertyId/real-estate/alerts"]
  ] as const) {
    assert.ok(routePermissionManifest.some((entry) => entry.method === method && entry.path === path), `${method} ${path} en el manifiesto`);
  }
  baseline = await farandaInvariants();
  tenant = await createIsolatedTenant(RUN);
  await prisma.complianceRequirement.createMany({
    data: [
      { code: REQ_ELEVATOR, areaCode: "INS", title: `OCA del ascensor (prueba ${RUN})`, legalReference: "RD 355/2024", riskLevel: "HIGH", requiredDocuments: ["acta_oca"], renewalRequired: true, defaultRenewalPeriodDays: 730 },
      { code: REQ_CEE, areaCode: "ENV", title: `Certificado de eficiencia energética (prueba ${RUN})`, legalReference: "RD 390/2021", riskLevel: "MEDIUM", requiredDocuments: ["cee"], renewalRequired: true, defaultRenewalPeriodDays: 3650 }
    ]
  });
  const manager = await addEntityUser(tenant, "activos", "asset_manager");
  assetManager = await strict(() => loginOrThrow(app, manager.email, tenant.password));
  receptionist = await strict(() => loginOrThrow(app, tenant.users.receptionist.email, tenant.password));
  accountant = await strict(() => loginOrThrow(app, tenant.users.accountant.email, tenant.password));
  inspectionsUrl = `${base(tenant.propertyA)}/inspections`;
  insurancesUrl = `${base(tenant.propertyA)}/insurances`;
  alertsUrl = `${base(tenant.propertyA)}/alerts`;
  // Activo creado por API (L1).
  const created = await call(app, "POST", base(tenant.propertyA), assetManager, { name: "Hotel de prueba ACT L5", roomsCount: 120, yearBuilt: 1998 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assetId = created.body.asset.id;
});

after(async () => {
  try {
    await flushAuditQueues();
    await prisma.complianceRequirement.deleteMany({ where: { code: { in: [REQ_ELEVATOR, REQ_CEE] } } });
    if (tenant) {
      await prisma.complianceItem.deleteMany({ where: { propertyId: { in: [tenant.propertyA, tenant.propertyB] } } });
      await cleanupTenant(tenant.organizationId);
      assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "sin organizaciones residuales");
      assert.equal(await prisma.realEstateInspection.count({ where: { organizationId: tenant.organizationId } }), 0, "inspecciones barridas con la ficha");
      assert.equal(await prisma.realEstateInsurance.count({ where: { organizationId: tenant.organizationId } }), 0, "pólizas barridas con la ficha");
    }
    assert.equal(await prisma.complianceRequirement.count({ where: { code: { in: [REQ_ELEVATOR, REQ_CEE] } } }), 0, "catálogo de cumplimiento limpio");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
  }
});

describe("ACT-L5 · inspecciones obligatorias (§5.1)", () => {
  it("alta oca_ascensor sin base legal toma el catálogo (24 meses)", async () => {
    const empty = await call(app, "GET", inspectionsUrl, assetManager);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body, []);

    const created = await call(app, "POST", inspectionsUrl, assetManager, { kind: "oca_ascensor", installationRef: "RAE-0001", scheduledAt: day(25), complianceRequirementCode: REQ_ELEVATOR, providerName: "Organismo de control de prueba SA" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    elevatorId = created.body.id;
    assert.equal(created.body.assetId, assetId);
    assert.equal(created.body.propertyId, tenant.propertyA);
    assert.equal(created.body.organizationId, tenant.organizationId);
    assert.equal(created.body.legalBasis, "RD 355/2024 art. 11.4.a");
    assert.equal(created.body.periodicityMonths, 24);
    assert.equal(created.body.status, "programada");
    assert.equal(created.body.scheduledAt, day(25));
    assert.equal(created.body.dueState, "proxima", "≤ 90 días");
    assert.equal(created.body.nextDueAt, null);
    assert.equal(created.body.result, null);
    assert.equal(created.body.defectsJson, null);
    assert.equal(created.body.complianceRequirementCode, REQ_ELEVATOR);

    const other = await call(app, "POST", inspectionsUrl, assetManager, { kind: "otra", installationRef: "Grupo electrógeno", notes: "Revisión voluntaria anual." });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal(other.body.legalBasis, null);
    assert.equal(other.body.periodicityMonths, null);
    assert.equal(other.body.dueState, "sin_fecha");

    const cee = await call(app, "POST", inspectionsUrl, assetManager, { kind: "cee", legalBasis: "Ordenanza local de prueba", periodicityMonths: 60, complianceRequirementCode: REQ_CEE });
    assert.equal(cee.status, 201, JSON.stringify(cee.body));
    ceeId = cee.body.id;
    assert.equal(cee.body.legalBasis, "Ordenanza local de prueba", "lo que trae el cuerpo manda");
    assert.equal(cee.body.periodicityMonths, 60);

    const badKind = await call(app, "POST", inspectionsUrl, assetManager, { kind: "ascensor" });
    assert.equal(badKind.status, 400, JSON.stringify(badKind.body));
    assert.equal(codeOf(badKind), "VALIDATION_ERROR");
    const unknownField = await call(app, "POST", inspectionsUrl, assetManager, { kind: "gas", foo: 1 });
    assert.equal(unknownField.status, 400);

    const all = await call(app, "GET", inspectionsUrl, assetManager);
    assert.equal(all.status, 200);
    assert.equal(all.body.length, 3);
    const onlyElevators = await call(app, "GET", `${inspectionsUrl}?kind=oca_ascensor`, assetManager);
    assert.equal(onlyElevators.status, 200);
    assert.equal(onlyElevators.body.length, 1);
    assert.equal(onlyElevators.body[0].id, elevatorId);
    const filtered = await call(app, "GET", `${inspectionsUrl}?status=programada&kind=cee`, assetManager);
    assert.equal(filtered.body.length, 1);
    const badQuery = await call(app, "GET", `${inspectionsUrl}?status=abierta`, assetManager);
    assert.equal(badQuery.status, 400, JSON.stringify(badQuery.body));
    assert.equal(codeOf(badQuery), "VALIDATION_ERROR");
  });

  it("acta negativa → con_defectos y alerta INSPECTION_NEGATIVE_OPEN alta", async () => {
    const performedAt = day(-2);
    const acta = await call(app, "PATCH", `${inspectionsUrl}/${elevatorId}`, assetManager, {
      performedAt,
      result: "negativa",
      defectsJson: [
        { severity: "grave", text: "Cable de tracción con hilos rotos", dueAt: day(60) },
        { severity: "leve", text: "Iluminación de cabina insuficiente", dueAt: day(90) }
      ]
    });
    assert.equal(acta.status, 200, JSON.stringify(acta.body));
    assert.equal(acta.body.status, "con_defectos");
    assert.equal(acta.body.result, "negativa");
    assert.equal(acta.body.performedAt, performedAt);
    elevatorNextDueAt = addMonths(performedAt, 24);
    assert.equal(acta.body.nextDueAt, elevatorNextDueAt, "performedAt + 24 meses");
    assert.equal(acta.body.correctionDueAt, day(60), "primer plazo abierto");
    assert.equal(acta.body.correctedAt, null);
    assert.equal(acta.body.dueState, "en_plazo");
    assert.equal(acta.body.defectsJson.length, 2);
    assert.deepEqual(acta.body.defectsJson[0], { severity: "grave", text: "Cable de tracción con hilos rotos", dueAt: day(60), fixedAt: null });

    const alerts = await call(app, "GET", alertsUrl, assetManager);
    assert.equal(alerts.status, 200, JSON.stringify(alerts.body));
    const negative = alerts.body.find((a: Json) => a.kind === "INSPECTION_NEGATIVE_OPEN" && a.entityId === elevatorId);
    assert.ok(negative, JSON.stringify(alerts.body));
    assert.equal(negative.severity, "alta");
    assert.equal(negative.dueAt, day(60));
    assert.equal(negative.entityType, "real_estate_inspection");
    assert.equal(negative.propertyId, tenant.propertyA);
    assert.match(negative.message, /negativa sin subsanar/);
    assert.ok(!alerts.body.some((a: Json) => a.kind === "INSPECTION_OVERDUE" && a.entityId === elevatorId), "vencimiento del acta anterior ya no se avisa");

    // El centro de cumplimiento refleja el acta: ítem NON_COMPLIANT con las fechas de la inspección.
    const item = await prisma.complianceItem.findUnique({ where: { propertyId_requirementCode: { propertyId: tenant.propertyA, requirementCode: REQ_ELEVATOR } } });
    assert.ok(item, "ComplianceItem creado por el acta");
    assert.equal(item.status, "NON_COMPLIANT");
    assert.equal(item.applies, true);
    assert.equal(item.issueDate?.toISOString().slice(0, 10), performedAt);
    assert.equal(item.expiryDate?.toISOString().slice(0, 10), elevatorNextDueAt);

    const close = await call(app, "PATCH", `${inspectionsUrl}/${elevatorId}`, assetManager, { status: "cerrada" });
    assert.equal(close.status, 409, JSON.stringify(close.body));
    assert.equal(codeOf(close), "INSPECTION_INVALID_TRANSITION");
    assert.equal(close.body.details.openDefects, 2);
    assert.deepEqual(close.body.details.allowed, ["cerrada"]);
    const flip = await call(app, "PATCH", `${inspectionsUrl}/${elevatorId}`, assetManager, { result: "favorable" });
    assert.equal(flip.status, 409, JSON.stringify(flip.body));
    assert.equal(codeOf(flip), "INSPECTION_INVALID_TRANSITION");
    assert.equal(await prisma.realEstateInspection.count({ where: { assetId, kind: "oca_ascensor", installationRef: "RAE-0001", status: "programada" } }), 0, "sin sucesora hasta subsanar");
  });

  it("subsanar todos los defectos → cerrada y nace la siguiente programada con scheduledAt = nextDueAt", async () => {
    const partial = await call(app, "PATCH", `${inspectionsUrl}/${elevatorId}`, assetManager, {
      defectsJson: [
        { severity: "grave", text: "Cable de tracción con hilos rotos", dueAt: day(60), fixedAt: day(-1) },
        { severity: "leve", text: "Iluminación de cabina insuficiente", dueAt: day(90) }
      ]
    });
    assert.equal(partial.status, 200, JSON.stringify(partial.body));
    assert.equal(partial.body.status, "con_defectos", "queda un defecto abierto");
    assert.equal(partial.body.correctionDueAt, day(90), "el plazo pasa al defecto que queda");

    const closed = await call(app, "PATCH", `${inspectionsUrl}/${elevatorId}`, assetManager, {
      defectsJson: [
        { severity: "grave", text: "Cable de tracción con hilos rotos", dueAt: day(60), fixedAt: day(-1) },
        { severity: "leve", text: "Iluminación de cabina insuficiente", dueAt: day(90), fixedAt: TODAY }
      ]
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.status, "cerrada");
    assert.equal(closed.body.correctedAt, TODAY, "último fixedAt");
    assert.equal(closed.body.nextDueAt, elevatorNextDueAt);

    const elevators = await call(app, "GET", `${inspectionsUrl}?kind=oca_ascensor`, assetManager);
    assert.equal(elevators.status, 200);
    assert.equal(elevators.body.length, 2, "la cerrada y su sucesora");
    const successor = elevators.body.find((row: Json) => row.id !== elevatorId);
    assert.ok(successor);
    assert.equal(successor.status, "programada");
    assert.equal(successor.scheduledAt, elevatorNextDueAt);
    assert.equal(successor.nextDueAt, elevatorNextDueAt);
    assert.equal(successor.installationRef, "RAE-0001");
    assert.equal(successor.legalBasis, "RD 355/2024 art. 11.4.a");
    assert.equal(successor.periodicityMonths, 24);
    assert.equal(successor.complianceRequirementCode, REQ_ELEVATOR);
    assert.equal(successor.providerName, "Organismo de control de prueba SA");
    assert.equal(successor.performedAt, null);
    assert.equal(successor.dueState, "en_plazo");

    const item = await prisma.complianceItem.findUnique({ where: { propertyId_requirementCode: { propertyId: tenant.propertyA, requirementCode: REQ_ELEVATOR } } });
    assert.equal(item?.status, "COMPLIANT", "subsanación completa");
    assert.equal(item?.expiryDate?.toISOString().slice(0, 10), elevatorNextDueAt);

    const alerts = await call(app, "GET", alertsUrl, assetManager);
    assert.ok(!alerts.body.some((a: Json) => a.entityId === elevatorId), "la cerrada no avisa");
    assert.ok(!alerts.body.some((a: Json) => a.entityId === successor.id), "la sucesora vence en dos años");

    const frozen = await call(app, "PATCH", `${inspectionsUrl}/${elevatorId}`, assetManager, { notes: "cambio tardío" });
    assert.equal(frozen.status, 409, JSON.stringify(frozen.body));
    assert.equal(codeOf(frozen), "INSPECTION_INVALID_TRANSITION");
    assert.equal(await prisma.realEstateInspection.count({ where: { assetId, kind: "oca_ascensor" } }), 2, "una sola sucesora");
  });

  it("ascensor con nextDueAt ayer → INSPECTION_OVERDUE alta", async () => {
    const overdue = await call(app, "POST", inspectionsUrl, assetManager, { kind: "oca_ascensor", installationRef: "RAE-0002", nextDueAt: day(-1) });
    assert.equal(overdue.status, 201, JSON.stringify(overdue.body));
    assert.equal(overdue.body.dueState, "vencida");
    const alerts = await call(app, "GET", alertsUrl, assetManager);
    const alert = alerts.body.find((a: Json) => a.kind === "INSPECTION_OVERDUE" && a.entityId === overdue.body.id);
    assert.ok(alert, JSON.stringify(alerts.body));
    assert.equal(alert.severity, "alta");
    assert.equal(alert.dueAt, day(-1));
    assert.match(alert.message, /fuera de servicio a las 24 h/);
    assert.equal(alerts.body[0].severity, "alta", "ordenadas por gravedad");

    // Acta favorable: realizada, sucesora con el nuevo plazo y el vencido deja de avisar.
    const acta = await call(app, "PATCH", `${inspectionsUrl}/${overdue.body.id}`, assetManager, { performedAt: TODAY, result: "favorable" });
    assert.equal(acta.status, 200, JSON.stringify(acta.body));
    assert.equal(acta.body.status, "realizada");
    assert.equal(acta.body.nextDueAt, addMonths(TODAY, 24));
    const after = await call(app, "GET", alertsUrl, assetManager);
    assert.ok(!after.body.some((a: Json) => a.entityId === overdue.body.id), "sin OVERDUE tras el acta");
    const successors = await prisma.realEstateInspection.findMany({ where: { assetId, kind: "oca_ascensor", installationRef: "RAE-0002", status: "programada" }, select: { scheduledAt: true } });
    assert.equal(successors.length, 1);
    assert.equal(successors[0].scheduledAt?.toISOString().slice(0, 10), addMonths(TODAY, 24));

    // Un plazo cercano no se avisa dos veces (la realizada y su sucesora comparten fecha): legionela cada 3 meses.
    const legionella = await call(app, "POST", inspectionsUrl, assetManager, { kind: "legionella", installationRef: "ACS-1" });
    assert.equal(legionella.status, 201);
    assert.equal(legionella.body.periodicityMonths, 3);
    const legionellaActa = await call(app, "PATCH", `${inspectionsUrl}/${legionella.body.id}`, assetManager, { performedAt: day(-10), result: "favorable" });
    assert.equal(legionellaActa.status, 200, JSON.stringify(legionellaActa.body));
    const due = addMonths(day(-10), 3);
    assert.equal(legionellaActa.body.nextDueAt, due);
    const dueAlerts = (await call(app, "GET", alertsUrl, assetManager)).body.filter((a: Json) => a.kind === "INSPECTION_DUE" && a.dueAt === due);
    assert.equal(dueAlerts.length, 1, JSON.stringify(dueAlerts));
    assert.notEqual(dueAlerts[0].entityId, legionella.body.id, "la avisa la sucesora, no la realizada");
    assert.equal(dueAlerts[0].severity, "baja", "≈ 80 días");
  });

  it("inspección con complianceRequirementCode actualiza ComplianceItem.expiryDate", async () => {
    assert.equal(await prisma.complianceItem.count({ where: { propertyId: tenant.propertyA, requirementCode: REQ_CEE } }), 0);
    const acta = await call(app, "PATCH", `${inspectionsUrl}/${ceeId}`, assetManager, { performedAt: "2026-09-01", result: "favorable", documentId: "red_cee_prueba" });
    assert.equal(acta.status, 200, JSON.stringify(acta.body));
    assert.equal(acta.body.status, "realizada");
    assert.equal(acta.body.nextDueAt, "2031-09-01", "60 meses explícitos, no los 120 del catálogo");
    assert.equal(acta.body.documentId, "red_cee_prueba");
    let item = await prisma.complianceItem.findUnique({ where: { propertyId_requirementCode: { propertyId: tenant.propertyA, requirementCode: REQ_CEE } } });
    assert.ok(item);
    assert.equal(item.status, "COMPLIANT");
    assert.equal(item.issueDate?.toISOString().slice(0, 10), "2026-09-01");
    assert.equal(item.expiryDate?.toISOString().slice(0, 10), "2031-09-01");
    assert.equal((await prisma.realEstateInspection.findFirst({ where: { assetId, kind: "cee", status: "programada" }, select: { scheduledAt: true } }))?.scheduledAt?.toISOString().slice(0, 10), "2031-09-01");

    // Plazo editado a mano sobre la realizada → el ítem lo sigue.
    const edited = await call(app, "PATCH", `${inspectionsUrl}/${ceeId}`, assetManager, { nextDueAt: "2030-01-01" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.nextDueAt, "2030-01-01");
    item = await prisma.complianceItem.findUnique({ where: { propertyId_requirementCode: { propertyId: tenant.propertyA, requirementCode: REQ_CEE } } });
    assert.equal(item?.expiryDate?.toISOString().slice(0, 10), "2030-01-01");
    assert.equal(item?.status, "COMPLIANT");

    // Código fuera del catálogo: se guarda en la inspección y no sincroniza nada.
    const gas = await call(app, "POST", inspectionsUrl, assetManager, { kind: "gas", complianceRequirementCode: REQ_UNKNOWN });
    assert.equal(gas.status, 201, JSON.stringify(gas.body));
    const gasActa = await call(app, "PATCH", `${inspectionsUrl}/${gas.body.id}`, assetManager, { performedAt: TODAY, result: "favorable" });
    assert.equal(gasActa.status, 200, JSON.stringify(gasActa.body));
    assert.equal(gasActa.body.complianceRequirementCode, REQ_UNKNOWN);
    assert.equal(await prisma.complianceItem.count({ where: { requirementCode: REQ_UNKNOWN } }), 0);
  });
});

describe("ACT-L5 · pólizas", () => {
  it("póliza que vence en 40 días → INSURANCE_EXPIRING media", async () => {
    const created = await call(app, "POST", insurancesUrl, assetManager, { kind: "rc", insurerName: "Aseguradora de prueba SA", policyNumber: `RC-${RUN}`, validFrom: day(-325), validUntil: day(40), premiumAnnual: "4200.00", insuredSum: "3000000.00", mandatoryBasis: "Decreto 57/2016 art. 17" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    rcPolicyId = created.body.id;
    assert.equal(created.body.status, "vigente");
    assert.equal(created.body.noticeDays, 60, "preaviso por defecto");
    assert.equal(created.body.autoRenew, true);
    assert.equal(created.body.policyholder, "sociedad");
    assert.equal(created.body.premiumAnnual, "4200.00");
    assert.equal(created.body.validUntil, day(40));

    const alerts = await call(app, "GET", alertsUrl, assetManager);
    const expiring = alerts.body.find((a: Json) => a.kind === "INSURANCE_EXPIRING" && a.entityId === rcPolicyId);
    assert.ok(expiring, JSON.stringify(alerts.body));
    assert.equal(expiring.severity, "media");
    assert.equal(expiring.dueAt, day(40));
    assert.equal(expiring.entityType, "real_estate_insurance");
    assert.match(expiring.message, /responsabilidad civil/);

    const expired = await call(app, "POST", insurancesUrl, assetManager, { kind: "multirriesgo", insurerName: "Aseguradora de prueba SA", policyNumber: `MR-${RUN}`, validFrom: day(-400), validUntil: day(-1), autoRenew: false, noticeDays: 30 });
    assert.equal(expired.status, 201, JSON.stringify(expired.body));
    expiredPolicyId = expired.body.id;
    assert.equal(expired.body.status, "vencida", "derivado: validUntil pasó");
    assert.equal((await prisma.realEstateInsurance.findUnique({ where: { id: expiredPolicyId }, select: { status: true } }))?.status, "vigente", "nunca se persiste vencida");
    const expiredAlert = (await call(app, "GET", alertsUrl, assetManager)).body.find((a: Json) => a.kind === "INSURANCE_EXPIRING" && a.entityId === expiredPolicyId);
    assert.equal(expiredAlert?.severity, "alta");
    assert.match(expiredAlert?.message, /sin renovación registrada/);

    const badWindow = await call(app, "POST", insurancesUrl, assetManager, { kind: "rc", insurerName: "x", policyNumber: "y", validFrom: TODAY, validUntil: day(-1) });
    assert.equal(badWindow.status, 400, JSON.stringify(badWindow.body));
    assert.equal(codeOf(badWindow), "VALIDATION_ERROR");
    const missing = await call(app, "POST", insurancesUrl, assetManager, { kind: "rc", insurerName: "x", validFrom: TODAY, validUntil: day(10) });
    assert.equal(missing.status, 400);

    const listed = await call(app, "GET", insurancesUrl, assetManager);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 2);
    assert.equal(listed.body[0].id, expiredPolicyId, "por validUntil ascendente");
  });

  it("renovar (validUntil) quita la alerta; cancelar y vencida son estados distintos", async () => {
    const renewed = await call(app, "PATCH", `${insurancesUrl}/${rcPolicyId}`, assetManager, { validUntil: day(405), premiumAnnual: "4400.00" });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.validUntil, day(405));
    assert.equal(renewed.body.premiumAnnual, "4400.00");
    assert.equal(renewed.body.status, "vigente");
    assert.ok(!(await call(app, "GET", alertsUrl, assetManager)).body.some((a: Json) => a.entityId === rcPolicyId), "renovada: sin alerta");

    const before = await call(app, "PATCH", `${insurancesUrl}/${rcPolicyId}`, assetManager, { validUntil: day(-400) });
    assert.equal(before.status, 400, "anterior a validFrom");
    assert.equal(codeOf(before), "VALIDATION_ERROR");
    const derived = await call(app, "PATCH", `${insurancesUrl}/${rcPolicyId}`, assetManager, { status: "vencida" });
    assert.equal(derived.status, 400, JSON.stringify(derived.body));
    assert.equal(codeOf(derived), "VALIDATION_ERROR");
    const empty = await call(app, "PATCH", `${insurancesUrl}/${rcPolicyId}`, assetManager, {});
    assert.equal(empty.status, 400);

    const cancelled = await call(app, "PATCH", `${insurancesUrl}/${expiredPolicyId}`, assetManager, { status: "cancelada" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, "cancelada");
    assert.ok(!(await call(app, "GET", alertsUrl, assetManager)).body.some((a: Json) => a.entityId === expiredPolicyId), "cancelada: sin alerta");
    const unknown = await call(app, "PATCH", `${insurancesUrl}/rein_no_existe`, assetManager, { notes: "x" });
    assert.equal(unknown.status, 404);
  });
});

describe("ACT-L5 · RBAC, tenencia y auditoría", () => {
  it("receptionist 403", async () => {
    for (const attempt of [
      call(app, "GET", inspectionsUrl, receptionist),
      call(app, "GET", insurancesUrl, receptionist),
      call(app, "GET", alertsUrl, receptionist),
      call(app, "POST", inspectionsUrl, receptionist, { kind: "gas" }),
      call(app, "PATCH", `${inspectionsUrl}/${ceeId}`, receptionist, { notes: "x" }),
      call(app, "POST", insurancesUrl, receptionist, { kind: "rc", insurerName: "x", policyNumber: "y", validFrom: TODAY, validUntil: day(10) }),
      call(app, "PATCH", `${insurancesUrl}/${rcPolicyId}`, receptionist, { notes: "x" })
    ]) {
      const reply = await attempt;
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
    }
  });

  it("accountant lee (real_estate.read) y no escribe (403)", async () => {
    for (const url of [inspectionsUrl, insurancesUrl, alertsUrl]) {
      const reply = await call(app, "GET", url, accountant);
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.ok(Array.isArray(reply.body));
    }
    const inspectionsBefore = await prisma.realEstateInspection.count({ where: { assetId } });
    for (const attempt of [
      call(app, "POST", inspectionsUrl, accountant, { kind: "gas" }),
      call(app, "PATCH", `${inspectionsUrl}/${ceeId}`, accountant, { notes: "x" }),
      call(app, "POST", insurancesUrl, accountant, { kind: "rc", insurerName: "x", policyNumber: "y", validFrom: TODAY, validUntil: day(10) }),
      call(app, "PATCH", `${insurancesUrl}/${rcPolicyId}`, accountant, { notes: "x" })
    ]) {
      const reply = await attempt;
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
    }
    assert.equal(await prisma.realEstateInspection.count({ where: { assetId } }), inspectionsBefore, "nada escrito");
  });

  it("centro sin ficha 404 ASSET_NOT_FOUND e ids de otro centro 404 opaco", async () => {
    const noAsset = await call(app, "GET", `${base(tenant.propertyB)}/inspections`, assetManager);
    assert.equal(noAsset.status, 404, JSON.stringify(noAsset.body));
    assert.equal(codeOf(noAsset), "ASSET_NOT_FOUND");
    const noAlerts = await call(app, "GET", `${base(tenant.propertyB)}/alerts`, assetManager);
    assert.equal(noAlerts.status, 404);
    assert.equal(codeOf(noAlerts), "ASSET_NOT_FOUND");
    const noInsurances = await call(app, "GET", `${base(tenant.propertyB)}/insurances`, assetManager);
    assert.equal(noInsurances.status, 404);
    // Con ficha en B, los ids de A no se resuelven bajo B.
    const createdB = await call(app, "POST", base(tenant.propertyB), assetManager, { name: "Hotel de prueba ACT L5 (B)" });
    assert.equal(createdB.status, 201, JSON.stringify(createdB.body));
    const crossInspection = await call(app, "PATCH", `${base(tenant.propertyB)}/inspections/${ceeId}`, assetManager, { notes: "x" });
    assert.equal(crossInspection.status, 404, JSON.stringify(crossInspection.body));
    const crossInsurance = await call(app, "PATCH", `${base(tenant.propertyB)}/insurances/${rcPolicyId}`, assetManager, { notes: "x" });
    assert.equal(crossInsurance.status, 404, JSON.stringify(crossInsurance.body));
    assert.equal((await prisma.realEstateInspection.findUnique({ where: { id: ceeId }, select: { notes: true } }))?.notes, null, "nada escrito");
    assert.deepEqual((await call(app, "GET", `${base(tenant.propertyB)}/alerts`, assetManager)).body, [], "B sin alertas");
    const foreign = await call(app, "GET", `/properties/prop_no_existe_${RUN}/real-estate/alerts`, assetManager);
    assert.equal(foreign.status, 404);
    assert.equal(codeOf(foreign), undefined, "guardia global: opaco");
  });

  it("auditoría: toda escritura deja su evento real_estate_* con el actor", async () => {
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenant.organizationId, entityType: { in: ["real_estate_inspection", "real_estate_insurance"] } }, select: { action: true, entityType: true, entityId: true, actorUserId: true, afterJson: true } });
    const actions = new Set(events.map((e) => e.action));
    for (const expected of ["REAL_ESTATE_INSPECTION_CREATED", "REAL_ESTATE_INSPECTION_UPDATED", "REAL_ESTATE_INSPECTION_ACTA_RECORDED", "REAL_ESTATE_INSPECTION_CLOSED", "REAL_ESTATE_INSURANCE_CREATED", "REAL_ESTATE_INSURANCE_UPDATED", "REAL_ESTATE_INSURANCE_CANCELLED"]) {
      assert.ok(actions.has(expected), `falta ${expected} en ${[...actions].join(", ")}`);
    }
    assert.ok(events.every((e) => e.actorUserId === assetManager.userId), "todas las escrituras las hizo el asset_manager");
    const closedEvent = events.find((e) => e.action === "REAL_ESTATE_INSPECTION_CLOSED" && e.entityId === elevatorId);
    assert.ok(closedEvent);
    const closedAfter = closedEvent.afterJson as Json;
    assert.deepEqual(closedAfter.transition, { from: "con_defectos", to: "cerrada" });
    assert.equal(closedAfter.complianceSynced, true);
    assert.ok(typeof closedAfter.successorId === "string");
    assert.ok(events.some((e) => e.action === "REAL_ESTATE_INSPECTION_CREATED" && (e.afterJson as Json)?.successorOf === elevatorId), "la sucesora se audita como creada");
    assert.ok(!events.some((e) => JSON.stringify(e.afterJson ?? {}).includes("Organismo de control")), "sin nombre del proveedor en la auditoría");
  });
});
