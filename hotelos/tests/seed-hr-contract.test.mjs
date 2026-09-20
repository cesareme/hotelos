// Tanda RRHH · lote RRHH-7 · contrato del tenant de prueba de plantilla, previsión
// y nómina (scratchpad/RRHH/recon-delta.md §3.5; docs/design/RRHH-PLANTILLA-NOMINA.md
// §12 como referencia; reglas: tenants aislados por producto, nunca Faranda).
//
//   · packages/database/prisma/seed-hr.ts existe, pasa por assertDemoTarget, es
//     autónomo (no importa seed.ts, seed-operations.ts, seed-ux-day.ts ni
//     seed-checkin.ts), usa los prefijos del tenant aislado (@hr.test, hr_*,
//     usr_hr_*) y no contiene ningún apellido real (lista negra de apellidos
//     frecuentes y de los huéspedes ficticios de otros seeds);
//   · 24 expedientes ficticios en rooms / fnb / pom / admin_general, 12 con
//     usuario + ficha + contrato (8 indefinidos · 2 fijos discontinuos · 2
//     temporales que vencen en 30 días); NIE sintéticos Z9999xxx con letra
//     válida; el cifrado lo hace la extensión del cliente (nunca a mano) y el
//     update del upsert no reescribe PII;
//   · convenio ES-15-HOST desde HR_AGREEMENT_DEFAULTS, estándares 4★ desde
//     HR_STANDARD_DEFAULTS, plantilla máxima alta/baja aprobada, 90 snapshots
//     demo + 30 previsiones de ingresos, 6 semanas de turnos y fichajes, 3
//     ausencias (pending · approved por OTRO usuario · rejected), 28 días de
//     previsión laboral por departamento y un periodo de nómina del mes en
//     curso open / external; todo relativo a hoy (la única fecha literal es
//     GO_LIVE_AT) y sin Math.random;
//   · los deleteMany van acotados a prop_hr (deleteScoped), a org_hr
//     (deleteOrgScoped) o a los hijos de padres leídos antes en el ámbito
//     (staffing_plan_lines, agreement_rules); nunca toca Faranda, org_123,
//     org_uxday ni org_chk;
//   · org_hr / prop_hr están en la allowlist demo (lib/demo-guard.ts), el
//     script `db:seed:hr` existe y demo-seed-contract lo censa.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const seed = read("../packages/database/prisma/seed-hr.ts");
const guard = read("../packages/database/prisma/lib/demo-guard.ts");
const databasePackage = JSON.parse(read("../packages/database/package.json"));

/** Apellidos que NUNCA pueden aparecer en el seed de prueba (personas ficticias de otros seeds y apellidos frecuentes). */
const SURNAME_BLACKLIST = [
  "Ameijeiras", "Ares", "Baña", "Brey", "Carballo", "Castiñeira", "Cobas", "Cueto", "Docampo", "Espiño", "Freire",
  "Insua", "Lavandera", "Lema", "Menéndez", "Nogueira", "Piñeiro", "Prieto", "Requeijo", "Rial", "Rubido", "Salgado",
  "Souto", "Turnes", "Varela", "Vieites", "Vilar", "Lopez", "López", "Garcia", "García", "Fernández", "Fernandez",
  "Rodríguez", "Rodriguez", "Martínez", "Martinez", "Pérez", "Perez", "Sánchez", "Sanchez", "Gómez", "Gomez", "González",
  "Gonzalez", "Ruiz", "Díaz", "Diaz", "Hernández", "Moreno", "Jiménez", "Álvarez", "Romero", "Torres", "Navarro", "Vázquez",
  "Ramos", "Gil", "Serrano", "Blanco", "Molina", "Castro", "Ortiz", "Rubio", "Marín", "Sanz", "Iglesias", "Núñez", "Medina",
  "Garrido", "Cortés", "Santos", "Lozano", "Guerrero", "Cano", "Méndez", "Cruz", "Flores", "Herrera", "Peña", "Vega", "Fuentes",
  "Carrasco", "Diez", "Caballero", "Reyes", "Nieto", "Aguilar", "Pascual", "Herrero", "Santana", "Lorenzo", "Hidalgo", "Montero",
  "Ibáñez", "Ferrer", "Duran", "Vicente", "Benítez", "Mora", "Vidal", "Arias", "Carmona", "Crespo", "Soto", "Román", "Pastor",
  "Velasco", "Parra", "Sáez", "Moya", "Bravo", "Rivera", "Gallego", "Rey", "Silva", "Calvo", "Otero", "Costa", "Pereira",
  // Personas ficticias de seed-operations.ts (nombres «reales» que este seed no reutiliza).
  "Marín", "Soto", "Torres", "Gómez", "Ruiz", "Díaz", "López", "Navarro"
];

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

function importSpecifiers(source) {
  return [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
}

/** Una línea por expediente dentro de EMPLOYEES: `{ n: <número>, dept: "<REC|HSK|FNB|MNT|ADM>", …`. */
function employeeLines(source) {
  const block = /export const EMPLOYEES: readonly EmployeeSpec\[\] = \[\n([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, "bloque EMPLOYEES");
  return block[1].split("\n").filter((line) => /^\s+\{ n: \d+, dept: "/.test(line));
}

describe("Seed «tenant de prueba HR» (RRHH-7)", () => {
  it("existe, pasa por assertDemoTarget (tras el dry-run) y solo escribe en el tenant aislado", () => {
    assert.match(seed, /assertDemoTarget\(\{ orgId: ORG_ID, propertyId: PROPERTY_ID, action: `seed-hr \(\$\{reset \? "reset" : "ensure"\}\)`, planned \}\)/);
    assert.match(seed, /export const ORG_ID = "org_hr"/);
    assert.match(seed, /export const LEGAL_ENTITY_ID = "le_hr"/);
    assert.match(seed, /export const PROPERTY_ID = "prop_hr"/);
    assert.match(seed, /export const PROPERTY_CODE = "HR"/);
    assert.match(seed, /export const PROPERTY_NAME = "Hotel HR \(prueba\)"/);
    assert.match(seed, /export const EMAIL_DOMAIN = "hr\.test"/);
    assert.match(seed, /process\.env\.SEED_HR_PASSWORD\?\.trim\(\) \|\| "hr-demo"/, "contraseña sustituible");
    assert.match(seed, /hashPassword\(DEMO_PASSWORD\)/);
    assert.match(seed, /syncPermissionCatalog\(\)/);
    assert.match(seed, /provisionDefaultTemplateRoles\(ORG_ID\)/);
    assert.match(seed, /applyRoleTemplate\(roleId, templateKey\)/);
    assert.match(seed, /provisionOrganizationChart\(ORG_ID\)/);
    assert.match(seed, /ensurePropertySettings\(PROPERTY_ID\)/);
    assert.match(seed, /export const TIME_ZONE = "Europe\/Madrid"/);
    assert.match(seed, /timezone: TIME_ZONE/);
    assert.match(seed, /taxRegion: "ES_PENINSULA_BALEARES"/);
    assert.match(seed, /goLiveAt: GO_LIVE_AT/);
    assert.match(seed, /GO_LIVE_AT = new Date\("2026-01-01T00:00:00\.000Z"\)/);
    assert.match(seed, /NODE_ENV === "production" && process\.env\.SEED_HR_ALLOW_PRODUCTION !== "1"/, "guarda de producción");
    assert.match(seed, /args\.includes\("--reset"\)/);
    assert.match(seed, /args\.includes\("--dry-run"\)/);
    assert.match(seed, /if \(dryRun\) \{[\s\S]*?log\("\[seed-hr\] dry-run: nada escrito\."\);\s*return;/);
    assert.ok(seed.indexOf('log("[seed-hr] dry-run: nada escrito.")') < seed.indexOf("assertDemoTarget({ orgId: ORG_ID"), "el dry-run sale antes de la guarda y de cualquier escritura");
    // La sociedad de prueba tiene su propio CIF (distinto del de CHK 2026_0920 y del de UXDAY).
    assert.match(seed, /LEGAL_ENTITY_TAX_ID = cifFor\("B", 2026_0921\)/);
    assert.match(seed, /El NIF \$\{LEGAL_ENTITY_TAX_ID\} ya pertenece a la sociedad/, "aborta si el CIF ya es de otra sociedad");
    assert.match(seed, /ya existe en otra organización/, "aborta si el correo es de otra organización");
  });

  it("es autónomo: no importa seed.ts, seed-operations.ts, seed-ux-day.ts ni seed-checkin.ts; toma convenios y estándares de hr-types", () => {
    const specifiers = importSpecifiers(seed);
    assert.ok(specifiers.length >= 6, `imports parsed: ${specifiers.length}`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /seed\.js$|seed\.ts$|seed-operations|seed-commercial|seed-rbac|seed-ux-day|seed-checkin|seed-revenue|seed-compliance/, `import prohibido: ${specifier}`);
    }
    assert.ok(specifiers.includes("../../shared/src/hr-types.js"), "HR_AGREEMENT_DEFAULTS / HR_STANDARD_DEFAULTS de packages/shared");
    assert.ok(specifiers.includes("../src/client.js"), "cliente de @hotelos/database (extensión de cifrado)");
    assert.ok(specifiers.includes("./lib/demo-guard.js"));
    assert.doesNotMatch(seed, /demoStore|hydrateTenantMirrors/);
  });

  it("usuarios principales con su plantilla, hotel de 4★ con 60 habitaciones, centros de coste USALI y módulos del producto", () => {
    for (const [local, templateKey] of [["direccion", "general_manager"], ["rrhh", "payroll_hr"], ["jefe.pisos", "housekeeping_manager"], ["camarera1", "housekeeper"]]) {
      const re = new RegExp(`user: \\{ local: "${local.replace(".", "\\.")}", templateKey: "${templateKey}"`);
      assert.match(seed, re, `${local} → ${templateKey} (expediente con usuario)`);
      assert.match(seed, new RegExp(`\\{ local: "${local.replace(".", "\\.")}", templateKey: "${templateKey}" \\}`), `${local} en PRINCIPAL_USERS`);
    }
    assert.match(seed, /El usuario principal \$\{principal\.local\}/, "los principales se comprueban contra EMPLOYEES");
    assert.match(seed, /scopeType: "property", propertyId: PROPERTY_ID, organizationId: ORG_ID, reason: "seed hr \(tenant de prueba\)"/);
    assert.match(seed, /export const STAR_RATING = 4/);
    assert.match(seed, /starRating: STAR_RATING/);
    assert.match(seed, /code: "DBL", name: "Doble", maxOccupancy: 2, displayOrder: 1, numbers: \[\.\.\.range\(101, 120\), \.\.\.range\(201, 220\)\]/);
    assert.match(seed, /code: "SUP", name: "Superior", maxOccupancy: 3, displayOrder: 2, numbers: range\(301, 320\)/);
    for (const code of ["ROOMS", "FNB", "POM", "ADMIN_GENERAL"]) assert.match(seed, new RegExp(`code: "${code}", name: "[^"]+", usali: "[a-z_]+"`), `centro de coste ${code}`);
    assert.match(seed, /type: "usali", active: true/);
    for (const code of ["REC", "HSK", "FNB", "MNT", "ADM"]) assert.match(seed, new RegExp(`code: "${code}", name: "[^"]+", usali: "(rooms|fnb|pom|admin_general)"`), `departamento ${code}`);
    for (const code of ["pms_core", "workforce_labor", "housekeeping", "maintenance"]) assert.ok(seed.includes(`"${code}"`), `módulo ${code} activado`);
    assert.match(seed, /prisma\.propertyModule\.upsert\(\{\s*where: \{ propertyId_moduleId: \{ propertyId: PROPERTY_ID, moduleId: module\.id \} \}/);
    assert.match(seed, /sesHospedajesEnabled: false/, "sin SES ni VeriFactu en el tenant RRHH");
    assert.match(seed, /verifactuEnabled: false/);
  });

  it("24 expedientes ficticios en rooms/fnb/pom/admin_general: 12 con usuario, ficha y contrato (8 indefinidos · 2 fijos discontinuos · 2 temporales a 30 días)", () => {
    const lines = employeeLines(seed);
    assert.equal(lines.length, 24, "24 expedientes");
    const numbers = lines.map((line) => Number(/\{ n: (\d+),/.exec(line)[1]));
    assert.deepEqual(numbers, Array.from({ length: 24 }, (_, i) => i + 1), "numerados 1..24 sin huecos");
    const withUser = lines.filter((line) => /user: \{ local: "[a-z0-9.]+", templateKey: "[a-z_]+"/.test(line));
    assert.equal(withUser.length, 12, "12 con usuario + ficha + contrato");
    const contracts = { indefinido: 0, fijo_discontinuo: 0, temporal: 0 };
    for (const line of withUser) contracts[/contract: "([a-z_]+)"/.exec(line)[1]] += 1;
    assert.deepEqual(contracts, { indefinido: 8, fijo_discontinuo: 2, temporal: 2 });
    const byDept = {};
    for (const line of lines) {
      const dept = /dept: "([A-Z]+)"/.exec(line)[1];
      byDept[dept] = (byDept[dept] ?? 0) + 1;
    }
    assert.deepEqual(byDept, { REC: 4, HSK: 8, FNB: 6, MNT: 2, ADM: 4 }, "rooms 12 (REC 4 + HSK 8) · fnb 6 · pom 2 · admin_general 4");
    const templates = new Set(withUser.map((line) => /templateKey: "([a-z_]+)"/.exec(line)[1]));
    assert.deepEqual([...templates].sort(), ["fnb", "general_manager", "housekeeper", "housekeeping_manager", "maintenance", "payroll_hr", "receptionist"]);
    assert.match(seed, /export const TEMPORARY_CONTRACT_ENDS_IN_DAYS = 30/);
    assert.match(seed, /endDate: temporary \? dateOnly\(isoPlus\(today, TEMPORARY_CONTRACT_ENDS_IN_DAYS\)\) : null/, "los temporales vencen en 30 días");
    assert.match(seed, /fixedDiscontinuous: user\.contract === "fijo_discontinuo"/);
    assert.match(seed, /contractType: user\.contract,/);
    assert.match(seed, /agreementId: AGREEMENT_ID,\s*weeklyHours: money\(weeklyHours\),\s*partTimePct: money\(\(weeklyHours \/ 40\) \* 100\)/, "convenio, jornada y % de jornada en el contrato");
    assert.match(seed, /contributionGroup: user\.group/);
    assert.match(seed, /payCount: 12 \+ HR_AGREEMENT_DEFAULTS\[AGREEMENT_CODE\]\.rules\.extra_pay_count/, "12 mensualidades + pagas extra del convenio");
    // La ficha de centro apunta al expediente (RRHH-1: StaffProfile.employeeId / usaliDepartment / jobTitle; userId sigue obligatorio).
    assert.match(seed, /userId: userIdFor\(user\.local\),\s*propertyId: PROPERTY_ID,\s*employeeCode: employeeNumberFor\(spec\.n\),/);
    assert.match(seed, /employeeId: employeeIdFor\(spec\.n\),\s*usaliDepartment: dept\.usali,\s*jobTitle: spec\.jobTitle/);
    assert.match(seed, /employeeNumberFor = \(n: number\): string => `HR-\$\{String\(n\)\.padStart\(3, "0"\)\}`/);
    assert.match(seed, /hiredAt = dateOnly\(monthsBefore\(today, spec\.hiredMonthsAgo\)\)/, "antigüedad relativa a hoy");
  });

  it("PII cifrada por la extensión del cliente: NIE sintéticos Z9999xxx con letra válida, nada cifrado a mano y sin PII en el update del upsert", () => {
    assert.match(seed, /NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE"/);
    assert.match(seed, /export function syntheticNieFor\(n: number\): string \{\s*const digits = String\(9_999_000 \+ n\)\.padStart\(7, "0"\);\s*const letter = NIF_LETTERS\[Number\(`2\$\{digits\}`\) % 23\];\s*return `Z\$\{digits\}\$\{letter\}`;/);
    // Mismo algoritmo que el seed: la letra de los 24 NIE es válida (Z → 2 en el módulo 23).
    for (let n = 1; n <= 24; n += 1) {
      const digits = String(9_999_000 + n).padStart(7, "0");
      assert.equal(NIF_LETTERS[Number(`2${digits}`) % 23].length, 1, `NIE ${n}`);
    }
    assert.match(seed, /taxId: syntheticNieFor\(spec\.n\),\s*socialSecurityNumber: syntheticNafFor\(spec\.n\),\s*email: emailFor\(local\),\s*phone: `\+34600001\$\{String\(spec\.n\)\.padStart\(3, "0"\)\}`,\s*iban: syntheticIbanFor\(spec\.n\)/);
    assert.doesNotMatch(seed, /encryptField|computeLookupHash|taxIdLookupHash:|\$executeRaw|\$queryRaw|crypto-fields/, "el cifrado y el hash los pone la extensión (PII_FIELDS.Employee)");
    const upsert = /prisma\.employee\.upsert\(\{[\s\S]*?update: \{([^\n]*)\},/.exec(seed);
    assert.ok(upsert, "employee.upsert con update");
    assert.doesNotMatch(upsert[1], /taxId|socialSecurityNumber|email|phone|iban|firstName|lastName/, "el update no reescribe PII ni nombres");
    assert.match(seed, /syntheticIbanFor[\s\S]*?remainder = \(remainder \* 10 \+ Number\(ch\)\) % 97/, "IBAN con dígitos de control válidos (módulo 97)");
    assert.match(seed, /syntheticNafFor[\s\S]*?Number\(body\) % 97/, "NAF con control módulo 97");
  });

  it("no contiene ningún apellido real ni nombres de personas reales (ficticios con apellidos griegos); correos solo @hr.test", () => {
    const names = [...seed.matchAll(/"([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)"/g)].map((m) => m[1]);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    for (const surname of SURNAME_BLACKLIST) assert.ok(!lower.has(surname.toLowerCase()), `apellido real en el seed: ${surname}`);
    assert.match(seed, /GREEK_SURNAMES = \["Alfa", "Beta", "Gamma"/);
    assert.match(seed, /FIRST_NAMES = \["Ana", "Luis", "Marta"/);
    assert.match(seed, /export function employeeNameFor\(n: number\)/, "nombres deterministas por número de expediente");
    assert.match(seed, /lastName: `\$\{s1\} \$\{s2\}`/, "dos apellidos griegos");
    const emails = [...seed.matchAll(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]+/g)].map((m) => m[0]);
    assert.ok(emails.length >= 1, "algún correo literal en cabecera o logs");
    for (const email of emails) assert.ok(email.endsWith("@hr.test"), `correo fuera de @hr.test: ${email}`);
    assert.match(seed, /emailFor = \(local: string\): string => `\$\{local\}@\$\{EMAIL_DOMAIN\}`/);
    assert.doesNotMatch(seed, /@faranda\.test|@example\.com|@ehotelos\.demo|@chk\.test|@uxday\.test/);
  });

  it("convenio ES-15-HOST desde HR_AGREEMENT_DEFAULTS (asignado al hotel y a los contratos), estándares 4★ desde HR_STANDARD_DEFAULTS y plantilla alta/baja aprobada", () => {
    assert.match(seed, /export const AGREEMENT_CODE = "ES-15-HOST" as const/);
    assert.match(seed, /export const AGREEMENT_ID = "hr_agr_es15"/);
    assert.match(seed, /const spec = HR_AGREEMENT_DEFAULTS\[AGREEMENT_CODE\];/);
    assert.match(seed, /validFrom: dateOnly\(spec\.validFrom\),\s*validTo: spec\.validTo \? dateOnly\(spec\.validTo\) : null,\s*ultraactivity: spec\.ultraactivity/);
    assert.match(seed, /for \(const \[key, value\] of Object\.entries\(spec\.rules\) as Array<\[HrAgreementRuleKey, unknown\]>\)/, "una AgreementRule por clave del convenio");
    assert.match(seed, /valueJson: jsonOf\(value\)/);
    assert.match(seed, /value === null \? Prisma\.JsonNull/, "los topes nulos del convenio se guardan como JSON null");
    assert.match(seed, /update: \{ starRating: STAR_RATING, agreementId: AGREEMENT_ID \}/, "Property.agreementId también al reafirmar");
    assert.match(seed, /HR_STANDARD_DEFAULTS\[hrStarBandOf\(STAR_RATING\)\]/);
    assert.match(seed, /source: "sector_default"/);
    // Corrector RRHH (SEC-08): un único escritor de labor_standards (standards.service) y de labor_forecasts (labor-forecast.service).
    assert.match(seed, /export function effectiveStandardCount\(\): number \{\s*return mergeSameDriverStandards\(/, "un estándar por (departamento, driver): la misma fusión que resetLaborStandardDefaults");
    assert.match(seed, /resetLaborStandardDefaults\(\{ context: seedContext\(\), propertyId: PROPERTY_ID, validFrom: `\$\{year\}-01-01`, correlationId: "seed-hr:standards" \}\)/, "estándares vigentes desde el 1 de enero del año en curso, por el servicio");
    assert.doesNotMatch(seed, /prisma\.laborStandard\.upsert|prisma\.laborForecast\.upsert|laborNeedFor/, "el seed no calcula ni escribe estándares ni previsiones por su cuenta");
    assert.match(seed, /\{ id: "hr_plan_high", season: "high", fromMonth: 4, toMonth: 10 \}/);
    assert.match(seed, /\{ id: "hr_plan_low", season: "low", fromMonth: 11, toMonth: 3 \}/);
    assert.match(seed, /status: "approved",\s*createdBy: userIdFor\("rrhh"\),\s*approvedBy: userIdFor\("direccion"\)/, "aprobado por dirección, creado por RRHH");
    assert.match(seed, /planId_usaliDepartment: \{ planId: season\.id, usaliDepartment: department \}/);
    assert.match(seed, /FORECAST_DEPARTMENTS: readonly HrUsaliDepartment\[\] = \["rooms", "fnb", "pom", "admin_general"\]/);
  });

  it("demanda determinista: 90 snapshots demo y 30 previsiones de ingresos top-level, 6 semanas de turnos y fichajes, 3 ausencias, 28 días de previsión laboral por departamento y periodo de nómina del mes open/external", () => {
    assert.match(seed, /export const SNAPSHOT_DAYS = 90/);
    assert.match(seed, /export const FORECAST_DAYS = 30/);
    assert.match(seed, /export const LABOR_FORECAST_DAYS = 28/);
    assert.match(seed, /export const SHIFT_DAYS_BEFORE = 35/);
    assert.match(seed, /export const SHIFT_DAYS_AFTER = 6/);
    assert.doesNotMatch(seed, /Math\.random/, "reproducible: ruido determinista");
    assert.match(seed, /const topLevel = \{ roomTypeId: null, ratePlanId: null, channelId: null, segment: null, market: null \};/);
    assert.match(seed, /dataSource: "demo"/);
    // SEC-08: previsiones con prefijo pms_import (drivers.service solo usa esas como driver) y desde hoy (offset 0).
    assert.match(seed, /export const FORECAST_MODEL_VERSION = "pms_import:seed-hr-demo"/);
    assert.match(seed, /modelVersion: FORECAST_MODEL_VERSION/);
    assert.match(seed, /for \(let offset = 0; offset < FORECAST_DAYS; offset \+= 1\)/);
    // Reservas demo con régimen (cubiertos de la previsión de A&B), sin datos personales, reemplazadas enteras.
    assert.match(seed, /export const DEMO_RESERVATION_PREFIX = "HRDEMO-"/);
    assert.match(seed, /boardType: dow === 5 \|\| dow === 6 \? "HB" : "BB"/);
    assert.doesNotMatch(seed, /guestName|bookerName|guestEmail/, "las reservas demo no llevan huésped");
    assert.match(seed, /todayIn\(TIME_ZONE, now\)/);
    // Turnos: patrones por puesto, descansos, rotación de recepción y sin turno en las vacaciones aprobadas.
    assert.match(seed, /status = past \? "completed" : shift\.iso === today && started \? "confirmed" : "scheduled"/);
    assert.match(seed, /roleLabel: "Recepción noche"/);
    assert.match(seed, /if \(absent\.get\(spec\.n\)\?\.has\(iso\)\) continue;/, "sin turno en las vacaciones aprobadas");
    assert.match(seed, /clockType: "in"/);
    assert.match(seed, /clockType: "out"/);
    assert.match(seed, /export const CLOCK_SOURCE = "seed-hr"/);
    assert.match(seed, /prisma\.shift\.createMany\(\{ data: shiftRows, skipDuplicates: true \}\)/);
    assert.match(seed, /prisma\.timeClockEntry\.createMany\(\{ data: clockRows, skipDuplicates: true \}\)/);
    // Ausencias: pending · approved por OTRO usuario · rejected (CHECK absence_requests_requested_ne_approved).
    const absences = [...seed.matchAll(/\{ id: "(hr_abs_\d\d)", n: (\d+), absenceType: "([a-z_]+)", fromOffset: (-?\d+), toOffset: (-?\d+), status: "([a-z]+)", decidedByLocal: (null|"[a-z.]+")/g)];
    assert.equal(absences.length, 3);
    assert.deepEqual(absences.map((m) => m[6]).sort(), ["approved", "pending", "rejected"]);
    const approved = absences.find((m) => m[6] === "approved");
    const lines = employeeLines(seed);
    const requester = /user: \{ local: "([a-z0-9.]+)"/.exec(lines[Number(approved[2]) - 1])[1];
    assert.notEqual(`"${requester}"`, approved[7], "la ausencia aprobada la decide otro usuario (requestedBy ≠ approvedBy)");
    assert.equal(absences.find((m) => m[6] === "pending")[7], "null");
    assert.match(seed, /const approvedBy = absence\.status === "approved" && absence\.decidedByLocal \? userIdFor\(absence\.decidedByLocal\) : null;/);
    assert.match(seed, /const requestedBy = userIdFor\(EMPLOYEES\.find\(\(e\) => e\.n === absence\.n\)!\.user!\.local\);/);
    assert.match(seed, /decidedAt: decided \? new Date\(\) : null/);
    // Previsión laboral (SEC-08): la escribe generateLaborForecast (único escritor) sobre la ventana de 28 días desde hoy.
    assert.match(seed, /generateLaborForecast\(\{ context: seedContext\(\), propertyId: PROPERTY_ID, from: today, to: isoPlus\(today, LABOR_FORECAST_DAYS - 1\), correlationId: "seed-hr:labor-forecast", today: dateOnly\(today\) \}\)/);
    assert.match(seed, /await flushAuditQueues\(\);/, "las auditorías de los servicios se vacían antes de cerrar");
    assert.match(seed, /permissions: \["hr\.standards\.manage", "workforce\.schedule\.manage"\]/, "el contexto del seed lleva solo las claves de los dos escritores");
    // Periodo de nómina del mes en curso, abierto y en modo externo.
    assert.match(seed, /periodCode, startDate: start, endDate: end, status: "open", mode: "external"/);
    assert.match(seed, /export function periodCodeOf\(iso: string\): string \{\s*return iso\.slice\(0, 7\);/);
    const literalDates = [...seed.matchAll(/"20\d{2}-\d{2}-\d{2}/g)];
    assert.equal(literalDates.length, 1, `la única fecha literal es GO_LIVE_AT: ${literalDates.map((m) => m[0]).join(", ")}`);
  });

  it("los deleteMany van acotados a prop_hr (deleteScoped), a org_hr (deleteOrgScoped) o a los hijos de padres leídos en el ámbito; nunca toca Faranda ni otros tenants", () => {
    const calls = [...seed.matchAll(/deleteMany\(/g)];
    assert.equal(calls.length, 4, "deleteScoped + deleteOrgScoped + líneas de plan + reglas de convenio");
    assert.match(seed, /const where = \{ \.\.\.extraWhere, propertyId: PROPERTY_ID \};/);
    assert.match(seed, /const where = \{ \.\.\.extraWhere, organizationId: ORG_ID \};/);
    assert.match(seed, /const planIds = \(await prisma\.staffingPlan\.findMany\(\{ where: \{ propertyId: PROPERTY_ID \}, select: \{ id: true \} \}\)\)\.map\(\(p\) => p\.id\);/);
    assert.match(seed, /prisma\.staffingPlanLine\.deleteMany\(\{ where: \{ planId: \{ in: planIds \} \} \}\)/);
    assert.match(seed, /const agreementIds = \(await prisma\.collectiveAgreement\.findMany\(\{ where: \{ organizationId: ORG_ID \}, select: \{ id: true \} \}\)\)\.map\(\(a\) => a\.id\);/);
    assert.match(seed, /prisma\.agreementRule\.deleteMany\(\{ where: \{ agreementId: \{ in: agreementIds \} \} \}\)/);
    for (const model of ["timeClockEntry", "shift", "absenceRequest", "laborForecast", "laborStandard", "staffingPlan", "staffProfile"]) {
      assert.match(seed, new RegExp(`deleteScoped\\("${model}"\\)`), `${model} acotado a prop_hr`);
    }
    for (const model of ["employmentContract", "employee", "collectiveAgreement", "payrollPeriod"]) {
      assert.match(seed, new RegExp(`deleteOrgScoped\\("${model}"\\)`), `${model} acotado a org_hr`);
    }
    assert.match(seed, /deleteScoped\("revenueDailySnapshot", \{ dataSource: "demo" \}\)/, "--reset solo borra los snapshots demo");
    assert.match(seed, /deleteScoped\("revenueDailySnapshot", \{ dataSource: "demo", snapshotDate: \{ gte: windowStart, lte: dateOnly\(today\) \}, \.\.\.topLevel \}\)/, "la ventana se reemplaza sin tocar cierres reales");
    assert.match(seed, /export const LEGACY_FORECAST_MODEL_VERSION = "seed-hr-demo"/);
    assert.match(seed, /deleteScoped\("revenueForecast", \{ modelVersion: \{ in: FORECAST_MODEL_VERSIONS \} \}\)/, "retira también las previsiones del seed anterior (mismos ids hr_rf_*)");
    assert.match(seed, /deleteScoped\("reservation", \{ code: \{ startsWith: DEMO_RESERVATION_PREFIX \} \}\)/, "solo las reservas demo HRDEMO-*");
    assert.doesNotMatch(seed, /deleteScoped\("(room|roomType|department|costCenter|propertyModule)"|deleteOrgScoped\("(user|role|userRoleAssignment)"/, "el esqueleto del tenant (usuarios, roles, habitaciones, módulos) nunca se borra");
    assert.doesNotMatch(seed, /cmrhw9jy30002fyvb6tsdiugt|cmrhw9jy4|cmu4805|cmu1mifcp|org_123|prop_123|prop_canary|org_uxday|prop_uxday|org_chk|prop_chk/, "nunca toca Faranda (ids de organización/propiedades), el demo base, UXDAY ni CHK");
  });

  it("está en la allowlist demo, tiene script pnpm y demo-seed-contract lo censa", () => {
    assert.match(guard, /DEMO_ORG_IDS: readonly string\[\] = \["org_123", "org_uxday", "org_chk", "org_act", "org_hr"\]/);
    assert.match(guard, /DEMO_PROPERTY_IDS: readonly string\[\] = \["prop_123", "prop_canary", "prop_uxday", "prop_chk", "prop_hr"\]/);
    assert.equal(databasePackage.scripts["db:seed:hr"], "node --env-file=../../.env --import tsx prisma/seed-hr.ts");
    assert.match(read("./demo-seed-contract.test.mjs"), /"seed-hr\.ts"/);
  });
});
