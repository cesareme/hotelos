export type SpainGuestRegisterStatus =
  | "draft"
  | "missing_data"
  | "ready_to_sign"
  | "signed"
  | "ready_to_submit"
  | "queued"
  | "exported"
  | "submitted"
  | "accepted"
  | "rejected"
  | "failed"
  | "annulled"
  | "corrected"
  | "expired";

export type SpainGuestRegisterRecordInput = {
  recordType?: "reservation" | "checkin" | "cancellation" | "correction" | "annulment";
  firstName?: string;
  surname1?: string;
  surname2?: string;
  sex?: string;
  nationality?: string;
  dateOfBirth?: string;
  documentType?: "DNI" | "PASSPORT" | "TIE" | string;
  documentNumber?: string;
  documentSupportNumber?: string;
  residenceFullAddress?: string;
  residenceLocality?: string;
  residenceCountry?: string;
  phoneLandline?: string;
  phoneMobile?: string;
  email?: string;
  travellerCount?: number;
  isMinor?: boolean;
  age?: number;
  providedByAdultGuestId?: string;
  kinshipRelationIfMinor?: string;
  contractReference?: string;
  contractDate?: string;
  checkinAt?: string;
  checkoutAt?: string;
  paymentType?: string;
  paymentMethodIdentifier?: string;
  paymentHolder?: string;
  paymentReference?: string;
  rawCardPan?: string;
  rawCvv?: string;
  signatureRequired?: boolean;
  signedAt?: string;
  idImageStored?: boolean;
  idImageDiscarded?: boolean;
  allowLegalIdImageException?: boolean;
};

export type SpainGuestRegisterValidationIssue = {
  code: string;
  field?: keyof SpainGuestRegisterRecordInput;
  severity: "blocking" | "warning";
  message: string;
};

export type SpainGuestRegisterValidationResult = {
  valid: boolean;
  status: SpainGuestRegisterStatus;
  issues: SpainGuestRegisterValidationIssue[];
  payload: Record<string, unknown>;
};

const REQUIRED_BASE_FIELDS: Array<keyof SpainGuestRegisterRecordInput> = [
  "firstName",
  "surname1",
  "documentType",
  "documentNumber",
  "nationality",
  "dateOfBirth",
  "residenceFullAddress",
  "residenceLocality",
  "residenceCountry",
  "travellerCount",
  "contractReference"
];

const SUPPORT_NUMBER_DOCUMENT_TYPES = new Set(["DNI", "TIE"]);

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

function addMissingIssue(
  issues: SpainGuestRegisterValidationIssue[],
  field: keyof SpainGuestRegisterRecordInput,
  message = `${String(field)} is required by the Spain guest register schema.`
) {
  issues.push({ code: `missing_${String(field)}`, field, severity: "blocking", message });
}

export function buildSpainGuestRegisterPayload(input: SpainGuestRegisterRecordInput): Record<string, unknown> {
  return {
    recordType: input.recordType ?? "checkin",
    identity: {
      firstName: input.firstName,
      surname1: input.surname1,
      surname2: input.surname2,
      sex: input.sex,
      nationality: input.nationality,
      dateOfBirth: input.dateOfBirth,
      documentType: input.documentType,
      documentNumber: input.documentNumber,
      documentSupportNumber: input.documentSupportNumber
    },
    residence: {
      fullAddress: input.residenceFullAddress,
      locality: input.residenceLocality,
      country: input.residenceCountry
    },
    contact: {
      phoneLandline: input.phoneLandline,
      phoneMobile: input.phoneMobile,
      email: input.email
    },
    group: {
      travellerCount: input.travellerCount,
      isMinor: input.isMinor,
      providedByAdultGuestId: input.providedByAdultGuestId,
      kinshipRelationIfMinor: input.kinshipRelationIfMinor
    },
    contract: {
      contractReference: input.contractReference,
      contractDate: input.contractDate,
      checkinAt: input.checkinAt,
      checkoutAt: input.checkoutAt
    },
    payment: {
      paymentType: input.paymentType,
      paymentMethodIdentifier: input.paymentMethodIdentifier,
      paymentHolder: input.paymentHolder,
      paymentReference: input.paymentReference
    },
    privacy: {
      idImageStored: false,
      idImageDiscarded: input.idImageDiscarded === true,
      dataMinimisation: "Store only legal fields. Do not store DNI/passport/TIE image, raw PAN or CVV."
    }
  };
}

export function calculateSpainGuestRegisterRetentionUntil(checkoutOrEndOfService: string | Date): string {
  const retentionUntil = typeof checkoutOrEndOfService === "string" ? new Date(checkoutOrEndOfService) : new Date(checkoutOrEndOfService);
  retentionUntil.setFullYear(retentionUntil.getFullYear() + 3);
  return retentionUntil.toISOString();
}

export function validateSpainGuestRegisterRecord(input: SpainGuestRegisterRecordInput): SpainGuestRegisterValidationResult {
  const issues: SpainGuestRegisterValidationIssue[] = [];

  for (const field of REQUIRED_BASE_FIELDS) {
    if (isMissing(input[field])) {
      addMissingIssue(issues, field);
    }
  }

  if (isMissing(input.sex)) {
    addMissingIssue(issues, "sex", "Sex is required when the configured authority schema requires it.");
  }

  if (input.documentType && SUPPORT_NUMBER_DOCUMENT_TYPES.has(String(input.documentType).toUpperCase()) && isMissing(input.documentSupportNumber)) {
    addMissingIssue(issues, "documentSupportNumber", "Document support number is required for DNI/TIE when the official schema applies it.");
  }

  if (isMissing(input.phoneMobile) && isMissing(input.phoneLandline)) {
    issues.push({
      code: "missing_phone_contact",
      field: "phoneMobile",
      severity: "blocking",
      message: "At least one configured legal phone contact must be present unless the authority schema accepts unavailable values."
    });
  }

  if ((input.recordType ?? "checkin") === "checkin" && isMissing(input.checkinAt)) {
    addMissingIssue(issues, "checkinAt", "Check-in/start-of-service timestamp is required before authority submission.");
  }

  if (input.isMinor === true || (input.age !== undefined && input.age < 14)) {
    if (isMissing(input.providedByAdultGuestId)) {
      addMissingIssue(issues, "providedByAdultGuestId", "Children under 14 must be linked to the accompanying adult who provides their data.");
    }
    if (isMissing(input.kinshipRelationIfMinor)) {
      addMissingIssue(issues, "kinshipRelationIfMinor", "Kinship or relationship is required when a minor is included.");
    }
  }

  const signatureRequired = input.signatureRequired !== false && input.isMinor !== true && !(input.age !== undefined && input.age < 14);
  if (signatureRequired && isMissing(input.signedAt)) {
    issues.push({
      code: "signature_required",
      field: "signedAt",
      severity: "blocking",
      message: "Guest entry form signature is required for travellers older than 14 before submission."
    });
  }

  if (input.idImageStored === true && input.allowLegalIdImageException !== true) {
    issues.push({
      code: "id_image_stored_blocked",
      field: "idImageStored",
      severity: "blocking",
      message: "DNI/passport/TIE images must not be stored by default. Use temporary OCR and log ID_IMAGE_DISCARDED."
    });
  }

  if (input.idImageDiscarded !== true) {
    issues.push({
      code: "id_image_discard_event_missing",
      field: "idImageDiscarded",
      severity: "blocking",
      message: "Temporary scan must be discarded immediately and the ID_IMAGE_DISCARDED audit event must exist."
    });
  }

  if (!isMissing(input.rawCvv)) {
    issues.push({
      code: "cvv_storage_blocked",
      field: "rawCvv",
      severity: "blocking",
      message: "Do not store CVV. Use PSP tokenization and transaction references."
    });
  }

  if (!isMissing(input.rawCardPan)) {
    issues.push({
      code: "pan_storage_blocked",
      field: "rawCardPan",
      severity: "blocking",
      message: "Do not store full PAN by default. Store PSP token, brand, last four and transaction reference only."
    });
  }

  const blocking = issues.some((issue) => issue.severity === "blocking");
  const status: SpainGuestRegisterStatus = blocking ? (issues.some((issue) => issue.code === "signature_required") ? "ready_to_sign" : "missing_data") : "ready_to_submit";

  return {
    valid: !blocking,
    status,
    issues,
    payload: buildSpainGuestRegisterPayload(input)
  };
}
