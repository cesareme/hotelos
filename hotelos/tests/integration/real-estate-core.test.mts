/**
 * Tanda ACT · lote L1 · integración (Postgres): ficha del activo inmobiliario,
 * unidades, cargas, valoraciones y tenencia sobre un tenant AISLADO
 * (helpers/l2-tenant.mts, organización `org_l2_act…`) más un usuario con la
 * plantilla `asset_manager` asignado a la SOCIEDAD (scopeType legal_entity),
 * auth real y RBAC_STRICT; Faranda y org_123 solo se leen (invariantes antes y
 * después). Las 12 rutas van cableadas en server.ts (registerRealEstateRoutes).
 *
 * Casos: alta 201 y segundo alta 409 ASSET_ALREADY_EXISTS · referencia
 * catastral inválida 400 · asset_manager crea unidad, carga y valoración y la
 * caché lastValuationValue se actualiza · segunda tenencia vigente 409
 * TENURE_ALREADY_ACTIVE · receptionist 403 en GET y POST · accountant lee
 * (real_estate.read) y no escribe (403) · centro ajeno 404 opaco.
 *
 * Sin nombres de personas: contrapartes y titulares son sociedades ficticias.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/real-estate-core.test.mts
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
const { realEstateRoutePermissions } = await import("../../apps/api/src/modules/real-estate/route-permissions.partial.js");
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

const RUN_A = `act${newRunId()}`;
const RUN_B = `${RUN_A}b`;
/** Referencia catastral de prueba con la forma real (7 + 7 + 4 + 2). */
const CENSUS_REF_PRINTED = "9872023 vh5797s 0001 wx";
const CENSUS_REF = "9872023VH5797S0001WX";
const LOCAL_REF = "1234567890ABCDEFGHIJ";

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let assetManagerA: Session;
let receptionistA: Session;
let accountantA: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

const base = (propertyId: string) => `/properties/${propertyId}/real-estate`;

let assetId: string;
let firstUnitId: string;
let localUnitId: string;
let chargeId: string;
let propietadTenureId: string;
let gestionTenureId: string;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  assert.ok(routePermissionManifest.some((entry) => entry.path === "/properties/:propertyId/real-estate" && entry.method === "GET"), "las rutas del activo inmobiliario van cableadas en server.ts");
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  // Censo del centro A como lo teclearía la administración (impreso con espacios y minúsculas).
  await prisma.property.update({ where: { id: tenantA.propertyA }, data: { cadastralReference: CENSUS_REF_PRINTED, surfaceM2: "5400.50", bedCapacity: 250 } });
  const manager = await addEntityUser(tenantA, "activos", "asset_manager");
  assetManagerA = await strict(() => loginOrThrow(app, manager.email, tenantA.password));
  receptionistA = await strict(() => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  accountantA = await strict(() => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
  ownerB = await strict(() => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
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

describe("ACT-REV-01 · composición real de las rutas del módulo", () => {
  it("toda entrada de los partials real-estate tiene ruta registrada en buildApiServer()", () => {
    // Cruce inverso al contract test estático (api-route-permissions-contract lee *.routes.ts):
    // un partial con entrada en el manifiesto cuyo `<lote>.routes.ts` no se llame desde
    // real-estate.register.ts (caso documentos L3, ACT-REV-01) rompe aquí.
    assert.ok(realEstateRoutePermissions.length >= 41, `partials real-estate: ${realEstateRoutePermissions.length} entradas`);
    const missing = realEstateRoutePermissions
      .filter((entry) => !app.hasRoute({ method: entry.method as "GET", url: entry.path }))
      .map((entry) => `${entry.method} ${entry.path}`);
    assert.deepEqual(missing, [], `entradas del manifiesto sin ruta en el servidor:\n${missing.join("\n")}`);
    for (const entry of realEstateRoutePermissions) {
      assert.ok(routePermissionManifest.some((row) => row.method === entry.method && row.path === entry.path), `${entry.method} ${entry.path} en routePermissionManifest`);
    }
  });
});

describe("ACT-L1 · ficha del activo", () => {
  it("alta 201 y segundo alta 409 ASSET_ALREADY_EXISTS", async () => {
    const missing = await call(app, "GET", base(tenantA.propertyA), assetManagerA);
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(codeOf(missing), "ASSET_NOT_FOUND");

    const created = await call(app, "POST", base(tenantA.propertyA), assetManagerA, { name: "Hotel de prueba ACT", roomsCount: 120, yearBuilt: 1998, cadastralValueTotal: "3250000.00", cadastralValueYear: 2025, energyRating: "C" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const detail = created.body;
    assert.equal(detail.asset.propertyId, tenantA.propertyA);
    assert.equal(detail.asset.organizationId, tenantA.organizationId);
    assert.equal(detail.asset.legalEntityId, tenantA.legalEntityId, "sociedad por defecto del centro");
    assert.equal(detail.asset.status, "active");
    assert.equal(detail.asset.roomsCount, 120);
    assert.equal(detail.asset.cadastralValueTotal, "3250000.00");
    assert.equal(detail.asset.lastValuationValue, null);
    assert.equal(detail.asset.currentTenureKind, null, "la tenencia del alta nace en borrador");
    assetId = detail.asset.id;
    // Primera unidad prellenada desde el censo (referencia normalizada, superficie copiada).
    assert.equal(detail.units.length, 1, "una unidad al alta");
    firstUnitId = detail.units[0].id;
    assert.equal(detail.units[0].kind, "finca_registral");
    assert.equal(detail.units[0].cadastralReference, CENSUS_REF);
    assert.equal(detail.units[0].surfaceM2, "5400.50");
    assert.deepEqual(detail.units[0].charges, []);
    assert.equal(detail.currentTenure, null);
    assert.deepEqual(detail.valuations, []);
    assert.deepEqual(detail.taxes, []);
    assert.equal(detail.kpis.cadastralValueTotal, "3250000.00");
    assert.equal(detail.kpis.valuePerRoom, null);
    assert.equal(detail.kpis.openAlerts, 0);
    assert.deepEqual(detail.alerts, []);

    const tenures = await call(app, "GET", `${base(tenantA.propertyA)}/tenures`, assetManagerA);
    assert.equal(tenures.status, 200, JSON.stringify(tenures.body));
    assert.equal(tenures.body.length, 1);
    propietadTenureId = tenures.body[0].id;
    assert.equal(tenures.body[0].kind, "propiedad");
    assert.equal(tenures.body[0].status, "borrador");
    assert.equal(tenures.body[0].counterpartyName, `L2 Test ${RUN_A} SL`, "a nombre de la sociedad");
    assert.equal(tenures.body[0].counterpartyTaxId, tenantA.taxId);

    const again = await call(app, "POST", base(tenantA.propertyA), assetManagerA, { name: "Duplicado" });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(codeOf(again), "ASSET_ALREADY_EXISTS");
    assert.equal(again.body.details.assetId, assetId);

    const patched = await call(app, "PATCH", base(tenantA.propertyA), assetManagerA, { yearLastRefurbished: 2020, notes: "Reforma integral de plantas 3-6." });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.asset.yearLastRefurbished, 2020);
    assert.equal(patched.body.asset.roomsCount, 120, "el PATCH no toca lo que no envía");
    const emptyPatch = await call(app, "PATCH", base(tenantA.propertyA), assetManagerA, {});
    assert.equal(emptyPatch.status, 400);
    assert.equal(codeOf(emptyPatch), "VALIDATION_ERROR");
  });

  it("referencia catastral inválida 400", async () => {
    const short = await call(app, "POST", `${base(tenantA.propertyA)}/units`, assetManagerA, { kind: "local", cadastralReference: "1234" });
    assert.equal(short.status, 400, JSON.stringify(short.body));
    assert.equal(codeOf(short), "INVALID_CADASTRAL_REFERENCE");
    assert.equal(short.body.details.value, "1234");
    const hyphen = await call(app, "PATCH", `${base(tenantA.propertyA)}/units/${firstUnitId}`, assetManagerA, { cadastralReference: "9872023-VH5797S0001WX" });
    assert.equal(hyphen.status, 400, JSON.stringify(hyphen.body));
    assert.equal(codeOf(hyphen), "INVALID_CADASTRAL_REFERENCE");
    assert.equal((await prisma.realEstateUnit.count({ where: { assetId } })), 1, "nada escrito");
  });

  it("asset_manager crea unidad, carga y valoración; la caché lastValuationValue se actualiza", async () => {
    const unit = await call(app, "POST", `${base(tenantA.propertyA)}/units`, assetManagerA, { kind: "local", cadastralReference: LOCAL_REF.toLowerCase(), useCode: "local", surfaceM2: "120.00", cadastralValueLand: "40000.00", cadastralValueBuilding: "80000.00" });
    assert.equal(unit.status, 201, JSON.stringify(unit.body));
    localUnitId = unit.body.id;
    assert.equal(unit.body.assetId, assetId);
    assert.equal(unit.body.cadastralReference, LOCAL_REF, "normalizada a mayúsculas");
    assert.deepEqual(unit.body.charges, []);

    const duplicateRef = await call(app, "POST", `${base(tenantA.propertyA)}/units`, assetManagerA, { kind: "referencia_catastral", cadastralReference: LOCAL_REF });
    assert.equal(duplicateRef.status, 409, "índice único [organizationId, cadastralReference]");

    const charge = await call(app, "POST", `${base(tenantA.propertyA)}/units/${localUnitId}/charges`, assetManagerA, { kind: "hipoteca", holderName: "Entidad financiera de prueba SA", amount: "1500000.00", outstandingAmount: "820000.00", registeredAt: "2019-03-01" });
    assert.equal(charge.status, 201, JSON.stringify(charge.body));
    chargeId = charge.body.id;
    assert.equal(charge.body.unitId, localUnitId);
    assert.equal(charge.body.amount, "1500000.00");
    assert.equal(charge.body.registeredAt, "2019-03-01");

    const chargePatched = await call(app, "PATCH", `${base(tenantA.propertyA)}/charges/${chargeId}`, assetManagerA, { outstandingAmount: "800000.00" });
    assert.equal(chargePatched.status, 200, JSON.stringify(chargePatched.body));
    assert.equal(chargePatched.body.outstandingAmount, "800000.00");
    assert.equal(chargePatched.body.amount, "1500000.00");

    const unitPatched = await call(app, "PATCH", `${base(tenantA.propertyA)}/units/${firstUnitId}`, assetManagerA, { registryFincaNumber: "12345", registryOffice: "Registro de la Propiedad de prueba" });
    assert.equal(unitPatched.status, 200, JSON.stringify(unitPatched.body));
    assert.equal(unitPatched.body.registryFincaNumber, "12345");
    assert.equal(unitPatched.body.cadastralReference, CENSUS_REF, "la referencia no cambia");

    const valuation = await call(app, "POST", `${base(tenantA.propertyA)}/valuations`, assetManagerA, { kind: "eco_805", purpose: "hipotecaria", valuedAt: "2025-11-15", value: "9800000.00", capRatePct: "6.25", appraiser: "Sociedad de tasación de prueba SA" });
    assert.equal(valuation.status, 201, JSON.stringify(valuation.body));
    assert.equal(valuation.body.value, "9800000.00");
    assert.equal(valuation.body.valuePerRoom, "81666.67", "9.800.000 / 120 habitaciones");
    assert.equal(valuation.body.capRatePct, "6.25");

    // Una tasación ANTERIOR registrada después no pisa la caché (la más reciente por valuedAt manda).
    const older = await call(app, "POST", `${base(tenantA.propertyA)}/valuations`, assetManagerA, { kind: "interna", valuedAt: "2023-06-30", value: "8000000.00" });
    assert.equal(older.status, 201, JSON.stringify(older.body));

    const detail = await call(app, "GET", base(tenantA.propertyA), assetManagerA);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.asset.lastValuationValue, "9800000.00");
    assert.equal(detail.body.asset.lastValuationAt, "2025-11-15");
    assert.equal(detail.body.kpis.lastValuationValue, "9800000.00");
    assert.equal(detail.body.kpis.valuePerRoom, "81666.67");
    assert.equal(detail.body.valuations.length, 2);
    assert.equal(detail.body.valuations[0].id, valuation.body.id, "más reciente primero");
    assert.equal(detail.body.units.length, 2);
    const local = detail.body.units.find((u: Json) => u.id === localUnitId);
    assert.equal(local.charges.length, 1);
    assert.equal(local.charges[0].outstandingAmount, "800000.00");

    const listed = await call(app, "GET", `${base(tenantA.propertyA)}/valuations`, assetManagerA);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 2);

    const row = await prisma.realEstateAsset.findUnique({ where: { id: assetId }, select: { lastValuationValue: true, lastValuationAt: true } });
    assert.equal(row?.lastValuationValue?.toFixed(2), "9800000.00");
    assert.equal(row?.lastValuationAt?.toISOString().slice(0, 10), "2025-11-15");

    const zero = await call(app, "POST", `${base(tenantA.propertyA)}/valuations`, assetManagerA, { kind: "interna", valuedAt: "2026-01-01", value: "0" });
    assert.equal(zero.status, 400);
    assert.equal(codeOf(zero), "VALIDATION_ERROR");
  });
});

describe("ACT-L1 · tenencia (§5.1)", () => {
  it("segunda tenencia vigente 409 TENURE_ALREADY_ACTIVE", async () => {
    const activated = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${propietadTenureId}`, assetManagerA, { action: "activar" });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.status, "vigente");
    let detail = await call(app, "GET", base(tenantA.propertyA), assetManagerA);
    assert.equal(detail.body.currentTenure?.id, propietadTenureId);
    assert.equal(detail.body.asset.currentTenureKind, "propiedad", "caché actualizada al activar");

    const twice = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${propietadTenureId}`, assetManagerA, { action: "activar" });
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
    assert.equal(codeOf(twice), "TENURE_INVALID_TRANSITION", "vigente → vigente no está en la máquina");

    const gestion = await call(app, "POST", `${base(tenantA.propertyA)}/tenures`, assetManagerA, { kind: "gestion", counterpartyName: "Operadora hotelera de prueba SL", startDate: "2026-01-01", endDate: "2031-12-31", noticeMonths: 6, brandName: "Marca de prueba", rentKind: "variable", rentVariablePct: "8.50", rentVariableBase: "gop", ffeReservePct: "4.00" });
    assert.equal(gestion.status, 201, JSON.stringify(gestion.body));
    gestionTenureId = gestion.body.id;
    assert.equal(gestion.body.status, "borrador");
    assert.equal(gestion.body.rentVariablePct, "8.50");

    const conflict = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${gestionTenureId}`, assetManagerA, { action: "activar" });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(codeOf(conflict), "TENURE_ALREADY_ACTIVE");
    assert.equal(conflict.body.details.activeTenureId, propietadTenureId);
    assert.equal((await prisma.realEstateTenure.findUnique({ where: { id: gestionTenureId }, select: { status: true } }))?.status, "borrador", "sin cambio");

    const resolved = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${propietadTenureId}`, assetManagerA, { action: "resolver" });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.status, "resuelto");
    detail = await call(app, "GET", base(tenantA.propertyA), assetManagerA);
    assert.equal(detail.body.currentTenure, null);
    assert.equal(detail.body.asset.currentTenureKind, null, "caché vaciada al resolver");

    const frozen = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${propietadTenureId}`, assetManagerA, { notes: "cambio tardío" });
    assert.equal(frozen.status, 409, JSON.stringify(frozen.body));
    assert.equal(codeOf(frozen), "TENURE_INVALID_TRANSITION");

    const activatedGestion = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${gestionTenureId}`, assetManagerA, { action: "activar", noticeMonths: 9 });
    assert.equal(activatedGestion.status, 200, JSON.stringify(activatedGestion.body));
    assert.equal(activatedGestion.body.status, "vigente");
    assert.equal(activatedGestion.body.noticeMonths, 9, "campos y acción en la misma petición");
    detail = await call(app, "GET", base(tenantA.propertyA), assetManagerA);
    assert.equal(detail.body.currentTenure?.id, gestionTenureId);
    assert.equal(detail.body.asset.currentTenureKind, "gestion");
    assert.equal(detail.body.kpis.openAlerts, detail.body.alerts.length);

    const badWindow = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${gestionTenureId}`, assetManagerA, { endDate: "2025-12-31" });
    assert.equal(badWindow.status, 400, "endDate anterior a la startDate vigente");

    // Un contrato vigente vencido se muestra `vencido` (derivado) sin persistirlo y genera alerta alta.
    await prisma.realEstateTenure.update({ where: { id: gestionTenureId }, data: { endDate: new Date("2026-01-31T00:00:00.000Z") } });
    detail = await call(app, "GET", base(tenantA.propertyA), assetManagerA);
    assert.equal(detail.body.currentTenure?.status, "vencido");
    assert.equal((await prisma.realEstateTenure.findUnique({ where: { id: gestionTenureId }, select: { status: true } }))?.status, "vigente", "el estado persistido no cambia");
    assert.ok(detail.body.alerts.some((a: Json) => a.kind === "TENURE_NOTICE" && a.severity === "alta" && a.entityId === gestionTenureId), JSON.stringify(detail.body.alerts));
    assert.equal(detail.body.kpis.openAlerts, detail.body.alerts.length);
    assert.deepEqual(detail.body.taxes, [], "sin tributos: la ficha lista []");
    assert.equal(detail.body.kpis.annualTaxBurden, null);
    // ACT-REV-14: una vigente vencida (derivada) es historia: sus campos no se editan.
    const late = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${gestionTenureId}`, assetManagerA, { notes: "cambio sobre un contrato vencido" });
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(codeOf(late), "TENURE_INVALID_TRANSITION");
    assert.equal(late.body.details.from, "vencido");
    assert.match(late.body.message, /vencida/);
    assert.equal((await prisma.realEstateTenure.findUnique({ where: { id: gestionTenureId }, select: { notes: true } }))?.notes, null, "nada escrito");

    const unknown = await call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/ret_no_existe`, assetManagerA, { action: "activar" });
    assert.equal(unknown.status, 404);
  });
});

describe("ACT-L1 · RBAC y tenencia entre centros", () => {
  it("receptionist 403 en GET y POST", async () => {
    const read = await call(app, "GET", base(tenantA.propertyA), receptionistA);
    assert.equal(read.status, 403, JSON.stringify(read.body));
    const write = await call(app, "POST", `${base(tenantA.propertyA)}/valuations`, receptionistA, { kind: "interna", valuedAt: "2026-01-01", value: "1.00" });
    assert.equal(write.status, 403, JSON.stringify(write.body));
    const tenures = await call(app, "GET", `${base(tenantA.propertyA)}/tenures`, receptionistA);
    assert.equal(tenures.status, 403);
  });

  it("accountant lee (real_estate.read) y no escribe (403)", async () => {
    const read = await call(app, "GET", base(tenantA.propertyA), accountantA);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.asset.id, assetId);
    const valuations = await call(app, "GET", `${base(tenantA.propertyA)}/valuations`, accountantA);
    assert.equal(valuations.status, 200);
    assert.equal(valuations.body.length, 2);
    for (const attempt of [
      call(app, "PATCH", base(tenantA.propertyA), accountantA, { notes: "x" }),
      call(app, "POST", `${base(tenantA.propertyA)}/units`, accountantA, { kind: "local" }),
      call(app, "POST", `${base(tenantA.propertyA)}/units/${localUnitId}/charges`, accountantA, { kind: "embargo" }),
      call(app, "PATCH", `${base(tenantA.propertyA)}/charges/${chargeId}`, accountantA, { note: "x" }),
      call(app, "POST", `${base(tenantA.propertyA)}/valuations`, accountantA, { kind: "interna", valuedAt: "2026-01-01", value: "1.00" }),
      call(app, "POST", `${base(tenantA.propertyA)}/tenures`, accountantA, { kind: "gestion", startDate: "2026-01-01" }),
      call(app, "PATCH", `${base(tenantA.propertyA)}/tenures/${gestionTenureId}`, accountantA, { action: "resolver" })
    ]) {
      const reply = await attempt;
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
    }
    assert.equal((await prisma.realEstateCharge.count({ where: { unit: { assetId } } })), 1, "nada escrito");
  });

  it("centro ajeno 404 opaco", async () => {
    // owner de la organización B (tiene real_estate.read) sobre el centro A: la guardia global de tenencia.
    const foreign = await call(app, "GET", base(tenantA.propertyA), ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(foreign.body.message, "Propiedad no encontrada.");
    assert.equal(codeOf(foreign), undefined, "sin código: opaco");
    // asset_manager de A sobre el hotel B de su propia sociedad: existe el centro pero no la ficha.
    const noAsset = await call(app, "GET", base(tenantA.propertyB), assetManagerA);
    assert.equal(noAsset.status, 404);
    assert.equal(codeOf(noAsset), "ASSET_NOT_FOUND");
    // Ids del centro A usados bajo el centro B: 404 opaco (nunca se resuelven fuera del activo del centro).
    const crossUnit = await call(app, "PATCH", `${base(tenantA.propertyB)}/units/${localUnitId}`, assetManagerA, { notary: "x" });
    assert.equal(crossUnit.status, 404, JSON.stringify(crossUnit.body));
    const crossTenure = await call(app, "PATCH", `${base(tenantA.propertyB)}/tenures/${gestionTenureId}`, assetManagerA, { action: "resolver" });
    assert.equal(crossTenure.status, 404, JSON.stringify(crossTenure.body));
    assert.equal((await prisma.realEstateUnit.findUnique({ where: { id: localUnitId }, select: { notary: true } }))?.notary, null, "nada escrito");
  });

  it("auditoría: toda escritura deja su evento real_estate_* con el actor", async () => {
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, entityType: { startsWith: "real_estate_" } }, select: { action: true, entityType: true, entityId: true, actorUserId: true } });
    const actions = new Set(events.map((e) => e.action));
    for (const expected of ["REAL_ESTATE_ASSET_CREATED", "REAL_ESTATE_ASSET_UPDATED", "REAL_ESTATE_UNIT_CREATED", "REAL_ESTATE_UNIT_UPDATED", "REAL_ESTATE_CHARGE_CREATED", "REAL_ESTATE_CHARGE_UPDATED", "REAL_ESTATE_VALUATION_CREATED", "REAL_ESTATE_TENURE_CREATED", "REAL_ESTATE_TENURE_ACTIVATED", "REAL_ESTATE_TENURE_RESOLVED", "REAL_ESTATE_TENURE_UPDATED"]) {
      assert.ok(actions.has(expected), `falta ${expected} en ${[...actions].join(", ")}`);
    }
    assert.ok(events.every((e) => e.actorUserId === assetManagerA.userId), "todas las escrituras las hizo el asset_manager");
    assert.ok(events.some((e) => e.entityType === "real_estate_asset" && e.entityId === assetId));
  });
});
