// Tanda UX-1 · lote U1 · contrato del «día de prueba» de recepción y de la
// medida automatizada (docs/design/UX-RECEPCION-FEEL.md §8.4, §8.6, §9 fila U1).
//
//   · packages/database/prisma/seed-ux-day.ts existe, pasa por assertDemoTarget,
//     es autónomo (no importa seed.ts ni seed-operations.ts, huella de L5), usa
//     los prefijos del tenant aislado (UXDAY-, @uxday.test, *_uxday) y no
//     contiene ningún apellido real (lista negra mínima: apellidos de los
//     usuarios ficticios de seed-rbac-demo y de los huéspedes del seed base);
//   · el único deleteMany del seed va acotado a `propertyId: PROPERTY_ID`;
//   · org_uxday / prop_uxday están en la allowlist demo y el script
//     `db:seed:ux-day` existe;
//   · admin-web tiene los scripts `test` y `e2e:measure`, el proyecto Playwright
//     «measure» con trace "on", los 6 specs t1…t6 sobre el helper de medida, y
//     results.json ignorado por git con la baseline copiada a docs/audits;
//   · el dev-bypass de e2e (`loginAsUxDay`) escribe la sesión real y no queda
//     ningún `testInfo.skip` en las specs de recepción;
//   · lib/ux-trace.ts + provider bajo VITE_UX_TRACE, montado en main.tsx;
//   · el kit del moderador existe con los comandos reales.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const exists = (path) => existsSync(new URL(path, import.meta.url));

const seed = read("../packages/database/prisma/seed-ux-day.ts");
const guard = read("../packages/database/prisma/lib/demo-guard.ts");
const databasePackage = JSON.parse(read("../packages/database/package.json"));
const adminPackage = JSON.parse(read("../apps/admin-web/package.json"));
const playwrightConfig = read("../apps/admin-web/playwright.config.ts");
const helpers = read("../apps/admin-web/e2e/_helpers.ts");
const gitignore = read("../.gitignore");

/** Apellidos que NUNCA pueden aparecer en el seed de prueba (personas ficticias de otros seeds y apellidos comunes usados en demos). */
const SURNAME_BLACKLIST = [
  "Ameijeiras", "Ares", "Baña", "Brey", "Carballo", "Castiñeira", "Cobas", "Cueto", "Docampo", "Espiño", "Freire",
  "Insua", "Lavandera", "Lema", "Menéndez", "Nogueira", "Piñeiro", "Prieto", "Requeijo", "Rial", "Rubido", "Salgado",
  "Souto", "Turnes", "Varela", "Vieites", "Vilar", "Lopez", "López", "Garcia", "García", "Fernández", "Rodríguez",
  "Martínez", "Pérez", "Sánchez", "Gómez"
];

function importSpecifiers(source) {
  return [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
}

describe("Seed «día de prueba» UXDAY (U1)", () => {
  it("existe, pasa por assertDemoTarget y solo escribe en el tenant aislado", () => {
    assert.match(seed, /assertDemoTarget\(\{/);
    assert.match(seed, /export const ORG_ID = "org_uxday"/);
    assert.match(seed, /export const PROPERTY_ID = "prop_uxday"/);
    assert.match(seed, /export const LEGAL_ENTITY_ID = "le_uxday"/);
    assert.match(seed, /export const RESERVATION_PREFIX = "UXDAY-"/);
    assert.match(seed, /export const EMAIL_DOMAIN = "uxday\.test"/);
    for (const local of ["recepcion", "direccion", "sistemas"]) assert.match(seed, new RegExp(`local: "${local}"`));
    assert.match(seed, /hashPassword\(DEMO_PASSWORD\)/);
    assert.match(seed, /syncPermissionCatalog\(\)/);
    assert.match(seed, /provisionDefaultTemplateRoles\(ORG_ID\)/);
    assert.match(seed, /applyRoleTemplate\(adminRole\.id, "admin"\)/);
    assert.match(seed, /provisionOrganizationChart\(ORG_ID\)/);
    assert.match(seed, /ensurePropertySettings\(PROPERTY_ID\)/);
    assert.match(seed, /timezone: "Europe\/Madrid"/);
    assert.match(seed, /taxRegion: "ES_PENINSULA_BALEARES"/);
    assert.match(seed, /fiscalTerritory: "common"/);
    assert.match(seed, /sesHospedajesEnabled: false/);
    assert.match(seed, /verifactuEnabled: false/);
    assert.match(seed, /goLiveAt: GO_LIVE_AT/);
    assert.match(seed, /isDefault: true/);
    assert.match(seed, /freeCancelHours: 24/);
  });

  it("es autónomo: no importa seed.ts ni seed-operations.ts (huella de L5)", () => {
    const specifiers = importSpecifiers(seed);
    assert.ok(specifiers.length >= 5, `imports parsed: ${specifiers.length}`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /seed\.js$|seed\.ts$|seed-operations|seed-commercial|seed-rbac/, `import prohibido: ${specifier}`);
    }
    assert.doesNotMatch(seed, /from "\.\/seed\.js"/);
  });

  it("siembra el día de §8.4 con códigos UXDAY-* explícitos y fechas relativas a hoy", () => {
    for (const code of ["UXDAY-T1", "UXDAY-T3", "UXDAY-T4", "UXDAY-T6", "UXDAY-E1"]) assert.match(seed, new RegExp(`code: "${code}"`));
    assert.match(seed, /todayIn\("Europe\/Madrid"\)/);
    assert.match(seed, /arrivalOffset: 0/, "llegadas de hoy");
    assert.match(seed, /departureOffset: 0/, "salidas de hoy");
    assert.match(seed, /room: 204/, "UXDAY-T3 en la 204");
    assert.match(seed, /room: 310/, "UXDAY-T4 en la 310");
    assert.match(seed, /vip: true/);
    assert.match(seed, /dirtyRoom: true/);
    assert.match(seed, /workOrder: "Avería/);
    assert.match(seed, /const T6_SURNAME = "Zeta"/);
    assert.match(seed, /COMPANY_NAME = "Empresa UXDAY SL"/);
    assert.match(seed, /cifFor\("B"/, "NIF con checksum válido");
    assert.match(seed, /status: "captured"/, "solo los pagos captured dejan saldo");
  });

  it("no contiene ningún apellido real (personas ficticias con apellidos griegos)", () => {
    const names = [...seed.matchAll(/"([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)"/g)].map((m) => m[1]);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    for (const surname of SURNAME_BLACKLIST) assert.ok(!lower.has(surname.toLowerCase()), `apellido real en el seed: ${surname}`);
    assert.match(seed, /GREEK_SURNAMES = \["Alfa", "Beta", "Gamma"/);
  });

  it("los deleteMany van acotados a prop_uxday (deleteScoped) o, el de huéspedes huérfanos, a org_uxday (modo --reset; corrector R7)", () => {
    const calls = [...seed.matchAll(/deleteMany\(/g)];
    assert.equal(calls.length, 2, "deleteScoped + huéspedes huérfanos de org_uxday");
    assert.match(seed, /prisma\.guest\.deleteMany\(\{ where: \{ organizationId: ORG_ID, reservationGuests: \{ none: \{\} \} \} \}\)/);
    assert.match(seed, /const where = \{ \.\.\.extraWhere, propertyId: PROPERTY_ID \};/);
    assert.match(seed, /NODE_ENV === "production" && process\.env\.SEED_UXDAY_ALLOW_PRODUCTION !== "1"/, "guarda de producción (R9)");
    assert.match(seed, /process\.env\.SEED_UXDAY_PASSWORD\?\.trim\(\) \|\| "uxday-demo"/, "contraseña sustituible (R9)");
    assert.match(seed, /args\.includes\("--reset"\)/);
    assert.match(seed, /args\.includes\("--dry-run"\)/);
    assert.match(seed, /verifactuHash: \{ not: null \}/, "las reservas con factura VeriFactu se conservan");
    assert.match(seed, /deleteScoped\("reservation", \{ id: \{ notIn: \[\.\.\.protectedReservationIds\] \} \}\)/);
    assert.doesNotMatch(seed, /cmrhw9jy30002fyvb6tsdiugt|org_123|prop_123|prop_canary/, "nunca toca Faranda ni el demo base");
  });

  it("está en la allowlist demo y tiene script pnpm", () => {
    // Tanda CHK (W1-D): la allowlist incorpora el tenant aislado org_chk / prop_chk (seed-checkin.ts).
    assert.match(guard, /DEMO_ORG_IDS: readonly string\[\] = \["org_123", "org_uxday", "org_chk"\]/);
    assert.match(guard, /DEMO_PROPERTY_IDS: readonly string\[\] = \["prop_123", "prop_canary", "prop_uxday", "prop_chk"\]/);
    assert.equal(databasePackage.scripts["db:seed:ux-day"], "node --env-file=../../.env --import tsx prisma/seed-ux-day.ts");
  });
});

describe("Medida automatizada del camino óptimo (U1 · §8.6)", () => {
  it("admin-web tiene los scripts test y e2e:measure sin dependencias nuevas", () => {
    assert.equal(adminPackage.scripts.test, 'node --import ../api/node_modules/tsx/dist/loader.mjs --test "src/**/__tests__/*.test.mts"');
    assert.equal(adminPackage.scripts["e2e:measure"], "playwright test --project measure");
    assert.equal(adminPackage.devDependencies.tsx, undefined, "tsx no se declara en admin-web (lockfile intacto)");
  });

  it("playwright.config define los proyectos chromium y measure (trace on, retries 0)", () => {
    assert.match(playwrightConfig, /baseURL: process\.env\.E2E_BASE_URL \?\? "http:\/\/localhost:5173"/);
    assert.match(playwrightConfig, /name: "measure"/);
    assert.match(playwrightConfig, /testDir: "\.\/e2e\/measure"/);
    assert.match(playwrightConfig, /trace: "on"/);
    assert.match(playwrightConfig, /name: "chromium"/);
    assert.match(playwrightConfig, /testIgnore: \/measure\//);
    assert.match(playwrightConfig, /workers: 1/);
    assert.match(playwrightConfig, /retries: 0/);
  });

  it("dev-bypass: loginAsUxDay escribe la sesión real y el login tras el bypass es fallo, no skip", () => {
    assert.match(helpers, /export async function loginAsUxDay\(/);
    assert.match(helpers, /\/auth\/login/);
    assert.match(helpers, /process\.env\.E2E_UXDAY_PASSWORD \?\? "uxday-demo"/);
    assert.match(helpers, /deviceId: "e2e"/);
    for (const key of ["hotelos.auth.token", "hotelos.auth.user", "hotelos-active-property", "hotelos-active-org", "hotelos-active-property-name"]) {
      assert.match(helpers, new RegExp(key.replace(/[.-]/g, "\\$&")), `clave ${key}`);
    }
    assert.match(helpers, /prop_uxday/);
    assert.match(helpers, /org_uxday/);
    assert.doesNotMatch(helpers, /testInfo\.skip\(/, "el login tras el bypass es fallo, no skip");
  });

  it("las 12 specs e2e (11 de recepción + integraciones L8) no se saltan y usan las rutas del árbol de navegación", () => {
    const dir = new URL("../apps/admin-web/e2e/", import.meta.url);
    const specs = readdirSync(dir).filter((f) => f.endsWith(".spec.ts"));
    // U6: quick-checkout · walk-in · U7: reservation-workspace (ficha) · U8: reservations-list · U9b: timeline (Live Timeline) · U10: target-size (tablet, proyecto `touch`).
    // L8: integrations-status (Configuración › Integraciones, estado veraz de cada integración).
    assert.deepEqual(specs.sort(), [
      "compliance-center.spec.ts",
      "frontdesk-cockpit.spec.ts",
      "integrations-status.spec.ts",
      "login.spec.ts",
      "quick-checkin.spec.ts",
      "quick-checkout.spec.ts",
      "reservation-create.spec.ts",
      "reservation-workspace.spec.ts",
      "reservations-list.spec.ts",
      "target-size.spec.ts",
      "timeline.spec.ts",
      "walk-in.spec.ts"
    ]);
    for (const file of specs) {
      const source = read(`../apps/admin-web/e2e/${file}`);
      assert.doesNotMatch(source, /testInfo\.skip\(|test\.skip\(/, `${file} no debe saltarse`);
      assert.doesNotMatch(source, /\/backoffice\//, `${file} usa las URL del árbol (nav-tree.generated.json), no /backoffice/*`);
    }
    assert.match(read("../apps/admin-web/e2e/quick-checkin.spec.ts"), /name: \/\^Hacer check-in\$\//);
    assert.match(read("../apps/admin-web/e2e/quick-checkin.spec.ts"), /UXDAY-T1/);
    assert.match(read("../apps/admin-web/e2e/frontdesk-cockpit.spec.ts"), /Llegan hoy/);
    assert.match(read("../apps/admin-web/e2e/frontdesk-cockpit.spec.ts"), /Salen hoy/);
    assert.match(read("../apps/admin-web/e2e/frontdesk-cockpit.spec.ts"), /En el hotel/);
    assert.match(read("../apps/admin-web/e2e/reservation-create.spec.ts"), /Confirmar y crear reserva/);
    assert.match(read("../apps/admin-web/e2e/reservation-create.spec.ts"), /\/recepcion\/reservas\/nueva/);
    assert.match(read("../apps/admin-web/e2e/compliance-center.spec.ts"), /\/cumplimiento\/centro/);
    assert.match(read("../apps/admin-web/e2e/integrations-status.spec.ts"), /\/configuracion\/modulos\/integraciones/);
  });

  it("hay 6 specs de medida t1…t6 sobre el helper con contadores y results.json ignorado", () => {
    const dir = new URL("../apps/admin-web/e2e/measure/", import.meta.url);
    const specs = readdirSync(dir).filter((f) => /^t[1-6]-.*\.spec\.ts$/.test(f)).sort();
    assert.equal(specs.length, 6, `specs de medida: ${specs.join(", ")}`);
    const measure = read("../apps/admin-web/e2e/measure/_measure.ts");
    for (const fn of ["countedClick", "countedPress", "countedFill", "writeResult", "performance.mark", 'page.on("request"', "MEASURE_STRICT"]) {
      assert.ok(measure.includes(fn), `_measure.ts debe incluir ${fn}`);
    }
    for (const [index, file] of specs.entries()) {
      const source = read(`../apps/admin-web/e2e/measure/${file}`);
      assert.ok(source.includes(`"t${index + 1}"`), `${file} mide la tarea t${index + 1}`);
      assert.match(source, /startMeasure\(|createMeasure\(/, `${file} usa el helper`);
    }
    assert.match(gitignore, /^apps\/admin-web\/e2e\/measure\/results\.json$/m);
    assert.ok(exists("../docs/audits/ux-recepcion/measure-baseline-2026-09-19.json"), "baseline copiada a docs/audits/ux-recepcion");
    const baseline = JSON.parse(read("../docs/audits/ux-recepcion/measure-baseline-2026-09-19.json"));
    assert.deepEqual(Object.keys(baseline.tasks).sort(), ["t1", "t2", "t3", "t4", "t5", "t6"]);
    for (const [task, result] of Object.entries(baseline.tasks)) {
      for (const key of ["clicks", "keys", "requests", "ms", "completed", "path"]) assert.ok(key in result, `${task}.${key}`);
    }
  });
});

describe("ux-trace (U1 · §6.4 / §8.4 C)", () => {
  it("lib + provider bajo VITE_UX_TRACE, montado en main.tsx, sin PII", () => {
    const lib = read("../apps/admin-web/src/lib/ux-trace.ts");
    const provider = read("../apps/admin-web/src/providers/UxTraceProvider.tsx");
    const main = read("../apps/admin-web/src/main.tsx");
    assert.match(provider, /import\.meta\.env\.VITE_UX_TRACE === "1"/);
    assert.match(main, /UxTraceProvider/);
    assert.match(main, /import\.meta\.env\.VITE_UX_TRACE === "1"/);
    assert.match(provider, /logBreadcrumb/);
    assert.match(lib, /sessionId/);
    assert.match(lib, /taskId/);
    assert.match(lib, /indexedDB/);
    assert.match(lib, /exportJson/);
    assert.match(provider, /shiftKey/, "⌘⇧T cambia de tarea");
    assert.doesNotMatch(provider, /style=\{/, "0 style= inline nuevos (Cocoa)");
    assert.ok(exists("../apps/admin-web/src/lib/__tests__/ux-trace.test.mts"));
  });

  it("el kit del moderador existe con los comandos reales", () => {
    const runbook = read("../docs/runbooks/ux-recepcion-pruebas.md");
    for (const marker of ["db:seed:ux-day", "--reset", "VITE_UX_TRACE=1", "e2e:measure", "recepcion@uxday.test", "SEQ", "UMUX-Lite", "Hoja de registro", "⌘⇧T"]) {
      assert.ok(runbook.includes(marker), `runbook debe mencionar ${marker}`);
    }
    assert.doesNotMatch(runbook, /cmrhw9jy30002fyvb6tsdiugt/);
  });
});
