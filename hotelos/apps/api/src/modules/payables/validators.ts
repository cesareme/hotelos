// Payables · Spanish tax-id (NIF/NIE/CIF) and IBAN validation.
//
// The NIF algorithm is the one already used by the issuer identity
// (`@hotelos/compliance` → spain/tax-id.ts: DNI mod-23 letter, NIE X/Y/Z
// prefix, K/L/M series, CIF control digit/letter per Orden EHA/451/2008). This
// module only adds the payables-facing wrapper (normalised value + kind +
// Spanish message) and the IBAN wrapper (mod-97 from banking-spain, plus the
// national length table for the countries a Spanish hotel pays: an IBAN of
// the wrong length passes mod-97 one time in 97).

import { classifySpanishTaxId, isValidSpanishTaxId, normalizeTaxId, spanishTaxIdValidationMessage } from "@hotelos/compliance";
import { validateIban as ibanMod97 } from "../../modules/banking-spain/sepa-norma19.generator.js";

export type NifKind = "DNI" | "NIE" | "NIF_SPECIAL" | "CIF";

export type NifCheck =
  | { ok: true; value: string; kind: NifKind; isCompany: boolean }
  | { ok: false; value: string | null; message: string };

/**
 * Validates a Spanish NIF. `isCompany` is true for a CIF (a company: no IRPF
 * withholding by default) and false for a natural person (DNI/NIE/K-L-M:
 * professional withholding may apply).
 */
export function checkSpanishNif(raw: string | null | undefined): NifCheck {
  const value = normalizeTaxId(raw);
  const message = spanishTaxIdValidationMessage(value);
  if (message !== null || !value || !isValidSpanishTaxId(value)) {
    return { ok: false, value, message: message ?? "NIF no válido." };
  }
  const kind = classifySpanishTaxId(value);
  if (!kind) return { ok: false, value, message: "El formato no corresponde a un DNI, NIE o CIF español." };
  return { ok: true, value, kind, isCompany: kind === "CIF" };
}

/** Canonical NIF (upper-case, no separators, no "ES" prefix) or null when empty. */
export function normalizeNif(raw: string | null | undefined): string | null {
  return normalizeTaxId(raw);
}

// IBAN lengths per country (ISO 13616 registry) for the countries a Spanish
// company realistically pays; anything else falls back to the generic
// 15..34 bound of the standard.
const IBAN_LENGTHS: Record<string, number> = {
  ES: 24, PT: 25, FR: 27, DE: 22, IT: 27, AD: 24, NL: 18, BE: 16, GB: 22, IE: 22,
  LU: 20, AT: 20, CH: 21, PL: 28, SE: 24, DK: 18, NO: 15, FI: 18, GR: 27, MT: 31
};

export type IbanCheck = { ok: true; value: string; countryCode: string } | { ok: false; value: string; message: string };

/** Validates an IBAN: structure, national length and mod-97 checksum. Returns the compact upper-case form. */
export function checkIban(raw: string | null | undefined): IbanCheck {
  const value = String(raw ?? "").replace(/\s|-/g, "").toUpperCase();
  if (value.length === 0) return { ok: false, value, message: "El IBAN está vacío." };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) {
    return { ok: false, value, message: "El IBAN debe empezar por país y dígitos de control (p. ej. ES91 2100 …)." };
  }
  const countryCode = value.slice(0, 2);
  const expected = IBAN_LENGTHS[countryCode];
  if (expected !== undefined && value.length !== expected) {
    return { ok: false, value, message: `Un IBAN de ${countryCode} tiene ${expected} caracteres (recibidos ${value.length}).` };
  }
  if (!ibanMod97(value)) return { ok: false, value, message: "Los dígitos de control del IBAN no coinciden." };
  return { ok: true, value, countryCode };
}

/** IBAN pretty-printed in groups of 4 for the UI ("ES91 2100 0418 4502 0005 1332"). */
export function formatIban(value: string): string {
  return value.replace(/(.{4})/g, "$1 ").trim();
}
