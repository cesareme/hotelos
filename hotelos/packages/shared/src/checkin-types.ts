// Check-in automatizado y recepcionista IA (Tanda CHK · W1-A, 2026-09-19).
//
// Contrato wire compartido por el API (módulo checkin), el portal del huésped,
// el kiosco y el admin-web: estados de la sesión y del viajero, canales,
// métodos de verificación de identidad, vocabulario de preferencias, DTOs y
// códigos de error. Diseño: docs/design/CHECKIN-AUTOMATIZADO-IA.md §6 (modelo
// de datos) y §7 (API, permisos, privacidad). Cada enumeración se declara como
// array `as const` + unión literal para que los tests de contrato sin
// TypeScript (tests/checkin-schema-contract.test.mjs) lean los valores y los
// comparen con los `///` de schema.prisma: 0 enums Prisma nuevos, los estados
// son String documentados (como PropertyAiToolSetting.automationLevel).
//
// Privacidad: ningún DTO de este fichero transporta PII más allá del nombre
// del viajero y de los 3 últimos caracteres del documento
// (`documentNumberLast3`). El número completo, el soporte, el correo, el
// móvil y la dirección viven cifrados en checkin_guests
// (PII_FIELDS.CheckInGuest, packages/database/src/crypto-fields.ts) y no
// salen por la API. `DocumentCaptureResult` es el resultado EN MEMORIA de una
// lectura (sí lleva los campos PII que se escriben en CheckInGuest); lo que se
// persiste en document_captures.fields_json es SOLO `DOCUMENT_CAPTURE_NON_PII_FIELDS`.

import type { MoneyString } from "./accounting-types.js";

// ---------------------------------------------------------------------------
// Estados y vocabularios (espejo de los `///` de schema.prisma)
// ---------------------------------------------------------------------------

/** CheckInSession.status */
export const CHECKIN_SESSION_STATUSES = [
  "invited",
  "in_progress",
  "ready_for_arrival",
  "arrived",
  "checked_in",
  "handed_off",
  "expired",
  "cancelled"
] as const;
export type CheckInSessionStatus = (typeof CHECKIN_SESSION_STATUSES)[number];

/** CheckInSession.channel · PropertyCheckInPolicy.welcomeChannelOrderJson[] */
export const CHECKIN_CHANNELS = ["email", "whatsapp", "sms", "kiosk", "reception", "manual"] as const;
export type CheckInChannel = (typeof CHECKIN_CHANNELS)[number];

/** CheckInGuest.status */
export const CHECKIN_GUEST_STATUSES = ["pending", "document_captured", "data_complete", "signed", "verified"] as const;
export type CheckInGuestStatus = (typeof CHECKIN_GUEST_STATUSES)[number];

/**
 * CheckInGuest.identityVerificationMethod · PropertyCheckInPolicy.allowedVerificationMethodsJson[].
 * Ninguno requiere hardware ni proveedor: reader_hardware y midni_qr son
 * adaptadores con implementación local hasta que César aporte el dispositivo.
 */
export const IDENTITY_VERIFICATION_METHODS = [
  "visual_reception",
  "mrz_checksum",
  "otp_phone",
  "otp_email",
  "payment_match",
  "midni_qr",
  "reader_hardware"
] as const;
export type IdentityVerificationMethod = (typeof IDENTITY_VERIFICATION_METHODS)[number];

/** DocumentCapture.source */
export const DOCUMENT_CAPTURE_SOURCES = ["mrz_reader", "mrz_ai", "ai_vision", "manual"] as const;
export type DocumentCaptureSource = (typeof DOCUMENT_CAPTURE_SOURCES)[number];

/** CheckInSession.paymentStatus */
export const CHECKIN_PAYMENT_STATUSES = ["none", "link_sent", "paid", "authorized", "failed", "at_reception"] as const;
export type CheckInPaymentStatus = (typeof CHECKIN_PAYMENT_STATUSES)[number];

/**
 * Vocabulario cerrado de preferencias del huésped (CheckInSession.preferencesJson,
 * Guest.preferencesJson normalizado). El motor de asignación solo entiende estas
 * claves; el texto libre del huésped se clasifica a una de ellas o se descarta.
 */
export const PREFERENCE_VOCABULARY = [
  "floor_high",
  "floor_low",
  "quiet",
  "near_elevator",
  "far_elevator",
  "view_sea",
  "view_city",
  "bed_twin",
  "bed_king",
  "accessible",
  "connecting",
  "crib"
] as const;
export type GuestPreferenceCode = (typeof PREFERENCE_VOCABULARY)[number];

/** AssignmentSuggestion.status */
export const ASSIGNMENT_SUGGESTION_STATUSES = ["suggested", "confirmed", "changed", "auto_assigned", "expired"] as const;
export type AssignmentSuggestionStatus = (typeof ASSIGNMENT_SUGGESTION_STATUSES)[number];

/** AssignmentSuggestion.source */
export const ASSIGNMENT_SOURCES = ["rules", "rules+ai"] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

/** PropertyCheckInPolicy.autoAssignLevel · AssignmentSuggestion.automationLevel */
export const AUTO_ASSIGN_LEVELS = ["suggest", "suggest_and_confirm", "preassign"] as const;
export type AutoAssignLevel = (typeof AUTO_ASSIGN_LEVELS)[number];

/** PropertyCheckInPolicy.depositPolicy */
export const DEPOSIT_POLICIES = ["none", "balance", "first_night", "fixed"] as const;
export type DepositPolicy = (typeof DEPOSIT_POLICIES)[number];

/** KioskDevice.status */
export const KIOSK_DEVICE_STATUSES = ["unpaired", "online", "offline", "disabled"] as const;
export type KioskDeviceStatus = (typeof KIOSK_DEVICE_STATUSES)[number];

/** Signature.method */
export const SIGNATURE_METHODS = ["touch_portal", "touch_kiosk", "touch_reception", "paper_scanned"] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

/** RoomBlock.reason */
export const ROOM_BLOCK_REASONS = ["maintenance", "deep_clean", "owner", "event", "other"] as const;
export type RoomBlockReason = (typeof ROOM_BLOCK_REASONS)[number];

/** RoomConnection.kind */
export const ROOM_CONNECTION_KINDS = ["connecting", "adjacent"] as const;
export type RoomConnectionKind = (typeof ROOM_CONNECTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Sesión y viajeros
// ---------------------------------------------------------------------------

/** CheckInSession.consentJson */
export interface CheckInConsentDto {
  /** ISO 8601 del consentimiento RGPD, null si no se ha dado. */
  gdprAt: string | null;
  /** ISO 8601 de la aceptación del aviso de IA (GUEST_AI_DISCLOSURE). */
  aiDisclosureAt: string | null;
  marketing: boolean;
  whatsappOptInAt: string | null;
}

export interface CheckInSessionDto {
  id: string;
  propertyId: string;
  reservationId: string;
  status: CheckInSessionStatus;
  channel: CheckInChannel;
  invitedAt: string | null;
  reminderAt: string | null;
  completedAt: string | null;
  arrivedAt: string | null;
  checkedInAt: string | null;
  /** HH:MM declarada por el huésped. */
  etaDeclared: string | null;
  preferences: GuestPreferenceCode[];
  consent: CheckInConsentDto;
  paymentStatus: CheckInPaymentStatus;
  /** Motivo por el que la sesión pasó a recepción (handed_off), si aplica. */
  handoffKind: string | null;
  handoffReason: string | null;
  kioskDeviceId: string | null;
  guests: CheckInGuestDto[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Viajero de la sesión sin PII: nombre y apellidos, últimos 3 caracteres del
 * documento y banderas de presencia (hasEmail / hasPhoneMobile). Ni número de
 * documento, ni soporte, ni correo, ni móvil, ni dirección, ni fecha de nacimiento.
 */
export interface CheckInGuestDto {
  id: string;
  sessionId: string;
  guestId: string | null;
  guestRegisterRecordId: string | null;
  isPrimary: boolean;
  ordinal: number;
  status: CheckInGuestStatus;
  ageAtArrival: number | null;
  isMinor: boolean;
  /** Adulto de la misma sesión que aporta los datos del menor. */
  providedByCheckInGuestId: string | null;
  kinship: string | null;
  guardianTitle: string | null;
  identityVerificationMethod: IdentityVerificationMethod | null;
  identityVerifiedAt: string | null;
  firstName: string | null;
  surname1: string | null;
  surname2: string | null;
  nationality: string | null;
  documentType: string | null;
  /** Últimos 3 caracteres del número de documento; nunca el número completo. */
  documentNumberLast3: string | null;
  hasEmail: boolean;
  hasPhoneMobile: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Lectura de documentos (MRZ ICAO 9303 por reglas · visión por ai-core)
// ---------------------------------------------------------------------------

/** DocumentCapture.checksJson: resultado de cada dígito de control MRZ (null = no aplicable). */
export interface MrzChecks {
  document: boolean | null;
  birth: boolean | null;
  expiry: boolean | null;
  composite: boolean | null;
}

/**
 * Campos extraíbles de un documento de identidad. Fechas en ISO 8601 (YYYY-MM-DD).
 * Los marcados como PII se escriben cifrados en CheckInGuest y NUNCA en
 * document_captures.fields_json (ver DOCUMENT_CAPTURE_NON_PII_FIELDS).
 */
export interface DocumentCaptureFields {
  documentType?: string;
  mrzFormat?: "TD1" | "TD3";
  issuingCountry?: string;
  nationality?: string;
  sex?: string;
  dateOfBirth?: string;
  documentExpiryDate?: string;
  /** PII */
  documentNumber?: string;
  /** PII */
  documentSupportNumber?: string;
  /** PII */
  firstName?: string;
  /** PII */
  surname1?: string;
  /** PII */
  surname2?: string;
}

/** Únicas claves de DocumentCaptureFields que pueden persistirse en document_captures.fields_json. */
export const DOCUMENT_CAPTURE_NON_PII_FIELDS = [
  "documentType",
  "mrzFormat",
  "issuingCountry",
  "nationality",
  "sex",
  "dateOfBirth",
  "documentExpiryDate"
] as const satisfies readonly (keyof DocumentCaptureFields)[];

export interface DocumentCaptureResult {
  fields: DocumentCaptureFields;
  /** Confianza 0..1 por campo extraído. */
  confidence: Partial<Record<keyof DocumentCaptureFields, number>>;
  checks: MrzChecks;
  source: DocumentCaptureSource;
  /** Campos que la recepción debe revisar (baja confianza o checksum fallido). */
  needsReview: (keyof DocumentCaptureFields)[];
}

// ---------------------------------------------------------------------------
// Asignación de habitación con motivo
// ---------------------------------------------------------------------------

export interface AssignmentReason {
  /** Regla que aporta puntuación (p. ej. preference:quiet, room_type_match, block_free). */
  rule: string;
  weight: number;
  /** Texto en español para la ConfirmationCard. */
  detail: string;
}

export interface AssignmentCandidate {
  roomId: string;
  number: string;
  score: number;
  reasons: AssignmentReason[];
  warnings: string[];
}

export interface AssignmentSuggestionDto {
  id: string;
  propertyId: string;
  reservationId: string;
  sessionId: string | null;
  candidates: AssignmentCandidate[];
  rejectedCount: number;
  chosenRoomId: string | null;
  /** 0..1 */
  confidence: number;
  rulesVersion: string;
  source: AssignmentSource;
  automationLevel: AutoAssignLevel;
  status: AssignmentSuggestionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  aiToolCallId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Política de la propiedad y kiosco
// ---------------------------------------------------------------------------

export interface PropertyCheckInPolicyDto {
  propertyId: string;
  selfCheckInEnabled: boolean;
  inviteDaysBefore: number;
  reminderDaysBefore: number;
  allowedVerificationMethods: IdentityVerificationMethod[];
  requireVisualCheckAtKiosk: boolean;
  requireInspectedRoom: boolean;
  depositPolicy: DepositPolicy;
  depositAmount: MoneyString | null;
  /** Sin PSP: `at_reception` satisface depositPolicy para el huésped/kiosco solo si es true (recepción nunca queda bloqueada). */
  allowPayAtReception: boolean;
  allowWalkIn: boolean;
  allowUpgradeSuggestion: boolean;
  autoAssignLevel: AutoAssignLevel;
  /** Peso por regla del motor de asignación; vacío = pesos por defecto de rulesVersion. */
  assignmentWeights: Record<string, number>;
  welcomeChannelOrder: CheckInChannel[];
  guestConsentText: string | null;
  aiDisclosureText: string | null;
  /** Tanda L7 (L7-04): el tick del check-in invita a la encuesta post-estancia a las reservas checked_out (opt-in por propiedad). */
  postStaySurveyEnabled: boolean;
  /** Horas desde las 00:00 (hora local del tick) del día de salida hasta la invitación (0-72; 24 = el día siguiente). */
  postStaySurveyDelayHours: number;
  updatedAt: string;
}

/** KioskDevice.capabilitiesJson */
export interface KioskDeviceCapabilities {
  mrzReader: boolean;
  cardEncoder: boolean;
  paymentTerminal: boolean;
  printer: boolean;
}

/** Kiosco sin secretos: ni pairingCodeHash ni deviceTokenHash salen por la API. */
export interface KioskDeviceDto {
  id: string;
  propertyId: string;
  name: string;
  status: KioskDeviceStatus;
  paired: boolean;
  pairedAt: string | null;
  pairingExpiresAt: string | null;
  lastSeenAt: string | null;
  capabilities: KioskDeviceCapabilities;
  lockProvider: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Códigos de error (respuestas 4xx del módulo checkin)
// ---------------------------------------------------------------------------

export const CHECKIN_ERROR_CODES = [
  "GUEST_SESSION_INVALID",
  "CHECKIN_GUEST_LIMIT",
  "DOCUMENT_UNREADABLE",
  "MRZ_CHECKSUM_FAILED",
  "IDENTITY_MISMATCH",
  "SIGNATURE_NOT_REQUIRED",
  "GUEST_REGISTER_INCOMPLETE",
  "CHECKIN_INCOMPLETE",
  "ROOM_NOT_READY",
  "ROOM_BLOCKED",
  "BALANCE_DUE",
  "CHECKIN_ALREADY_DONE",
  "IDENTITY_NOT_VERIFIED",
  "CHECK_IN_DATE_OUT_OF_RANGE",
  "PSP_NOT_CONFIGURED",
  "UPSELL_UNAVAILABLE",
  "KIOSK_PAIRING_INVALID",
  "OTP_INVALID",
  "OTP_RATE_LIMITED"
] as const;
export type CheckInErrorCode = (typeof CHECKIN_ERROR_CODES)[number];
