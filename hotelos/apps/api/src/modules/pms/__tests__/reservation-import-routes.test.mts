// El partial del manifiesto debe cubrir TODAS las rutas registradas en
// reservation-import.routes.ts y ninguna más: `assertRoutePermission` responde
// 403 a cualquier no-GET sin entrada, en todos los entornos, y el contrato del
// repo parsea el partial con una regex que también lee una entrada comentada.
// Este test lee el array vivo (clon de channel-manager/__tests__/route-permissions.test.mts)
// y pina, además, los riesgos y permisos del diseño (docs/design/RESERVAS-IMPORTACION-MASIVA.md §7),
// las opciones de cuerpo / rate limit de las dos rutas de subida, el orden de
// registro (template antes que :id, preview antes que :id/undo) y el cableado en
// security/route-permissions.ts, server.ts y lib/tenancy.ts. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-routes.test.mts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { reservationImportRoutePermissions } from "../route-permissions.partial.js";

const source = readFileSync(new URL("../reservation-import.routes.ts", import.meta.url), "utf8");
const registered = [...source.matchAll(/\bapp\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)].map((m) => `${(m[1] as string).toUpperCase()} ${m[2]}`);
const manifest = reservationImportRoutePermissions.map((e) => `${e.method} ${e.path}`);
const byKey = new Map(reservationImportRoutePermissions.map((e) => [`${e.method} ${e.path}`, e] as const));

const BASE = "/properties/:propertyId/reservations/imports";
const UPLOAD_OPTIONS = '{ bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }';

describe("reservation-import — partial de permisos de las rutas", () => {
  it("registra exactamente 6 rutas y cada una tiene exactamente una entrada en el manifiesto (y viceversa)", () => {
    assert.equal(registered.length, 6, `rutas extraídas: ${registered.join(", ")}`);
    const missing = registered.filter((r) => !manifest.includes(r));
    assert.deepEqual(missing, [], `rutas sin entrada en el manifiesto: ${missing.join(", ")}`);
    const orphans = manifest.filter((m) => !registered.includes(m));
    assert.deepEqual(orphans, [], `entradas del manifiesto sin ruta: ${orphans.join(", ")}`);
    assert.equal(new Set(manifest).size, manifest.length, "entradas duplicadas en el manifiesto");
    assert.equal(new Set(registered).size, registered.length, "rutas registradas dos veces");
  });

  it("las 6 rutas son las del diseño §7, en el orden de registro template antes que :id y preview antes que :id/undo", () => {
    assert.deepEqual(registered, [
      `POST ${BASE}/preview`,
      `POST ${BASE}`,
      `GET ${BASE}`,
      `GET ${BASE}/template`,
      `GET ${BASE}/:id`,
      `POST ${BASE}/:id/undo`
    ]);
    assert.ok(registered.indexOf(`GET ${BASE}/template`) < registered.indexOf(`GET ${BASE}/:id`), "template antes que :id");
    assert.ok(registered.indexOf(`POST ${BASE}/preview`) < registered.indexOf(`POST ${BASE}/:id/undo`), "preview antes que :id/undo");
    for (const entry of reservationImportRoutePermissions) assert.ok(entry.path.startsWith(BASE), entry.path);
  });

  it("riesgos y permisos: preview create/medium; import create + modify/high; undo modify/high; lecturas read/low", () => {
    assert.deepEqual(byKey.get(`POST ${BASE}/preview`)?.permissions, ["pms.reservation.create"]);
    assert.equal(byKey.get(`POST ${BASE}/preview`)?.riskLevel, "medium");
    assert.deepEqual(byKey.get(`POST ${BASE}`)?.permissions, ["pms.reservation.create", "pms.reservation.modify"], "importar exige create Y modify (assignRoom / transitionReservation)");
    assert.equal(byKey.get(`POST ${BASE}`)?.riskLevel, "high");
    assert.deepEqual(byKey.get(`POST ${BASE}/:id/undo`)?.permissions, ["pms.reservation.modify"], "deshacer exige modify (espejo de POST /reservations/:id/cancel)");
    assert.equal(byKey.get(`POST ${BASE}/:id/undo`)?.riskLevel, "high");
    for (const path of [BASE, `${BASE}/template`, `${BASE}/:id`]) {
      const entry = byKey.get(`GET ${path}`);
      assert.deepEqual(entry?.permissions, ["pms.reservation.read"], path);
      assert.equal(entry?.riskLevel, "low", path);
    }
    for (const entry of reservationImportRoutePermissions) {
      assert.ok(entry.permissions.length >= 1, `${entry.method} ${entry.path} sin permisos`);
      assert.notEqual(entry.riskLevel, "public", `${entry.method} ${entry.path} no puede ser pública`);
      for (const key of entry.permissions) assert.match(key, /^pms\.reservation\.(read|create|modify)$/, `${entry.path}: clave existente, sin rbac:sync`);
    }
  });

  it("preview e import llevan bodyLimit de 8 MiB y rate limit 30/min; import responde 201; :id pasa por assertEntityAccess con propertyId", () => {
    const previewAt = source.indexOf(`app.post("${BASE}/preview"`);
    const importAt = source.indexOf(`app.post("${BASE}",`);
    assert.ok(previewAt >= 0 && importAt > previewAt);
    assert.ok(source.slice(previewAt, previewAt + 200).includes(UPLOAD_OPTIONS), "preview con bodyLimit + rateLimit literales");
    assert.ok(source.slice(importAt, importAt + 200).includes(UPLOAD_OPTIONS), "import con bodyLimit + rateLimit literales");
    assert.equal((source.match(/bodyLimit: 8 \* 1024 \* 1024/g) ?? []).length, 2, "solo las dos rutas de subida amplían el cuerpo");
    assert.match(source, /reply\.code\(201\)\.send\(result\)/);
    assert.match(source, /createId\("corr"\)/);
    assert.equal((source.match(/assertEntityAccess\(request, \{ entity: "reservationImport", id, propertyId \}\)/g) ?? []).length, 2, "GET :id y POST :id/undo cruzan el lote con :propertyId");
    assert.match(source, /parseOr400\(PreviewReservationImportSchema/);
    assert.match(source, /parseOr400\(CreateReservationImportSchema/);
    assert.match(source, /parseOr400\(ListReservationImportsQuerySchema/);
    assert.match(source, /parseOr400\(ReservationImportTemplateQuerySchema/);
    assert.match(source, /parseOr400\(UndoReservationImportSchema/);
    assert.match(source, /source: "http"/);
    assert.match(source, /cache-control", "no-store"/);
  });

  it("cableado: spread en security/route-permissions.ts, registro en server.ts y resolver de tenencia", () => {
    const manifestSource = readFileSync(new URL("../../../security/route-permissions.ts", import.meta.url), "utf8");
    assert.match(manifestSource, /import \{ reservationImportRoutePermissions \} from "\.\.\/modules\/pms\/route-permissions\.partial\.js";/);
    assert.match(manifestSource, /^\s*\.\.\.reservationImportRoutePermissions,$/m);
    assert.ok(manifestSource.indexOf("...payrollRoutePermissions,") < manifestSource.indexOf("...reservationImportRoutePermissions,"), "tras el partial de nómina");
    const server = readFileSync(new URL("../../../server.ts", import.meta.url), "utf8");
    assert.match(server, /import \{ registerReservationImportRoutes \} from "\.\/modules\/pms\/reservation-import\.routes\.js";/);
    assert.match(server, /registerReservationImportRoutes\(app\);/);
    assert.ok(server.indexOf("registerPayrollCostRoutes(app);") < server.indexOf("registerReservationImportRoutes(app);"), "registrado tras las rutas de nómina");
    const tenancy = readFileSync(new URL("../../../lib/tenancy.ts", import.meta.url), "utf8");
    assert.match(tenancy, /reservationImport: byProperty\("Importación de reservas no encontrada\.", \(id\) =>\s*prisma\.reservationImport\.findUnique\(\{ where: \{ id \}, select: selectProperty \}\)/);
  });
});
