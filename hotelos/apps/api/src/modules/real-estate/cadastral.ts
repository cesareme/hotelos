// Referencia catastral (Tanda ACT · L0a, diseño §4 `RealEstateUnit.cadastralReference`).
// Puro: sin Prisma ni Fastify. La referencia catastral española tiene 20
// caracteres alfanuméricos (14 de finca + 4 de cargo + 2 de control); aquí solo
// se valida la FORMA (`^[0-9A-Z]{20}$`) tras normalizar (mayúsculas, sin
// espacios). Los dígitos de control no se verifican: el dato lo teclea la
// administración desde la certificación catastral y no hay consulta externa
// (decisión del brief: sin Catastro externo).

import { realEstateError } from "./errors.js";

export const CADASTRAL_REFERENCE_LENGTH = 20;
export const CADASTRAL_REFERENCE_RE = /^[0-9A-Z]{20}$/;

/** Mayúsculas y sin espacios (los catastrales se imprimen como «9872023 VH5797S 0001 WX»). No quita guiones ni otros signos. */
export function normalizeCadastralReference(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** True si el valor, TAL CUAL, son 20 caracteres [0-9A-Z]. */
export function isValidCadastralReference(value: unknown): value is string {
  return typeof value === "string" && CADASTRAL_REFERENCE_RE.test(value);
}

/**
 * Normaliza y valida; devuelve la referencia canónica o lanza 400
 * `INVALID_CADASTRAL_REFERENCE` (mensaje en español, `details.value` con lo
 * recibido ya normalizado para que el front lo resalte).
 */
export function assertCadastralReference(raw: string): string {
  const normalized = normalizeCadastralReference(raw);
  if (!isValidCadastralReference(normalized)) {
    throw realEstateError(400, "INVALID_CADASTRAL_REFERENCE", `Referencia catastral no válida: deben ser ${CADASTRAL_REFERENCE_LENGTH} caracteres alfanuméricos (sin guiones ni signos).`, { value: normalized });
  }
  return normalized;
}
