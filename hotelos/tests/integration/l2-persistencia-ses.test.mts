/**
 * Tanda L2 · L2-04 · integración (Postgres): ajustes SES / registro de viajeros
 * persistidos (authority_reporting_settings, lodging_legal_profiles,
 * authority_routing_rules) y eventos de escaneo de documento
 * (identity_document_processing_events). Organizaciones AISLADAS
 * (helpers/l2-tenant.mts), auth real y RBAC_STRICT (STRICT_ENV); Faranda y
 * org_123 solo se leen (invariantes).
 *
 *   · PATCH …/guest-register/settings en una propiedad recién creada → 200 (crea
 *     la fila) → GET la devuelve con `persisted: true` y legalProfile persistido;
 *   · un buildApiServer() nuevo sigue devolviéndola (no vive en memoria; misma
 *     instancia de proceso y demoStore compartido: no sustituye al reinicio real
 *     del integrador en :3901);
 *   · GET sin fila → valores por defecto (`persisted: false`, id null), perfil
 *     legal derivado de la sociedad, reglas de enrutado ES sembradas;
 *   · organización B → 404 opaco; recepcionista sin clave → 403; clave
 *     desconocida → 400 (zod strict);
 *   · POST test-connection lee la fila; temporary-scan / discard-event crean
 *     identity_document_processing_events.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-persistencia-ses.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, loginOrThrow, cleanupTenant, STRICT_ENV, withEnv, newRunId, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { buildApiServer } = await import("../../apps/api/src/server.js");
type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;

const RUN_A = newRunId();
const RUN_B = `${RUN_A}b`;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
/** Propiedad (plantilla owner, T8a): lectura. */
let ownerA: Session;
/** Cumplimiento (plantilla compliance, T8a): guest_register.configure + compliance.ses.configure. */
let complianceA: Session;
let receptionistA: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: Record<string, any> };

async function call(server: ApiApp, method: Method, url: string, session: Session, payload?: unknown, propertyId?: string): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    server.inject({
      method,
      url,
      headers: { ...session.headers, ...(propertyId ? { "x-property-id": propertyId } : {}) },
      ...(payload !== undefined ? { payload } : {})
    })
  );
  let body: Record<string, any> = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Record<string, any>) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body };
}

const settingsUrl = (propertyId: string) => `/compliance/spain/properties/${propertyId}/guest-register/settings`;

/**
 * Usuario extra con una plantilla de organización que el helper no crea
 * (misma forma que createIsolatedTenant: asignación real en user_role_assignments).
 */
async function addTemplateUser(tenant: IsolatedTenant, templateKey: string, local: string): Promise<string> {
  const roleId = tenant.roles[templateKey];
  assert.ok(roleId, `plantilla ${templateKey} provisionada en ${tenant.organizationId}`);
  const email = `${local}.l2.${tenant.run}@faranda.test`;
  const user = await prisma.user.create({
    data: {
      id: `usr_l2_${local}_${tenant.run}`,
      organizationId: tenant.organizationId,
      email,
      fullName: `${templateKey} L2`,
      status: "active",
      passwordHash: hashPassword(tenant.password),
      mustChangePassword: false,
      passwordChangedAt: new Date()
    },
    select: { id: true }
  });
  await prisma.userRoleAssignment.create({
    data: { userId: user.id, roleId, scopeType: "organization", propertyId: null, organizationId: tenant.organizationId, reason: `seed l2 ${templateKey}` }
  });
  resetRbacScopeCacheForTests();
  return email;
}

before(async () => {
  app = await buildApiServer();
  await app.ready();
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  ownerA = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantA.users.owner.email, tenantA.password));
  const complianceEmail = await addTemplateUser(tenantA, "compliance", "compliance");
  complianceA = await withEnv(STRICT_ENV, () => loginOrThrow(app, complianceEmail, tenantA.password));
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

describe("L2-04 · ajustes SES / registro de viajeros en Prisma", () => {
  it("GET sin fila devuelve valores por defecto sin crear nada y el perfil legal derivado", async () => {
    const res = await call(app, "GET", settingsUrl(tenantA.propertyB), ownerA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reporting.persisted, false);
    assert.equal(res.body.reporting.id, null);
    assert.equal(res.body.reporting.propertyId, tenantA.propertyB);
    assert.equal(res.body.reporting.authorityType, "ses_hospedajes");
    assert.equal(res.body.reporting.enabled, true);
    assert.equal(res.body.reporting.batchExportEnabled, true);
    assert.equal(res.body.legalProfile.source, "derived");
    assert.equal(res.body.legalProfile.id, null);
    assert.equal(res.body.legalProfile.taxId, tenantA.taxId, "el NIF derivado es el de la sociedad");
    assert.equal(res.body.legalProfile.roomCount, 3);
    assert.ok(Array.isArray(res.body.legalProfile.missing));
    assert.equal(await prisma.authorityReportingSetting.count({ where: { propertyId: tenantA.propertyB } }), 0, "GET no crea fila");
    assert.equal(await prisma.lodgingLegalProfile.count({ where: { propertyId: tenantA.propertyB } }), 0);
    const ruleIds = (res.body.routingRules as Array<{ id: string; propertyId?: string }>).map((rule) => rule.id);
    assert.ok(ruleIds.includes("arr_es_default"), `reglas ES sembradas: ${ruleIds.join(",")}`);
    assert.ok(ruleIds.includes("arr_es_ct_mossos"));
    assert.equal(await prisma.authorityRoutingRule.count({ where: { id: { in: ["arr_es_default", "arr_es_ct_mossos"] } } }), 2);
    assert.equal(res.body.privacy.storeIdImageDefault, false);
  });

  it("PATCH crea la configuración de una propiedad recién creada (200) y GET la devuelve persistida", async () => {
    const patch = await call(app, "PATCH", settingsUrl(tenantA.propertyA), complianceA, {
      establishmentCode: `EST-L2-${RUN_A}`,
      landlordCode: "ARR-L2",
      enabled: true,
      webServiceEnabled: false,
      batchExportEnabled: true,
      retentionYears: 4,
      defaultBatchTime: "06:30",
      configurationJson: { nota: "prueba L2" },
      legalProfile: {
        legalName: `L2 Test ${RUN_A} SL`,
        taxId: tenantA.taxId,
        fullAddress: "Calle Real 1",
        postalCode: "15001",
        locality: "A Coruña",
        establishmentProvince: "A Coruña",
        roomCount: 3,
        internetConnection: true
      }
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(patch.body.persisted, true);
    assert.equal(patch.body.establishmentCode, `EST-L2-${RUN_A}`);
    assert.equal(patch.body.configurationJson.retentionYears, 4);
    assert.equal(patch.body.configurationJson.defaultBatchTime, "06:30");
    assert.equal(patch.body.configurationJson.nota, "prueba L2");
    assert.equal(patch.body.legalProfile.source, "persisted");
    assert.equal(patch.body.legalProfile.fullAddress, "Calle Real 1");

    const row = await prisma.authorityReportingSetting.findUnique({ where: { propertyId: tenantA.propertyA } });
    assert.ok(row, "fila en authority_reporting_settings");
    assert.equal(row.establishmentCode, `EST-L2-${RUN_A}`);
    assert.equal(row.country, "ES");
    const profile = await prisma.lodgingLegalProfile.findUnique({ where: { propertyId: tenantA.propertyA } });
    assert.ok(profile, "fila en lodging_legal_profiles");
    assert.equal(profile.postalCode, "15001");
    assert.equal(profile.roomCount, 3);

    const get = await call(app, "GET", settingsUrl(tenantA.propertyA), ownerA);
    assert.equal(get.status, 200);
    assert.equal(get.body.reporting.persisted, true);
    assert.equal(get.body.reporting.id, row.id);
    assert.equal(get.body.reporting.landlordCode, "ARR-L2");
    assert.equal(get.body.legalProfile.source, "persisted");
    assert.equal(get.body.legalProfile.id, profile.id);
    assert.deepEqual(get.body.legalProfile.missing, []);

    // Second PATCH merges: the previous configuration keys survive, a text field can be cleared with null.
    const patch2 = await call(app, "PATCH", settingsUrl(tenantA.propertyA), complianceA, { landlordCode: null, alertBeforeDeadlineHours: 6, legalProfile: { phone: "+34600000000" } });
    assert.equal(patch2.status, 200, JSON.stringify(patch2.body));
    assert.equal(patch2.body.landlordCode, undefined);
    assert.equal(patch2.body.configurationJson.retentionYears, 4);
    assert.equal(patch2.body.configurationJson.alertBeforeDeadlineHours, 6);
    assert.equal(patch2.body.legalProfile.phone, "+34600000000");
    assert.equal(patch2.body.legalProfile.fullAddress, "Calle Real 1");

    const audit = await prisma.auditEvent.findFirst({
      where: { propertyId: tenantA.propertyA, action: "AuthorityReportingSettingsUpdated" },
      select: { id: true }
    });
    assert.ok(audit, "auditoría AuthorityReportingSettingsUpdated");
  });

  it("un buildApiServer() nuevo sigue devolviendo la configuración (no vive en memoria)", async () => {
    const app2 = await buildApiServer();
    await app2.ready();
    try {
      const session = await withEnv(STRICT_ENV, () => loginOrThrow(app2, complianceA.email, tenantA.password, "l2-second-instance"));
      const get = await call(app2, "GET", settingsUrl(tenantA.propertyA), session);
      assert.equal(get.status, 200, JSON.stringify(get.body));
      assert.equal(get.body.reporting.persisted, true);
      assert.equal(get.body.reporting.establishmentCode, `EST-L2-${RUN_A}`);
      assert.equal(get.body.legalProfile.source, "persisted");
      assert.equal(get.body.legalProfile.postalCode, "15001");
    } finally {
      await app2.close();
    }
  });

  it("organización B → 404 opaco; recepcionista → 403 al configurar y 404 fuera de su ámbito; clave desconocida → 400", async () => {
    const foreignGet = await call(app, "GET", settingsUrl(tenantA.propertyA), ownerB);
    assert.equal(foreignGet.status, 404, JSON.stringify(foreignGet.body));
    const foreignPatch = await call(app, "PATCH", settingsUrl(tenantA.propertyA), ownerB, { enabled: false });
    assert.equal(foreignPatch.status, 404, JSON.stringify(foreignPatch.body));
    assert.equal((await prisma.authorityReportingSetting.findUnique({ where: { propertyId: tenantA.propertyA } }))?.enabled, true, "la organización B no escribe");

    const readOk = await call(app, "GET", settingsUrl(tenantA.propertyA), receptionistA);
    assert.equal(readOk.status, 200, "recepción lee (guest_register.read)");
    const forbidden = await call(app, "PATCH", settingsUrl(tenantA.propertyA), receptionistA, { enabled: false });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    const outOfScope = await call(app, "GET", settingsUrl(tenantA.propertyB), receptionistA);
    assert.equal(outOfScope.status, 404, "recepción no cubre el hotel B");

    const unknownKey = await call(app, "PATCH", settingsUrl(tenantA.propertyA), complianceA, { clave_desconocida: 1 });
    assert.equal(unknownKey.status, 400, JSON.stringify(unknownKey.body));
    const badType = await call(app, "PATCH", settingsUrl(tenantA.propertyA), complianceA, { enabled: "sí" });
    assert.equal(badType.status, 400);
    const missing = await call(app, "GET", settingsUrl(`prop_l2_missing_${RUN_A}`), ownerA);
    assert.equal(missing.status, 404);
  });

  it("POST test-connection lee la fila persistida", async () => {
    const res = await call(app, "POST", `/compliance/ses-hospedajes/properties/${tenantA.propertyA}/test-connection`, complianceA, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.authorityType, "ses_hospedajes");
    assert.ok(["establishment_incomplete", "sandbox_ready", "web_service_ready", "batch_export_ready"].includes(res.body.status), res.body.status);
    assert.equal(typeof res.body.message, "string");
    assert.ok(res.body.establishment, "bloque establecimiento resuelto");
    const foreign = await call(app, "POST", `/compliance/ses-hospedajes/properties/${tenantA.propertyA}/test-connection`, ownerB, {});
    assert.equal(foreign.status, 404);
  });

  it("temporary-scan y discard-event crean identity_document_processing_events (imagen nunca almacenada)", async () => {
    const scan = await call(
      app,
      "POST",
      "/compliance/spain/identity-document/temporary-scan",
      receptionistA,
      { propertyId: tenantA.propertyA, fieldsExtractedJson: { firstName: "Ana", documentType: "DNI" }, confidenceJson: { firstName: 0.97 } },
      tenantA.propertyA
    );
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.equal(scan.body.eventType, "temporary_scan_started");
    assert.equal(scan.body.imageStored, false);
    assert.equal(scan.body.imageDiscarded, false);
    assert.equal(scan.body.createdBy, receptionistA.userId);
    const discard = await call(
      app,
      "POST",
      "/compliance/spain/identity-document/discard-event",
      receptionistA,
      { propertyId: tenantA.propertyA, fieldsExtractedJson: { firstName: "Ana" } },
      tenantA.propertyA
    );
    assert.equal(discard.status, 200, JSON.stringify(discard.body));
    assert.equal(discard.body.eventType, "image_discarded");
    assert.equal(discard.body.imageDiscarded, true);

    const rows = await prisma.identityDocumentProcessingEvent.findMany({ where: { propertyId: tenantA.propertyA }, orderBy: { createdAt: "asc" } });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.eventType), ["temporary_scan_started", "image_discarded"]);
    assert.ok(rows.every((row) => row.imageStored === false));
    assert.equal(rows[0]?.id, scan.body.id);

    const foreign = await call(app, "POST", "/compliance/spain/identity-document/temporary-scan", ownerB, { propertyId: tenantA.propertyA, fieldsExtractedJson: {} }, tenantA.propertyA);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    // server.ts spreads the body into the service input, so only the typed fields
    // reach the zod schema: a wrong type is rejected (400), an extra key is dropped.
    const badType = await call(app, "POST", "/compliance/spain/identity-document/temporary-scan", receptionistA, { propertyId: tenantA.propertyA, fieldsExtractedJson: "texto" }, tenantA.propertyA);
    assert.equal(badType.status, 400, JSON.stringify(badType.body));
    const outOfScope = await call(app, "POST", "/compliance/spain/identity-document/temporary-scan", receptionistA, { propertyId: tenantA.propertyB, fieldsExtractedJson: {} }, tenantA.propertyB);
    assert.equal(outOfScope.status, 404, "recepción no cubre el hotel B");

    assert.equal(await prisma.identityDocumentProcessingEvent.count({ where: { propertyId: tenantA.propertyA } }), 2);
    assert.equal(await prisma.identityDocumentProcessingEvent.count({ where: { propertyId: tenantA.propertyB } }), 0);
  });
});
