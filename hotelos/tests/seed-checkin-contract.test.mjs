// Tanda CHK · lotes W1-D + W5-B · contrato del tenant de prueba del check-in
// automatizado (docs/design/CHECKIN-AUTOMATIZADO-IA.md §10.1; reglas: tenants
// aislados por producto, nunca Faranda).
//
//   · packages/database/prisma/seed-checkin.ts existe, pasa por assertDemoTarget,
//     es autónomo (no importa seed.ts, seed-operations.ts ni seed-ux-day.ts), usa
//     los prefijos del tenant aislado (CHK-, @chk.test, chk_*) y no contiene
//     ningún apellido real (lista negra de apellidos frecuentes y de los
//     huéspedes ficticios de otros seeds);
//   · los deleteMany van acotados a prop_chk (deleteScoped) o, el de huéspedes
//     huérfanos, a org_chk; nunca toca Faranda ni org_123 ni org_uxday;
//   · las reservas son relativas a hoy (todayIn("Europe/Madrid")): la única
//     fecha literal del fichero es GO_LIVE_AT;
//   · el plan cubre los diez escenarios de §10.1 (acompañante, menor con
//     parentesco, grupo, VIP, recurrente con estancia previa en la 204,
//     accesibilidad, invitación sin documento ni teléfono, alojado en la 305),
//     36 habitaciones en 4 plantas con rasgos variados y una fuera de servicio,
//     SES sandbox e IA activada, módulos del producto activados;
//   · org_chk / prop_chk están en la allowlist demo (lib/demo-guard.ts) y el
//     script `db:seed:checkin` existe.
//
// Lote W5-B (estados de §10.1 sobre las 9 tablas de W1-A):
//   · las MRZ sintéticas salen de buildMrz (W1-B) a partir del perfil y solo
//     viajan a captureDocument como `hints.mrzLines`: en la BD quedan el número y
//     el soporte del documento (syntheticDocumentFor), nunca las líneas;
//   · ninguna sesión nace sin CheckInGuest: no hay prisma.checkInSession.create,
//     todas las sesiones pasan por inviteReservation / ensureSession (que crean
//     un viajero por hueco) y el mapa CHECKIN_SCENARIOS cubre 2 invited · 2
//     in_progress · 3 ready_for_arrival · 1 checked_in · 1 handed_off;
//   · la política lleva selfCheckInEnabled, depositPolicy balance, los tres
//     métodos de verificación y textos de consentimiento / aviso de IA marcados
//     «(texto provisional)»; el kiosco chk_kiosk_01 se empareja con los
//     servicios reales (startPairing + claimPairing) con mrzReader/cardEncoder
//     false; bloqueo deep_clean de la 401 mañana y comunicadas 201-202;
//   · --reset borra también la capa del check-in (sesiones, capturas, firmas,
//     sugerencias, bloqueos, entregas, lotes del job) siempre acotada a prop_chk.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const seed = read("../packages/database/prisma/seed-checkin.ts");
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
  "Velasco", "Parra", "Sáez", "Moya", "Bravo", "Rivera", "Gallego", "Rey", "Silva", "Calvo", "Otero", "Costa", "Pereira"
];

function importSpecifiers(source) {
  return [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
}

describe("Seed «tenant de prueba CHK» (W1-D)", () => {
  it("existe, pasa por assertDemoTarget y solo escribe en el tenant aislado", () => {
    assert.match(seed, /assertDemoTarget\(\{/);
    assert.match(seed, /export const ORG_ID = "org_chk"/);
    assert.match(seed, /export const PROPERTY_ID = "prop_chk"/);
    assert.match(seed, /export const LEGAL_ENTITY_ID = "le_chk"/);
    assert.match(seed, /export const PROPERTY_CODE = "CHK"/);
    assert.match(seed, /export const PROPERTY_NAME = "Hotel CHK \(prueba\)"/);
    assert.match(seed, /export const RESERVATION_PREFIX = "CHK-"/);
    assert.match(seed, /export const EMAIL_DOMAIN = "chk\.test"/);
    assert.match(seed, /process\.env\.SEED_CHK_PASSWORD\?\.trim\(\) \|\| "chk-demo"/, "contraseña sustituible");
    for (const [local, templateKey] of [["recepcion", "receptionist"], ["jefe.recepcion", "front_office_manager"], ["direccion", "manager"]]) {
      assert.match(seed, new RegExp(`local: "${local.replace(".", "\\.")}",[^\\n]*templateKey: "${templateKey}"`), `${local} → ${templateKey}`);
    }
    assert.match(seed, /hashPassword\(DEMO_PASSWORD\)/);
    assert.match(seed, /syncPermissionCatalog\(\)/);
    assert.match(seed, /provisionDefaultTemplateRoles\(ORG_ID\)/);
    assert.match(seed, /provisionOrganizationChart\(ORG_ID\)/);
    assert.match(seed, /ensurePropertySettings\(PROPERTY_ID\)/);
    assert.match(seed, /timezone: "Europe\/Madrid"/);
    assert.match(seed, /taxRegion: "ES_PENINSULA_BALEARES"/);
    assert.match(seed, /goLiveAt: GO_LIVE_AT/);
    assert.match(seed, /GO_LIVE_AT = new Date\("2026-09-01T00:00:00\.000Z"\)/);
    assert.match(seed, /NODE_ENV === "production" && process\.env\.SEED_CHK_ALLOW_PRODUCTION !== "1"/, "guarda de producción");
    assert.match(seed, /args\.includes\("--reset"\)/);
    assert.match(seed, /args\.includes\("--dry-run"\)/);
  });

  it("es autónomo: no importa seed.ts, seed-operations.ts ni seed-ux-day.ts", () => {
    const specifiers = importSpecifiers(seed);
    assert.ok(specifiers.length >= 5, `imports parsed: ${specifiers.length}`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /seed\.js$|seed\.ts$|seed-operations|seed-commercial|seed-rbac|seed-ux-day/, `import prohibido: ${specifier}`);
    }
  });

  it("activa SES en sandbox, la IA y los módulos del producto en prop_chk", () => {
    assert.match(seed, /SES_REGISTRY_NUMBER = "CHK0000001"/);
    assert.match(seed, /sesRegistryNumber: SES_REGISTRY_NUMBER/);
    assert.match(seed, /sesHospedajesEnabled: true/);
    assert.match(seed, /verifactuEnabled: false/);
    assert.match(seed, /ineMunicipalityCode: "15030"/, "establecimiento SES completo");
    assert.match(seed, /propertyAiSetting\.upsert\(\{[\s\S]*?update: \{ aiEnabled: true \}/);
    for (const code of ["pms_core", "spain_guest_register_compliance", "guest_self_service", "checkin_online", "ai_concierge", "payment_vault"]) {
      assert.ok(seed.includes(`"${code}"`), `módulo ${code} activado`);
    }
    assert.match(seed, /prisma\.propertyModule\.upsert\(\{\s*where: \{ propertyId_moduleId: \{ propertyId: PROPERTY_ID, moduleId: module\.id \} \}/);
  });

  it("inventario: DBL/SUP/STE con displayOrder 1/2/3 y maxOccupancy 2/3/4, 36 habitaciones en 4 plantas, rasgos variados y la 109 fuera de servicio", () => {
    assert.match(seed, /code: "DBL", name: "Doble", price: \d+, maxOccupancy: 2, displayOrder: 1, numbers: \[\.\.\.range\(101, 109\), \.\.\.range\(201, 209\)\]/);
    assert.match(seed, /code: "SUP", name: "Superior", price: \d+, maxOccupancy: 3, displayOrder: 2, numbers: range\(301, 309\)/);
    assert.match(seed, /code: "STE", name: "Suite", price: \d+, maxOccupancy: 4, displayOrder: 3, numbers: range\(401, 409\)/);
    assert.match(seed, /ACCESSIBLE_ROOMS: readonly number\[\] = \[101, 102\]/);
    assert.match(seed, /OUT_OF_ORDER_ROOM = 109/);
    assert.match(seed, /viewType: number % 2 === 1 \? "sea" : "city"/);
    assert.match(seed, /featuresJson: \{ quiet: [^}]+near_elevator: [^}]+far_elevator: [^}]+crib: [^}]+\}/);
    assert.match(seed, /bedConfigurationJson: \{ type: number % 2 === 0 \? "twin" : "king" \}/);
    assert.match(seed, /accessibilityJson: ACCESSIBLE_ROOMS\.includes\(number\) \? \{ accessible: true \} : \{\}/);
    assert.match(seed, /"dirty" : [^\n]*"inspected" : "clean"/, "limpieza mixta clean/inspected/dirty");
    assert.match(seed, /maintenanceStatus: outOfOrder \? "blocked" : "ok"/);
    assert.match(seed, /status: outOfOrder \? "out_of_order" : housekeepingStatus/);
    assert.match(seed, /sellable: !outOfOrder/);
    assert.match(seed, /RATE_DAYS_AFTER = 60/, "plan BAR de 60 días");
    assert.match(seed, /code: "BAR"/);
  });

  it("siembra los diez escenarios CHK-* de §10.1 con fechas relativas a hoy (la única fecha literal es GO_LIVE_AT)", () => {
    for (let n = 1; n <= 10; n += 1) assert.match(seed, new RegExp(`code: "CHK-${String(n).padStart(2, "0")}"`), `CHK-${String(n).padStart(2, "0")}`);
    assert.match(seed, /todayIn\("Europe\/Madrid"\)/);
    assert.match(seed, /code: "CHK-01"[^\n]*arrivalOffset: 0,/, "CHK-01 llega hoy");
    assert.match(seed, /code: "CHK-01"[^\n]*guests: \[adult\("01", \d+\), adult\("01b", \d+, \{ isPrimary: false \}\)\]/, "CHK-01 titular + acompañante sin parentesco");
    assert.match(seed, /code: "CHK-02"[^\n]*arrivalOffset: 1,[^\n]*relationshipType: "hijo", age: 9/, "CHK-02 menor de 9 años con parentesco");
    // W5-B: el grupo, el VIP y la reserva accesible llegan HOY para que sus sesiones asomen en la cola de Mi día (W3-D solo mira las llegadas del día).
    for (const code of ["CHK-03", "CHK-04", "CHK-05"]) assert.match(seed, new RegExp(`code: "${code}"[^\\n]*arrivalOffset: 0,[^\\n]*groupCode: GROUP_CODE`), `${code} en el grupo, llega hoy`);
    assert.match(seed, /code: "CHK-03"[^\n]*guests: \[adult\("03", \d+, \{ noDocument: true \}\)\]/, "CHK-03 (walkthrough): titular sin documento en el perfil, lo lee en el asistente");
    assert.match(seed, /const withDocument = !minor && !guest\.incomplete && !guest\.noDocument;/);
    assert.match(seed, /GROUP_CODE = "CHK-G1"/);
    assert.match(seed, /code: "CHK-06"[^\n]*arrivalOffset: 0,[^\n]*vip: true[^\n]*adult\("06b", \d+, \{ isPrimary: false \}\)/, "CHK-06 VIP con acompañante, llega hoy");
    assert.match(seed, /code: "CHK-08"[^\n]*arrivalOffset: 0,/, "CHK-08 llega hoy");
    assert.match(seed, /code: "CHK-02"[^\n]*arrivalOffset: 1,/, "CHK-02 llega mañana");
    assert.match(seed, /code: "CHK-07"[^\n]*arrivalOffset: 1,/, "CHK-07 llega mañana");
    assert.match(seed, /vipCode: guest\.vip \? "VIP" : null/);
    assert.match(seed, /code: "CHK-07P", status: "checked_out", roomType: "DBL", room: 204,[^\n]*stay: "checked_out"/, "CHK-07 estancia previa en la 204");
    assert.match(seed, /code: "CHK-07"[^\n]*arrivalOffset: 1,/);
    assert.match(seed, /code: "CHK-08"[^\n]*accessibilityNeeds: "silla de ruedas"/);
    assert.match(seed, /code: "CHK-09"[^\n]*arrivalOffset: 2,[^\n]*incomplete: true/, "CHK-09 sin documento ni teléfono");
    assert.match(seed, /code: "CHK-10", status: "checked_in", roomType: "SUP", room: 305,[^\n]*stay: "in_house"/, "CHK-10 alojado en la 305");
    assert.match(seed, /data: \{ status: "occupied", housekeepingStatus: "clean" \}/);
    assert.match(seed, /paid: 0,/, "CHK-01 con saldo");
    assert.match(seed, /code: "CHK-06"[^\n]*paid: 100,/, "CHK-06 con saldo");
    assert.match(seed, /status: "captured"/, "solo los pagos captured dejan saldo");
    assert.match(seed, /eta: "16:30"/);
    assert.match(seed, /\+34600000/, "móviles E.164 sintéticos");
    assert.match(seed, /dateOfBirth: bornYearsAgo\(guest\.age\)/, "fechas de nacimiento relativas");
    const literalDates = [...seed.matchAll(/"20\d{2}-\d{2}-\d{2}/g)];
    assert.equal(literalDates.length, 1, `la única fecha literal es GO_LIVE_AT: ${literalDates.map((m) => m[0]).join(", ")}`);
  });

  it("no contiene ningún apellido real ni nombres de personas reales (ficticios con apellidos griegos)", () => {
    const names = [...seed.matchAll(/"([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)"/g)].map((m) => m[1]);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    for (const surname of SURNAME_BLACKLIST) assert.ok(!lower.has(surname.toLowerCase()), `apellido real en el seed: ${surname}`);
    assert.match(seed, /GREEK_SURNAMES = \["Alfa", "Beta", "Gamma"/);
    assert.match(seed, /const digits = String\(sequence\)\.padStart\(6, "0"\);\s*return \{ documentNumber: `CHK\$\{digits\}`, documentSupportNumber: `SOP\$\{digits\}` \};/, "documentos sintéticos (número + soporte)");
    assert.match(seed, /MISMATCH_IDENTITY = \{ firstName: "Persona", surname1: "Prueba"/, "la identidad discrepante también es ficticia");
  });

  it("los deleteMany van acotados a prop_chk (deleteScoped), a org_chk (huéspedes huérfanos) o a las encuestas de prop_chk (respuestas, L7-04); nunca toca Faranda ni otros tenants", () => {
    const calls = [...seed.matchAll(/deleteMany\(/g)];
    assert.equal(calls.length, 3, "deleteScoped + huéspedes huérfanos de org_chk + respuestas de las encuestas de prop_chk");
    assert.match(seed, /const where = \{ \.\.\.extraWhere, propertyId: PROPERTY_ID \};/);
    assert.match(seed, /prisma\.guest\.deleteMany\(\{ where: \{ organizationId: ORG_ID, reservationGuests: \{ none: \{\} \} \} \}\)/);
    assert.match(seed, /const chkSurveys = await prisma\.survey\.findMany\(\{ where: \{ propertyId: PROPERTY_ID \}, select: \{ id: true \} \}\);\s*counts\.surveyResponse = \(await prisma\.surveyResponse\.deleteMany\(\{ where: \{ surveyId: \{ in: chkSurveys\.map\(\(s\) => s\.id\) \} \} \}\)\)\.count;/, "respuestas acotadas a las encuestas de prop_chk");
    assert.match(seed, /deleteScoped\("reservation", \{ code: \{ startsWith: RESERVATION_PREFIX \}, id: \{ notIn: protectedIds \} \}\)/, "--reset borra las reservas CHK-*");
    // Corrector L7-REV-10: y las RES-* de las corridas e2e (titular prueba.portal.*), solo de prop_chk y solo sin factura.
    assert.match(seed, /export const E2E_BOOKER_EMAIL_PREFIX = "prueba\.portal\."/);
    assert.match(seed, /prisma\.reservation\.findMany\(\{ where: \{ propertyId: PROPERTY_ID, bookerEmail: \{ startsWith: E2E_BOOKER_EMAIL_PREFIX \} \}, select: \{ id: true \} \}\)/);
    assert.match(seed, /const purgeIds = e2eIds\.filter\(\(id\) => !invoicedIds\.has\(id\) && !protectedReservationIds\.has\(id\)\);/, "las facturadas y las protegidas se conservan");
    assert.match(seed, /deleteScoped\("reservation", \{ id: \{ in: purgeIds \}, bookerEmail: \{ startsWith: E2E_BOOKER_EMAIL_PREFIX \} \}\)/, "purga acotada a prop_chk (deleteScoped) y al titular e2e");
    assert.doesNotMatch(seed, /deleteScoped\("reservation", \{ \}\)|deleteScoped\("reservation"\)/, "nunca todas las reservas de prop_chk");
    assert.match(seed, /verifactuHash: \{ not: null \}/, "las reservas con factura VeriFactu se conservan");
    for (const model of ["guestRegisterRecord", "sesHospedajesSubmission", "guestPortalSession", "guestPortalAction", "housekeepingTask", "workOrder", "paymentIntent"]) {
      assert.match(seed, new RegExp(`deleteScoped\\("${model}"`), `satélite ${model} acotado a prop_chk`);
    }
    assert.match(seed, /where: \{ id: `chk_room_\$\{number\}`, propertyId: PROPERTY_ID \}/, "la reposición de habitaciones va acotada");
    assert.doesNotMatch(seed, /cmrhw9jy30002fyvb6tsdiugt|cmrhw9jy4|cmu4805|cmu1mifcp|org_123|prop_123|prop_canary|org_uxday|prop_uxday/, "nunca toca Faranda (ids de organización/propiedades), el demo base ni UXDAY");
  });

  it("está en la allowlist demo y tiene script pnpm", () => {
    // Tanda ACT (L7): la allowlist incorpora también el tenant aislado org_act (seed-real-estate.ts).
    assert.match(guard, /DEMO_ORG_IDS: readonly string\[\] = \["org_123", "org_uxday", "org_chk", "org_act"\]/);
    assert.match(guard, /DEMO_PROPERTY_IDS: readonly string\[\] = \["prop_123", "prop_canary", "prop_uxday", "prop_chk"\]/);
    assert.equal(databasePackage.scripts["db:seed:checkin"], "node --env-file=../../.env --import tsx prisma/seed-checkin.ts");
  });
});

describe("Seed CHK · escenarios de sesión, MRZ sintéticas, política y kiosco (W5-B)", () => {
  it("usa buildMrz y no guarda mrzLines en BD: las líneas solo viajan a captureDocument como hints", () => {
    assert.match(seed, /import \{ buildMrz, type MrzSex \} from "\.\.\/\.\.\/compliance\/src\/spain\/mrz\.js"/, "buildMrz de W1-B (packages/compliance)");
    assert.match(seed, /export function mrzFixtureFor\(profile: MrzProfile/, "fixture derivada del perfil");
    assert.match(seed, /return buildMrz\(\{\s*format: "TD1",\s*documentType: "DNI",\s*issuingCountry: "ESP",/, "DNI español TD1 (soporte en 6-14, número en el opcional)");
    // Único punto en el que existen las líneas: la entrada del servicio de captura.
    const mrzLinesUses = [...seed.matchAll(/mrzLines/g)];
    assert.equal(mrzLinesUses.length, 1, `mrzLines aparece solo en hints de captureDocument: ${mrzLinesUses.length}`);
    assert.match(seed, /captureDocument\(\{ context: contexts\.checkin, propertyId: PROPERTY_ID, checkInGuestId: guest\.id, hints: \{ mrzLines: lines \}/);
    assert.doesNotMatch(seed, /mrzLinesJson|mrz_lines|mrzText|mrzRaw/, "ninguna columna de MRZ");
    // En la BD solo el número y el soporte del documento (perfil Guest); la captura persiste fieldsJson sin PII (W2-B).
    assert.match(seed, /export function syntheticDocumentFor\(sequence: number\)/);
    assert.match(seed, /documentNumber: withDocument \? document\.documentNumber : null,\s*documentSupportNumber: withDocument \? document\.documentSupportNumber : null,/);
    assert.match(seed, /update: documentFields,/, "una fila anterior a W5-B también recibe el soporte");
    // Checksums exigidos: una MRZ sintética inválida aborta el seed (el parser es el oráculo, diseño §10.1).
    assert.match(seed, /if \(!checksOk\) throw new Error\(`\[seed-checkin\] MRZ sintética inválida/);
    // La fixture se imprime para el walkthrough (runbook), nunca se persiste.
    assert.match(seed, /MRZ sintéticas \(fixture del walkthrough; en la BD solo el número y el soporte\)/);
  });

  it("ninguna sesión sin CheckInGuest: todas nacen por inviteReservation / ensureSession y el mapa cubre los estados de §10.1", () => {
    assert.doesNotMatch(seed, /prisma\.checkInSession\.create\(/, "sin filas de sesión a mano");
    assert.doesNotMatch(seed, /prisma\.checkInGuest\.create\(/, "los viajeros los crea ensureSession");
    assert.match(seed, /inviteReservation\(\{ reservationId, channel: "email", context: contexts\.checkin/, "invitación real (entrega simulada sin proveedor)");
    assert.match(seed, /ensureSession\(\{ reservationId, channel: "reception", actor: SEED_ACTOR/, "la alojada CHK-10 nace por ensureSession");
    assert.match(seed, /completePreArrival\(\{ token/, "ready_for_arrival por el cierre real del pre-check-in");
    assert.match(seed, /signGuest\(\{\s*context: contexts\.checkin,\s*checkInGuestId: guest\.id,\s*pngBase64: SIGNATURE_PNG\.toString\("base64"\)/, "firma con el PNG mínimo");
    assert.match(seed, /method: "touch_portal"/);
    assert.match(seed, /suggestForReservation\(\{ context: contexts\.checkin, reservationId, sessionId, persist: true \}\)/);
    assert.match(seed, /issueWalletPass\(\{ context: contexts\.checkin, reservationId \}\)/, "llave QR de CHK-10 en guest_portal_actions");
    // Reparto de estados (2 · 2 · 3 · 1 · 1) y las reservas que los llevan.
    const scenarios = /export const CHECKIN_SCENARIOS[^\n]*\n([\s\S]*?)\n\}\);/.exec(seed);
    assert.ok(scenarios, "mapa CHECKIN_SCENARIOS");
    const entries = [...scenarios[1].matchAll(/"(\d{2})": \{ scenario: "([a-z_]+)"/g)].map((m) => [m[1], m[2]]);
    const byScenario = {};
    for (const [key, scenario] of entries) (byScenario[scenario] ??= []).push(key);
    assert.deepEqual(byScenario.invited.sort(), ["03", "09"]);
    assert.deepEqual(byScenario.in_progress.sort(), ["01", "02"]);
    assert.deepEqual(byScenario.ready_for_arrival.sort(), ["04", "05", "06"]);
    assert.deepEqual(byScenario.checked_in, ["10"]);
    assert.deepEqual(byScenario.handed_off, ["08"]);
    assert.equal(entries.length, 9);
    // Contexto de servicio (R17): las escrituras de dominio van con checkInServiceContext, nunca demoStore.
    assert.match(seed, /checkInServiceContext\(PROPERTY_ID, SEED_ACTOR\)/);
    assert.match(seed, /SEED_ACTOR = \{ kind: "system", job: "seed" \} as const/);
    assert.doesNotMatch(seed, /demoStore/);
    // handed_off identity_review: captura con discrepancia esperada + auditoría CheckInHandedOff.
    assert.match(seed, /captureByMrz\(contexts, primary, lines, `\$\{item\.key\}_mismatch`, true\)/);
    assert.match(seed, /handoffKind: "identity_review"/);
    assert.match(seed, /action: "CheckInHandedOff"/);
    // Cadena de auditoría: hidratada antes y vaciada al terminar.
    assert.match(seed, /await hydrateAuditChainFromPostgres\(\);/);
    assert.match(seed, /await flushAuditQueues\(\);/);
  });

  it("policy con textos provisionales marcados, kiosco emparejado por los servicios, bloqueo y comunicadas", () => {
    assert.match(seed, /export const PROVISIONAL_TEXT_MARK = "\(texto provisional\)"/);
    assert.match(seed, /export const GUEST_CONSENT_TEXT = `[^`]*\$\{PROVISIONAL_TEXT_MARK\}`/);
    assert.match(seed, /export const AI_DISCLOSURE_TEXT = `[^`]*\$\{PROVISIONAL_TEXT_MARK\}`/);
    assert.match(seed, /POLICY_VERIFICATION_METHODS = \["visual_reception", "mrz_checksum", "otp_email"\] as const/);
    assert.match(seed, /upsertPolicy\(\{\s*context: contexts\.admin,\s*propertyId: PROPERTY_ID,\s*patch: \{\s*selfCheckInEnabled: true,\s*depositPolicy: "balance",\s*allowedVerificationMethods: \[\.\.\.POLICY_VERIFICATION_METHODS\],[\s\S]{0,600}?requireVisualCheckAtKiosk: false,\s*guestConsentText: GUEST_CONSENT_TEXT,\s*aiDisclosureText: AI_DISCLOSURE_TEXT/);
    assert.match(seed, /decisión de demo, no del diseño/, "el cotejo visual en el kiosco desactivado queda declarado como decisión de demo");
    // Lote L7-04: encuesta post-estancia activa (24 h) en la misma política.
    assert.match(seed, /aiDisclosureText: AI_DISCLOSURE_TEXT,\s*postStaySurveyEnabled: true,\s*postStaySurveyDelayHours: POST_STAY_SURVEY_DELAY_HOURS/);
    assert.match(seed, /export const POST_STAY_SURVEY_DELAY_HOURS = 24/);
    assert.match(seed, /current\.postStaySurveyEnabled === true &&\s*current\.postStaySurveyDelayHours === POST_STAY_SURVEY_DELAY_HOURS/, "el «unchanged» también mira la encuesta");
    // Kiosco: fila por id fijo y emparejamiento real (solo hashes en la fila).
    assert.match(seed, /export const KIOSK_ID = "chk_kiosk_01"/);
    assert.match(seed, /capabilitiesJson = \{ mrzReader: false, cardEncoder: false, paymentTerminal: false, printer: false \}/);
    assert.match(seed, /startPairing\(\{ context: contexts\.admin, propertyId: PROPERTY_ID, deviceId: KIOSK_ID/);
    assert.match(seed, /claimPairing\(pairing\.code\)/);
    assert.doesNotMatch(seed, /deviceTokenHash: |pairingCodeHash: /, "el seed nunca escribe hashes a mano");
    // Bloqueo de la 401 mañana y comunicadas 201-202, por los servicios de W2-C.
    assert.match(seed, /export const BLOCKED_ROOM = 401/);
    assert.match(seed, /export const CONNECTED_ROOMS: readonly \[number, number\] = \[201, 202\]/);
    assert.match(seed, /createRoomBlock\(\{[\s\S]*?reason: "deep_clean"/);
    assert.match(seed, /createRoomConnection\(\{[\s\S]*?kind: "connecting"/);
    // Las dos claves de configuración solo viven en el contexto admin del seed (buildServiceContext rechaza las prohibidas).
    assert.match(seed, /permissions: \[\.\.\.CHECKIN_SERVICE_PERMISSIONS, "guest_self_service\.manage", "kiosk\.configure"\] as PermissionKey\[\]/);
  });

  it("L7-04: Survey post_stay fija de prop_chk (cuestionario por defecto del portal) y --reset borra solo sus respuestas", () => {
    assert.match(seed, /export const SURVEY_ID = "chk_survey_post_stay"/);
    assert.match(seed, /export const SURVEY_NAME = "Encuesta post-estancia CHK \(prueba\)"/);
    assert.match(seed, /import \{ DEFAULT_GUEST_SURVEY_QUESTIONS, type PermissionKey \} from "\.\.\/\.\.\/shared\/src\/index\.js"/, "las preguntas son las del portal (una sola fuente)");
    assert.match(seed, /prisma\.survey\.upsert\(\{\s*where: \{ id: SURVEY_ID \},\s*create: \{ id: SURVEY_ID, propertyId: PROPERTY_ID, name: SURVEY_NAME, surveyType: "post_stay", questionsJson: DEFAULT_GUEST_SURVEY_QUESTIONS\.map\(\(question\) => \(\{ \.\.\.question \}\)\), active: true \},\s*update: \{ propertyId: PROPERTY_ID, name: SURVEY_NAME, surveyType: "post_stay", active: true \}/);
    assert.doesNotMatch(seed, /deleteScoped\("survey"|prisma\.survey\.deleteMany/, "la encuesta es fija: nunca se borra");
    assert.match(seed, /const survey = await ensureSurvey\(\);/);
  });

  it("--reset rearma también la capa del check-in, siempre acotada a prop_chk (contrato de W1-D intacto)", () => {
    for (const model of ["checkInSession", "documentCapture", "signature", "assignmentSuggestion", "roomBlock", "notificationDelivery"]) {
      assert.match(seed, new RegExp(`deleteScoped\\("${model}"\\)`), `satélite ${model} acotado a prop_chk`);
    }
    assert.match(seed, /deleteScoped\("workerJobRun", \{ jobName: "checkin\.assignment" \}\)/);
    assert.match(seed, /deleteScoped\("kioskDevice", \{ id: \{ not: KIOSK_ID \} \}\)/, "solo sobreviven el kiosco del seed y su emparejamiento");
    assert.doesNotMatch(seed, /deleteScoped\("propertyCheckInPolicy"|deleteScoped\("roomConnection"/, "política y comunicadas son fijas");
  });

  it("corrector REV3-03: el walkthrough de integración (que ejecuta el seed) solo corre contra una BD *_chk o con CHK_WALKTHROUGH=1 y lo dice", () => {
    const walkthrough = read("./integration/checkin-seed-walkthrough.test.mts");
    assert.match(walkthrough, /export function walkthroughSkipReason\(env/);
    assert.match(walkthrough, /if \(env\.CHK_WALKTHROUGH === "1"\) return false;/);
    assert.match(walkthrough, /if \(\/_chk\$\/\.test\(database\)\) return false;/);
    assert.match(walkthrough, /const WALKTHROUGH_SKIP = walkthroughSkipReason\(process\.env\);/);
    assert.equal((walkthrough.match(/\{ skip: WALKTHROUGH_SKIP \}/g) ?? []).length, 2, "las dos suites llevan el skip con motivo");
    assert.match(walkthrough, /before\(async \(\) => \{\s*if \(WALKTHROUGH_SKIP\) return;/, "el before no siembra cuando se salta");
    // package.json#test:integration carga el .env del árbol como gates.sh (la BD del carril, nunca la de :3000 por defecto).
    const pkg = read("../package.json");
    assert.match(pkg, /"test:integration": "cd apps\/api && node --env-file-if-exists=\.\.\/\.\.\/\.env --import tsx --test/);
  });
});
