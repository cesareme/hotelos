/**
 * Tanda L2 · L2-04 · integración (Postgres): puesta en marcha del back office
 * persistida — envíos manuales (manual_setup_submissions), salud de módulos
 * (module_health_checks), pasos (property_setup_steps), formularios
 * (property_setup_form_submissions), gestor de categorías
 * (category_definitions sembradas + property_category_options +
 * traducciones) y campos personalizados (definiciones + valores). Dos
 * organizaciones AISLADAS (helpers/l2-tenant.mts), auth real y RBAC_STRICT;
 * Faranda y org_123 solo se leen (invariantes).
 *
 *   · manual-setup POST → GET → un buildApiServer() nuevo lo sigue sirviendo
 *     (mismo proceso y demoStore compartido: prueba la lectura desde Prisma, no
 *     un reinicio real — ese lo hace el integrador en :3901);
 *   · recalculate-health → filas en module_health_checks y GET …/modules coherente;
 *   · setup/:stepCode PATCH → GET (estado inicial materializado desde el catálogo);
 *   · property-setup/forms POST → GET;
 *   · categoría: POST opción → GET → POST duplicada 409 → organización B 404 →
 *     recepción 403 → traducciones → campo personalizado POST / valores.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-persistencia-backoffice.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, loginOrThrow, cleanupTenant, STRICT_ENV, withEnv, newRunId, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;

const RUN_A = newRunId();
const RUN_B = `${RUN_A}b`;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
/** Dirección general (general_manager): configura el hotel. */
let gmA: Session;
let receptionistA: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: Record<string, any> };

async function call(server: ApiApp, method: Method, url: string, session: Session, payload?: unknown): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () => server.inject({ method, url, headers: session.headers, ...(payload !== undefined ? { payload } : {}) }));
  let body: Record<string, any> = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Record<string, any>) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body };
}

const base = (propertyId: string) => `/backoffice/properties/${propertyId}`;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  gmA = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantA.users.generalManager.email, tenantA.password));
  receptionistA = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  ownerB = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
});

after(async () => {
  try {
    if (tenantA) await cleanupTenant(tenantA.organizationId);
    if (tenantB) await cleanupTenant(tenantB.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: { in: [tenantA?.organizationId ?? "", tenantB?.organizationId ?? ""] } } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
  }
});

describe("L2-04 · envíos de configuración manual (manual_setup_submissions)", () => {
  it("POST guarda el envío, GET lo devuelve y un buildApiServer() nuevo lo sigue sirviendo", async () => {
    const url = `${base(tenantA.propertyA)}/manual-setup/reservation_reporting`;
    const saved = await call(app, "POST", url, gmA, {
      "Fecha desde": "2026-10-01",
      "Fecha hasta": "2026-10-07",
      "Tipo de informe": "ocupacion",
      "Formato de exportación": "csv"
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.submission.status, "saved");
    assert.equal(saved.body.submission.optionCode, "reservation_reporting");
    assert.equal(saved.body.submission.createdBy, gmA.userId);
    assert.ok(Array.isArray(saved.body.submission.targetTables) && saved.body.submission.targetTables.includes("reservations"));

    const failed = await call(app, "POST", url, gmA, { "Fecha desde": "2026-10-01" });
    assert.equal(failed.status, 400, JSON.stringify(failed.body));

    const rows = await prisma.manualSetupSubmission.findMany({ where: { propertyId: tenantA.propertyA, optionCode: "reservation_reporting" }, orderBy: { createdAt: "asc" } });
    assert.equal(rows.length, 2, "envío válido + envío fallido persistidos");
    assert.deepEqual(rows.map((row) => row.status), ["saved", "failed"]);
    assert.equal(rows[0]!.id, saved.body.submission.id);

    const detail = await call(app, "GET", url, gmA);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.submissions.length, 2);
    assert.equal(detail.body.latestSubmission.status, "failed");
    const options = await call(app, "GET", `${base(tenantA.propertyA)}/manual-setup/options`, gmA);
    assert.equal(options.status, 200);
    const option = (options.body.options as Array<{ code: string; setupState: string }>).find((candidate) => candidate.code === "reservation_reporting");
    assert.equal(option?.setupState, "failed", "el último envío manda");
    assert.equal(options.body.setupSummary.failedOptions, 1);

    const app2 = await buildApiServer();
    await app2.ready();
    try {
      const session = await withEnv(STRICT_ENV, () => loginOrThrow(app2, tenantA.users.generalManager.email, tenantA.password, "l2-second-instance"));
      const again = await call(app2, "GET", url, session);
      assert.equal(again.status, 200);
      assert.equal(again.body.submissions.length, 2, "otra instancia lee las mismas filas");
    } finally {
      await app2.close();
    }
    const foreign = await call(app, "GET", url, ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  });
});

describe("L2-04 · salud de módulos (module_health_checks)", () => {
  it("recalculate-health escribe una fila por check y GET …/modules la lee en una consulta", async () => {
    const recalculated = await call(app, "POST", `${base(tenantA.propertyA)}/modules/checkin_online/recalculate-health`, gmA, {});
    assert.equal(recalculated.status, 200, JSON.stringify(recalculated.body));
    const checks = recalculated.body as unknown as Array<{ checkCode: string; status: string; severity: string; moduleCode: string }>;
    assert.equal(checks.length, 3);
    assert.equal(checks.find((check) => check.checkCode === "room_inventory_exists")?.status, "ok", "3 habitaciones vendibles en Prisma");
    assert.equal(checks.find((check) => check.checkCode === "signature_template_configured")?.status, "needs_configuration");
    assert.ok(checks.every((check) => check.moduleCode === "checkin_online"));

    const rows = await prisma.moduleHealthCheck.findMany({ where: { propertyId: tenantA.propertyA, moduleCode: "checkin_online" } });
    assert.equal(rows.length, 3);
    // Idempotent: a second recalculation upserts (same unique key), never duplicates.
    const again = await call(app, "POST", `${base(tenantA.propertyA)}/modules/checkin_online/recalculate-health`, gmA, {});
    assert.equal(again.status, 200);
    assert.equal(await prisma.moduleHealthCheck.count({ where: { propertyId: tenantA.propertyA } }), 3);

    const modules = await call(app, "GET", `${base(tenantA.propertyA)}/modules`, gmA);
    assert.equal(modules.status, 200, JSON.stringify(modules.body));
    const entry = (modules.body as unknown as Array<{ code: string; healthStatus: string; healthChecks: unknown[] }>).find((module) => module.code === "checkin_online");
    assert.ok(entry, "checkin_online en la lista");
    assert.equal(entry.healthChecks.length, 3);
    assert.equal(entry.healthStatus, "needs_configuration");
    const pms = (modules.body as unknown as Array<{ code: string; healthChecks: unknown[]; healthStatus: string }>).find((module) => module.code === "pms_core");
    assert.equal(pms?.healthChecks.length, 0, "otro módulo sin recalcular no hereda checks");
    assert.equal(pms?.healthStatus, "ok");

    const configuration = await call(app, "GET", `${base(tenantA.propertyA)}/modules/checkin_online/configuration`, gmA);
    assert.equal(configuration.status, 200, JSON.stringify(configuration.body));
    assert.equal(configuration.body.module.code, "checkin_online");
    assert.equal(configuration.body.setupRequirements.length, 3);

    const foreign = await call(app, "POST", `${base(tenantA.propertyA)}/modules/checkin_online/recalculate-health`, ownerB, {});
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const forbidden = await call(app, "POST", `${base(tenantA.propertyA)}/modules/checkin_online/recalculate-health`, receptionistA, {});
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  });
});

describe("L2-04 · pasos de puesta en marcha (property_setup_steps)", () => {
  it("el primer GET materializa el catálogo, PATCH persiste el estado y GET lo devuelve", async () => {
    const initial = await call(app, "GET", `${base(tenantA.propertyA)}/setup`, gmA);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.total, 15);
    assert.equal(initial.body.completed, 0);
    assert.ok((initial.body.steps as Array<{ status: string; id: string }>).every((step) => step.status === "not_started" && !step.id.startsWith("virtual_")));
    assert.equal(await prisma.propertySetupStep.count({ where: { propertyId: tenantA.propertyA } }), 15);
    assert.equal((initial.body.steps as Array<{ stepCode: string }>)[0]?.stepCode, "organization_details", "orden del catálogo");

    const patched = await call(app, "PATCH", `${base(tenantA.propertyA)}/setup/organization_details`, gmA, { status: "completed", metadataJson: { nota: "L2" } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.status, "completed");
    assert.equal(patched.body.completedBy, gmA.userId);
    assert.ok(patched.body.completedAt);
    assert.equal(patched.body.metadataJson.nota, "L2");
    const row = await prisma.propertySetupStep.findUniqueOrThrow({ where: { propertyId_stepCode: { propertyId: tenantA.propertyA, stepCode: "organization_details" } } });
    assert.equal(row.status, "completed");
    assert.equal(row.completedBy, gmA.userId);

    const after = await call(app, "GET", `${base(tenantA.propertyA)}/setup`, gmA);
    assert.equal(after.body.completed, 1);
    assert.equal(after.body.progressPercent, 7);
    assert.equal(await prisma.propertySetupStep.count({ where: { propertyId: tenantA.propertyA } }), 15, "sin duplicados");

    const badStatus = await call(app, "PATCH", `${base(tenantA.propertyA)}/setup/organization_details`, gmA, { status: "done" });
    assert.equal(badStatus.status, 400, JSON.stringify(badStatus.body));
    const unknownStep = await call(app, "PATCH", `${base(tenantA.propertyA)}/setup/paso_inventado`, gmA, { status: "completed" });
    assert.equal(unknownStep.status, 404, JSON.stringify(unknownStep.body));
    const foreign = await call(app, "PATCH", `${base(tenantA.propertyA)}/setup/organization_details`, ownerB, { status: "blocked" });
    assert.equal(foreign.status, 404);
    assert.equal((await prisma.propertySetupStep.findUniqueOrThrow({ where: { propertyId_stepCode: { propertyId: tenantA.propertyA, stepCode: "organization_details" } } })).status, "completed");
  });
});

describe("L2-04 · formularios de puesta en marcha (property_setup_form_submissions)", () => {
  it("POST guarda el envío y completa el paso; GET los devuelve", async () => {
    const url = `${base(tenantA.propertyA)}/property-setup/forms/building`;
    const saved = await call(app, "POST", url, gmA, { name: `Edificio Norte ${RUN_A}`, code: `N${RUN_A.slice(-4)}` });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.form.code, "building");
    assert.equal(saved.body.submission.status, "saved");
    assert.equal(saved.body.submission.targetEntityType, "building");
    assert.ok(saved.body.submission.targetEntityId);
    assert.equal(saved.body.setupStep.stepCode, "property_physical_map");
    assert.equal(saved.body.setupStep.status, "completed");

    const failed = await call(app, "POST", url, gmA, { code: "SIN-NOMBRE" });
    assert.equal(failed.status, 400, JSON.stringify(failed.body));

    const rows = await prisma.propertySetupFormSubmission.findMany({ where: { propertyId: tenantA.propertyA, formCode: "building" }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(rows.map((row) => row.status), ["saved", "failed"]);
    assert.equal(rows[0]!.targetEntityId, saved.body.submission.targetEntityId);
    assert.equal(await prisma.building.count({ where: { propertyId: tenantA.propertyA } }), 1);

    const form = await call(app, "GET", url, gmA);
    assert.equal(form.status, 200, JSON.stringify(form.body));
    assert.equal(form.body.submissions.length, 2);
    assert.ok(Array.isArray(form.body.dataQuality));
    const forms = await call(app, "GET", `${base(tenantA.propertyA)}/property-setup/forms`, gmA);
    assert.equal(forms.status, 200);
    const building = (forms.body.forms as Array<{ code: string; status: string; latestSubmission?: { id: string } }>).find((candidate) => candidate.code === "building");
    assert.equal(building?.status, "failed", "el último envío manda");
    assert.equal(building?.latestSubmission?.id, rows[1]!.id);
    const setup = await call(app, "GET", `${base(tenantA.propertyA)}/setup`, gmA);
    assert.equal((setup.body.steps as Array<{ stepCode: string; status: string }>).find((step) => step.stepCode === "property_physical_map")?.status, "completed");
  });
});

describe("L2-04 · gestor de categorías y campos personalizados en Prisma", () => {
  let optionId = "";

  it("el catálogo de definiciones está sembrado y POST opción → GET → duplicada 409 → organización B 404 → recepción 403", async () => {
    assert.ok((await prisma.categoryDefinition.count({ where: { code: { in: ["room_features", "market_segments", "document_types"] } } })) === 3, "category_definitions sembradas al arrancar");

    const categoriesUrl = `${base(tenantA.propertyA)}/configuration/categories`;
    const created = await call(app, "POST", `${categoriesUrl}/room_features/options`, gmA, {
      code: "vistas_mar",
      label: "Vistas al mar",
      description: "",
      colorToken: "color.brand.electricBlue",
      iconName: "Waves",
      active: true,
      translations: [{ language: "en", label: "Sea view" }]
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    optionId = created.body.id;
    assert.ok(optionId);
    assert.equal(created.body.propertyId, tenantA.propertyA);
    assert.equal(created.body.code, "vistas_mar");
    assert.equal(created.body.createdBy, gmA.userId);
    assert.deepEqual(created.body.translations, [{ language: "en", label: "Sea view", description: undefined }].map((t) => ({ language: t.language, label: t.label })));
    const row = await prisma.propertyCategoryOption.findUniqueOrThrow({ where: { id: optionId } });
    assert.equal(row.propertyId, tenantA.propertyA);
    assert.equal(await prisma.propertyCategoryOptionTranslation.count({ where: { categoryOptionId: optionId } }), 1);

    const category = await call(app, "GET", `${categoriesUrl}/room_features`, gmA);
    assert.equal(category.status, 200, JSON.stringify(category.body));
    assert.equal(category.body.code, "room_features");
    const options = category.body.options as Array<{ id: string; label: string; translations: Array<{ language: string; label: string }>; canDelete: boolean }>;
    assert.equal(options.length, 1);
    assert.equal(options[0]!.id, optionId);
    assert.equal(options[0]!.translations[0]?.label, "Sea view");
    assert.equal(options[0]!.canDelete, true);
    assert.equal(category.body.activeOptions, 1);

    const all = await call(app, "GET", categoriesUrl, gmA);
    assert.equal(all.status, 200);
    const groups = all.body.groups as Array<{ group: string; categories: Array<{ code: string; options: unknown[] }> }>;
    const rooms = groups.find((group) => group.group === "Rooms");
    assert.equal(rooms?.categories.find((candidate) => candidate.code === "room_features")?.options.length, 1);
    assert.equal(rooms?.categories.find((candidate) => candidate.code === "bed_types")?.options.length, 0, "la propiedad nueva no hereda opciones de la demo");

    const duplicate = await call(app, "POST", `${categoriesUrl}/room_features/options`, gmA, { code: "vistas_mar", label: "Otra etiqueta" });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.details?.code ?? duplicate.body.code, "UNIQUE_VIOLATION");
    const unknownKey = await call(app, "POST", `${categoriesUrl}/room_features/options`, gmA, { code: "otra", label: "Otra", usageCount: 5 });
    assert.equal(unknownKey.status, 400, JSON.stringify(unknownKey.body));
    const readOnly = await call(app, "POST", `${categoriesUrl}/reservation_statuses/options`, gmA, { code: "x", label: "X" });
    assert.equal(readOnly.status, 409, "categoría de solo lectura");
    const unknownCategory = await call(app, "POST", `${categoriesUrl}/categoria_inventada/options`, gmA, { code: "x", label: "X" });
    assert.equal(unknownCategory.status, 404);

    const foreignGet = await call(app, "GET", `${categoriesUrl}/room_features`, ownerB);
    assert.equal(foreignGet.status, 404, JSON.stringify(foreignGet.body));
    const foreignPost = await call(app, "POST", `${categoriesUrl}/room_features/options`, ownerB, { code: "ajena", label: "Ajena" });
    assert.equal(foreignPost.status, 404, JSON.stringify(foreignPost.body));
    const forbidden = await call(app, "POST", `${categoriesUrl}/room_features/options`, receptionistA, { code: "sin_clave", label: "Sin clave" });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    assert.equal(await prisma.propertyCategoryOption.count({ where: { propertyId: tenantA.propertyA } }), 1);
    const foreignProperty = await call(app, "GET", `${base(tenantB.propertyA)}/configuration/categories/room_features`, gmA);
    assert.equal(foreignProperty.status, 404, "la dirección de A no ve el hotel de B");
  });

  it("PATCH, desactivar / reactivar y reordenar persisten; las traducciones se sustituyen", async () => {
    const optionsUrl = `${base(tenantA.propertyA)}/configuration/category-options/${optionId}`;
    const patched = await call(app, "PATCH", optionsUrl, gmA, { label: "Vistas al mar (parcial)", translations: [{ language: "en", label: "Partial sea view" }, { language: "fr", label: "Vue mer" }] });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.label, "Vistas al mar (parcial)");
    assert.equal(patched.body.updatedBy, gmA.userId);
    assert.deepEqual((patched.body.translations as Array<{ language: string }>).map((t) => t.language), ["en", "fr"]);
    assert.equal(await prisma.propertyCategoryOptionTranslation.count({ where: { categoryOptionId: optionId } }), 2);

    const deactivated = await call(app, "POST", `${optionsUrl}/deactivate`, gmA, {});
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.active, false);
    assert.equal((await prisma.propertyCategoryOption.findUniqueOrThrow({ where: { id: optionId } })).active, false);
    const reactivated = await call(app, "POST", `${optionsUrl}/reactivate`, gmA, {});
    assert.equal(reactivated.body.active, true);

    const second = await call(app, "POST", `${base(tenantA.propertyA)}/configuration/categories/room_features/options`, gmA, { code: "balcon", label: "Balcón" });
    assert.ok([200, 201].includes(second.status), JSON.stringify(second.body));
    const reordered = await call(app, "POST", `${base(tenantA.propertyA)}/configuration/categories/room_features/reorder`, gmA, { optionIds: [second.body.id, optionId] });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    assert.deepEqual((reordered.body.options as Array<{ id: string; sortOrder: number }>).map((option) => [option.id, option.sortOrder]), [[second.body.id, 1], [optionId, 2]]);
    const foreignReorder = await call(app, "POST", `${base(tenantA.propertyA)}/configuration/categories/room_features/reorder`, ownerB, { optionIds: [optionId] });
    assert.equal(foreignReorder.status, 404);
    const missingOption = await call(app, "PATCH", `${base(tenantA.propertyA)}/configuration/category-options/catopt_l2_missing`, gmA, { label: "X" });
    assert.equal(missingOption.status, 404);
    const exported = await call(app, "POST", `${base(tenantA.propertyA)}/configuration/categories/export`, gmA, {});
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal((exported.body.rows as Array<{ option_code: string }>).length, 2);
    assert.ok((exported.body.rows as Array<{ category_code: string }>).every((row) => row.category_code === "room_features"));
  });

  it("campos personalizados: POST definición → duplicada 409 → valores por entidad → GET", async () => {
    const fieldsUrl = `${base(tenantA.propertyA)}/configuration/custom-fields`;
    const created = await call(app, "POST", fieldsUrl, gmA, { entityType: "room", fieldKey: "notas_internas", label: "Notas internas", dataType: "text", searchable: true });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const fieldId = created.body.id as string;
    assert.equal(created.body.propertyId, tenantA.propertyA);
    assert.equal(created.body.visibleInDetail, true);
    assert.equal((await prisma.propertyCustomFieldDefinition.findUniqueOrThrow({ where: { id: fieldId } })).fieldKey, "notas_internas");

    const duplicate = await call(app, "POST", fieldsUrl, gmA, { entityType: "room", fieldKey: "notas_internas", label: "Repetido", dataType: "text" });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    const badType = await call(app, "POST", fieldsUrl, gmA, { entityType: "room", fieldKey: "otro", label: "Otro", dataType: "color" });
    assert.equal(badType.status, 400);
    const foreign = await call(app, "POST", fieldsUrl, ownerB, { entityType: "room", fieldKey: "ajeno", label: "Ajeno", dataType: "text" });
    assert.equal(foreign.status, 404);

    const list = await call(app, "GET", fieldsUrl, gmA);
    assert.equal(list.status, 200);
    assert.equal((list.body.items as Array<{ id: string }>).length, 1);

    const roomId = tenantA.roomsA[0]!;
    const valuesUrl = `${base(tenantA.propertyA)}/configuration/entity/room/${roomId}/custom-fields`;
    const patched = await call(app, "PATCH", valuesUrl, gmA, { values: [{ fieldDefinitionId: fieldId, valueJson: { value: "Huésped prefiere planta alta." } }] });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.status, "updated");
    assert.equal(patched.body.values.length, 1);
    const again = await call(app, "PATCH", valuesUrl, gmA, { values: [{ fieldDefinitionId: fieldId, valueJson: { value: "Actualizado" } }] });
    assert.equal(again.status, 200);
    assert.equal(await prisma.propertyCustomFieldValue.count({ where: { propertyId: tenantA.propertyA, entityId: roomId } }), 1, "upsert por (entidad, campo)");
    const unknownField = await call(app, "PATCH", valuesUrl, gmA, { values: [{ fieldDefinitionId: "cf_l2_missing", valueJson: { value: "x" } }] });
    assert.equal(unknownField.status, 404);

    const entity = await call(app, "GET", valuesUrl, gmA);
    assert.equal(entity.status, 200, JSON.stringify(entity.body));
    assert.equal(entity.body.definitions.length, 1);
    assert.equal(entity.body.values.length, 1);
    assert.equal(entity.body.values[0].valueJson.value, "Actualizado");

    const deactivated = await call(app, "POST", `${fieldsUrl}/${fieldId}/deactivate`, gmA, {});
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.active, false);
    const entityAfter = await call(app, "GET", valuesUrl, gmA);
    assert.equal(entityAfter.body.definitions.length, 0, "las definiciones inactivas no se sirven a la entidad");
  });

  it("readiness y centro de configuración leen solo Prisma", async () => {
    // Tanda L5 (lote C): sin filas persistidas el GET evalúa las 17 comprobaciones,
    // las persiste (sin auditar) y responde con computedAt; un hotel recién creado
    // sigue «blocked» porque le faltan comprobaciones bloqueantes reales.
    assert.equal(await prisma.propertyReadinessCheck.count({ where: { propertyId: tenantA.propertyA } }), 0, "sin filas antes del primer GET");
    const readiness = await call(app, "GET", `${base(tenantA.propertyA)}/readiness`, gmA);
    assert.equal(readiness.status, 200, JSON.stringify(readiness.body));
    assert.equal(readiness.body.propertyId, tenantA.propertyA);
    assert.equal(readiness.body.status, "blocked", "un hotel recién creado tiene comprobaciones bloqueantes pendientes");
    assert.equal(readiness.body.checks.length, 17, "el GET calcula las 17 comprobaciones");
    assert.ok(readiness.body.blockingCount > 0);
    assert.match(String(readiness.body.computedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "computedAt en ISO 8601");
    assert.equal(readiness.body.goLiveAt, null);
    assert.equal(await prisma.propertyReadinessCheck.count({ where: { propertyId: tenantA.propertyA } }), 17, "las 17 filas quedan persistidas");
    const center = await call(app, "GET", `${base(tenantA.propertyA)}/configuration-center`, gmA);
    if (center.status === 200) {
      assert.equal(center.body.optionCount, 2);
      assert.equal(center.body.customFieldCount, 0, "el campo desactivado no cuenta");
      assert.ok(center.body.categoryCount >= 14);
    } else {
      assert.equal(center.status, 404, "ruta retirada del manifiesto");
    }
  });
});
