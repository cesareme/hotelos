import type { GuestIdentityFields } from "@hotelos/shared";
import {
  buildGuestRegisterPayload,
  calculateGuestRegisterRetentionUntil,
  detectMissingGuestRegisterFields,
  validateSpainGuestRegisterRecord,
  buildSpainGuestRegisterPayload,
  calculateSpainGuestRegisterRetentionUntil,
  type SpainGuestRegisterRecordInput
} from "@hotelos/compliance";
import { createId, nowIso } from "../../lib/ids.js";
import {
  demoStore,
  type AuthoritySubmissionBatchRecord,
  type AuthoritySubmissionRecord,
  type GuestRegisterRecord,
  type IdentityDocumentProcessingEventRecord,
  type SesSubmissionRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

export function checkGuestRegisterCompleteness(fields: GuestIdentityFields): {
  missingFields: string[];
  signatureRequired: boolean;
} {
  return {
    missingFields: detectMissingGuestRegisterFields(fields),
    signatureRequired: true
  };
}

export function prepareGuestRegisterRecord(input: {
  context: UserContext;
  propertyId: string;
  reservationId: string;
  guestId: string;
  fields: GuestIdentityFields;
  correlationId: string;
}): GuestRegisterRecord {
  const createdAt = new Date();
  const record: GuestRegisterRecord = {
    id: createId("grr"),
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    guestId: input.guestId,
    status: "draft",
    recordType: "checkin",
    firstName: input.fields.firstName,
    surname1: input.fields.surname1,
    surname2: input.fields.surname2,
    nationality: input.fields.nationality,
    dateOfBirth: input.fields.dateOfBirth,
    documentType: input.fields.documentType,
    documentNumber: input.fields.documentNumber,
    residenceFullAddress: input.fields.residenceAddress,
    phoneMobile: input.fields.phone,
    email: input.fields.email,
    requiredPayloadJson: buildGuestRegisterPayload(input.fields),
    validationErrorsJson: [],
    signatureRequired: true,
    idImageStored: false,
    idImageDiscarded: true,
    idImageDiscardedAt: createdAt.toISOString(),
    retentionUntil: calculateGuestRegisterRetentionUntil(createdAt).toISOString(),
    createdBy: input.context.userId,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString()
  };

  demoStore.guestRegisterRecords.push(record);

  // Dual-write to Prisma so downstream services (SES submission) can read it.
  void mirrorGuestRegisterToPrisma(record).catch((error) =>
    console.error(`[compliance] mirror PROMISE rejected:`, error)
  );

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_REGISTER_PREPARED",
    entityType: "guest_register_record",
    entityId: record.id,
    afterJson: record,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  return record;
}

async function mirrorGuestRegisterToPrisma(record: GuestRegisterRecord): Promise<void> {
  try {
    const { prisma } = await import("@hotelos/database");
    const data = {
      firstName: record.firstName ?? null,
      surname1: record.surname1 ?? null,
      surname2: record.surname2 ?? null,
      nationality: record.nationality ?? null,
      dateOfBirth: record.dateOfBirth ? new Date(record.dateOfBirth) : null,
      documentType: record.documentType ?? null,
      documentNumber: record.documentNumber ?? null,
      phoneMobile: record.phoneMobile ?? null,
      email: record.email ?? null,
      residenceFullAddress: record.residenceFullAddress ?? null
    };
    await prisma.guestRegisterRecord.upsert({
      where: { id: record.id },
      update: data,
      create: {
        id: record.id,
        propertyId: record.propertyId,
        reservationId: record.reservationId,
        guestId: record.guestId,
        recordType: record.recordType,
        requiredPayloadJson: (record.requiredPayloadJson ?? {}) as object,
        signatureRequired: record.signatureRequired,
        idImageStored: record.idImageStored,
        idImageDiscarded: record.idImageDiscarded,
        idImageDiscardedAt: record.idImageDiscardedAt ? new Date(record.idImageDiscardedAt) : null,
        retentionUntil: record.retentionUntil ? new Date(record.retentionUntil) : new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 3),
        createdBy: record.createdBy ?? null,
        ...data
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[compliance] failed to mirror guest_register_record ${record.id} to Prisma: ${message}`);
  }
}

export function markGuestRegisterSigned(input: {
  context: UserContext;
  guestRegisterRecordId: string;
  signatureObjectKey: string;
  correlationId: string;
}): GuestRegisterRecord {
  const record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === input.guestRegisterRecordId);
  if (!record) {
    throw new Error("Guest register record was not found.");
  }

  const before = { ...record };
  record.status = "signed";
  record.signatureObjectKey = input.signatureObjectKey;
  record.signedAt = nowIso();

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_REGISTER_SIGNED",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: before,
    afterJson: record,
    correlationId: input.correlationId
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterRecordSigned",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: before,
    afterJson: record,
    correlationId: input.correlationId
  });

  return record;
}

export function listGuestRegisterRecords(propertyId: string): GuestRegisterRecord[] {
  return demoStore.guestRegisterRecords.filter((record) => record.propertyId === propertyId);
}

export function correctGuestRegisterRecord(input: {
  context: UserContext;
  guestRegisterRecordId: string;
  fields: Partial<GuestIdentityFields>;
  correlationId: string;
}): GuestRegisterRecord {
  const record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === input.guestRegisterRecordId);
  if (!record) {
    throw new Error("Guest register record was not found.");
  }

  const before = { ...record, requiredPayloadJson: { ...record.requiredPayloadJson } };
  record.requiredPayloadJson = {
    ...record.requiredPayloadJson,
    ...Object.fromEntries(Object.entries(buildGuestRegisterPayload(input.fields)).filter(([, value]) => value !== undefined))
  };
  record.status = "corrected";

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_REGISTER_CORRECTED",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: before,
    afterJson: record,
    correlationId: input.correlationId
  });

  return record;
}

export function queueSesHospedajesSubmission(input: {
  context: UserContext;
  guestRegisterRecordId: string;
  submissionType: "reservation" | "checkin" | "cancellation";
  correlationId: string;
}): SesSubmissionRecord {
  requirePermissions(input.context, ["compliance.ses.submit"]);

  let record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === input.guestRegisterRecordId);
  if (!record) {
    // Fallback when the API was restarted: Prisma has the row but demoStore is empty.
    // We dispatch the new service directly (which reads from Prisma) and return a
    // synthetic submission descriptor; the real submission row is persisted via
    // ses-submission.service.
    void import("./ses-submission.service.js").then(({ queueSesSubmission }) => {
      queueSesSubmission({
        guestRegisterRecordId: input.guestRegisterRecordId,
        submissionType: input.submissionType === "cancellation" ? "baja" : input.submissionType === "checkin" ? "modificacion" : "alta",
        context: input.context,
        correlationId: input.correlationId
      });
    });
    return {
      id: createId("ses"),
      propertyId: input.context.propertyId,
      guestRegisterRecordId: input.guestRegisterRecordId,
      submissionType: input.submissionType,
      status: "queued",
      requestPayloadJson: {}
    };
  }

  const submission: SesSubmissionRecord = {
    id: createId("ses"),
    propertyId: record.propertyId,
    guestRegisterRecordId: record.id,
    submissionType: input.submissionType,
    status: "queued",
    requestPayloadJson: record.requiredPayloadJson
  };

  record.status = "queued";
  demoStore.sesSubmissions.push(submission);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "SES_HOSPEDAJES_SUBMISSION_QUEUED",
    entityType: "ses_hospedajes_submission",
    entityId: submission.id,
    afterJson: submission,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    entityType: "guest_register_record",
    entityId: record.id,
    eventType: "SesHospedajesSubmissionQueued",
    payload: { submissionId: submission.id },
    actorType: "system",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  // Fire the real MIR submission asynchronously. Persists XML + tracking number
  // in the SesHospedajesSubmission Prisma table and emits AuthoritySubmission*
  // domain events when MIR responds.
  void import("./ses-submission.service.js").then(({ queueSesSubmission }) => {
    queueSesSubmission({
      guestRegisterRecordId: record.id,
      submissionType: input.submissionType === "cancellation" ? "baja" : input.submissionType === "checkin" ? "modificacion" : "alta",
      context: input.context,
      correlationId: input.correlationId
    });
  });

  return submission;
}

export function listSesHospedajesSubmissions(propertyId: string): SesSubmissionRecord[] {
  return demoStore.sesSubmissions.filter((submission) => submission.propertyId === propertyId);
}

export function updateSesHospedajesSubmissionStatus(input: {
  context: UserContext;
  submissionId: string;
  status: SesSubmissionRecord["status"];
  responsePayloadJson?: Record<string, unknown>;
  errorMessage?: string;
  correlationId: string;
}): SesSubmissionRecord {
  const submission = demoStore.sesSubmissions.find((candidate) => candidate.id === input.submissionId);
  if (!submission) {
    throw new Error("SES.HOSPEDAJES submission was not found.");
  }

  const before = { ...submission };
  submission.status = input.status;
  submission.responsePayloadJson = input.responsePayloadJson;
  submission.errorMessage = input.errorMessage;
  submission.submittedAt = ["sent", "accepted", "rejected", "failed"].includes(input.status) ? nowIso() : submission.submittedAt;

  const record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === submission.guestRegisterRecordId);
  if (record && input.status === "accepted") {
    record.status = "submitted";
  }
  if (record && ["rejected", "failed"].includes(input.status)) {
    record.status = "failed";
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: submission.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "SES_HOSPEDAJES_SUBMISSION_STATUS_UPDATED",
    entityType: "ses_hospedajes_submission",
    entityId: submission.id,
    beforeJson: before,
    afterJson: submission,
    correlationId: input.correlationId
  });

  return submission;
}

export function getComplianceInbox(propertyId: string): Array<{ status: string; issue: string; recordId?: string }> {
  const missingFieldIssues = demoStore.guestRegisterRecords
    .filter((record) => record.propertyId === propertyId)
    .flatMap((record) =>
      detectMissingGuestRegisterFields(record.requiredPayloadJson as GuestIdentityFields).map((field) => ({
        status: "needs_human_review",
        issue: `Guest register record ${record.id} missing ${field}.`,
        recordId: record.id
      }))
    );

  const failedSubmissions = demoStore.sesSubmissions
    .filter((submission) => submission.propertyId === propertyId && ["failed", "rejected"].includes(submission.status))
    .map((submission) => ({
      status: submission.status,
      issue: submission.errorMessage ?? "SES.HOSPEDAJES submission failed.",
      recordId: submission.guestRegisterRecordId
    }));

  return [...missingFieldIssues, ...failedSubmissions];
}

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
    throw new Error("Authority reporting settings were not found.");
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

export function listReservationGuestRegisterRecords(reservationId: string): GuestRegisterRecord[] {
  return demoStore.guestRegisterRecords.filter((record) => record.reservationId === reservationId);
}

function validationInputFromRecord(record: GuestRegisterRecord): SpainGuestRegisterRecordInput {
  return {
    recordType: record.recordType,
    firstName: record.firstName,
    surname1: record.surname1,
    surname2: record.surname2,
    sex: record.sex,
    nationality: record.nationality,
    dateOfBirth: record.dateOfBirth,
    documentType: record.documentType,
    documentNumber: record.documentNumber,
    documentSupportNumber: record.documentSupportNumber,
    residenceFullAddress: record.residenceFullAddress,
    residenceLocality: record.residenceLocality,
    residenceCountry: record.residenceCountry,
    phoneLandline: record.phoneLandline,
    phoneMobile: record.phoneMobile,
    email: record.email,
    travellerCount: record.travellerCount,
    isMinor: record.isMinor,
    providedByAdultGuestId: record.providedByAdultGuestId,
    kinshipRelationIfMinor: record.kinshipRelationIfMinor,
    contractReference: record.contractReference,
    contractDate: record.contractDate,
    checkinAt: record.checkinAt,
    checkoutAt: record.checkoutAt,
    paymentType: record.paymentType,
    paymentMethodIdentifier: record.paymentMethodIdentifier,
    paymentHolder: record.paymentHolder,
    paymentReference: record.paymentReference,
    signatureRequired: record.signatureRequired,
    signedAt: record.signedAt,
    idImageStored: record.idImageStored,
    idImageDiscarded: record.idImageDiscarded
  };
}

export function createSpainGuestRegisterRecord(input: {
  context: UserContext;
  propertyId: string;
  reservationId: string;
  payload: SpainGuestRegisterRecordInput & { guestId?: string };
  correlationId: string;
}): GuestRegisterRecord {
  requirePermissions(input.context, ["guest_register.create"]);
  const createdAt = nowIso();
  const validation = validateSpainGuestRegisterRecord(input.payload);
  const checkoutOrEnd = input.payload.checkoutAt ?? createdAt;
  const record: GuestRegisterRecord = {
    id: createId("grr"),
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    guestId: input.payload.guestId,
    recordType: input.payload.recordType ?? "checkin",
    status: validation.status,
    isMinor: input.payload.isMinor,
    firstName: input.payload.firstName,
    surname1: input.payload.surname1,
    surname2: input.payload.surname2,
    sex: input.payload.sex,
    nationality: input.payload.nationality,
    dateOfBirth: input.payload.dateOfBirth,
    documentType: input.payload.documentType,
    documentNumber: input.payload.documentNumber,
    documentSupportNumber: input.payload.documentSupportNumber,
    residenceFullAddress: input.payload.residenceFullAddress,
    residenceLocality: input.payload.residenceLocality,
    residenceCountry: input.payload.residenceCountry,
    phoneLandline: input.payload.phoneLandline,
    phoneMobile: input.payload.phoneMobile,
    email: input.payload.email,
    travellerCount: input.payload.travellerCount,
    providedByAdultGuestId: input.payload.providedByAdultGuestId,
    kinshipRelationIfMinor: input.payload.kinshipRelationIfMinor,
    contractReference: input.payload.contractReference,
    contractDate: input.payload.contractDate,
    checkinAt: input.payload.checkinAt,
    checkoutAt: input.payload.checkoutAt,
    paymentType: input.payload.paymentType,
    paymentMethodIdentifier: input.payload.paymentMethodIdentifier,
    paymentHolder: input.payload.paymentHolder,
    paymentReference: input.payload.paymentReference,
    requiredPayloadJson: validation.payload,
    validationErrorsJson: validation.issues,
    signatureRequired: input.payload.signatureRequired ?? true,
    signedAt: input.payload.signedAt,
    idImageStored: false,
    idImageDiscarded: input.payload.idImageDiscarded === true,
    idImageDiscardedAt: input.payload.idImageDiscarded === true ? createdAt : undefined,
    retentionUntil: calculateSpainGuestRegisterRetentionUntil(checkoutOrEnd),
    createdBy: input.context.userId,
    createdAt,
    updatedAt: createdAt
  };
  demoStore.guestRegisterRecords.push(record);
  void mirrorGuestRegisterToPrisma(record).catch((error) =>
    console.error(`[compliance] mirror failed:`, error)
  );
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterRecordCreated",
    entityType: "guest_register_record",
    entityId: record.id,
    afterJson: record,
    correlationId: input.correlationId
  });
  return record;
}

export function patchSpainGuestRegisterRecord(input: {
  context: UserContext;
  recordId: string;
  patch: Partial<SpainGuestRegisterRecordInput>;
  correlationId: string;
}): GuestRegisterRecord {
  requirePermissions(input.context, ["guest_register.edit"]);
  const record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === input.recordId);
  if (!record) {
    throw new Error("Guest register record was not found.");
  }
  const before = { ...record };
  Object.assign(record, input.patch);
  const validation = validateSpainGuestRegisterRecord({ ...validationInputFromRecord(record), ...input.patch });
  record.requiredPayloadJson = validation.payload;
  record.validationErrorsJson = validation.issues;
  record.status = validation.status;
  record.updatedBy = input.context.userId;
  record.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterRecordValidated",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: before,
    afterJson: record,
    correlationId: input.correlationId
  });
  return record;
}

export function validateSpainGuestRegisterRecordApi(input: { context: UserContext; recordId: string; correlationId: string }) {
  requirePermissions(input.context, ["guest_register.read"]);
  const record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === input.recordId);
  if (!record) {
    throw new Error("Guest register record was not found.");
  }
  const validation = validateSpainGuestRegisterRecord(validationInputFromRecord(record));
  record.validationErrorsJson = validation.issues;
  record.requiredPayloadJson = validation.payload;
  record.status = validation.status;
  record.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "GuestRegisterRecordValidated",
    entityType: "guest_register_record",
    entityId: record.id,
    afterJson: validation,
    correlationId: input.correlationId
  });
  return validation;
}

export function markGuestRegisterIdentityVerified(input: {
  context: UserContext;
  recordId: string;
  method: string;
  correlationId: string;
}): GuestRegisterRecord {
  requirePermissions(input.context, ["guest_register.edit"]);
  const record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === input.recordId);
  if (!record) {
    throw new Error("Guest register record was not found.");
  }
  const before = { ...record };
  record.identityVerified = true;
  record.identityVerifiedBy = input.context.userId;
  record.identityVerifiedAt = nowIso();
  record.identityVerificationMethod = input.method;
  record.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterIdentityVerified",
    entityType: "guest_register_record",
    entityId: record.id,
    beforeJson: before,
    afterJson: record,
    correlationId: input.correlationId
  });
  return record;
}

export function queueGuestAuthoritySubmission(input: {
  context: UserContext;
  recordId: string;
  submissionType: AuthoritySubmissionRecord["submissionType"];
  correlationId: string;
}): AuthoritySubmissionRecord {
  requirePermissions(input.context, ["guest_register.submit", "compliance.ses.submit"]);
  const record = demoStore.guestRegisterRecords.find((candidate) => candidate.id === input.recordId);
  if (!record) {
    throw new Error("Guest register record was not found.");
  }
  const validation = validateSpainGuestRegisterRecord(validationInputFromRecord(record));
  if (!validation.valid) {
    record.status = validation.status;
    record.validationErrorsJson = validation.issues;
    throw new Error(`Guest register record cannot be submitted: ${validation.issues.map((issue) => issue.code).join(", ")}`);
  }
  const setting = demoStore.authorityReportingSettings.find((candidate) => candidate.propertyId === record.propertyId);
  const submission: AuthoritySubmissionRecord = {
    id: createId("authsub"),
    propertyId: record.propertyId,
    guestRegisterRecordId: record.id,
    authorityType: setting?.authorityType ?? "ses_hospedajes",
    submissionType: input.submissionType,
    status: "queued",
    requestPayloadJson: validation.payload,
    responsePayloadJson: {},
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  record.status = "queued";
  demoStore.authoritySubmissions.push(submission);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "GuestRegisterQueued",
    entityType: "authority_submission",
    entityId: submission.id,
    afterJson: submission,
    correlationId: input.correlationId
  });
  return submission;
}

export function correctSpainGuestRegisterRecord(input: {
  context: UserContext;
  recordId: string;
  patch: Partial<SpainGuestRegisterRecordInput>;
  correlationId: string;
}): GuestRegisterRecord {
  requirePermissions(input.context, ["guest_register.correct"]);
  const record = patchSpainGuestRegisterRecord({ context: input.context, recordId: input.recordId, patch: input.patch, correlationId: input.correlationId });
  record.status = "corrected";
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GuestRegisterCorrected",
    entityType: "guest_register_record",
    entityId: record.id,
    afterJson: record,
    correlationId: input.correlationId
  });
  return record;
}

export function annulAuthorityCommunication(input: { context: UserContext; recordId: string; reason: string; correlationId: string }) {
  requirePermissions(input.context, ["guest_register.annul"]);
  const submission = demoStore.authoritySubmissions.find((candidate) => candidate.guestRegisterRecordId === input.recordId);
  if (!submission) {
    throw new Error("Authority submission was not found.");
  }
  const before = { ...submission };
  submission.status = "annulled";
  submission.responsePayloadJson = { annulmentReason: input.reason };
  submission.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: submission.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "AuthorityCommunicationAnnulled",
    entityType: "authority_submission",
    entityId: submission.id,
    beforeJson: before,
    afterJson: submission,
    correlationId: input.correlationId
  });
  return submission;
}

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
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "ID_IMAGE_DISCARDED",
    entityType: "identity_document_processing_event",
    entityId: event.id,
    afterJson: event,
    correlationId: input.correlationId
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "TemporaryIdOcrCompleted",
    entityType: "identity_document_processing_event",
    entityId: event.id,
    afterJson: event,
    correlationId: input.correlationId
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "IdImageDiscarded",
    entityType: "identity_document_processing_event",
    entityId: event.id,
    afterJson: event,
    correlationId: input.correlationId
  });
  return event;
}

export function getAuthorityInbox(propertyId: string) {
  const baseIssues = getComplianceInbox(propertyId);
  const authorityIssues = demoStore.authoritySubmissions
    .filter((submission) => submission.propertyId === propertyId && ["queued", "rejected", "failed"].includes(submission.status))
    .map((submission) => ({
      status: submission.status,
      issue:
        submission.status === "queued"
          ? "Guest register authority submission is queued for SES.HOSPEDAJES/manual authority handling."
          : submission.errorMessage ?? "Authority submission needs review.",
      recordId: submission.guestRegisterRecordId,
      deadline: "24h legal deadline",
      authorityTarget: submission.authorityType,
      suggestedAction: submission.status === "queued" ? "Submit or include in daily batch." : "Correct and retry."
    }));
  return [...baseIssues, ...authorityIssues];
}

export function listAuthoritySubmissions(propertyId: string): AuthoritySubmissionRecord[] {
  return demoStore.authoritySubmissions.filter((submission) => submission.propertyId === propertyId);
}

export function getAuthoritySubmission(input: { context: UserContext; submissionId: string; correlationId: string }): AuthoritySubmissionRecord {
  requirePermissions(input.context, ["guest_register.read", "guest_register.view_sensitive"]);
  const submission = demoStore.authoritySubmissions.find((candidate) => candidate.id === input.submissionId);
  if (!submission) {
    throw new Error("Authority submission was not found.");
  }
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: submission.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SensitiveGuestRegisterViewed",
    entityType: "authority_submission",
    entityId: submission.id,
    afterJson: { viewed: true },
    correlationId: input.correlationId
  });
  return submission;
}

export function retryAuthoritySubmission(input: { context: UserContext; submissionId: string; correlationId: string }) {
  requirePermissions(input.context, ["guest_register.submit"]);
  const submission = demoStore.authoritySubmissions.find((candidate) => candidate.id === input.submissionId);
  if (!submission) {
    throw new Error("Authority submission was not found.");
  }
  const before = { ...submission };
  submission.status = "queued";
  submission.errorCode = undefined;
  submission.errorMessage = undefined;
  submission.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: submission.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "AuthoritySubmissionRetried",
    entityType: "authority_submission",
    entityId: submission.id,
    beforeJson: before,
    afterJson: submission,
    correlationId: input.correlationId
  });
  return submission;
}

export function generateSesHospedajesBatch(input: { context: UserContext; propertyId: string; correlationId: string }): AuthoritySubmissionBatchRecord {
  requirePermissions(input.context, ["guest_register.export", "compliance.ses.export"]);
  const dueRecords = demoStore.guestRegisterRecords.filter((record) =>
    record.propertyId === input.propertyId && ["ready_to_submit", "signed", "queued"].includes(record.status)
  );
  const batch: AuthoritySubmissionBatchRecord = {
    id: createId("asb"),
    propertyId: input.propertyId,
    authorityType: "ses_hospedajes",
    batchType: "daily_batch",
    status: "generated",
    periodFrom: new Date().toISOString(),
    periodTo: new Date().toISOString(),
    fileFormat: "json",
    fileObjectKey: `authority-batches/${input.propertyId}-${Date.now()}.json`,
    recordCount: dueRecords.length,
    idempotencyKey: `${input.propertyId}-${new Date().toISOString().slice(0, 10)}-daily`,
    generatedBy: input.context.userId,
    generatedAt: nowIso(),
    responsePayloadJson: {},
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  demoStore.authoritySubmissionBatches.push(batch);
  for (const record of dueRecords) {
    record.status = "exported";
    demoStore.authoritySubmissionBatchRecords.push({
      id: createId("asbr"),
      batchId: batch.id,
      guestRegisterRecordId: record.id,
      status: "included",
      responsePayloadJson: {}
    });
  }
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "AuthorityBatchGenerated",
    entityType: "authority_submission_batch",
    entityId: batch.id,
    afterJson: batch,
    correlationId: input.correlationId
  });
  return batch;
}

export function submitSesHospedajesBatch(input: { context: UserContext; propertyId: string; batchId: string; correlationId: string }) {
  requirePermissions(input.context, ["guest_register.submit", "compliance.ses.submit"]);
  const batch = demoStore.authoritySubmissionBatches.find((candidate) => candidate.id === input.batchId && candidate.propertyId === input.propertyId);
  if (!batch) {
    throw new Error("Authority submission batch was not found.");
  }
  const before = { ...batch };
  batch.status = "submitted";
  batch.submittedBy = input.context.userId;
  batch.submittedAt = nowIso();
  batch.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "AuthorityBatchSubmitted",
    entityType: "authority_submission_batch",
    entityId: batch.id,
    beforeJson: before,
    afterJson: batch,
    correlationId: input.correlationId
  });
  return batch;
}

export function downloadSesHospedajesBatch(input: { context: UserContext; propertyId: string; batchId: string; correlationId: string }) {
  requirePermissions(input.context, ["guest_register.export", "compliance.ses.export"]);
  const batch = demoStore.authoritySubmissionBatches.find((candidate) => candidate.id === input.batchId && candidate.propertyId === input.propertyId);
  if (!batch) {
    throw new Error("Authority submission batch was not found.");
  }
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
  // Build a real downloadable file representing the batch contents. Format
  // follows the requested fileFormat (XML by default for SES.HOSPEDAJES).
  const links = demoStore.authoritySubmissionBatchRecords.filter((l) => l.batchId === batch.id);
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
    // XML (default for SES.HOSPEDAJES)
    content = `<?xml version="1.0" encoding="UTF-8"?>\n<batch id="${escXml(batch.id)}" authority="${escXml(batch.authorityType)}" propertyId="${escXml(batch.propertyId)}" generatedAt="${escXml(batch.generatedAt ?? batch.createdAt)}" recordCount="${batch.recordCount}">\n  <period from="${escXml(batch.periodFrom ?? "")}" to="${escXml(batch.periodTo ?? "")}"/>\n${links.map((l) => `  <record id="${escXml(l.id)}" guestRegisterRecordId="${escXml(l.guestRegisterRecordId)}" status="${escXml(l.status)}"/>`).join("\n")}\n</batch>`;
    contentType = "application/xml;charset=utf-8";
  }
  return { filename, contentType, content, batch };
}

export function markSesBatchManuallyUploaded(input: {
  context: UserContext;
  propertyId: string;
  batchId: string;
  receiptReference?: string;
  correlationId: string;
}) {
  requirePermissions(input.context, ["guest_register.submit", "compliance.ses.submit"]);
  const batch = demoStore.authoritySubmissionBatches.find((candidate) => candidate.id === input.batchId && candidate.propertyId === input.propertyId);
  if (!batch) {
    throw new Error("Authority submission batch was not found.");
  }
  batch.status = "accepted";
  batch.responsePayloadJson = { manuallyUploaded: true, receiptReference: input.receiptReference };
  batch.responseReceivedAt = nowIso();
  batch.updatedAt = nowIso();
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "AuthoritySubmissionAccepted",
    entityType: "authority_submission_batch",
    entityId: batch.id,
    afterJson: batch,
    correlationId: input.correlationId
  });
  return batch;
}

export function testSesHospedajesConnection(input: { context: UserContext; propertyId: string; correlationId: string }) {
  requirePermissions(input.context, ["compliance.ses.configure"]);
  const setting = demoStore.authorityReportingSettings.find((candidate) => candidate.propertyId === input.propertyId);
  return {
    status: setting?.webServiceEnabled ? "needs_official_schema" : "batch_export_ready",
    authorityType: setting?.authorityType ?? "ses_hospedajes",
    message:
      "SES.HOSPEDAJES adapter is configured with mock/file-export support. Production web service requires official documentation, credentials and schema template."
  };
}
