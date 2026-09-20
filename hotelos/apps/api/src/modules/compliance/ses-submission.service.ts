// SES.HOSPEDAJES submission pipeline (Tanda 3 · QC-01 / FISC-08).
//
// Single source of truth for every comunicación sent to the MIR:
//   * queueSesSubmission creates the `SesHospedajesSubmission` row SYNCHRONOUSLY
//     (status queued, real id) and returns it — the id the front / check-in
//     command receives is the one `/ses/submissions/:id` serves. Processing is
//     serialised on an in-process chain and updates that same row by id.
//   * TipoComunicacion is derived (alta → modificación once the MIR accepted a
//     communication for the reservation → baja on cancellation).
//   * ReferenciaExterna is deterministic: `CODIGO_RESERVA-TIPO-INTENTO`.
//   * The establishment block comes from Property + PropertyComplianceSetting +
//     the issuer identity; there are NO defaults. An incomplete establishment
//     leaves a `failed` row (SES_ESTABLISHMENT_INCOMPLETE · missing[]) and the
//     queue call raises a 409 with `details.missing`; those rows are retried
//     automatically by the scheduler once the profile is complete.
//   * Retries reuse the row (attempts++), the scheduler acts with a per-property
//     system context, and overdue communications (RD 933/2021 · 24 h) emit one
//     AuthoritySubmissionOverdue event each.
//   * The parte mirrors the MIR outcome (guestRegisterStatusForSesOutcome): an
//     accepted alta/modificación leaves it `accepted`, an accepted baja leaves
//     it `annulled`. The scheduler reconciles partes whose status drifted from
//     their SES history (reconcileGuestRegisterStatus), e.g. a baja accepted
//     before this mapping existed.

import {
  buildSesHospedajesXml,
  deriveSesSubmissionType,
  describeSesEstablishmentIssue,
  guestRegisterValidationInput,
  nextSesExternalReference,
  SES_ESTABLISHMENT_INCOMPLETE_CODE,
  submitSesHospedajesComunicacion,
  validateSesEstablishment,
  validateSpainGuestRegisterRecord,
  type SesEstablishmentIssue,
  type SesGuest,
  type SesSubmissionRecord,
  type SesSubmissionType
} from "@hotelos/compliance";
import { prisma, type Prisma } from "@hotelos/database";
import { z } from "zod";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { buildPage, decodeCursor, MAX_PAGE_LIMIT, type Page } from "../../lib/pagination.js";
import { parse } from "../../lib/validate.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { ISSUER_TAX_ID_MISSING_CODE, requireIssuerIdentity, resolveIssuerIdentity } from "../invoicing/issuer-identity.service.js";

type SesRow = Awaited<ReturnType<typeof prisma.sesHospedajesSubmission.findUniqueOrThrow>>;
type SesStatus = SesRow["status"];
type GuestRegisterRow = Awaited<ReturnType<typeof prisma.guestRegisterRecord.findUniqueOrThrow>>;
type GuestRegisterStatus = GuestRegisterRow["status"];

const SES_STATUSES: ReadonlySet<string> = new Set(["queued", "sent", "accepted", "rejected", "failed", "annulled", "retrying"]);

// ───────────────────────────────────────────── honest queue (Tanda L5 · L5-B2)

/** 409 when Property.sesHospedajesEnabled is false: nothing is queued and no row is created. */
export const SES_DISABLED_CODE = "SES_DISABLED";
/** 409 when the parte fails validateSpainGuestRegisterRecord over its persisted columns (details.issues); no row is created. */
export const GUEST_REGISTER_INVALID_CODE = "GUEST_REGISTER_INVALID";
/** 409 when the parte's persisted status is one the pipeline never (re)sends as alta/modificación (accepted · annulled · expired). */
export const GUEST_REGISTER_NOT_QUEUEABLE_CODE = "GUEST_REGISTER_NOT_QUEUEABLE";
/** 409 when an open comunicación (queued · sent · retrying) of the same type already exists for the parte: it is not duplicated. */
export const SES_SUBMISSION_IN_FLIGHT_CODE = "SES_SUBMISSION_IN_FLIGHT";
/** errorCode of a `failed` row the operator discarded (discardFailedSesSubmissions): never re-queued by the scheduler nor retried. */
export const SES_DISCARDED_CODE = "SES_DISCARDED";
/** Audit action written when queueSesSubmission refuses WITHOUT creating a row (flag off, invalid parte, not queueable, in flight). */
export const SES_SUBMISSION_REFUSED_ACTION = "SES_HOSPEDAJES_SUBMISSION_REFUSED";
/** Audit action written per row by discardFailedSesSubmissions. */
export const SES_SUBMISSION_DISCARDED_ACTION = "SES_HOSPEDAJES_SUBMISSION_DISCARDED";

/**
 * Gate of the parte status for an alta/modificación (PURE). A parte the MIR
 * already holds (`accepted`), one whose registration was revoked (`annulled`)
 * or a duplicate demoted by the backfill (`expired`) is legal history: it is
 * never rewritten by a new comunicación. A `corrected` parte (the operator
 * fixed the data after an acceptance or a rejection) goes through as a
 * modificación once it validates. Bajas are never gated here: they revoke
 * whatever the MIR holds (selectGuestRegisterRecordsForSesBaja decides).
 */
export function sesQueueGateForRecord(status: string, submissionType: SesSubmissionType): { code: string; message: string } | null {
  if (submissionType === SES_BAJA_TYPE) return null;
  switch (status) {
    case "accepted":
      return {
        code: GUEST_REGISTER_NOT_QUEUEABLE_CODE,
        message: "El parte ya está aceptado por el MIR: los históricos no se reescriben. Corrígelo para comunicar una modificación."
      };
    case "annulled":
      return { code: GUEST_REGISTER_NOT_QUEUEABLE_CODE, message: "El parte está anulado (baja aceptada por el MIR): no se vuelve a comunicar." };
    case "expired":
      return { code: GUEST_REGISTER_NOT_QUEUEABLE_CODE, message: "El parte está caducado (duplicado retirado): no se comunica." };
    default:
      return null;
  }
}

/** Guest data the comunicación needs per traveller (profile columns; the primary guest also falls back to the parte's own columns). */
export type SesGuestSource = {
  documentType: string | null | undefined;
  documentNumber: string | null | undefined;
  documentSupportNumber?: string | null;
  firstName: string | null | undefined;
  surname1: string | null | undefined;
  surname2?: string | null;
  dateOfBirth: Date | string | null | undefined;
  nationality: string | null | undefined;
  phone?: string | null;
  email?: string | null;
  residenceAddress?: string | null;
  // Corrector L5 (CS-03): what the comunicación carried as «desconocido» (<Sexo>0</Sexo>)
  // or not at all (municipio / país de residencia, bloque de menor) although the
  // parte validates and persists it.
  /** Profile / parte `sex`: M · F · X (also male/female/hombre/mujer, any case). */
  sex?: string | null;
  residenceLocality?: string | null;
  residenceProvince?: string | null;
  residencePostalCode?: string | null;
  residenceCountry?: string | null;
  /** Parte `isMinor` (B1: age < 14 at check-in). */
  isMinor?: boolean | null;
  /** Parte `kinshipRelationIfMinor` (ReservationGuest.relationshipType). */
  kinshipRelationIfMinor?: string | null;
  /** Adult who provides the minor's data (parte `providedByAdultGuestId` → guest). */
  parentName?: string | null;
  parentDocumentNumber?: string | null;
};

/** Sex as the SES XML expects it (M → 1, F → 2, anything else → 0 «desconocido»). Tolerant with legacy spellings. */
export function sesGenderOf(raw: string | null | undefined): SesGuest["gender"] | undefined {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return undefined;
  if (value === "M" || value === "H" || value === "MALE" || value === "HOMBRE" || value === "V" || value === "VARON" || value === "VARÓN") return "M";
  if (value === "F" || value === "FEMALE" || value === "MUJER") return "F";
  return "X";
}

/** Fields Personas cannot travel without (there are NO defaults: a missing value fails the row, never a placeholder). */
const SES_GUEST_REQUIRED_FIELDS = ["documentType", "documentNumber", "firstName", "surname1", "dateOfBirth", "nationality"] as const;

/**
 * SesGuest from a guest source (PURE). Before Tanda L5 the pipeline filled
 * `1900-01-01` / `ESP` / `DNI` / `""` for missing data and the sandbox stub
 * accepted the comunicación: partes with 9-11 blocking issues ended `accepted`.
 * Now every required field must be present; the missing ones are reported and
 * the row fails with GUEST_REGISTER_INVALID (not recoverable by the scheduler).
 */
export function sesGuestFromSource(source: SesGuestSource): { ok: true; guest: SesGuest } | { ok: false; missing: string[] } {
  const dateOfBirth = source.dateOfBirth instanceof Date ? source.dateOfBirth.toISOString().slice(0, 10) : source.dateOfBirth?.trim() || undefined;
  const values: Record<(typeof SES_GUEST_REQUIRED_FIELDS)[number], string | undefined> = {
    documentType: source.documentType?.trim() || undefined,
    documentNumber: source.documentNumber?.trim() || undefined,
    firstName: source.firstName?.trim() || undefined,
    surname1: source.surname1?.trim() || undefined,
    dateOfBirth,
    nationality: source.nationality?.trim() || undefined
  };
  // Corrector CHK (REV3-06): un menor de 14 sin documento propio viaja sin el bloque de documento
  // (RD 933/2021: lo aporta el adulto en DocumentoParentesco); el resto de campos sigue siendo obligatorio.
  const minorWithoutDocument = source.isMinor === true && values.documentNumber === undefined;
  const missing = SES_GUEST_REQUIRED_FIELDS.filter((field) => values[field] === undefined && !(minorWithoutDocument && (field === "documentType" || field === "documentNumber")));
  if (missing.length > 0) return { ok: false, missing: [...missing] };
  return {
    ok: true,
    guest: toSesGuest({
      documentType: values.documentType,
      documentNumber: values.documentNumber,
      documentSupportNumber: source.documentSupportNumber?.trim() || undefined,
      firstName: values.firstName!,
      surname1: values.surname1!,
      surname2: source.surname2?.trim() || undefined,
      dateOfBirth: values.dateOfBirth!,
      nationality: values.nationality!,
      phone: source.phone?.trim() || undefined,
      email: source.email?.trim() || undefined,
      residenceAddress: source.residenceAddress?.trim() || undefined,
      gender: sesGenderOf(source.sex),
      residenceMunicipality: source.residenceLocality?.trim() || undefined,
      residenceProvince: source.residenceProvince?.trim() || undefined,
      residencePostalCode: source.residencePostalCode?.trim() || undefined,
      residenceCountry: source.residenceCountry?.trim() || undefined,
      isMinor: source.isMinor === true ? true : undefined,
      relationshipToMinor: source.isMinor === true ? source.kinshipRelationIfMinor?.trim() || undefined : undefined,
      parentName: source.isMinor === true ? source.parentName?.trim() || undefined : undefined,
      parentDocumentNumber: source.isMinor === true ? source.parentDocumentNumber?.trim() || undefined : undefined
    })
  };
}

/** RD 933/2021: a comunicación not accepted 24 h after it was queued is overdue. */
export const SES_OVERDUE_MS = 24 * 60 * 60 * 1000;
/** Network/transient failures are retried this often (nextRetryAt). */
const SES_RETRY_DELAY_MS = 10 * 60_000;
/** Safety cap on automatic retries; a manual retry (retrySesSubmission) still works. */
const SES_MAX_ATTEMPTS = Number(process.env.SES_MAX_ATTEMPTS ?? 10);
/**
 * `failed` rows with one of these codes are re-queued by the scheduler once the
 * profile passes (establishment / NIF) or the switch is back on (SES_DISABLED,
 * corrector L5 · CS-02: a row that was queued and then found the switch off
 * waits for it instead of leaving a dead row plus a new one on the next queue).
 */
export const SES_RECOVERABLE_ERROR_CODES: readonly string[] = [SES_ESTABLISHMENT_INCOMPLETE_CODE, ISSUER_TAX_ID_MISSING_CODE, SES_DISABLED_CODE];

/**
 * Corrector L5 (CS-01): the SES.HOSPEDAJES switch is the OR of the two flags the
 * product writes — `properties.ses_hospedajes_enabled` (seed, bootstrap, chain
 * seed) and `property_compliance_settings.ses_hospedajes_enabled` (the switch of
 * Ajustes de cumplimiento, TaxComplianceSettings → persistComplianceSettings) —
 * the same rule the readiness applies (backoffice.service resolveComplianceApplicability).
 * Null when the property does not exist.
 */
export async function sesHospedajesEnabledFor(propertyId: string): Promise<boolean | null> {
  const [property, settings] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { sesHospedajesEnabled: true } }),
    prisma.propertyComplianceSetting.findUnique({ where: { propertyId }, select: { sesHospedajesEnabled: true } })
  ]);
  if (!property) return null;
  return Boolean(property.sesHospedajesEnabled || settings?.sesHospedajesEnabled);
}
/** Statuses the pipeline still owes an answer for (in flight). */
const SES_OPEN_STATUSES: readonly SesStatus[] = ["queued", "sent", "retrying"];
/** Everything the MIR has not accepted and nobody annulled: the legal 24 h clock keeps running on these. */
const SES_UNRESOLVED_STATUSES: readonly SesStatus[] = ["queued", "sent", "retrying", "failed", "rejected"];

export { SES_ESTABLISHMENT_INCOMPLETE_CODE };

// ───────────────────────────────────────────── parte status ↔ SES outcome (pure)

/** TipoComunicacion that revokes a registration at the MIR. */
export const SES_BAJA_TYPE = "baja";

/** A baja in one of these statuses already revoked the registration it followed. */
export const SES_BAJA_DONE_STATUSES: readonly SesStatus[] = ["accepted", "annulled"];

/**
 * A baja in one of these statuses is in flight or parked for retry. The
 * scheduler / manual retry reuse the row, so it still reaches the MIR and
 * revokes whatever registration the MIR holds at that moment: queuing another
 * baja for the same parte would communicate it twice.
 */
export const SES_BAJA_PENDING_STATUSES: readonly SesStatus[] = ["queued", "sent", "retrying", "failed"];

/**
 * Every baja status that leaves no room for a new baja (done + pending). Only
 * a `rejected` baja (the MIR refused it) does. How they apply depends on the
 * ORDER of the history — see selectGuestRegisterRecordsForSesBaja.
 */
export const SES_BAJA_BLOCKING_STATUSES: readonly SesStatus[] = [...SES_BAJA_PENDING_STATUSES, ...SES_BAJA_DONE_STATUSES];

export type SesHistoryEntry = { submissionType: string; status: SesStatus };

/** Parte statuses the SES pipeline owns; reconciliation never touches the others (draft, signed, expired…). */
const SES_OWNED_RECORD_STATUSES: readonly GuestRegisterStatus[] = ["queued", "submitted", "accepted", "rejected", "failed", "annulled"];

/**
 * Parte status mirrored once a comunicación reaches `status`. The mapping
 * depends on the TipoComunicacion: an accepted alta/modificación means the
 * guest is registered at the MIR (`accepted`), an accepted baja means that
 * registration was revoked (`annulled` · ComplianceStatus.annulled), never
 * `accepted`. Exhaustive over SubmissionStatus (schema.prisma).
 */
export function guestRegisterStatusForSesOutcome(input: SesHistoryEntry): GuestRegisterStatus {
  switch (input.status) {
    case "accepted":
      return input.submissionType === SES_BAJA_TYPE ? "annulled" : "accepted";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
    case "annulled":
      return "annulled";
    case "queued":
      return "queued";
    case "sent":
    case "retrying":
      return "submitted";
  }
}

/**
 * Parte status implied by its whole SES history (oldest first). Precedence:
 *   1. an in-flight comunicación (queued/sent/retrying) — the newest one — the
 *      pipeline owns the parte until the MIR answers;
 *   2. the MIR-side truth: the LAST accepted comunicación decides (baja →
 *      annulled, alta/modificación → accepted), even if a later baja was
 *      rejected or failed (the guest is still registered; the inbox shows it);
 *   3. with nothing accepted, the newest outcome (rejected / failed / annulled).
 * Null for a parte without SES history: nothing to reconcile.
 */
export function deriveGuestRegisterStatusFromSesHistory(history: readonly SesHistoryEntry[]): GuestRegisterStatus | null {
  if (history.length === 0) return null;
  const open = history.filter((entry) => SES_OPEN_STATUSES.includes(entry.status));
  if (open.length > 0) return guestRegisterStatusForSesOutcome(open[open.length - 1]);
  const accepted = history.filter((entry) => entry.status === "accepted");
  if (accepted.length > 0) return guestRegisterStatusForSesOutcome(accepted[accepted.length - 1]);
  return guestRegisterStatusForSesOutcome(history[history.length - 1]);
}

function withDetails<T extends HttpError>(error: T, details: unknown): T {
  error.details = details;
  return error;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ───────────────────────────────────────────── views

export type SesSubmissionView = {
  id: string;
  propertyId: string;
  guestRegisterRecordId: string;
  reservationId: string | null;
  externalReference: string | null;
  submissionType: string;
  status: SesStatus;
  endpoint: string | null;
  acknowledgementCode: string | null;
  trackingNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Establishment fields that blocked the communication (SES_ESTABLISHMENT_INCOMPLETE). */
  missing: string[];
  attempts: number;
  signatureMode: string | null;
  correlationId: string | null;
  /** Not accepted 24 h after being queued (RD 933/2021). */
  overdue: boolean;
  submittedAt: string | undefined;
  acknowledgedAt: string | undefined;
  nextRetryAt: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export function isSesSubmissionOverdue(row: Pick<SesRow, "status" | "createdAt"> & Partial<Pick<SesRow, "errorCode">>, now: Date = new Date()): boolean {
  // A row the operator discarded is closed history: the 24 h clock no longer applies to it (Tanda L5 · L5-B2).
  if (row.errorCode === SES_DISCARDED_CODE) return false;
  return SES_UNRESOLVED_STATUSES.includes(row.status) && row.createdAt.getTime() < now.getTime() - SES_OVERDUE_MS;
}

export function toSesSubmissionView(row: SesRow, now: Date = new Date()): SesSubmissionView {
  const response = jsonObject(row.responsePayloadJson);
  const missing = Array.isArray(response.missing) ? response.missing.map(String) : [];
  return {
    id: row.id,
    propertyId: row.propertyId,
    guestRegisterRecordId: row.guestRegisterRecordId,
    reservationId: row.reservationId,
    externalReference: row.externalReference,
    submissionType: row.submissionType,
    status: row.status,
    endpoint: row.endpoint,
    acknowledgementCode: row.acknowledgementCode,
    trackingNumber: row.trackingNumber,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    missing,
    attempts: row.attempts,
    signatureMode: row.signatureMode,
    correlationId: row.correlationId,
    overdue: isSesSubmissionOverdue(row, now),
    submittedAt: row.submittedAt?.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString(),
    nextRetryAt: row.nextRetryAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

// ───────────────────────────────────────────── establishment (contract F)

export type SesEstablishmentResolution = {
  ok: boolean;
  missing: SesEstablishmentIssue[];
  /** Non-blocking notes (sandbox placeholder NIF, production NIF problem…). */
  warnings: string[];
  establishment: {
    registryNumber: string | null;
    taxId: string | null;
    legalName: string | null;
    address: string | null;
    municipality: string | null;
    municipalityCode: string | null;
    province: string | null;
    postalCode: string | null;
    country: string;
  };
};

/**
 * Establishment block for the SES comunicación, resolved from the property
 * profile (address, INE code, postal code…), the per-property registry number
 * (PropertyComplianceSetting.sesRegistryNumber) and the issuer identity
 * (NIF / razón social, same policy as invoices). Never falls back to defaults:
 * whatever is missing is listed in `missing` so the hotel fixes its profile.
 */
export async function resolveSesEstablishment(propertyId: string): Promise<SesEstablishmentResolution> {
  const [property, setting] = await Promise.all([
    prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        address: true,
        municipality: true,
        province: true,
        postalCode: true,
        ineMunicipalityCode: true,
        country: true
      }
    }),
    prisma.propertyComplianceSetting.findUnique({ where: { propertyId }, select: { sesRegistryNumber: true } })
  ]);
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  const warnings: string[] = [];
  let taxId: string | null = null;
  // Tanda 6b (C8): the razón social comes from the sociedad via resolveIssuerIdentity
  // below; Property.legalName is deprecated (a hotel's trade name, never the issuer).
  let legalName: string | null = null;
  try {
    const issuer = await requireIssuerIdentity(propertyId);
    taxId = issuer.taxId;
    legalName = issuer.legalName;
    if (issuer.placeholder) {
      warnings.push("NIF de sandbox (placeholder): configura el NIF real de la organización antes de pasar a modo real.");
    }
  } catch (error) {
    // Production without a checksum-valid NIF: same 409 policy as invoicing.
    // The establishment is reported as incomplete (taxId) instead of thrown so
    // the caller sees every missing field at once.
    if (!(error instanceof ConflictError)) throw error;
    warnings.push(error.message);
    const identity = await resolveIssuerIdentity(propertyId);
    if (identity) legalName = identity.legalName;
  }

  const establishment: SesEstablishmentResolution["establishment"] = {
    registryNumber: setting?.sesRegistryNumber?.trim() || null,
    taxId,
    legalName,
    address: property.address?.trim() || null,
    municipality: property.municipality?.trim() || null,
    municipalityCode: property.ineMunicipalityCode?.trim() || null,
    province: property.province?.trim() || null,
    postalCode: property.postalCode?.trim() || null,
    country: property.country?.trim() || "ES"
  };
  const validation = validateSesEstablishment(establishment);
  return { ok: validation.ok, missing: validation.missing, warnings, establishment };
}

function establishmentErrorCode(missing: SesEstablishmentIssue[]): string {
  return missing.length === 1 && missing[0] === "taxId" ? ISSUER_TAX_ID_MISSING_CODE : SES_ESTABLISHMENT_INCOMPLETE_CODE;
}

function establishmentErrorMessage(missing: SesEstablishmentIssue[]): string {
  return `El establecimiento no está completo para SES.HOSPEDAJES: ${missing.map(describeSesEstablishmentIssue).join(" ")}`;
}

// ───────────────────────────────────────────── actor context

/**
 * Actor for jobs that run without a request (scheduler, retries): the
 * property's organization with a system user, so audit and domain events are
 * attributed to the right tenant instead of the demo org.
 */
export async function systemContextForProperty(propertyId: string): Promise<UserContext | null> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true } });
  if (!property) return null;
  return {
    organizationId: property.organizationId,
    propertyId: property.id,
    userId: "system",
    fullName: "Programador SES.HOSPEDAJES",
    deviceId: "scheduler",
    permissions: []
  };
}

// ───────────────────────────────────────────── queue / process

let sesChain: Promise<void> = Promise.resolve();

function schedule(submissionId: string, context: UserContext, correlationId: string): void {
  sesChain = sesChain.then(async () => {
    try {
      await processSubmission({ submissionId, context, correlationId });
    } catch (error) {
      // Honest catch (QC-06): the failure is persisted on the row so the SES
      // dashboard shows it, and logged with correlation — never swallowed.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ses] processing failed for submission ${submissionId} (correlation ${correlationId}): ${message}`);
      await prisma.sesHospedajesSubmission
        .update({
          where: { id: submissionId },
          data: { status: "failed", errorCode: "PROCESSING_ERROR", errorMessage: message, nextRetryAt: null }
        })
        .catch((persistError: unknown) => {
          console.error(`[ses] could not persist processing failure for ${submissionId}:`, persistError instanceof Error ? persistError.message : persistError);
        });
    }
  });
}

/**
 * True when the MIR currently holds a registration for the reservation: the
 * newest accepted comunicación is an alta/modificación. An accepted baja
 * revokes it, so the next comunicación is derived as a fresh alta (and
 * annulAuthorityCommunication does not queue a second baja).
 */
export async function hasAcceptedSesSubmission(reservationId: string): Promise<boolean> {
  const latestAccepted = await prisma.sesHospedajesSubmission.findFirst({
    where: { reservationId, status: "accepted" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { submissionType: true }
  });
  return latestAccepted !== null && latestAccepted.submissionType !== SES_BAJA_TYPE;
}

export async function queueSesSubmission(input: {
  guestRegisterRecordId: string;
  reservationId?: string;
  /** Explicit A/M/B; derived from the reservation history when omitted. */
  submissionType?: SesSubmissionType;
  /** Business trigger (legacy API values); only `cancellation` changes the derivation. */
  trigger?: "reservation" | "checkin" | "cancellation";
  context: UserContext;
  correlationId: string;
}): Promise<SesSubmissionView> {
  const record = await prisma.guestRegisterRecord.findUnique({ where: { id: input.guestRegisterRecordId } });
  if (!record) throw new NotFoundError("Registro de viajero no encontrado.");
  const reservationId = input.reservationId ?? record.reservationId;
  if (!reservationId) {
    throw withDetails(new ConflictError("El parte de viajeros no está vinculado a ninguna reserva."), { code: "RESERVATION_MISSING", guestRegisterRecordId: record.id });
  }
  const [reservation, sesEnabled] = await Promise.all([
    prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true, status: true } }),
    sesHospedajesEnabledFor(record.propertyId)
  ]);
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  if (sesEnabled === null) throw new NotFoundError("Propiedad no encontrada.");

  const submissionType =
    input.submissionType ??
    deriveSesSubmissionType({
      trigger: input.trigger ?? null,
      reservationStatus: reservation.status,
      recordType: record.recordType,
      hasAcceptedPrevious: await hasAcceptedSesSubmission(reservationId)
    });

  // Honest refusal (Tanda L5 · L5-B2): NO row is created, the refusal is
  // audited (SES_HOSPEDAJES_SUBMISSION_REFUSED) and the 409 carries a typed
  // code the drawer / inbox can act on.
  const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): never => {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: record.propertyId,
      actorUserId: input.context.userId,
      // Corrector L5 (CS-07): la negativa la inicia quien pide el envío (usuario) o el sistema (scheduler).
      actorType: input.context.userId ? "user" : "system",
      action: SES_SUBMISSION_REFUSED_ACTION,
      entityType: "guest_register_record",
      entityId: record.id,
      afterJson: { code, submissionType, reason: message, ...extra },
      correlationId: input.correlationId
    });
    throw withDetails(new ConflictError(message), {
      code,
      guestRegisterRecordId: record.id,
      propertyId: record.propertyId,
      reservationId,
      submissionType,
      submissionId: null,
      ...extra
    });
  };

  // (1) The property must have SES.HOSPEDAJES switched on (either flag, CS-01).
  // Corrector L5 (CS-09): a baja is never gated by the switch — a property that
  // switched SES off after accepted altas must still be able to revoke them.
  if (!sesEnabled && submissionType !== SES_BAJA_TYPE) {
    refuse(SES_DISABLED_CODE, "SES.HOSPEDAJES está desactivado para este establecimiento: actívalo en Ajustes de cumplimiento.");
  }

  // (2) Alta / modificación: the parte must be legally sendable — not a
  // rewritten historical (accepted / annulled / expired) and valid over its
  // PERSISTED columns (same verdict queueGuestAuthoritySubmission applies).
  if (submissionType !== SES_BAJA_TYPE) {
    const gate = sesQueueGateForRecord(record.status, submissionType);
    if (gate) refuse(gate.code, gate.message, { status: record.status });
    const validation = validateSpainGuestRegisterRecord(guestRegisterValidationInput(record));
    if (!validation.valid) {
      refuse(GUEST_REGISTER_INVALID_CODE, `El parte de viajeros no se puede enviar: ${validation.issues.map((issue) => issue.code).join(", ")}.`, {
        status: record.status,
        issues: validation.issues
      });
    }
  }

  // An open comunicación of the same type is never duplicated: the pipeline
  // still owes an answer for it (retry / scheduler reuse that row).
  const inFlight = await prisma.sesHospedajesSubmission.findFirst({
    where: { guestRegisterRecordId: record.id, submissionType, status: { in: [...SES_OPEN_STATUSES] } },
    select: { id: true, status: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  if (inFlight) {
    refuse(SES_SUBMISSION_IN_FLIGHT_CODE, `El parte ya tiene una comunicación SES.HOSPEDAJES en curso (estado «${inFlight.status}»): no se duplica.`, {
      submissionId: inFlight.id,
      status: inFlight.status
    });
  }

  // (3) A `failed` row parked for a recoverable cause (establishment / NIF) is
  // REUSED — refreshed while the profile stays incomplete, re-queued once it is
  // complete — instead of leaving one more row per attempt (126 rows of the
  // same parte in the demo before Tanda L5).
  const reusable = await prisma.sesHospedajesSubmission.findFirst({
    where: { guestRegisterRecordId: record.id, submissionType, status: "failed", errorCode: { in: [...SES_RECOVERABLE_ERROR_CODES] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const now = new Date();

  const establishment = await resolveSesEstablishment(record.propertyId);
  if (!establishment.ok) {
    const errorCode = establishmentErrorCode(establishment.missing);
    const errorMessage = establishmentErrorMessage(establishment.missing);
    let blocked: SesRow;
    if (reusable) {
      const previous = jsonObject(reusable.responsePayloadJson);
      blocked = await prisma.sesHospedajesSubmission.update({
        where: { id: reusable.id },
        data: {
          errorCode,
          errorMessage,
          nextRetryAt: null,
          correlationId: input.correlationId,
          requestPayloadJson: asJson({ reason: errorCode, trigger: input.trigger ?? null, reusedAt: now.toISOString() }),
          responsePayloadJson: asJson({
            ...previous,
            missing: establishment.missing,
            warnings: establishment.warnings,
            blockedAttempts: (typeof previous.blockedAttempts === "number" ? previous.blockedAttempts : 1) + 1,
            lastBlockedAt: now.toISOString()
          })
        }
      });
    } else {
      blocked = await prisma.sesHospedajesSubmission.create({
        data: {
          propertyId: record.propertyId,
          guestRegisterRecordId: record.id,
          reservationId,
          submissionType,
          status: "failed",
          requestPayloadJson: asJson({ reason: errorCode, trigger: input.trigger ?? null }),
          responsePayloadJson: asJson({ missing: establishment.missing, warnings: establishment.warnings, blockedAttempts: 1, lastBlockedAt: now.toISOString() }),
          errorCode,
          errorMessage,
          attempts: 0,
          nextRetryAt: null,
          correlationId: input.correlationId
        }
      });
    }
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: record.propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "SES_HOSPEDAJES_SUBMISSION_BLOCKED",
      entityType: "ses_hospedajes_submission",
      entityId: blocked.id,
      afterJson: { errorCode, missing: establishment.missing, submissionType, reused: Boolean(reusable) },
      correlationId: input.correlationId
    });
    throw withDetails(new ConflictError(errorMessage), {
      code: errorCode,
      missing: establishment.missing,
      submissionId: blocked.id,
      propertyId: record.propertyId,
      reused: Boolean(reusable)
    });
  }

  let row: SesRow;
  if (reusable) {
    row = await prisma.sesHospedajesSubmission.update({
      where: { id: reusable.id },
      data: {
        status: "queued",
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
        correlationId: input.correlationId,
        requestPayloadJson: asJson({ trigger: input.trigger ?? null, queuedBy: input.context.userId, requeuedFrom: reusable.errorCode })
      }
    });
  } else {
    row = await prisma.sesHospedajesSubmission.create({
      data: {
        propertyId: record.propertyId,
        guestRegisterRecordId: record.id,
        reservationId,
        submissionType,
        status: "queued",
        requestPayloadJson: asJson({ trigger: input.trigger ?? null, queuedBy: input.context.userId }),
        correlationId: input.correlationId
      }
    });
  }
  await mirrorGuestRegisterStatus(record.id, "queued");

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "SES_HOSPEDAJES_SUBMISSION_QUEUED",
    entityType: "ses_hospedajes_submission",
    entityId: row.id,
    afterJson: { submissionType, guestRegisterRecordId: record.id, reservationId, reused: Boolean(reusable) },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    entityType: "guest_register_record",
    entityId: record.id,
    eventType: "SesHospedajesSubmissionQueued",
    payload: { submissionId: row.id, submissionType },
    actorType: "system",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  schedule(row.id, input.context, input.correlationId);
  return toSesSubmissionView(row);
}

export async function retrySesSubmission(submissionId: string, context?: UserContext): Promise<SesSubmissionView> {
  const row = await prisma.sesHospedajesSubmission.findUnique({ where: { id: submissionId } });
  if (!row) throw new NotFoundError("Envío SES no encontrado.");
  if (row.status === "accepted") throw new ConflictError("El envío ya fue aceptado por el MIR; no se puede reintentar.");
  // Tanda L5 (L5-B2): a discarded row is closed history — the operator chose
  // not to send it; a fresh comunicación is queued from the parte instead.
  if (row.errorCode === SES_DISCARDED_CODE) {
    throw withDetails(new ConflictError("El envío fue descartado por el operador y no se reintenta: encola una comunicación nueva desde el parte."), {
      code: SES_DISCARDED_CODE,
      submissionId: row.id
    });
  }
  const actor = context ?? (await systemContextForProperty(row.propertyId));
  if (!actor) throw new NotFoundError("Propiedad no encontrada.");
  // Corrector L5 (CS-02): the retry applies the SAME gates as the queue — switch
  // (CS-01 OR, never for a baja), parte status (an accepted / annulled / expired
  // parte is never re-sent as alta) and the validator over the persisted columns —
  // so a legacy parked row cannot reach the MIR through the back door.
  const gate = await sesRequeueGate(row);
  if (gate) {
    throw withDetails(new ConflictError(gate.message), { code: gate.code, submissionId: row.id, guestRegisterRecordId: row.guestRegisterRecordId, ...(gate.extra ?? {}) });
  }
  const requeued = await prisma.sesHospedajesSubmission.update({
    where: { id: row.id },
    data: { status: "queued", nextRetryAt: null }
  });
  schedule(row.id, actor, `retry_${row.id}_${row.attempts + 1}`);
  return toSesSubmissionView(requeued);
}

type SesRequeueGate = {
  code: string;
  message: string;
  extra?: Record<string, unknown>;
  /** true = the cause is the property (switch off): the row stays parked; false = the parte itself is not sendable. */
  recoverable: boolean;
};

/**
 * Why a parked row must NOT be re-queued right now (null = it may). Shared by the
 * manual retry, the scheduler and processSubmission (corrector L5 · CS-02).
 */
async function sesRequeueGate(row: Pick<SesRow, "propertyId" | "guestRegisterRecordId" | "submissionType">): Promise<SesRequeueGate | null> {
  const isBaja = row.submissionType === SES_BAJA_TYPE;
  const [enabled, record] = await Promise.all([sesHospedajesEnabledFor(row.propertyId), prisma.guestRegisterRecord.findUnique({ where: { id: row.guestRegisterRecordId } })]);
  if (enabled === null) return { code: "PROPERTY_NOT_FOUND", message: "Propiedad no encontrada.", recoverable: false };
  if (!record) return { code: "GUEST_REGISTER_RECORD_NOT_FOUND", message: "El parte de viajeros ya no existe.", recoverable: false };
  if (!enabled && !isBaja) {
    return { code: SES_DISABLED_CODE, message: "SES.HOSPEDAJES está desactivado para este establecimiento: actívalo en Ajustes de cumplimiento.", recoverable: true };
  }
  if (isBaja) return null;
  const statusGate = sesQueueGateForRecord(record.status, row.submissionType as SesSubmissionType);
  if (statusGate) return { ...statusGate, extra: { status: record.status }, recoverable: false };
  const validation = validateSpainGuestRegisterRecord(guestRegisterValidationInput(record));
  if (!validation.valid) {
    return {
      code: GUEST_REGISTER_INVALID_CODE,
      message: `El parte de viajeros no se puede enviar: ${validation.issues.map((issue) => issue.code).join(", ")}.`,
      extra: { status: record.status, issues: validation.issues },
      recoverable: false
    };
  }
  return null;
}

const DiscardFailedSesSubmissionsSchema = z.object({
  propertyId: z.string().trim().min(1),
  reason: z.string().trim().min(5, "El motivo del descarte debe tener al menos 5 caracteres."),
  submissionIds: z.array(z.string().trim().min(1)).min(1).optional(),
  dryRun: z.boolean().optional()
});

export type DiscardFailedSesSubmissionsResult = {
  /** Rows discarded (or, with dryRun, that would be). */
  discarded: number;
  ids: string[];
  dryRun: boolean;
  /** `failed` rows with a recoverable code still parked for the property after the call. */
  recoverableLeft: number;
};

/**
 * Operator discard of `failed` rows (Tanda L5 · L5-B2). Targets the rows of
 * the property parked with a RECOVERABLE code (establishment / NIF) — or the
 * explicit `submissionIds`, any failed code but an already discarded one — and
 * closes them: errorCode SES_DISCARDED, errorMessage «Descartado por el
 * operador: <reason>», nextRetryAt null, responsePayloadJson.discarded
 * { by, at, reason, previousErrorCode }. The status stays `failed` (the
 * SubmissionStatus enum has no other honest value); the scheduler only re-queues
 * recoverable codes and retrySesSubmission answers 409 SES_DISCARDED, so the
 * row can never reach the MIR. One SES_HOSPEDAJES_SUBMISSION_DISCARDED audit
 * per row. Permission: compliance.ses.submit; the property must belong to the
 * caller's organisation (opaque 404 otherwise). `dryRun` only counts.
 * No HTTP route (decision of Tanda L5): apps/api/src/scripts/discard-failed-ses-submissions.ts.
 */
/** One `failed` row → SES_DISCARDED (closed history) + SES_HOSPEDAJES_SUBMISSION_DISCARDED audit. Shared by the operator discard and the scheduler collapse. */
async function discardSesSubmissionRow(input: {
  row: Pick<SesRow, "id" | "status" | "errorCode" | "responsePayloadJson" | "guestRegisterRecordId" | "submissionType" | "propertyId">;
  context: UserContext;
  reason: string;
  actorType: "user" | "system";
  correlationId: string;
  /** Extra audit fields (e.g. the row that superseded this one). */
  extra?: Record<string, unknown>;
}): Promise<void> {
  const at = new Date();
  const previous = jsonObject(input.row.responsePayloadJson);
  await prisma.sesHospedajesSubmission.update({
    where: { id: input.row.id },
    data: {
      errorCode: SES_DISCARDED_CODE,
      errorMessage: `Descartado por ${input.actorType === "user" ? "el operador" : "el sistema"}: ${input.reason}`,
      nextRetryAt: null,
      responsePayloadJson: asJson({
        ...previous,
        discarded: { by: input.context.userId, at: at.toISOString(), reason: input.reason, previousErrorCode: input.row.errorCode, ...(input.extra ?? {}) }
      })
    }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.row.propertyId,
    actorUserId: input.context.userId,
    actorType: input.actorType,
    action: SES_SUBMISSION_DISCARDED_ACTION,
    entityType: "ses_hospedajes_submission",
    entityId: input.row.id,
    beforeJson: { status: input.row.status, errorCode: input.row.errorCode },
    afterJson: {
      status: "failed",
      errorCode: SES_DISCARDED_CODE,
      reason: input.reason,
      by: input.context.userId,
      guestRegisterRecordId: input.row.guestRegisterRecordId,
      submissionType: input.row.submissionType,
      ...(input.extra ?? {})
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
}

export async function discardFailedSesSubmissions(input: {
  context: UserContext;
  propertyId: string;
  reason: string;
  submissionIds?: string[];
  dryRun?: boolean;
  correlationId?: string;
}): Promise<DiscardFailedSesSubmissionsResult> {
  // Corrector L5 (CS-10): the discard closes comunicaciones for good — it is
  // connector management (compliance.ses.configure), not reception's submit key.
  requirePermissions(input.context, ["compliance.ses.configure"]);
  const body = parse(DiscardFailedSesSubmissionsSchema, {
    propertyId: input.propertyId,
    reason: input.reason,
    submissionIds: input.submissionIds,
    dryRun: input.dryRun
  });
  const property = await prisma.property.findUnique({ where: { id: body.propertyId }, select: { id: true, organizationId: true } });
  if (!property || property.organizationId !== input.context.organizationId) throw new NotFoundError("Propiedad no encontrada.");
  const dryRun = body.dryRun === true;
  const where: Prisma.SesHospedajesSubmissionWhereInput = body.submissionIds
    ? {
        id: { in: body.submissionIds },
        propertyId: property.id,
        status: "failed",
        OR: [{ errorCode: null }, { errorCode: { not: SES_DISCARDED_CODE } }]
      }
    : { propertyId: property.id, status: "failed", errorCode: { in: [...SES_RECOVERABLE_ERROR_CODES] } };
  const rows = await prisma.sesHospedajesSubmission.findMany({
    where,
    select: { id: true, propertyId: true, status: true, errorCode: true, responsePayloadJson: true, guestRegisterRecordId: true, submissionType: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  if (!dryRun) {
    for (const row of rows) {
      await discardSesSubmissionRow({ row, context: input.context, reason: body.reason, actorType: "user", correlationId: input.correlationId ?? `ses_discard_${row.id}` });
    }
  }
  const recoverableLeft = await prisma.sesHospedajesSubmission.count({
    where: { propertyId: property.id, status: "failed", errorCode: { in: [...SES_RECOVERABLE_ERROR_CODES] } }
  });
  return { discarded: rows.length, ids: rows.map((row) => row.id), dryRun, recoverableLeft };
}

async function mirrorGuestRegisterStatus(recordId: string, status: GuestRegisterStatus): Promise<void> {
  await prisma.guestRegisterRecord.updateMany({ where: { id: recordId }, data: { status } });
}

/**
 * Re-derive the parte status from its persisted SES history and write it when
 * it drifted (e.g. a baja accepted while the mirror still mapped every
 * acceptance to `accepted`). Only pipeline-owned statuses are rewritten; a
 * draft/signed/expired parte is never touched. Conditional write (status we
 * read in the WHERE) so a concurrent pipeline update wins. Returns the change,
 * or null when nothing was written.
 */
export async function reconcileGuestRegisterStatus(recordId: string): Promise<{ from: GuestRegisterStatus; to: GuestRegisterStatus } | null> {
  const [record, history] = await Promise.all([
    prisma.guestRegisterRecord.findUnique({ where: { id: recordId }, select: { id: true, status: true } }),
    prisma.sesHospedajesSubmission.findMany({
      where: { guestRegisterRecordId: recordId },
      select: { submissionType: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    })
  ]);
  if (!record || !SES_OWNED_RECORD_STATUSES.includes(record.status)) return null;
  const derived = deriveGuestRegisterStatusFromSesHistory(history);
  if (!derived || derived === record.status) return null;
  const written = await prisma.guestRegisterRecord.updateMany({ where: { id: record.id, status: record.status }, data: { status: derived } });
  return written.count === 1 ? { from: record.status, to: derived } : null;
}

async function failSubmission(input: {
  row: Pick<SesRow, "id" | "guestRegisterRecordId" | "propertyId">;
  context: UserContext;
  correlationId: string;
  errorCode: string;
  errorMessage: string;
  response?: Record<string, unknown>;
}): Promise<void> {
  await prisma.sesHospedajesSubmission.update({
    where: { id: input.row.id },
    data: {
      status: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      responsePayloadJson: input.response ? asJson(input.response) : undefined,
      nextRetryAt: null
    }
  });
  await mirrorGuestRegisterStatus(input.row.guestRegisterRecordId, "failed");
  console.error(`[ses] submission ${input.row.id} failed (${input.errorCode}, correlation ${input.correlationId}): ${input.errorMessage}`);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.row.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "SES_HOSPEDAJES_SUBMISSION_FAILED",
    entityType: "ses_hospedajes_submission",
    entityId: input.row.id,
    afterJson: { errorCode: input.errorCode, errorMessage: input.errorMessage, ...(input.response ?? {}) },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.row.propertyId,
    entityType: "guest_register_record",
    entityId: input.row.guestRegisterRecordId,
    eventType: "AuthoritySubmissionFailed",
    payload: { submissionId: input.row.id, errorCode: input.errorCode, ...(input.response ?? {}) },
    actorType: "system",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
}

async function processSubmission(input: { submissionId: string; context: UserContext; correlationId: string }): Promise<void> {
  const row = await prisma.sesHospedajesSubmission.findUnique({ where: { id: input.submissionId } });
  if (!row) {
    console.error(`[ses] submission ${input.submissionId} not found (correlation ${input.correlationId}).`);
    return;
  }
  if (row.status === "accepted" || row.status === "annulled") return; // idempotent: nothing left to send

  const record = await prisma.guestRegisterRecord.findUnique({ where: { id: row.guestRegisterRecordId } });
  if (!record) {
    await failSubmission({ row, context: input.context, correlationId: input.correlationId, errorCode: "GUEST_REGISTER_RECORD_NOT_FOUND", errorMessage: "El parte de viajeros ya no existe." });
    return;
  }
  const reservationId = row.reservationId ?? record.reservationId;
  if (!reservationId) {
    await failSubmission({ row, context: input.context, correlationId: input.correlationId, errorCode: "RESERVATION_MISSING", errorMessage: "El parte de viajeros no está vinculado a ninguna reserva." });
    return;
  }
  const [property, reservation, primaryGuestLink] = await Promise.all([
    prisma.property.findUnique({ where: { id: row.propertyId }, select: { id: true } }),
    prisma.reservation.findUnique({ where: { id: reservationId } }),
    prisma.reservationGuest.findFirst({ where: { reservationId, isPrimary: true } })
  ]);
  if (!property || !reservation) {
    await failSubmission({ row, context: input.context, correlationId: input.correlationId, errorCode: "RESERVATION_NOT_FOUND", errorMessage: "La reserva o la propiedad del parte ya no existen." });
    return;
  }

  // Corrector L5 (CS-02): the pipeline re-checks the switch and the parte (status
  // gate + validator) right before sending — a row queued by a legacy path or a
  // parte accepted meanwhile never reaches the MIR.
  const requeueGate = await sesRequeueGate(row);
  if (requeueGate) {
    await failSubmission({
      row,
      context: input.context,
      correlationId: input.correlationId,
      errorCode: requeueGate.code,
      errorMessage: requeueGate.message,
      response: requeueGate.extra
    });
    return;
  }

  // FISC-08: establishment resolved live, never defaulted. A missing NIF in
  // production (ISSUER_TAX_ID_MISSING) or any other missing field leaves a
  // failed row the scheduler re-queues once the profile is complete.
  const establishment = await resolveSesEstablishment(property.id);
  if (!establishment.ok) {
    await failSubmission({
      row,
      context: input.context,
      correlationId: input.correlationId,
      errorCode: establishmentErrorCode(establishment.missing),
      errorMessage: establishmentErrorMessage(establishment.missing),
      response: { missing: establishment.missing, warnings: establishment.warnings }
    });
    return;
  }

  const allLinks = await prisma.reservationGuest.findMany({ where: { reservationId } });
  const guestIds = allLinks.map((l) => l.guestId);
  const [guests, partes] = await Promise.all([
    guestIds.length ? prisma.guest.findMany({ where: { id: { in: guestIds } } }) : Promise.resolve([]),
    // Corrector L5 (CS-03): one parte per traveller (ensureReservationGuestRegisterRecords)
    // carries sex, residence and the minor block the comunicación must communicate.
    prisma.guestRegisterRecord.findMany({
      where: { reservationId },
      select: { guestId: true, sex: true, residenceLocality: true, residenceCountry: true, residenceFullAddress: true, isMinor: true, kinshipRelationIfMinor: true, providedByAdultGuestId: true }
    })
  ]);
  const primaryGuestId = primaryGuestLink?.guestId ?? record.guestId ?? undefined;
  const parteByGuest = new Map(partes.filter((parte) => parte.guestId).map((parte) => [parte.guestId as string, parte]));
  const parteFor = (guestId: string) => parteByGuest.get(guestId) ?? (guestId === primaryGuestId ? record : undefined);
  /** Sex / residence / minor block of one traveller from its parte (falls back to the profile). */
  const legalBlockFor = (guest: (typeof guests)[number]) => {
    const parte = parteFor(guest.id);
    const isMinor = parte?.isMinor === true;
    const adult = isMinor
      ? (guests.find((candidate) => candidate.id === parte?.providedByAdultGuestId) ?? guests.find((candidate) => candidate.id === primaryGuestId && candidate.id !== guest.id))
      : undefined;
    return {
      sex: guest.sex ?? parte?.sex,
      residenceLocality: guest.residenceLocality ?? parte?.residenceLocality,
      residenceProvince: guest.residenceProvince,
      residencePostalCode: guest.residencePostalCode,
      residenceCountry: guest.residenceCountry ?? parte?.residenceCountry,
      isMinor,
      kinshipRelationIfMinor: parte?.kinshipRelationIfMinor,
      parentName: adult ? [adult.firstName, adult.surname1, adult.surname2].filter(Boolean).join(" ") : undefined,
      parentDocumentNumber: adult?.documentNumber ?? (adult && adult.id === primaryGuestId ? record.documentNumber : undefined)
    };
  };

  // Tanda L5 (L5-B2): no placeholders (1900-01-01 / ESP / DNI / "") — a
  // traveller without the legal fields fails the row with GUEST_REGISTER_INVALID
  // (not recoverable by the scheduler) instead of reaching the MIR with markers.
  const sesGuests: SesGuest[] = [];
  const invalidGuests: Array<{ guestId: string; missing: string[] }> = [];
  const primary = guests.find((g) => g.id === primaryGuestId);
  if (primary) {
    const mapped = sesGuestFromSource({
      documentType: primary.documentType ?? record.documentType,
      documentNumber: primary.documentNumber ?? record.documentNumber,
      documentSupportNumber: primary.documentSupportNumber ?? record.documentSupportNumber,
      firstName: primary.firstName,
      surname1: primary.surname1 ?? record.surname1,
      surname2: primary.surname2 ?? record.surname2,
      dateOfBirth: primary.dateOfBirth ?? record.dateOfBirth,
      nationality: primary.nationality ?? record.nationality,
      phone: primary.mobilePhone ?? primary.phone ?? record.phoneMobile ?? record.phoneLandline,
      email: primary.email ?? record.email,
      residenceAddress: primary.residenceAddress ?? record.residenceFullAddress,
      ...legalBlockFor(primary)
    });
    if (mapped.ok) sesGuests.push(mapped.guest);
    else invalidGuests.push({ guestId: primary.id, missing: mapped.missing });
  }
  for (const guest of guests) {
    if (guest.id === primaryGuestId) continue;
    const mapped = sesGuestFromSource({
      documentType: guest.documentType,
      documentNumber: guest.documentNumber,
      documentSupportNumber: guest.documentSupportNumber,
      firstName: guest.firstName,
      surname1: guest.surname1,
      surname2: guest.surname2,
      dateOfBirth: guest.dateOfBirth,
      nationality: guest.nationality,
      phone: guest.mobilePhone ?? guest.phone,
      email: guest.email,
      residenceAddress: guest.residenceAddress ?? parteFor(guest.id)?.residenceFullAddress,
      ...legalBlockFor(guest)
    });
    if (mapped.ok) sesGuests.push(mapped.guest);
    else invalidGuests.push({ guestId: guest.id, missing: mapped.missing });
  }
  if (invalidGuests.length > 0) {
    const missingFields = [...new Set(invalidGuests.flatMap((entry) => entry.missing))];
    await failSubmission({
      row,
      context: input.context,
      correlationId: input.correlationId,
      errorCode: GUEST_REGISTER_INVALID_CODE,
      errorMessage: `El parte de viajeros no tiene los datos obligatorios para SES.HOSPEDAJES (${invalidGuests.length === 1 ? "1 viajero" : `${invalidGuests.length} viajeros`}): faltan ${missingFields.join(", ")}.`,
      response: { missingGuestFields: missingFields, invalidGuests }
    });
    return;
  }
  if (sesGuests.length === 0) {
    await failSubmission({ row, context: input.context, correlationId: input.correlationId, errorCode: "NO_GUESTS", errorMessage: "La reserva no tiene huéspedes vinculados que comunicar." });
    return;
  }

  const submissionType = row.submissionType as SesSubmissionType;
  // Deterministic `CODIGO_RESERVA-TIPO-INTENTO`: next attempt after every
  // reference already used for this reservation + type (siblings and retries).
  const siblings = await prisma.sesHospedajesSubmission.findMany({
    where: { reservationId, submissionType },
    select: { externalReference: true }
  });
  const externalReference = nextSesExternalReference(reservation.code, submissionType, siblings.map((s) => s.externalReference));

  const e = establishment.establishment;
  const submissionRecord: SesSubmissionRecord = {
    submissionType,
    externalReference,
    establishment: {
      taxId: e.taxId!,
      legalName: e.legalName!,
      registryNumber: e.registryNumber!,
      registryType: "establecimiento_turistico",
      address: e.address!,
      municipalityCode: e.municipalityCode!,
      province: e.province!,
      postalCode: e.postalCode!,
      country: e.country
    },
    contract: {
      contractRef: reservation.code,
      contractDate: reservation.createdAt.toISOString(),
      checkinDate: reservation.arrivalDate.toISOString().slice(0, 10),
      checkoutDate: reservation.departureDate.toISOString().slice(0, 10),
      contractType: "alojamiento",
      numberOfPersons: reservation.adults + reservation.children,
      paymentMethod: "card",
      paymentReference: reservation.code,
      totalAmount: Number(reservation.totalAmount),
      internetAccess: true
    },
    guests: sesGuests
  };

  const xml = buildSesHospedajesXml(submissionRecord);
  const signed = await signSubmissionXml({
    xml,
    certPath: process.env.SES_HOSPEDAJES_CERT_PATH,
    certPassphrase: process.env.SES_HOSPEDAJES_CERT_PASSPHRASE
  });

  // Guest PII stays in the signed XML only; the request snapshot keeps the
  // establishment + contract (no document numbers, e-mails or phones).
  await prisma.sesHospedajesSubmission.update({
    where: { id: row.id },
    data: {
      externalReference,
      status: "sent",
      requestPayloadJson: asJson({
        establishment: submissionRecord.establishment,
        contract: submissionRecord.contract,
        guestCount: sesGuests.length,
        guestRegisterRecordId: record.id
      }),
      xmlPayload: signed.signedXml,
      attempts: { increment: 1 },
      submittedAt: new Date(),
      signatureMode: signed.signatureMode,
      signedAt: new Date(signed.signedAt),
      correlationId: input.correlationId,
      errorCode: null,
      errorMessage: null
    }
  });
  await mirrorGuestRegisterStatus(record.id, "submitted");

  const response = await submitSesHospedajesComunicacion({
    externalReference,
    establishmentTaxId: submissionRecord.establishment.taxId,
    xmlPayload: signed.signedXml
  });

  const attempts = row.attempts + 1;
  const exhausted = response.status === "network_error" && attempts >= SES_MAX_ATTEMPTS;
  const finalStatus: SesStatus =
    response.status === "accepted" || response.status === "accepted_with_warnings"
      ? "accepted"
      : response.status === "rejected"
        ? "rejected"
        : exhausted
          ? "failed"
          : "retrying";

  await prisma.sesHospedajesSubmission.update({
    where: { id: row.id },
    data: {
      status: finalStatus,
      endpoint: response.endpoint,
      acknowledgementCode: response.acknowledgementCode ?? null,
      trackingNumber: response.trackingNumber ?? null,
      errorCode: exhausted ? "MAX_ATTEMPTS_EXCEEDED" : (response.errorCode ?? null),
      errorMessage: exhausted ? `Sin respuesta del MIR tras ${attempts} intentos: ${response.errorMessage ?? "error de red"}.` : (response.errorMessage ?? null),
      responseAck: response.rawResponse ?? null,
      responsePayloadJson: asJson({
        ack: response.rawResponse ?? null,
        status: response.status,
        warnings: establishment.warnings
      }),
      acknowledgedAt: finalStatus === "accepted" ? new Date() : null,
      nextRetryAt: finalStatus === "retrying" ? new Date(Date.now() + SES_RETRY_DELAY_MS) : null
    }
  });
  // An accepted baja leaves the parte `annulled`, an accepted alta/modificación `accepted`.
  const guestRegisterStatus = guestRegisterStatusForSesOutcome({ submissionType, status: finalStatus });
  await mirrorGuestRegisterStatus(record.id, guestRegisterStatus);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "SES_HOSPEDAJES_SUBMISSION",
    entityType: "guest_register_record",
    entityId: record.id,
    afterJson: {
      submissionId: row.id,
      externalReference,
      submissionType,
      status: finalStatus,
      guestRegisterStatus,
      attempts,
      acknowledgementCode: response.acknowledgementCode,
      trackingNumber: response.trackingNumber,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage
    },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: property.id,
    entityType: "guest_register_record",
    entityId: record.id,
    eventType:
      finalStatus === "accepted"
        ? "AuthoritySubmissionAccepted"
        : finalStatus === "rejected"
          ? "AuthoritySubmissionRejected"
          : finalStatus === "failed"
            ? "AuthoritySubmissionFailed"
            : "AuthoritySubmissionPending",
    payload: {
      submissionId: row.id,
      submissionType,
      externalReference,
      acknowledgementCode: response.acknowledgementCode,
      trackingNumber: response.trackingNumber,
      status: finalStatus
    },
    actorType: "system",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
}

function toSesGuest(input: {
  documentType?: string;
  documentNumber?: string;
  documentSupportNumber?: string;
  firstName: string;
  surname1: string;
  surname2?: string;
  dateOfBirth: string;
  nationality: string;
  phone?: string;
  email?: string;
  residenceAddress?: string;
  gender?: SesGuest["gender"];
  residenceMunicipality?: string;
  residenceProvince?: string;
  residencePostalCode?: string;
  residenceCountry?: string;
  isMinor?: boolean;
  relationshipToMinor?: string;
  parentName?: string;
  parentDocumentNumber?: string;
}): SesGuest {
  const docType = input.documentType?.toUpperCase();
  const mapped: SesGuest["documentType"] = !input.documentNumber
    ? undefined
    : docType === "NIE" ? "NIE" : docType === "PASSPORT" || docType === "PASAPORTE" ? "PASSPORT" : docType === "TIE" ? "TIE" : "DNI";
  return {
    documentType: mapped,
    documentNumber: input.documentNumber,
    documentSupportNumber: input.documentSupportNumber,
    firstName: input.firstName,
    surname1: input.surname1,
    surname2: input.surname2,
    dateOfBirth: input.dateOfBirth,
    nationality: input.nationality,
    // Corrector L5 (CS-03): sexo, residencia y bloque de menor viajan al MIR.
    gender: input.gender,
    phone: input.phone,
    email: input.email,
    residenceAddress: input.residenceAddress,
    residenceMunicipality: input.residenceMunicipality,
    residenceProvince: input.residenceProvince,
    residencePostalCode: input.residencePostalCode,
    residenceCountry: input.residenceCountry,
    isMinor: input.isMinor,
    relationshipToMinor: input.relationshipToMinor,
    parentName: input.parentName,
    parentDocumentNumber: input.parentDocumentNumber
  };
}

// ───────────────────────────────────────────── scheduler

export type SesSchedulerResult = {
  /** `retrying` rows whose nextRetryAt elapsed and were re-queued. */
  retried: number;
  /** `failed` rows with a recoverable code re-queued because the establishment now passes. */
  recovered: number;
  /** Recoverable rows left alone because their property profile is still incomplete (or the switch is off). */
  blocked: number;
  /** Corrector L5 (CS-02): older parked rows of the same parte + type discarded (one recoverable row per parte). */
  superseded: number;
  /** Corrector L5 (CS-02): parked rows whose parte is accepted / annulled / expired, discarded (never re-sent). */
  notQueueable: number;
  /** Corrector L5 (CS-02): parked rows whose parte does not validate, failed for good with GUEST_REGISTER_INVALID. */
  invalid: number;
  /** Open rows older than 24 h (RD 933/2021). */
  overdue: number;
  /** Overdue rows that emitted AuthoritySubmissionOverdue in this tick (once per row). */
  overdueNotified: number;
  /** Partes with an accepted baja whose status drifted from `annulled` and were rewritten from their SES history. */
  reconciled: number;
  failed: Array<{ id: string; error: string }>;
};

/**
 * SES Hospedajes scheduler tick (5 min). Idempotent and safe on an interval:
 *   1. re-queue `retrying` rows whose nextRetryAt elapsed;
 *   2. re-queue `failed` rows with a recoverable code (establishment / NIF)
 *      once resolveSesEstablishment passes for their property;
 *   3. emit AuthoritySubmissionOverdue ONCE per open row older than 24 h and
 *      report the total so /compliance/health and the inbox can surface it;
 *   4. reconcile partes with an accepted baja that are not `annulled` (status
 *      drift from before the per-type mirror) from their SES history.
 * The `context` argument is ignored: every action runs with the system context
 * of the row's property (organizationId from Prisma), never the demo user.
 */
export async function runDueSesSubmissions(_context?: UserContext): Promise<SesSchedulerResult> {
  const now = new Date();
  const result: SesSchedulerResult = { retried: 0, recovered: 0, blocked: 0, superseded: 0, notQueueable: 0, invalid: 0, overdue: 0, overdueNotified: 0, reconciled: 0, failed: [] };
  const contexts = new Map<string, UserContext | null>();
  const contextFor = async (propertyId: string): Promise<UserContext | null> => {
    if (!contexts.has(propertyId)) contexts.set(propertyId, await systemContextForProperty(propertyId));
    return contexts.get(propertyId) ?? null;
  };

  const due = await prisma.sesHospedajesSubmission.findMany({
    where: { status: "retrying", nextRetryAt: { lte: now } },
    select: { id: true, propertyId: true },
    take: 50
  });
  for (const s of due) {
    try {
      const actor = await contextFor(s.propertyId);
      if (!actor) throw new Error("property not found");
      await retrySesSubmission(s.id, actor);
      result.retried++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ses.scheduler] retry ${s.id} failed: ${message}`);
      result.failed.push({ id: s.id, error: message });
    }
  }

  // Corrector L5 (CS-02): the parked rows are classified BEFORE any re-queue —
  //   · one recoverable row per parte + type: the older duplicates (126 rows of the
  //     same parte in the demo before L5; 12 of RES-00028 in RA) are discarded as
  //     superseded, so the newest is the only one that can ever be re-queued;
  //   · a parte the MIR already holds (accepted / annulled / expired) is legal
  //     history: its parked row is discarded, never re-sent;
  //   · a parte that does not validate fails its row for good (GUEST_REGISTER_INVALID)
  //     instead of failing it again on every tick once the establishment is fixed;
  //   · the switch off or the establishment incomplete leave the row parked (blocked).
  const recoverable = await prisma.sesHospedajesSubmission.findMany({
    where: { status: "failed", errorCode: { in: [...SES_RECOVERABLE_ERROR_CODES] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200
  });
  const keeperByParte = new Map<string, (typeof recoverable)[number]>();
  for (const s of recoverable) keeperByParte.set(`${s.guestRegisterRecordId}:${s.submissionType}`, s); // ascending order → the newest wins
  const establishmentOk = new Map<string, boolean>();
  let requeued = 0;
  for (const s of recoverable) {
    try {
      const actor = await contextFor(s.propertyId);
      if (!actor) throw new Error("property not found");
      const keeper = keeperByParte.get(`${s.guestRegisterRecordId}:${s.submissionType}`);
      if (keeper && keeper.id !== s.id) {
        await discardSesSubmissionRow({
          row: s,
          context: actor,
          actorType: "system",
          reason: "fila aparcada duplicada del mismo parte: la sustituye la más reciente",
          correlationId: `ses_supersede_${s.id}`,
          extra: { supersededBy: keeper.id }
        });
        result.superseded++;
        continue;
      }
      const gate = await sesRequeueGate(s);
      if (gate && gate.recoverable) {
        result.blocked++;
        continue;
      }
      if (gate && gate.code === GUEST_REGISTER_NOT_QUEUEABLE_CODE) {
        await discardSesSubmissionRow({ row: s, context: actor, actorType: "system", reason: gate.message, correlationId: `ses_not_queueable_${s.id}`, extra: gate.extra });
        result.notQueueable++;
        continue;
      }
      if (gate) {
        await failSubmission({ row: s, context: actor, correlationId: `ses_invalid_${s.id}`, errorCode: gate.code, errorMessage: gate.message, response: gate.extra });
        result.invalid++;
        continue;
      }
      if (!establishmentOk.has(s.propertyId)) {
        establishmentOk.set(s.propertyId, (await resolveSesEstablishment(s.propertyId)).ok);
      }
      if (!establishmentOk.get(s.propertyId)) {
        result.blocked++;
        continue;
      }
      if (requeued >= 50) {
        result.blocked++;
        continue;
      }
      await retrySesSubmission(s.id, actor);
      requeued++;
      result.recovered++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ses.scheduler] recovery of ${s.id} failed: ${message}`);
      result.failed.push({ id: s.id, error: message });
    }
  }

  const overdueRows = await prisma.sesHospedajesSubmission.findMany({
    where: {
      status: { in: [...SES_UNRESOLVED_STATUSES] },
      createdAt: { lt: new Date(now.getTime() - SES_OVERDUE_MS) },
      OR: [{ errorCode: null }, { errorCode: { not: SES_DISCARDED_CODE } }]
    },
    select: { id: true, propertyId: true, guestRegisterRecordId: true, submissionType: true, createdAt: true, responsePayloadJson: true }
  });
  result.overdue = overdueRows.length;
  for (const s of overdueRows) {
    const response = jsonObject(s.responsePayloadJson);
    if (typeof response.overdueNotifiedAt === "string") continue;
    try {
      const actor = await contextFor(s.propertyId);
      if (!actor) throw new Error("property not found");
      recordDomainEvent({
        organizationId: actor.organizationId,
        propertyId: s.propertyId,
        entityType: "ses_hospedajes_submission",
        entityId: s.id,
        eventType: "AuthoritySubmissionOverdue",
        payload: { submissionId: s.id, guestRegisterRecordId: s.guestRegisterRecordId, submissionType: s.submissionType, queuedAt: s.createdAt.toISOString(), deadlineHours: 24 },
        actorType: "system",
        actorUserId: actor.userId,
        correlationId: `ses_overdue_${s.id}`
      });
      await prisma.sesHospedajesSubmission.update({
        where: { id: s.id },
        data: { responsePayloadJson: asJson({ ...response, overdueNotifiedAt: now.toISOString() }) }
      });
      result.overdueNotified++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ses.scheduler] overdue notification for ${s.id} failed: ${message}`);
      result.failed.push({ id: s.id, error: message });
    }
  }

  // 4. Accepted bajas whose parte is still not `annulled`: cheap in steady
  // state (one query returns nothing once every parte matches its history).
  const acceptedBajas = await prisma.sesHospedajesSubmission.findMany({
    where: { submissionType: SES_BAJA_TYPE, status: "accepted" },
    select: { guestRegisterRecordId: true, propertyId: true },
    distinct: ["guestRegisterRecordId"],
    take: 200
  });
  const drifted = acceptedBajas.length
    ? await prisma.guestRegisterRecord.findMany({
        where: { id: { in: acceptedBajas.map((s) => s.guestRegisterRecordId) }, status: { in: SES_OWNED_RECORD_STATUSES.filter((status) => status !== "annulled") } },
        select: { id: true }
      })
    : [];
  const propertyByRecord = new Map(acceptedBajas.map((s) => [s.guestRegisterRecordId, s.propertyId]));
  for (const record of drifted) {
    try {
      const change = await reconcileGuestRegisterStatus(record.id);
      if (!change) continue;
      result.reconciled++;
      const propertyId = propertyByRecord.get(record.id);
      const actor = propertyId ? await contextFor(propertyId) : null;
      if (!actor || !propertyId) throw new Error("property not found");
      recordAuditEvent({
        organizationId: actor.organizationId,
        propertyId,
        actorUserId: actor.userId,
        actorType: "system",
        action: "SES_GUEST_REGISTER_STATUS_RECONCILED",
        entityType: "guest_register_record",
        entityId: record.id,
        beforeJson: { status: change.from },
        afterJson: { status: change.to, reason: "accepted_baja" },
        correlationId: `ses_reconcile_${record.id}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ses.scheduler] reconciliation of parte ${record.id} failed: ${message}`);
      result.failed.push({ id: record.id, error: message });
    }
  }

  return result;
}

// ───────────────────────────────────────────── reads

export async function getSesSubmission(submissionId: string): Promise<(SesSubmissionView & { xmlPayload: string | null; responseAck: string | null; warnings: string[] }) | null> {
  const row = await prisma.sesHospedajesSubmission.findUnique({ where: { id: submissionId } });
  if (!row) return null;
  const response = jsonObject(row.responsePayloadJson);
  return {
    ...toSesSubmissionView(row),
    xmlPayload: row.xmlPayload,
    responseAck: row.responseAck,
    warnings: Array.isArray(response.warnings) ? response.warnings.map(String) : []
  };
}

/** Contract F: cursor-paginated list (newest first) — see lib/pagination.ts. */
export async function listSesSubmissions(
  propertyId: string,
  options: { limit?: number; cursor?: string; status?: string; includeDiscarded?: boolean } = {}
): Promise<Page<SesSubmissionView>> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), MAX_PAGE_LIMIT);
  if (options.status !== undefined && !SES_STATUSES.has(options.status)) {
    throw new BadRequestError(`Estado de envío SES no válido: ${options.status}.`);
  }
  const cursor = decodeCursor(options.cursor ?? null);
  // Corrector L5 (CS-04): `?status=failed` lists the rows that still need an
  // answer; the discarded ones (closed history) only with includeDiscarded=true.
  const excludeDiscarded = options.status === "failed" && options.includeDiscarded !== true;
  const where: Prisma.SesHospedajesSubmissionWhereInput = {
    propertyId,
    ...(options.status ? { status: options.status as SesStatus } : {}),
    ...(excludeDiscarded ? { OR: [{ errorCode: null }, { errorCode: { not: SES_DISCARDED_CODE } }] } : {})
  };
  const cursorWhere: Prisma.SesHospedajesSubmissionWhereInput = cursor
    ? { OR: [{ createdAt: { lt: new Date(cursor.k) } }, { createdAt: new Date(cursor.k), id: { lt: cursor.id } }] }
    : {};
  const [rows, total] = await Promise.all([
    prisma.sesHospedajesSubmission.findMany({
      where: { AND: [where, cursorWhere] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1
    }),
    prisma.sesHospedajesSubmission.count({ where })
  ]);
  const now = new Date();
  return buildPage(
    rows.map((row) => toSesSubmissionView(row, now)),
    limit,
    total,
    (row) => row.createdAt
  );
}

export type SesInboxIssue = {
  status: string;
  issue: string;
  recordId: string;
  submissionId: string;
  /** Older than the 24 h legal deadline and still not accepted. */
  overdue: boolean;
  deadline: string;
};

/**
 * Issues the compliance inbox shows for SES: failed / rejected / retrying rows
 * and overdue open ones. Rows the operator discarded (SES_DISCARDED) are closed
 * history, not pending work: they stay out of the inbox (Tanda L5 · L5-B2).
 */
export async function listSesInboxIssues(propertyId: string): Promise<SesInboxIssue[]> {
  const now = new Date();
  const rows = await prisma.sesHospedajesSubmission.findMany({
    where: {
      propertyId,
      OR: [
        { status: { in: ["failed", "rejected", "retrying"] }, OR: [{ errorCode: null }, { errorCode: { not: SES_DISCARDED_CODE } }] },
        { status: { in: [...SES_OPEN_STATUSES] }, createdAt: { lt: new Date(now.getTime() - SES_OVERDUE_MS) } }
      ]
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  return rows.map((row) => {
    const overdue = isSesSubmissionOverdue(row, now);
    const base = {
      recordId: row.guestRegisterRecordId,
      submissionId: row.id,
      overdue,
      deadline: "24h (RD 933/2021)"
    };
    if (row.status === "failed" || row.status === "rejected") {
      return { ...base, status: row.status, issue: row.errorMessage ?? `Envío SES.HOSPEDAJES ${row.status === "failed" ? "fallido" : "rechazado"}.` };
    }
    if (row.status === "retrying") {
      return { ...base, status: overdue ? "overdue" : "retrying", issue: `Envío SES.HOSPEDAJES pendiente de reintento${row.errorMessage ? `: ${row.errorMessage}` : "."}` };
    }
    return { ...base, status: "overdue", issue: `Envío SES.HOSPEDAJES sin aceptar más de 24 h (${row.submissionType}, encolado ${row.createdAt.toISOString()}).` };
  });
}
