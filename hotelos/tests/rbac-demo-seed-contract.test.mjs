// Contrato · datos de demo por rol y smoke por plantilla (Tanda 8a · RBAC · L5).
//
// Lectura de fuentes, sin TypeScript ni base de datos (mismo estilo que
// tests/demo-seed-contract.test.mjs y tests/rbac-sod-contract.test.mjs): fija
// lo que docs/design/RBAC-DEPARTAMENTOS.md §8.1 y el lote L5 exigen de
// packages/database/prisma/seed-rbac-demo.ts, scripts/check-role-smoke.mjs y
// los dos package.json:
//   - el seed solo conoce correos @faranda.test / @example.com (nunca reales),
//     pasa por assertDemoTarget con la organización de Faranda como objetivo,
//     no importa nada de apps/api y respeta a los usuarios que ya existen;
//   - 30 usuarios = 28 personas + 2 cuentas de emergencia, con la plantilla y
//     el ámbito de la tabla del diseño; los 4 scopeType se escriben en
//     user_role_assignments y solo el ámbito property se espeja en
//     user_property_roles; ROLE_ASSIGNED con actorType system;
//   - dos grupos de propiedades (galicia, asturias-cantabria) con sus centros;
//     22 plantillas + admin + Emergencia; umbrales por defecto; contraseña
//     única que cumple la política y se puede sobreescribir con
//     RBAC_DEMO_PASSWORD; --dry-run antes del guard;
//   - scripts db:seed:rbac-demo en packages/database y en la raíz;
//   - el smoke no lleva contraseñas literales, toma los usuarios del seed,
//     rota la contraseña, usa x-property-id, exige 403 por SOD_STATIC_PAIRS y
//     404 fuera de ámbito, y sus parsers leen las fuentes reales.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const seed = read("../packages/database/prisma/seed-rbac-demo.ts");
const smoke = read("../scripts/check-role-smoke.mjs");
const rootPackage = JSON.parse(read("../package.json"));
const databasePackage = JSON.parse(read("../packages/database/package.json"));
const rbacTypesSource = read("../packages/shared/src/rbac-types.ts");
const permissionsSource = read("../packages/shared/src/permissions.ts");
const navContract = read("./rbac-nav-contract.test.mjs");

// ---------------------------------------------------------------------------
// Parsers del seed (sin TS)
// ---------------------------------------------------------------------------

const ORG_ID = "cmrhw9jy30002fyvb6tsdiugt";
const EXPECTED_PROPERTIES = {
  LT: "cmu1mifcp0000fyo1wzvq7txo",
  RA: "cmrhw9jy40003fyvbuu2ec2w7",
  PG: "cmu4805uo000afyvlr44ufp8r",
  MC: "cmu4805w0002afyvl6kb1wtbf",
  AS: "cmu4805xd0053fyvl5z7swn6y",
  OC: "cmu4805tm0001fyvlwatrruq2"
};
const EXPECTED_GROUPS = { galicia: ["LT", "RA"], "asturias-cantabria": ["PG", "MC", "AS"] };
/** Tabla del lote L5 (§8.1 ampliada): local → [plantilla, ámbito, referencia]. */
const EXPECTED_PEOPLE = {
  "recepcion.pathos": ["receptionist", "property", "PG"],
  "recepcion.rias": ["receptionist", "property", "RA"],
  "auditoria.noche.tilos": ["night_auditor", "property", "LT"],
  "jefatura.recepcion.tilos": ["front_office_manager", "property", "LT"],
  "jefatura.recepcion.rias": ["front_office_manager", "property", "RA"],
  "pisos.tilos": ["housekeeper", "property", "LT"],
  "gobernanta.tilos": ["housekeeping_manager", "property", "LT"],
  "mantenimiento.rias": ["maintenance", "property", "RA"],
  "encargado.mantenimiento.rias": ["maintenance_manager", "property", "RA"],
  "tpv.pathos": ["fnb", "property", "PG"],
  "jefatura.ab.pathos": ["fnb_manager", "property", "PG"],
  "comercial.galicia": ["sales", "property_group", "galicia"],
  "administracion.tilos": ["admin_clerk", "property", "LT"],
  "administracion.central": ["admin_clerk", "property", "OC"],
  "direccion.tilos": ["manager", "property", "LT"],
  "direccion.rias": ["manager", "property", "RA"],
  "direccion.pathos": ["manager", "property", "PG"],
  "operaciones.galicia": ["operations_director", "property_group", "galicia"],
  "operaciones.norte": ["operations_director", "property_group", "asturias-cantabria"],
  revenue: ["revenue", "organization", ORG_ID],
  contabilidad: ["accountant", "legal_entity", "le_5a1bd74b"],
  "direccion.financiera": ["controller", "legal_entity", "le_5a1bd74b"],
  rrhh: ["payroll_hr", "legal_entity", "le_5a1bd74b"],
  cumplimiento: ["compliance", "legal_entity", "le_5a1bd74b"],
  activos: ["asset_manager", "legal_entity", "le_5a1bd74b"],
  "direccion.general": ["general_manager", "organization", ORG_ID],
  "auditoria.interna": ["auditor", "organization", ORG_ID],
  sistemas: ["admin", "organization", ORG_ID]
};

function usersBlock() {
  const block = seed.match(/export const RBAC_DEMO_USERS[^=]*=\s*\[(.*?)\n\];/s);
  assert.ok(block, "RBAC_DEMO_USERS not found in the seed");
  return block[1];
}

function parsePeople() {
  const re = /\{\s*local:\s*"([^"]+)",\s*fullName:\s*"([^"]+)",\s*templateKey:\s*"([^"]+)",\s*scope:\s*(?:property\("([A-Z]{2})"\)|group\("([^"]+)"\)|(legalEntity)|(organization))\s*\}/g;
  return [...usersBlock().matchAll(re)].map((m) => ({
    local: m[1],
    fullName: m[2],
    templateKey: m[3],
    scopeType: m[4] ? "property" : m[5] ? "property_group" : m[6] ? "legal_entity" : "organization",
    ref: m[4] ?? m[5] ?? (m[6] ? "le_5a1bd74b" : ORG_ID)
  }));
}

function parseEmergency() {
  const re = /\{\s*local:\s*`\$\{EMERGENCY_LOCAL_PREFIX\}(\d)`,\s*fullName:\s*"([^"]+)",\s*emergency:\s*true\s*\}/g;
  return [...usersBlock().matchAll(re)].map((m) => ({ local: `emergencia-${m[1]}`, fullName: m[2] }));
}

function parseConst(source, name) {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`));
  assert.ok(m, `${name} not found`);
  return m[1];
}

function importSpecifiers(source) {
  return [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Literales de cadena y partes de template literal de un fuente JS. */
function stringLiterals(source) {
  const out = [];
  for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gs)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function looksLikePassword(text) {
  return /^[^\s/]{8,}$/.test(text) && /[A-Z]/.test(text) && /[0-9]/.test(text) && /[^A-Za-z0-9]/.test(text);
}

function passwordPolicyOk(text) {
  return text.length >= 8 && /[A-Z]/.test(text) && /[0-9]/.test(text) && /[^A-Za-z0-9]/.test(text);
}

const people = parsePeople();
const emergency = parseEmergency();
const DEMO_PASSWORD = parseConst(seed, "DEMO_PASSWORD");

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

describe("RBAC demo seed · correos, guard y aislamiento (L5)", () => {
  it("solo conoce correos @faranda.test / @example.com y nunca un correo real", () => {
    assert.equal(parseConst(seed, "EMAIL_DOMAIN"), "faranda.test");
    for (const source of [seed, smoke]) {
      const emails = [...new Set([...source.matchAll(EMAIL_RE)].map((m) => m[0]))];
      const foreign = emails.filter((email) => !/@(faranda\.test|example\.com)$/.test(email));
      assert.deepEqual(foreign, [], `correos fuera de los dominios ficticios: ${foreign.join(", ")}`);
    }
    assert.doesNotMatch(seed, /farandariasaltas/, "Carmen (correo real) no aparece en el seed");
    assert.doesNotMatch(smoke, /farandariasaltas/);
  });

  it("pasa por assertDemoTarget con Faranda como objetivo (fuera de la allowlist: exige SEED_ALLOW_REAL + SEED_CONFIRM)", () => {
    assert.match(seed, /import \{ assertDemoTarget[^}]*\} from "\.\/lib\/demo-guard\.js"/);
    assert.match(seed, /assertDemoTarget\(\{\s*orgId: ORG_ID/);
    assert.equal(parseConst(seed, "ORG_ID"), ORG_ID);
    assert.match(seed, /SEED_ALLOW_REAL=1/);
    assert.match(seed, new RegExp(`SEED_CONFIRM=\\$\\{ORG_ID\\}|SEED_CONFIRM=${ORG_ID}`));
  });

  it("--dry-run imprime el plan y termina ANTES del guard y de cualquier escritura", () => {
    assert.match(seed, /arg === "--dry-run"/);
    const dryRunReturn = seed.indexOf("if (flags.dryRun) {");
    const guard = seed.indexOf("assertDemoTarget({");
    const apply = seed.indexOf("applyPlan(prisma, plan, password)");
    assert.ok(dryRunReturn > 0 && guard > dryRunReturn && apply > guard, "orden esperado: dry-run → assertDemoTarget → applyPlan");
  });

  it("no importa nada de apps/api ni del paquete @hotelos (catálogo compartido por ruta relativa)", () => {
    const specifiers = importSpecifiers(seed);
    assert.ok(specifiers.length >= 5, `imports parsed: ${specifiers.length}`);
    const allowed = /^(node:[a-z_/]+|@prisma\/client|\.\/lib\/demo-guard\.js|\.\.\/src\/password\.js|\.\.\/\.\.\/shared\/src\/index\.js)$/;
    for (const specifier of specifiers) assert.match(specifier, allowed, `import no permitido en el seed: ${specifier}`);
    assert.doesNotMatch(seed, /from "[^"]*apps\/api/);
    assert.doesNotMatch(seed, /import\("[^"]*apps\/api/);
    assert.doesNotMatch(seed, /from "@hotelos\//);
    for (const name of ["ROLE_PERMISSION_MAP", "ORGANIZATION_TEMPLATE_ROLE_KEYS", "ROLE_TEMPLATE_LABELS_ES", "ROLE_TEMPLATE_LEVEL", "ROLE_TEMPLATE_VERSION", "ORG_PERMISSION_KEYS", "DEFAULT_THRESHOLDS"]) {
      assert.match(seed, new RegExp(`^\\s*${name},?$`, "m"), `${name} debe importarse del catálogo compartido`);
    }
  });

  it("no toca a los usuarios existentes ni borra nada", () => {
    assert.ok(!people.some((user) => user.local === "recepcion.tilos"), "recepcion.tilos existe y no se siembra");
    assert.doesNotMatch(seed, /\.deleteMany\(/, "el seed nunca borra");
    assert.doesNotMatch(seed, /rolePermission\.delete/, "el seed nunca revoca claves (eso es rbac:sync --upgrade-templates)");
    assert.match(seed, /role\.updateMany\(\{ where: \{ id: roleId, level: null \}/, "el nivel solo se rellena cuando es null");
    assert.match(seed, /ya existe en otra organización/, "un correo de otra organización bloquea el seed");
  });
});

describe("RBAC demo seed · 30 usuarios, plantillas y ámbitos (§8.1)", () => {
  it("30 usuarios = 28 personas + 2 cuentas de emergencia, locales únicas", () => {
    assert.equal(people.length, 28, `personas parseadas: ${people.map((u) => u.local).join(", ")}`);
    assert.equal(emergency.length, 2);
    const locals = [...people.map((u) => u.local), ...emergency.map((u) => u.local)];
    assert.equal(new Set(locals).size, 30);
    assert.match(seed, /users\.length !== 30/);
    assert.match(seed, /emergency !== 2/);
  });

  it("cada persona lleva la plantilla y el ámbito de la tabla del lote", () => {
    assert.deepEqual([...people.map((u) => u.local)].sort(), Object.keys(EXPECTED_PEOPLE).sort());
    for (const user of people) {
      const [templateKey, scopeType, ref] = EXPECTED_PEOPLE[user.local];
      assert.equal(user.templateKey, templateKey, `${user.local}: plantilla`);
      assert.equal(user.scopeType, scopeType, `${user.local}: ámbito`);
      assert.equal(user.ref, ref, `${user.local}: referencia`);
      assert.ok(user.fullName.split(" ").length >= 2, `${user.local}: nombre inventado con apellido`);
    }
  });

  it("los 4 scopeType se escriben en user_role_assignments; solo property se espeja en user_property_roles (dual-read)", () => {
    const byScope = new Set(people.map((u) => u.scopeType));
    assert.deepEqual([...byScope].sort(), ["legal_entity", "organization", "property", "property_group"]);
    assert.match(seed, /\| \{ scopeType: "property"; property: FarandaPropertyCode \}/);
    assert.match(seed, /\| \{ scopeType: "property_group"; groupCode: string \}/);
    assert.match(seed, /\| \{ scopeType: "legal_entity" \}/);
    assert.match(seed, /\| \{ scopeType: "organization" \}/);
    assert.match(seed, /tx\.userRoleAssignment\.create\(\{/);
    assert.match(seed, /scopeType: row\.scopeType,\s*propertyId: row\.propertyId,\s*propertyGroupId,\s*legalEntityId: row\.legalEntityId,\s*organizationId: ORG_ID/);
    assert.match(seed, /if \(row\.scopeType === "property" && row\.propertyId\) \{[\s\S]*?tx\.userPropertyRole\.create\(/);
    assert.match(seed, /revokedAt: null/, "una asignación revocada no cuenta como existente");
  });

  it("cuentas de emergencia: status emergency, sin contraseña, 2FA, sin asignación fija; prefijo emergencia-", () => {
    assert.equal(parseConst(seed, "EMERGENCY_LOCAL_PREFIX"), "emergencia-");
    assert.match(seed, /status: "emergency", mfaEnabled: true, passwordHash: null, mustChangePassword: false/);
    assert.match(seed, /if \(isEmergencyAccount\(user\)\) continue;/, "las cuentas de emergencia no reciben asignación");
    assert.match(seed, /user\.templateKey === "break_glass"\) throw/, "break_glass nunca se asigna a una persona");
  });

  it("personas: status active, mustChangePassword true, 2FA para rango ≥ 2, contraseña única que cumple la política y sale al final", () => {
    assert.match(seed, /status: "active", mfaEnabled: requiresMfa\(spec\), passwordHash, mustChangePassword: true/);
    assert.match(seed, /ROLE_LEVEL_RANK\[ROLE_TEMPLATE_LEVEL\[user\.templateKey\]\] >= 2/);
    assert.ok(passwordPolicyOk(DEMO_PASSWORD), "DEMO_PASSWORD debe cumplir la política del API");
    assert.equal(parseConst(seed, "PASSWORD_ENV_VAR"), "RBAC_DEMO_PASSWORD");
    assert.match(seed, /process\.env\.RBAC_DEMO_PASSWORD/);
    assert.match(seed, /hashPassword\(password\)/);
    assert.equal((seed.match(/hashPassword\(/g) ?? []).length, 1, "una sola contraseña para todos");
    assert.match(seed, /Contraseña de demo[^\n]*\$\{result\.password\}/, "el seed imprime la contraseña al final");
  });

  it("provisiona las 22 plantillas + admin + Emergencia con nivel / departamento / versión / managed y solo hace top-up aditivo", () => {
    assert.match(seed, /export const SEEDED_TEMPLATES: readonly RoleKey\[\] = \[\.\.\.ORGANIZATION_TEMPLATE_ROLE_KEYS, "admin", "break_glass"\]/);
    assert.match(seed, /level: ROLE_TEMPLATE_LEVEL\[row\.templateKey\],\s*department: ROLE_TEMPLATE_DEPARTMENT_ES\[row\.templateKey\],\s*templateVersion: ROLE_TEMPLATE_VERSION,\s*managed: true/);
    assert.match(seed, /rolePermission\.createMany\(\{ data: toGrant\.map/);
    assert.match(seed, /skipDuplicates: true/);
    assert.match(seed, /templateKey === "break_glass" \? \[\.\.\.ORG_PERMISSION_KEYS\]/, "Emergencia = todas las claves de organización, nunca de plataforma");
  });

  it("dos grupos de propiedades con los centros del diseño (D5) y la sociedad CELUISMA", () => {
    for (const [code, id] of Object.entries(EXPECTED_PROPERTIES)) assert.match(seed, new RegExp(`${code}: "${id}"`), `centro ${code}`);
    for (const [code, members] of Object.entries(EXPECTED_GROUPS)) {
      assert.match(seed, new RegExp(`code: "${code}", name: "[^"]+", members: \\[${members.map((m) => `"${m}"`).join(", ")}\\]`), `grupo ${code}`);
    }
    assert.equal(parseConst(seed, "LEGAL_ENTITY_ID"), "le_5a1bd74b");
    assert.match(seed, /tx\.propertyGroup\.upsert\(\{/);
    assert.match(seed, /tx\.propertyGroupMember\.createMany\(\{/);
  });

  it("umbrales por defecto (§4.7) en role_thresholds solo si la organización no tiene filas", () => {
    assert.match(seed, /roleThreshold\.count\(\{ where: \{ organizationId: ORG_ID, roleId: null, level: null \} \}\)/);
    assert.match(seed, /tx\.roleThreshold\.createMany\(\{ data: thresholdRows\(ORG_ID\) \}\)/);
    assert.match(seed, /for \(const action of THRESHOLD_ACTIONS\)/);
    assert.match(seed, /tier: "ABOVE_T4"/);
    assert.match(seed, /requiresSecondApproval: true/);
    assert.match(seed, /DEFAULT_THRESHOLDS\.rateBandPct/);
  });

  it("audita cada asignación como ROLE_ASSIGNED (actorType system) en la cadena sha256 y sube rbac_version una vez", () => {
    assert.match(seed, /action: "ROLE_ASSIGNED"/);
    assert.match(seed, /action: "USER_CREATED"/);
    assert.match(seed, /actorType: "system"/);
    assert.doesNotMatch(seed, /actorType: "user"/);
    assert.equal(parseConst(seed, "CORRELATION_PREFIX"), "rbac_demo_seed_");
    assert.match(seed, /createHash\("sha256"\)/);
    assert.match(seed, /previousHash,\s*currentHash/);
    assert.match(seed, /rbacVersion: \{ increment: 1 \}/);
  });
});

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

describe("RBAC demo seed · scripts", () => {
  it("db:seed:rbac-demo existe en packages/database y en la raíz con el patrón de db:seed:commercial", () => {
    assert.equal(databasePackage.scripts["db:seed:rbac-demo"], "node --env-file=../../.env --import tsx prisma/seed-rbac-demo.ts");
    assert.equal(rootPackage.scripts["db:seed:rbac-demo"], "pnpm --filter @hotelos/database db:seed:rbac-demo");
    assert.equal(databasePackage.scripts["db:seed:commercial"], "node --env-file=../../.env --import tsx prisma/seed-commercial-demo.ts");
  });
});

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe("check-role-smoke.mjs · contraseñas, fuentes y reglas", () => {
  it("integrador 8a: el limitador de /auth/login (10/min por IP) no cuenta como fallo: login y change-password reintentan tras esperar la ventana", () => {
    assert.match(smoke, /export const RATE_LIMIT_WINDOW_MS = 61_000;/);
    assert.match(smoke, /export const RATE_LIMIT_MAX_RETRIES = 6;/);
    assert.match(smoke, /async function withRateLimitRetry\(request, label\)/);
    assert.match(smoke, /if \(last\.status !== 429\) return last;/);
    assert.match(smoke, /async function login\(app, email, password, deviceId\) \{\n\s+return withRateLimitRetry\(/);
    assert.match(smoke, /async function changePassword\(app, token, currentPassword, newPassword\) \{\n\s+return withRateLimitRetry\(/);
  });

  it("no contiene contraseñas literales (la del seed llega por resolveDemoPassword y la temporal se deriva de ella)", () => {
    const suspicious = stringLiterals(smoke).filter((text) => looksLikePassword(text) && text !== DEMO_PASSWORD);
    assert.deepEqual(suspicious, [], `literales con pinta de contraseña: ${suspicious.join(" | ")}`);
    assert.ok(!smoke.includes(DEMO_PASSWORD), "ni siquiera la del seed va literal en el smoke");
    assert.match(smoke, /seed\.resolveDemoPassword\(\)/);
    assert.match(smoke, /const tempPassword = `\$\{demoPassword\}\$\{ROTATION_SUFFIX\}`/);
    assert.doesNotMatch(smoke, /password:\s*"/);
  });

  it("toma los usuarios del seed (fuente única) y salta las cuentas de emergencia", () => {
    assert.match(smoke, /seed: resolve\(REPO_ROOT, "packages\/database\/prisma\/seed-rbac-demo\.ts"\)/);
    assert.match(smoke, /seed\.RBAC_DEMO_USERS/);
    assert.match(smoke, /seed\.isEmergencyAccount\(user\)/);
    assert.match(smoke, /if \(user\.emergency\) \{[\s\S]*?no se prueba por login/);
  });

  it("arranca el API en proceso (buildApiServer + app.inject) en modo estricto y sin unión demo, rota la contraseña y usa x-property-id", () => {
    assert.match(smoke, /const \{ buildApiServer \} = await importTs\(PATHS\.server\)/);
    assert.match(smoke, /app\.inject\(/);
    assert.match(smoke, /applyEnv\(\{ RBAC_STRICT: "true", HOTELOS_DEMO_PERMISSION_UNION: "false", RUN_SCHEDULERS: "false" \}\)/);
    assert.match(smoke, /url: "\/auth\/login"/);
    assert.match(smoke, /url: "\/auth\/change-password"/);
    assert.match(smoke, /"\/users\/me"/);
    assert.match(smoke, /"x-property-id": activePropertyId/);
    assert.match(smoke, /mustChangePassword === true/);
  });

  it("cruza nav-tree × inventario con la regla readRoutesFor del contrato, exige 403 por SOD_STATIC_PAIRS y 404 fuera de ámbito, salida 1 si hay fallos", () => {
    assert.match(smoke, /nav-tree\.generated\.json/);
    assert.match(smoke, /\.\.\/pilots\/screens-inventory\.csv/);
    assert.match(smoke, /function readRoutesFor\(screenKey\)/);
    assert.match(smoke, /parseSodPairs\(rbacTypesSource\)/);
    assert.match(smoke, /parseStringRecord\(rbacTypesSource, "ROLE_TEMPLATE_NAV_TOKEN"\)/);
    assert.match(smoke, /const SOD_PROBES = 3;/);
    assert.match(smoke, /res\.statusCode === 403/);
    assert.match(smoke, /foreignRes\.status === 404/);
    assert.match(smoke, /return report\.ok \? 0 : 1;/);
    for (const flag of ["--dry-run", "--users", "--json", "--keep-rotated"]) assert.ok(smoke.includes(`"${flag}"`), `flag ${flag}`);
    // Misma regla que el contrato: todas las GET mapeadas; si ninguna, la primera mutación.
    assert.match(navContract, /function readRoutesFor\(row, screenKey\)/);
    assert.match(smoke, /if \(gets\.size > 0\) return \[\.\.\.gets\.values\(\)\];/);
    assert.match(navContract, /if \(gets\.size > 0\) return \[\.\.\.gets\.values\(\)\];/);
  });

  it("sus parsers leen las fuentes reales (24 plantillas, 24 tokens, todos los pares SoD) y buildUrl sustituye solo :propertyId", async () => {
    const mod = await import("../scripts/check-role-smoke.mjs");
    const { templates } = mod.parseTemplates(permissionsSource);
    assert.equal(Object.keys(templates).length, 24, "ROLE_PERMISSION_MAP → 24 plantillas");
    assert.ok(templates.break_glass.size > 200, "break_glass = todas las claves de organización");
    const navToken = mod.parseStringRecord(rbacTypesSource, "ROLE_TEMPLATE_NAV_TOKEN");
    assert.equal(Object.keys(navToken).length, 24);
    assert.equal(navToken.admin, "sistemas");
    const pairs = mod.parseSodPairs(rbacTypesSource);
    const declared = (rbacTypesSource.match(/\{\s*a:\s*"[^"]+",\s*b:\s*"[^"]+"/g) ?? []).length;
    assert.equal(pairs.length, declared);
    assert.ok(pairs.some((pair) => pair.a === "payables.approve" && pair.b === "payables.pay" && pair.except.includes("controller")));
    assert.equal(mod.buildUrl("/properties/:p/reservations/:id", "/properties/:propertyId/reservations/:id", "PROP"), "/properties/PROP/reservations/smoke-no-existe");
    assert.equal(mod.buildUrl("/approvals", "/approvals", "PROP"), "/approvals");
    assert.equal(mod.foreignPropertyFor(["a", "b"], ["a"]), "b");
    assert.equal(mod.foreignPropertyFor(["a", "b"], ["a", "b"]), "prop_123");
    const manifest = mod.loadManifest();
    assert.ok(manifest.length > 900, `manifiesto parseado: ${manifest.length}`);
    // Sondas SoD: prefieren la clave contraria a una que la plantilla tiene.
    const model = { templates, sodPairs: pairs, manifest };
    const probes = mod.sodProbesFor(model, ["receptionist"]);
    assert.equal(probes.length, 3);
    assert.ok(probes.every((probe) => !templates.receptionist.has(probe.key)), "toda sonda exige una clave que la plantilla no tiene");
    assert.ok(probes.some((probe) => probe.why === "separación de funciones"));
    assert.deepEqual(mod.missingKeysFor(model, ["receptionist"], ["pms.reservation.read", "payables.pay"]), ["payables.pay"]);
  });
});
