// Parte de viajeros (registro de viajeros · RD 933/2021) and authority
// submissions — Tanda 3 · QC-01.
//
// Every read and write of guest register records, SES submissions, authority
// submissions and batches goes to Prisma. The previous in-memory lists
// (demoStore.guestRegisterRecords / sesSubmissions / authoritySubmissions /
// authoritySubmissionBatches) and the partial async mirror are gone: the legal
// history survives restarts, statuses and validation errors are persisted, and
// check-in never creates a duplicate parte for the same (reservation, guest).
//
// Uniqueness of (reservation_id, guest_id) in guest_register_records is
// enforced IN CODE ONLY (find-then-create in persistGuestRegister callers:
// prepareGuestRegisterRecord / ensureReservationGuestRegisterRecords). The
// table has no unique index for the pair (schema.prisma: @@index only), so two
// concurrent check-ins of the same guest can still create two partes. Tanda 4
// (schema) adds the partial unique index — Prisma cannot declare a partial
// index, so it is raw SQL next to `db push`:
//   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
//     guest_register_records_reservation_guest_active_uq
//     ON guest_register_records (reservation_id, guest_id)
//     WHERE reservation_id IS NOT NULL AND guest_id IS NOT NULL AND status <> 'expired';
// (`expired` is the status the backfill gives to duplicates it demotes, so the
// index is creatable after `backfill:guest-register --apply`). Once it exists
// the create path must map P2002 to a 409 instead of relying on the pre-read.
//
// Cancellation / no-show: transitionReservation (pms.service) calls
// queueSesBajaForReservation best-effort so every parte the MIR already holds
// (accepted alta/modificación) receives a baja exactly once.
//
// Still in demoStore (not part of this lot): authority reporting settings,
// lodging legal profiles, routing rules and identity-scan processing events.

import type { GuestIdentityFields } from "@hotelos/shared";
import {
  blockingIssueCodes,
  calculateSpainGuestRegisterRetentionUntil,
  deriveGuestRegisterStatus,
  detectMissingGuestRegisterFields,
  guestRegisterValidationInput,
  validateSpainGuestRegisterRecord,
  type SpainGuestRegisterRecordInput,
  type SpainGuestRegisterValidationIssue,
  type SpainGuestRegisterValidationResult
} from "@hotelos/compliance";
import { prisma, type Prisma } from "@hotelos/database";
import { createId, nowIso } from "../../lib/ids.js";
import {
  demoStore,
  type AuthoritySubmissionBatchRecord,
  type AuthoritySubmissionBatchRecordLink,
  type AuthoritySubmissionRecord,
  type GuestRegisterRecord,
  type IdentityDocumentProcessingEventRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import {
  guestRegisterStatusForSesOutcome,
  hasAcceptedSesSubmission,
  listSesInboxIssues,
  listSesSubmissions,
  queueSesSubmission,
  resolveSesEstablishment,
  retrySesSubmission,
  SES_BAJA_DONE_STATUSES,
  SES_BAJA_PENDING_STATUSES,
  SES_BAJA_TYPE,
  toSesSubmissionView,
  type SesHistoryEntry,
  type SesSubmissionView
} from "./ses-submission.service.js";

type GuestRegisterRow = Awaited<ReturnType<typeof prisma.guestRegisterRecord.findUniqueOrThrow>>;
type GuestRegisterStatus = GuestRegisterRow["status"];
type AuthoritySubmissionRow = Awaited<ReturnType<typeof prisma.authoritySubmission.findUniqueOrThrow>>;
type AuthorityBatchRow = Awaited<ReturnType<typeof prisma.authoritySubmissionBatch.findUniqueOrThrow>>;
type AuthorityBatchLinkRow = Awaited<ReturnType<typeof prisma.authoritySubmissionBatchRecord.findUniqueOrThrow>>;
type SesStatus = SesSubmissionView["status"];

const GUEST_REGISTER_NOT_FOUND = "Registro de viajero no encontrado.";
const AUTHORITY_SUBMISSION_NOT_FOUND = "Envío a la autoridad no encontrado.";
const AUTHORITY_BATCH_NOT_FOUND = "Lote de envío a la autoridad no encontrado.";

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

function jsonIssues(value: unknown): SpainGuestRegisterValidationIssue[] {
  return Array.isArray(value) ? (value as SpainGuestRegisterValidationIssue[]) : [];
}

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function isoDay(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString().slice(0, 10) : undefined;
}

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

// ───────────────────────────────────────────── mappers

/** Prisma row → API shape (the `GuestRegisterRecord` type every consumer already reads). */
export function toGuestRegisterApi(row: GuestRegisterRow): GuestRegisterRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    reservationId: row.reservationId ?? undefined,
    guestId: row.guestId ?? undefined,
    recordType: row.recordType as GuestRegisterRecord["recordType"],
    status: row.status,
    isPrimaryGuest: row.isPrimaryGuest,
    isMinor: row.isMinor,
    providedByAdultGuestId: row.providedByAdultGuestId ?? undefined,
    firstName: row.firstName ?? undefined,
    surname1: row.surname1 ?? undefined,
    surname2: row.surname2 ?? undefined,
    sex: row.sex ?? undefined,
    nationality: row.nationality ?? undefined,
    dateOfBirth: isoDay(row.dateOfBirth),
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
    kinshipRelationIfMinor: row.kinshipRelationIfMinor ?? undefined,
    contractReference: row.contractReference ?? undefined,
    contractDate: iso(row.contractDate),
    checkinAt: iso(row.checkinAt),
    checkoutAt: iso(row.checkoutAt),
    propertyFullAddress: row.propertyFullAddress ?? undefined,
    contractedRoomCount: row.contractedRoomCount ?? undefined,
    internetConnection: row.internetConnection ?? undefined,
    paymentType: row.paymentType ?? undefined,
    paymentMethodIdentifier: row.paymentMethodIdentifier ?? undefined,
    paymentHolder: row.paymentHolder ?? undefined,
    paymentDate: iso(row.paymentDate),
    paymentReference: row.paymentReference ?? undefined,
    requiredPayloadJson: jsonObject(row.requiredPayloadJson),
    validationErrorsJson: jsonIssues(row.validationErrorsJson) as unknown as Array<Record<string, unknown>>,
    signatureRequired: row.signatureRequired,
    signatureObjectKey: row.signatureObjectKey ?? undefined,
    signedAt: iso(row.signedAt),
    identityVerified: row.identityVerified,
    identityVerifiedBy: row.identityVerifiedBy ?? undefined,
    identityVerifiedAt: iso(row.identityVerifiedAt),
    identityVerificationMethod: row.identityVerificationMethod ?? undefined,
    idImageStored: row.idImageStored,
    idImageDiscarded: row.idImageDiscarded,
    idImageDiscardedAt: iso(row.idImageDiscardedAt),
    retentionUntil: row.retentionUntil.toISOString(),
    createdBy: row.createdBy ?? undefined,
    updatedBy: row.updatedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Validator input from the persisted columns (single mapping in @hotelos/compliance, shared with the backfill CLI). */
export function validationInputFromRow(row: GuestRegisterRow): SpainGuestRegisterRecordInput {
  return guestRegisterValidationInput(row);
}

/** Columns for the keys present (non-undefined) in a Spain guest-register input. */
function columnsFromInput(input: Partial<SpainGuestRegisterRecordInput>): Prisma.GuestRegisterRecordUncheckedUpdateInput {
  const data: Prisma.GuestRegisterRecordUncheckedUpdateInput = {};
  if (input.recordType !== undefined) data.recordType = input.recordType;
  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.surname1 !== undefined) data.surname1 = input.surname1;
  if (input.surname2 !== undefined) data.surname2 = input.surname2;
  if (input.sex !== undefined) data.sex = input.sex;
  if (input.nationality !== undefined) data.nationality = input.nationality;
  if (input.dateOfBirth !== undefined) data.dateOfBirth = toDate(input.dateOfBirth) ?? null;
  if (input.documentType !== undefined) data.documentType = input.documentType;
  if (input.documentNumber !== undefined) data.documentNumber = input.documentNumber;
  if (input.documentSupportNumber !== undefined) data.documentSupportNumber = input.documentSupportNumber;
  if (input.residenceFullAddress !== undefined) data.residenceFullAddress = input.residenceFullAddress;
  if (input.residenceLocality !== undefined) data.residenceLocality = input.residenceLocality;
  if (input.residenceCountry !== undefined) data.residenceCountry = input.residenceCountry;
  if (input.phoneLandline !== undefined) data.phoneLandline = input.phoneLandline;
  if (input.phoneMobile !== undefined) data.phoneMobile = input.phoneMobile;
  if (input.email !== undefined) data.email = input.email;
  if (input.travellerCount !== undefined) data.travellerCount = input.travellerCount;
  if (input.isMinor !== undefined) data.isMinor = input.isMinor;
  if (input.providedByAdultGuestId !== undefined) data.providedByAdultGuestId = input.providedByAdultGuestId;
  if (input.kinshipRelationIfMinor !== undefined) data.kinshipRelationIfMinor = input.kinshipRelationIfMinor;
  if (input.contractReference !== undefined) data.contractReference = input.contractReference;
  if (input.contractDate !== undefined) data.contractDate = toDate(input.contractDate) ?? null;
  if (input.checkinAt !== undefined) data.checkinAt = toDate(input.checkinAt) ?? null;
  if (input.checkoutAt !== undefined) data.checkoutAt = toDate(input.checkoutAt) ?? null;
  if (input.paymentType !== undefined) data.paymentType = input.paymentType;
  if (input.paymentMethodIdentifier !== undefined) data.paymentMethodIdentifier = input.paymentMethodIdentifier;
  if (input.paymentHolder !== undefined) data.paymentHolder = input.paymentHolder;
  if (input.paymentReference !== undefined) data.paymentReference = input.paymentReference;
  if (input.signatureRequired !== undefined) data.signatureRequired = input.signatureRequired;
  if (input.signedAt !== undefined) data.signedAt = toDate(input.signedAt) ?? null;
  if (input.idImageStored !== undefined) data.idImageStored = input.idImageStored;
  if (input.idImageDiscarded !== undefined) data.idImageDiscarded = input.idImageDiscarded;
  return data;
}

/** Strip undefined keys so a patch never clears a column by accident. */
function definedPatch<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Scan / profile fields (flat GuestIdentityFields) → Spain guest-register input. */
function spainInputFromIdentityFields(fields: Partial<GuestIdentityFields>): Partial<SpainGuestRegisterRecordInput> {
  return definedPatch({
    firstName: fields.firstName,
    surname1: fields.surname1,
    surname2: fields.surname2,
    sex: fields.sex,
    nationality: fields.nationality,
    dateOfBirth: fields.dateOfBirth,
    documentType: fields.documentType,
    documentNumber: fields.documentNumber,
    documentSupportNumber: fields.documentSupportNumber,
    residenceFullAddress: fields.residenceAddress,
    residenceLocality: fields.residenceLocality,
    residenceCountry: fields.residenceCountry,
    phoneMobile: fields.mobilePhone ?? fields.phone,
    phoneLandline: fields.mobilePhone ? fields.phone : undefined,
    email: fields.email
  });
}

function toAuthoritySubmissionApi(row: AuthoritySubmissionRow): AuthoritySubmissionRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    guestRegisterRecordId: row.guestRegisterRecordId ?? undefined,
    batchId: row.batchId ?? undefined,
    authorityType: row.authorityType as AuthoritySubmissionRecord["authorityType"],
    submissionType: row.submissionType as AuthoritySubmissionRecord["submissionType"],
    status: (row.status === "retrying" ? "queued" : row.status) as AuthoritySubmissionRecord["status"],
    externalReference: row.externalReference ?? undefined,
    requestPayloadJson: jsonObject(row.requestPayloadJson),
    responsePayloadJson: jsonObject(row.responsePayloadJson),
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    submittedAt: iso(row.submittedAt),
    acceptedAt: iso(row.acceptedAt),
    rejectedAt: iso(row.rejectedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toBatchApi(row: AuthorityBatchRow): AuthoritySubmissionBatchRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    authorityType: row.authorityType as AuthoritySubmissionBatchRecord["authorityType"],
    batchType: row.batchType as AuthoritySubmissionBatchRecord["batchType"],
    status: row.status as AuthoritySubmissionBatchRecord["status"],
    periodFrom: iso(row.periodFrom),
    periodTo: iso(row.periodTo),
    fileFormat: (row.fileFormat ?? undefined) as AuthoritySubmissionBatchRecord["fileFormat"],
    fileObjectKey: row.fileObjectKey ?? undefined,
    recordCount: row.recordCount,
    idempotencyKey: row.idempotencyKey ?? undefined,
    generatedBy: row.generatedBy ?? undefined,
    submittedBy: row.submittedBy ?? undefined,
    generatedAt: iso(row.generatedAt),
    submittedAt: iso(row.submittedAt),
    responseReceivedAt: iso(row.responseReceivedAt),
    responsePayloadJson: jsonObject(row.responsePayloadJson),
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toBatchLinkApi(row: AuthorityBatchLinkRow): AuthoritySubmissionBatchRecordLink {
  return {
    id: row.id,
    batchId: row.batchId,
    guestRegisterRecordId: row.guestRegisterRecordId,
    status: row.status as AuthoritySubmissionBatchRecordLink["status"],
    responsePayloadJson: jsonObject(row.responsePayloadJson),
    errorMessage: row.errorMessage ?? undefined
  };
}

async function requireGuestRegisterRow(id: string): Promise<GuestRegisterRow> {
  const row = await prisma.guestRegisterRecord.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(GUEST_REGISTER_NOT_FOUND);
  return row;
}

// ───────────────────────────────────────────── guest register: create

export function checkGuestRegisterCompleteness(fields: GuestIdentityFields): {
  missingFields: string[];
  signatureRequired: boolean;
} {
  return {
    missingFields: detectMissingGuestRegisterFields(fields),
    signatureRequired: true
  };
}

/**
 * Persist a parte de viajeros with every column plus the validator's verdict
 * (status, validationErrorsJson, requiredPayloadJson). `existingId` updates a
 * row in place (dedupe by reservation + guest) instead of creating another.
 */
async function persistGuestRegister(input: {
  context: UserContext;
  propertyId: string;
  reservationId: string;
  guestId: string | undefined;
  payload: SpainGuestRegisterRecordInput;
  existingId?: string;
  auditAction: string;
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  const now = new Date();
  const validation = validateSpainGuestRegisterRecord(input.payload);
  const status = deriveGuestRegisterStatus({
    currentStatus: null,
    validationValid: validation.valid,
    validationStatus: validation.status,
    signedAt: input.payload.signedAt,
    blockingIssueCodes: blockingIssueCodes(validation.issues)
  }) as GuestRegisterStatus;
  const columns = columnsFromInput(input.payload);
  const shared: Prisma.GuestRegisterRecordUncheckedUpdateInput = {
    ...columns,
    recordType: input.payload.recordType ?? "checkin",
    status,
    requiredPayloadJson: asJson(validation.payload),
    validationErrorsJson: asJson(validation.issues),
    signatureRequired: input.payload.signatureRequired ?? true,
    idImageStored: false,
    idImageDiscarded: input.payload.idImageDiscarded === true,
    idImageDiscardedAt: input.payload.idImageDiscarded === true ? now : null,
    updatedBy: input.context.userId
  };

  let row: GuestRegisterRow;
  if (input.existingId) {
    row = await prisma.guestRegisterRecord.update({ where: { id: input.existingId }, data: { ...shared, guestId: input.guestId ?? null } });
  } else {
    const retentionUntil = new Date(calculateSpainGuestRegisterRetentionUntil(input.payload.checkoutAt ?? now.toISOString()));
    row = await prisma.guestRegisterRecord.create({
      data: {
        ...(shared as Prisma.GuestRegisterRecordUncheckedCreateInput),
        id: createId("grr"),
        propertyId: input.propertyId,
        reservationId: input.reservationId,
        guestId: input.guestId ?? null,
        recordType: input.payload.recordType ?? "checkin",
        status,
        requiredPayloadJson: asJson(validation.payload),
        retentionUntil,
        createdBy: input.context.userId
      }
    });
  }
  const record = toGuestRegisterApi(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.auditAction,
    entityType: "guest_register_record",
    entityId: record.id,
    afterJson: { status: record.status, issues: validation.issues.map((issue) => issue.code), reservationId: input.reservationId, guestId: input.guestId ?? null },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return record;
}

/**
 * AI check-in from a document scan: the parte is created (or refreshed, if the
 * guest already has one for this reservation) from the extracted fields. The
 * scan image is never stored, so the discard flag is set on creation.
 */
export async function prepareGuestRegisterRecord(input: {
  context: UserContext;
  propertyId: string;
  reservationId: string;
  guestId: string;
  fields: GuestIdentityFields;
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  const [reservation, existing] = await Promise.all([
    prisma.reservation.findUnique({ where: { id: input.reservationId }, select: { code: true } }),
    prisma.guestRegisterRecord.findFirst({ where: { reservationId: input.reservationId, guestId: input.guestId }, select: { id: true } })
  ]);
  return persistGuestRegister({
    context: input.context,
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    guestId: input.guestId,
    existingId: existing?.id,
    auditAction: "GUEST_REGISTER_PREPARED",
    correlationId: input.correlationId,
    payload: {
      recordType: "checkin",
      ...spainInputFromIdentityFields(input.fields),
      travellerCount: 1,
      contractReference: reservation?.code,
      checkinAt: nowIso(),
      idImageDiscarded: true
    }
  });
}

export async function createSpainGuestRegisterRecord(input: {
  context: UserContext;
  propertyId: string;
  reservationId: string;
  payload: SpainGuestRegisterRecordInput & { guestId?: string };
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  requirePermissions(input.context, ["guest_register.create"]);
  const { guestId, ...payload } = input.payload;
  return persistGuestRegister({
    context: input.context,
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    guestId,
    auditAction: "GuestRegisterRecordCreated",
    correlationId: input.correlationId,
    payload
  });
}

/**
 * Check-in: guarantee one parte per guest of the reservation, from the guest
 * profile in Prisma. Idempotent by (reservationId, guestId) AT CODE LEVEL: the
 * existing rows are read first and only missing guests get a parte, so a
 * restart never produces a duplicate that would be communicated twice. The
 * database does not enforce the pair yet (no unique index on
 * guest_register_records(reservation_id, guest_id) — Tanda 4 schema), so two
 * concurrent check-ins of the same reservation remain a known race.
 * Incomplete profiles still get a record (status missing_data) — that is the
 * SES reality the inbox must show, not a reason to skip.
 */
export async function ensureReservationGuestRegisterRecords(input: {
  context: UserContext;
  reservationId: string;
  correlationId: string;
}): Promise<{ created: GuestRegisterRecord[]; existing: number }> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: { id: true, propertyId: true, code: true }
  });
  if (!reservation) {
    return { created: [], existing: 0 };
  }
  const [links, existingRows] = await Promise.all([
    prisma.reservationGuest.findMany({ where: { reservationId: input.reservationId }, include: { guest: true } }),
    prisma.guestRegisterRecord.findMany({ where: { reservationId: input.reservationId }, select: { id: true, guestId: true } })
  ]);
  const existingGuestIds = new Set(existingRows.map((row) => row.guestId).filter((id): id is string => Boolean(id)));
  const guests = links.map((link) => link.guest).filter((guest): guest is NonNullable<typeof guest> => Boolean(guest));
  const checkinAt = nowIso();
  const created: GuestRegisterRecord[] = [];
  for (const guest of guests) {
    if (existingGuestIds.has(guest.id)) continue;
    const record = await createSpainGuestRegisterRecord({
      context: input.context,
      propertyId: reservation.propertyId,
      reservationId: input.reservationId,
      correlationId: input.correlationId,
      payload: {
        guestId: guest.id,
        recordType: "checkin",
        firstName: guest.firstName,
        surname1: guest.surname1 ?? undefined,
        surname2: guest.surname2 ?? undefined,
        sex: guest.sex ?? undefined,
        nationality: guest.nationality ?? undefined,
        dateOfBirth: isoDay(guest.dateOfBirth),
        documentType: guest.documentType ?? undefined,
        documentNumber: guest.documentNumber ?? undefined,
        documentSupportNumber: guest.documentSupportNumber ?? undefined,
        residenceFullAddress: guest.residenceAddress ?? undefined,
        residenceLocality: guest.residenceLocality ?? undefined,
        residenceCountry: guest.residenceCountry ?? undefined,
        phoneLandline: guest.phone ?? undefined,
        phoneMobile: guest.mobilePhone ?? undefined,
        email: guest.email ?? undefined,
        travellerCount: 1,
        contractReference: reservation.code,
        checkinAt,
        // No document image is captured in this flow: nothing to retain.
        idImageDiscarded: true
      }
    });
    existingGuestIds.add(guest.id);
    created.push(record);
  }
  return { created, existing: existingRows.length };
}

// ───────────────────────────────────────────── guest register: reads

export async function listGuestRegisterRecords(propertyId: string): Promise<GuestRegisterRecord[]> {
  const rows = await prisma.guestRegisterRecord.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  return rows.map(toGuestRegisterApi);
}

export async function listReservationGuestRegisterRecords(reservationId: string): Promise<GuestRegisterRecord[]> {
  const rows = await prisma.guestRegisterRecord.findMany({
    where: { reservationId },
    orderBy: { createdAt: "asc" }
  });
  return rows.map(toGuestRegisterApi);
}

export async function getGuestRegisterRecord(recordId: string): Promise<GuestRegisterRecord | null> {
  const row = await prisma.guestRegisterRecord.findUnique({ where: { id: recordId } });
  return row ? toGuestRegisterApi(row) : null;
}

// ───────────────────────────────────────────── guest register: updates

/** Re-validate a row after a patch and persist status + errors + payload in one update. */
async function applyValidatedPatch(input: {
  row: GuestRegisterRow;
  patch: Partial<SpainGuestRegisterRecordInput>;
  /** Keep pipeline-owned statuses (queued/accepted…); false lets failed/rejected be re-evaluated. */
  keepTerminal: boolean;
  forceStatus?: GuestRegisterStatus;
  updatedBy: string;
}): Promise<{ row: GuestRegisterRow; validation: SpainGuestRegisterValidationResult }> {
  const patch = definedPatch(input.patch);
  const merged: SpainGuestRegisterRecordInput = { ...validationInputFromRow(input.row), ...patch };
  const validation = validateSpainGuestRegisterRecord(merged);
  const reevaluate = !input.keepTerminal && (input.row.status === "failed" || input.row.status === "rejected");
  const status =
    input.forceStatus ??
    (deriveGuestRegisterStatus({
      currentStatus: reevaluate ? null : input.row.status,
      validationValid: validation.valid,
      validationStatus: validation.status,
      signedAt: merged.signedAt,
      blockingIssueCodes: blockingIssueCodes(validation.issues)
    }) as GuestRegisterStatus);
  const row = await prisma.guestRegisterRecord.update({
    where: { id: input.row.id },
    data: {
      ...columnsFromInput(patch),
      status,
      requiredPayloadJson: asJson(validation.payload),
      validationErrorsJson: asJson(validation.issues),
      updatedBy: input.updatedBy
    }
  });
  return { row, validation };
}

export async function markGuestRegisterSigned(input: {
  context: UserContext;
  guestRegisterRecordId: string;
  signatureObjectKey: string;
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  const before = await requireGuestRegisterRow(input.guestRegisterRecordId);
  const signedAt = nowIso();
  const { row } = await applyValidatedPatch({
    row: before,
    patch: { signedAt },
    keepTerminal: true,
    updatedBy: input.context.userId
  });
  const signed = await prisma.guestRegisterRecord.update({
    where: { id: row.id },
    data: { signatureObjectKey: input.signatureObjectKey }
  });
  const record = toGuestRegisterApi(signed);
  for (const action of ["GUEST_REGISTER_SIGNED", "GuestRegisterRecordSigned"]) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: record.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action,
      entityType: "guest_register_record",
      entityId: record.id,
      beforeJson: { status: before.status, signedAt: iso(before.signedAt) ?? null },
      afterJson: { status: record.status, signedAt: record.signedAt, signatureObjectKey: input.signatureObjectKey },
      correlationId: input.correlationId
    });
  }
  return record;
}

/** Correction from the scan/identity form (flat GuestIdentityFields). */
export async function correctGuestRegisterRecord(input: {
  context: UserContext;
  guestRegisterRecordId: string;
  fields: Partial<GuestIdentityFields>;
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  const before = await requireGuestRegisterRow(input.guestRegisterRecordId);
  const { row, validation } = await applyValidatedPatch({
    row: before,
    patch: spainInputFromIdentityFields(input.fields),
    keepTerminal: false,
    forceStatus: "corrected",
    updatedBy: input.context.userId
  });
  const record = toGuestRegisterApi(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_REGISTER_CORRECTED",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: { status: before.status },
    afterJson: { status: record.status, fields: Object.keys(input.fields), issues: validation.issues.map((issue) => issue.code) },
    correlationId: input.correlationId
  });
  return record;
}

export async function patchSpainGuestRegisterRecord(input: {
  context: UserContext;
  recordId: string;
  patch: Partial<SpainGuestRegisterRecordInput>;
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  requirePermissions(input.context, ["guest_register.edit"]);
  const before = await requireGuestRegisterRow(input.recordId);
  const { row, validation } = await applyValidatedPatch({
    row: before,
    patch: input.patch,
    keepTerminal: false,
    updatedBy: input.context.userId
  });
  const record = toGuestRegisterApi(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterRecordValidated",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: { status: before.status },
    afterJson: { status: record.status, patchedFields: Object.keys(definedPatch(input.patch)), issues: validation.issues.map((issue) => issue.code) },
    correlationId: input.correlationId
  });
  return record;
}

export async function validateSpainGuestRegisterRecordApi(input: { context: UserContext; recordId: string; correlationId: string }): Promise<SpainGuestRegisterValidationResult> {
  requirePermissions(input.context, ["guest_register.read"]);
  const before = await requireGuestRegisterRow(input.recordId);
  const { row, validation } = await applyValidatedPatch({
    row: before,
    patch: {},
    keepTerminal: true,
    updatedBy: input.context.userId
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "GuestRegisterRecordValidated",
    entityType: "guest_register_record",
    entityId: row.id,
    afterJson: { valid: validation.valid, status: row.status, issues: validation.issues },
    correlationId: input.correlationId
  });
  return validation;
}

export async function markGuestRegisterIdentityVerified(input: {
  context: UserContext;
  recordId: string;
  method: string;
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  requirePermissions(input.context, ["guest_register.edit"]);
  const before = await requireGuestRegisterRow(input.recordId);
  const row = await prisma.guestRegisterRecord.update({
    where: { id: before.id },
    data: {
      identityVerified: true,
      identityVerifiedBy: input.context.userId,
      identityVerifiedAt: new Date(),
      identityVerificationMethod: input.method,
      updatedBy: input.context.userId
    }
  });
  const record = toGuestRegisterApi(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterIdentityVerified",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: { identityVerified: before.identityVerified, method: before.identityVerificationMethod },
    afterJson: { identityVerified: true, method: input.method, verifiedAt: record.identityVerifiedAt },
    correlationId: input.correlationId
  });
  return record;
}

export async function correctSpainGuestRegisterRecord(input: {
  context: UserContext;
  recordId: string;
  patch: Partial<SpainGuestRegisterRecordInput>;
  correlationId: string;
}): Promise<GuestRegisterRecord> {
  requirePermissions(input.context, ["guest_register.correct"]);
  const before = await requireGuestRegisterRow(input.recordId);
  const { row, validation } = await applyValidatedPatch({
    row: before,
    patch: input.patch,
    keepTerminal: false,
    forceStatus: "corrected",
    updatedBy: input.context.userId
  });
  const record = toGuestRegisterApi(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterCorrected",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: { status: before.status },
    afterJson: { status: record.status, patchedFields: Object.keys(definedPatch(input.patch)), issues: validation.issues.map((issue) => issue.code) },
    correlationId: input.correlationId
  });
  return record;
}

// ───────────────────────────────────────────── SES submissions (Prisma pipeline)

/**
 * Queue a SES.HOSPEDAJES comunicación for a parte. The row is created
 * synchronously (status queued) and returned; the A/M/B type is derived from
 * the reservation history (the legacy `submissionType` only signals a
 * cancellation). Throws 409 SES_ESTABLISHMENT_INCOMPLETE with details.missing
 * when the property profile cannot produce a valid Establecimiento block.
 */
export async function queueSesHospedajesSubmission(input: {
  context: UserContext;
  guestRegisterRecordId: string;
  submissionType: "reservation" | "checkin" | "cancellation";
  correlationId: string;
}): Promise<SesSubmissionView> {
  requirePermissions(input.context, ["compliance.ses.submit"]);
  return queueSesSubmission({
    guestRegisterRecordId: input.guestRegisterRecordId,
    trigger: input.submissionType,
    context: input.context,
    correlationId: input.correlationId
  });
}

export async function listSesHospedajesSubmissions(propertyId: string): Promise<SesSubmissionView[]> {
  const page = await listSesSubmissions(propertyId, { limit: 100 });
  return page.items;
}

/** Manual status override (e.g. acknowledged by hand at the MIR portal); mirrors the parte status. */
export async function updateSesHospedajesSubmissionStatus(input: {
  context: UserContext;
  submissionId: string;
  status: SesStatus;
  responsePayloadJson?: Record<string, unknown>;
  errorMessage?: string;
  correlationId: string;
}): Promise<SesSubmissionView> {
  const before = await prisma.sesHospedajesSubmission.findUnique({ where: { id: input.submissionId } });
  if (!before) throw new NotFoundError("Envío SES no encontrado.");
  const now = new Date();
  const closes = ["sent", "accepted", "rejected", "failed"].includes(input.status);
  const row = await prisma.sesHospedajesSubmission.update({
    where: { id: before.id },
    data: {
      status: input.status,
      responsePayloadJson: input.responsePayloadJson
        ? asJson({ ...jsonObject(before.responsePayloadJson), ...input.responsePayloadJson, manualStatusBy: input.context.userId })
        : undefined,
      errorMessage: input.errorMessage ?? (input.status === "accepted" ? null : before.errorMessage),
      submittedAt: closes && !before.submittedAt ? now : before.submittedAt,
      acknowledgedAt: input.status === "accepted" ? (before.acknowledgedAt ?? now) : before.acknowledgedAt,
      nextRetryAt: input.status === "retrying" ? (before.nextRetryAt ?? now) : null
    }
  });
  // Terminal statuses mirror onto the parte by TipoComunicacion (an accepted
  // baja → annulled, an accepted alta/modificación → accepted); in-flight
  // overrides (queued/sent/retrying) leave the parte untouched, as before.
  const terminal: readonly SesStatus[] = ["accepted", "rejected", "failed", "annulled"];
  const recordStatus: GuestRegisterStatus | null = terminal.includes(input.status)
    ? guestRegisterStatusForSesOutcome({ submissionType: before.submissionType, status: input.status })
    : null;
  if (recordStatus) {
    await prisma.guestRegisterRecord.updateMany({ where: { id: row.guestRegisterRecordId }, data: { status: recordStatus } });
  }
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SES_HOSPEDAJES_SUBMISSION_STATUS_UPDATED",
    entityType: "ses_hospedajes_submission",
    entityId: row.id,
    beforeJson: { status: before.status },
    afterJson: { status: row.status, errorMessage: row.errorMessage, guestRegisterStatus: recordStatus },
    correlationId: input.correlationId
  });
  return toSesSubmissionView(row);
}

// ───────────────────────────────────────────── cancellation → baja

export type SesBajaCandidate = {
  recordId: string;
  /** SES history of the parte, oldest first. */
  submissions: readonly SesHistoryEntry[];
};

export type SesBajaSkipReason = "not_communicated" | "baja_pending" | "baja_accepted";

export type SesBajaPlan = {
  /** Partes that need a baja: the MIR holds them and no baja is done or on its way. */
  queue: string[];
  skipped: Array<{ recordId: string; reason: SesBajaSkipReason }>;
};

/**
 * Pure selection of the partes to revoke when a reservation is cancelled or
 * no-shows. The history of each parte is read oldest first:
 *   * the registration the MIR currently holds is the LAST accepted
 *     alta/modificación; a parte with none was never communicated — nothing
 *     to revoke;
 *   * a done baja (SES_BAJA_DONE_STATUSES) counts only when it came AFTER that
 *     registration: an earlier accepted baja revoked a previous registration
 *     that a later alta replaced (manual annulment, then re-registration);
 *   * a pending baja (SES_BAJA_PENDING_STATUSES) blocks wherever it sits: the
 *     row is retried, reaches the MIR and revokes the registration held then,
 *     so it is never duplicated;
 *   * otherwise (no baja, or only bajas the MIR rejected) a baja is queued.
 * Calling this again after the bajas were queued yields an empty `queue`: the
 * hook is idempotent.
 */
export function selectGuestRegisterRecordsForSesBaja(candidates: readonly SesBajaCandidate[]): SesBajaPlan {
  const plan: SesBajaPlan = { queue: [], skipped: [] };
  for (const candidate of candidates) {
    const history = candidate.submissions;
    let registeredAt = -1;
    history.forEach((entry, index) => {
      if (entry.status === "accepted" && entry.submissionType !== SES_BAJA_TYPE) registeredAt = index;
    });
    if (registeredAt < 0) {
      plan.skipped.push({ recordId: candidate.recordId, reason: "not_communicated" });
      continue;
    }
    const bajas = history.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.submissionType === SES_BAJA_TYPE);
    if (bajas.some(({ entry, index }) => index > registeredAt && SES_BAJA_DONE_STATUSES.includes(entry.status))) {
      plan.skipped.push({ recordId: candidate.recordId, reason: "baja_accepted" });
      continue;
    }
    if (bajas.some(({ entry }) => SES_BAJA_PENDING_STATUSES.includes(entry.status))) {
      plan.skipped.push({ recordId: candidate.recordId, reason: "baja_pending" });
      continue;
    }
    plan.queue.push(candidate.recordId);
  }
  return plan;
}

/**
 * Group SES rows by parte keeping the caller's order (oldest first) and giving
 * every listed parte an entry, even without history. Pure: the order of
 * `submissions` IS the history order the selection relies on.
 */
export function groupSesHistoryByRecord(
  recordIds: readonly string[],
  submissions: readonly { guestRegisterRecordId: string; submissionType: string; status: SesStatus }[]
): Map<string, SesHistoryEntry[]> {
  const history = new Map<string, SesHistoryEntry[]>(recordIds.map((id) => [id, []]));
  for (const submission of submissions) {
    history.get(submission.guestRegisterRecordId)?.push({ submissionType: submission.submissionType, status: submission.status });
  }
  return history;
}

/**
 * Automatic baja on cancellation / no-show (RD 933/2021): for every parte of
 * the reservation the MIR already holds (accepted alta or modificación) and
 * without a baja accepted or pending, queue a `cancellation` comunicación
 * (derived → baja) through the regular pipeline. No permission check: this is
 * a legal obligation triggered by the reservation lifecycle, not a user action
 * (rows are audited as system). Per-parte failures that the pipeline already
 * persisted and audited (typed HttpError, e.g. SES_ESTABLISHMENT_INCOMPLETE →
 * failed row recovered by the scheduler) are counted in `failed`, never
 * swallowed; anything else is rethrown for the caller's best-effort catch.
 */
export async function queueSesBajaForReservation(input: {
  context: UserContext;
  reservationId: string;
  correlationId: string;
}): Promise<{ queued: number; skipped: number; failed: Array<{ recordId: string; error: string }> }> {
  const records = await prisma.guestRegisterRecord.findMany({
    where: { reservationId: input.reservationId },
    select: { id: true, propertyId: true }
  });
  if (records.length === 0) return { queued: 0, skipped: 0, failed: [] };

  const submissions = await prisma.sesHospedajesSubmission.findMany({
    where: { guestRegisterRecordId: { in: records.map((record) => record.id) } },
    select: { guestRegisterRecordId: true, submissionType: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const historyByRecord = groupSesHistoryByRecord(
    records.map((record) => record.id),
    submissions
  );
  const plan = selectGuestRegisterRecordsForSesBaja(records.map((record) => ({ recordId: record.id, submissions: historyByRecord.get(record.id) ?? [] })));

  const result = { queued: 0, skipped: plan.skipped.length, failed: [] as Array<{ recordId: string; error: string }> };
  for (const recordId of plan.queue) {
    try {
      await queueSesSubmission({
        guestRegisterRecordId: recordId,
        reservationId: input.reservationId,
        trigger: "cancellation",
        context: input.context,
        correlationId: input.correlationId
      });
      result.queued++;
    } catch (error) {
      // Typed pipeline refusal: the failed row + SES_HOSPEDAJES_SUBMISSION_BLOCKED
      // audit already exist; keep going with the other partes.
      if (!(error instanceof HttpError)) throw error;
      console.error(`[compliance] baja for parte ${recordId} of reservation ${input.reservationId} could not be queued (correlation ${input.correlationId}): ${error.message}`);
      result.failed.push({ recordId, error: error.message });
    }
  }
  if (result.queued > 0 || result.failed.length > 0) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: records[0].propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "SES_BAJA_QUEUED_ON_CANCELLATION",
      entityType: "reservation",
      entityId: input.reservationId,
      afterJson: { queued: result.queued, skipped: plan.skipped, failed: result.failed },
      correlationId: input.correlationId
    });
  }
  return result;
}

// ───────────────────────────────────────────── inbox

export type ComplianceInboxItem = {
  status: string;
  issue: string;
  recordId?: string;
  submissionId?: string;
  fields?: string[];
  overdue?: boolean;
  deadline?: string;
};

const INBOX_RECORD_STATUSES: readonly GuestRegisterStatus[] = ["draft", "missing_data", "ready_to_sign", "failed", "rejected"];

/**
 * Open compliance work for a property: partes with blocking validation issues
 * (from validationErrorsJson; legacy `draft` rows with no stored verdict are
 * validated on the fly so the inbox is honest before the backfill) plus SES
 * submissions failed / rejected / retrying / overdue.
 */
export async function getComplianceInbox(propertyId: string): Promise<ComplianceInboxItem[]> {
  const rows = await prisma.guestRegisterRecord.findMany({
    where: { propertyId, status: { in: [...INBOX_RECORD_STATUSES] } },
    orderBy: { createdAt: "desc" },
    take: 500
  });
  const recordIssues: ComplianceInboxItem[] = [];
  for (const row of rows) {
    let blocking = jsonIssues(row.validationErrorsJson).filter((issue) => issue.severity === "blocking");
    if (blocking.length === 0 && row.status === "draft") {
      blocking = validateSpainGuestRegisterRecord(validationInputFromRow(row)).issues.filter((issue) => issue.severity === "blocking");
    }
    if (blocking.length === 0) continue;
    const name = [row.firstName, row.surname1].filter(Boolean).join(" ") || "sin nombre";
    recordIssues.push({
      status: row.status === "failed" || row.status === "rejected" ? row.status : "needs_human_review",
      issue: `Parte de viajeros ${row.id} (${name}): ${blocking.map((issue) => issue.code).join(", ")}.`,
      recordId: row.id,
      fields: blocking.map((issue) => String(issue.field ?? issue.code))
    });
  }
  const sesIssues = await listSesInboxIssues(propertyId);
  return [...recordIssues, ...sesIssues];
}

export async function getAuthorityInbox(propertyId: string): Promise<ComplianceInboxItem[]> {
  const [baseIssues, authorityRows] = await Promise.all([
    getComplianceInbox(propertyId),
    prisma.authoritySubmission.findMany({
      where: { propertyId, status: { in: ["queued", "rejected", "failed"] } },
      orderBy: { createdAt: "desc" },
      take: 200
    })
  ]);
  const authorityIssues = authorityRows.map((submission) => ({
    status: submission.status,
    issue:
      submission.status === "queued"
        ? "Envío a la autoridad en cola (SES.HOSPEDAJES / gestión manual)."
        : submission.errorMessage ?? "El envío a la autoridad necesita revisión.",
    recordId: submission.guestRegisterRecordId ?? undefined,
    submissionId: submission.id,
    deadline: "24h (RD 933/2021)",
    authorityTarget: submission.authorityType,
    suggestedAction: submission.status === "queued" ? "Enviar o incluir en el lote diario." : "Corregir y reintentar."
  }));
  return [...baseIssues, ...authorityIssues];
}

// ───────────────────────────────────────────── settings (demoStore · unchanged in this lot)

export function getSpainGuestRegisterSettings(propertyId: string) {
  return {
    reporting: demoStore.authorityReportingSettings.find((setting) => setting.propertyId === propertyId),
    legalProfile: demoStore.lodgingLegalProfiles.find((profile) => profile.propertyId === propertyId),
    routingRules: demoStore.authorityRoutingRules.filter((rule) => !rule.propertyId || rule.propertyId === propertyId),
    privacy: {
      temporaryOcrEnabled: true,
      onDeviceOcrPreferred: true,
      storeIdImageDefault: false,
      allowIdImageStorage: false,
      documentImageRetentionDays: 0,
      manualVisualVerificationRequired: true,
      onlineVerificationMethods: ["email_code", "sms_code", "payment_match", "certificate"]
    }
  };
}

export function patchSpainGuestRegisterSettings(input: {
  context: UserContext;
  propertyId: string;
  patch: Record<string, unknown>;
  correlationId: string;
}) {
  requirePermissions(input.context, ["guest_register.configure", "compliance.ses.configure"]);
  const setting = demoStore.authorityReportingSettings.find((candidate) => candidate.propertyId === input.propertyId);
  if (!setting) {
    throw new NotFoundError("La configuración de comunicación a la autoridad no existe para esta propiedad.");
  }
  const before = { ...setting, configurationJson: { ...setting.configurationJson } };
  // Apply known top-level connector fields; merge anything else into configurationJson.
  const TOP_LEVEL_STR = ["establishmentCode", "landlordCode", "webServiceUsername", "webServiceSecretRef", "regionCode"];
  const TOP_LEVEL_BOOL = ["enabled", "professionalActivity", "webServiceEnabled", "batchExportEnabled", "automaticSubmissionEnabled"];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.patch)) {
    if (TOP_LEVEL_STR.includes(key)) {
      (setting as Record<string, unknown>)[key] = value == null ? undefined : String(value);
    } else if (TOP_LEVEL_BOOL.includes(key)) {
      (setting as Record<string, unknown>)[key] = Boolean(value);
    } else {
      rest[key] = value;
    }
  }
  setting.configurationJson = { ...setting.configurationJson, ...rest };
  setting.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "AIPolicyUpdated",
    entityType: "authority_reporting_settings",
    entityId: setting.id,
    beforeJson: before,
    afterJson: setting,
    correlationId: input.correlationId
  });
  return setting;
}

// ───────────────────────────────────────────── authority submissions (Prisma)

function sesTriggerFor(submissionType: AuthoritySubmissionRecord["submissionType"]): "reservation" | "checkin" | "cancellation" {
  if (submissionType === "cancellation" || submissionType === "annulment") return "cancellation";
  if (submissionType === "reservation") return "reservation";
  return "checkin";
}

/**
 * Authority submission from the guest-register screen: persists the
 * AuthoritySubmission row and, for SES.HOSPEDAJES, queues the real MIR
 * pipeline (the SES row id is kept in responsePayloadJson.sesSubmissionId).
 * An incomplete establishment leaves the row failed and surfaces the 409.
 */
export async function queueGuestAuthoritySubmission(input: {
  context: UserContext;
  recordId: string;
  submissionType: AuthoritySubmissionRecord["submissionType"];
  correlationId: string;
}): Promise<AuthoritySubmissionRecord> {
  requirePermissions(input.context, ["guest_register.submit", "compliance.ses.submit"]);
  const before = await requireGuestRegisterRow(input.recordId);
  const { row, validation } = await applyValidatedPatch({ row: before, patch: {}, keepTerminal: true, updatedBy: input.context.userId });
  if (!validation.valid) {
    throw withDetails(new ConflictError(`El parte de viajeros no se puede enviar: ${validation.issues.map((issue) => issue.code).join(", ")}.`), {
      code: "GUEST_REGISTER_INVALID",
      recordId: row.id,
      issues: validation.issues
    });
  }
  const setting = demoStore.authorityReportingSettings.find((candidate) => candidate.propertyId === row.propertyId);
  const authorityType = setting?.authorityType ?? "ses_hospedajes";
  const created = await prisma.authoritySubmission.create({
    data: {
      propertyId: row.propertyId,
      guestRegisterRecordId: row.id,
      authorityType,
      submissionType: input.submissionType,
      status: "queued",
      requestPayloadJson: asJson(validation.payload)
    }
  });
  await prisma.guestRegisterRecord.updateMany({ where: { id: row.id }, data: { status: "queued" } });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "GuestRegisterQueued",
    entityType: "authority_submission",
    entityId: created.id,
    afterJson: { authorityType, submissionType: input.submissionType, guestRegisterRecordId: row.id },
    correlationId: input.correlationId
  });

  let final = created;
  if (authorityType === "ses_hospedajes") {
    try {
      const ses = await queueSesSubmission({
        guestRegisterRecordId: row.id,
        trigger: sesTriggerFor(input.submissionType),
        context: input.context,
        correlationId: input.correlationId
      });
      final = await prisma.authoritySubmission.update({
        where: { id: created.id },
        data: { externalReference: ses.externalReference ?? undefined, responsePayloadJson: asJson({ sesSubmissionId: ses.id, sesSubmissionType: ses.submissionType }) }
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const details = jsonObject(error.details);
      await prisma.authoritySubmission.update({
        where: { id: created.id },
        data: {
          status: "failed",
          errorCode: typeof details.code === "string" ? details.code : "SES_QUEUE_REJECTED",
          errorMessage: error.message,
          responsePayloadJson: asJson({ missing: details.missing ?? [], sesSubmissionId: details.submissionId ?? null })
        }
      });
      throw error;
    }
  }
  return toAuthoritySubmissionApi(final);
}

export async function annulAuthorityCommunication(input: { context: UserContext; recordId: string; reason: string; correlationId: string }): Promise<AuthoritySubmissionRecord> {
  requirePermissions(input.context, ["guest_register.annul"]);
  const submission = await prisma.authoritySubmission.findFirst({
    where: { guestRegisterRecordId: input.recordId },
    orderBy: { createdAt: "desc" }
  });
  if (!submission) throw new NotFoundError(AUTHORITY_SUBMISSION_NOT_FOUND);
  const response: Record<string, unknown> = { ...jsonObject(submission.responsePayloadJson), annulmentReason: input.reason };

  // A communication the MIR already accepted must be revoked with a BAJA.
  const record = await prisma.guestRegisterRecord.findUnique({ where: { id: input.recordId }, select: { reservationId: true } });
  const accepted = record?.reservationId ? await hasAcceptedSesSubmission(record.reservationId) : false;
  if (accepted) {
    try {
      const baja = await queueSesSubmission({
        guestRegisterRecordId: input.recordId,
        submissionType: "baja",
        context: input.context,
        correlationId: input.correlationId
      });
      response.sesBajaSubmissionId = baja.id;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      response.sesBajaError = { code: jsonObject(error.details).code ?? null, message: error.message };
      console.error(`[compliance] baja for record ${input.recordId} could not be queued (correlation ${input.correlationId}): ${error.message}`);
    }
  }

  const updated = await prisma.authoritySubmission.update({
    where: { id: submission.id },
    data: { status: "annulled", responsePayloadJson: asJson(response) }
  });
  await prisma.guestRegisterRecord.updateMany({ where: { id: input.recordId }, data: { status: "annulled" } });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: updated.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "AuthorityCommunicationAnnulled",
    entityType: "authority_submission",
    entityId: updated.id,
    beforeJson: { status: submission.status },
    afterJson: { status: updated.status, reason: input.reason, sesBajaSubmissionId: response.sesBajaSubmissionId ?? null },
    correlationId: input.correlationId
  });
  return toAuthoritySubmissionApi(updated);
}

export async function listAuthoritySubmissions(propertyId: string): Promise<AuthoritySubmissionRecord[]> {
  const rows = await prisma.authoritySubmission.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map(toAuthoritySubmissionApi);
}

export async function getAuthoritySubmission(input: { context: UserContext; submissionId: string; correlationId: string }): Promise<AuthoritySubmissionRecord> {
  requirePermissions(input.context, ["guest_register.read", "guest_register.view_sensitive"]);
  const row = await prisma.authoritySubmission.findUnique({ where: { id: input.submissionId } });
  if (!row) throw new NotFoundError(AUTHORITY_SUBMISSION_NOT_FOUND);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SensitiveGuestRegisterViewed",
    entityType: "authority_submission",
    entityId: row.id,
    afterJson: { viewed: true },
    correlationId: input.correlationId
  });
  return toAuthoritySubmissionApi(row);
}

export async function retryAuthoritySubmission(input: { context: UserContext; submissionId: string; correlationId: string }): Promise<AuthoritySubmissionRecord> {
  requirePermissions(input.context, ["guest_register.submit"]);
  const before = await prisma.authoritySubmission.findUnique({ where: { id: input.submissionId } });
  if (!before) throw new NotFoundError(AUTHORITY_SUBMISSION_NOT_FOUND);
  const response = jsonObject(before.responsePayloadJson);
  let sesSubmissionId = typeof response.sesSubmissionId === "string" ? response.sesSubmissionId : null;
  if (before.authorityType === "ses_hospedajes" && before.guestRegisterRecordId) {
    if (sesSubmissionId) {
      await retrySesSubmission(sesSubmissionId, input.context);
    } else {
      const ses = await queueSesSubmission({
        guestRegisterRecordId: before.guestRegisterRecordId,
        trigger: sesTriggerFor(before.submissionType as AuthoritySubmissionRecord["submissionType"]),
        context: input.context,
        correlationId: input.correlationId
      });
      sesSubmissionId = ses.id;
    }
  }
  const row = await prisma.authoritySubmission.update({
    where: { id: before.id },
    data: {
      status: "queued",
      errorCode: null,
      errorMessage: null,
      responsePayloadJson: asJson({ ...response, sesSubmissionId, retriedAt: nowIso() })
    }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "AuthoritySubmissionRetried",
    entityType: "authority_submission",
    entityId: row.id,
    beforeJson: { status: before.status, errorCode: before.errorCode },
    afterJson: { status: row.status, sesSubmissionId },
    correlationId: input.correlationId
  });
  return toAuthoritySubmissionApi(row);
}

// ───────────────────────────────────────────── batches (Prisma)

const BATCH_DUE_STATUSES: readonly GuestRegisterStatus[] = ["ready_to_submit", "signed", "queued"];

export async function generateSesHospedajesBatch(input: { context: UserContext; propertyId: string; correlationId: string }): Promise<AuthoritySubmissionBatchRecord> {
  requirePermissions(input.context, ["guest_register.export", "compliance.ses.export"]);
  const dueRecords = await prisma.guestRegisterRecord.findMany({
    where: { propertyId: input.propertyId, status: { in: [...BATCH_DUE_STATUSES] } },
    select: { id: true }
  });
  const now = new Date();
  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.authoritySubmissionBatch.create({
      data: {
        propertyId: input.propertyId,
        authorityType: "ses_hospedajes",
        batchType: "daily_batch",
        status: "generated",
        periodFrom: now,
        periodTo: now,
        fileFormat: "xml",
        fileObjectKey: `authority-batches/${input.propertyId}-${now.getTime()}.xml`,
        recordCount: dueRecords.length,
        idempotencyKey: `${input.propertyId}-${now.toISOString().slice(0, 10)}-daily-${now.getTime()}`,
        generatedBy: input.context.userId,
        generatedAt: now
      }
    });
    if (dueRecords.length > 0) {
      await tx.authoritySubmissionBatchRecord.createMany({
        data: dueRecords.map((record) => ({ batchId: created.id, guestRegisterRecordId: record.id, status: "included" }))
      });
      await tx.guestRegisterRecord.updateMany({
        where: { id: { in: dueRecords.map((record) => record.id) } },
        data: { status: "exported" }
      });
    }
    return created;
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "AuthorityBatchGenerated",
    entityType: "authority_submission_batch",
    entityId: batch.id,
    afterJson: { recordCount: batch.recordCount, fileObjectKey: batch.fileObjectKey },
    correlationId: input.correlationId
  });
  return toBatchApi(batch);
}

async function requireBatch(propertyId: string, batchId: string): Promise<AuthorityBatchRow> {
  const batch = await prisma.authoritySubmissionBatch.findFirst({ where: { id: batchId, propertyId } });
  if (!batch) throw new NotFoundError(AUTHORITY_BATCH_NOT_FOUND);
  return batch;
}

export async function submitSesHospedajesBatch(input: { context: UserContext; propertyId: string; batchId: string; correlationId: string }): Promise<AuthoritySubmissionBatchRecord> {
  requirePermissions(input.context, ["guest_register.submit", "compliance.ses.submit"]);
  const before = await requireBatch(input.propertyId, input.batchId);
  const batch = await prisma.authoritySubmissionBatch.update({
    where: { id: before.id },
    data: { status: "submitted", submittedBy: input.context.userId, submittedAt: new Date() }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "AuthorityBatchSubmitted",
    entityType: "authority_submission_batch",
    entityId: batch.id,
    beforeJson: { status: before.status },
    afterJson: { status: batch.status, submittedAt: iso(batch.submittedAt) },
    correlationId: input.correlationId
  });
  return toBatchApi(batch);
}

export async function downloadSesHospedajesBatch(input: { context: UserContext; propertyId: string; batchId: string; correlationId: string }) {
  requirePermissions(input.context, ["guest_register.export", "compliance.ses.export"]);
  const row = await requireBatch(input.propertyId, input.batchId);
  const batch = toBatchApi(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "AuthorityBatchDownloaded",
    entityType: "authority_submission_batch",
    entityId: batch.id,
    afterJson: { fileObjectKey: batch.fileObjectKey },
    correlationId: input.correlationId
  });
  const links = (await prisma.authoritySubmissionBatchRecord.findMany({ where: { batchId: batch.id } })).map(toBatchLinkApi);
  const stamp = (batch.generatedAt ?? batch.createdAt).slice(0, 10);
  const fmt = batch.fileFormat ?? "xml";
  const filename = `${batch.authorityType}-${batch.id}-${stamp}.${fmt === "api" ? "json" : fmt}`;
  const escXml = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let content: string;
  let contentType: string;
  if (fmt === "json" || fmt === "api") {
    content = JSON.stringify({ batch, records: links }, null, 2);
    contentType = "application/json;charset=utf-8";
  } else if (fmt === "txt") {
    content = [
      `# ${batch.authorityType.toUpperCase()} batch ${batch.id}`,
      `# Property: ${batch.propertyId}`,
      `# Period: ${batch.periodFrom ?? "-"} → ${batch.periodTo ?? "-"}`,
      `# Records: ${batch.recordCount}`,
      "",
      ...links.map((l) => JSON.stringify(l))
    ].join("\n");
    contentType = "text/plain;charset=utf-8";
  } else {
    content = `<?xml version="1.0" encoding="UTF-8"?>\n<batch id="${escXml(batch.id)}" authority="${escXml(batch.authorityType)}" propertyId="${escXml(batch.propertyId)}" generatedAt="${escXml(batch.generatedAt ?? batch.createdAt)}" recordCount="${batch.recordCount}">\n  <period from="${escXml(batch.periodFrom ?? "")}" to="${escXml(batch.periodTo ?? "")}"/>\n${links.map((l) => `  <record id="${escXml(l.id)}" guestRegisterRecordId="${escXml(l.guestRegisterRecordId)}" status="${escXml(l.status)}"/>`).join("\n")}\n</batch>`;
    contentType = "application/xml;charset=utf-8";
  }
  return { filename, contentType, content, batch };
}

export async function markSesBatchManuallyUploaded(input: {
  context: UserContext;
  propertyId: string;
  batchId: string;
  receiptReference?: string;
  correlationId: string;
}): Promise<AuthoritySubmissionBatchRecord> {
  requirePermissions(input.context, ["guest_register.submit", "compliance.ses.submit"]);
  const before = await requireBatch(input.propertyId, input.batchId);
  const now = new Date();
  const batch = await prisma.authoritySubmissionBatch.update({
    where: { id: before.id },
    data: {
      status: "accepted",
      responsePayloadJson: asJson({ manuallyUploaded: true, receiptReference: input.receiptReference ?? null, by: input.context.userId }),
      responseReceivedAt: now
    }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "AuthoritySubmissionAccepted",
    entityType: "authority_submission_batch",
    entityId: batch.id,
    afterJson: { status: batch.status, receiptReference: input.receiptReference ?? null },
    correlationId: input.correlationId
  });
  return toBatchApi(batch);
}

/**
 * Real readiness instead of a canned message: transport mode from env plus
 * the establishment resolution (what is missing before a comunicación can
 * be built for this property).
 */
export async function testSesHospedajesConnection(input: { context: UserContext; propertyId: string; correlationId: string }) {
  requirePermissions(input.context, ["compliance.ses.configure"]);
  const setting = demoStore.authorityReportingSettings.find((candidate) => candidate.propertyId === input.propertyId);
  const rawMode = process.env.SES_HOSPEDAJES_MODE;
  const mode = rawMode === "production" || rawMode === "preproduction" ? rawMode : "sandbox";
  const establishment = await resolveSesEstablishment(input.propertyId);
  const status = !establishment.ok ? "establishment_incomplete" : mode === "sandbox" ? "sandbox_ready" : setting?.webServiceEnabled ? "web_service_ready" : "batch_export_ready";
  const message = !establishment.ok
    ? `Faltan datos del establecimiento: ${establishment.missing.join(", ")}. Completa el perfil de la propiedad (dirección, código postal, código INE) y el número de registro SES.`
    : mode === "sandbox"
      ? "Establecimiento completo. Modo de pruebas: los envíos se simulan; configura el modo de producción y el certificado para enviar al Ministerio del Interior."
      : "Establecimiento completo y modo real configurado.";
  return {
    status,
    authorityType: setting?.authorityType ?? "ses_hospedajes",
    message,
    mode,
    establishment
  };
}

// ───────────────────────────────────────────── identity scan events (demoStore · unchanged)

export function recordTemporaryIdentityScan(input: {
  context: UserContext;
  propertyId: string;
  reservationId?: string;
  guestId?: string;
  fieldsExtractedJson?: Record<string, unknown>;
  confidenceJson?: Record<string, unknown>;
  correlationId: string;
}): IdentityDocumentProcessingEventRecord {
  requirePermissions(input.context, ["guest_register.create"]);
  const event: IdentityDocumentProcessingEventRecord = {
    id: createId("idpe"),
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    guestId: input.guestId,
    eventType: "temporary_scan_started",
    processor: "on_device",
    fieldsExtractedJson: input.fieldsExtractedJson ?? {},
    confidenceJson: input.confidenceJson ?? {},
    imageStored: false,
    imageDiscarded: false,
    createdBy: input.context.userId,
    createdAt: nowIso()
  };
  demoStore.identityDocumentProcessingEvents.push(event);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "TemporaryIdScanStarted",
    entityType: "identity_document_processing_event",
    entityId: event.id,
    afterJson: event,
    correlationId: input.correlationId
  });
  return event;
}

export function recordIdentityDiscardEvent(input: {
  context: UserContext;
  propertyId: string;
  reservationId?: string;
  guestId?: string;
  fieldsExtractedJson?: Record<string, unknown>;
  confidenceJson?: Record<string, unknown>;
  correlationId: string;
}): IdentityDocumentProcessingEventRecord {
  requirePermissions(input.context, ["guest_register.create"]);
  const event: IdentityDocumentProcessingEventRecord = {
    id: createId("idpe"),
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    guestId: input.guestId,
    eventType: "image_discarded",
    processor: "on_device",
    fieldsExtractedJson: input.fieldsExtractedJson ?? {},
    confidenceJson: input.confidenceJson ?? {},
    imageStored: false,
    imageDiscarded: true,
    createdBy: input.context.userId,
    createdAt: nowIso()
  };
  demoStore.identityDocumentProcessingEvents.push(event);
  for (const action of ["ID_IMAGE_DISCARDED", "TemporaryIdOcrCompleted", "IdImageDiscarded"]) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action,
      entityType: "identity_document_processing_event",
      entityId: event.id,
      afterJson: event,
      correlationId: input.correlationId
    });
  }
  return event;
}

