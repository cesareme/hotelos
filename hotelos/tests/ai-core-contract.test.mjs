// Contrato del núcleo de IA (Tanda L6a): el shim lib/llm.ts delega en
// @hotelos/ai-core sin proveedores directos, el paquete no lee entorno ni Prisma,
// los modelos por defecto son los decididos (sonnet-5 / haiku-4.5 / opus-5, nunca
// fable), las variables AI_* nuevas están en los examples y no queda rastro del
// ai-gateway retirado. Regex sobre ficheros, como tests/ai-safety-matrix.test.mjs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo", ".git"]);
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|md|sh|txt|example|Dockerfile)$|^Dockerfile\./;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (stats.isFile()) out.push(full);
  }
  return out;
}
const rel = (file) => relative(ROOT, file).split(sep).join("/");
const sourceFiles = (dir, { excludeTests = false } = {}) =>
  walk(join(ROOT, dir)).filter((file) => /\.[cm]?ts$/.test(file) && (!excludeTests || !file.includes("__tests__")));

describe("AI core contract (Tanda L6a)", () => {
  it("lib/llm.ts is a thin shim over @hotelos/ai-core without direct provider calls", () => {
    const llm = read("apps/api/src/lib/llm.ts");
    assert.doesNotMatch(llm, /api\.anthropic\.com|api\.openai\.com/);
    assert.match(llm, /from "@hotelos\/ai-core"/);
    for (const name of ["isLlmConfigured", "llmProviderName", "llmModelName", "llmComplete", "llmExtractDocument", "llmExtractJsonFromImage", "llmExtractJsonFromDocument", "llmStructured", "llmClassify"]) {
      assert.match(llm, new RegExp(`export (?:async )?function ${name}\\b`), `llm.ts sin export ${name}`);
    }
    // Corrección 1 (WT-10): tope con margen; el shim mide ~150 líneas tras context_required y la telemetría de invalid_output.
    assert.ok(llm.split("\n").length <= 160, "llm.ts debe seguir siendo un envoltorio fino (≤ 160 líneas)");
    // CFC-06 / SEC-01: sin organización no se llama al modelo (ningún cubo `unscoped` compartido entre organizaciones).
    assert.doesNotMatch(llm, /"unscoped"/);
    assert.match(llm, /context_required/);
  });

  it("controls reasoning per model and never sends inference_geo to Haiku 4.5 (corrección 1 · CFC-01 / CFC-03)", () => {
    const messages = read("packages/ai-core/src/messages.ts");
    assert.match(messages, /export function resolveReasoning\(/);
    assert.match(messages, /thinking: reasoning\.thinking/);
    assert.match(messages, /caps\.inferenceGeo \? \(opts\.inferenceGeo \?\? config\.inferenceGeo\) : undefined/);
    const capabilities = read("packages/ai-core/src/capabilities.ts");
    assert.match(capabilities, /prefix: "claude-haiku-4-5", capabilities: \{[^}]*inferenceGeo: false/);
    assert.match(capabilities, /prefix: "claude-sonnet-5", capabilities: \{[^}]*thinking: "adaptive"/);
  });

  it("packages/ai-core never reads the environment nor the database", () => {
    const files = sourceFiles("packages/ai-core/src", { excludeTests: true });
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /process\.env/, `${rel(file)} lee process.env`);
      assert.doesNotMatch(source, /@hotelos\/database|@prisma\/client/, `${rel(file)} importa la base de datos`);
    }
  });

  it("the pricing table is dated and the API configuration is the only AI_* reader", () => {
    assert.match(read("packages/ai-core/src/pricing.ts"), /PRICING_TABLE_DATE = "\d{4}-\d{2}-\d{2}"/);
    const readers = sourceFiles("apps/api/src", { excludeTests: true }).filter((file) => /process\.env\.AI_|\benv\.AI_/.test(readFileSync(file, "utf8")));
    assert.deepEqual(readers.map(rel), ["apps/api/src/lib/ai-config.ts"]);
  });

  it("uses the decided models and never a fable model", () => {
    const env = read("apps/api/src/lib/env.ts");
    assert.match(env, /claude-sonnet-5/);
    assert.doesNotMatch(env, /claude-3-5-sonnet-latest/);
    const config = read("packages/ai-core/src/config.ts");
    assert.match(config, /claude-haiku-4-5-20251001/);
    assert.match(config, /claude-opus-5/);
    const offenders = [...sourceFiles("apps/api/src"), ...walk(join(ROOT, "packages")).filter((f) => /\/src\/.*\.[cm]?ts$/.test(f))]
      .filter((file) => /claude-fable-5-1/.test(readFileSync(file, "utf8")))
      .map(rel);
    assert.deepEqual(offenders, [], "ningún fichero puede fijar el modelo fable (retención 30 días)");
  });

  it("declares the new AI_* variables in both example files", () => {
    for (const path of [".env.example", "deploy/.env.production.example"]) {
      const example = read(path);
      for (const key of ["AI_MODEL_CLASSIFY", "AI_MODEL_INSIGHTS", "AI_MONTHLY_BUDGET_EUR_DEFAULT", "AI_RATE_LIMIT_PER_MINUTE", "AI_USD_EUR_RATE"]) {
        assert.match(example, new RegExp(`^#? ?${key}=`, "m"), `${path} no declara ${key}`);
      }
    }
  });

  it("leaves no trace of the retired ai-gateway", () => {
    // Únicas menciones legítimas: la lista RETIRED_KEYS que impide que las variables
    // vuelvan (validate-env) y este mismo test, que contiene la expresión.
    const allowed = new Set(["scripts/validate-env.mjs", "tests/ai-core-contract.test.mjs"]);
    const roots = ["apps", "packages", "scripts", "tests", "deploy"].flatMap((dir) => walk(join(ROOT, dir)));
    const files = [...roots, join(ROOT, "package.json"), join(ROOT, "tsconfig.base.json")].filter((file) => TEXT_EXT.test(file) || /Dockerfile/.test(file));
    const offenders = files.filter((file) => !allowed.has(rel(file)) && /ai-gateway|AI_GATEWAY|aiGateway/.test(readFileSync(file, "utf8"))).map(rel);
    assert.deepEqual(offenders, []);
    const retired = read("scripts/validate-env.mjs");
    for (const key of ["AI_GATEWAY_MODE", "AI_GATEWAY_URL", "API_BASE_URL", "OCR_PROVIDER_API_KEY", "SPEECH_PROVIDER_API_KEY"]) {
      assert.match(retired, new RegExp(`"${key}"`), `RETIRED_KEYS sin ${key}`);
    }
  });
});
