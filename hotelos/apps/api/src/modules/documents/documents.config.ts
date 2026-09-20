// Documentos · configuración del módulo (Tanda T9 · lote T9-05b).
//
// ÚNICO punto del módulo que resuelve las variables DOCUMENT_* y la clave de
// cifrado en reposo (HOTELOS_FIELD_KEY → ENCRYPTION_KEY). Lo hace a través del
// contrato de lib/env.ts — effectiveValue (valor real sin placeholders, o el
// default del contrato) sobre processEnvironment() — y nunca con lecturas
// directas del entorno: env-partial.test.mts exige que ningún fichero de
// modules/documents lea el entorno por su cuenta. Rutas, pipeline y job de
// retención piden getDocumentsConfig() / getDocumentStorage(); server.ts pasa
// uploadBodyLimit a registerDocumentsRoutes y expone describeDocumentStorageHealth()
// en /health.
//
//   getDocumentsConfig()            → DocumentsConfig memoizada; sin variables →
//                                     inline (base64 en la fila, tope 2 MiB). Lanza
//                                     DocumentStorageError DOCUMENT_STORAGE_CONFIG_INVALID
//                                     (500) si la combinación es inválida: disk sin
//                                     DOCUMENT_STORAGE_DIR, s3 sin alguna DOCUMENT_S3_*,
//                                     kind desconocido, booleano o entero mal formados.
//   getDocumentStorage()            → adaptador singleton (createDocumentStorage).
//   describeDocumentStorageHealth() → "unconfigured" | "inline" | "disk" | "s3" para el
//                                     /health público: NUNCA rutas, endpoints ni buckets.
//   resetDocumentsConfigForTests()  → olvida la memo y, opcionalmente, fija un entorno
//                                     alternativo (objeto plano) para las pruebas.

import { effectiveValue, processEnvironment } from "../../lib/env.js";
import { DOCUMENTS_ENV_CONTRACT, DOCUMENT_STORAGE_KINDS } from "./env.partial.js";
import { createDocumentStorage } from "./storage/index.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  DocumentStorageError,
  type DocumentStorage,
  type DocumentStorageKind,
  type DocumentsS3Config,
  type DocumentsStorageConfig
} from "./storage/storage.js";

export type DocumentsConfig = DocumentsStorageConfig & {
  /** bodyLimit de Fastify en las rutas de subida (DOCUMENT_UPLOAD_BODY_LIMIT; JSON base64 ≈ 4/3 del fichero). */
  uploadBodyLimit: number;
};

/** Valor de `dependencies.objectStorage` en /health: el tipo de almacén o «unconfigured» si la configuración no vale. */
export type DocumentStorageHealth = "unconfigured" | DocumentStorageKind;

export const DOCUMENT_STORAGE_HEALTH_VALUES: readonly DocumentStorageHealth[] = Object.freeze([
  "unconfigured",
  ...DOCUMENT_STORAGE_KINDS
]);

const S3_VARIABLES = Object.freeze([
  "DOCUMENT_S3_ENDPOINT",
  "DOCUMENT_S3_REGION",
  "DOCUMENT_S3_BUCKET",
  "DOCUMENT_S3_ACCESS_KEY_ID",
  "DOCUMENT_S3_SECRET_ACCESS_KEY"
] as const);

type DocumentsVariable = keyof typeof DOCUMENTS_ENV_CONTRACT | (typeof S3_VARIABLES)[number] | "HOTELOS_FIELD_KEY" | "ENCRYPTION_KEY";

let environmentOverride: NodeJS.ProcessEnv | null = null;
let cachedConfig: DocumentsConfig | null = null;
let cachedStorage: DocumentStorage | null = null;
let healthWarned = false;

/** Valor efectivo (sin placeholders) o el default del contrato parcial del módulo. */
function readVariable(name: DocumentsVariable): string | undefined {
  const source = environmentOverride ?? processEnvironment();
  return effectiveValue(source, name) ?? DOCUMENTS_ENV_CONTRACT[name]?.default;
}

function invalid(message: string): DocumentStorageError {
  return new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", message);
}

function parseKind(raw: string | undefined): DocumentStorageKind {
  const kind = raw ?? "inline";
  if (!(DOCUMENT_STORAGE_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`DOCUMENT_STORAGE_KIND debe ser uno de: ${DOCUMENT_STORAGE_KINDS.join(" | ")}.`);
  }
  return kind as DocumentStorageKind;
}

function parseBool(name: DocumentsVariable, raw: string | undefined): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw invalid(`${name} debe ser exactamente "true" o "false".`);
}

function parseBytes(name: DocumentsVariable, raw: string | undefined): number {
  const value = raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${name} debe ser un entero positivo (bytes).`);
  }
  return value;
}

function buildConfig(): DocumentsConfig {
  const kind = parseKind(readVariable("DOCUMENT_STORAGE_KIND"));
  const encryptAtRest = parseBool("DOCUMENT_ENCRYPT_AT_REST", readVariable("DOCUMENT_ENCRYPT_AT_REST"));
  const maxBytes = parseBytes("DOCUMENT_MAX_BYTES", readVariable("DOCUMENT_MAX_BYTES"));
  const uploadBodyLimit = parseBytes("DOCUMENT_UPLOAD_BODY_LIMIT", readVariable("DOCUMENT_UPLOAD_BODY_LIMIT"));
  // Clave de campos del tenant (AES-256-GCM): HOTELOS_FIELD_KEY manda, ENCRYPTION_KEY
  // es su alternativa documentada (lib/env.ts). Aquí solo se transporta: el adaptador
  // en disco la valida (parseFieldKey) y no arranca sin una clave válida si cifra.
  const fieldKeyBase64 = readVariable("HOTELOS_FIELD_KEY") ?? readVariable("ENCRYPTION_KEY");

  const config: DocumentsConfig = {
    kind,
    encryptAtRest,
    maxBytes,
    inlineMaxBytes: DEFAULT_INLINE_MAX_BYTES,
    uploadBodyLimit,
    ...(fieldKeyBase64 !== undefined ? { fieldKeyBase64 } : {})
  };

  if (kind === "disk") {
    const dir = readVariable("DOCUMENT_STORAGE_DIR");
    if (!dir) throw invalid("DOCUMENT_STORAGE_KIND=disk exige DOCUMENT_STORAGE_DIR (directorio raíz del almacén).");
    config.dir = dir;
  }

  if (kind === "s3") {
    const values = new Map<(typeof S3_VARIABLES)[number], string>();
    for (const name of S3_VARIABLES) {
      const value = readVariable(name);
      if (value) values.set(name, value);
    }
    const missing = S3_VARIABLES.filter((name) => !values.has(name));
    if (missing.length > 0) throw invalid(`DOCUMENT_STORAGE_KIND=s3 exige ${missing.join(", ")}.`);
    const s3: DocumentsS3Config = {
      endpoint: values.get("DOCUMENT_S3_ENDPOINT")!,
      region: values.get("DOCUMENT_S3_REGION")!,
      bucket: values.get("DOCUMENT_S3_BUCKET")!,
      accessKeyId: values.get("DOCUMENT_S3_ACCESS_KEY_ID")!,
      secretAccessKey: values.get("DOCUMENT_S3_SECRET_ACCESS_KEY")!
    };
    config.s3 = s3;
  }

  return Object.freeze(config) as DocumentsConfig;
}

/** Configuración memoizada del módulo (una lectura del contrato por proceso). */
export function getDocumentsConfig(): DocumentsConfig {
  if (!cachedConfig) cachedConfig = buildConfig();
  return cachedConfig;
}

/**
 * bodyLimit para registrar las rutas de subida sin impedir el arranque: con una
 * configuración inválida (disk sin directorio, s3 incompleto…) el API arranca
 * igualmente en desarrollo — /health dice «unconfigured» y la primera subida
 * responde 500 DOCUMENT_STORAGE_CONFIG_INVALID —, mientras que en producción el
 * contrato (required.when de lib/env.ts) ya aborta el arranque. Devuelve el
 * default del contrato (40 MiB) cuando la configuración no se puede leer.
 */
export function getDocumentsUploadBodyLimit(): number {
  try {
    return getDocumentsConfig().uploadBodyLimit;
  } catch (error) {
    const fallback = Number(DOCUMENTS_ENV_CONTRACT.DOCUMENT_UPLOAD_BODY_LIMIT?.default);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[documents] configuración del almacén inválida; las rutas de subida usan el bodyLimit por defecto (${fallback} bytes): ${reason}`);
    return fallback;
  }
}

/** Adaptador singleton del almacén (inline por defecto; disk/s3 según la configuración). */
export function getDocumentStorage(): DocumentStorage {
  if (!cachedStorage) cachedStorage = createDocumentStorage(getDocumentsConfig());
  return cachedStorage;
}

/**
 * Descripción para /health (público): el tipo de almacén que sirve el API o
 * «unconfigured» cuando la configuración no permite construir el adaptador
 * (disk sin directorio o sin clave válida cifrando, s3 incompleto, kind
 * desconocido…). Nunca lanza ni revela rutas, endpoints o buckets; el motivo
 * se escribe UNA vez en el log del proceso (los mensajes nombran variables,
 * nunca valores).
 */
export function describeDocumentStorageHealth(): DocumentStorageHealth {
  try {
    return getDocumentStorage().kind;
  } catch (error) {
    if (!healthWarned) {
      healthWarned = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[documents] almacén de documentos no configurado (objectStorage=unconfigured): ${reason}`);
    }
    return "unconfigured";
  }
}

/**
 * Test hook: olvida la configuración y el adaptador memoizados. Con `override`
 * las lecturas posteriores usan ese objeto plano en lugar del entorno del
 * proceso (un `{}` aísla la prueba de cualquier variable real); `null` o sin
 * argumento vuelve al entorno del proceso.
 */
export function resetDocumentsConfigForTests(override: NodeJS.ProcessEnv | null = null): void {
  environmentOverride = override;
  cachedConfig = null;
  cachedStorage = null;
  healthWarned = false;
}
