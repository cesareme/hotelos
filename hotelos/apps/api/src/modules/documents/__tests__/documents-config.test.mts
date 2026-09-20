// Unit tests · Tanda T9 · lote T9-05b — configuración del módulo de documentos
// (documents.config.ts): defaults del contrato (sin variables → inline 2 MiB),
// errores tipados (disk sin directorio, s3 incompleto, kind/booleano/entero
// inválidos), precedencia HOTELOS_FIELD_KEY → ENCRYPTION_KEY, placeholders,
// memoización y descripción de salud sin rutas ni endpoints. También fija que
// lib/env.ts hace spread de DOCUMENTS_ENV_CONTRACT (sección «Documentos»).
// Sin base de datos, sin red; entorno inyectado con resetDocumentsConfigForTests.
//   node --import tsx --test src/modules/documents/__tests__/documents-config.test.mts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { ENV_CONTRACT, processEnvironment } from "../../../lib/env.js";
import { DOCUMENTS_ENV_CONTRACT } from "../env.partial.js";
import {
  DOCUMENT_STORAGE_HEALTH_VALUES,
  describeDocumentStorageHealth,
  getDocumentStorage,
  getDocumentsConfig,
  getDocumentsUploadBodyLimit,
  resetDocumentsConfigForTests
} from "../documents.config.js";
import { DiskDocumentStorage } from "../storage/disk-storage.js";
import { DEFAULT_INLINE_MAX_BYTES, DocumentStorageError } from "../storage/storage.js";

const FIELD_KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const S3_ENV = {
  DOCUMENT_STORAGE_KIND: "s3",
  DOCUMENT_S3_ENDPOINT: "https://s3.eu-central-1.example",
  DOCUMENT_S3_REGION: "eu-central-1",
  DOCUMENT_S3_BUCKET: "ehotelos-documentos-test",
  DOCUMENT_S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  DOCUMENT_S3_SECRET_ACCESS_KEY: "secreto-de-prueba-que-nunca-debe-salir"
};
const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ehotelos-docs-config-"));
  dirs.push(dir);
  return dir;
}

function configError(run: () => unknown): DocumentStorageError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DocumentStorageError, `esperaba DocumentStorageError, llegó ${String(error)}`);
    return error;
  }
  assert.fail("no lanzó");
}

/** Captura console.warn mientras dura `run` (la salud avisa una sola vez por proceso). */
function captureWarnings<T>(run: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = original;
  }
}

afterEach(() => resetDocumentsConfigForTests());
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("lib/env.ts · spread del contrato parcial de documentos", () => {
  it("ENV_CONTRACT contiene las 11 variables del módulo con su sección y defaults", () => {
    for (const [name, spec] of Object.entries(DOCUMENTS_ENV_CONTRACT)) {
      const merged = ENV_CONTRACT[name];
      assert.ok(merged, `${name} no está en ENV_CONTRACT (falta el spread de DOCUMENTS_ENV_CONTRACT en lib/env.ts)`);
      assert.equal(merged.section, spec.section, name);
      assert.equal(merged.default, spec.default, name);
    }
    assert.equal(ENV_CONTRACT.DOCUMENT_STORAGE_KIND!.section, "Documentos");
    assert.equal(ENV_CONTRACT.DOCUMENT_RETENTION_JOB_DISABLED!.section, "Schedulers");
  });

  it("processEnvironment() es el entorno vivo del proceso", () => {
    assert.equal(processEnvironment(), process.env);
  });
});

describe("getDocumentsConfig · defaults", () => {
  it("sin variables → inline con tope 2 MiB y los defaults del contrato (25 MiB, 40 MiB, cifrado true)", () => {
    resetDocumentsConfigForTests({});
    const config = getDocumentsConfig();
    assert.equal(config.kind, "inline");
    assert.equal(config.inlineMaxBytes, DEFAULT_INLINE_MAX_BYTES);
    assert.equal(config.inlineMaxBytes, 2 * 1024 * 1024);
    assert.equal(config.maxBytes, Number(DOCUMENTS_ENV_CONTRACT.DOCUMENT_MAX_BYTES!.default));
    assert.equal(config.maxBytes, 25 * 1024 * 1024);
    assert.equal(config.uploadBodyLimit, Number(DOCUMENTS_ENV_CONTRACT.DOCUMENT_UPLOAD_BODY_LIMIT!.default));
    assert.equal(config.uploadBodyLimit, 40 * 1024 * 1024);
    assert.equal(config.encryptAtRest, true);
    assert.equal(config.dir, undefined);
    assert.equal(config.s3, undefined);
    assert.equal(config.fieldKeyBase64, undefined);
    assert.ok(Object.isFrozen(config));
    assert.equal(getDocumentStorage().kind, "inline");
    assert.equal(describeDocumentStorageHealth(), "inline");
  });

  it("memoiza la configuración y el adaptador hasta el reset", () => {
    resetDocumentsConfigForTests({});
    const first = getDocumentsConfig();
    const store = getDocumentStorage();
    assert.equal(getDocumentsConfig(), first);
    assert.equal(getDocumentStorage(), store);
    resetDocumentsConfigForTests({ DOCUMENT_MAX_BYTES: "1048576" });
    assert.notEqual(getDocumentsConfig(), first);
    assert.equal(getDocumentsConfig().maxBytes, 1_048_576);
    assert.notEqual(getDocumentStorage(), store);
  });

  it("los placeholders del contrato cuentan como ausentes (kind «change-me» → inline; clave «change-me» → sin clave)", () => {
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "change-me", ENCRYPTION_KEY: "change-me", HOTELOS_FIELD_KEY: "" });
    const config = getDocumentsConfig();
    assert.equal(config.kind, "inline");
    assert.equal(config.fieldKeyBase64, undefined);
  });

  it("sin override lee el entorno del proceso (la instancia de pruebas no fija DOCUMENT_*)", () => {
    resetDocumentsConfigForTests();
    const config = getDocumentsConfig();
    assert.ok(["inline", "disk", "s3"].includes(config.kind));
    assert.ok(DOCUMENT_STORAGE_HEALTH_VALUES.includes(describeDocumentStorageHealth()));
  });
});

describe("getDocumentsConfig · disk", () => {
  it("disk sin DOCUMENT_STORAGE_DIR → DOCUMENT_STORAGE_CONFIG_INVALID (500) y salud «unconfigured» avisando una sola vez", () => {
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "disk", HOTELOS_FIELD_KEY: FIELD_KEY });
    const error = configError(() => getDocumentsConfig());
    assert.equal(error.code, "DOCUMENT_STORAGE_CONFIG_INVALID");
    assert.equal(error.statusCode, 500);
    assert.match(error.message, /DOCUMENT_STORAGE_DIR/);
    assert.equal((error.details as { code: string }).code, "DOCUMENT_STORAGE_CONFIG_INVALID");
    const { result, warnings } = captureWarnings(() => [describeDocumentStorageHealth(), describeDocumentStorageHealth()]);
    assert.deepEqual(result, ["unconfigured", "unconfigured"]);
    assert.equal(warnings.length, 1, "un único aviso por proceso");
    assert.match(warnings[0]!, /objectStorage=unconfigured/);
  });

  it("disk con directorio y HOTELOS_FIELD_KEY → «disk» cifrando; HOTELOS_FIELD_KEY manda sobre ENCRYPTION_KEY", () => {
    const dir = tmp();
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_STORAGE_DIR: dir, HOTELOS_FIELD_KEY: FIELD_KEY, ENCRYPTION_KEY: OTHER_KEY });
    const config = getDocumentsConfig();
    assert.equal(config.kind, "disk");
    assert.equal(config.dir, dir);
    assert.equal(config.fieldKeyBase64, FIELD_KEY);
    assert.equal(config.encryptAtRest, true);
    const store = getDocumentStorage();
    assert.ok(store instanceof DiskDocumentStorage);
    assert.equal(store.encrypts, true);
    assert.equal(describeDocumentStorageHealth(), "disk");
  });

  it("disk con solo ENCRYPTION_KEY usa esa clave como alternativa", () => {
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_STORAGE_DIR: tmp(), ENCRYPTION_KEY: OTHER_KEY });
    assert.equal(getDocumentsConfig().fieldKeyBase64, OTHER_KEY);
    assert.equal(describeDocumentStorageHealth(), "disk");
  });

  it("disk cifrando sin clave válida: la configuración se lee, el adaptador no arranca (KEY_MALFORMED) y la salud es «unconfigured»", () => {
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_STORAGE_DIR: tmp() });
    assert.equal(getDocumentsConfig().kind, "disk");
    const error = configError(() => getDocumentStorage());
    assert.equal(error.code, "DOCUMENT_STORAGE_KEY_MALFORMED");
    assert.equal(captureWarnings(() => describeDocumentStorageHealth()).result, "unconfigured");
  });

  it("disk con DOCUMENT_ENCRYPT_AT_REST=false no necesita clave", () => {
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_STORAGE_DIR: tmp(), DOCUMENT_ENCRYPT_AT_REST: "false" });
    const config = getDocumentsConfig();
    assert.equal(config.encryptAtRest, false);
    const store = getDocumentStorage() as DiskDocumentStorage;
    assert.equal(store.encrypts, false);
    assert.equal(describeDocumentStorageHealth(), "disk");
  });
});

describe("getDocumentsConfig · s3", () => {
  it("s3 exige las cinco DOCUMENT_S3_*: el error nombra exactamente las que faltan y nunca valores", () => {
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "s3", DOCUMENT_S3_ENDPOINT: S3_ENV.DOCUMENT_S3_ENDPOINT, DOCUMENT_S3_BUCKET: S3_ENV.DOCUMENT_S3_BUCKET });
    const error = configError(() => getDocumentsConfig());
    assert.equal(error.code, "DOCUMENT_STORAGE_CONFIG_INVALID");
    assert.match(error.message, /DOCUMENT_S3_REGION, DOCUMENT_S3_ACCESS_KEY_ID, DOCUMENT_S3_SECRET_ACCESS_KEY/);
    assert.doesNotMatch(error.message, /DOCUMENT_S3_ENDPOINT|DOCUMENT_S3_BUCKET/);
    assert.doesNotMatch(error.message, /example|ehotelos-documentos/);
    assert.equal(captureWarnings(() => describeDocumentStorageHealth()).result, "unconfigured");
  });

  it("s3 completo → «s3» con la configuración del bucket y el cifrado delegado al proveedor", () => {
    resetDocumentsConfigForTests({ ...S3_ENV });
    const config = getDocumentsConfig();
    assert.equal(config.kind, "s3");
    assert.deepEqual(config.s3, {
      endpoint: S3_ENV.DOCUMENT_S3_ENDPOINT,
      region: S3_ENV.DOCUMENT_S3_REGION,
      bucket: S3_ENV.DOCUMENT_S3_BUCKET,
      accessKeyId: S3_ENV.DOCUMENT_S3_ACCESS_KEY_ID,
      secretAccessKey: S3_ENV.DOCUMENT_S3_SECRET_ACCESS_KEY
    });
    assert.equal(config.encryptAtRest, true);
    assert.equal(getDocumentStorage().kind, "s3");
    assert.equal(describeDocumentStorageHealth(), "s3");
  });
});

describe("getDocumentsConfig · valores inválidos (errores tipados, nunca silenciosos)", () => {
  it("kind desconocido", () => {
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "gcs" });
    const error = configError(() => getDocumentsConfig());
    assert.equal(error.code, "DOCUMENT_STORAGE_CONFIG_INVALID");
    assert.match(error.message, /inline \| disk \| s3/);
  });

  it("booleano que no es exactamente true|false", () => {
    for (const value of ["1", "yes", "TRUE"]) {
      resetDocumentsConfigForTests({ DOCUMENT_ENCRYPT_AT_REST: value });
      const error = configError(() => getDocumentsConfig());
      assert.match(error.message, /DOCUMENT_ENCRYPT_AT_REST/, value);
    }
  });

  it("enteros no positivos, con unidades o con separadores (los espacios exteriores los recorta el contrato y sí valen)", () => {
    for (const [name, value] of [
      ["DOCUMENT_MAX_BYTES", "10MB"],
      ["DOCUMENT_MAX_BYTES", "0"],
      ["DOCUMENT_MAX_BYTES", "-1"],
      ["DOCUMENT_UPLOAD_BODY_LIMIT", "1.5"],
      ["DOCUMENT_UPLOAD_BODY_LIMIT", "4 096"]
    ] as const) {
      resetDocumentsConfigForTests({ [name]: value });
      const error = configError(() => getDocumentsConfig());
      assert.equal(error.code, "DOCUMENT_STORAGE_CONFIG_INVALID");
      assert.match(error.message, new RegExp(name), `${name}=${value}`);
    }
  });
});

describe("getDocumentsUploadBodyLimit · nunca impide el arranque", () => {
  it("devuelve el valor configurado y, con configuración inválida, el default del contrato (40 MiB) avisando", () => {
    resetDocumentsConfigForTests({ DOCUMENT_UPLOAD_BODY_LIMIT: "8388608" });
    assert.equal(getDocumentsUploadBodyLimit(), 8_388_608);
    resetDocumentsConfigForTests({ DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_UPLOAD_BODY_LIMIT: "8388608" });
    const { result, warnings } = captureWarnings(() => getDocumentsUploadBodyLimit());
    assert.equal(result, 40 * 1024 * 1024);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /DOCUMENT_STORAGE_DIR/);
    assert.equal(captureWarnings(() => describeDocumentStorageHealth()).result, "unconfigured");
  });
});

describe("describeDocumentStorageHealth · público", () => {
  it("solo devuelve unconfigured|inline|disk|s3 y nunca contiene «/» ni «http», con directorio y endpoint configurados", () => {
    const matrix: NodeJS.ProcessEnv[] = [
      {},
      { DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_STORAGE_DIR: "/var/lib/anfitorio/documents", DOCUMENT_ENCRYPT_AT_REST: "false" },
      { DOCUMENT_STORAGE_KIND: "disk", DOCUMENT_STORAGE_DIR: tmp(), HOTELOS_FIELD_KEY: FIELD_KEY },
      { DOCUMENT_STORAGE_KIND: "disk" },
      { ...S3_ENV },
      { DOCUMENT_STORAGE_KIND: "s3", DOCUMENT_S3_ENDPOINT: "http://minio.local:9000" },
      { DOCUMENT_STORAGE_KIND: "ftp" }
    ];
    const seen = new Set<string>();
    for (const env of matrix) {
      resetDocumentsConfigForTests(env);
      const health = captureWarnings(() => describeDocumentStorageHealth()).result;
      assert.ok(DOCUMENT_STORAGE_HEALTH_VALUES.includes(health), `${health} fuera del catálogo`);
      assert.doesNotMatch(health, /[/]|http/i);
      seen.add(health);
    }
    assert.deepEqual([...seen].sort(), ["disk", "inline", "s3", "unconfigured"]);
  });
});
