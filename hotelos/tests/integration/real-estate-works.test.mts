/**
 * Tanda ACT · lote L4 · integración (Postgres): obras (CapexProject ampliado),
 * licencia de obras, ejecución por asientos 21x reales del centro y
 * capitalización sin asiento, sobre un tenant AISLADO (helpers/l2-tenant.mts,
 * organización `org_l2_act…`) con un usuario `asset_manager` asignado a la
 * SOCIEDAD (scopeType legal_entity; capex.create + assets.manage +
 * real_estate.manage), el owner del tenant (asset.capex.approve) y el
 * receptionist; auth real y RBAC_STRICT. Faranda y org_123 solo se leen
 * (invariantes antes y después). El diario de Sage se simula insertando con
 * Prisma, en el tenant aislado, un JournalEntry posted/normal del centro con
 * una línea 211 al debe (12.000) y otra 572 al haber (sourceType manual).
 *
 * Casos: «PATCH work enlaza el activo y exige licencia: in_progress sin
 * licenceDocumentId 409 LICENCE_REQUIRED» · «con licencia pasa a in_progress y
 * GET works muestra executedAmountLedger 12.000 (executionSource ledger)» ·
 * «sin líneas 21x la ejecución es Σ actualCost (items)» · «capitalize antes de
 * completed 409 CAPEX_NOT_COMPLETED» · «capitalize crea FixedAsset 211 con
 * coste = ejecución + ICIO y segunda vez 409» · «receptionist 403».
 *
 * Sin nombres de personas.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/real-estate-works.test.mts
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

/**
 * proposed → approved por HTTP con la ruta propia POST /capex-projects/:id/approve
 * (asset.capex.approve; ACT-REV-05). El PATCH /capex-projects/:id heredado sigue
 * exigiendo capex.create en el manifiesto y asset.capex.approve en el servicio
 * (ninguna plantilla reúne ambas): se pina que sigue cerrado para el owner y para
 * quien lo propuso, y que el proponente tampoco aprueba por la ruta nueva.
 */
async function approveProject(app: ApiApp, projectId: string, owner: Session, proposer: Session): Promise<void> {
  const legacy = await call(app, "PATCH", `/capex-projects/${projectId}`, owner, { status: "approved" });
  assert.equal(legacy.status, 403, `owner sin capex.create en el manifiesto de PATCH /capex-projects/:id: ${JSON.stringify(legacy.body)}`);
  const byProposer = await call(app, "POST", `/capex-projects/${projectId}/approve`, proposer);
  assert.equal(byProposer.status, 403, `asset_manager sin asset.capex.approve: ${JSON.stringify(byProposer.body)}`);
  const approved = await call(app, "POST", `/capex-projects/${projectId}/approve`, owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.ownerApprovedBy, owner.userId);
  assert.equal((await prisma.capexProject.findUnique({ where: { id: projectId }, select: { status: true, ownerApprovedBy: true } }))?.ownerApprovedBy, owner.userId);
}

/** Asiento «de Sage» en el tenant aislado: posted · normal · del centro · 211 al debe / 572 al haber. */
async function insertLedgerEntry(tenant: IsolatedTenant, propertyId: string, amount: string, entryDate: string, accountCode = "211"): Promise<string> {
  const accounts = await prisma.account.findMany({ where: { organizationId: tenant.organizationId, code: { in: [accountCode, "572"] } }, select: { id: true, code: true } });
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  const assetAccountId = byCode.get(accountCode);
  const bankAccountId = byCode.get("572");
  assert.ok(assetAccountId && bankAccountId, `plan del tenant sin ${accountCode}/572`);
  const entry = await prisma.journalEntry.create({
    data: {
      organizationId: tenant.organizationId,
      propertyId,
      sourceType: "manual",
      status: "posted",
      postedAt: new Date(),
      entryKind: "normal",
      entryDate: new Date(`${entryDate}T00:00:00.000Z`),
      fiscalYearCode: entryDate.slice(0, 4),
      description: `Certificación de obra ${amount}`
    },
    select: { id: true }
  });
  // JournalLine no declara relación Prisma con JournalEntry (solo la columna journal_entry_id): las líneas van aparte.
  await prisma.journalLine.createMany({
    data: [
      { journalEntryId: entry.id, accountId: assetAccountId, accountCode, debit: amount, credit: "0", description: "Obra · certificación" },
      { journalEntryId: entry.id, accountId: bankAccountId, accountCode: "572", debit: "0", credit: amount, description: "Pago certificación" }
    ]
  });
  return entry.id;
}

const RUN = `actw${newRunId()}`;
const TODAY = new Date().toISOString().slice(0, 10);

let app: ApiApp;
let tenant: IsolatedTenant;
let assetManager: Session;
let owner: Session;
let receptionist: Session;
let accountant: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

let assetId: string;
let licenceDocumentId: string;
/** Proyecto principal (reforma con licencia, ejecución del diario, capitalizado). */
let projectId: string;
/** Proyecto sin líneas 21x (prefijos 231: ejecución por partidas). */
let itemsProjectId: string;
/** Proyecto terminado sin ficha enlazada (CAPEX_NOT_LINKED). */
let unlinkedProjectId: string;

const worksUrl = (propertyId: string) => `/properties/${propertyId}/real-estate/works`;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  for (const [method, path] of [
    ["GET", "/properties/:propertyId/real-estate/works"],
    ["PATCH", "/capex-projects/:id/work"],
    ["POST", "/capex-projects/:id/capitalize"]
  ] as const) {
    assert.ok(routePermissionManifest.some((entry) => entry.path === path && entry.method === method), `${method} ${path} en el manifiesto (works-route-permissions.partial.ts)`);
  }
  baseline = await farandaInvariants();
  tenant = await createIsolatedTenant(RUN);
  const manager = await addEntityUser(tenant, "activos", "asset_manager");
  assetManager = await strict(() => loginOrThrow(app, manager.email, tenant.password));
  owner = await strict(() => loginOrThrow(app, tenant.users.owner.email, tenant.password));
  receptionist = await strict(() => loginOrThrow(app, tenant.users.receptionist.email, tenant.password));
  accountant = await strict(() => loginOrThrow(app, tenant.users.accountant.email, tenant.password));

  // Ficha del activo del hotel A (real_estate.manage) y licencia de obras como documento del activo (ACT-L3 publica la ruta; aquí fila directa).
  const created = await call(app, "POST", `/properties/${tenant.propertyA}/real-estate`, assetManager, { name: "Hotel de prueba ACT obras", roomsCount: 120, yearBuilt: 1998 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assetId = created.body.asset.id;
  const licence = await prisma.realEstateDocument.create({
    data: { organizationId: tenant.organizationId, propertyId: tenant.propertyA, assetId, category: "licencias", kind: "licencia_obras", title: "Licencia de obras · reforma plantas 3-6", issuerName: "Ayuntamiento de prueba", issueDate: new Date("2026-09-01T00:00:00.000Z"), storageKind: "inline" },
    select: { id: true }
  });
  licenceDocumentId = licence.id;
});

after(async () => {
  try {
    await flushAuditQueues();
    if (tenant) await cleanupTenant(tenant.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: tenant?.organizationId ?? "" } }), 0, "sin organización residual");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
  }
});

describe("ACT-L4 · obras: licencia y ejecución", () => {
  it("PATCH work enlaza el activo y exige licencia: in_progress sin licenceDocumentId 409 LICENCE_REQUIRED", async () => {
    const proposed = await call(app, "POST", "/capex-projects", assetManager, { propertyId: tenant.propertyA, name: "Reforma plantas 3-6", description: "Reforma integral de plantas 3-6.", budget: 15000, startDate: "2026-03-01", targetEndDate: "2026-12-31" });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.equal(proposed.body.status, "proposed");
    projectId = proposed.body.id;

    // Antes de aprobar no hay obra que iniciar (máquina CAPEX_WORK: proposed → approved | cancelled).
    const early = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { status: "in_progress" });
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.equal(codeOf(early), "CAPEX_NOT_COMPLETED", "código por defecto de la máquina CAPEX_WORK");
    assert.deepEqual(early.body.details.allowed, ["approved", "cancelled"]);

    await approveProject(app, projectId, owner, assetManager);

    // Enlace al activo + datos de obra en una petición; el paso a in_progress en la misma petición cae por la licencia y NO escribe nada (transacción).
    const blocked = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { realEstateAssetId: assetId, workKind: "reforma", licenceRequired: true, icioAmount: "480.00", executionAccountPrefixes: ["211", "212"], status: "in_progress" });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(codeOf(blocked), "LICENCE_REQUIRED");
    const untouched = await prisma.capexProject.findUnique({ where: { id: projectId }, select: { status: true, realEstateAssetId: true, workKind: true } });
    assert.deepEqual(untouched, { status: "approved", realEstateAssetId: null, workKind: null }, "nada escrito");

    const linked = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { realEstateAssetId: assetId, workKind: "reforma", licenceRequired: true, icioAmount: "480.00", executionAccountPrefixes: ["211", "212"] });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.realEstateAssetId, assetId);
    assert.equal(linked.body.workKind, "reforma");
    assert.equal(linked.body.licenceRequired, true);
    assert.equal(linked.body.icioAmount, "480.00");
    assert.equal(linked.body.executionAccountPrefixes, "211,212");
    assert.equal(linked.body.status, "approved");
    assert.equal(linked.body.executionSource, "items", "sin líneas 21x todavía");
    assert.equal(linked.body.executedAmount, "0.00");
    assert.equal(linked.body.executedAmountLedger, null);

    const stillBlocked = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { status: "in_progress" });
    assert.equal(stillBlocked.status, 409, JSON.stringify(stillBlocked.body));
    assert.equal(codeOf(stillBlocked), "LICENCE_REQUIRED");
    assert.equal(stillBlocked.body.details.capexProjectId, projectId);

    // La ficha de OTRO centro no se enlaza (404 opaco tipado) y un documento inexistente tampoco.
    const foreignAsset = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { realEstateAssetId: "rea_no_existe" });
    assert.equal(foreignAsset.status, 404, JSON.stringify(foreignAsset.body));
    assert.equal(codeOf(foreignAsset), "ASSET_NOT_FOUND");
    const missingDoc = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { licenceDocumentId: "red_no_existe" });
    assert.equal(missingDoc.status, 404, JSON.stringify(missingDoc.body));
    const badStatus = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { status: "approved" });
    assert.equal(badStatus.status, 400);
    assert.equal(codeOf(badStatus), "VALIDATION_ERROR");
    const empty = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, {});
    assert.equal(empty.status, 400);
  });

  it("con licencia pasa a in_progress y GET works muestra executedAmountLedger 12.000 (executionSource ledger)", async () => {
    const started = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { licenceDocumentId, licenceGrantedAt: "2026-09-01", status: "in_progress" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, "in_progress");
    assert.equal(started.body.licenceDocumentId, licenceDocumentId);
    assert.equal(started.body.licenceGrantedAt, "2026-09-01");

    // Asientos «de Sage» del centro: 211 debe 12.000 dentro de la ventana; uno de 216 (fuera de los prefijos 211,212) y uno de 211 en borrador no cuentan.
    await insertLedgerEntry(tenant, tenant.propertyA, "12000.00", "2026-06-15");
    await insertLedgerEntry(tenant, tenant.propertyA, "700.00", "2026-06-16", "216");
    await prisma.journalEntry.updateMany({ where: { id: await insertLedgerEntry(tenant, tenant.propertyA, "500.00", "2026-06-17") }, data: { status: "draft" } });

    const works = await call(app, "GET", worksUrl(tenant.propertyA), assetManager);
    assert.equal(works.status, 200, JSON.stringify(works.body));
    const project = works.body.projects.find((p: Json) => p.id === projectId);
    assert.ok(project, "el proyecto está en la lista del centro");
    assert.equal(project.executedAmountLedger, "12000.00");
    assert.equal(project.executionSource, "ledger");
    assert.equal(project.executedAmount, "12000.00");
    assert.equal(project.executedAmountItems, "0.00");
    assert.deepEqual(works.body.alerts, [], "con licencia registrada no hay CAPEX_LICENCE_MISSING");
    const cached = await prisma.capexProject.findUnique({ where: { id: projectId }, select: { executedAmountLedger: true } });
    assert.equal(cached?.executedAmountLedger?.toFixed(2), "12000.00", "caché executedAmountLedger en la fila");

    // Una obra en curso que exige licencia y la pierde genera la alerta alta.
    const unlicensed = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { licenceDocumentId: null });
    assert.equal(unlicensed.status, 200, JSON.stringify(unlicensed.body));
    const alerted = await call(app, "GET", worksUrl(tenant.propertyA), assetManager);
    assert.ok(alerted.body.alerts.some((a: Json) => a.kind === "CAPEX_LICENCE_MISSING" && a.severity === "alta" && a.entityId === projectId), JSON.stringify(alerted.body.alerts));
    const relicensed = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { licenceDocumentId });
    assert.equal(relicensed.status, 200);

    // Centro B: sin proyectos.
    const emptyWorks = await call(app, "GET", worksUrl(tenant.propertyB), assetManager);
    assert.equal(emptyWorks.status, 200);
    assert.deepEqual(emptyWorks.body, { projects: [], alerts: [] });
  });

  it("sin líneas 21x la ejecución es Σ actualCost (items)", async () => {
    const proposed = await call(app, "POST", "/capex-projects", assetManager, { propertyId: tenant.propertyA, name: "Sustitución de climatización", budget: 9000 });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    itemsProjectId = proposed.body.id;
    for (const item of [
      { description: "Enfriadora", estimatedCost: 6000, actualCost: 1500 },
      { description: "Conductos", estimatedCost: 3000, actualCost: 2500 }
    ]) {
      const created = await call(app, "POST", `/capex-projects/${itemsProjectId}/items`, assetManager, item);
      assert.equal(created.status, 200, JSON.stringify(created.body));
    }
    // Prefijos 231 (obra en curso): el centro no tiene líneas 231 → partidas.
    const patched = await call(app, "PATCH", `/capex-projects/${itemsProjectId}/work`, assetManager, { workKind: "eficiencia_energetica", executionAccountPrefixes: ["231"] });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.executionSource, "items");
    assert.equal(patched.body.executedAmountItems, "4000.00");
    assert.equal(patched.body.executedAmount, "4000.00");
    assert.equal(patched.body.executedAmountLedger, null);

    const works = await call(app, "GET", worksUrl(tenant.propertyA), assetManager);
    const project = works.body.projects.find((p: Json) => p.id === itemsProjectId);
    assert.equal(project.executionSource, "items");
    assert.equal(project.executedAmount, "4000.00");
    const main = works.body.projects.find((p: Json) => p.id === projectId);
    assert.equal(main.executionSource, "ledger", "cada proyecto lee sus propios prefijos");
  });
});

describe("ACT-L4 · capitalización", () => {
  it("capitalize antes de completed 409 CAPEX_NOT_COMPLETED", async () => {
    const early = await call(app, "POST", `/capex-projects/${projectId}/capitalize`, assetManager);
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.equal(codeOf(early), "CAPEX_NOT_COMPLETED");
    assert.equal(early.body.details.status, "in_progress");
    assert.equal(await prisma.fixedAsset.count({ where: { organizationId: tenant.organizationId } }), 0, "sin alta en el registro");
  });

  it("capitalize crea FixedAsset 211 con coste = ejecución + ICIO y segunda vez 409", async () => {
    const completed = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { status: "completed" });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.status, "completed");

    const capitalized = await call(app, "POST", `/capex-projects/${projectId}/capitalize`, assetManager);
    assert.equal(capitalized.status, 201, JSON.stringify(capitalized.body));
    assert.equal(capitalized.body.fixedAsset.accountCode, "211");
    assert.equal(capitalized.body.fixedAsset.category, "construcciones");
    assert.equal(capitalized.body.fixedAsset.acquisitionCost, "12480.00", "12.000 del diario + 480 de ICIO");
    assert.equal(capitalized.body.fixedAsset.name, "Reforma plantas 3-6");
    assert.equal(capitalized.body.fixedAsset.propertyId, tenant.propertyA);
    assert.equal(capitalized.body.project.capitalizedFixedAssetId, capitalized.body.fixedAsset.id);
    assert.equal(capitalized.body.project.capitalizedAt, TODAY);
    assert.equal(capitalized.body.fixedAsset.acquisitionDate, TODAY, "targetEndDate futuro: alta hoy (ACT-REV-12)");
    assert.equal(capitalized.body.project.executedAmount, "12000.00");

    const row = await prisma.fixedAsset.findUnique({ where: { id: capitalized.body.fixedAsset.id } });
    assert.equal(row?.organizationId, tenant.organizationId);
    assert.equal(row?.acquisitionCost.toFixed(2), "12480.00");
    assert.equal(row?.accountCode, "211");
    assert.equal(row?.depreciationAccountCode, "2811");
    assert.equal(row?.status, "active");
    // Sin asiento: capitalizar solo registra (los 21x ya están en el diario).
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: tenant.organizationId, sourceType: { not: "manual" } } }), 0, "capitalizar no asienta");

    const again = await call(app, "POST", `/capex-projects/${projectId}/capitalize`, assetManager);
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(codeOf(again), "CAPEX_ALREADY_CAPITALIZED");
    assert.equal(again.body.details.capitalizedFixedAssetId, capitalized.body.fixedAsset.id);
    assert.equal(await prisma.fixedAsset.count({ where: { organizationId: tenant.organizationId } }), 1);

    // Una obra terminada es final: ningún status más.
    const reopen = await call(app, "PATCH", `/capex-projects/${projectId}/work`, assetManager, { status: "in_progress" });
    assert.equal(reopen.status, 409);
    assert.equal(codeOf(reopen), "CAPEX_NOT_COMPLETED");
  });

  it("capitalize sin ficha enlazada 409 CAPEX_NOT_LINKED y eficiencia energética va a 212", async () => {
    const proposed = await call(app, "POST", "/capex-projects", assetManager, { propertyId: tenant.propertyA, name: "Pintura de fachada", budget: 2000 });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    unlinkedProjectId = proposed.body.id;
    await approveProject(app, unlinkedProjectId, owner, assetManager);
    const started = await call(app, "PATCH", `/capex-projects/${unlinkedProjectId}/work`, assetManager, { status: "in_progress" });
    assert.equal(started.status, 200, JSON.stringify(started.body), "sin licenceRequired no hace falta licencia");
    const completed = await call(app, "PATCH", `/capex-projects/${unlinkedProjectId}/work`, assetManager, { status: "completed" });
    assert.equal(completed.status, 200);
    const unlinked = await call(app, "POST", `/capex-projects/${unlinkedProjectId}/capitalize`, assetManager);
    assert.equal(unlinked.status, 409, JSON.stringify(unlinked.body));
    assert.equal(codeOf(unlinked), "CAPEX_NOT_LINKED");

    // Enlazada pero sin coste (ni diario en 231, ni partidas, ni ICIO): 400 explicado, sin alta.
    const linked = await call(app, "PATCH", `/capex-projects/${unlinkedProjectId}/work`, assetManager, { realEstateAssetId: assetId, workKind: "eficiencia_energetica", executionAccountPrefixes: ["231"] });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const noCost = await call(app, "POST", `/capex-projects/${unlinkedProjectId}/capitalize`, assetManager);
    assert.equal(noCost.status, 400, JSON.stringify(noCost.body));
    assert.equal(codeOf(noCost), "VALIDATION_ERROR");
    // Con ICIO ya hay coste: 212 (instalaciones técnicas) por el tipo de obra.
    const withIcio = await call(app, "PATCH", `/capex-projects/${unlinkedProjectId}/work`, assetManager, { icioAmount: "150.00" });
    assert.equal(withIcio.status, 200);
    const badDate = await call(app, "POST", `/capex-projects/${unlinkedProjectId}/capitalize`, assetManager, { acquisitionDate: "30/06/2026" });
    assert.equal(badDate.status, 400, JSON.stringify(badDate.body));
    // ACT-REV-12: la fecha de fin de obra del cuerpo es la de alta (y puesta en funcionamiento) del inmovilizado.
    const capitalized = await call(app, "POST", `/capex-projects/${unlinkedProjectId}/capitalize`, assetManager, { acquisitionDate: "2026-06-30" });
    assert.equal(capitalized.status, 201, JSON.stringify(capitalized.body));
    assert.equal(capitalized.body.fixedAsset.acquisitionDate, "2026-06-30");
    assert.equal(capitalized.body.fixedAsset.startDate, "2026-06-30");
    assert.equal(capitalized.body.project.capitalizedAt, TODAY, "la capitalización se registra hoy");
    assert.equal(capitalized.body.fixedAsset.accountCode, "212");
    assert.equal(capitalized.body.fixedAsset.category, "instalaciones");
    assert.equal(capitalized.body.fixedAsset.acquisitionCost, "150.00");
    assert.equal(await prisma.fixedAsset.count({ where: { organizationId: tenant.organizationId } }), 2);
  });
});

describe("ACT-L4 · RBAC y tenencia", () => {
  it("receptionist 403", async () => {
    const read = await call(app, "GET", worksUrl(tenant.propertyA), receptionist);
    assert.equal(read.status, 403, JSON.stringify(read.body));
    const work = await call(app, "PATCH", `/capex-projects/${itemsProjectId}/work`, receptionist, { workKind: "reforma" });
    assert.equal(work.status, 403, JSON.stringify(work.body));
    const capitalize = await call(app, "POST", `/capex-projects/${itemsProjectId}/capitalize`, receptionist);
    assert.equal(capitalize.status, 403, JSON.stringify(capitalize.body));
    assert.equal((await prisma.capexProject.findUnique({ where: { id: itemsProjectId }, select: { workKind: true } }))?.workKind, "eficiencia_energetica", "nada escrito");
  });

  it("accountant lee (real_estate.read) y no edita la obra (403, sin capex.create); owner de otra organización 404 opaco", async () => {
    const read = await call(app, "GET", worksUrl(tenant.propertyA), accountant);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.projects.length, 3);
    const work = await call(app, "PATCH", `/capex-projects/${itemsProjectId}/work`, accountant, { workKind: "reforma" });
    assert.equal(work.status, 403, JSON.stringify(work.body));

    const unknownProject = await call(app, "PATCH", "/capex-projects/capex_no_existe/work", assetManager, { workKind: "reforma" });
    assert.equal(unknownProject.status, 404, JSON.stringify(unknownProject.body));
    assert.equal(unknownProject.body.message, "Proyecto CAPEX no encontrado.");
    const unknownCapitalize = await call(app, "POST", "/capex-projects/capex_no_existe/capitalize", assetManager);
    assert.equal(unknownCapitalize.status, 404);
  });

  it("auditoría: CAPEX_WORK_UPDATED y CAPEX_CAPITALIZED con el actor y sin texto libre", async () => {
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenant.organizationId, entityType: "capex_project", action: { in: ["CAPEX_WORK_UPDATED", "CAPEX_CAPITALIZED"] } }, select: { action: true, entityId: true, actorUserId: true, afterJson: true } });
    const updated = events.filter((e) => e.action === "CAPEX_WORK_UPDATED");
    const capitalizedEvents = events.filter((e) => e.action === "CAPEX_CAPITALIZED");
    assert.ok(updated.length >= 8, `CAPEX_WORK_UPDATED: ${updated.length}`);
    assert.equal(capitalizedEvents.length, 2, "una capitalización por obra");
    assert.ok(events.every((e) => e.actorUserId === assetManager.userId), "todas las escrituras las hizo el asset_manager");
    const main = capitalizedEvents.find((e) => e.entityId === projectId);
    assert.equal((main?.afterJson as Json)?.acquisitionCost, "12480.00");
    assert.equal((main?.afterJson as Json)?.accountCode, "211");
    assert.ok(!("description" in ((main?.afterJson as Json) ?? {})), "sin descripción libre en la auditoría");
  });
});

describe("ACT-REV · aprobación propia y PATCH heredado acotado (ACT-REV-02 / ACT-REV-05)", () => {
  it("el PATCH /capex-projects/:id heredado respeta la máquina CAPEX_WORK, exige licencia y no toca una obra capitalizada", async () => {
    const proposed = await call(app, "POST", "/capex-projects", assetManager, { propertyId: tenant.propertyA, name: "Cubierta", budget: 5000 });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    const id = proposed.body.id as string;
    const skip = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "completed" });
    assert.equal(skip.status, 409, `proposed → completed no está en la máquina: ${JSON.stringify(skip.body)}`);
    assert.equal(codeOf(skip), "CAPEX_NOT_COMPLETED");
    assert.deepEqual(skip.body.details.allowed, ["approved", "cancelled"]);
    const early = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "in_progress" });
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.equal((await prisma.capexProject.findUnique({ where: { id }, select: { status: true } }))?.status, "proposed", "nada escrito");

    await approveProject(app, id, owner, assetManager);
    const twice = await call(app, "POST", `/capex-projects/${id}/approve`, owner);
    assert.equal(twice.status, 409, `approved → approved: ${JSON.stringify(twice.body)}`);
    assert.equal(codeOf(twice), "CAPEX_NOT_COMPLETED");

    // Licencia exigida y sin registrar: el PATCH heredado tampoco inicia la obra.
    const licence = await call(app, "PATCH", `/capex-projects/${id}/work`, assetManager, { realEstateAssetId: assetId, licenceRequired: true });
    assert.equal(licence.status, 200, JSON.stringify(licence.body));
    const unlicensed = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "in_progress" });
    assert.equal(unlicensed.status, 409, JSON.stringify(unlicensed.body));
    assert.equal(codeOf(unlicensed), "LICENCE_REQUIRED");
    const relaxed = await call(app, "PATCH", `/capex-projects/${id}/work`, assetManager, { licenceRequired: false });
    assert.equal(relaxed.status, 200);
    const started = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "in_progress", name: "Cubierta (fase 1)" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, "in_progress");
    const cancelLate = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "cancelled" });
    assert.equal(cancelLate.status, 409, "in_progress no se cancela");
    const completed = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "completed" });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const cancelDone = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "cancelled" });
    assert.equal(cancelDone.status, 409, "completed es final");
    assert.equal(codeOf(cancelDone), "CAPEX_NOT_COMPLETED");

    const icio = await call(app, "PATCH", `/capex-projects/${id}/work`, assetManager, { icioAmount: "375.00", workKind: "reforma" });
    assert.equal(icio.status, 200, JSON.stringify(icio.body));
    const capitalized = await call(app, "POST", `/capex-projects/${id}/capitalize`, assetManager);
    assert.equal(capitalized.status, 201, JSON.stringify(capitalized.body));
    const reopen = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { status: "proposed" });
    assert.equal(reopen.status, 409, JSON.stringify(reopen.body));
    assert.equal(codeOf(reopen), "CAPEX_ALREADY_CAPITALIZED");
    assert.equal(reopen.body.details.capitalizedFixedAssetId, capitalized.body.fixedAsset.id);
    const rename = await call(app, "PATCH", `/capex-projects/${id}`, assetManager, { description: "Cubierta rehabilitada." });
    assert.equal(rename.status, 200, "los campos descriptivos siguen editables");
    const row = await prisma.capexProject.findUnique({ where: { id }, select: { status: true, capitalizedFixedAssetId: true } });
    assert.equal(row?.status, "completed");
    assert.equal(row?.capitalizedFixedAssetId, capitalized.body.fixedAsset.id);
  });

  it("POST …/approve: proposado por el owner → 409 SoD del motor; receptionist 403; organización ajena 404 opaco", async () => {
    const byOwner = await call(app, "POST", "/capex-projects", owner, { propertyId: tenant.propertyA, name: "Propuesta del owner", budget: 100 });
    if (byOwner.status === 200) {
      const self = await call(app, "POST", `/capex-projects/${byOwner.body.id}/approve`, owner);
      assert.ok([403, 409].includes(self.status), `nunca quien lo propuso: ${JSON.stringify(self.body)}`);
      assert.equal((await prisma.capexProject.findUnique({ where: { id: byOwner.body.id }, select: { status: true } }))?.status, "proposed");
    } else {
      assert.equal(byOwner.status, 403, "owner sin capex.create no propone");
    }
    const forbidden = await call(app, "POST", `/capex-projects/${itemsProjectId}/approve`, receptionist);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    const unknown = await call(app, "POST", "/capex-projects/capex_no_existe/approve", owner);
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
  });
});
