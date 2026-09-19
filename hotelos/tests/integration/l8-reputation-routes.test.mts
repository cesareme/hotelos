/**
 * Tanda T8 · lote T8-D — rutas de reputación por app.inject sobre las tablas
 * existentes (Postgres real, tenant aislado de helpers/l2-tenant.mts).
 *
 * buildApiServer() (server.ts:1054) devuelve la app SIN llamar a app.ready()
 * y findRoutePermission (route-permissions.ts:1257) hace .find sobre el array
 * exportado en vivo: este test empuja las 12 entradas del partial al
 * manifiesto (routePermissionManifest.push) y registra las rutas
 * (registerReputationRoutes(app)) ANTES del primer inject, y las retira al
 * terminar (splice). Hasta que el integrador aplique las mergeLines de
 * server.ts / route-permissions.ts, así se prueban las rutas de verdad.
 *
 * Dos organizaciones aisladas: A con reputation_quality (+ guest_experience,
 * ai_concierge: enableModules inserta property_modules sin pasar por la
 * dependencia) solo en el hotel A; usuario manager (plantilla con las 6 claves
 * de reputación; asignado a los dos hoteles de A para que el gate de módulo
 * responda 403 en B y no el 404 del ámbito) y receptionist del helper (solo
 * lectura). B con su propio manager para los 404 opacos. RBAC_STRICT=true, auth
 * real, sin unión de permisos de demo. Datos FICTICIOS (nunca reseñas ni
 * nombres reales). Al terminar borra las dos organizaciones; las invariantes
 * de Faranda son idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l8-reputation-routes.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;
type FarandaInvariants = Awaited<ReturnType<typeof farandaInvariants>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { reputationRoutePermissions } = await import("../../apps/api/src/modules/reputation/route-permissions.partial.js");
const { registerReputationRoutes } = await import("../../apps/api/src/modules/reputation/reputation.routes.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { readReviewMeta, SCORE10_NEGATIVE } = await import("../../apps/api/src/modules/reputation/reputation-types.js");
const { invalidateReputationCache, resetSchemaPatchCacheForTests } = await import("../../apps/api/src/modules/reputation/reputation-score.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; headers: Record<string, string | string[] | undefined> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: Session, propertyId: string, payload?: unknown): Promise<Reply> {
  const res = await app.inject({ method, url, headers: { ...session.headers, "x-property-id": propertyId }, ...(payload === undefined ? {} : { payload }) });
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, string | string[] | undefined> };
}

const detailsCode = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
const items = (reply: Reply): Json[] => (Array.isArray(reply.body.items) ? (reply.body.items as Json[]) : []);
const asArray = (reply: Reply): Json[] => (Array.isArray(reply.body) ? (reply.body as unknown as Json[]) : Array.isArray(reply.body.raw) ? [] : []);

/** Usuario extra con una plantilla en las propiedades dadas (barrido por cleanupTenant; patrón l2-motor-generico.test.mts:70-85). */
async function addUser(tenant: IsolatedTenant, key: string, templateKey: string, propertyIds: string[]): Promise<{ id: string; email: string }> {
  const id = `usr_l8r_${key}_${tenant.run}`;
  const email = `${key}.l8r.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L8R ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
  for (const propertyId of propertyIds) {
    await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId, organizationId: tenant.organizationId, reason: `l8-routes ${key}` } });
  }
  resetRbacScopeCacheForTests();
  return { id, email };
}

const NOW = new Date();
const DAY = 86_400_000;
const isoDay = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY).toISOString().slice(0, 10);

/** 10 reseñas FICTICIAS (escala 5 por fila; 3 negativas < 6/10). */
const CSV_ROWS: Array<[string, string, number, string, string, string, string]> = [
  ["r-01", isoDay(1), 5, "Excelente", "Personal atento y habitación impecable.", "es", "Huésped Ficticio Uno"],
  ["r-02", isoDay(2), 4.5, "Muy bien", "Desayuno variado y buena ubicación.", "es", "Huésped Ficticio Dos"],
  ["r-03", isoDay(3), 4, "Correcto", "Todo bien salvo el wifi, algo lento.", "es", "Huésped Ficticio Tres"],
  ["r-04", isoDay(4), 1.5, "Muy mal", "La habitación estaba sucia y había ruido toda la noche.", "es", "Huésped Ficticio Cuatro"],
  ["r-05", isoDay(5), 3.5, "Normal", "Estancia sin sorpresas.", "es", "Huésped Ficticio Cinco"],
  ["r-06", isoDay(6), 5, "Great stay", "Lovely staff and a quiet room.", "en", "Fictional Guest Six"],
  ["r-07", isoDay(7), 2.5, "Decepcionante", "El desayuno era escaso y la recepción lenta.", "es", "Huésped Ficticio Siete"],
  ["r-08", isoDay(8), 4, "Bien", "Buena relación calidad-precio.", "es", "Huésped Ficticio Ocho"],
  ["r-09", isoDay(9), 1, "Nunca más", "Mantenimiento deficiente: el aire acondicionado no funcionaba.", "es", "Huésped Ficticio Nueve"],
  ["r-10", isoDay(10), 4.5, "Repetiremos", "Instalaciones cuidadas y personal amable.", "es", "Huésped Ficticio Diez"]
];
const NEGATIVES = CSV_ROWS.filter((row) => (row[2] / 5) * 10 < SCORE10_NEGATIVE).length;

function csvText(): string {
  const quote = (value: string | number): string => `"${String(value).replace(/"/g, '""')}"`;
  const lines = ["external_id,date,rating,scale_max,title,body,language,author"];
  for (const [id, date, rating, title, body, language, author] of CSV_ROWS) lines.push([id, date, rating, 5, title, body, language, author].map(quote).join(","));
  return `${lines.join("\n")}\n`;
}
const CSV_BASE64 = Buffer.from(csvText(), "utf8").toString("base64");

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
let manager: Session;
let managerId = "";
let receptionist: Session;
let managerB: Session;
let invariantsBefore: FarandaInvariants;
let manifestStart = -1;
let csvSourceId = "";
let googleSourceId = "";
let negativeReviewId = "";
let positiveReviewId = "";
let draftReviewItemId = "";

describe("L8 · reputación · rutas por app.inject (tenant aislado, manifiesto empujado en vivo)", () => {
  before(async () => {
    invariantsBefore = await farandaInvariants();
    app = await buildApiServer();
    // Cableado que hará el integrador (mergeLines): manifiesto + registro, antes del primer inject.
    manifestStart = routePermissionManifest.length;
    routePermissionManifest.push(...reputationRoutePermissions);
    registerReputationRoutes(app);
    A = await createIsolatedTenant(`r${newRunId()}`);
    B = await createIsolatedTenant(`s${newRunId()}`);
    await enableModules(A.propertyA, ["guest_experience", "ai_concierge", "reputation_quality"]);
    await enableModules(B.propertyA, ["guest_experience", "ai_concierge", "reputation_quality"]);
    resetSchemaPatchCacheForTests();
    invalidateReputationCache();
    const managerUser = await addUser(A, "manager", "manager", [A.propertyA, A.propertyB]);
    const managerBUser = await addUser(B, "manager", "manager", [B.propertyA]);
    managerId = managerUser.id;
    await strict(async () => {
      manager = await loginOrThrow(app, managerUser.email, A.password);
      receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
      managerB = await loginOrThrow(app, managerBUser.email, B.password);
    });
  });

  after(async () => {
    try {
      if (A) await cleanupTenant(A.organizationId);
      if (B) await cleanupTenant(B.organizationId);
    } finally {
      if (manifestStart >= 0) routePermissionManifest.splice(manifestStart, reputationRoutePermissions.length);
      invalidateReputationCache();
      await app?.close();
    }
    assert.equal(routePermissionManifest.some((entry) => entry.path.startsWith("/reputation/properties/:propertyId/inbox")), false, "manifiesto restaurado");
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "Faranda debe quedar idéntica");
    // Comprobación local a esta suite: las suites hermanas l8-* crean y borran sus propias organizaciones en paralelo
    // (node --test sin --test-concurrency=1), así que el recuento global de org_l2_* no es un invariante de esta suite.
    assert.equal(await prisma.organization.count({ where: { id: { in: [A?.organizationId, B?.organizationId].filter((id): id is string => Boolean(id)) } } }), 0, "las dos organizaciones aisladas de esta suite deben desaparecer");
  });

  it("gate de módulo: 403 con el texto del motor en el hotel B (sin reputation_quality); la ruta retirada /dashboard sigue en 404 de Fastify", async () =>
    strict(async () => {
      const off = await call(app, "GET", `/reputation/properties/${A.propertyB}/inbox?envelope=1`, manager, A.propertyB);
      assert.equal(off.status, 403, JSON.stringify(off.body));
      assert.equal(off.body.message, "El módulo reputation_quality no está activado en esta propiedad.");
      const offSources = await call(app, "POST", `/reputation/properties/${A.propertyB}/sources`, manager, A.propertyB, { provider: "csv" });
      assert.equal(offSources.status, 403);
      const retired = await call(app, "GET", `/reputation/properties/${A.propertyA}/dashboard`, manager, A.propertyA);
      assert.equal(retired.status, 404);
      assert.match(String(retired.body.message), /not found/i);
    }));

  it("bandeja vacía: 200 con envelope { items, nextCursor, total } (?envelope=1) o array plano (regla de L2) y X-Total-Count; parámetro desconocido → 400 VALIDATION_ERROR", async () =>
    strict(async () => {
      const inbox = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1`, manager, A.propertyA);
      assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
      assert.deepEqual(inbox.body, { items: [], nextCursor: null, total: 0 });
      assert.equal(inbox.headers["x-total-count"], "0");
      // T8F-05: sin envelope la ruta devuelve el array plano (lib/pagination.ts pageBody), con las mismas cabeceras.
      const bare = await app.inject({ method: "GET", url: `/reputation/properties/${A.propertyA}/inbox`, headers: { ...manager.headers, "x-property-id": A.propertyA } });
      assert.equal(bare.statusCode, 200);
      assert.deepEqual(JSON.parse(bare.body), []);
      assert.equal(bare.headers["x-total-count"], "0");
      const bad = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&foo=1`, manager, A.propertyA);
      assert.equal(bad.status, 400);
      assert.equal(detailsCode(bad), "VALIDATION_ERROR");
      // zodErrorMapEs de parseOr400 manda sobre el mensaje del .strict(): «clave no admitida: 'foo'».
      assert.match(String(bad.body.message), /no admitid/);
      assert.match(String(bad.body.message), /foo/);
      const range = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&minScore=9&maxScore=2`, manager, A.propertyA);
      assert.equal(range.status, 400);
    }));

  it("fuentes: POST csv → 201 connected; google → 201 unavailable con lastError honesto; credenciales en el cuerpo → 400; receptionist → 403 en POST y 200 en GET", async () =>
    strict(async () => {
      const csv = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources`, manager, A.propertyA, { provider: "csv", displayName: "Importación manual" });
      assert.equal(csv.status, 201, JSON.stringify(csv.body));
      assert.equal(csv.body.status, "connected");
      assert.equal(csv.body.mode, "csv");
      assert.equal(csv.body.hasCredentials, false);
      csvSourceId = csv.body.id as string;
      const google = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources`, manager, A.propertyA, { provider: "google", externalLocationId: "locations/ficticia-1" });
      assert.equal(google.status, 201, JSON.stringify(google.body));
      assert.equal(google.body.status, "unavailable");
      assert.ok(typeof google.body.lastError === "string" && (google.body.lastError as string).length > 0, "motivo honesto");
      googleSourceId = google.body.id as string;
      const leaked = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources`, manager, A.propertyA, { provider: "google", accessToken: "nunca" });
      assert.equal(leaked.status, 400);
      assert.equal(detailsCode(leaked), "REVIEW_SOURCE_CREDENTIALS_IN_CONFIG");
      const unknown = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources`, manager, A.propertyA, { provider: "csv", foo: 1 });
      assert.equal(unknown.status, 400);
      assert.equal(detailsCode(unknown), "VALIDATION_ERROR");
      const forbidden = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources`, receptionist, A.propertyA, { provider: "csv" });
      assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
      const list = await call(app, "GET", `/reputation/properties/${A.propertyA}/sources`, receptionist, A.propertyA);
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.deepEqual(asArray(list).map((source) => source.provider).sort(), ["csv", "google"]);
      for (const source of asArray(list)) assert.equal(JSON.stringify(source).includes("nunca"), false);
    }));

  it("importación CSV: 201 con created = 10; el segundo import devuelve duplicates = 10; filas JSON → created; casos review_negative por reseña < 6; fichero inválido → 400 REVIEW_IMPORT_INVALID", async () =>
    strict(async () => {
      const first = await call(app, "POST", `/reputation/properties/${A.propertyA}/imports`, manager, A.propertyA, { source: "csv", sourceId: csvSourceId, fileName: "reseñas-ficticias.csv", contentBase64: CSV_BASE64 });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.created, CSV_ROWS.length);
      assert.equal(first.body.updated, 0);
      assert.equal(first.body.duplicates, 0);
      assert.deepEqual(first.body.invalid, []);
      assert.equal(first.body.total, CSV_ROWS.length);
      assert.equal(first.body.sourceId, csvSourceId);
      assert.match(String(first.body.correlationId), /^corr_/);

      const second = await call(app, "POST", `/reputation/properties/${A.propertyA}/imports`, manager, A.propertyA, { source: "csv", sourceId: csvSourceId, contentBase64: CSV_BASE64 });
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.created, 0);
      assert.equal(second.body.duplicates, CSV_ROWS.length);

      const rows = await call(app, "POST", `/reputation/properties/${A.propertyA}/imports`, manager, A.propertyA, {
        source: "booking",
        rows: [
          { externalId: "bk-01", date: isoDay(2), rating: 9, title: "Genial", body: "Trato impecable.", language: "es", author: "Huésped Ficticio Once" },
          { externalId: "bk-02", date: isoDay(3), rating: 7.5, body: "Sin incidencias.", language: "es", author: "Huésped Ficticio Doce" }
        ]
      });
      assert.equal(rows.status, 201, JSON.stringify(rows.body));
      assert.equal(rows.body.created, 2);
      assert.notEqual(rows.body.sourceId, csvSourceId, "las filas de Booking van a la fuente CSV de Booking (creada al vuelo)");

      assert.equal(await prisma.guestReview.count({ where: { propertyId: A.propertyA } }), CSV_ROWS.length + 2);
      const cases = await prisma.qualityCase.findMany({ where: { propertyId: A.propertyA, caseType: "review_negative" } });
      assert.equal(cases.length, NEGATIVES);
      for (const qualityCase of cases) assert.equal(qualityCase.status, "open");
      const negative = await prisma.guestReview.findFirstOrThrow({ where: { propertyId: A.propertyA, externalReference: "r-04" } });
      negativeReviewId = negative.id;
      assert.equal(negative.sentiment, "negative");
      assert.ok(readReviewMeta(negative.topicsJson).qualityCaseId);
      const positive = await prisma.guestReview.findFirstOrThrow({ where: { propertyId: A.propertyA, externalReference: "r-01" } });
      positiveReviewId = positive.id;
      assert.equal(readReviewMeta(positive.topicsJson).analysis.status, "done", "la importación analiza (diccionario)");

      const invalid = await call(app, "POST", `/reputation/properties/${A.propertyA}/imports`, manager, A.propertyA, { source: "csv", contentBase64: Buffer.from("titulo,cuerpo\nhola,mundo\n", "utf8").toString("base64") });
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
      assert.equal(detailsCode(invalid), "REVIEW_IMPORT_INVALID");
      const both = await call(app, "POST", `/reputation/properties/${A.propertyA}/imports`, manager, A.propertyA, { source: "csv", contentBase64: CSV_BASE64, rows: [{ date: isoDay(1) }] });
      assert.equal(both.status, 400);
      const forbidden = await call(app, "POST", `/reputation/properties/${A.propertyA}/imports`, receptionist, A.propertyA, { source: "csv", contentBase64: CSV_BASE64 });
      assert.equal(forbidden.status, 403);

      await flushAuditQueues();
      assert.equal(await prisma.auditEvent.count({ where: { organizationId: A.organizationId, action: "ReviewsImported" } }), 3);
      assert.equal(await prisma.auditEvent.count({ where: { organizationId: A.organizationId, action: "ReviewReceived", entityType: "guest_review" } }), NEGATIVES);
    }));

  it("bandeja con datos: total 12, filtros (status, sentiment, minScore/maxScore, responded=0), paginación por cursor y X-Next-Cursor", async () =>
    strict(async () => {
      const all = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1`, manager, A.propertyA);
      assert.equal(all.status, 200);
      assert.equal(all.body.total, CSV_ROWS.length + 2);
      assert.equal(items(all).length, CSV_ROWS.length + 2);
      for (const item of items(all)) {
        assert.equal(item.status, "new");
        assert.equal(typeof item.score10, "number");
        assert.ok(!("body" in item), "la bandeja lleva extracto, no cuerpo completo");
      }
      const negatives = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&sentiment=negative&responded=0`, manager, A.propertyA);
      assert.equal(negatives.body.total, NEGATIVES);
      const byScore = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&minScore=0&maxScore=5.9`, manager, A.propertyA);
      assert.equal(byScore.body.total, NEGATIVES);
      const page1 = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&limit=5`, manager, A.propertyA);
      assert.equal(items(page1).length, 5);
      assert.ok(page1.body.nextCursor);
      assert.equal(page1.headers["x-next-cursor"], page1.body.nextCursor);
      const page2 = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&limit=5&cursor=${encodeURIComponent(String(page1.body.nextCursor))}`, manager, A.propertyA);
      assert.equal(items(page2).length, 5);
      assert.equal(new Set([...items(page1), ...items(page2)].map((item) => item.id)).size, 10);
      const booking = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&source=booking`, manager, A.propertyA);
      assert.equal(booking.body.total, 2);
    }));

  it("detalle: 200 con cuerpo y análisis en A; 404 opaco «Reseña no encontrada.» para el manager de otra organización", async () =>
    strict(async () => {
      const detail = await call(app, "GET", `/reputation/reviews/${negativeReviewId}`, manager, A.propertyA);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.id, negativeReviewId);
      assert.equal(typeof detail.body.body, "string");
      assert.equal(detail.body.responseBody, null);
      assert.equal((detail.body.analysis as Json).status, "done");
      assert.equal((detail.body.analysis as Json).source, "dictionary");
      assert.ok(detail.body.qualityCaseId);
      const foreign = await call(app, "GET", `/reputation/reviews/${negativeReviewId}`, managerB, B.propertyA);
      assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
      assert.equal(foreign.body.message, "Reseña no encontrada.");
      const foreignPatch = await call(app, "PATCH", `/reputation/reviews/${negativeReviewId}`, managerB, B.propertyA, { status: "ignored" });
      assert.equal(foreignPatch.status, 404);
    }));

  it("PATCH: transición inválida → 409 INVALID_TRANSITION; responsable → assigned (200, auditado); clave desconocida → 400; receptionist → 403", async () =>
    strict(async () => {
      const invalid = await call(app, "PATCH", `/reputation/reviews/${positiveReviewId}`, manager, A.propertyA, { status: "closed" });
      assert.equal(invalid.status, 409, JSON.stringify(invalid.body));
      assert.equal(detailsCode(invalid), "INVALID_TRANSITION");
      const assigned = await call(app, "PATCH", `/reputation/reviews/${positiveReviewId}`, manager, A.propertyA, { assignedUserId: managerId });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      assert.equal(assigned.body.status, "assigned");
      assert.equal(assigned.body.assignedUserId, managerId);
      const row = await prisma.guestReview.findUniqueOrThrow({ where: { id: positiveReviewId } });
      assert.equal(readReviewMeta(row.topicsJson).status, "assigned");
      assert.equal(row.responseBody, null);
      const unknown = await call(app, "PATCH", `/reputation/reviews/${positiveReviewId}`, manager, A.propertyA, { responseBody: "nunca por PATCH" });
      assert.equal(unknown.status, 400);
      assert.equal(detailsCode(unknown), "VALIDATION_ERROR");
      const forbidden = await call(app, "PATCH", `/reputation/reviews/${positiveReviewId}`, receptionist, A.propertyA, { status: "ignored" });
      assert.equal(forbidden.status, 403);
      await flushAuditQueues();
      assert.equal(await prisma.auditEvent.count({ where: { organizationId: A.organizationId, action: "ReviewUpdated", entityId: positiveReviewId } }), 1);
    }));

  it("borrador: 201 con source rules y requiresHumanReview; meta.draft.source rules + status drafted; fila ai_human_review_items review_response; responseBody sigue null; receptionist → 403", async () =>
    strict(async () => {
      const draft = await call(app, "POST", `/reputation/reviews/${negativeReviewId}/draft`, manager, A.propertyA, { tone: "cordial" });
      assert.equal(draft.status, 201, JSON.stringify(draft.body));
      assert.equal(draft.body.source, "rules");
      assert.equal(draft.body.requiresHumanReview, true);
      assert.equal(typeof draft.body.draft, "string");
      assert.ok((draft.body.draft as string).length > 20);
      draftReviewItemId = draft.body.reviewItemId as string;
      assert.ok(draftReviewItemId);
      const item = await prisma.aiHumanReviewItem.findUniqueOrThrow({ where: { id: draftReviewItemId } });
      assert.equal(item.reviewType, "review_response");
      assert.equal(item.organizationId, A.organizationId);
      assert.equal(item.relatedEntityType, "guest_review");
      assert.equal(item.relatedEntityId, negativeReviewId);
      assert.equal(item.status, "pending");
      const row = await prisma.guestReview.findUniqueOrThrow({ where: { id: negativeReviewId } });
      assert.equal(row.responseBody, null);
      assert.equal(row.respondedAt, null);
      const meta = readReviewMeta(row.topicsJson);
      assert.equal(meta.status, "drafted");
      assert.equal(meta.draft?.source, "rules");
      assert.equal(meta.draft?.reviewItemId, draftReviewItemId);
      const detail = await call(app, "GET", `/reputation/reviews/${negativeReviewId}`, manager, A.propertyA);
      assert.equal(detail.body.hasDraft, true);
      assert.equal((detail.body.draft as Json).source, "rules");
      const badTone = await call(app, "POST", `/reputation/reviews/${negativeReviewId}/draft`, manager, A.propertyA, { tone: "agresivo" });
      assert.equal(badTone.status, 400);
      const forbidden = await call(app, "POST", `/reputation/reviews/${negativeReviewId}/draft`, receptionist, A.propertyA, {});
      assert.equal(forbidden.status, 403);
    }));

  it("POST /reputation/reviews/:id/respond (motor, intacta) sigue publicando responseBody; el detalle nuevo lo muestra; segunda vez 409", async () =>
    strict(async () => {
      const responded = await call(app, "POST", `/reputation/reviews/${negativeReviewId}/respond`, manager, A.propertyA, { responseBody: "Gracias por su visita; lamentamos las molestias." });
      assert.equal(responded.status, 200, JSON.stringify(responded.body));
      assert.equal(responded.body.status, "responded");
      const row = await prisma.guestReview.findUniqueOrThrow({ where: { id: negativeReviewId } });
      assert.equal(row.responseBody, "Gracias por su visita; lamentamos las molestias.");
      assert.ok(row.respondedAt instanceof Date);
      const detail = await call(app, "GET", `/reputation/reviews/${negativeReviewId}`, manager, A.propertyA);
      assert.equal(detail.body.responseBody, "Gracias por su visita; lamentamos las molestias.");
      assert.ok(detail.body.respondedAt);
      // T8F-02: POST …/respond no escribe topicsJson, pero la bandeja y el detalle leen el estado efectivo `responded`.
      assert.equal(detail.body.status, "responded");
      assert.equal(readReviewMeta((await prisma.guestReview.findUniqueOrThrow({ where: { id: negativeReviewId } })).topicsJson).status, "drafted", "la meta sigue drafted hasta el PATCH o el tick");
      // HP-01 + T8F-02: un PATCH a responded reconcilia la meta y aprueba el ítem HITL del borrador (nunca publica: ya está publicada).
      const patched = await call(app, "PATCH", `/reputation/reviews/${negativeReviewId}`, manager, A.propertyA, { status: "responded", responseSource: "api" });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(patched.body.status, "responded");
      assert.equal(patched.body.draftReviewStatus, "approved");
      assert.equal((await prisma.aiHumanReviewItem.findUniqueOrThrow({ where: { id: draftReviewItemId } })).status, "approved");
      assert.equal(readReviewMeta((await prisma.guestReview.findUniqueOrThrow({ where: { id: negativeReviewId } })).topicsJson).status, "responded");
      assert.equal((await call(app, "POST", `/reputation/reviews/${negativeReviewId}/respond`, manager, A.propertyA, { responseBody: "Otra vez" })).status, 409);
      const responded1 = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1&responded=1`, manager, A.propertyA);
      assert.equal(responded1.body.total, 1);
    }));

  it("caso de calidad desde una reseña positiva (force): 201 con prioridad y título propios, la reseña queda enlazada, QualityCaseCreated auditado; segunda vez 409; ownerUserId ajeno → 400", async () =>
    strict(async () => {
      const slaTargetAt = new Date(NOW.getTime() + 3 * DAY).toISOString();
      const created = await call(app, "POST", `/reputation/reviews/${positiveReviewId}/quality-case`, manager, A.propertyA, { priority: "normal", title: "Revisar wifi de la planta 1", slaTargetAt, ownerUserId: managerId });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.reviewId, positiveReviewId);
      assert.equal(created.body.priority, "normal");
      assert.equal(created.body.title, "Revisar wifi de la planta 1");
      assert.equal(created.body.ownerUserId, managerId);
      assert.equal(created.body.caseType, "review_negative");
      assert.equal(created.body.status, "open");
      assert.equal(new Date(String(created.body.slaTargetAt)).toISOString(), slaTargetAt);
      const caseRow = await prisma.qualityCase.findUniqueOrThrow({ where: { id: created.body.id as string } });
      assert.equal(caseRow.propertyId, A.propertyA);
      const review = await prisma.guestReview.findUniqueOrThrow({ where: { id: positiveReviewId } });
      assert.equal(readReviewMeta(review.topicsJson).qualityCaseId, caseRow.id);
      const again = await call(app, "POST", `/reputation/reviews/${positiveReviewId}/quality-case`, manager, A.propertyA, {});
      assert.equal(again.status, 409);
      assert.equal(detailsCode(again), "QUALITY_CASE_ALREADY_LINKED");
      const other = await prisma.guestReview.findFirstOrThrow({ where: { propertyId: A.propertyA, externalReference: "r-02" } });
      const badOwner = await call(app, "POST", `/reputation/reviews/${other.id}/quality-case`, manager, A.propertyA, { ownerUserId: B.users.owner.id });
      assert.equal(badOwner.status, 400);
      const foreign = await call(app, "POST", `/reputation/reviews/${other.id}/quality-case`, managerB, B.propertyA, {});
      assert.equal(foreign.status, 404);
      const forbidden = await call(app, "POST", `/reputation/reviews/${other.id}/quality-case`, receptionist, A.propertyA, {});
      assert.equal(forbidden.status, 403);
      await flushAuditQueues();
      assert.equal(await prisma.auditEvent.count({ where: { organizationId: A.organizationId, action: "QualityCaseCreated", entityId: caseRow.id } }), 1);
    }));

  it("sincronización manual: csv → run completed con 0 traídas; google → run skipped con motivo; fuente ajena → 404; ejecuciones ordenadas (import incluidos) y filtrables", async () =>
    strict(async () => {
      const csv = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources/${csvSourceId}/sync`, manager, A.propertyA);
      assert.equal(csv.status, 200, JSON.stringify(csv.body));
      const csvRun = csv.body.run as Json;
      assert.equal(csvRun.sourceId, csvSourceId);
      assert.equal(csvRun.trigger, "manual");
      assert.equal(csvRun.status, "completed");
      assert.equal(csvRun.fetched, 0);
      assert.equal((csv.body.summary as Json).propertyId, A.propertyA);
      const google = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources/${googleSourceId}/sync`, manager, A.propertyA);
      assert.equal(google.status, 200, JSON.stringify(google.body));
      assert.equal((google.body.run as Json).status, "skipped");
      assert.ok(typeof (google.body.run as Json).error === "string");
      const foreign = await call(app, "POST", `/reputation/properties/${B.propertyA}/sources/${csvSourceId}/sync`, managerB, B.propertyA);
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.message, "Fuente de reseñas no encontrada.");
      const forbidden = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources/${csvSourceId}/sync`, receptionist, A.propertyA);
      assert.equal(forbidden.status, 403);

      const runs = await call(app, "GET", `/reputation/properties/${A.propertyA}/runs`, manager, A.propertyA);
      assert.equal(runs.status, 200, JSON.stringify(runs.body));
      const list = asArray(runs);
      assert.ok(list.length >= 5, `runs: ${list.length}`);
      for (let i = 1; i < list.length; i += 1) assert.ok(String(list[i - 1]!.startedAt) >= String(list[i]!.startedAt), "orden startedAt desc");
      assert.ok(list.some((run) => run.trigger === "import" && run.sourceId === csvSourceId && run.created === CSV_ROWS.length));
      assert.ok(list.some((run) => run.trigger === "manual" && run.sourceId === googleSourceId && run.status === "skipped"));
      const filtered = await call(app, "GET", `/reputation/properties/${A.propertyA}/runs?sourceId=${googleSourceId}&limit=1`, manager, A.propertyA);
      assert.equal(asArray(filtered).length, 1);
      assert.equal(asArray(filtered)[0]!.sourceId, googleSourceId);
      const bad = await call(app, "GET", `/reputation/properties/${A.propertyA}/runs?limit=0`, manager, A.propertyA);
      assert.equal(bad.status, 400);
      await flushAuditQueues();
      assert.equal(await prisma.auditEvent.count({ where: { organizationId: A.organizationId, action: "ReviewSourceSynced" } }), 2);
    }));

  it("fuentes: PATCH cambia peso y nombre (200, auditado); DELETE → status disabled (sin borrar la fila, las reseñas conservan sourceId); sync de una desactivada → 409; GET la oculta salvo includeDisabled=1", async () =>
    strict(async () => {
      const patched = await call(app, "PATCH", `/reputation/properties/${A.propertyA}/sources/${csvSourceId}`, manager, A.propertyA, { weight: 1.5, displayName: "CSV mensual" });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(patched.body.weight, 1.5);
      assert.equal(patched.body.displayName, "CSV mensual");
      const empty = await call(app, "PATCH", `/reputation/properties/${A.propertyA}/sources/${csvSourceId}`, manager, A.propertyA, {});
      assert.equal(empty.status, 400);
      const foreign = await call(app, "PATCH", `/reputation/properties/${B.propertyA}/sources/${csvSourceId}`, managerB, B.propertyA, { weight: 2 });
      assert.equal(foreign.status, 404);

      const disabled = await call(app, "DELETE", `/reputation/properties/${A.propertyA}/sources/${googleSourceId}`, manager, A.propertyA);
      assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
      assert.equal(disabled.body.status, "disabled");
      assert.equal(await prisma.reviewSource.count({ where: { propertyId: A.propertyA } }), 3, "csv, google y la fuente CSV de Booking; nada se borra");
      const conflict = await call(app, "POST", `/reputation/properties/${A.propertyA}/sources/${googleSourceId}/sync`, manager, A.propertyA);
      assert.equal(conflict.status, 409);
      assert.equal(detailsCode(conflict), "REVIEW_SOURCE_DISABLED");
      const visible = await call(app, "GET", `/reputation/properties/${A.propertyA}/sources`, manager, A.propertyA);
      assert.equal(asArray(visible).some((source) => source.id === googleSourceId), false);
      const all = await call(app, "GET", `/reputation/properties/${A.propertyA}/sources?includeDisabled=1`, manager, A.propertyA);
      assert.equal(asArray(all).some((source) => source.id === googleSourceId && source.status === "disabled"), true);
      const forbidden = await call(app, "DELETE", `/reputation/properties/${A.propertyA}/sources/${csvSourceId}`, receptionist, A.propertyA);
      assert.equal(forbidden.status, 403);
      const reviews = await prisma.guestReview.findMany({ where: { propertyId: A.propertyA, source: "csv" } });
      assert.equal(reviews.length, CSV_ROWS.length);
      for (const row of reviews) assert.equal(readReviewMeta(row.topicsJson).sourceId, csvSourceId);
      await flushAuditQueues();
      assert.equal(await prisma.auditEvent.count({ where: { organizationId: A.organizationId, action: "ReviewSourceUpdated" } }), 1);
      assert.equal(await prisma.auditEvent.count({ where: { organizationId: A.organizationId, action: "ReviewSourceDisabled" } }), 1);
    }));

  it("aislamiento: la organización B no ve nada de A (bandeja vacía, fuentes vacías) y sus propias escrituras no tocan A", async () =>
    strict(async () => {
      const inbox = await call(app, "GET", `/reputation/properties/${B.propertyA}/inbox?envelope=1`, managerB, B.propertyA);
      assert.equal(inbox.status, 200);
      assert.equal(inbox.body.total, 0);
      const sources = await call(app, "GET", `/reputation/properties/${B.propertyA}/sources`, managerB, B.propertyA);
      assert.deepEqual(asArray(sources), []);
      const crossProperty = await call(app, "GET", `/reputation/properties/${A.propertyA}/inbox?envelope=1`, managerB, B.propertyA);
      assert.equal(crossProperty.status, 404, "propiedad de otra organización: 404 opaco del guard de tenencia");
      assert.equal(await prisma.guestReview.count({ where: { propertyId: B.propertyA } }), 0);
    }));
});
