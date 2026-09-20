// Errores tipados del activo inmobiliario (Tanda ACT · L0a, diseño §7).
// Patrón `typed` de modules/payables/expenses.service.ts: un HttpError con
// `details.code` ∈ REAL_ESTATE_ERROR_CODES (packages/shared) para que el front
// ramifique por código y no por el texto en español del mensaje.

import { REAL_ESTATE_ERROR_CODES, type RealEstateErrorCode } from "@hotelos/shared";
import { HttpError } from "../../lib/http-error.js";

const CODES = new Set<string>(REAL_ESTATE_ERROR_CODES);

export function isRealEstateErrorCode(value: unknown): value is RealEstateErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/**
 * 4xx tipado del módulo: `details = { code, ...extra }` (el código nunca se
 * pisa con `extra`). El handler global de server.ts reenvía `details` en el
 * cuerpo del error.
 */
export function realEstateError(statusCode: number, code: RealEstateErrorCode, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { ...extra, code });
}

/** Código tipado de un error lanzado por el módulo (o null si no es uno de los nuestros). */
export function realEstateErrorCodeOf(error: unknown): RealEstateErrorCode | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { details?: { code?: unknown } }).details?.code;
  return isRealEstateErrorCode(code) ? code : null;
}
