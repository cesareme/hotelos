// Errores de dominio del módulo RRHH (Tanda RRHH · RRHH-2).
//
// Todos los errores del módulo viajan como HttpError con `details.code` ∈
// HR_ERROR_CODES (packages/shared/src/hr-types.ts) y el mensaje en español de
// HR_ERROR_MESSAGES_ES, para que el admin-web ramifique por código y nunca por
// texto (patrón de STAFF_PROFILE_ERROR_CODES en payroll/staff-profiles.service).
//
//   hrBadRequest(code, extra?)   400 · validación (VALIDATION_ERROR lleva `field`)
//   hrNotFound(code)             404 OPACO · misma respuesta para «no existe», «de
//                                otra organización» y «fuera del ámbito del actor»
//   hrConflict(code, extra?)     409 · duplicados, transiciones y SoD
//   hrUnavailable(code)          503 · la clave de cifrado no está configurada y se
//                                pidió PII descifrada (nunca se devuelve el envelope)
//
// Ningún mensaje ni `details` lleva datos personales: los identificadores que se
// adjuntan son ids de fila y nombres de campo.

import { HR_ERROR_MESSAGES_ES, type HrErrorCode } from "@hotelos/shared";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";

export type HrErrorDetails = { code: HrErrorCode } & Record<string, unknown>;

export function hrMessage(code: HrErrorCode): string {
  return HR_ERROR_MESSAGES_ES[code];
}

export function hrBadRequest(code: HrErrorCode, extra?: Record<string, unknown> & { message?: string }): BadRequestError {
  const { message, ...rest } = extra ?? {};
  const error = new BadRequestError(typeof message === "string" && message.length > 0 ? message : hrMessage(code));
  // `code` siempre gana: un extra con esa clave no puede enmascarar el código de error.
  error.details = { ...rest, code } satisfies HrErrorDetails;
  return error;
}

export function hrNotFound(code: HrErrorCode = "HR_EMPLOYEE_NOT_FOUND"): NotFoundError {
  const error = new NotFoundError(hrMessage(code));
  error.details = { code } satisfies HrErrorDetails;
  return error;
}

export function hrConflict(code: HrErrorCode, extra?: Record<string, unknown> & { message?: string }): ConflictError {
  const { message, ...rest } = extra ?? {};
  return new ConflictError(typeof message === "string" && message.length > 0 ? message : hrMessage(code), { ...rest, code } satisfies HrErrorDetails);
}

export function hrUnavailable(code: HrErrorCode = "HR_PII_KEY_MISSING"): HttpError {
  return new HttpError(503, hrMessage(code), true, { code } satisfies HrErrorDetails);
}

/** `details.code` de un error del módulo, o null si no es un HttpError con código. */
export function hrErrorCodeOf(error: unknown): HrErrorCode | null {
  if (!(error instanceof HttpError)) return null;
  const details = error.details as { code?: unknown } | undefined;
  return typeof details?.code === "string" ? (details.code as HrErrorCode) : null;
}

export function isHrError(error: unknown, code: HrErrorCode): boolean {
  return hrErrorCodeOf(error) === code;
}
