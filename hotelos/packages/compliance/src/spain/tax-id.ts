// Spanish tax identifiers (NIF) — pure helpers shared by the API (issuer
// identity, profile / bootstrap validation) and the worker (VeriFactu retries).
//
// Formats covered, all 9 characters after normalisation:
//   DNI          8 digits + control letter (mod-23 table)
//   NIE          X/Y/Z + 7 digits + control letter (X→0, Y→1, Z→2, then DNI rule)
//   K/L/M series natural persons without DNI: letter + 7 digits + control letter
//                computed over the 7 digits with the DNI table
//   CIF          organisation letter + 7 digits + control (digit or letter,
//                Luhn-like sum per Orden EHA/451/2008 art. 4)
//
// Nothing here touches I/O or the database; callers decide what to do with an
// invalid value (400 on a form, 409 on issuance in fiscal production mode…).

const DNI_CONTROL_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CIF_CONTROL_LETTERS = "JABCDEFGHI";
// Organisation letters allowed as the first character of a CIF.
const CIF_ORGANISATION_LETTERS = "ABCDEFGHJNPQRSUVW";
// Letters whose control character MUST be a digit / MUST be a letter; the
// remaining organisation letters (C, D, F, G, J, U, V) accept either form.
const CIF_DIGIT_CONTROL_ONLY = "ABEH";
const CIF_LETTER_CONTROL_ONLY = "NPQRSW";

/**
 * Sandbox-only placeholder NIF. Its all-zero body passes the CIF checksum
 * arithmetically, so `isValidSpanishTaxId` rejects all-zero bodies explicitly
 * and it can never be mistaken for a real identifier; the API stamps
 * `issuerTaxIdPlaceholder` on every invoice issued with it. NEVER used in
 * fiscal production mode.
 */
export const SPANISH_TAX_ID_PLACEHOLDER = "B00000000";

export type SpanishTaxIdKind = "DNI" | "NIE" | "NIF_SPECIAL" | "CIF";

/**
 * Canonical form: upper-case, no spaces / hyphens / dots, and without an
 * "ES" VAT-number prefix (ESB12345674 → B12345674). Returns null for an empty
 * value so callers can store "not configured" as NULL.
 */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (value.length === 11 && value.startsWith("ES")) value = value.slice(2);
  return value.length > 0 ? value : null;
}

function dniControlLetter(digits: string): string {
  return DNI_CONTROL_LETTERS[Number(digits) % 23] ?? "";
}

function cifControl(digits: string): { digit: string; letter: string } {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const n = Number(digits[i]);
    if (i % 2 === 0) {
      // Positions 1, 3, 5, 7 (1-based): double and add the digits of the result.
      const doubled = n * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else {
      sum += n;
    }
  }
  const control = (10 - (sum % 10)) % 10;
  return { digit: String(control), letter: CIF_CONTROL_LETTERS[control] ?? "" };
}

/** Structural classification of a normalised value (no checksum). */
export function classifySpanishTaxId(raw: string | null | undefined): SpanishTaxIdKind | null {
  const value = normalizeTaxId(raw);
  if (!value || value.length !== 9) return null;
  if (/^\d{8}[A-Z]$/.test(value)) return "DNI";
  if (/^[XYZ]\d{7}[A-Z]$/.test(value)) return "NIE";
  if (/^[KLM]\d{7}[A-Z]$/.test(value)) return "NIF_SPECIAL";
  if (new RegExp(`^[${CIF_ORGANISATION_LETTERS}]\\d{7}[0-9A-J]$`).test(value)) return "CIF";
  return null;
}

/**
 * Spanish user-facing reason why a value is not a valid NIF, or null when it
 * is valid. Used to build 400 messages on the profile / bootstrap forms.
 */
export function spanishTaxIdValidationMessage(raw: string | null | undefined): string | null {
  const value = normalizeTaxId(raw);
  if (!value) return "El NIF está vacío.";
  if (value.length !== 9) return "El NIF debe tener 9 caracteres (letra o dígitos más carácter de control).";
  const kind = classifySpanishTaxId(value);
  if (!kind) return "El formato no corresponde a un DNI, NIE o CIF español.";
  // An all-zero body (B00000000, 00000000T, X0000000…) is never assigned: it is
  // the sandbox placeholder or an unfilled form, not an identifier.
  if (/^[A-Z]?0{7,8}[A-Z0-9]$/.test(value)) return "El NIF es un valor de relleno (todo ceros), no un identificador real.";
  if (kind === "DNI") {
    return dniControlLetter(value.slice(0, 8)) === value[8] ? null : "La letra de control del DNI no coincide.";
  }
  if (kind === "NIE") {
    const prefix = { X: "0", Y: "1", Z: "2" }[value[0] as "X" | "Y" | "Z"];
    return dniControlLetter(prefix + value.slice(1, 8)) === value[8] ? null : "La letra de control del NIE no coincide.";
  }
  if (kind === "NIF_SPECIAL") {
    return dniControlLetter(value.slice(1, 8)) === value[8] ? null : "La letra de control del NIF no coincide.";
  }
  // CIF
  const organisationLetter = value[0]!;
  const control = value[8]!;
  const expected = cifControl(value.slice(1, 8));
  const isDigit = /\d/.test(control);
  if (isDigit && CIF_LETTER_CONTROL_ONLY.includes(organisationLetter)) {
    return `Los CIF que empiezan por ${organisationLetter} llevan letra de control, no dígito.`;
  }
  if (!isDigit && CIF_DIGIT_CONTROL_ONLY.includes(organisationLetter)) {
    return `Los CIF que empiezan por ${organisationLetter} llevan dígito de control, no letra.`;
  }
  const matches = isDigit ? control === expected.digit : control === expected.letter;
  return matches ? null : "El carácter de control del CIF no coincide.";
}

/** True when the value is a structurally valid DNI / NIE / CIF with a correct control character. */
export function isValidSpanishTaxId(raw: string | null | undefined): boolean {
  return spanishTaxIdValidationMessage(raw) === null;
}
