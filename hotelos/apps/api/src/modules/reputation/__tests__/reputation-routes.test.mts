// El partial del manifiesto debe cubrir TODAS las rutas registradas en
// reputation.routes.ts y ninguna más (clon de los dos primeros `it` de
// pms-shadow/__tests__/pms-shadow-routes.test.mts; los asertos de cableado en
// server.ts / route-permissions.ts / env.ts NO se clonan: en la Tanda T8 el
// cableado es del integrador y va como mergeLines). Este test lee el array vivo
// y pina: 12 rutas == 12 entradas (sin huérfanos ni duplicados), el orden
// (literales antes que :id), riesgos y permisos exactos (sin claves nuevas),
// que ninguna de las 12 coincide con las 8 rutas vivas del motor genérico en
// server.ts ni termina en /dashboard, que el fichero no importa lib/llm ni
// ai-tools, el gate de módulo, las opciones literales de la subida y que el
// partial se parsea con la misma regex que tests/api-route-permissions-contract.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-routes.test.mts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { reputationRoutePermissions } from "../route-permissions.partial.js";
import { DRAFT_TONE_TO_PORT, IMPORT_MAX_ANALYSIS, importRowsToCsv } from "../reputation.routes.js";
import { IMPORT_MAX_BASE64_CHARS, IMPORT_MAX_ROWS, ImportSchema, InboxQuerySchema, ReviewPatchSchema, SourceCreateSchema } from "../../../schemas/reputation.schemas.js";
import { CSV_MAX_ROWS, parseReviewCsv } from "../review-csv.parser.js";
import { RESPONSE_TONES } from "../reputation-ai.port.js";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const source = read("../reputation.routes.ts");
const partialSource = read("../route-permissions.partial.ts");
const server = read("../../../server.ts");
const registered = [...source.matchAll(/\bapp\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)].map((m) => `${(m[1] as string).toUpperCase()} ${m[2]}`);
const manifest = reputationRoutePermissions.map((e) => `${e.method} ${e.path}`);
const byKey = new Map(reputationRoutePermissions.map((e) => [`${e.method} ${e.path}`, e] as const));

const PROPERTY = "/reputation/properties/:propertyId";
const REVIEW = "/reputation/reviews/:id";
const IMPORT_OPTIONS = 'const IMPORT_OPTIONS = { bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };';
const MODULE_GATE = 'throw new ForbiddenError("El módulo reputation_quality no está activado en esta propiedad.");';

/** Las 8 rutas vivas del motor genérico (server.ts:3246-3277) que T8 NO mueve ni repite. */
const LEGACY_ROUTES = [
  "GET /reputation/properties/:propertyId/reviews",
  "POST /reputation/reviews/:id/respond",
  "GET /quality/properties/:propertyId/cases",
  "POST /quality/properties/:propertyId/cases",
  "PATCH /quality/cases/:id",
  "GET /surveys/properties/:propertyId",
  "POST /surveys/properties/:propertyId",
  "POST /surveys/:id/responses"
];

describe("reputación — partial de permisos de las rutas", () => {
  it("registra exactamente 12 rutas y cada una tiene exactamente una entrada en el manifiesto (y viceversa)", () => {
    assert.equal(registered.length, 12, `rutas extraídas: ${registered.join(", ")}`);
    assert.equal(reputationRoutePermissions.length, 12);
    const missing = registered.filter((r) => !manifest.includes(r));
    assert.deepEqual(missing, [], `rutas sin entrada en el manifiesto: ${missing.join(", ")}`);
    const orphans = manifest.filter((m) => !registered.includes(m));
    assert.deepEqual(orphans, [], `entradas del manifiesto sin ruta: ${orphans.join(", ")}`);
    assert.equal(new Set(manifest).size, manifest.length, "entradas duplicadas en el manifiesto");
    assert.equal(new Set(registered).size, registered.length, "rutas registradas dos veces");
  });

  it("las 12 rutas del lote, en orden: literales antes que :id", () => {
    assert.deepEqual(registered, [
      `GET ${PROPERTY}/inbox`,
      `GET ${PROPERTY}/sources`,
      `POST ${PROPERTY}/sources`,
      `GET ${PROPERTY}/runs`,
      `POST ${PROPERTY}/imports`,
      `PATCH ${PROPERTY}/sources/:id`,
      `DELETE ${PROPERTY}/sources/:id`,
      `POST ${PROPERTY}/sources/:id/sync`,
      `GET ${REVIEW}`,
      `PATCH ${REVIEW}`,
      `POST ${REVIEW}/draft`,
      `POST ${REVIEW}/quality-case`
    ]);
    assert.ok(registered.indexOf(`GET ${PROPERTY}/sources`) < registered.indexOf(`PATCH ${PROPERTY}/sources/:id`));
    assert.ok(registered.indexOf(`POST ${PROPERTY}/imports`) < registered.indexOf(`POST ${PROPERTY}/sources/:id/sync`));
    assert.ok(registered.indexOf(`POST ${PROPERTY}/sources`) < registered.indexOf(`GET ${REVIEW}`), "las rutas de propiedad van antes que las de reseña");
  });

  it("riesgos y permisos exactos: lecturas reputation.read (inbox/detalle medium, fuentes/ejecuciones low); escrituras reputation.respond high; caso de calidad quality_cases.manage medium", () => {
    assert.deepEqual(byKey.get(`GET ${PROPERTY}/inbox`), { method: "GET", path: `${PROPERTY}/inbox`, permissions: ["reputation.read"], riskLevel: "medium" });
    assert.deepEqual(byKey.get(`GET ${REVIEW}`), { method: "GET", path: REVIEW, permissions: ["reputation.read"], riskLevel: "medium" });
    for (const path of [`${PROPERTY}/sources`, `${PROPERTY}/runs`]) {
      assert.deepEqual(byKey.get(`GET ${path}`)?.permissions, ["reputation.read"], path);
      assert.equal(byKey.get(`GET ${path}`)?.riskLevel, "low", path);
    }
    for (const key of [`POST ${PROPERTY}/sources`, `PATCH ${PROPERTY}/sources/:id`, `DELETE ${PROPERTY}/sources/:id`, `POST ${PROPERTY}/sources/:id/sync`, `POST ${PROPERTY}/imports`, `PATCH ${REVIEW}`, `POST ${REVIEW}/draft`]) {
      assert.deepEqual(byKey.get(key)?.permissions, ["reputation.respond"], key);
      assert.equal(byKey.get(key)?.riskLevel, "high", key);
    }
    // HP-05: la única ruta que no exigía una clave reputation.* exponía el texto de la reseña con solo quality_cases.manage.
    assert.deepEqual(byKey.get(`POST ${REVIEW}/quality-case`), { method: "POST", path: `${REVIEW}/quality-case`, permissions: ["quality_cases.manage", "reputation.read"], riskLevel: "medium" });
    for (const entry of reputationRoutePermissions) {
      assert.ok(entry.permissions.length >= 1, `${entry.method} ${entry.path} sin permisos`);
      assert.notEqual(entry.riskLevel, "public", `${entry.path}: ninguna ruta de reputación es pública`);
      for (const key of entry.permissions) assert.match(key, /^(reputation\.(read|respond)|quality_cases\.manage)$/, `${entry.path}: clave existente (permissions.ts:179-184), sin reputation.manage ni rbac:sync`);
    }
  });

  it("no repite ninguna de las 8 rutas vivas del motor (server.ts) ni termina en /dashboard; las 8 siguen en server.ts", () => {
    for (const legacy of LEGACY_ROUTES) {
      assert.ok(!registered.includes(legacy), `${legacy} se registra en server.ts, no aquí`);
      assert.ok(!manifest.includes(legacy), `${legacy} tiene su entrada en el manifiesto principal, no en el partial`);
      const [method, path] = legacy.split(" ") as [string, string];
      assert.ok(server.includes(`app.${method.toLowerCase()}("${path}"`), `${legacy} debe seguir viva en server.ts`);
    }
    for (const key of [...registered, ...manifest]) assert.doesNotMatch(key, /\/dashboard$/, `${key}: /dashboard está retirada (l2-motor-generico.test.mts:444-456)`);
    assert.ok(!registered.some((key) => key.startsWith("GET /reputation/properties/:propertyId/reviews")), "la lista del motor no se mueve");
  });

  it("sin IA directa (ni lib/llm ni ai-tools ni variables de entorno), gate de módulo, tenencia por assertPropertyEntityAccess(guestReview), zod strict y correlación", () => {
    const code = source
      .split("\n")
      .map((line) => (line.trim().startsWith("//") ? "" : line))
      .join("\n");
    assert.ok(!/lib\/llm|ai-tools|ai-operations|process\.env\.|\benv\.[A-Z_]+/.test(code), "la IA entra por ReputationAiPort y el entorno por options");
    assert.ok(!/from "\.\.\/\.\.\/lib\/env\.js"/.test(code), "sin lib/env");
    assert.match(source, /getReputationAiPort/);
    assert.match(source, /getEnabledModuleCodes\(propertyId\)\.includes\(REPUTATION_MODULE_CODE\)/);
    assert.ok(source.includes(MODULE_GATE), "texto del gate idéntico al de advanced-modules.service.ts:426-431");
    assert.equal((source.match(/requireReputationModule\(propertyId\);/g) ?? []).length, 12, "las 12 rutas pasan por el gate");
    assert.equal((source.match(/assertPropertyEntityAccess\(request, \{ entity: "guestReview", id \}\)/g) ?? []).length, 4, "las 4 rutas de :id de reseña resuelven la propiedad de la fila");
    assert.equal((source.match(/createId\("corr"\)/g) ?? []).length, 9, "correlationId en cada escritura");
    for (const schema of ["InboxQuerySchema", "SourcesQuerySchema", "SourceCreateSchema", "RunsQuerySchema", "ImportSchema", "SourceUpdateSchema", "ReviewPatchSchema", "DraftSchema", "QualityCaseFromReviewSchema"]) {
      assert.match(source, new RegExp(`parseOr400\\(${schema},`), schema);
    }
    assert.match(source, /"Fuente de reseñas no encontrada\."/, "404 opaco de fuente");
    assert.match(source, /"Reseña no encontrada\."/, "404 opaco de reseña");
  });

  it("importación: opciones literales (4 MiB, 10/min), una sola ruta con ellas, 201 ImportResult y filas JSON → CSV canónico que el parser acepta", () => {
    assert.ok(source.includes(IMPORT_OPTIONS), "opciones literales de la subida");
    assert.equal((source.match(/, IMPORT_OPTIONS, /g) ?? []).length, 1, "solo la importación amplía el cuerpo");
    assert.match(source, /reply\.code\(201\)\.send\(result\)/);
    assert.equal(IMPORT_MAX_ROWS, CSV_MAX_ROWS);
    assert.equal(IMPORT_MAX_BASE64_CHARS, 2_800_000);
    assert.ok(IMPORT_MAX_ANALYSIS > 0 && IMPORT_MAX_ANALYSIS <= 500);
    const csv = importRowsToCsv([
      { externalId: "j-1", date: "2026-09-10", rating: 4, scaleMax: 5, title: 'Título con "comillas"', body: "Línea uno, con coma", language: "es", author: "Huésped Ficticio", country: "es", url: "https://example.test/r/1" },
      { date: "2026-09-11", rating: "8,5", scaleMax: 10, body: "Sin título" }
    ]);
    const parsed = parseReviewCsv(csv, { source: "csv" });
    assert.equal(parsed.rows.length, 2);
    assert.deepEqual(parsed.invalid, []);
    assert.equal(parsed.rows[0]?.externalId, "j-1");
    assert.equal(parsed.rows[0]?.title, 'Título con "comillas"');
    assert.equal(parsed.rows[0]?.body, "Línea uno, con coma");
    assert.equal(parsed.rows[0]?.authorCountry, "ES");
    assert.equal(parsed.rows[1]?.ratingRaw, 8.5);
  });

  it("esquemas strict con mensajes en español; los tonos del cable se traducen a los del puerto de IA", () => {
    assert.equal(InboxQuerySchema.safeParse({ status: "new", minScore: "5", responded: "1", limit: "10" }).success, true);
    const unknown = InboxQuerySchema.safeParse({ foo: "1" });
    assert.equal(unknown.success, false);
    assert.match(unknown.success ? "" : (unknown.error.issues[0]?.message ?? ""), /no admitido/);
    assert.equal(InboxQuerySchema.safeParse({ minScore: "8", maxScore: "2" }).success, false, "minScore > maxScore");
    assert.equal(ReviewPatchSchema.safeParse({}).success, false, "PATCH vacío");
    assert.equal(ReviewPatchSchema.safeParse({ responseBody: "nunca por PATCH" }).success, false, "responseBody solo por POST …/respond");
    assert.equal(SourceCreateSchema.safeParse({ provider: "google", accessToken: "x" }).success, false);
    assert.equal(ImportSchema.safeParse({ source: "csv" }).success, false, "sin contenido");
    assert.equal(ImportSchema.safeParse({ source: "csv", contentBase64: "QQ==", rows: [{ date: "2026-01-01" }] }).success, false, "contenido y filas a la vez");
    assert.equal(ImportSchema.safeParse({ source: "booking", rows: [{ date: "2026-01-01", rating: 8 }] }).success, true);
    for (const tone of Object.values(DRAFT_TONE_TO_PORT)) assert.ok((RESPONSE_TONES as readonly string[]).includes(tone), tone);
    assert.deepEqual(Object.keys(DRAFT_TONE_TO_PORT).sort(), ["breve", "cordial", "formal"]);
  });

  it("el partial es el PRIMER array exportado, cada entrada cumple la regex del contrato raíz y la cabecera documenta las mergeLines", () => {
    const stripped = partialSource
      .split("\n")
      .map((line) => (line.trim().startsWith("//") ? "" : line))
      .join("\n");
    const decl = /export const \w+(?:: ApiRoutePermission\[\])? = \[/.exec(stripped);
    assert.ok(decl, "array exportado no encontrado");
    assert.match(stripped.slice(decl!.index, decl!.index + 80), /export const reputationRoutePermissions: ApiRoutePermission\[\] = \[/);
    const end = stripped.indexOf("\n];", decl!.index);
    const body = stripped.slice(decl!.index, end);
    const entryPattern = /\{\s*method:\s*"(GET|POST|PATCH|DELETE|PUT)"\s*,\s*path:\s*"([^"]+)"\s*,\s*permissions:\s*\[([^\]]*)\]\s*,\s*riskLevel:\s*"(\w+)"\s*\}/g;
    const entries = [...body.matchAll(entryPattern)];
    assert.equal(entries.length, 12);
    assert.equal((body.match(/\bmethod:\s*"/g) ?? []).length, 12, "ninguna entrada se desvía de la forma { method, path, permissions, riskLevel }");
    assert.equal((stripped.match(/^export const /gm) ?? []).length, 1, "un único export: el contrato lee el primero");
    assert.match(partialSource, /import type \{ ApiRoutePermission \} from "\.\.\/\.\.\/security\/route-permissions\.js";/);
    assert.match(partialSource, /\.\.\.reputationRoutePermissions,/, "la cabecera trae la línea del spread");
    assert.match(partialSource, /registerReputationRoutes\(app\);/, "la cabecera trae la línea del registro");
    assert.match(partialSource, /reputation\.manage/, "documenta que no existe reputation.manage");
  });
});
