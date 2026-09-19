/**
 * Tanda FIX-1 · lote F5 — Centro de informes: exportación descargable.
 *
 * POST /reports/properties/:id/export devuelve ahora `export.downloadUrl`
 * (= /reports/exports/:id/download) y `export.expiresAt` además de `content`;
 * GET /reports/exports/:id/download sirve el mismo fichero (almacén en
 * memoria, 15 min) con content-type y content-disposition. Tenant aislado de
 * helpers/l2-tenant.mts (Postgres real, app.inject); RBAC_STRICT=true, auth
 * real, sin unión de permisos de demo. Dos organizaciones: A exporta y
 * descarga; la dirección general de B recibe el 404 opaco. Al terminar borra
 * las dos organizaciones; las cifras de Faranda no cambian.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/reports-export-download.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { REPORT_EXPORT_STORE, REPORT_EXPORT_TTL_MS, REPORT_EXPORT_MAX } = await import("../../apps/api/src/modules/reporting/reporting.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; headers: Record<string, unknown>; raw: string };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST", url: string, session: Session, propertyId: string, payload?: unknown): Promise<Reply> {
  const res = await app.inject({ method, url, headers: { ...session.headers, "x-property-id": propertyId }, ...(payload === undefined ? {} : { payload }) });
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, unknown>, raw: res.body };
}

type ExportReply = { export: { id: string; filename: string; contentType: string; downloadUrl: string; expiresAt: string; generatedAt: string }; content: string };

describe("F5 · Centro de informes: exportación con descarga autenticada", () => {
  let app: ApiApp;
  let A: IsolatedTenant;
  let B: IsolatedTenant;
  let managerA: Session; // general_manager de A (analytics.export)
  let managerB: Session; // general_manager de B (otra organización)
  let receptionist: Session; // solo A, sin analytics.export
  let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

  before(async () => {
    invariantsBefore = await farandaInvariants();
    app = await buildApiServer();
    A = await createIsolatedTenant(`x${newRunId()}`);
    B = await createIsolatedTenant(`y${newRunId()}`);
    await strict(async () => {
      managerA = await loginOrThrow(app, A.users.generalManager.email, A.password);
      managerB = await loginOrThrow(app, B.users.generalManager.email, B.password);
      receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
    });
  });

  after(async () => {
    try {
      if (A) await cleanupTenant(A.organizationId);
      if (B) await cleanupTenant(B.organizationId);
    } finally {
      await app?.close();
    }
    for (const [id, entry] of REPORT_EXPORT_STORE) {
      if (entry.organizationId === A?.organizationId || entry.organizationId === B?.organizationId) REPORT_EXPORT_STORE.delete(id);
    }
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
    assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
  });

  it("el manifiesto lleva GET /reports/exports/:exportId/download con analytics.export (riesgo alto, como el POST que lo genera: sin sesión real nunca se sirve; corrector FIX-1 · SEC-06)", () => {
    const entry = routePermissionManifest.find((route) => route.method === "GET" && route.path === "/reports/exports/:exportId/download");
    assert.ok(entry, "entrada del manifiesto");
    assert.deepEqual(entry.permissions, ["analytics.export"]);
    assert.equal(entry.riskLevel, "high");
    assert.equal(REPORT_EXPORT_TTL_MS, 15 * 60 * 1000);
    assert.equal(REPORT_EXPORT_MAX, 100);
  });

  it("POST export (Reservas · CSV) → 200 con downloadUrl, expiresAt y content; GET downloadUrl sirve el mismo fichero como adjunto", async () => {
    await strict(async () => {
      const exported = await call(app, "POST", `/reports/properties/${A.propertyA}/export`, managerA, A.propertyA, { reportType: "reservation", format: "csv" });
      assert.equal(exported.status, 200, `export → ${exported.status} ${exported.raw.slice(0, 300)}`);
      const body = exported.body as unknown as ExportReply;
      assert.match(body.export.id, /^report_export_/);
      assert.equal(body.export.downloadUrl, `/reports/exports/${body.export.id}/download`);
      assert.equal(body.export.contentType, "text/csv;charset=utf-8");
      assert.match(body.export.filename, /^informe-reservation-.+\.csv$/);
      assert.equal(typeof body.content, "string");
      const ttl = Date.parse(body.export.expiresAt) - Date.parse(body.export.generatedAt);
      assert.equal(ttl, REPORT_EXPORT_TTL_MS, "expiresAt = generatedAt + 15 min");
      const stored = REPORT_EXPORT_STORE.get(body.export.id);
      assert.ok(stored, "el artefacto queda en el almacén temporal");
      assert.equal(stored.organizationId, A.organizationId);
      assert.equal(stored.propertyId, A.propertyA);

      const download = await call(app, "GET", body.export.downloadUrl, managerA, A.propertyA);
      assert.equal(download.status, 200, `download → ${download.status} ${download.raw.slice(0, 300)}`);
      assert.equal(String(download.headers["content-type"]), "text/csv;charset=utf-8");
      assert.equal(String(download.headers["content-disposition"]), `attachment; filename="${body.export.filename}"`);
      assert.equal(download.raw, body.content, "el cuerpo descargado es el mismo content de la exportación");
      // Segunda descarga: el artefacto sigue disponible dentro del TTL.
      const again = await call(app, "GET", body.export.downloadUrl, managerA, A.propertyA);
      assert.equal(again.status, 200);
      assert.equal(again.raw, body.content);
    });
  });

  it("Facturación · XLSX cae a CSV (sin escritor xlsx) y se descarga igual", async () => {
    await strict(async () => {
      const exported = await call(app, "POST", `/reports/properties/${A.propertyA}/export`, managerA, A.propertyA, { reportType: "billing", format: "xlsx" });
      assert.equal(exported.status, 200, `export → ${exported.status} ${exported.raw.slice(0, 300)}`);
      const body = exported.body as unknown as ExportReply;
      assert.match(body.export.filename, /^informe-billing-.+\.csv$/);
      const download = await call(app, "GET", body.export.downloadUrl, managerA, A.propertyA);
      assert.equal(download.status, 200, `download → ${download.status} ${download.raw.slice(0, 300)}`);
      assert.equal(download.raw, body.content);
    });
  });

  it("GET con id inexistente → 404 «Exportación no encontrada o caducada.»; caducada → 404 y sale del almacén", async () => {
    await strict(async () => {
      const missing = await call(app, "GET", "/reports/exports/report_export_inexistente/download", managerA, A.propertyA);
      assert.equal(missing.status, 404, `missing → ${missing.status} ${missing.raw.slice(0, 300)}`);
      assert.equal(missing.body.message, "Exportación no encontrada o caducada.");

      const exported = await call(app, "POST", `/reports/properties/${A.propertyA}/export`, managerA, A.propertyA, { reportType: "reservation", format: "json" });
      assert.equal(exported.status, 200);
      const id = (exported.body as unknown as ExportReply).export.id;
      const stored = REPORT_EXPORT_STORE.get(id);
      assert.ok(stored);
      stored.expiresAt = Date.now() - 1;
      const expired = await call(app, "GET", `/reports/exports/${id}/download`, managerA, A.propertyA);
      assert.equal(expired.status, 404, `expired → ${expired.status} ${expired.raw.slice(0, 300)}`);
      assert.equal(expired.body.message, "Exportación no encontrada o caducada.");
      assert.equal(REPORT_EXPORT_STORE.has(id), false, "la entrada caducada se poda al leerla");
    });
  });

  it("GET con usuario de otra organización → 404 opaco; sin analytics.export → 403", async () => {
    await strict(async () => {
      const exported = await call(app, "POST", `/reports/properties/${A.propertyA}/export`, managerA, A.propertyA, { reportType: "reservation", format: "csv" });
      assert.equal(exported.status, 200);
      const body = exported.body as unknown as ExportReply;
      const other = await call(app, "GET", body.export.downloadUrl, managerB, B.propertyA);
      assert.equal(other.status, 404, `otra organización → ${other.status} ${other.raw.slice(0, 300)}`);
      assert.equal(other.body.message, "Exportación no encontrada o caducada.");
      const forbidden = await call(app, "GET", body.export.downloadUrl, receptionist, A.propertyA);
      assert.equal(forbidden.status, 403, `recepción → ${forbidden.status} ${forbidden.raw.slice(0, 300)}`);
    });
  });

  it("el almacén poda las entradas más antiguas al superar REPORT_EXPORT_MAX", async () => {
    await strict(async () => {
      const first = await call(app, "POST", `/reports/properties/${A.propertyA}/export`, managerA, A.propertyA, { reportType: "reservation", format: "csv" });
      const firstId = (first.body as unknown as ExportReply).export.id;
      // La entrada más antigua del almacén (las de los tests anteriores de esta suite o firstId).
      const oldest = REPORT_EXPORT_STORE.keys().next().value;
      assert.ok(oldest, "almacén con entradas");
      // Rellena el almacén con entradas sintéticas (sin pasar por el API) hasta el tope.
      const synthetic: string[] = [];
      while (REPORT_EXPORT_STORE.size < REPORT_EXPORT_MAX) {
        const id = `report_export_f5_${A.run}_${synthetic.length}`;
        synthetic.push(id);
        REPORT_EXPORT_STORE.set(id, { organizationId: A.organizationId, propertyId: A.propertyA, filename: "x.csv", contentType: "text/csv", content: "", expiresAt: Date.now() + REPORT_EXPORT_TTL_MS });
      }
      const next = await call(app, "POST", `/reports/properties/${A.propertyA}/export`, managerA, A.propertyA, { reportType: "reservation", format: "csv" });
      assert.equal(next.status, 200);
      assert.ok(REPORT_EXPORT_STORE.size <= REPORT_EXPORT_MAX, `tamaño ${REPORT_EXPORT_STORE.size} ≤ ${REPORT_EXPORT_MAX}`);
      assert.equal(REPORT_EXPORT_STORE.has(oldest), false, "la exportación más antigua se ha podado");
      assert.equal(REPORT_EXPORT_STORE.has((next.body as unknown as ExportReply).export.id), true, "la nueva queda guardada");
      assert.ok(oldest === firstId || REPORT_EXPORT_STORE.has(firstId), "firstId solo desaparece si era la más antigua");
      for (const id of synthetic) REPORT_EXPORT_STORE.delete(id);
    });
  });
});
