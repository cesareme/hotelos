// Contrato documental · Documentos y digitalización con IA (Tanda T9 · lote T9-14).
//
// Ata docs/runbooks/documentos-digitalizacion.md a la fuente de verdad (patrón
// tests/rate-grid-docs-contract.test.mjs: readFileSync + node --test, sin BD ni
// servidor; tablas parseadas por celdas, no por línea literal):
//   · §6.1 lista EXACTAMENTE las entradas de los cuatro partials del módulo
//     (documents, pipeline, workflow, archive) y las filas de la Tanda T9 del
//     partial de payables (recepciones y cotejo), con la misma clave y riesgo;
//   · §7 tiene una fila por cada DOCUMENT_ERROR_CODES del contrato compartido;
//   · §2 documenta cada variable de modules/documents/env.partial.ts;
//   · §9 cita el script demo:seed-documents y la guarda assertDemoTarget; el seed
//     llama assertDemoTarget(, no lee process.env (censo de env-contract), marca
//     sus filas con el prefijo que el runbook anuncia y ni el seed, ni el dataset
//     ni el runbook mencionan a la organización real (nombre o id).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const api = (relative) => read(`../apps/api/src/${relative}`);

const runbook = read("../docs/runbooks/documentos-digitalizacion.md");
const seedSource = api("scripts/seed-documents-demo.ts");
const datasetSource = api("scripts/seed-documents-demo.dataset.ts");
const apiPackage = JSON.parse(read("../apps/api/package.json"));
const sharedDocuments = read("../packages/shared/src/documents-types.ts");
const envPartial = api("modules/documents/env.partial.ts");
const payablesPartial = api("modules/payables/route-permissions.partial.ts");

const DOCUMENTS_DIR = new URL("../apps/api/src/modules/documents/", import.meta.url);
/** Organización real: nunca aparece en el seed, el dataset ni el runbook (ni por nombre ni por id). */
const REAL_ORG_ID = "cmrhw9jy30002fyvb6tsdiugt";
const REAL_ORG_NAME = /faranda/i;

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

/** Markdown table rows (cells trimmed) of a text fragment, header and separator excluded. */
function tableRows(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !/^\| (Ruta|Código|Variable|Plantilla|Qué) \|/.test(line))
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

// ---------------------------------------------------------------- sources

const partialFiles = readdirSync(DOCUMENTS_DIR)
  .filter((file) => file.endsWith("route-permissions.partial.ts"))
  .sort();
const documentsEntries = partialFiles.map((file) => ({ file, entries: parsePartial(readFileSync(new URL(file, DOCUMENTS_DIR), "utf8"), file) }));
const payablesT9Entries = parsePartial(payablesPartial, "payables").filter((e) => e.path.includes("/goods-receipts") || e.path.endsWith("/match"));

const routesSection = section(runbook, "### 6.1 Tabla exacta", "### 6.2");
const errorsSection = section(runbook, "## 7 · Códigos de error", "## 8 ·");
const envSection = section(runbook, "## 2 · Configuración", "## 3 ·");
const seedSection = section(runbook, "## 9 · Seed de demo", "## 10 ·");

// ---------------------------------------------------------------- tests

describe("Documentos · contrato documental (docs/runbooks/documentos-digitalizacion.md)", () => {
  it("discovers the four route-permissions partials of the module and the T9 rows of payables", () => {
    assert.deepEqual(partialFiles, ["archive-route-permissions.partial.ts", "pipeline-route-permissions.partial.ts", "route-permissions.partial.ts", "workflow-route-permissions.partial.ts"]);
    for (const { file, entries } of documentsEntries) assert.ok(entries.length > 0, `${file}: no entries parsed`);
    assert.equal(payablesT9Entries.length, 5, "payables partial must carry the 4 goods-receipts routes and the match route");
  });

  it("§6.1 lists exactly the entries of the module partials and the T9 rows of payables (method, path, keys, risk)", () => {
    const expected = new Map();
    for (const { entries } of documentsEntries) for (const entry of entries) expected.set(`${entry.method} ${entry.path}`, entry);
    for (const entry of payablesT9Entries) expected.set(`${entry.method} ${entry.path}`, entry);
    assert.ok(expected.size >= 30, `unexpectedly few partial entries: ${expected.size}`);

    const documented = new Map();
    for (const cells of tableRows(routesSection)) {
      assert.equal(cells.length, 3, `§6.1 row must have 3 cells: ${cells.join(" | ")}`);
      const [route, permissionCell, risk] = cells;
      const routeMatch = /^`(GET|POST|PATCH|DELETE|PUT) (\/\S+)`$/.exec(route);
      assert.ok(routeMatch, `§6.1 route cell not parseable: ${route}`);
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
    for (const { file, entries } of documentsEntries) {
      const match = new RegExp(`modules/documents/${file.replace(/[/.]/g, "\\$&")}\`,\\s*(\\d+)\\s+entradas`).exec(routesSection);
      assert.ok(match, `§6.1 must state the entry count of ${file}`);
      assert.equal(Number(match[1]), entries.length, `§6.1 entry count of ${file}`);
    }
    const payablesCount = /las (\d+) filas de la Tanda T9 de\s*`modules\/payables\/route-permissions\.partial\.ts`/.exec(flat(routesSection));
    assert.ok(payablesCount, "§6.1 must state how many payables rows belong to the tanda");
    assert.equal(Number(payablesCount[1]), payablesT9Entries.length);
  });

  it("§7 has one row per DOCUMENT_ERROR_CODES entry, with an HTTP status and a message", () => {
    const codes = parseConstArray(sharedDocuments, "DOCUMENT_ERROR_CODES");
    assert.ok(codes.length >= 16, `unexpectedly few error codes: ${codes.length}`);
    const rows = new Map();
    for (const cells of tableRows(errorsSection)) {
      assert.equal(cells.length, 4, `§7 row must have 4 cells: ${cells.join(" | ")}`);
      const code = /^`([A-Z_]+)`$/.exec(cells[0]);
      assert.ok(code, `§7 code cell not parseable: ${cells[0]}`);
      assert.match(cells[1], /^(400|404|409|413|503)$/, `§7 status of ${code[1]} must be an HTTP status`);
      assert.ok(cells[3].length > 10, `§7 message of ${code[1]} must not be empty`);
      rows.set(code[1], cells);
    }
    for (const code of codes) assert.ok(rows.has(code), `§7 must list ${code}`);
    for (const code of rows.keys()) assert.ok(codes.includes(code), `§7 documents a code the contract does not declare: ${code}`);
  });

  it("§2 documents every variable of modules/documents/env.partial.ts", () => {
    const keys = [...envPartial.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{/gm)].map((m) => m[1]);
    assert.ok(keys.includes("DOCUMENT_STORAGE_KIND") && keys.includes("DOCUMENT_RETENTION_JOB_DISABLED"), `unexpected partial keys: ${keys.join(", ")}`);
    const documented = tableRows(envSection).map((cells) => /^`([A-Z0-9_]+)`$/.exec(cells[0])?.[1]);
    for (const key of keys) assert.ok(documented.includes(key), `§2 must have a row for ${key}`);
    assert.match(flat(envSection), /\/var\/lib\/anfitorio\/documents/);
    assert.match(flat(envSection), /ReadWritePaths/);
    assert.match(flat(envSection), /documents-data/);
  });

  it("§9 cites the demo script and the guard; apps/api/package.json registers demo:seed-documents", () => {
    assert.equal(apiPackage.scripts["demo:seed-documents"], "node --env-file-if-exists=../../.env --import tsx src/scripts/seed-documents-demo.ts");
    assert.match(flat(seedSection), /demo:seed-documents -- --dry-run/);
    assert.match(flat(seedSection), /demo:seed-documents -- --apply/);
    assert.match(flat(seedSection), /demo:seed-documents -- --purge --apply/);
    assert.match(flat(seedSection), /assertDemoTarget/);
    assert.match(flat(seedSection), /--allow-real --confirm/);
  });

  it("the seed calls assertDemoTarget( with an explicit env from the flags and never reads process.env", () => {
    assert.match(seedSource, /assertDemoTarget\(/);
    assert.match(seedSource, /guardEnvFromFlags\(flags\)/);
    for (const [name, source] of [["seed", seedSource], ["dataset", datasetSource]]) {
      assert.doesNotMatch(source, /process\.env/, `${name} must not read process.env (env census)`);
    }
    assert.match(datasetSource, /import \{ evaluateDemoTarget, type DemoGuardEnv, type PlannedWrite \} from "..\/..\/..\/..\/packages\/database\/prisma\/lib\/demo-guard\.js"/);
  });

  it("seed, dataset and runbook never mention the real organisation (name or id) and the demo marker matches", () => {
    for (const [name, source] of [["seed", seedSource], ["dataset", datasetSource], ["runbook", runbook]]) {
      assert.doesNotMatch(source, REAL_ORG_NAME, `${name} must not mention the real organisation by name`);
      assert.ok(!source.includes(REAL_ORG_ID), `${name} must not mention the real organisation id`);
    }
    const prefix = /export const DEMO_TITLE_PREFIX = "([^"]+)";/.exec(datasetSource);
    assert.ok(prefix, "dataset must export DEMO_TITLE_PREFIX");
    assert.ok(seedSection.includes(`\`${prefix[1]}\``), `§9 must name the title prefix ${prefix[1]}`);
    const emails = [...datasetSource.matchAll(/"([a-z.]+@example\.com)"/g)].map((m) => m[1]);
    assert.ok(emails.length >= 2, "dataset must declare the two demo mailboxes");
    for (const email of emails) assert.ok(seedSection.includes(`\`${email}\``), `§9 must list ${email}`);
    const password = /export const DEMO_PASSWORD = "([^"]+)";/.exec(datasetSource);
    assert.ok(password && seedSection.includes(`\`${password[1]}\``), "§9 must state the demo password");
    assert.doesNotMatch(datasetSource, /\bES\d{2}\s?\d{4}\s?\d{4}/, "dataset must not carry an IBAN-looking value");
  });
});
