// SES.HOSPEDAJES — Comunicaciones de Hospedaje al Ministerio del Interior
// per Real Decreto 933/2021 and the technical resolution of 2022. The schema
// (ses-hospedajes-v1.xsd) is published by the Sede Electrónica del MIR.
// This builder produces a canonical XML envelope matching the field order
// expected by the official submission endpoint. Production submission
// requires a qualified electronic certificate registered with the MIR.
//
// Tanda 3 (QC-01 / FISC-08): besides the XML builder this module hosts the
// PURE domain helpers shared by the API service, the scheduler, the backfill
// CLI and the unit tests — establishment validation (never Madrid defaults),
// TipoComunicacion derivation, deterministic ReferenciaExterna and the
// parte-de-viajeros status derivation. They take plain values and never touch
// env, Prisma or the network, so they can be tested with `node --test`.

import type { SpainGuestRegisterRecordInput } from "../guest-register-validator.js";

export type SesContractType = "alquiler" | "alojamiento";
export type SesPaymentMethod = "card" | "cash" | "bank_transfer" | "platform" | "other";

export type SesGuest = {
  documentType: "DNI" | "NIE" | "PASSPORT" | "TIE";
  documentNumber: string;
  documentSupportNumber?: string;
  firstName: string;
  surname1: string;
  surname2?: string;
  dateOfBirth: string;
  nationality: string;
  gender?: "M" | "F" | "X";
  phone?: string;
  email?: string;
  residenceAddress?: string;
  residenceMunicipality?: string;
  residenceProvince?: string;
  residenceCountry?: string;
  residencePostalCode?: string;
  isMinor?: boolean;
  parentDocumentNumber?: string;
  parentName?: string;
  relationshipToMinor?: string;
};

export type SesEstablishment = {
  taxId: string;
  legalName: string;
  registryNumber: string;
  registryType: "establecimiento_turistico" | "vivienda_uso_turistico";
  address: string;
  municipalityCode: string;
  province: string;
  postalCode: string;
  country: string;
};

export type SesContract = {
  contractRef: string;
  contractDate: string;
  checkinDate: string;
  checkoutDate: string;
  contractType: SesContractType;
  numberOfPersons: number;
  paymentMethod: SesPaymentMethod;
  paymentReference?: string;
  totalAmount: number;
  internetAccess?: boolean;
};

export type SesSubmissionRecord = {
  establishment: SesEstablishment;
  contract: SesContract;
  guests: SesGuest[];
  submissionType: "alta" | "modificacion" | "baja";
  externalReference: string;
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmtDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function fmtAmount(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function buildPersonaBlock(guest: SesGuest, idx: number): string {
  const tipoDoc = guest.documentType === "DNI" ? "1" : guest.documentType === "NIE" ? "2" : guest.documentType === "PASSPORT" ? "3" : "4";
  const sexo = guest.gender === "M" ? "1" : guest.gender === "F" ? "2" : "0";
  return `      <Persona>
        <Rol>${idx === 0 ? "TI" : "VI"}</Rol>
        <Nombre>${xmlEscape(guest.firstName)}</Nombre>
        <ApellidoPrimero>${xmlEscape(guest.surname1)}</ApellidoPrimero>
${guest.surname2 ? `        <ApellidoSegundo>${xmlEscape(guest.surname2)}</ApellidoSegundo>\n` : ""}        <TipoDocumento>${tipoDoc}</TipoDocumento>
        <NumeroDocumento>${xmlEscape(guest.documentNumber)}</NumeroDocumento>
${guest.documentSupportNumber ? `        <NumeroSoporte>${xmlEscape(guest.documentSupportNumber)}</NumeroSoporte>\n` : ""}        <FechaNacimiento>${fmtDate(guest.dateOfBirth)}</FechaNacimiento>
        <Sexo>${sexo}</Sexo>
        <Nacionalidad>${xmlEscape(guest.nationality)}</Nacionalidad>
${guest.phone ? `        <Telefono>${xmlEscape(guest.phone)}</Telefono>\n` : ""}${guest.email ? `        <Correo>${xmlEscape(guest.email)}</Correo>\n` : ""}${guest.residenceAddress ? `        <DireccionDomicilio>${xmlEscape(guest.residenceAddress)}</DireccionDomicilio>\n` : ""}${guest.residenceMunicipality ? `        <MunicipioDomicilio>${xmlEscape(guest.residenceMunicipality)}</MunicipioDomicilio>\n` : ""}${guest.residenceProvince ? `        <ProvinciaDomicilio>${xmlEscape(guest.residenceProvince)}</ProvinciaDomicilio>\n` : ""}${guest.residencePostalCode ? `        <CodigoPostalDomicilio>${xmlEscape(guest.residencePostalCode)}</CodigoPostalDomicilio>\n` : ""}${guest.residenceCountry ? `        <PaisDomicilio>${xmlEscape(guest.residenceCountry)}</PaisDomicilio>\n` : ""}${guest.isMinor ? `        <Menor>S</Menor>\n        <ParentescoMenor>${xmlEscape(guest.relationshipToMinor ?? "")}</ParentescoMenor>\n        <NombreParentesco>${xmlEscape(guest.parentName ?? "")}</NombreParentesco>\n        <DocumentoParentesco>${xmlEscape(guest.parentDocumentNumber ?? "")}</DocumentoParentesco>\n` : ""}      </Persona>`;
}

export function buildSesHospedajesXml(record: SesSubmissionRecord): string {
  const paymentCode = {
    card: "T",
    cash: "EF",
    bank_transfer: "TR",
    platform: "PL",
    other: "OT"
  }[record.contract.paymentMethod];

  const contractTypeCode = record.contract.contractType === "alquiler" ? "AL" : "AH";

  const personas = record.guests.map(buildPersonaBlock).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ses:ComunicacionParte xmlns:ses="https://sede.mir.gob.es/ses/hospedajes/v1">
  <ses:Cabecera>
    <ses:TipoComunicacion>${record.submissionType === "alta" ? "A" : record.submissionType === "modificacion" ? "M" : "B"}</ses:TipoComunicacion>
    <ses:ReferenciaExterna>${xmlEscape(record.externalReference)}</ses:ReferenciaExterna>
    <ses:FechaComunicacion>${new Date().toISOString()}</ses:FechaComunicacion>
  </ses:Cabecera>
  <ses:Establecimiento>
    <ses:NIF>${xmlEscape(record.establishment.taxId)}</ses:NIF>
    <ses:RazonSocial>${xmlEscape(record.establishment.legalName)}</ses:RazonSocial>
    <ses:NumeroRegistro>${xmlEscape(record.establishment.registryNumber)}</ses:NumeroRegistro>
    <ses:TipoRegistro>${record.establishment.registryType === "establecimiento_turistico" ? "ET" : "VUT"}</ses:TipoRegistro>
    <ses:Direccion>${xmlEscape(record.establishment.address)}</ses:Direccion>
    <ses:CodigoMunicipio>${xmlEscape(record.establishment.municipalityCode)}</ses:CodigoMunicipio>
    <ses:Provincia>${xmlEscape(record.establishment.province)}</ses:Provincia>
    <ses:CodigoPostal>${xmlEscape(record.establishment.postalCode)}</ses:CodigoPostal>
    <ses:Pais>${xmlEscape(record.establishment.country)}</ses:Pais>
  </ses:Establecimiento>
  <ses:Contrato>
    <ses:Referencia>${xmlEscape(record.contract.contractRef)}</ses:Referencia>
    <ses:FechaContrato>${fmtDate(record.contract.contractDate)}</ses:FechaContrato>
    <ses:TipoContrato>${contractTypeCode}</ses:TipoContrato>
    <ses:FechaEntrada>${fmtDate(record.contract.checkinDate)}</ses:FechaEntrada>
    <ses:FechaSalida>${fmtDate(record.contract.checkoutDate)}</ses:FechaSalida>
    <ses:NumPersonas>${record.contract.numberOfPersons}</ses:NumPersonas>
    <ses:MedioPago>${paymentCode}</ses:MedioPago>
${record.contract.paymentReference ? `    <ses:ReferenciaPago>${xmlEscape(record.contract.paymentReference)}</ses:ReferenciaPago>\n` : ""}    <ses:ImporteTotal>${fmtAmount(record.contract.totalAmount)}</ses:ImporteTotal>
${typeof record.contract.internetAccess === "boolean" ? `    <ses:AccesoInternet>${record.contract.internetAccess ? "S" : "N"}</ses:AccesoInternet>\n` : ""}  </ses:Contrato>
  <ses:Personas>
${personas}
  </ses:Personas>
</ses:ComunicacionParte>`;
}


// ───────────────────────────────────────────── establishment (FISC-08)

export type SesEstablishmentInput = {
  registryNumber: string | null | undefined;
  taxId: string | null | undefined;
  legalName: string | null | undefined;
  address: string | null | undefined;
  municipalityCode: string | null | undefined;
  province: string | null | undefined;
  postalCode: string | null | undefined;
  country: string | null | undefined;
};

/**
 * Machine-readable reasons an establishment block cannot be sent. Plain field
 * names mean "missing"; dotted suffixes mean "present but malformed".
 */
export type SesEstablishmentIssue =
  | "registryNumber"
  | "taxId"
  | "legalName"
  | "address"
  | "municipalityCode"
  | "municipalityCode.format"
  | "province"
  | "postalCode"
  | "postalCode.format"
  | "postalCode.provinceMismatch"
  | "country";

export const SES_ESTABLISHMENT_INCOMPLETE_CODE = "SES_ESTABLISHMENT_INCOMPLETE";
export const SES_MALFORMED_ESTABLISHMENT_CODE = "MALFORMED_ESTABLISHMENT";

const FIVE_DIGITS = /^\d{5}$/;

function isBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim() === "";
}

/** INE province prefix (2 digits) of a 5-digit code: 01..52 are the Spanish provinces. */
export function isSpanishProvinceCode(prefix: string): boolean {
  if (!/^\d{2}$/.test(prefix)) return false;
  const n = Number(prefix);
  return n >= 1 && n <= 52;
}

/**
 * Validates the establishment block against the MIR requirements: every field
 * present, INE municipality code and postal code of exactly 5 digits, and
 * both sharing a valid province prefix (01-52). The postal code is NEVER used
 * to infer the INE code (CP↔municipio is N:M); it is only cross-checked.
 */
export function validateSesEstablishment(input: SesEstablishmentInput): { ok: boolean; missing: SesEstablishmentIssue[] } {
  const missing: SesEstablishmentIssue[] = [];
  if (isBlank(input.registryNumber)) missing.push("registryNumber");
  if (isBlank(input.taxId)) missing.push("taxId");
  if (isBlank(input.legalName)) missing.push("legalName");
  if (isBlank(input.address)) missing.push("address");
  if (isBlank(input.province)) missing.push("province");
  if (isBlank(input.country)) missing.push("country");

  const municipality = (input.municipalityCode ?? "").trim();
  const postal = (input.postalCode ?? "").trim();
  let municipalityOk = false;
  let postalOk = false;
  if (isBlank(input.municipalityCode)) missing.push("municipalityCode");
  else if (!FIVE_DIGITS.test(municipality) || !isSpanishProvinceCode(municipality.slice(0, 2))) missing.push("municipalityCode.format");
  else municipalityOk = true;
  if (isBlank(input.postalCode)) missing.push("postalCode");
  else if (!FIVE_DIGITS.test(postal) || !isSpanishProvinceCode(postal.slice(0, 2))) missing.push("postalCode.format");
  else postalOk = true;
  if (municipalityOk && postalOk && municipality.slice(0, 2) !== postal.slice(0, 2)) missing.push("postalCode.provinceMismatch");

  return { ok: missing.length === 0, missing };
}

/** Spanish user-facing label for each establishment issue (settings screen, 409 body). */
export function describeSesEstablishmentIssue(issue: SesEstablishmentIssue): string {
  switch (issue) {
    case "registryNumber":
      return "Falta el número de registro del establecimiento en SES.HOSPEDAJES.";
    case "taxId":
      return "Falta un NIF válido de la organización.";
    case "legalName":
      return "Falta la razón social del titular.";
    case "address":
      return "Falta la dirección del establecimiento.";
    case "municipalityCode":
      return "Falta el código INE de municipio (5 dígitos).";
    case "municipalityCode.format":
      return "El código INE de municipio debe tener 5 dígitos con provincia 01-52.";
    case "province":
      return "Falta la provincia del establecimiento.";
    case "postalCode":
      return "Falta el código postal del establecimiento.";
    case "postalCode.format":
      return "El código postal debe tener 5 dígitos con provincia 01-52.";
    case "postalCode.provinceMismatch":
      return "El código postal y el código INE de municipio no pertenecen a la misma provincia.";
    case "country":
      return "Falta el país del establecimiento.";
  }
}

// ───────────────────────────────────────────── TipoComunicacion

export type SesSubmissionType = SesSubmissionRecord["submissionType"];

/**
 * A/M/B derivation (RD 933/2021): the first accepted communication of a stay
 * is an ALTA; once the MIR has accepted one, any further communication for
 * the same reservation is a MODIFICACIÓN; a cancelled stay is a BAJA. The old
 * mapping (checkin → modificación) sent every first parte as M.
 */
export function deriveSesSubmissionType(input: {
  /** Explicit trigger from the caller (legacy API values are accepted). */
  trigger?: "reservation" | "checkin" | "cancellation" | "alta" | "modificacion" | "baja" | null;
  /** Reservation status at queue time. */
  reservationStatus?: string | null;
  /** Guest register record type. */
  recordType?: string | null;
  /** True when the MIR already accepted a communication for this reservation. */
  hasAcceptedPrevious: boolean;
}): SesSubmissionType {
  const cancelled =
    input.trigger === "cancellation" ||
    input.trigger === "baja" ||
    input.reservationStatus === "cancelled" ||
    input.recordType === "cancellation" ||
    input.recordType === "annulment";
  if (cancelled) return "baja";
  return input.hasAcceptedPrevious ? "modificacion" : "alta";
}

// ───────────────────────────────────────────── ReferenciaExterna

const EXTERNAL_REFERENCE_PATTERN = /^(.*)-(alta|modificacion|baja)-(\d+)$/;

/** Parse `CODIGO_RESERVA-TIPO-INTENTO`; null for legacy references (Date.now() suffix included). */
export function parseSesExternalReference(reference: string | null | undefined): { reservationCode: string; submissionType: SesSubmissionType; attempt: number } | null {
  if (!reference) return null;
  const match = EXTERNAL_REFERENCE_PATTERN.exec(reference);
  if (!match) return null;
  const attempt = Number(match[3]);
  // A 13-digit suffix is a legacy Date.now() stamp, not an attempt counter.
  if (!Number.isSafeInteger(attempt) || attempt < 1 || match[3]!.length > 6) return null;
  return { reservationCode: match[1]!, submissionType: match[2] as SesSubmissionType, attempt };
}

/**
 * Deterministic ReferenciaExterna `CODIGO_RESERVA-TIPO-INTENTO`: the attempt
 * counter is one more than the highest attempt already used for the same
 * reservation and type, so re-running with the same database state yields the
 * same reference and the unique index never collides between two guest
 * records of one reservation or between retries of one row.
 */
export function nextSesExternalReference(reservationCode: string, submissionType: SesSubmissionType, existingReferences: ReadonlyArray<string | null | undefined>): string {
  let maxAttempt = 0;
  for (const reference of existingReferences) {
    const parsed = parseSesExternalReference(reference);
    if (!parsed || parsed.reservationCode !== reservationCode || parsed.submissionType !== submissionType) continue;
    if (parsed.attempt > maxAttempt) maxAttempt = parsed.attempt;
  }
  return `${reservationCode}-${submissionType}-${maxAttempt + 1}`;
}

// ───────────────────────────────────────────── parte de viajeros status

/** Statuses owned by the submission pipeline: a validation pass never rewrites them. */
export const GUEST_REGISTER_TERMINAL_STATUSES = new Set<string>([
  "queued",
  "exported",
  "submitted",
  "accepted",
  "rejected",
  "failed",
  "annulled",
  "corrected",
  "expired"
]);

/**
 * Status of a parte de viajeros after (re)validation. Pipeline-owned statuses
 * are preserved (their errors list is still refreshed by the caller); a valid
 * record is `signed` once the guest signed and `ready_to_submit` otherwise
 * (signature not required). An invalid record is `ready_to_sign` only when
 * the missing signature is its SOLE blocking issue — the validator itself says
 * ready_to_sign whenever `signature_required` appears, which hid missing
 * identity data behind a "ready" label; with other blockers it is
 * `missing_data`. Without `blockingIssueCodes` the validator verdict is used.
 */
export function deriveGuestRegisterStatus(input: {
  currentStatus: string | null | undefined;
  validationValid: boolean;
  validationStatus: string;
  signedAt: string | Date | null | undefined;
  /** Codes of the blocking issues (validation.issues filtered by severity). */
  blockingIssueCodes?: readonly string[];
}): string {
  if (input.currentStatus && GUEST_REGISTER_TERMINAL_STATUSES.has(input.currentStatus)) return input.currentStatus;
  if (input.validationValid) return input.signedAt ? "signed" : "ready_to_submit";
  if (input.blockingIssueCodes) {
    return input.blockingIssueCodes.every((code) => code === "signature_required") ? "ready_to_sign" : "missing_data";
  }
  return input.validationStatus;
}

/** Codes of the blocking issues of a validation result (helper for deriveGuestRegisterStatus). */
export function blockingIssueCodes(issues: ReadonlyArray<{ code: string; severity: string }>): string[] {
  return issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.code);
}

/**
 * Persisted columns of a parte de viajeros (structural: Prisma row or any
 * object with the same shape). Dates come as Date or ISO string.
 */
export type GuestRegisterColumns = {
  recordType: string | null;
  firstName: string | null;
  surname1: string | null;
  surname2: string | null;
  sex: string | null;
  nationality: string | null;
  dateOfBirth: Date | string | null;
  documentType: string | null;
  documentNumber: string | null;
  documentSupportNumber: string | null;
  residenceFullAddress: string | null;
  residenceLocality: string | null;
  residenceCountry: string | null;
  phoneLandline: string | null;
  phoneMobile: string | null;
  email: string | null;
  travellerCount: number | null;
  isMinor: boolean | null;
  providedByAdultGuestId: string | null;
  kinshipRelationIfMinor: string | null;
  contractReference: string | null;
  contractDate: Date | string | null;
  checkinAt: Date | string | null;
  checkoutAt: Date | string | null;
  paymentType: string | null;
  paymentMethodIdentifier: string | null;
  paymentHolder: string | null;
  paymentReference: string | null;
  signatureRequired: boolean | null;
  signedAt: Date | string | null;
  idImageStored: boolean | null;
  idImageDiscarded: boolean | null;
};

function columnIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function columnDay(value: Date | string | null | undefined): string | undefined {
  const text = columnIso(value);
  return text ? text.slice(0, 10) : undefined;
}

/** Validator input from persisted columns — the single column→validator mapping (API service + backfill). */
export function guestRegisterValidationInput(row: GuestRegisterColumns): SpainGuestRegisterRecordInput {
  return {
    recordType: (row.recordType ?? "checkin") as SpainGuestRegisterRecordInput["recordType"],
    firstName: row.firstName ?? undefined,
    surname1: row.surname1 ?? undefined,
    surname2: row.surname2 ?? undefined,
    sex: row.sex ?? undefined,
    nationality: row.nationality ?? undefined,
    dateOfBirth: columnDay(row.dateOfBirth),
    documentType: row.documentType ?? undefined,
    documentNumber: row.documentNumber ?? undefined,
    documentSupportNumber: row.documentSupportNumber ?? undefined,
    residenceFullAddress: row.residenceFullAddress ?? undefined,
    residenceLocality: row.residenceLocality ?? undefined,
    residenceCountry: row.residenceCountry ?? undefined,
    phoneLandline: row.phoneLandline ?? undefined,
    phoneMobile: row.phoneMobile ?? undefined,
    email: row.email ?? undefined,
    travellerCount: row.travellerCount ?? undefined,
    isMinor: row.isMinor ?? undefined,
    providedByAdultGuestId: row.providedByAdultGuestId ?? undefined,
    kinshipRelationIfMinor: row.kinshipRelationIfMinor ?? undefined,
    contractReference: row.contractReference ?? undefined,
    contractDate: columnIso(row.contractDate),
    checkinAt: columnIso(row.checkinAt),
    checkoutAt: columnIso(row.checkoutAt),
    paymentType: row.paymentType ?? undefined,
    paymentMethodIdentifier: row.paymentMethodIdentifier ?? undefined,
    paymentHolder: row.paymentHolder ?? undefined,
    paymentReference: row.paymentReference ?? undefined,
    signatureRequired: row.signatureRequired ?? undefined,
    signedAt: columnIso(row.signedAt),
    idImageStored: row.idImageStored ?? undefined,
    idImageDiscarded: row.idImageDiscarded ?? undefined
  };
}
