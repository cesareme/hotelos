/**
 * Tanda ACT · lote L6 · integración (Postgres): vista de grupo, calendario
 * anual y exportación CSV sobre un tenant AISLADO (helpers/l2-tenant.mts,
 * organización `org_l2_act6…` con dos centros prop_l2_a/b) más un
 * `asset_manager` asignado a la SOCIEDAD (scopeType legal_entity) que crea los
 * activos por API, un `manager` asignado SOLO en A (tenant.roles.manager,
 * scopeType property) y un `accountant` asignado SOLO en A (ve los dos por
 * accounting.entity.read); auth real y RBAC_STRICT; Faranda y org_123 solo se
 * leen (invariantes antes y después). Las 4 rutas van cableadas en
 * real-estate.register.ts (registerRealEstateGroupRoutes) y la suite lo exige con
 * aserción dura (ACT-REV-02: sin cableado de reserva; igual para documentos L3).
 *
 * Casos: owner ve 2 filas y los totales cuadran con las filas · manager
 * asignado en A ve 1 fila · accountant (accounting.entity.read) ve 2 · export
 * CSV devuelve text/csv con BOM y 3 líneas (cabecera + 2) · calendar del año
 * lista periodos voluntarios e inspecciones · receptionist 403 · centro sin
 * ficha 404 ASSET_NOT_FOUND · organización ajena 404 · consulta inválida 400.
 *
 * Sin nombres de personas: contrapartes y aseguradoras son sociedades ficticias.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/real-estate-group.test.mts
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
const { addDays, addMonths, toIsoDay } = await import("../../apps/api/src/modules/real-estate/vigencias.js");
const { voluntaryPeriodFor } = await import("../../apps/api/src/modules/real-estate/tax-calendar.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json };
type RawReply = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

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

async function callRaw(app: ApiApp, url: string, session: Session): Promise<RawReply> {
  const res = await strict(() => app.inject({ method: "GET", url, headers: { ...session.headers } }));
  return { status: res.statusCode, headers: res.headers as RawReply["headers"], text: res.body };
}

const codeOf = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
const csvLines = (text: string) => text.replace(/^\uFEFF/, "").split("\r\n").filter((line) => line.length > 0);
const eventsOf = (calendar: Json): Json[] => (calendar.months as Json[]).flatMap((month) => month.events as Json[]);

/** Usuario extra con una plantilla asignada a la sociedad (legal_entity) o a UN centro (property); barrido por cleanupTenant. */
async function addUser(tenant: IsolatedTenant, key: string, templateKey: string, scope: { scopeType: "legal_entity" } | { scopeType: "property"; propertyId: string }): Promise<{ id: string; email: string }> {
  const id = `usr_act6_${key}_${tenant.run}`;
  const email = `${key}.act6.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `ACT6 ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: {
      userId: id,
      roleId,
      organizationId: tenant.organizationId,
      reason: `act6 ${key}`,
      ...(scope.scopeType === "legal_entity" ? { scopeType: "legal_entity", legalEntityId: tenant.legalEntityId } : { scopeType: "property", propertyId: scope.propertyId })
    }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

const RUN = `act6${newRunId()}`;
const TODAY = toIsoDay(new Date());
const day = (n: number) => addDays(TODAY, n);
/** Todas las fechas de prueba caen en el mismo ejercicio que FUTURE (robusto en diciembre). */
const FUTURE = day(60);
const YEAR = Number(FUTURE.slice(0, 4));
const TENURE_END = addMonths(FUTURE, 6);

let app: ApiApp;
let tenant: IsolatedTenant;
let assetManager: Session;
let owner: Session;
let managerA: Session;
let accountantA: Session;
let receptionist: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;
let wiredByServer = true;

const org = () => `/organizations/${tenant.organizationId}/real-estate`;
const base = (propertyId: string) => `/properties/${propertyId}/real-estate`;

let ibiTaxId: string;
let iaeTaxId: string;
let inspectionId: string;
let documentId: string;
let insuranceId: string;
let tenureBId: string;

before(async () => {
  app = await buildApiServer();
  // ACT-REV-02: aserciones duras, sin cableado de reserva (la suite prueba la composición real de server.ts).
  wiredByServer = app.hasRoute({ method: "GET", url: "/organizations/:organizationId/real-estate/overview" });
  assert.ok(wiredByServer, "falta registerRealEstateGroupRoutes(app) en real-estate.register.ts");
  assert.ok(app.hasRoute({ method: "POST", url: "/properties/:propertyId/real-estate/documents" }), "falta registerRealEstateDocumentRoutes(app) en real-estate.register.ts");
  await app.ready();
  for (const path of ["/organizations/:organizationId/real-estate/overview", "/organizations/:organizationId/real-estate/calendar", "/organizations/:organizationId/real-estate/export", "/properties/:propertyId/real-estate/calendar"]) {
    assert.ok(routePermissionManifest.some((entry) => entry.path === path && entry.method === "GET" && entry.permissions.includes("real_estate.read")), `manifiesto: GET ${path} con real_estate.read`);
  }
  baseline = await farandaInvariants();
  tenant = await createIsolatedTenant(RUN);
  const am = await addUser(tenant, "activos", "asset_manager", { scopeType: "legal_entity" });
  const mgr = await addUser(tenant, "direccion", "manager", { scopeType: "property", propertyId: tenant.propertyA });
  const acc = await addUser(tenant, "finanzas", "accountant", { scopeType: "property", propertyId: tenant.propertyA });
  assetManager = await strict(() => loginOrThrow(app, am.email, tenant.password));
  managerA = await strict(() => loginOrThrow(app, mgr.email, tenant.password));
  accountantA = await strict(() => loginOrThrow(app, acc.email, tenant.password));
  owner = await strict(() => loginOrThrow(app, tenant.users.owner.email, tenant.password));
  receptionist = await strict(() => loginOrThrow(app, tenant.users.receptionist.email, tenant.password));

  // ── Centro A: ficha, tenencia propiedad vigente, tasación, IBI (sociedad) + IAE (arrendatario), inspección y documento con vigencia ──
  const assetA = await call(app, "POST", base(tenant.propertyA), assetManager, { name: "Hotel de prueba ACT L6 Norte", roomsCount: 120, yearBuilt: 1998, cadastralValueTotal: "3250000.00", cadastralValueYear: 2025 });
  assert.equal(assetA.status, 201, JSON.stringify(assetA.body));
  const tenuresA = await call(app, "GET", `${base(tenant.propertyA)}/tenures`, assetManager);
  assert.equal(tenuresA.status, 200);
  const draft = (tenuresA.body as Json[]).find((row) => row.kind === "propiedad" && row.status === "borrador");
  assert.ok(draft, "la tenencia propiedad del alta nace en borrador");
  const activated = await call(app, "PATCH", `${base(tenant.propertyA)}/tenures/${draft!.id}`, assetManager, { action: "activar" });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const valuation = await call(app, "POST", `${base(tenant.propertyA)}/valuations`, assetManager, { kind: "eco_805", purpose: "contable", valuedAt: day(-10), value: "5100000.00", appraiser: "Sociedad de tasación de prueba SA" });
  assert.equal(valuation.status, 201, JSON.stringify(valuation.body));
  const ibi = await call(app, "POST", `${base(tenant.propertyA)}/taxes`, assetManager, { kind: "ibi", authorityName: "Ayuntamiento de prueba", fiscalReference: "IBI-ACT6", taxBase: "3250000.00", ratePct: "0.4525", expectedAnnualAmount: "12000.00" });
  assert.equal(ibi.status, 201, JSON.stringify(ibi.body));
  ibiTaxId = ibi.body.id;
  const iae = await call(app, "POST", `${base(tenant.propertyA)}/taxes`, assetManager, { kind: "iae", taxpayer: "arrendatario", authorityName: "Ayuntamiento de prueba", expectedAnnualAmount: "1500.00" });
  assert.equal(iae.status, 201, JSON.stringify(iae.body));
  iaeTaxId = iae.body.id;
  const inspection = await call(app, "POST", `${base(tenant.propertyA)}/inspections`, assetManager, { kind: "oca_ascensor", installationRef: "RAE-ACT6", scheduledAt: FUTURE, providerName: "Organismo de control de prueba SA" });
  assert.equal(inspection.status, 201, JSON.stringify(inspection.body));
  inspectionId = inspection.body.id;
  const document = await call(app, "POST", `${base(tenant.propertyA)}/documents`, assetManager, { category: "licencias", kind: "licencia_actividad", title: "Licencia de actividad ACT6", validUntil: FUTURE });
  assert.equal(document.status, 201, JSON.stringify(document.body));
  documentId = document.body.id;

  // ── Centro B: ficha, tenencia de gestión vigente con preaviso y revisión de renta, póliza ──
  const assetB = await call(app, "POST", base(tenant.propertyB), assetManager, { name: "Hotel de prueba ACT L6 Sur", roomsCount: 80, cadastralValueTotal: "1800000.00", cadastralValueYear: 2025 });
  assert.equal(assetB.status, 201, JSON.stringify(assetB.body));
  const gestion = await call(app, "POST", `${base(tenant.propertyB)}/tenures`, assetManager, { kind: "gestion", counterpartyName: "Operadora hotelera de prueba SL", startDate: `${YEAR - 1}-01-01`, endDate: TENURE_END, noticeMonths: 6, rentKind: "variable", rentVariablePct: "8.50", rentVariableBase: "gop", rentReviewIndex: "ipc", rentReviewMonth: Number(FUTURE.slice(5, 7)) });
  assert.equal(gestion.status, 201, JSON.stringify(gestion.body));
  tenureBId = gestion.body.id;
  const activatedB = await call(app, "PATCH", `${base(tenant.propertyB)}/tenures/${tenureBId}`, assetManager, { action: "activar" });
  assert.equal(activatedB.status, 200, JSON.stringify(activatedB.body));
  const insurance = await call(app, "POST", `${base(tenant.propertyB)}/insurances`, assetManager, { kind: "rc", insurerName: "Aseguradora de prueba SA", policyNumber: `RC-${RUN}`, validFrom: day(-305), validUntil: FUTURE, premiumAnnual: "4200.00" });
  assert.equal(insurance.status, 201, JSON.stringify(insurance.body));
  insuranceId = insurance.body.id;
});

after(async () => {
  try {
    await flushAuditQueues();
    if (tenant) await cleanupTenant(tenant.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: tenant?.organizationId ?? "" } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
  }
});

describe("ACT-L6 · vista de grupo", () => {
  it("las rutas están cableadas en real-estate.register.ts", () => {
    assert.equal(wiredByServer, true, "registerRealEstateGroupRoutes(app) en real-estate.register.ts");
  });

  it("owner ve 2 filas y los totales cuadran con las filas", async () => {
    const reply = await call(app, "GET", `${org()}/overview`, owner);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const rows = reply.body.rows as Json[];
    assert.deepEqual(rows.map((row) => row.propertyId), [tenant.propertyA, tenant.propertyB], "los dos centros en orden de alta");
    const [a, b] = rows;
    assert.equal(a.propertyCode, "L2A");
    assert.equal(a.tenureKind, "propiedad");
    assert.equal(a.cadastralValueTotal, "3250000.00");
    assert.equal(a.lastValuationValue, "5100000.00");
    assert.equal(a.annualTaxBurden, "12000.00", "solo el IBI (sociedad); el IAE del arrendatario no carga a la sociedad");
    assert.equal(a.documentsValidPct, "100.00", "la licencia vence en 60 días (> 30): vigente");
    assert.equal(a.inspectionsOnTimePct, "100.00", "la OCA programada a 60 días está en plazo");
    assert.equal(b.tenureKind, "gestion");
    assert.equal(b.cadastralValueTotal, "1800000.00");
    assert.equal(b.lastValuationValue, null);
    assert.equal(b.annualTaxBurden, null);
    assert.equal(b.documentsValidPct, null);
    assert.equal(b.inspectionsOnTimePct, null);
    for (const row of rows) {
      assert.equal(typeof row.openAlerts, "number");
      assert.ok(row.openAlertsHigh <= row.openAlerts);
    }
    const totals = reply.body.totals as Json;
    assert.equal(totals.properties, 2);
    assert.equal(totals.cadastralValueTotal, "5050000.00");
    assert.equal(totals.lastValuationValue, "5100000.00");
    assert.equal(totals.annualTaxBurden, "12000.00");
    assert.equal(totals.openAlerts, a.openAlerts + b.openAlerts);
    assert.equal(totals.openAlertsHigh, a.openAlertsHigh + b.openAlertsHigh);
    const alerts = reply.body.alerts as Json[];
    assert.ok(alerts.every((alert) => alert.severity === "alta"), "solo las alertas altas del grupo");
    assert.equal(alerts.length, totals.openAlertsHigh);
    for (const alert of alerts) assert.ok([tenant.propertyA, tenant.propertyB].includes(alert.propertyId));
  });

  it("la ficha del centro usa el mismo motor de alertas y las mismas definiciones de KPI que su fila de grupo (ACT-REV-06)", async () => {
    const overview = await call(app, "GET", `${org()}/overview`, owner);
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    const rowA = (overview.body.rows as Json[]).find((row) => row.propertyId === tenant.propertyA) as Json;
    const detail = await call(app, "GET", base(tenant.propertyA), owner);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.kpis.annualTaxBurden, rowA.annualTaxBurden);
    assert.equal(detail.body.kpis.documentsValidPct, rowA.documentsValidPct);
    assert.equal(detail.body.kpis.inspectionsOnTimePct, rowA.inspectionsOnTimePct);
    assert.equal(detail.body.kpis.openAlerts, rowA.openAlerts);
    assert.equal(detail.body.alerts.length, rowA.openAlerts);
    assert.ok(rowA.openAlerts > 0, "el centro A tiene alertas más allá de la tenencia");
    const engine = await call(app, "GET", `${base(tenant.propertyA)}/alerts`, owner);
    assert.equal(engine.status, 200);
    assert.deepEqual(detail.body.alerts, engine.body, "misma salida que GET …/alerts");
    const taxes = detail.body.taxes as Json[];
    assert.ok(taxes.some((tax) => tax.kind === "ibi" && tax.taxpayer === "sociedad"), "la ficha lista los tributos");
    assert.equal(taxes.length, 2, "IBI y IAE del centro A");
  });

  it("manager asignado en A ve 1 fila", async () => {
    const reply = await call(app, "GET", `${org()}/overview`, managerA);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual((reply.body.rows as Json[]).map((row) => row.propertyId), [tenant.propertyA]);
    assert.equal(reply.body.totals.properties, 1);
    assert.equal(reply.body.totals.cadastralValueTotal, "3250000.00");
    assert.ok((reply.body.alerts as Json[]).every((alert) => alert.propertyId === tenant.propertyA), "sin alertas del centro B");
  });

  it("accountant (accounting.entity.read) ve 2", async () => {
    const reply = await call(app, "GET", `${org()}/overview`, accountantA);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual((reply.body.rows as Json[]).map((row) => row.propertyId), [tenant.propertyA, tenant.propertyB], "asignado solo en A, pero con ámbito de sociedad");
    assert.equal(reply.body.totals.properties, 2);
  });

  it("receptionist 403", async () => {
    for (const url of [`${org()}/overview`, `${org()}/calendar?year=${YEAR}`, `${org()}/export?format=csv&what=overview`, `${base(tenant.propertyA)}/calendar?year=${YEAR}`]) {
      const reply = await call(app, "GET", url, receptionist);
      assert.equal(reply.status, 403, `${url} → ${reply.status} ${JSON.stringify(reply.body)}`);
    }
  });

  it("organización ajena → 404 opaco", async () => {
    const reply = await call(app, "GET", "/organizations/org_act6_no_existe/real-estate/overview", owner);
    assert.equal(reply.status, 404, JSON.stringify(reply.body));
  });
});

describe("ACT-L6 · calendario anual", () => {
  it("calendar del año lista periodos voluntarios e inspecciones", async () => {
    const reply = await call(app, "GET", `${org()}/calendar?year=${YEAR}`, owner);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.year, YEAR);
    assert.deepEqual((reply.body.properties as Json[]).map((row) => row.propertyId), [tenant.propertyA, tenant.propertyB]);
    const months = reply.body.months as Json[];
    assert.equal(months.length, 12);
    assert.deepEqual(months.map((month) => month.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const events = eventsOf(reply.body);
    assert.equal(reply.body.totalEvents, events.length);
    // Orden cronológico dentro del año.
    for (let index = 1; index < events.length; index += 1) assert.ok(events[index - 1].dueAt <= events[index].dueAt, `orden en ${events[index - 1].dueAt} ≤ ${events[index].dueAt}`);
    assert.ok(events.every((event) => event.dueAt.startsWith(String(YEAR))), "solo eventos del año pedido");
    // Periodos voluntarios previstos (sin recibo generado) del IBI y del IAE, supletorio LGT 62.3 (el tenant no tiene INE).
    const period = voluntaryPeriodFor(null, "ibi", YEAR);
    const ibiEvents = events.filter((event) => event.entityId === ibiTaxId);
    // ACT-REV-13: sin recibo el evento enlaza al tributo (entityType property_tax, entityId = PropertyTax.id); importe formateado (ACT-REV-15).
    assert.deepEqual(ibiEvents.map((event) => [event.kind, event.dueAt, event.entityType, event.propertyId]), [["TAX_DUE", period.from, "property_tax", tenant.propertyA], ["TAX_DUE", period.to, "property_tax", tenant.propertyA]]);
    assert.match(ibiEvents[0].label, /^Inicio del periodo voluntario previsto · IBI \d{4} \(sin recibo\)$/);
    assert.match(ibiEvents[1].label, /^Fin del periodo voluntario previsto · IBI \d{4} · 12\.000,00 € \(sin recibo\)$/);
    assert.equal(events.filter((event) => event.entityId === iaeTaxId).length, 2, "el IAE (arrendatario) también entra en el calendario");
    // Inspección programada, documento, póliza, preaviso y revisión de renta.
    const inspection = events.find((event) => event.entityId === inspectionId);
    assert.ok(inspection, "inspección en el calendario");
    assert.equal(inspection!.kind, "INSPECTION_DUE");
    assert.equal(inspection!.dueAt, FUTURE);
    assert.equal(inspection!.entityType, "real_estate_inspection");
    assert.match(inspection!.label, /^OCA del ascensor \(RAE-ACT6\) · próxima inspección el /);
    const document = events.find((event) => event.entityId === documentId);
    assert.deepEqual({ kind: document?.kind, dueAt: document?.dueAt, entityType: document?.entityType }, { kind: "DOCUMENT_EXPIRING", dueAt: FUTURE, entityType: "real_estate_document" });
    const insurance = events.find((event) => event.entityId === insuranceId);
    assert.deepEqual({ kind: insurance?.kind, dueAt: insurance?.dueAt, propertyId: insurance?.propertyId }, { kind: "INSURANCE_EXPIRING", dueAt: FUTURE, propertyId: tenant.propertyB });
    const tenureEvents = events.filter((event) => event.entityId === tenureBId);
    const notice = tenureEvents.find((event) => event.kind === "TENURE_NOTICE");
    assert.ok(notice, "preaviso de la tenencia de gestión");
    assert.equal(notice!.dueAt, FUTURE, "endDate − 6 meses");
    assert.match(notice!.label, /^Contrato de gestión · fin del preaviso \(6 meses\) el /);
    assert.doesNotMatch(notice!.label, /Operadora/, "sin contraparte en la etiqueta");
    const review = tenureEvents.find((event) => event.kind === "RENT_REVIEW");
    assert.equal(review?.dueAt, `${YEAR}-${FUTURE.slice(5, 7)}-01`);
    // Mes de la inspección: el evento está en su cubo.
    const bucket = months[Number(FUTURE.slice(5, 7)) - 1];
    assert.ok((bucket.events as Json[]).some((event) => event.entityId === inspectionId));
  });

  it("año por defecto = el actual; year inválido → 400", async () => {
    const reply = await call(app, "GET", `${org()}/calendar`, owner);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.year, Number(TODAY.slice(0, 4)));
    const bad = await call(app, "GET", `${org()}/calendar?year=26`, owner);
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
  });

  it("manager asignado en A solo ve los eventos de A; el calendario por centro coincide con su parte", async () => {
    const group = await call(app, "GET", `${org()}/calendar?year=${YEAR}`, managerA);
    assert.equal(group.status, 200);
    assert.deepEqual((group.body.properties as Json[]).map((row) => row.propertyId), [tenant.propertyA]);
    const groupEvents = eventsOf(group.body);
    assert.ok(groupEvents.length > 0);
    assert.ok(groupEvents.every((event) => event.propertyId === tenant.propertyA));
    const centre = await call(app, "GET", `${base(tenant.propertyA)}/calendar?year=${YEAR}`, managerA);
    assert.equal(centre.status, 200, JSON.stringify(centre.body));
    assert.deepEqual(eventsOf(centre.body), groupEvents);
    assert.equal(centre.body.properties[0].propertyCode, "L2A");
    const centreB = await call(app, "GET", `${base(tenant.propertyB)}/calendar?year=${YEAR}`, managerA);
    assert.equal(centreB.status, 404, "centro ajeno: 404 opaco de la guardia de tenencia");
  });

  it("centro sin ficha → 404 ASSET_NOT_FOUND", async () => {
    const other = await createIsolatedTenant(`${RUN}b`);
    try {
      const ownerB = await strict(() => loginOrThrow(app, other.users.owner.email, other.password));
      const reply = await call(app, "GET", `${base(other.propertyA)}/calendar?year=${YEAR}`, ownerB);
      assert.equal(reply.status, 404, JSON.stringify(reply.body));
      assert.equal(codeOf(reply), "ASSET_NOT_FOUND");
      const group = await call(app, "GET", `/organizations/${other.organizationId}/real-estate/overview`, ownerB);
      assert.equal(group.status, 200);
      assert.equal((group.body.rows as Json[]).length, 2, "los hoteles sin ficha aparecen con la fila vacía");
      assert.ok((group.body.rows as Json[]).every((row) => row.tenureKind === null && row.cadastralValueTotal === null && row.openAlerts === 0));
      assert.equal(group.body.totals.cadastralValueTotal, "0.00");
    } finally {
      await flushAuditQueues();
      await cleanupTenant(other.organizationId);
    }
  });
});

describe("ACT-L6 · exportación CSV", () => {
  it("export CSV devuelve text/csv con BOM y 3 líneas (cabecera + 2)", async () => {
    const reply = await callRaw(app, `${org()}/export?format=csv&what=overview&year=${YEAR}`, owner);
    assert.equal(reply.status, 200, reply.text.slice(0, 200));
    assert.match(String(reply.headers["content-type"]), /^text\/csv; charset=utf-8/);
    assert.match(String(reply.headers["content-disposition"]), new RegExp(`^attachment; filename="activo-inmobiliario-overview-${YEAR}\\.csv"`));
    assert.equal(reply.text.charCodeAt(0), 0xfeff, "BOM UTF-8");
    const lines = csvLines(reply.text);
    assert.equal(lines.length, 3, "cabecera + 2 centros");
    assert.equal(lines[0], "Centro;Código;Tenencia;Valor catastral;Última tasación;Carga fiscal anual;Documentos vigentes (%);Inspecciones en plazo (%);Alertas altas;Alertas abiertas");
    assert.match(lines[1], /^Hotel L2 Norte [^;]+;L2A;Propiedad;3250000,00;5100000,00;12000,00;100,00;100,00;\d+;\d+$/);
    assert.match(lines[2], /^Hotel L2 Sur [^;]+;L2B;Contrato de gestión;1800000,00;;;;;\d+;\d+$/);
    assert.ok(!/Total/.test(reply.text), "sin línea de totales");
  });

  it("el manager asignado en A exporta 2 líneas (cabecera + su centro); sin year el fichero lleva el año actual", async () => {
    const reply = await callRaw(app, `${org()}/export?what=overview`, managerA);
    assert.equal(reply.status, 200, reply.text.slice(0, 200));
    assert.equal(csvLines(reply.text).length, 2);
    assert.match(String(reply.headers["content-disposition"]), new RegExp(`activo-inmobiliario-overview-${TODAY.slice(0, 4)}\\.csv`));
  });

  it("what=calendar exporta una línea por evento del año con el centro y la clave", async () => {
    const calendar = await call(app, "GET", `${org()}/calendar?year=${YEAR}`, owner);
    const reply = await callRaw(app, `${org()}/export?format=csv&what=calendar&year=${YEAR}`, owner);
    assert.equal(reply.status, 200, reply.text.slice(0, 200));
    assert.match(String(reply.headers["content-disposition"]), new RegExp(`activo-inmobiliario-calendar-${YEAR}\\.csv`));
    const lines = csvLines(reply.text);
    assert.equal(lines[0], "Mes;Fecha;Centro;Código;Tipo;Clave;Descripción;Entidad;Id");
    assert.equal(lines.length, 1 + calendar.body.totalEvents);
    assert.ok(lines.slice(1).some((line) => line.includes(`;L2A;Inspección obligatoria;INSPECTION_DUE;`) && line.endsWith(`;real_estate_inspection;${inspectionId}`)));
    assert.ok(lines.slice(1).some((line) => line.includes(`;L2B;Vencimiento de póliza;INSURANCE_EXPIRING;`)));
  });

  it("consulta inválida → 400 (what desconocido, formato no csv, sin what)", async () => {
    for (const query of ["?format=csv&what=foo", "?format=xlsx&what=overview", "?format=csv"]) {
      const reply = await call(app, "GET", `${org()}/export${query}`, owner);
      assert.equal(reply.status, 400, `${query} → ${reply.status} ${JSON.stringify(reply.body)}`);
    }
  });
});
