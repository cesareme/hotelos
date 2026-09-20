// Unit tests · Tanda T9 · lote T9-03 — contrato parcial de entorno del módulo
// de documentos (env.partial.ts): claves, secciones, required.when, formatos,
// defaults y etiquetas; y el censo (tests/env-contract.test.mjs →
// scripts/env-census.mjs) no debe encontrar ninguna lectura directa en
// modules/documents (ni `process.env.` ni `env.NOMBRE`, comentarios incluidos).
// Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/env-partial.test.mts
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DOCUMENTS_ENV_CONTRACT, DOCUMENTS_ENV_SECTION, DOCUMENT_STORAGE_KINDS } from "../env.partial.js";

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

describe("DOCUMENTS_ENV_CONTRACT", () => {
  it("declara exactamente las 11 variables del lote, 10 en «Documentos» y el interruptor del job en «Schedulers»", () => {
    assert.equal(DOCUMENTS_ENV_SECTION, "Documentos");
    assert.deepEqual(Object.keys(DOCUMENTS_ENV_CONTRACT).sort(), [
      "DOCUMENT_ENCRYPT_AT_REST",
      "DOCUMENT_MAX_BYTES",
      "DOCUMENT_RETENTION_JOB_DISABLED",
      "DOCUMENT_S3_ACCESS_KEY_ID",
      "DOCUMENT_S3_BUCKET",
      "DOCUMENT_S3_ENDPOINT",
      "DOCUMENT_S3_REGION",
      "DOCUMENT_S3_SECRET_ACCESS_KEY",
      "DOCUMENT_STORAGE_DIR",
      "DOCUMENT_STORAGE_KIND",
      "DOCUMENT_UPLOAD_BODY_LIMIT"
    ]);
    for (const [key, spec] of Object.entries(DOCUMENTS_ENV_CONTRACT)) {
      assert.equal(spec.section, key === "DOCUMENT_RETENTION_JOB_DISABLED" ? "Schedulers" : "Documentos", key);
      assert.equal(typeof spec.doc, "string");
      assert.ok(spec.doc.length > 20, key);
    }
  });

  it("DOCUMENT_STORAGE_KIND es enum inline|disk|s3 con default inline", () => {
    const kind = DOCUMENTS_ENV_CONTRACT.DOCUMENT_STORAGE_KIND!;
    assert.equal(kind.format, "enum");
    assert.deepEqual([...kind.values!], ["inline", "disk", "s3"]);
    assert.deepEqual([...DOCUMENT_STORAGE_KINDS], ["inline", "disk", "s3"]);
    assert.equal(kind.default, "inline");
    // SEC-03: obligatoria en producción (y `inline` rechazado por la regla cruzada de lib/env.ts / validate-env);
    // los ejemplos generados llevan inline en desarrollo y disk + /var/lib/anfitorio/documents en producción.
    assert.equal(kind.required, "production");
    assert.equal(kind.example, "inline");
    assert.equal(kind.productionExample, "disk");
    assert.equal(DOCUMENTS_ENV_CONTRACT.DOCUMENT_STORAGE_DIR!.productionExample, "/var/lib/anfitorio/documents");
    assert.equal(DOCUMENTS_ENV_CONTRACT.DOCUMENT_STORAGE_DIR!.example, undefined, "en desarrollo el directorio queda comentado");
  });

  it("required.when: el directorio solo con disk; las cinco DOCUMENT_S3_* solo con s3; el secreto etiquetado", () => {
    assert.deepEqual(DOCUMENTS_ENV_CONTRACT.DOCUMENT_STORAGE_DIR!.required, { when: "DOCUMENT_STORAGE_KIND=disk" });
    assert.equal(DOCUMENTS_ENV_CONTRACT.DOCUMENT_STORAGE_DIR!.format, "path");
    for (const key of ["DOCUMENT_S3_ENDPOINT", "DOCUMENT_S3_REGION", "DOCUMENT_S3_BUCKET", "DOCUMENT_S3_ACCESS_KEY_ID", "DOCUMENT_S3_SECRET_ACCESS_KEY"]) {
      assert.deepEqual(DOCUMENTS_ENV_CONTRACT[key]!.required, { when: "DOCUMENT_STORAGE_KIND=s3" }, key);
    }
    assert.equal(DOCUMENTS_ENV_CONTRACT.DOCUMENT_S3_ENDPOINT!.format, "url");
    assert.equal(DOCUMENTS_ENV_CONTRACT.DOCUMENT_S3_ENDPOINT!.origin, true);
    assert.equal(DOCUMENTS_ENV_CONTRACT.DOCUMENT_S3_ENDPOINT!.httpsInProduction, true);
    assert.deepEqual(DOCUMENTS_ENV_CONTRACT.DOCUMENT_S3_SECRET_ACCESS_KEY!.tags, ["secret"]);
    assert.equal(DOCUMENTS_ENV_CONTRACT.DOCUMENT_S3_ACCESS_KEY_ID!.tags, undefined);
    assert.match("ehotelos-documentos", new RegExp(DOCUMENTS_ENV_CONTRACT.DOCUMENT_S3_BUCKET!.pattern!));
    assert.doesNotMatch("Mayusculas", new RegExp(DOCUMENTS_ENV_CONTRACT.DOCUMENT_S3_BUCKET!.pattern!));
  });

  it("límites enteros y booleanos con sus defaults (25 MiB, 40 MiB, cifrado true, job activo)", () => {
    const max = DOCUMENTS_ENV_CONTRACT.DOCUMENT_MAX_BYTES!;
    assert.equal(max.format, "int");
    assert.equal(max.default, "26214400");
    assert.equal(Number(max.default), 25 * 1024 * 1024);
    const body = DOCUMENTS_ENV_CONTRACT.DOCUMENT_UPLOAD_BODY_LIMIT!;
    assert.equal(body.format, "int");
    assert.equal(body.default, "41943040");
    assert.equal(Number(body.default), 40 * 1024 * 1024);
    assert.ok(Number(body.default) > (Number(max.default) * 4) / 3, "el cuerpo base64 cabe con margen");
    const encrypt = DOCUMENTS_ENV_CONTRACT.DOCUMENT_ENCRYPT_AT_REST!;
    assert.equal(encrypt.format, "bool");
    assert.equal(encrypt.default, "true");
    const job = DOCUMENTS_ENV_CONTRACT.DOCUMENT_RETENTION_JOB_DISABLED!;
    assert.equal(job.format, "bool");
    assert.equal(job.default, "false");
    assert.equal(job.section, "Schedulers");
  });

  it("ningún fichero fuente del módulo lee el entorno directamente (patrones de scripts/env-census.mjs)", () => {
    const files = sourceFiles(MODULE_DIR);
    assert.ok(files.length >= 13, `ficheros fuente encontrados: ${files.length}`);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/process\??\.env/.test(text) || /\benv\.[A-Z]/.test(text) || /\benv\(\s*["'][A-Z]/.test(text) || /\b(?:readEnv|readFlag)\(\s*env\s*,/.test(text) || /import\.meta\.env/.test(text)) {
        offenders.push(file.slice(MODULE_DIR.length + 1));
      }
    }
    assert.deepEqual(offenders, []);
  });
});
