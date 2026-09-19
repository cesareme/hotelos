// Unit tests · Tanda T8 · lote T8-C — contrato parcial de entorno del módulo
// (env.partial.ts): claves y secciones exactas, formatos, defaults y etiquetas;
// y el censo (tests/env-contract.test.mjs → scripts/env-census.mjs) no debe
// encontrar ninguna lectura directa en modules/reputation: ni `process.env.`
// ni `env.NOMBRE` en ningún fichero fuente del módulo (comentarios incluidos).
// Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/env-partial.test.mts
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { REPUTATION_ENV_CONTRACT } from "../env.partial.js";

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "__tests__") out.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|mts)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("REPUTATION_ENV_CONTRACT", () => {
  it("declara exactamente las 6 variables del lote, en sus secciones", () => {
    assert.deepEqual(Object.keys(REPUTATION_ENV_CONTRACT).sort(), [
      "GOOGLE_BUSINESS_CLIENT_ID",
      "GOOGLE_BUSINESS_CLIENT_SECRET",
      "GOOGLE_BUSINESS_REDIRECT_URI",
      "REPUTATION_SYNC_DISABLED",
      "REPUTATION_SYNC_INTERVAL_MS",
      "REPUTATION_SYNC_RUN_AT_BOOT"
    ]);
    for (const key of ["REPUTATION_SYNC_DISABLED", "REPUTATION_SYNC_INTERVAL_MS", "REPUTATION_SYNC_RUN_AT_BOOT"]) {
      assert.equal(REPUTATION_ENV_CONTRACT[key]!.section, "Schedulers", key);
    }
    for (const key of ["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET", "GOOGLE_BUSINESS_REDIRECT_URI"]) {
      assert.equal(REPUTATION_ENV_CONTRACT[key]!.section, "OTA", key);
      assert.equal(REPUTATION_ENV_CONTRACT[key]!.severity, "warn", key);
      assert.match(REPUTATION_ENV_CONTRACT[key]!.doc, /Google Business Profile: OAuth business\.manage; sin ellas la fuente queda unavailable/, key);
    }
  });

  it("formatos, defaults y límites del job; el secreto de Google lleva la etiqueta secret y la URI es url", () => {
    const disabled = REPUTATION_ENV_CONTRACT.REPUTATION_SYNC_DISABLED!;
    assert.equal(disabled.format, "bool");
    assert.equal(disabled.default, "false");
    const interval = REPUTATION_ENV_CONTRACT.REPUTATION_SYNC_INTERVAL_MS!;
    assert.equal(interval.format, "int");
    assert.equal(interval.min, 60_000);
    assert.equal(interval.max, 604_800_000);
    assert.equal(interval.default, "86400000");
    const runAtBoot = REPUTATION_ENV_CONTRACT.REPUTATION_SYNC_RUN_AT_BOOT!;
    assert.equal(runAtBoot.format, "bool");
    assert.equal(runAtBoot.default, "true");
    assert.equal(REPUTATION_ENV_CONTRACT.GOOGLE_BUSINESS_CLIENT_ID!.format, "string");
    assert.deepEqual(REPUTATION_ENV_CONTRACT.GOOGLE_BUSINESS_CLIENT_SECRET!.tags, ["secret"]);
    assert.equal(REPUTATION_ENV_CONTRACT.GOOGLE_BUSINESS_REDIRECT_URI!.format, "url");
    for (const spec of Object.values(REPUTATION_ENV_CONTRACT)) {
      assert.equal(typeof spec.doc, "string");
      assert.ok(spec.doc.length > 20);
      assert.equal(spec.required, undefined);
    }
  });

  it("ningún fichero fuente del módulo lee el entorno directamente (patrones de scripts/env-census.mjs)", () => {
    const files = sourceFiles(MODULE_DIR);
    assert.ok(files.length >= 20, `ficheros fuente encontrados: ${files.length}`);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/process\??\.env/.test(text) || /\benv\.[A-Z]/.test(text) || /\benv\(\s*["'][A-Z]/.test(text) || /\b(?:readEnv|readFlag)\(\s*env\s*,/.test(text)) {
        offenders.push(file.slice(MODULE_DIR.length + 1));
      }
    }
    assert.deepEqual(offenders, []);
  });
});
