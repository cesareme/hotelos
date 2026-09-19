// El partial del manifiesto debe cubrir TODAS las rutas registradas en
// pms-shadow.routes.ts y ninguna más (clon de pms/__tests__/reservation-import-routes.test.mts):
// `assertRoutePermission` responde 403 a cualquier no-GET sin entrada y el contrato del
// repo parsea el partial con una regex. Este test lee el array vivo y pina los riesgos y
// permisos del diseño (§10 nº 17: sin claves nuevas), la ruta pública (a′: prefijo en
// PUBLIC_PREFIXES ⇔ riskLevel public), las opciones de cuerpo / rate limit de las
// subidas, el orden (literales antes que :id) y el cableado en security/route-permissions.ts,
// server.ts, lib/tenancy.ts, lib/auth-context.ts, marketplace/oauth.service.ts, lib/env.ts y
// package.json. Desde apps/api:
//   node --import tsx --test src/modules/pms-shadow/__tests__/pms-shadow-routes.test.mts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pmsShadowRoutePermissions } from "../route-permissions.partial.js";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const source = read("../pms-shadow.routes.ts");
const registered = [...source.matchAll(/\bapp\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)].map((m) => `${(m[1] as string).toUpperCase()} ${m[2]}`);
const manifest = pmsShadowRoutePermissions.map((e) => `${e.method} ${e.path}`);
const byKey = new Map(pmsShadowRoutePermissions.map((e) => [`${e.method} ${e.path}`, e] as const));

const INGEST = "/integrations/pms-shadow/ingest";
const BASE = "/properties/:propertyId/pms-shadow";
const UPLOAD_OPTIONS = 'const UPLOAD_OPTIONS = { bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };';

describe("pms-shadow — partial de permisos de las rutas", () => {
  it("registra exactamente 15 rutas y cada una tiene exactamente una entrada en el manifiesto (y viceversa)", () => {
    assert.equal(registered.length, 15, `rutas extraídas: ${registered.join(", ")}`);
    assert.equal(pmsShadowRoutePermissions.length, 15);
    const missing = registered.filter((r) => !manifest.includes(r));
    assert.deepEqual(missing, [], `rutas sin entrada en el manifiesto: ${missing.join(", ")}`);
    const orphans = manifest.filter((m) => !registered.includes(m));
    assert.deepEqual(orphans, [], `entradas del manifiesto sin ruta: ${orphans.join(", ")}`);
    assert.equal(new Set(manifest).size, manifest.length, "entradas duplicadas en el manifiesto");
    assert.equal(new Set(registered).size, registered.length, "rutas registradas dos veces");
  });

  it("las 15 rutas del diseño, en orden: ingest pública primero y literales antes que :id", () => {
    assert.deepEqual(registered, [
      `POST ${INGEST}`,
      `GET ${BASE}/overview`,
      `GET ${BASE}/profile`,
      `PUT ${BASE}/profile`,
      `GET ${BASE}/runs`,
      `POST ${BASE}/runs`,
      `GET ${BASE}/runs/:id`,
      `GET ${BASE}/alerts`,
      `POST ${BASE}/alerts/:id/resolve`,
      `GET ${BASE}/reconciliation`,
      `POST ${BASE}/revenue/preview`,
      `POST ${BASE}/revenue`,
      `GET ${BASE}/revenue`,
      `GET ${BASE}/revenue/:id`,
      `POST ${BASE}/revenue/:id/reverse`
    ]);
    assert.ok(registered.indexOf(`GET ${BASE}/runs`) < registered.indexOf(`GET ${BASE}/runs/:id`));
    assert.ok(registered.indexOf(`POST ${BASE}/revenue/preview`) < registered.indexOf(`POST ${BASE}/revenue/:id/reverse`));
    assert.ok(registered.indexOf(`GET ${BASE}/revenue`) < registered.indexOf(`GET ${BASE}/revenue/:id`));
  });

  it("riesgos y permisos: pública sin claves; lecturas integrations.read / accounting.read low; escrituras integrations.connect high; ingresos accounting.journal.post medium/high/critical", () => {
    assert.deepEqual(byKey.get(`POST ${INGEST}`), { method: "POST", path: INGEST, permissions: [], riskLevel: "public" });
    for (const path of [`${BASE}/overview`, `${BASE}/profile`, `${BASE}/runs`, `${BASE}/runs/:id`, `${BASE}/alerts`]) {
      assert.deepEqual(byKey.get(`GET ${path}`)?.permissions, ["integrations.read"], path);
      assert.equal(byKey.get(`GET ${path}`)?.riskLevel, "low", path);
    }
    for (const key of [`PUT ${BASE}/profile`, `POST ${BASE}/runs`, `POST ${BASE}/alerts/:id/resolve`]) {
      assert.deepEqual(byKey.get(key)?.permissions, ["integrations.connect"], key);
      assert.equal(byKey.get(key)?.riskLevel, "high", key);
    }
    for (const path of [`${BASE}/reconciliation`, `${BASE}/revenue`, `${BASE}/revenue/:id`]) {
      assert.deepEqual(byKey.get(`GET ${path}`)?.permissions, ["accounting.read"], path);
      assert.equal(byKey.get(`GET ${path}`)?.riskLevel, "low", path);
    }
    assert.deepEqual(byKey.get(`POST ${BASE}/revenue/preview`)?.permissions, ["accounting.journal.post"]);
    assert.equal(byKey.get(`POST ${BASE}/revenue/preview`)?.riskLevel, "medium", "previsualizar nunca escribe");
    assert.deepEqual(byKey.get(`POST ${BASE}/revenue`)?.permissions, ["accounting.journal.post"]);
    assert.equal(byKey.get(`POST ${BASE}/revenue`)?.riskLevel, "high");
    assert.deepEqual(byKey.get(`POST ${BASE}/revenue/:id/reverse`)?.permissions, ["accounting.journal.post"]);
    assert.equal(byKey.get(`POST ${BASE}/revenue/:id/reverse`)?.riskLevel, "critical", "reverso de un asiento");
    const publicEntries = pmsShadowRoutePermissions.filter((entry) => entry.riskLevel === "public");
    assert.deepEqual(publicEntries.map((entry) => entry.path), [INGEST], "solo el ingest es público");
    for (const entry of pmsShadowRoutePermissions) {
      if (entry.riskLevel === "public") continue;
      assert.ok(entry.permissions.length >= 1, `${entry.method} ${entry.path} sin permisos`);
      for (const key of entry.permissions) assert.match(key, /^(integrations\.(read|connect)|accounting\.(read|journal\.post))$/, `${entry.path}: clave existente, sin rbac:sync`);
    }
  });

  it("subidas con bodyLimit 8 MiB y rate limit 30/min; 202 en ingest y run manual; 201 en ingresos; :id por assertEntityAccess con propertyId; esquemas strict", () => {
    assert.ok(source.includes(UPLOAD_OPTIONS), "opciones literales de subida");
    assert.equal((source.match(/, UPLOAD_OPTIONS, /g) ?? []).length, 4, "ingest, run manual, preview e import de ingresos amplían el cuerpo");
    assert.equal((source.match(/reply\.code\(202\)\.send\(/g) ?? []).length, 2, "ingest y run manual responden 202 con el run cerrado");
    assert.match(source, /reply\.code\(201\)\.send\(record\)/);
    assert.match(source, /assertEntityAccess\(request, \{ entity: "pmsShadowRun", id, propertyId \}\)/);
    assert.match(source, /assertEntityAccess\(request, \{ entity: "pmsShadowAlert", id, propertyId \}\)/);
    assert.equal((source.match(/assertEntityAccess\(request, \{ entity: "pmsShadowRevenueImport", id, propertyId \}\)/g) ?? []).length, 2, "GET revenue/:id y reverse");
    for (const schema of ["IngestSchema", "ManualRunSchema", "ProfileUpsertSchema", "RunsQuerySchema", "AlertsQuerySchema", "ResolveAlertSchema", "ReconciliationQuerySchema", "RevenuePreviewSchema", "RevenueImportSchema", "RevenueListQuerySchema", "RevenueReverseSchema"]) {
      assert.match(source, new RegExp(`parseOr400\\(${schema},`), schema);
    }
    assert.match(source, /createId\("corr"\)/);
  });

  it("ingest: clave verificada en el handler ANTES del cuerpo, 401 único, tenencia por assertPropertyInOrg(body.propertyId, devApp.organizationId), contexto de sistema, source api_key", () => {
    const at = source.indexOf(`app.post("${INGEST}"`);
    const handler = source.slice(at, source.indexOf("app.get(", at));
    const authAt = handler.indexOf("authenticateIngestApiKey(prisma, request.headers[PMS_SHADOW_INGEST_HEADER])");
    const bodyAt = handler.indexOf("parseOr400(IngestSchema");
    assert.ok(authAt >= 0 && bodyAt > authAt, "la clave se verifica antes de validar el cuerpo");
    assert.match(handler, /const devApp = await authenticateIngestApiKey/, "el resultado se llama devApp (no app)");
    assert.match(handler, /if \(!devApp\) throw ingestUnauthorizedError\(\);/);
    assert.match(handler, /assertPropertyInOrg\(body\.propertyId, devApp\.organizationId\)/);
    assert.match(handler, /systemContext\(devApp\.organizationId, body\.propertyId\)/);
    assert.match(handler, /source: "api_key"/);
    assert.match(handler, /createdBy: `developer_app:\$\{devApp\.clientId\}`/);
    assert.ok(!/request\.userContext/.test(handler), "el ingest nunca usa el contexto de personal");
    assert.match(source.slice(source.indexOf(`app.post("${BASE}/runs"`)), /source: "manual"/);
  });

  it("cableado: spread en security/route-permissions.ts, registro en server.ts, resolvers de tenencia, prefijo público, scope OAuth, contrato de entorno y script del CLI", () => {
    const manifestSource = read("../../../security/route-permissions.ts");
    assert.match(manifestSource, /import \{ pmsShadowRoutePermissions as pmsShadowRoutePermissionsAsWritten \} from "\.\.\/modules\/pms-shadow\/route-permissions\.partial\.js";/);
    assert.match(manifestSource, /const pmsShadowRoutePermissions = requireAccountingReportsKey\(pmsShadowRoutePermissionsAsWritten\);/, "las lecturas con importes pasan a accounting.reports.read en el manifiesto en vigor (t6#9)");
    assert.match(manifestSource, /^\s*\.\.\.pmsShadowRoutePermissions,$/m);
    assert.ok(manifestSource.indexOf("...reservationImportRoutePermissions,") < manifestSource.indexOf("...pmsShadowRoutePermissions,"), "tras el partial de importación de reservas");
    assert.match(manifestSource, /OPERA Cloud modo sombra \(Tanda 7b\): 15 entradas/);

    const server = read("../../../server.ts");
    assert.match(server, /import \{ registerPmsShadowRoutes \} from "\.\/modules\/pms-shadow\/pms-shadow\.routes\.js";/);
    assert.match(server, /^\s*registerPmsShadowRoutes\(app\);$/m);
    assert.ok(server.indexOf("registerReservationImportRoutes(app);") < server.indexOf("registerPmsShadowRoutes(app);"), "registrado tras las rutas de importación");
    assert.match(server, /import \{ startPmsShadowJob \} from "\.\/modules\/pms-shadow\/pms-shadow\.job\.js";/);
    assert.match(server, /if \(schedulerLeader && process\.env\.PMS_SHADOW_JOB_DISABLED !== "true"\) \{/, "job bajo el líder");
    assert.match(server, /startPmsShadowJob\(\{ log: app\.log, intervalMs: Number\(process\.env\.PMS_SHADOW_JOB_INTERVAL_MS \?\? 15 \* 60 \* 1000\) \}\)/);
    assert.match(server, /shutdown\.register\("pms-shadow\.job", job\.stop\);/);
    assert.match(server, /parseOr400\(CreateEmailConnectionSchema, request\.body \?\? \{\}, "body"\)/, "POST …/email/connections valida el cuerpo strict");

    const tenancy = read("../../../lib/tenancy.ts");
    assert.match(tenancy, /pmsShadowRun: byProperty\("Corte OPERA no encontrado\.", \(id\) =>\s*prisma\.pmsShadowRun\.findUnique\(\{ where: \{ id \}, select: selectProperty \}\)/);
    assert.match(tenancy, /pmsShadowAlert: byProperty\("Alerta no encontrada\.", \(id\) =>\s*prisma\.pmsShadowAlert\.findUnique\(\{ where: \{ id \}, select: selectProperty \}\)/);
    assert.match(tenancy, /pmsShadowRevenueImport: byProperty\("Importación de ingresos no encontrada\.", \(id\) =>\s*prisma\.pmsShadowRevenueImport\.findUnique\(\{ where: \{ id \}, select: selectProperty \}\)/);

    const authContext = read("../../../lib/auth-context.ts");
    assert.match(authContext, /^\s*"\/integrations\/pms-shadow\/ingest"\s*$/m, "prefijo público exacto (no /properties/…)");
    assert.ok(!/"\/properties\/:propertyId\/pms-shadow/.test(authContext), "ninguna ruta de /properties es pública");

    const oauth = read("../../marketplace/oauth.service.js".replace(/\.js$/, ".ts"));
    assert.match(oauth, /"pms\.shadow\.ingest"/);

    const env = read("../../../lib/env.ts");
    assert.match(env, /import \{ PMS_SHADOW_ENV_CONTRACT \} from "\.\.\/modules\/pms-shadow\/env\.partial\.js";/);
    assert.match(env, /^\s*\.\.\.PMS_SHADOW_ENV_CONTRACT,$/m);
    assert.match(env, /modo sombra OPERA/);
    const envPartial = read("../env.partial.ts");
    assert.match(envPartial, /PMS_SHADOW_JOB_DISABLED: \{\s*section: "Schedulers",\s*format: "bool",\s*default: "false"/);
    assert.match(envPartial, /PMS_SHADOW_JOB_INTERVAL_MS: \{\s*section: "Schedulers",\s*format: "int",\s*min: 10_000,\s*max: 86_400_000,\s*default: "900000"/);

    const pkg = JSON.parse(read("../../../../package.json")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["pms-shadow:pull"], "node --env-file-if-exists=../../.env --import tsx src/scripts/pms-shadow-pull.ts");
    const cli = read("../../../scripts/pms-shadow-pull.ts");
    assert.ok(!/process\.env\./.test(cli), "el CLI no lee variables de entorno (corrección g)");
  });
});
