// Almacén de firmas del check-in (Tanda CHK · W2-B). Contrato mínimo
// `SignatureStorage { put, get }` con una única implementación local:
// `dataUriSignatureStorage`, que devuelve como `objectKey` la propia
// `data:` URI (mismo patrón que los adjuntos de payables/supplier-bills
// .service.ts:59-61: no existe almacén de objetos en el API). La clave lógica
// (`org/<org>/prop/<prop>/checkin/<sesión>/signature-<viajero>.png`) se
// valida pero no se persiste: cuando exista el almacén real, `objectKey`
// pasará a ser esa clave.
//
// Punto de extensión T9: sustituir por documents/storage/* (almacén de
// documentos general) implementando esta misma interfaz; signature.service.ts
// solo conoce `SignatureStorage`.
//
// El almacén solo admite la firma (PNG o SVG) y el PDF del parte de entrada,
// con límite de tamaño y prefijo de clave: cualquier otro `image/*` u otro
// tipo se rechaza (nunca es un almacén de imágenes de documentos de
// identidad, que no se persisten: diseño §1.3 / §7.3).

import { BadRequestError, HttpError } from "../../lib/http-error.js";
import { CHECKIN_CONFIG_DEFAULTS, readCheckInConfig } from "./checkin-config.js";

export const SIGNATURE_IMAGE_MIME_TYPES = ["image/png", "image/svg+xml"] as const;
export const SIGNATURE_STORAGE_MIME_TYPES = [...SIGNATURE_IMAGE_MIME_TYPES, "application/pdf"] as const;
export type SignatureStorageMime = (typeof SIGNATURE_STORAGE_MIME_TYPES)[number];

/** Prefijo obligatorio de toda clave del almacén de firmas. */
export const SIGNATURE_KEY_PATTERN = /^org\/[A-Za-z0-9_.-]+\/prop\/[A-Za-z0-9_.-]+\/checkin\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.(png|svg|pdf)$/;

/** Tamaño máximo del PNG/SVG de la firma (bytes decodificados) del contrato: 512 KiB; CHECKIN_SIGNATURE_MAX_BYTES lo ajusta. */
export const DEFAULT_SIGNATURE_MAX_BYTES = CHECKIN_CONFIG_DEFAULTS.signatureMaxBytes;
/** Tamaño máximo del PDF del parte de entrada (texto sin comprimir, una página). */
export const ENTRY_FORM_PDF_MAX_BYTES = 2 * 1024 * 1024;

/** Límite vigente de la firma en bytes (checkin-config.ts, W2-A: única lectura de CHECKIN_*). */
export function signatureMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readCheckInConfig(env).signatureMaxBytes;
}

export type StoredObject = { bytes: Buffer; mime: SignatureStorageMime };

export interface SignatureStorage {
  /** Guarda los bytes bajo la clave lógica y devuelve la clave del objeto persistido. */
  put(key: string, bytes: Uint8Array, mime: SignatureStorageMime): Promise<{ objectKey: string }>;
  /** Recupera un objeto por su clave; null si no existe (o la clave no es de este almacén). */
  get(objectKey: string): Promise<StoredObject | null>;
}

function isAllowedMime(mime: string): mime is SignatureStorageMime {
  return (SIGNATURE_STORAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/** Valida clave, tipo y tamaño antes de guardar (común a cualquier implementación). */
export function assertSignatureObject(key: string, bytes: Uint8Array, mime: string, options: { maxImageBytes?: number } = {}): asserts mime is SignatureStorageMime {
  if (!SIGNATURE_KEY_PATTERN.test(key)) {
    throw new BadRequestError("Clave de firma no válida: se espera org/<org>/prop/<prop>/checkin/<sesión>/<fichero>.(png|svg|pdf).");
  }
  if (!isAllowedMime(mime)) {
    throw new BadRequestError(`Tipo no admitido en el almacén de firmas: ${mime}. Solo image/png, image/svg+xml o application/pdf.`);
  }
  if (bytes.length === 0) throw new BadRequestError("La firma está vacía.");
  const extension = key.slice(key.lastIndexOf(".") + 1);
  const expected = mime === "image/png" ? "png" : mime === "image/svg+xml" ? "svg" : "pdf";
  if (extension !== expected) throw new BadRequestError(`La extensión de la clave (${extension}) no coincide con el tipo ${mime}.`);
  const limit = mime === "application/pdf" ? ENTRY_FORM_PDF_MAX_BYTES : (options.maxImageBytes ?? signatureMaxBytes());
  if (bytes.length > limit) {
    throw new HttpError(413, `La firma supera el tamaño máximo (${bytes.length} > ${limit} bytes).`, true, { code: "SIGNATURE_TOO_LARGE", maxBytes: limit });
  }
}

/**
 * Implementación local: `objectKey` = `data:<mime>;base64,…`. No hay copia en
 * disco ni en red; el objeto vive en la fila `signatures` (objectKey /
 * pdfObjectKey). Punto de extensión T9: documents/storage/*.
 */
export const dataUriSignatureStorage: SignatureStorage = {
  async put(key, bytes, mime) {
    assertSignatureObject(key, bytes, mime);
    return { objectKey: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` };
  },
  async get(objectKey) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(objectKey ?? "");
    if (!match || !isAllowedMime(match[1]!)) return null;
    return { bytes: Buffer.from(match[2]!, "base64"), mime: match[1] as SignatureStorageMime };
  }
};

let current: SignatureStorage = dataUriSignatureStorage;

/** Almacén activo (data-URI hasta que T9 aporte el de documentos). */
export function getSignatureStorage(): SignatureStorage {
  return current;
}

/** Sustituye el almacén (tests, o el adaptador T9 al arrancar); sin argumento restaura el local. */
export function setSignatureStorage(storage?: SignatureStorage): void {
  current = storage ?? dataUriSignatureStorage;
}
