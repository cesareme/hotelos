// Contrato documental · Activo inmobiliario (Tanda ACT · lote ACT-D1).
//
// Ata docs/runbooks/activo-inmobiliario.md, docs/api-contracts.md y el diseño a
// la fuente de verdad (patrón tests/documentos-docs-contract.test.mjs: readFileSync
// + node --test, sin BD ni servidor; tablas parseadas por celdas):
//   · el runbook existe con sus 11 secciones numeradas;
//   · §6.1 lista EXACTAMENTE las entradas de los 6 partials de modules/real-estate
//     (método, ruta, claves, riesgo) y el recuento de cada partial; el agregador
//     route-permissions.partial.ts no aporta entradas propias;
//   · docs/api-contracts.md contiene cada ruta del módulo (sección «Activo
//     inmobiliario (Tanda ACT · 2026-09-20)») y la remisión desde «Real Estate,
//     Assets, And Owner Dashboard» para las rutas de /capex-projects/:id (approve, work, capitalize);
//   · §7 documenta cada código de REAL_ESTATE_ERROR_CODES (packages/shared) con
//     HTTP, causa, mensaje del API y el mensaje del front VERBATIM
//     (REAL_ESTATE_ERROR_MESSAGES de screens/realEstate/real-estate-helpers.ts),
//     más los REAL_ESTATE_EXTRA_ERROR_CODES;
//   · §2 documenta los 10 modelos de la migración y CapexProject con **`Modelo`**;
//   · §3 reproduce las tablas de state-machines.ts (de → [a…]);
//   · §8 nombra cada REAL_ESTATE_ALERT_KINDS y los umbrales 90 / 30 / 7;
//   · §9 cita db:seed:real-estate, org_act y *@act.test;
//   · marca «ehotelOS», ningún literal de la marca anterior y ninguna mención a
//     la organización real (nombre o id) en el runbook ni en la sección nueva;
//   · el diseño lleva la nota «Estado tras la implementación» en §7 y §9.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const api = (relative) => read(`../apps/api/src/${relative}`);

const runbook = read("../docs/runbooks/activo-inmobiliario.md");
const contracts = read("../docs/api-contracts.md");
const design = read("../docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md");
const sharedTypes = read("../packages/shared/src/real-estate-types.ts");
const stateMachines = api("modules/real-estate/state-machines.ts");
const frontHelpers = read("../apps/admin-web/src/screens/realEstate/real-estate-helpers.ts");
const migrationSql = read("../packages/database/prisma/migrations/20260920170000_activo_inmobiliario/migration.sql");
const databasePackage = JSON.parse(read("../packages/database/package.json"));

const REAL_ESTATE_DIR = new URL("../apps/api/src/modules/real-estate/", import.meta.url);
/** Organización real: nunca aparece en el runbook ni en la sección nueva de api-contracts (ni por nombre ni por id). */
const REAL_ORG_ID = "cmrhw9jy30002fyvb6tsdiugt";
const REAL_ORG_NAME = /faranda/i;
const OLD_BRAND = /\b(?:Anfitorio|ANFITORIO|HotelOS|hotelOS|Hotel OS)\b/;

// ---------------------------------------------------------------- helpers

const flat = (text) => text.replace(/\s+/g, " ");

function section(doc, startHeading, endHeading) {
  const start = doc.indexOf(startHeading);
  assert.ok(start >= 0, `heading not found: ${startHeading}`);
  const end = endHeading ? doc.indexOf(endHeading, start + startHeading.length) : -1;
  assert.ok(!endHeading || end > start, `heading not found after ${startHeading}: ${endHeading}`);
  return end > start ? doc.slice(start, end) : doc.slice(start);
}

/** Same rule as tests/api-route-permissions-contract: a commented-out entry is not an entry. */
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

const ENTRY_PATTERN = /\{\s*method:\s*"(GET|POST|PATCH|DELETE|PUT)"\s*,\s*path:\s*"([^"]+)"\s*,\s*permissions:\s*\[([^\]]*)\]\s*,\s*riskLevel:\s*"(\w+)"\s*\}/g;

function parsePartial(rawSource, name) {
  const source = stripLineComments(rawSource);
  const declaration = /export const \w+(?:: ApiRoutePermission\[\])? = \[/.exec(source);
  assert.ok(declaration, `${name}: permission array not found`);
  const end = source.indexOf("\n];", declaration.index);
  assert.ok(end > declaration.index, `${name}: permission array not closed`);
  const body = source.slice(declaration.index, end);
  return [...body.matchAll(ENTRY_PATTERN)].map((m) => ({
    method: m[1],
    path: m[2],
    permissions: m[3].replace(/"/g, "").split(",").map((s) => s.trim()).filter(Boolean).sort(),
    risk: m[4]
  }));
}

/** Markdown table rows (cells trimmed) of a text fragment; header and separator rows excluded. */
function tableRows(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !/^\| (Ruta|Código|Modelo|Desde|Línea|Qué) /.test(line))
    .map((line) => line.replace(/^\|\s*/, "").replace(/\s*\|$/, "").split(/\s\|\s/).map((cell) => cell.trim()));
}

/** Keys quoted in backticks BEFORE the first explanatory parenthesis of a permission cell. */
function keysOf(cell) {
  if (cell.startsWith("—")) return [];
  const head = cell.split(" (")[0];
  return [...head.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
}

function parseConstArray(source, name) {
  const block = source.match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`, "s"));
  assert.ok(block, `${name} not found`);
  return [...stripLineComments(block[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `export const X_TRANSITIONS … = { from: ["a", "b"], … }` → Map(from → [a, b]). */
function parseTransitions(source, name) {
  const block = source.match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  assert.ok(block, `${name} not found`);
  const table = new Map();
  for (const m of stripLineComments(block[1]).matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    table.set(m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  }
  assert.ok(table.size > 0, `${name}: no rows parsed`);
  return table;
}

/** `CODE: "message",` rows of the frozen REAL_ESTATE_ERROR_MESSAGES object. */
function parseFrontMessages(source) {
  const block = source.match(/export const REAL_ESTATE_ERROR_MESSAGES[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(block, "REAL_ESTATE_ERROR_MESSAGES not found");
  const messages = new Map();
  for (const m of block[1].matchAll(/^\s*([A-Z_]+):\s*"((?:[^"\\]|\\.)*)"/gm)) messages.set(m[1], m[2].replace(/\\"/g, "\""));
  assert.ok(messages.size >= 18, `unexpectedly few front messages: ${messages.size}`);
  return messages;
}

// ---------------------------------------------------------------- sources

const partialFiles = readdirSync(REAL_ESTATE_DIR)
  .filter((file) => file.endsWith("-route-permissions.partial.ts"))
  .sort();
const partialEntries = partialFiles.map((file) => ({ file, entries: parsePartial(readFileSync(new URL(file, REAL_ESTATE_DIR), "utf8"), file) }));
const aggregatorEntries = parsePartial(readFileSync(new URL("route-permissions.partial.ts", REAL_ESTATE_DIR), "utf8"), "route-permissions.partial.ts");
const allEntries = partialEntries.flatMap(({ entries }) => entries);

const errorCodes = parseConstArray(sharedTypes, "REAL_ESTATE_ERROR_CODES");
const extraCodes = parseConstArray(frontHelpers, "REAL_ESTATE_EXTRA_ERROR_CODES");
const alertKinds = parseConstArray(sharedTypes, "REAL_ESTATE_ALERT_KINDS");
const frontMessages = parseFrontMessages(frontHelpers);

const SECTION_HEADINGS = [
  "## 1 · Qué es y decisiones",
  "## 2 · Modelos",
  "## 3 · Máquinas de estado",
  "## 4 · Asiento propuesto",
  "## 5 · Documentos y almacén",
  "## 6 · Rutas y permisos",
  "## 7 · Códigos de error",
  "## 8 · Alertas y calendario",
  "## 9 · Datos de prueba",
  "## 10 · Verificación",
  "## 11 · Límites y lo que solo César puede aportar"
];

const modelsSection = section(runbook, "## 2 · Modelos", "## 3 ·");
const machinesSection = section(runbook, "## 3 · Máquinas de estado", "## 4 ·");
const routesSection = section(runbook, "### 6.1 Tabla exacta", "### 6.2");
const errorsSection = section(runbook, "## 7 · Códigos de error", "## 8 ·");
const alertsSection = section(runbook, "## 8 · Alertas y calendario", "## 9 ·");
const seedSection = section(runbook, "## 9 · Datos de prueba", "## 10 ·");
const contractsSection = section(contracts, "## Activo inmobiliario (Tanda ACT · 2026-09-20)", "## Tanda L2 · Persistencia y API");
const capexSection = section(contracts, "## Real Estate, Assets, And Owner Dashboard", "## Compliance");

// ---------------------------------------------------------------- tests

describe("Activo inmobiliario · contrato documental (docs/runbooks/activo-inmobiliario.md)", () => {
  it("el runbook existe con las 11 secciones numeradas, en orden", () => {
    let cursor = -1;
    for (const heading of SECTION_HEADINGS) {
      const at = runbook.indexOf(`\n${heading}`);
      assert.ok(at > cursor, `runbook must have «${heading}» after the previous section`);
      cursor = at;
    }
    assert.equal((runbook.match(/^## \d+ · /gm) ?? []).length, 11, "exactly 11 numbered sections");
  });

  it("descubre los 6 partials del módulo (42 entradas) y el agregador sin entradas propias", () => {
    assert.deepEqual(partialFiles, [
      "core-route-permissions.partial.ts",
      "documents-route-permissions.partial.ts",
      "group-route-permissions.partial.ts",
      "inspections-route-permissions.partial.ts",
      "taxes-route-permissions.partial.ts",
      "works-route-permissions.partial.ts"
    ]);
    for (const { file, entries } of partialEntries) assert.ok(entries.length > 0, `${file}: no entries parsed`);
    assert.equal(allEntries.length, 42, "the module declares 42 routes (ACT-REV-05: + POST /capex-projects/:id/approve)");
    assert.equal(aggregatorEntries.length, 0, "route-permissions.partial.ts only spreads the six partials");
    const keys = new Set(allEntries.map((e) => `${e.method} ${e.path}`));
    assert.equal(keys.size, allEntries.length, "no duplicate method + path across partials");
  });

  it("§6.1 lista exactamente las entradas de las 6 partials (método, ruta, claves, riesgo)", () => {
    const expected = new Map();
    for (const entry of allEntries) expected.set(`${entry.method} ${entry.path}`, entry);

    const documented = new Map();
    for (const cells of tableRows(routesSection)) {
      assert.equal(cells.length, 3, `§6.1 row must have 3 cells: ${cells.join(" | ")}`);
      const [route, permissionCell, risk] = cells;
      const routeMatch = /^`(GET|POST|PATCH|DELETE|PUT) (\/\S+)`$/.exec(route);
      assert.ok(routeMatch, `§6.1 route cell not parseable: ${route}`);
      assert.ok(!documented.has(`${routeMatch[1]} ${routeMatch[2]}`), `§6.1 duplicates ${route}`);
      documented.set(`${routeMatch[1]} ${routeMatch[2]}`, { permissions: keysOf(permissionCell), risk });
    }
    for (const [key, entry] of expected) {
      const row = documented.get(key);
      assert.ok(row, `§6.1 is missing the partial entry ${key}`);
      assert.deepEqual(row.permissions, entry.permissions, `§6.1 permissions differ for ${key}`);
      assert.equal(row.risk, entry.risk, `§6.1 risk differs for ${key}`);
    }
    for (const key of documented.keys()) assert.ok(expected.has(key), `§6.1 documents a route no partial declares: ${key}`);

    // The counts quoted next to each partial name follow the parsed arrays.
    for (const { file, entries } of partialEntries) {
      const match = new RegExp(`modules/real-estate/${file.replace(/[/.]/g, "\\$&")}\`,\\s*(\\d+)\\s+entradas`).exec(flat(routesSection));
      assert.ok(match, `§6.1 must state the entry count of ${file}`);
      assert.equal(Number(match[1]), entries.length, `§6.1 entry count of ${file}`);
    }
    assert.match(flat(routesSection), /\(42 en total;/);
  });

  it("docs/api-contracts.md contiene cada ruta del módulo y remite desde «Real Estate» a las dos rutas de capex", () => {
    for (const entry of allEntries) {
      const literal = `\`${entry.method} ${entry.path}\``;
      assert.ok(contractsSection.includes(literal), `api-contracts «Activo inmobiliario» must document ${literal}`);
      for (const key of entry.permissions) assert.ok(contractsSection.includes(`\`${key}\``), `api-contracts must name the key ${key}`);
    }
    const rows = tableRows(contractsSection).filter((cells) => /^`(GET|POST|PATCH|DELETE) \//.test(cells[0]));
    assert.equal(rows.length, 42, "one table row per route");
    for (const cells of rows) assert.equal(cells.length, 4, `route row must have 4 cells: ${cells[0]}`);
    for (const code of errorCodes) assert.ok(contractsSection.includes(`\`${code}\``), `api-contracts must list the error code ${code}`);
    assert.match(flat(contractsSection), /20260920170000_activo_inmobiliario/);
    assert.match(flat(contractsSection), /docs\/runbooks\/activo-inmobiliario\.md/);
    assert.ok(capexSection.includes("`POST /capex-projects/:id/approve`"), "«Real Estate» must refer to POST /capex-projects/:id/approve");
    assert.ok(capexSection.includes("`PATCH /capex-projects/:id/work`"), "«Real Estate» must refer to PATCH /capex-projects/:id/work");
    assert.ok(capexSection.includes("`POST /capex-projects/:id/capitalize`"), "«Real Estate» must refer to POST /capex-projects/:id/capitalize");
    assert.ok(capexSection.includes("Activo inmobiliario (Tanda ACT · 2026-09-20)"), "«Real Estate» must point to the new section");
  });

  it("§7 documenta cada código de REAL_ESTATE_ERROR_CODES (HTTP, causa, mensaje del API y mensaje del front verbatim) y los extras", () => {
    assert.equal(errorCodes.length, 18, `unexpected number of error codes: ${errorCodes.length}`);
    assert.ok(extraCodes.length >= 6, `unexpectedly few extra codes: ${extraCodes.length}`);
    const rows = new Map();
    for (const cells of tableRows(errorsSection)) {
      assert.equal(cells.length, 5, `§7 row must have 5 cells: ${cells.join(" | ")}`);
      const code = /^`([A-Z_]+)`$/.exec(cells[0]);
      assert.ok(code, `§7 code cell not parseable: ${cells[0]}`);
      assert.match(cells[1], /^(400|404|409|413|500)( \/ (400|404|409|413|500))?$/, `§7 status of ${code[1]} must be an HTTP status`);
      assert.ok(cells[2].length > 10, `§7 cause of ${code[1]} must not be empty`);
      assert.ok(cells[3].length > 10, `§7 API message of ${code[1]} must not be empty`);
      assert.ok(!rows.has(code[1]), `§7 duplicates ${code[1]}`);
      rows.set(code[1], cells);
    }
    for (const code of [...errorCodes, ...extraCodes]) {
      const cells = rows.get(code);
      assert.ok(cells, `§7 must list ${code}`);
      assert.equal(cells[4], frontMessages.get(code), `§7 front message of ${code} must match REAL_ESTATE_ERROR_MESSAGES`);
    }
    for (const code of rows.keys()) assert.ok(errorCodes.includes(code) || extraCodes.includes(code), `§7 documents a code neither catalogue declares: ${code}`);
    // Every shared code has a front message and vice versa (the front catalogue = shared + extras).
    assert.deepEqual([...frontMessages.keys()].sort(), [...errorCodes, ...extraCodes].sort());
  });

  it("§2 documenta los 10 modelos de la migración y CapexProject, y cita la migración", () => {
    const tables = [...migrationSql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    assert.equal(tables.length, 10, "the migration creates 10 tables");
    const addColumns = (migrationSql.match(/ADD COLUMN\s+"[a-z_]+"/g) ?? []).length;
    assert.equal(addColumns, 12, "the migration adds 12 columns to capex_projects");
    const models = ["RealEstateAsset", "RealEstateUnit", "RealEstateCharge", "RealEstateValuation", "RealEstateTenure", "PropertyTax", "PropertyTaxReceipt", "RealEstateDocument", "RealEstateInspection", "RealEstateInsurance", "CapexProject"];
    for (const model of models) assert.match(modelsSection, new RegExp(`\\*\\*\`${model}\`\\*\\*`), `§2 documents ${model} as **\`${model}\`**`);
    for (const table of tables) assert.ok(modelsSection.includes(`(\`${table}\`)`), `§2 names the table ${table}`);
    assert.match(runbook, /20260920170000_activo_inmobiliario/);
    assert.match(flat(modelsSection), /12 `ADD COLUMN`/);
    assert.match(flat(modelsSection), /0 enums nuevos/);
  });

  it("§3 reproduce las tablas de state-machines.ts (de → [a…]; «—» en los estados finales)", () => {
    const machines = ["TENURE_TRANSITIONS", "RECEIPT_TRANSITIONS", "INSPECTION_TRANSITIONS", "CAPEX_WORK_TRANSITIONS"];
    const rows = new Map();
    for (const cells of tableRows(machinesSection)) {
      if (cells.length !== 2) continue;
      const from = /^`([a-z_]+)`$/.exec(cells[0]);
      if (!from) continue;
      assert.ok(!rows.has(from[1]), `§3 duplicates the state ${from[1]}`);
      rows.set(from[1], cells[1]);
    }
    for (const name of machines) {
      for (const [from, targets] of parseTransitions(stateMachines, name)) {
        const cell = rows.get(from);
        assert.ok(cell !== undefined, `§3 must have a row for ${name} state ${from}`);
        if (targets.length === 0) {
          assert.equal(cell, "—", `§3 must mark ${from} as final (—)`);
        } else {
          const documented = [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
          assert.deepEqual(documented, targets, `§3 targets of ${from} must match ${name}`);
        }
      }
    }
    assert.match(machinesSection, /deriveDocumentStatus/, "§3 explains the document lifecycle (derived status, versions, retire)");
  });

  it("§8 nombra cada tipo de alerta y los umbrales 90 / 30 / 7; §4 fija las cuentas del asiento propuesto", () => {
    assert.ok(alertKinds.length >= 11, `unexpectedly few alert kinds: ${alertKinds.length}`);
    for (const kind of alertKinds) assert.ok(alertSection(kind), `§8 must name the alert kind ${kind}`);
    assert.match(flat(alertsSection), /\[90, 30, 7\]/);
    assert.match(flat(alertsSection), /baja\*\* a ≤ 90 días, \*\*media\*\* a ≤ 30, \*\*alta\*\* a ≤ 7/);
    const entry = section(runbook, "## 4 · Asiento propuesto", "## 5 ·");
    for (const account of ["631", "231", "570", "5721", "572", "475"]) assert.ok(entry.includes(`**${account}**`), `§4 must name account ${account}`);
    assert.match(entry, /FISCAL_YEAR_CLOSED/);
    assert.match(entry, /createJournalEntryDraft/);
    assert.match(entry, /POST \/journal-entries\/:id\/post/);
    function alertSection(kind) {
      return alertsSection.includes(`\`${kind}\``);
    }
  });

  it("§9 cita el script db:seed:real-estate, el tenant org_act y los usuarios *@act.test", () => {
    assert.equal(databasePackage.scripts["db:seed:real-estate"], "node --env-file=../../.env --import tsx prisma/seed-real-estate.ts");
    assert.match(flat(seedSection), /db:seed:real-estate -- --dry-run/);
    assert.match(flat(seedSection), /db:seed:real-estate -- --reset/);
    assert.match(seedSection, /`org_act`/);
    for (const user of ["activos@act.test", "contabilidad@act.test", "direccion@act.test", "recepcion@act.test"]) assert.ok(seedSection.includes(`\`${user}\``), `§9 must list ${user}`);
    assert.match(seedSection, /assertDemoTarget/);
    assert.match(seedSection, /ACT_DEMO_PASSWORD/);
  });

  it("marca ehotelOS, ningún literal de la marca anterior y ninguna mención a la organización real", () => {
    assert.ok(runbook.includes("ehotelOS"), "runbook must name the brand ehotelOS");
    for (const [name, source] of [["runbook", runbook], ["api-contracts «Activo inmobiliario»", contractsSection], ["design note §7", section(design, "## §7 · API y permisos", "### 7.1")]]) {
      const hit = OLD_BRAND.exec(source);
      assert.equal(hit, null, `${name} must not carry the previous brand (${hit && hit[0]})`);
    }
    for (const [name, source] of [["runbook", runbook], ["api-contracts «Activo inmobiliario»", contractsSection]]) {
      assert.doesNotMatch(source, REAL_ORG_NAME, `${name} must not mention the real organisation by name`);
      assert.ok(!source.includes(REAL_ORG_ID), `${name} must not mention the real organisation id`);
    }
  });

  it("el diseño lleva la nota «Estado tras la implementación (Tanda ACT, 2026-09-20)» al principio de §7 y de §9", () => {
    for (const heading of ["## §7 · API y permisos\n", "## §9 · Lotes\n"]) {
      const at = design.indexOf(heading);
      assert.ok(at >= 0, `design heading not found: ${heading.trim()}`);
      const after = design.slice(at + heading.length, at + heading.length + 120);
      assert.match(after, /^\s*> \*\*Estado tras la implementación \(Tanda ACT, 2026-09-20\)\.\*\*/, `note must open ${heading.trim()}`);
    }
    const note7 = section(design, "## §7 · API y permisos", "### 7.1");
    for (const token of ["real_estate.documents.manage", "property_tax.manage", "20260920170000_activo_inmobiliario", "createJournalEntryDraft", "21x", "/properties/:propertyId/real-estate", "/organizations/:organizationId/real-estate/overview | calendar | export"]) {
      assert.ok(note7.includes(token), `design §7 note must mention ${token}`);
    }
  });
});
