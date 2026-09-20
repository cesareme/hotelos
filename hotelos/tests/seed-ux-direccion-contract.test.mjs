// Tanda UX-2 · lote D1 · contrato del seed de dirección (packages/database/prisma/seed-ux-direccion.ts).
//
//   · existe, pasa por assertDemoTarget y solo escribe en org_uxday / prop_uxday_b
//     (ids fijos *_uxdb_*, prefijo UXDB-, correo director@uxday.test);
//   · es autónomo: no importa seed.ts, seed-operations.ts, seed-commercial, seed-rbac
//     ni seed-ux-day.ts (que ejecuta main() al importarse); los tipos del cierre
//     vienen de packages/shared/src/pos-types.ts como `import type`;
//   · el director usa la plantilla «manager» y queda asignado a prop_uxday y
//     prop_uxday_b; direccion@uxday.test también a prop_uxday_b;
//   · siembra el día (12 alojadas, 2 salidas, 3 llegadas), el cierre de anteayer
//     completado por usr_uxday_recepcion, 3 aprobaciones pending (refund 60,
//     folio_adjust 25, purchase_order 900; reasonCode seed-ux2; +7 d), 3 ítems IA
//     y SNAPSHOT_DAYS snapshots diarios de nivel superior (corrector UX2-REV-04:
//     ids rds_uxdb_<fecha>, las dos últimas noches desde el plan, borrados en --reset);
//   · nunca imprime la contraseña (corrector UX2-REV-07: solo DEMO_PASSWORD_LABEL);
//   · el ÚNICO deleteMany del fichero es deleteScoped con `propertyId: PROPERTY_ID`;
//     --reset nunca toca prop_uxday (BASE_PROPERTY_ID solo se lee y se asigna);
//   · prop_uxday_b está en la allowlist demo y existe el script db:seed:ux-direccion;
//   · sin apellidos reales (personas ficticias con apellidos griegos).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const seed = read("../packages/database/prisma/seed-ux-direccion.ts");
const guard = read("../packages/database/prisma/lib/demo-guard.ts");
const databasePackage = JSON.parse(read("../packages/database/package.json"));

/** Apellidos que NUNCA pueden aparecer en el seed (misma lista negra que seed-ux-day-contract). */
const SURNAME_BLACKLIST = [
  "Ameijeiras", "Ares", "Baña", "Brey", "Carballo", "Castiñeira", "Cobas", "Cueto", "Docampo", "Espiño", "Freire",
  "Insua", "Lavandera", "Lema", "Menéndez", "Nogueira", "Piñeiro", "Prieto", "Requeijo", "Rial", "Rubido", "Salgado",
  "Souto", "Turnes", "Varela", "Vieites", "Vilar", "Lopez", "López", "Garcia", "García", "Fernández", "Rodríguez",
  "Martínez", "Pérez", "Sánchez", "Gómez"
];

function importSpecifiers(source) {
  return [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
}

describe("Seed de dirección UX-2 (D1)", () => {
  it("existe, pasa por assertDemoTarget y usa los ids fijos del hotel B de org_uxday", () => {
    assert.match(seed, /assertDemoTarget\(\{ orgId: ORG_ID, propertyId: PROPERTY_ID/);
    assert.match(seed, /export const ORG_ID = "org_uxday"/);
    assert.match(seed, /export const LEGAL_ENTITY_ID = "le_uxday"/);
    assert.match(seed, /export const BASE_PROPERTY_ID = "prop_uxday"/);
    assert.match(seed, /export const PROPERTY_ID = "prop_uxday_b"/);
    assert.match(seed, /export const PROPERTY_CODE = "UXDB"/);
    assert.match(seed, /export const PROPERTY_NAME = "Hotel UXDAY B \(prueba\)"/);
    assert.match(seed, /export const RESERVATION_PREFIX = "UXDB-"/);
    assert.match(seed, /export const EMAIL_DOMAIN = "uxday\.test"/);
    assert.match(seed, /process\.env\.SEED_UXDAY_PASSWORD\?\.trim\(\) \|\| "uxday-demo"/, "misma contraseña de demo que seed-ux-day");
    assert.match(seed, /hashPassword\(DEMO_PASSWORD\)/);
    assert.match(seed, /kind: "hotel"/);
    assert.match(seed, /timezone: TIME_ZONE/);
    assert.match(seed, /export const TIME_ZONE = "Europe\/Madrid"/);
    assert.match(seed, /verifactuEnabled: false/);
    assert.match(seed, /ensurePropertySettings\(PROPERTY_ID\)/);
    assert.match(seed, /id: "rt_uxdb_dbl", code: "DBL", name: "Doble", price: 89, maxOccupancy: 2, numbers: range\(101, 120\)/);
    assert.match(seed, /export const RATE_PLAN_ID = "rp_uxdb_bar"/);
    assert.match(seed, /code: "BAR"/);
    assert.match(seed, /NODE_ENV === "production" && process\.env\.SEED_UXDAY_ALLOW_PRODUCTION !== "1"/, "guarda de producción (R9)");
  });

  it("es autónomo: no importa seed.ts, seed-operations ni seed-ux-day (main() al importar)", () => {
    const specifiers = importSpecifiers(seed);
    assert.ok(specifiers.length >= 5, `imports parsed: ${specifiers.length}`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /seed\.js$|seed\.ts$|seed-operations|seed-commercial|seed-rbac|seed-ux-day|seed-checkin/, `import prohibido: ${specifier}`);
    }
    assert.match(seed, /^import type \{ NightAuditReportWire, NightAuditStepWire \} from "\.\.\/\.\.\/shared\/src\/pos-types\.js";/m, "tipos del cierre solo como import type");
    assert.match(seed, /^import type \{ Prisma \} from "@prisma\/client";/m);
  });

  it("director con plantilla manager en prop_uxday y prop_uxday_b; direccion@uxday.test también en el hotel B", () => {
    assert.match(seed, /export const DIRECTOR = \{ id: "usr_uxday_director", local: "director", fullName: "Director UXDAY", templateKey: "manager" \} as const/);
    assert.match(seed, /export const DIRECCION_USER_ID = "usr_uxday_direccion"/);
    assert.match(seed, /export const RECEPCION_USER_ID = "usr_uxday_recepcion"/);
    assert.match(seed, /syncPermissionCatalog\(\)/);
    assert.match(seed, /provisionDefaultTemplateRoles\(ORG_ID\)/);
    assert.match(seed, /const managerRoleId = roles\[DIRECTOR\.templateKey\]/);
    assert.match(seed, /for \(const propertyId of \[BASE_PROPERTY_ID, PROPERTY_ID\]\) \{\n\s+if \(await ensureAssignment\(directorId, managerRoleId, propertyId\)\)/);
    assert.match(seed, /ensureAssignment\(DIRECCION_USER_ID, direccionRoleId, PROPERTY_ID\)/);
    assert.match(seed, /scopeType: "property", propertyId, organizationId: ORG_ID, reason: "seed ux-direccion \(tenant de prueba\)"/);
    assert.match(seed, /ya existe en otra organización/, "nunca reasigna un correo de otra organización");
  });

  it("siembra el día de dirección, el cierre de anteayer y los pendientes con fechas relativas a hoy", () => {
    assert.match(seed, /todayIn\(TIME_ZONE\)/);
    assert.match(seed, /for \(let i = 1; i <= 12; i \+= 1\)/, "12 alojadas");
    assert.match(seed, /arrivalOffset: -1,\n\s+departureOffset: 2/, "alojadas: llegaron ayer, salen hoy+2");
    for (const code of ["S01", "S02", "L01", "L02", "L03"]) assert.match(seed, new RegExp(`code: \`\\$\\{RESERVATION_PREFIX\\}${code}\``));
    assert.match(seed, /room: 113, arrivalOffset: -2, departureOffset: 0/, "salidas de hoy");
    assert.match(seed, /room: 115, arrivalOffset: 0, departureOffset: 1/, "llegadas de hoy");
    assert.match(seed, /status: "captured"/, "solo los pagos captured dejan saldo");
    // Cierre de anteayer completado ayer por recepción, con la forma de NightAuditRunWire.
    assert.match(seed, /export const NIGHT_AUDIT_RUN_ID = "nar_uxdb_anteayer"/);
    assert.match(seed, /businessDate: dateOnly\(dayBeforeYesterday\),\n\s+status: "completed"/);
    assert.match(seed, /startedBy: RECEPCION_USER_ID/);
    assert.match(seed, /stepResultsJson: \{ steps, report \} as unknown as Prisma\.InputJsonValue/);
    for (const step of ["validate_open_folios", "snapshot_room_status", "post_room_charges", "process_no_shows", "close_settled_folios", "revenue_snapshot", "payments_summary", "cash_closures", "advance_business_date"]) {
      assert.match(seed, new RegExp(`step: "${step}"`), `paso ${step}`);
    }
    // Fecha de negocio = ayer; sin --reset no se rebobina.
    assert.match(seed, /update: reset \? \{ currentDate: dateOnly\(yesterday\), closedAt: null, closedBy: null \} : \{\}/);
    // Aprobaciones y revisión IA.
    assert.match(seed, /export const APPROVAL_REASON_CODE = "seed-ux2"/);
    assert.match(seed, /export const APPROVAL_TTL_DAYS = 7/);
    assert.match(seed, /id: "apr_uxdb_refund", kind: "refund", entityType: "payment", entityId: "pay_uxdb_s01", amount: 60/);
    assert.match(seed, /id: "apr_uxdb_folio_adjust", kind: "folio_adjust", entityType: "folio", entityId: "folio_uxdb_h01", amount: 25/);
    assert.match(seed, /id: "apr_uxdb_purchase_order", kind: "purchase_order", entityType: "purchase_order", entityId: "po_uxdb_lenceria", amount: 900/);
    assert.match(seed, /requestedByUserId: RECEPCION_USER_ID,\n\s+status: "pending",\n\s+expiresAt/);
    assert.match(seed, /reviewType: "guest_message_reply"/);
    assert.match(seed, /reviewType: "rate_change"/);
    assert.match(seed, /reviewType: "review_response"/, "tercer ítem IA (diseño §4 D1: 3 AiHumanReviewItem)");
    assert.equal((seed.match(/^    id: "ahr_uxdb_/gm) ?? []).length, 3, "3 ítems IA con id fijo");
    assert.match(seed, /relatedEntityId: item\.relatedEntityId,\n\s+payloadJson: item\.payload,\n\s+status: "pending"/);
  });

  it("snapshots diarios del hotel B: SNAPSHOT_DAYS días con id fijo, las dos últimas noches desde el plan, BAR de 89 € (UX2-REV-04)", () => {
    assert.match(seed, /export const SNAPSHOT_DAYS = 20;/);
    assert.match(seed, /export function buildSnapshotPlan\(today: string, plan: DayReservation\[\]\): DaySnapshot\[\]/);
    assert.match(seed, /for \(let offset = -SNAPSHOT_DAYS; offset <= -1; offset \+= 1\)/, "solo noches cerradas (ayer y anteriores)");
    assert.match(seed, /const sleeping = plan\.filter\(\(r\) => r\.arrivalOffset <= offset && offset < r\.departureOffset\);/);
    assert.match(seed, /const fromPlan = offset >= -2;/);
    assert.match(seed, /const id = `rds_uxdb_\$\{day\.date\}`;/);
    assert.match(seed, /prisma\.revenueDailySnapshot\.create\(\{\s*data: \{\s*id,\s*propertyId: PROPERTY_ID,/);
    const snapshotsFn = seed.slice(seed.indexOf("async function seedSnapshots"), seed.indexOf("async function seedPending"));
    assert.doesNotMatch(snapshotsFn, /roomTypeId|ratePlanId|channelId|segment:|market:/, "nivel superior: sin dimensiones (las pantallas solo leen las filas sin dimensiones)");
    assert.match(snapshotsFn, /dataSource: "seed-ux-direccion"/);
    assert.match(seed, /adr: day\.rooms > 0 \? money\(ROOM_TYPE\.price\) : null,/);
    assert.match(seed, /occupancyPercent: money\(\(day\.rooms \/ roomsTotal\) \* 100\),/);
    assert.match(seed, /deleteScoped\("revenueDailySnapshot"\)/, "--reset borra los snapshots del hotel B");
    assert.match(seed, /const snapshots = await seedSnapshots\(today, plan\);/);
  });

  it("nunca imprime la contraseña: la salida solo dice de dónde sale (UX2-REV-07)", () => {
    assert.match(seed, /export const DEMO_PASSWORD_LABEL = process\.env\.SEED_UXDAY_PASSWORD\?\.trim\(\) \? "la de SEED_UXDAY_PASSWORD" : "la de demo por defecto";/);
    assert.match(seed, /\(contraseña: \$\{DEMO_PASSWORD_LABEL\}\)/);
    assert.doesNotMatch(seed, /\$\{DEMO_PASSWORD\}/, "el valor de la contraseña no va a la salida estándar");
    const uxDay = read("../packages/database/prisma/seed-ux-day.ts");
    assert.match(uxDay, /\(contraseña: \$\{DEMO_PASSWORD_LABEL\}\)/);
    assert.doesNotMatch(uxDay, /\$\{DEMO_PASSWORD\}/, "seed-ux-day tampoco imprime el valor");
  });

  it("el único deleteMany es deleteScoped (propertyId: prop_uxday_b) y --reset nunca toca prop_uxday", () => {
    const calls = [...seed.matchAll(/deleteMany\(/g)];
    assert.equal(calls.length, 1, "solo deleteScoped");
    assert.match(seed, /const where = \{ \.\.\.extraWhere, propertyId: PROPERTY_ID \};/);
    assert.match(seed, /args\.includes\("--reset"\)/);
    assert.match(seed, /args\.includes\("--dry-run"\)/);
    assert.match(seed, /verifactuHash: \{ not: null \}/, "las reservas con factura VeriFactu se conservan");
    assert.match(seed, /deleteScoped\("reservation", \{ id: \{ notIn: \[\.\.\.protectedReservationIds\] \} \}\)/);
    assert.match(seed, /deleteScoped\("nightAuditRun"\)/);
    assert.match(seed, /deleteScoped\("approvalRequest", \{ reasonCode: APPROVAL_REASON_CODE \}\)/);
    assert.match(seed, /deleteScoped\("aiHumanReviewItem", \{ id: \{ in: \[\.\.\.REVIEW_ITEM_IDS\] \} \}\)/);
    assert.match(seed, /prisma\.room\.updateMany\(\{ where: \{ propertyId: PROPERTY_ID \}/);
    // prop_uxday: solo lectura (precondición) y asignación del director; jamás en un borrado o update.
    const baseLines = seed.split("\n").filter((line) => line.includes("BASE_PROPERTY_ID"));
    assert.ok(baseLines.length >= 3, "BASE_PROPERTY_ID se usa (constante, precondición, asignación)");
    for (const line of baseLines) assert.doesNotMatch(line, /delete|updateMany|update\(|create\(\{ data: \{ [^}]*propertyId: BASE_PROPERTY_ID/, `escritura sobre prop_uxday: ${line.trim()}`);
    assert.doesNotMatch(seed, /propertyId: "prop_uxday"/, "prop_uxday solo a través de BASE_PROPERTY_ID");
    assert.doesNotMatch(seed, /cmrhw9jy30002fyvb6tsdiugt|org_123|prop_123|prop_canary|prop_chk/, "nunca toca Faranda, el demo base ni CHK");
  });

  it("no contiene ningún apellido real (personas ficticias con apellidos griegos)", () => {
    const names = [...seed.matchAll(/"([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)"/g)].map((m) => m[1]);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    for (const surname of SURNAME_BLACKLIST) assert.ok(!lower.has(surname.toLowerCase()), `apellido real en el seed: ${surname}`);
    assert.match(seed, /GREEK_SURNAMES = \["Alfa", "Beta", "Gamma"/);
  });

  it("prop_uxday_b está en la allowlist demo y existe el script db:seed:ux-direccion", () => {
    assert.match(guard, /export const UX2_DEMO_PROPERTY_IDS: readonly string\[\] = \["prop_uxday_b"\]/);
    assert.match(guard, /DEMO_PROPERTY_IDS: readonly string\[\] = \["prop_123", "prop_canary", "prop_uxday", "prop_chk"\]\.concat\(UX2_DEMO_PROPERTY_IDS\)/);
    assert.match(guard, /DEMO_ORG_IDS: readonly string\[\] = \["org_123", "org_uxday", "org_chk"\]/);
    assert.equal(databasePackage.scripts["db:seed:ux-direccion"], "node --env-file=../../.env --import tsx prisma/seed-ux-direccion.ts");
    assert.equal(databasePackage.scripts["db:seed:ux-day"], "node --env-file=../../.env --import tsx prisma/seed-ux-day.ts", "el script de UX-1 sigue intacto");
  });
});
