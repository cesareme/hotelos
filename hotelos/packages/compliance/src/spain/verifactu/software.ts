// SistemaInformatico block of every VeriFactu registro (RD 1007/2023 art. 13
// and Orden HAC/1177/2024, anexo). It identifies the PRODUCER of the software
// (Anfitorio's legal owner) — a different concept from the invoice issuer
// (Invoice.issuerTaxId) — and every value MUST match what the producer stated
// in its declaración responsable (docs/compliance/verifactu-declaracion-
// responsable.md). One resolver, shared by the API and the worker, so a retry
// can never rebuild a registro with a different block than the first send.
//
// Environment variables (empty string == not set):
//   VERIFACTU_SOFTWARE_NAME     NombreRazon of the producer (≤120)         required
//   VERIFACTU_SOFTWARE_NIF      NIF of the producer (checksum-valid)        required
//   VERIFACTU_SYSTEM_NAME       NombreSistemaInformatico (≤30)              default "Anfitorio"
//   VERIFACTU_SYSTEM_ID         IdSistemaInformatico (exactly 2 chars)      default "01"
//   VERIFACTU_SYSTEM_VERSION    Version (≤50) — falls back to APP_VERSION   default "0.1.0"
//   VERIFACTU_INSTALL_NUMBER    NumeroInstalacion (≤100), assigned by the
//                               producer per installation (NOT by AEAT)     required
//   VERIFACTU_MULTI_OT          "S" | "N" — TipoUsoPosibleMultiOT and
//                               IndicadorMultiplesOT (SaaS multi-tenant)    default "S"
//
// Missing required values are replaced by labelled sandbox defaults so the
// stub pipeline keeps working, and reported in `errors` so real modes
// (preproduction / production) refuse to send and readiness stays red.

import { isValidSpanishTaxId, normalizeTaxId, SPANISH_TAX_ID_PLACEHOLDER, spanishTaxIdValidationMessage } from "../tax-id.js";

export type VerifactuSoftwareFlag = "S" | "N";

export type VerifactuSoftwareBlock = {
  /** SistemaInformatico/NombreRazon — legal name of the software producer. */
  nombreRazon: string;
  /** SistemaInformatico/NIF — NIF of the software producer. */
  nif: string;
  /** SistemaInformatico/NombreSistemaInformatico — product name. */
  nombreSistema: string;
  /** SistemaInformatico/IdSistemaInformatico — 2-character code chosen by the producer. */
  idSistema: string;
  /** SistemaInformatico/Version — as declared in the declaración responsable. */
  version: string;
  /** SistemaInformatico/NumeroInstalacion — per-installation identifier chosen by the producer. */
  numeroInstalacion: string;
  tipoUsoPosibleSoloVerifactu: VerifactuSoftwareFlag;
  tipoUsoPosibleMultiOT: VerifactuSoftwareFlag;
  indicadorMultiplesOT: VerifactuSoftwareFlag;
};

export type VerifactuSoftwareResolution = {
  /** True when every field is present and within the XSD limits. */
  ok: boolean;
  /** Spanish, user-facing reasons the block is not ready for AEAT (empty when ok). */
  errors: string[];
  software: VerifactuSoftwareBlock;
};

// Limits from SuministroInformacion.xsd (TextMax120Type, NIFType, TextMax30Type,
// TextMax2Type, TextMax50Type, TextMax100Type).
export const VERIFACTU_SOFTWARE_LIMITS = Object.freeze({
  nombreRazon: 120,
  nombreSistema: 30,
  idSistema: 2,
  version: 50,
  numeroInstalacion: 100
});

export const VERIFACTU_SOFTWARE_DEFAULTS = Object.freeze({
  nombreSistema: "Anfitorio",
  idSistema: "01",
  version: "0.1.0",
  multiOT: "S" as VerifactuSoftwareFlag,
  // Sandbox-only fillers; never sent to AEAT because `ok` is false with them.
  nombreRazon: "PRODUCTOR SIN CONFIGURAR",
  nif: SPANISH_TAX_ID_PLACEHOLDER,
  numeroInstalacion: "DEV-001"
});

/** Trimmed value, or null when the variable is unset or blank ("" counts as absent). */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFlag(env: NodeJS.ProcessEnv, name: string, fallback: VerifactuSoftwareFlag, errors: string[]): VerifactuSoftwareFlag {
  const raw = readEnv(env, name);
  if (raw === null) return fallback;
  const upper = raw.toUpperCase();
  if (upper === "S" || upper === "N") return upper;
  errors.push(`${name} debe ser "S" o "N" (valor actual: "${raw}").`);
  return fallback;
}

function checkMaxLength(value: string, max: number, label: string, variable: string, errors: string[]): void {
  if (value.length > max) {
    errors.push(`${label} (${variable}) supera los ${max} caracteres permitidos por el XSD (${value.length}).`);
  }
}

/**
 * Resolve the SistemaInformatico block from the environment (contract E).
 * Pure: reads `env` only, never throws; callers decide what to do with
 * `errors` (sandbox tolerates them, real modes must not send).
 */
export function resolveVerifactuSoftware(env: NodeJS.ProcessEnv = process.env): VerifactuSoftwareResolution {
  const errors: string[] = [];

  const nombreRazonRaw = readEnv(env, "VERIFACTU_SOFTWARE_NAME");
  const nombreRazon = nombreRazonRaw ?? VERIFACTU_SOFTWARE_DEFAULTS.nombreRazon;
  if (nombreRazonRaw === null) {
    errors.push("Falta VERIFACTU_SOFTWARE_NAME (razón social del productor del software, NombreRazon del bloque SistemaInformatico).");
  } else {
    checkMaxLength(nombreRazonRaw, VERIFACTU_SOFTWARE_LIMITS.nombreRazon, "La razón social del productor", "VERIFACTU_SOFTWARE_NAME", errors);
  }

  const nifRaw = readEnv(env, "VERIFACTU_SOFTWARE_NIF");
  const nifNormalized = normalizeTaxId(nifRaw);
  let nif: string = VERIFACTU_SOFTWARE_DEFAULTS.nif;
  if (nifRaw === null || nifNormalized === null) {
    errors.push("Falta VERIFACTU_SOFTWARE_NIF (NIF del productor del software, no del hotel emisor).");
  } else if (!isValidSpanishTaxId(nifNormalized)) {
    errors.push(`VERIFACTU_SOFTWARE_NIF no es un NIF válido: ${spanishTaxIdValidationMessage(nifNormalized) ?? "formato incorrecto"}`);
    nif = nifNormalized;
  } else {
    nif = nifNormalized;
  }

  const nombreSistema = readEnv(env, "VERIFACTU_SYSTEM_NAME") ?? VERIFACTU_SOFTWARE_DEFAULTS.nombreSistema;
  checkMaxLength(nombreSistema, VERIFACTU_SOFTWARE_LIMITS.nombreSistema, "El nombre del sistema", "VERIFACTU_SYSTEM_NAME", errors);

  const idSistema = readEnv(env, "VERIFACTU_SYSTEM_ID") ?? VERIFACTU_SOFTWARE_DEFAULTS.idSistema;
  if (idSistema.length !== VERIFACTU_SOFTWARE_LIMITS.idSistema) {
    errors.push(
      `IdSistemaInformatico (VERIFACTU_SYSTEM_ID) debe tener exactamente ${VERIFACTU_SOFTWARE_LIMITS.idSistema} caracteres (valor actual: "${idSistema}").`
    );
  }

  const version = readEnv(env, "VERIFACTU_SYSTEM_VERSION") ?? readEnv(env, "APP_VERSION") ?? VERIFACTU_SOFTWARE_DEFAULTS.version;
  checkMaxLength(version, VERIFACTU_SOFTWARE_LIMITS.version, "La versión del sistema", "VERIFACTU_SYSTEM_VERSION", errors);

  const numeroInstalacionRaw = readEnv(env, "VERIFACTU_INSTALL_NUMBER");
  const numeroInstalacion = numeroInstalacionRaw ?? VERIFACTU_SOFTWARE_DEFAULTS.numeroInstalacion;
  if (numeroInstalacionRaw === null) {
    errors.push("Falta VERIFACTU_INSTALL_NUMBER (número de instalación asignado por el productor a este despliegue).");
  } else {
    checkMaxLength(numeroInstalacionRaw, VERIFACTU_SOFTWARE_LIMITS.numeroInstalacion, "El número de instalación", "VERIFACTU_INSTALL_NUMBER", errors);
  }

  const multiOT = readFlag(env, "VERIFACTU_MULTI_OT", VERIFACTU_SOFTWARE_DEFAULTS.multiOT, errors);

  return {
    ok: errors.length === 0,
    errors,
    software: {
      nombreRazon,
      nif,
      nombreSistema,
      idSistema,
      version,
      numeroInstalacion,
      // Anfitorio only ever runs as a VERI*FACTU system (records are sent to
      // AEAT, never kept offline), so the "solo VeriFactu" flag is fixed.
      tipoUsoPosibleSoloVerifactu: "S",
      tipoUsoPosibleMultiOT: multiOT,
      indicadorMultiplesOT: multiOT
    }
  };
}
