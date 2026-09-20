/**
 * Tanda T9 · lote T9-05b — cableado compartido del módulo de documentos:
 *   · GET /health expone `dependencies.objectStorage` con el tipo de almacén que
 *     sirve el API (inline sin configurar nada, disk con DOCUMENT_STORAGE_DIR) sin
 *     revelar rutas ni endpoints y sin degradar `status` (queda fuera de `checks`);
 *   · las rutas nuevas del módulo (entradas del manifiesto con documents.capture)
 *     responden 401 sin token y 403 a un usuario autenticado sin la clave
 *     (contable del tenant aislado: documents.review + archive.read, sin capture),
 *     con RBAC_STRICT=true y auth real (STRICT_ENV de helpers/l2-tenant.mts);
 *   · el manifiesto lleva los dos spreads de los partials de documentos.
 * Postgres real, tenant aislado creado y borrado por la suite; invariantes de
 * Faranda idénticas antes y después. Datos FICTICIOS.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/documents-health.test.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;
type FarandaInvariants = Awaited<ReturnType<typeof farandaInvariants>>;

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { describeDocumentStorageHealth, resetDocumentsConfigForTests } = await import("../../apps/api/src/modules/documents/documents.config.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type HealthBody = Json & { status: string; ok: boolean; dependencies: Record<string, string>; checks: Record<string, { ok: boolean }> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function health(app: ApiApp): Promise<{ status: number; body: HealthBody; raw: string }> {
  const res = await app.inject({ method: "GET", url: "/health" });
  return { status: res.statusCode, body: JSON.parse(res.body) as HealthBody, raw: res.body };
}

/** Sustituye cada `:param` de la ruta del manifiesto por el hotel A o por un id ficticio (el permiso se evalúa antes de cualquier búsqueda). */
function concreteUrl(path: string, propertyId: string): string {
  return path.replace(/:propertyId/g, propertyId).replace(/:[A-Za-z]+/g, "t905b_ficticio");
}

const captureEntries = routePermissionManifest.filter((entry) => (entry.permissions as readonly string[]).includes("documents.capture"));

let app: ApiApp;
let tenant: IsolatedTenant;
let accountant: Session;
let receptionist: Session;
let invariantsBefore: FarandaInvariants;
let tmpDir = "";

describe("T9-05b · /health objectStorage y RBAC de las rutas de documentos", () => {
  before(async () => {
    invariantsBefore = await farandaInvariants();
    tenant = await createIsolatedTenant(newRunId());
    app = await buildApiServer();
    await app.ready();
    await strict(async () => {
      accountant = await loginOrThrow(app, tenant.users.accountant.email, tenant.password, "t905b-accountant");
      receptionist = await loginOrThrow(app, tenant.users.receptionist.email, tenant.password, "t905b-receptionist");
    });
  });

  after(async () => {
    resetDocumentsConfigForTests();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    await app?.close();
    if (tenant) await cleanupTenant(tenant.organizationId);
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las invariantes de Faranda deben ser idénticas antes y después");
  });

  it("GET /health: dependencies.objectStorage es el tipo de almacén (inline|disk), sin «/» ni «http», fuera de checks y sin degradar status", async () => {
    const { status, body } = await health(app);
    assert.equal(status, 200);
    const objectStorage = body.dependencies.objectStorage;
    assert.ok(objectStorage === "inline" || objectStorage === "disk", `objectStorage=${objectStorage}`);
    assert.equal(objectStorage, describeDocumentStorageHealth());
    assert.doesNotMatch(objectStorage!, /[/]|http/i);
    assert.equal("objectStorage" in body.checks, false, "objectStorage no es un check: no degrada");
    const checksOk = Object.values(body.checks).every((check) => check.ok);
    assert.equal(body.ok, checksOk);
    assert.equal(body.status, checksOk ? "healthy" : "degraded");
    for (const key of ["DOCUMENT_STORAGE_DIR", "DOCUMENT_S3_ENDPOINT", "DOCUMENT_S3_BUCKET"]) {
      assert.equal(key in body.dependencies, false, key);
    }
  });

  it("con DOCUMENT_STORAGE_KIND=disk el mismo proceso responde «disk» y el cuerpo nunca contiene el directorio; al restaurar vuelve al valor del entorno", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ehotelos-t905b-"));
    const baseline = (await health(app)).body.dependencies.objectStorage;
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_STORAGE_DIR: tmpDir, DOCUMENT_ENCRYPT_AT_REST: "false" });
    try {
      const { body, raw } = await health(app);
      assert.equal(body.dependencies.objectStorage, "disk");
      assert.equal(raw.includes(tmpDir), false, "el directorio del almacén no sale en /health");
      assert.equal(raw.includes("ehotelos-t905b-"), false);
    } finally {
      resetDocumentsConfigForTests();
    }
    assert.equal((await health(app)).body.dependencies.objectStorage, baseline);
  });

  it("el manifiesto hace spread de los dos partials de documentos", () => {
    const source = readFileSync(new URL("../../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
    assert.match(source, /^\s*\.\.\.documentsRoutePermissions,$/m);
    assert.match(source, /^\s*\.\.\.documentPipelineRoutePermissions,$/m);
    assert.match(source, /import \{ documentsRoutePermissions \} from "\.\.\/modules\/documents\/route-permissions\.partial\.js";/);
    assert.match(source, /import \{ documentPipelineRoutePermissions \} from "\.\.\/modules\/documents\/pipeline-route-permissions\.partial\.js";/);
  });

  it("rutas con documents.capture: 401 sin token, 403 con el contable (sin la clave) y ni 401 ni 403 con recepción (con la clave)", async () => {
    assert.ok(captureEntries.length > 0, "el manifiesto vivo no tiene ninguna entrada con documents.capture (partial de T9-05a sin cablear)");
    await strict(async () => {
      for (const entry of captureEntries) {
        const url = concreteUrl(entry.path, tenant.propertyA);
        const payload = entry.method === "GET" || entry.method === "DELETE" ? {} : { payload: {} };
        const anonymous = await app.inject({ method: entry.method, url, ...payload });
        assert.equal(anonymous.statusCode, 401, `${entry.method} ${url} sin token → ${anonymous.statusCode}: ${anonymous.body}`);

        const forbidden = await app.inject({ method: entry.method, url, headers: { ...accountant.headers, "x-property-id": tenant.propertyA }, ...payload });
        assert.equal(forbidden.statusCode, 403, `${entry.method} ${url} contable → ${forbidden.statusCode}: ${forbidden.body}`);

        const allowed = await app.inject({ method: entry.method, url, headers: { ...receptionist.headers, "x-property-id": tenant.propertyA }, ...payload });
        assert.notEqual(allowed.statusCode, 401, `${entry.method} ${url} recepción → 401`);
        assert.notEqual(allowed.statusCode, 403, `${entry.method} ${url} recepción → 403: ${allowed.body}`);
      }
    });
  });
});
