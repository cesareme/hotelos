// Variables de entorno del módulo de documentos (Tanda T9 · lote T9-03). Mismo
// formato que ENV_CONTRACT en apps/api/src/lib/env.ts (patrón de
// modules/reputation/env.partial.ts): el integrador (lote T9-05b) hace spread
// de DOCUMENTS_ENV_CONTRACT en env.ts (import tras la línea 22, mergeLine en
// una sección nueva «Documentos» + la de «Schedulers» para el job de
// retención), añade "Documentos" al tipo EnvSection (env.ts:28-47) y regenera
// scripts/env-contract.json, .env.example y deploy/.env.production.example con
// node scripts/env-census.mjs --write.
//
// Decisiones:
//   · Ningún fichero de modules/documents lee estas variables directamente:
//     server.ts las lee del contrato y construye el objeto DocumentsStorageConfig
//     (storage/storage.ts) que recibe createDocumentStorage (storage/index.ts);
//     la clave de cifrado en reposo llega como fieldKeyBase64 (HOTELOS_FIELD_KEY
//     → ENCRYPTION_KEY, resuelta por el integrador, nunca aquí).
//   · Sin DOCUMENT_STORAGE_KIND el almacén es `inline` (base64 en la fila,
//     tope 2 MiB): la demo funciona sin configurar nada; `disk` exige el
//     directorio y `s3` las cinco DOCUMENT_S3_* (sin cuenta real: César la pone).
//     En PRODUCCIÓN la variable es obligatoria y `inline` no se admite (SEC-03:
//     facturas y cartas en claro en Postgres y 413 por encima de 2 MiB, contra el
//     diseño §4.2): `required: "production"` aquí + regla cruzada en lib/env.ts y
//     scripts/validate-env.mjs; deploy/.env.production.example lleva `disk` con
//     /var/lib/anfitorio/documents (productionExample).
//   · DOCUMENT_MAX_BYTES limita cada fichero (25 MiB) y DOCUMENT_UPLOAD_BODY_LIMIT
//     el cuerpo JSON base64 de las rutas de subida (40 MiB, bodyLimit de Fastify).

import type { EnvSection, EnvVarSpec } from "../../lib/env.js";

/** Sección nueva que T9-05b añade a EnvSection; hasta entonces el tipo local la admite. */
export const DOCUMENTS_ENV_SECTION = "Documentos" as const;

export type DocumentsEnvSection = EnvSection | typeof DOCUMENTS_ENV_SECTION;
export type DocumentsEnvVarSpec = Omit<EnvVarSpec, "section"> & { section: DocumentsEnvSection };
export type DocumentsEnvContract = Readonly<Record<string, DocumentsEnvVarSpec>>;

export const DOCUMENT_STORAGE_KINDS = Object.freeze(["inline", "disk", "s3"] as const);

export const DOCUMENTS_ENV_CONTRACT: DocumentsEnvContract = Object.freeze({
  DOCUMENT_STORAGE_KIND: {
    section: DOCUMENTS_ENV_SECTION,
    required: "production",
    format: "enum",
    values: DOCUMENT_STORAGE_KINDS,
    default: "inline",
    example: "inline",
    productionExample: "disk",
    doc: "Almacén de los documentos capturados: inline (base64 en la fila, tope 2 MiB, SOLO demo / desarrollo: en producción no se admite), disk (ficheros bajo DOCUMENT_STORAGE_DIR, cifrados en reposo) o s3 (endpoint compatible S3 con firma SigV4 propia, sin SDK)."
  },
  DOCUMENT_STORAGE_DIR: {
    section: DOCUMENTS_ENV_SECTION,
    required: { when: "DOCUMENT_STORAGE_KIND=disk" },
    format: "path",
    // Sin `example` en desarrollo (como los demás `format: "path"` del contrato: la
    // clave queda comentada en .env.example); en el ejemplo de producción va activa con
    // la ruta del VPS (compose: volumen documents-data; systemd: ReadWritePaths), donde
    // validate-env solo avisa si la ruta no existe en el host (role production-compose).
    productionExample: "/var/lib/anfitorio/documents",
    doc: "Directorio raíz del almacén en disco (DOCUMENT_STORAGE_KIND=disk). En compose es el volumen documents-data:/var/lib/anfitorio/documents montado en api e incluido en el backup."
  },
  DOCUMENT_S3_ENDPOINT: {
    section: DOCUMENTS_ENV_SECTION,
    required: { when: "DOCUMENT_STORAGE_KIND=s3" },
    format: "url",
    origin: true,
    httpsInProduction: true,
    doc: "Origen del endpoint compatible S3 (path-style: <endpoint>/<bucket>/<clave>); región europea para evitar la comunicación del art. 22 RD 1619/2012.",
    example: "https://s3.eu-central-1.example"
  },
  DOCUMENT_S3_REGION: {
    section: DOCUMENTS_ENV_SECTION,
    required: { when: "DOCUMENT_STORAGE_KIND=s3" },
    format: "string",
    doc: "Región de la firma SigV4 del endpoint S3 (p. ej. eu-central-1).",
    example: "eu-central-1"
  },
  DOCUMENT_S3_BUCKET: {
    section: DOCUMENTS_ENV_SECTION,
    required: { when: "DOCUMENT_STORAGE_KIND=s3" },
    format: "string",
    pattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
    doc: "Bucket de los documentos (privado; sin URLs firmadas públicas: el API sirve los ficheros).",
    example: "ehotelos-documentos"
  },
  DOCUMENT_S3_ACCESS_KEY_ID: {
    section: DOCUMENTS_ENV_SECTION,
    required: { when: "DOCUMENT_STORAGE_KIND=s3" },
    format: "string",
    doc: "Id de la clave de acceso del bucket de documentos."
  },
  DOCUMENT_S3_SECRET_ACCESS_KEY: {
    section: DOCUMENTS_ENV_SECTION,
    required: { when: "DOCUMENT_STORAGE_KIND=s3" },
    format: "string",
    tags: ["secret"],
    doc: "Clave secreta del bucket de documentos (nunca en el repo ni en logs)."
  },
  DOCUMENT_MAX_BYTES: {
    section: DOCUMENTS_ENV_SECTION,
    format: "int",
    min: 65_536,
    max: 1_073_741_824,
    default: "26214400",
    doc: "Tamaño máximo por fichero capturado en bytes (25 MiB por defecto); el almacén inline aplica además su tope de 2 MiB."
  },
  DOCUMENT_UPLOAD_BODY_LIMIT: {
    section: DOCUMENTS_ENV_SECTION,
    format: "int",
    min: 131_072,
    max: 2_147_483_647,
    default: "41943040",
    doc: "bodyLimit de Fastify en las rutas de subida de documentos (JSON base64 ≈ 4/3 del fichero): 40 MiB por defecto."
  },
  DOCUMENT_ENCRYPT_AT_REST: {
    section: DOCUMENTS_ENV_SECTION,
    format: "bool",
    default: "true",
    doc: "true cifra cada fichero del almacén en disco con AES-256-GCM y la clave de campos (HOTELOS_FIELD_KEY → ENCRYPTION_KEY); en s3 pide cifrado del proveedor (x-amz-server-side-encryption: AES256). Sin clave válida el almacén en disco no arranca."
  },
  DOCUMENT_RETENTION_JOB_DISABLED: {
    section: "Schedulers",
    format: "bool",
    default: "false",
    doc: "true desactiva el job diario de retención de documentos (bloqueo al vencer retentionUntil, purga y pseudonimización a los 12 meses). Solo actúa en el líder (RUN_SCHEDULERS)."
  }
});
