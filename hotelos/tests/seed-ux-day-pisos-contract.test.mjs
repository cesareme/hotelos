// Tanda UX-3 · lote U0 · contrato del seed de pisos/mantenimiento del tenant
// UXDAY y de la medida p1…p6 + auditoría táctil (recon UX-3 §Seed U0,
// §Contratos, §Baseline; docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §7-§8).
//
//   · packages/database/prisma/seed-ux-day-pisos.ts existe, pasa por
//     assertDemoTarget, admite --dry-run, es autónomo (no importa seed-ux-day.ts
//     —ejecuta main() al cargarse— ni seed.ts / seed-operations.ts) y duplica
//     las constantes del tenant con los MISMOS valores que seed-ux-day.ts;
//   · siembra los cuatro usuarios de pisos/mantenimiento con su plantilla, las
//     tres secciones, y habitaciones, tareas y partes con ids `*_uxday_p*`;
//     ningún apellido real (lista negra de seed-ux-day-contract);
//   · todo deleteMany va acotado a prop_uxday: `propertyId: PROPERTY_ID`
//     (deleteOwn) o el id propio del padre (tarea, parte, sección);
//   · el script `db:seed:ux-day-pisos` existe (1 línea, sin dependencias nuevas);
//   · e2e/measure/_measure-pisos.ts (p1…p6, TARGETS_P, results-pisos.json
//     ignorado) y las 6 specs p1…p6 con dos tests (ratón 1280 × 900 y tablet
//     820 × 1180 con hasTouch + pointer coarse) sobre los usuarios del seed,
//     éxito verificado por API y sin skip; _measure.ts intacto (contrato UX-1);
//   · e2e/pisos/_pisos.ts + pisos-target-size.spec.ts (cinco rutas, 820 × 1180
//     y 1024 × 768, claro/oscuro, 0 < 24 px y contraste, lista < 44);
//   · baselines copiadas a docs/audits/ux-pisos/.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const exists = (path) => existsSync(new URL(path, import.meta.url));

const seed = read("../packages/database/prisma/seed-ux-day-pisos.ts");
const seedUxDay = read("../packages/database/prisma/seed-ux-day.ts");
const databasePackage = JSON.parse(read("../packages/database/package.json"));
const measure = read("../apps/admin-web/e2e/measure/_measure-pisos.ts");
const measureUx1 = read("../apps/admin-web/e2e/measure/_measure.ts");
const helpers = read("../apps/admin-web/e2e/pisos/_pisos.ts");
const targetSize = read("../apps/admin-web/e2e/pisos/pisos-target-size.spec.ts");
const gitignore = read("../.gitignore");

/** Apellidos que NUNCA pueden aparecer (misma lista que seed-ux-day-contract). */
const SURNAME_BLACKLIST = [
  "Ameijeiras", "Ares", "Baña", "Brey", "Carballo", "Castiñeira", "Cobas", "Cueto", "Docampo", "Espiño", "Freire",
  "Insua", "Lavandera", "Lema", "Menéndez", "Nogueira", "Piñeiro", "Prieto", "Requeijo", "Rial", "Rubido", "Salgado",
  "Souto", "Turnes", "Varela", "Vieites", "Vilar", "Lopez", "López", "Garcia", "García", "Fernández", "Rodríguez",
  "Martínez", "Pérez", "Sánchez", "Gómez", "Míguez", "Amado", "Barreiro", "Lestón", "Castro", "Ferreiro", "Otero", "Pardo", "Seoane"
];

function importSpecifiers(source) {
  return [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
}

function constant(source, name) {
  const match = source.match(new RegExp(`export const ${name} = (.+?);$`, "m"));
  assert.ok(match, `constante ${name}`);
  return match[1];
}

describe("Seed de pisos y mantenimiento UXDAY (UX-3 · U0)", () => {
  it("existe, pasa por assertDemoTarget, admite --dry-run y guarda producción", () => {
    assert.match(seed, /assertDemoTarget\(\{ orgId: ORG_ID, propertyId: PROPERTY_ID/);
    assert.match(seed, /args\.includes\("--dry-run"\)/);
    assert.match(seed, /dry-run: nada escrito/);
    assert.match(seed, /NODE_ENV === "production" && process\.env\.SEED_UXDAY_ALLOW_PRODUCTION !== "1"/);
    assert.match(seed, /hashPassword\(DEMO_PASSWORD\)/);
    assert.match(seed, /provisionDefaultTemplateRoles\(ORG_ID\)/);
    assert.match(seed, /todayIn\("Europe\/Madrid"\)/);
  });

  it("duplica las constantes del tenant con los mismos valores que seed-ux-day.ts (no lo importa: ejecuta main() al cargarse)", () => {
    for (const name of ["ORG_ID", "PROPERTY_ID", "PROPERTY_NAME", "EMAIL_DOMAIN", "DEMO_PASSWORD"]) {
      assert.equal(constant(seed, name), constant(seedUxDay, name), `${name} igual en ambos seeds`);
    }
    assert.match(seed, /export const ORG_ID = "org_uxday"/);
    assert.match(seed, /export const PROPERTY_ID = "prop_uxday"/);
    assert.match(seed, /export const EMAIL_DOMAIN = "uxday\.test"/);
    const specifiers = importSpecifiers(seed);
    assert.ok(specifiers.length >= 3, `imports parsed: ${specifiers.length}`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /seed-ux-day|seed\.js$|seed\.ts$|seed-operations|seed-commercial|seed-rbac|seed-checkin/, `import prohibido: ${specifier}`);
    }
  });

  it("siembra las cuatro personas de pisos/mantenimiento, las tres secciones y las habitaciones, tareas y partes con ids *_uxday_p*", () => {
    for (const [local, fullName, templateKey] of [
      ["pisos", "Pisos UXDAY", "housekeeper"],
      ["gobernanta", "Gobernanta UXDAY", "housekeeping_manager"],
      ["mantenimiento", "Mantenimiento UXDAY", "maintenance"],
      ["encargado", "Encargado UXDAY", "maintenance_manager"]
    ]) {
      assert.match(seed, new RegExp(`local: "${local}", fullName: "${fullName}", templateKey: "${templateKey}"`), `usuario ${local}`);
    }
    assert.match(seed, /scopeType: "property", propertyId: PROPERTY_ID, organizationId: ORG_ID/);
    assert.match(seed, /name: "Planta 1", numbers: range\(101, 120\)/);
    assert.match(seed, /name: "Planta 2", numbers: range\(201, 220\)/);
    assert.match(seed, /name: "Plantas 3-4", numbers: \[\.\.\.range\(301, 315\), \.\.\.range\(401, 405\)\]/);
    assert.match(seed, /task: "hkt_uxday_p"/);
    assert.match(seed, /workOrder: "wo_uxday_p"/);
    assert.match(seed, /section: "hks_uxday_p"/);
    assert.match(seed, /user: "usr_uxday_p_"/);
    // Habitaciones de las specs t* y de humo: nunca se eligen.
    assert.match(seed, /RESERVED_BY_T_SPECS: ReadonlySet<number> = new Set\(\[\s*101, 102, 103, 104, 110, 111, 204, 205, 206, 207, 212, 213, 217, 218, 219, 220, 305, 306, 310, 311, 312, 401\s*\]\)/);
    // Papeles: 5 sucias p1 · 1 en curso · 2 limpias · 2 partes p5 · 2 partes p6 · 1 en curso · 1 emergencia.
    assert.match(seed, /\{ key: "p1", count: 5,/);
    assert.match(seed, /\{ key: "in_progress", count: 1,/);
    assert.match(seed, /\{ key: "clean", count: 2,/);
    assert.match(seed, /\{ key: "p5", count: 2,/);
    assert.match(seed, /\{ key: "p6", count: 2,/);
    assert.match(seed, /\{ key: "emergency", count: 1,/);
    assert.match(seed, /assignedTo: "Pisos UXDAY"/);
    assert.match(seed, /assignedTo: "Mantenimiento UXDAY"/);
    for (const marker of ["UXDAY-P5A", "UXDAY-P5B", "UXDAY-P6A", "UXDAY-P6B", "UXDAY-P-EC", "UXDAY-P-EM"]) assert.ok(seed.includes(marker), `parte ${marker}`);
    assert.match(seed, /priority: "urgent", status: "open"/);
    assert.match(seed, /priority: "emergency", status: "open"/);
    assert.match(seed, /blocksRoom: false/);
  });

  it("no contiene ningún apellido real (los usuarios llevan el nombre del puesto)", () => {
    const names = [...seed.matchAll(/"([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)"/g)].map((m) => m[1]);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    for (const surname of SURNAME_BLACKLIST) assert.ok(!lower.has(surname.toLowerCase()), `apellido real en el seed: ${surname}`);
    assert.doesNotMatch(seed, /faranda|cmrhw9jy30002fyvb6tsdiugt|org_123|prop_123|prop_canary/i, "nunca toca Faranda ni el demo base");
  });

  it("es idempotente y todos los deleteMany van acotados a prop_uxday (propertyId o id propio del padre)", () => {
    assert.match(seed, /const where = \{ \.\.\.extraWhere, propertyId: PROPERTY_ID \};/, "deleteOwn siempre con propertyId");
    // Cuatro deleteMany en total: deleteOwn (`deleteMany({ where })`, siempre con propertyId) y tres explícitos acotados por el id propio del padre.
    assert.equal((seed.match(/\.deleteMany\(/g) ?? []).length, 4, "deleteMany en el seed");
    assert.match(seed, /delegate\.deleteMany\(\{ where \}\)/, "deleteOwn");
    const calls = [...seed.matchAll(/\.deleteMany\(\{ where: (\{[^\n]*\}) \}\)/g)].map((m) => m[1]);
    assert.equal(calls.length, 3, `deleteMany explícitos (eventos de tarea, fotos de parte, habitaciones de sección): ${calls.length}`);
    for (const where of calls) {
      assert.ok(
        /taskId: \{ startsWith: OWN\.task \}|workOrderId: \{ startsWith: OWN\.workOrder \}|housekeepingSectionId: \{ in: SECTION_IDS \}/.test(where),
        `deleteMany no acotado: ${where}`
      );
    }
    assert.match(seed, /deleteOwn\("housekeepingTask", \{ id: \{ startsWith: OWN\.task \} \}\)/);
    assert.match(seed, /deleteOwn\("workOrder", \{ id: \{ startsWith: OWN\.workOrder \} \}\)/);
    assert.match(seed, /async function restorePreviousRooms\(\)/, "repone las habitaciones de una pasada anterior");
    assert.match(seed, /skipDuplicates: true/);
  });

  it("tiene script pnpm de una línea sin dependencias nuevas", () => {
    assert.equal(databasePackage.scripts["db:seed:ux-day-pisos"], "node --env-file=../../.env --import tsx prisma/seed-ux-day-pisos.ts");
    assert.deepEqual(Object.keys(databasePackage.dependencies), ["@prisma/client"]);
  });
});

describe("Medida p1…p6 de pisos y mantenimiento (UX-3 · U0)", () => {
  it("_measure-pisos.ts mide p1…p6 con contadores, results-pisos.json ignorado por git y _measure.ts intacto", () => {
    assert.match(measure, /export type PisosTaskId = "p1" \| "p2" \| "p3" \| "p4" \| "p5" \| "p6";/);
    assert.match(measure, /export const TARGETS_P: Record<PisosTaskId/);
    for (const task of ["p1", "p2", "p3", "p4", "p5", "p6"]) assert.match(measure, new RegExp(`${task}: \\{ clicks: [1-3], requests: \\d+, title: "P${task.slice(1)} · `), `objetivo ${task} ≤ 3`);
    for (const fn of ["countedClick", "countedPress", "countedFill", "writeResultP", "performance.mark", '.on("request"', "MEASURE_STRICT", "results-pisos.json", "attach"]) {
      assert.ok(measure.includes(fn), `_measure-pisos.ts debe incluir ${fn}`);
    }
    assert.match(measure, /if \(touch\) await locator\.tap\(\);/, "en tablet las acciones son toques");
    // Corrector UX-3-REV-M01: el estricto afirma «ninguna peor que la baseline de U0» con el toque aceptado por diseño (p5, p6).
    assert.match(measure, /export const BASELINE_CLICK_ALLOWANCE_P: Partial<Record<PisosTaskId, number>> = \{ p5: 1, p6: 1 \};/);
    assert.match(measure, /measure-baseline-2026-09-20\.json/);
    assert.match(measure, /export function baselineViolations\(/);
    assert.match(measure, /if \(STRICT\) \{[\s\S]*?expect\(baselineViolations\(result, readBaselineP\(task, variant\)\)[^\n]*\)\.toEqual\(\[\]\);/);
    assert.match(gitignore, /^apps\/admin-web\/e2e\/measure\/results-pisos\.json$/m);
    assert.ok(measureUx1.includes('const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "results.json");'), "_measure.ts de UX-1 intacto");
  });

  it("hay 6 specs p1…p6 con dos tests cada una (ratón 1280 × 900 y tablet 820 × 1180 táctil), personas del seed, éxito por API y sin skip", () => {
    const dir = new URL("../apps/admin-web/e2e/measure/", import.meta.url);
    const specs = readdirSync(dir).filter((f) => /^p[1-6]-.*\.spec\.ts$/.test(f)).sort();
    assert.deepEqual(specs, [
      "p1-limpia-inspeccionar.spec.ts",
      "p2-mi-turno-siguiente.spec.ts",
      "p3-crear-tarea.spec.ts",
      "p4-reportar-con-foto.spec.ts",
      "p5-tomar-resolver.spec.ts",
      "p6-bloquear-desbloquear.spec.ts"
    ]);
    const users = {
      "p1-limpia-inspeccionar.spec.ts": ["PISOS.users.pisos", "PISOS.users.gobernanta"],
      "p2-mi-turno-siguiente.spec.ts": ["PISOS.users.pisos"],
      "p3-crear-tarea.spec.ts": ["PISOS.users.gobernanta"],
      "p4-reportar-con-foto.spec.ts": ["PISOS.users.pisos", "PISOS.users.encargado"],
      "p5-tomar-resolver.spec.ts": ["PISOS.users.mantenimiento"],
      "p6-bloquear-desbloquear.spec.ts": ["PISOS.users.encargado"]
    };
    for (const [index, file] of specs.entries()) {
      const source = read(`../apps/admin-web/e2e/measure/${file}`);
      assert.ok(source.includes(`"p${index + 1}"`), `${file} mide la tarea p${index + 1}`);
      assert.match(source, /createMeasurePisos\(page, "p[1-6]", variant\)/, `${file} usa el helper`);
      assert.equal((source.match(/test\.describe\(/g) ?? []).length, 2, `${file}: dos bloques (ratón y tablet)`);
      assert.match(source, /test\.use\(\{ viewport: PISOS\.viewports\.raton \}\);/, `${file}: ratón 1280 × 900`);
      assert.match(source, /test\.use\(\{ viewport: PISOS\.viewports\.tablet, hasTouch: true \}\);/, `${file}: tablet 820 × 1180 táctil`);
      assert.match(source, /if \(touch\) await forceCoarse\(page\);/, `${file}: pointer coarse por CDP en tablet`);
      assert.match(source, /loginAsPisos\(page, request, PISOS\.users\./, `${file}: persona del seed`);
      for (const user of users[file]) assert.ok(source.includes(user), `${file}: ${user}`);
      assert.match(source, /measure\.finish\(page, \{\s*completed: (true|false)/, `${file}: escribe el resultado`);
      assert.doesNotMatch(source, /testInfo\.skip\(|test\.skip\(|test\.fixme\(/, `${file} no debe saltarse`);
      assert.doesNotMatch(source, /\/backoffice\//, `${file} usa las URL del árbol`);
      assert.match(source, /expect\(result\.clicks\)\.toBe\(/, `${file}: afirma los clics del camino de hoy (baseline)`);
    }
    assert.match(read("../apps/admin-web/e2e/measure/p4-reportar-con-foto.spec.ts"), /completed: false,[\s\S]*?note: "sin foto/, "p4 acaba completed:false «sin foto» (F4)");
    assert.match(read("../apps/admin-web/e2e/measure/p1-limpia-inspeccionar.spec.ts"), /browser\.newContext\(/, "p1: la gobernanta inspecciona desde otro contexto");
    assert.match(read("../apps/admin-web/e2e/measure/p6-bloquear-desbloquear.spec.ts"), /"Bloquear habitación"[\s\S]*"Resolver"/);
  });

  it("_pisos.ts fija usuarios, rutas del árbol, elección por API y sesión con caché (mismas claves que loginAsUxDay)", () => {
    for (const email of ["pisos@uxday.test", "gobernanta@uxday.test", "mantenimiento@uxday.test", "encargado@uxday.test"]) assert.ok(helpers.includes(`"${email}"`), email);
    for (const route of ["/operaciones/pisos", "/operaciones/pisos/mi-turno", "/operaciones/mantenimiento", "/operaciones/mantenimiento/mis-averias", "/recepcion/reservas/tablero"]) {
      assert.ok(helpers.includes(`"${route}"`), `ruta ${route}`);
    }
    assert.match(helpers, /raton: \{ width: 1280, height: 900 \}/);
    assert.match(helpers, /tablet: \{ width: 820, height: 1180 \}/);
    for (const fn of ["loginAsPisos", "pickDirtyRoom", "pickCleanRoomWithoutTasks", "pickWorkOrder", "roomState", "waitForMiTurno", "forceCoarse", "toastContaining"]) {
      assert.match(helpers, new RegExp(`export (async )?function ${fn}\\(`), fn);
    }
    for (const key of ["hotelos.auth.token", "hotelos.auth.user", "hotelos-active-property", "hotelos-active-org", "hotelos-active-property-name"]) {
      assert.ok(helpers.includes(`"${key}"`), `clave ${key}`);
    }
    assert.match(helpers, /\/auth\/sessions/, "la sesión cacheada se comprueba antes de usarse");
    assert.match(helpers, /loginAsUxDay\(page, request, \{ email \}\)/, "sin sesión válida hace el login real de _helpers");
    assert.match(helpers, /Emulation\.setEmulatedMedia/);
  });
});

describe("Auditoría táctil de pisos y mantenimiento (UX-3 · U0 · proyecto touch)", () => {
  it("e2e/pisos/pisos-target-size.spec.ts recorre las cinco pantallas a 1024 × 768 y 820 × 1180, claro y oscuro, y afirma 0 < 24 px y contraste; lista < 44", () => {
    assert.doesNotMatch(targetSize, /test\.skip\(|testInfo\.skip\(|test\.fixme\(/);
    assert.match(targetSize, /apaisado: \{ width: 1024, height: 768 \}/);
    assert.match(targetSize, /vertical: \{ width: 820, height: 1180 \}/);
    assert.match(targetSize, /const SCHEMES = \["light", "dark"\] as const;/);
    assert.match(targetSize, /test\.use\(\{ viewport, colorScheme: scheme \}\);/);
    for (const [id, path, user] of [
      ["pisos", "PISOS.routes.pisos", "PISOS.users.gobernanta"],
      ["mi-turno", "PISOS.routes.miTurno", "PISOS.users.pisos"],
      ["mantenimiento", "PISOS.routes.mantenimiento", "PISOS.users.encargado"],
      ["mis-averias", "PISOS.routes.misAverias", "PISOS.users.mantenimiento"],
      ["tablero", "PISOS.routes.tablero", "PISOS.users.gobernanta"]
    ]) {
      assert.match(targetSize, new RegExp(`id: "${id}",\\s*path: ${path.replace(/\./g, "\\.")},\\s*user: ${user.replace(/\./g, "\\.")},`), `ruta ${id} con su persona`);
    }
    assert.match(targetSize, /samples\.filter\(\(s\) => s\.min < 24\)/);
    assert.match(targetSize, /samples\.filter\(\(s\) => s\.min < 44\)/);
    assert.match(targetSize, /expect\(offenders, `objetivos < 24 × 24 px \(2\.5\.8\)[\s\S]*?\)\.toEqual\(\[\]\);/);
    assert.match(targetSize, /b\.textRatio < 4\.5/);
    assert.match(targetSize, /b\.borderRatio < 3\) \|\| \(b\.dotRatio !== null && b\.dotRatio < 3\)/);
    assert.match(targetSize, /matchMedia\("\(pointer: coarse\)"\)\.matches/);
    assert.match(targetSize, /below44Summary: summarize\(audit\.below44\)/, "los < 44 se listan en el JSON");
    assert.match(targetSize, /actionBar: document\.querySelector\('\[data-cocoa="action-bar"\]'\) !== null/, "F11: barra del pulgar");
    // Sin nombres: el texto de los controles de fila o tarjeta no se guarda.
    assert.match(targetSize, /return "\(fila\/tarjeta\)";/);
    // El proyecto `touch` de playwright.config.ts la recoge por testMatch /target-size\.spec\.ts$/ y `chromium` la excluye.
    const playwrightConfig = read("../apps/admin-web/playwright.config.ts");
    assert.match(playwrightConfig, /name: "touch",\s*testMatch: \/target-size\\\.spec\\\.ts\$\//);
  });

  it("las baselines de U0 están copiadas a docs/audits/ux-pisos/", () => {
    assert.ok(exists("../docs/audits/ux-pisos/measure-baseline-2026-09-20.json"));
    const baseline = JSON.parse(read("../docs/audits/ux-pisos/measure-baseline-2026-09-20.json"));
    assert.deepEqual(Object.keys(baseline.tasks).sort(), ["p1", "p2", "p3", "p4", "p5", "p6"]);
    for (const [task, variants] of Object.entries(baseline.tasks)) {
      assert.deepEqual(Object.keys(variants).sort(), ["raton", "tablet"], `${task}: ratón y tablet`);
      for (const [variant, result] of Object.entries(variants)) {
        for (const key of ["clicks", "keys", "requests", "ms", "completed", "path", "target", "touch"]) assert.ok(key in result, `${task}.${variant}.${key}`);
        assert.equal(result.touch, variant === "tablet", `${task}.${variant}.touch`);
      }
    }
    assert.equal(baseline.tasks.p4.raton.completed, false, "p4 sin foto (F4)");
    assert.ok(exists("../docs/audits/ux-pisos/target-size-pisos-baseline-2026-09-20.json"));
    const touch = JSON.parse(read("../docs/audits/ux-pisos/target-size-pisos-baseline-2026-09-20.json"));
    assert.equal(touch.criterios.targetMinPx, 24);
    assert.equal(touch.criterios.targetGoalPx, 44);
    assert.ok(Array.isArray(touch.runs) && touch.runs.length >= 20, `runs: ${touch.runs?.length}`);
    for (const run of touch.runs) {
      for (const key of ["id", "route", "viewport", "scheme", "coarse", "totals", "below44Summary", "actionBar"]) assert.ok(key in run, `${run.id}.${key}`);
      assert.doesNotMatch(JSON.stringify(run), /Alfa|Beta|Gamma|Delta|Zeta/, `${run.id}: sin nombres de huéspedes`);
    }
  });
});
