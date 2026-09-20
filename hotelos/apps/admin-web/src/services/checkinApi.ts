// Check-in automatizado · cliente del admin-web (Tanda CHK · lote W4-A,
// docs/design/CHECKIN-AUTOMATIZADO-IA.md §7.2 y §8 «Drawer de check-in»).
//
// Tipado con los contratos wire de @hotelos/shared (checkin-types.ts) y con las
// formas que devuelven las rutas de apps/api/src/modules/checkin/checkin.routes.ts
// (vista de recepción, captura, firma, cotejo, check-in completo) y
// apps/api/src/modules/pms/room-assignment.routes.ts (sugerencias). Todo pasa
// por `apiRequest` (services/api-client.ts): sesión, `x-property-id` y 401 como
// el resto de servicios; los 4xx tipados llegan como `ApiError` con
// `details.code` (CHECKIN_ERROR_CODES + CHECKIN_ALREADY_DONE / BALANCE_DUE).
//
// Privacidad: ningún DTO de aquí transporta PII más allá del nombre del viajero
// y de los 3 últimos caracteres del documento (contrato del módulo). El
// resultado de una lectura (`IdentityCaptureResult`) SÍ lleva en memoria los
// campos leídos del documento: el cajón los pinta con su origen y confianza y
// no los guarda en ningún sitio del navegador.
//
// Sin hardware ni proveedores: el escaneo por imagen solo lee la MRZ cuando hay
// proveedor de visión configurado; sin él, el API responde 400
// DOCUMENT_UNREADABLE y recepción pega la MRZ del lector (`applyMrz`).

import type {
  AssignmentSuggestionDto,
  CheckInChannel,
  CheckInGuestDto,
  CheckInSessionDto,
  DocumentCaptureFields,
  DocumentCaptureSource,
  IdentityVerificationMethod,
  KioskDeviceCapabilities,
  KioskDeviceDto,
  MrzChecks,
  PropertyCheckInPolicyDto,
  SignatureMethod
} from "@hotelos/shared";
import { ApiError, apiRequest, type RequestOptions } from "./api-client";

// ---------------------------------------------------------------------------
// Formas de respuesta (espejo de checkin.routes.ts · arrival.service.ts ·
// identity-capture.service.ts · signature.service.ts · room-assignment.service.ts)
// ---------------------------------------------------------------------------

/** document_captures sin PII (GET /reservations/:id/check-in → guests[].captures). */
export type CheckInCaptureSummary = {
  id: string;
  checkInGuestId: string;
  source: DocumentCaptureSource;
  mrzFormat: string | null;
  checksJson: MrzChecks | null;
  needsReviewJson: string[] | null;
  imageStored: boolean;
  processingMs: number | null;
  purgeAt: string;
  createdAt: string;
};

/** signatures sin trazo (GET /reservations/:id/check-in → guests[].signatures). */
export type CheckInSignatureSummary = {
  id: string;
  checkInGuestId: string | null;
  guestRegisterRecordId: string | null;
  method: SignatureMethod;
  sha256: string;
  pdfSha256: string | null;
  signedAt: string;
  retentionUntil: string;
};

export type ReservationCheckInGuest = CheckInGuestDto & {
  identityVerifiedBy: string | null;
  captures: CheckInCaptureSummary[];
  signatures: CheckInSignatureSummary[];
};

/** Vista de recepción de la sesión: sesión + política + pasos + viajeros con capturas y firmas (sin PII). */
export type ReservationCheckInView = Omit<CheckInSessionDto, "guests"> & {
  policy: PropertyCheckInPolicyDto;
  steps: Array<{ key: string; status: string } & Record<string, unknown>>;
  guests: ReservationCheckInGuest[];
};

export type IdentityCaptureFields = DocumentCaptureFields & {
  residenceFullAddress?: string;
  residenceLocality?: string;
  residenceCountry?: string;
};
export type IdentityCaptureFieldKey = keyof IdentityCaptureFields;

/** Resultado EN MEMORIA de una lectura (POST /reservations/:id/check-in/scan). */
export type IdentityCaptureResult = {
  fields: IdentityCaptureFields;
  /** 0..1 por campo extraído. */
  confidence: Partial<Record<IdentityCaptureFieldKey, number>>;
  checks: MrzChecks;
  source: DocumentCaptureSource;
  mrzFormat: "TD1" | "TD3" | null;
  /** Campo, «mrz» (banda completa) o «identity_mismatch» (no coincide con la reserva). */
  needsReview: string[];
  warnings: string[];
  captureId: string;
  /** false sin `checkInGuestId`: no hay fila y el viajero no recibe los datos. */
  persisted: boolean;
  vision: { model: string; tokensInput: number; tokensOutput: number; costEur: number | null } | null;
  processingMs: number;
};

export type SignatureStrokeMeta = { points: number; durationMs: number; bbox: Record<string, number> };

export type SignAtReceptionInput = {
  checkInGuestId?: string;
  guestRegisterRecordId?: string;
  /** PNG en base64 (con o sin prefijo data:image/png;base64,). */
  pngBase64: string;
  svg?: string;
  strokeMeta: SignatureStrokeMeta;
};

export type SignAtReceptionResult = {
  signatureId: string;
  guestRegisterRecordId: string;
  checkInGuestId: string | null;
  sha256: string;
  pdfSha256: string;
  signedAt: string;
  retentionUntil: string;
  method: SignatureMethod;
  guestRegisterStatus: string;
  checkInGuestStatus: string | null;
};

export type VerifyIdentityInput = { checkInGuestId: string; method?: IdentityVerificationMethod };

export type VerifyIdentityResult = {
  guest: CheckInGuestDto;
  guestRegisterRecord: { id: string; identityVerified: boolean; identityVerificationMethod: string | null; status: string } | null;
};

/** Sugerencia persistida más el detalle en memoria del motor (POST …/assignment-suggestions, 201). */
export type AssignmentSuggestionDetail = AssignmentSuggestionDto & {
  rejected: Array<{ roomId?: string; number?: string; reason?: string } & Record<string, unknown>>;
  dataNotes: string[];
  housekeepingAlerts: Array<Record<string, unknown>>;
  persisted: boolean;
};

export type AssignmentSuggestionsResponse = { current: AssignmentSuggestionDto | null; history: AssignmentSuggestionDto[] };

export type ConfirmSuggestionResult = {
  suggestion: AssignmentSuggestionDto;
  reservation: { id: string; status: string; assignedRoomId?: string | null } & Record<string, unknown>;
};

/** POST /reservations/:id/check-in/complete (CompleteCheckInSchema: allowEarlyCheckIn exige overrideReason). */
export type CompleteCheckInBody = {
  roomId?: string;
  overrideReason?: string;
  allowEarlyCheckIn?: boolean;
  verification?: { method?: IdentityVerificationMethod };
  /** Solo comprueba las precondiciones (sesión, ventana, identidad, firmas) sin asignar, cobrar ni alojar (corrector REV3-03). */
  dryRun?: boolean;
};

/** Respuesta de POST …/check-in/complete con `dryRun: true` (arrival.service.ts precheckCheckIn). */
export type PrecheckCheckInResult = {
  ok: true;
  dryRun: true;
  reservationId: string;
  sessionId: string;
  actor: "user";
  identityMethod: IdentityVerificationMethod;
  /** Partes creados por recepción desde los viajeros con datos completos (0 si ya existían). */
  recordsCreated: number;
  warnings: string[];
};

export type ArrivalKey = {
  serialNumber: string;
  qr: string;
  validFrom: string;
  validUntil: string;
  wallet: { apple: { signedByApple: boolean; pass: unknown }; google: unknown };
} | null;

export type ArrivalSesSubmission = { guestRegisterRecordId: string; submissionId: string | null; status: string; code: string | null };

export type CompleteCheckInResult = {
  reservationId: string;
  sessionId: string;
  actor: "guest" | "kiosk" | "user";
  room: { id: string; number: string; floor: string | null };
  /** true cuando la habitación no estaba lista y el API la cambió por otra de la misma categoría. */
  reassigned: boolean;
  key: ArrivalKey;
  ses: { status: "queued" | "partial" | "warning"; submissions: ArrivalSesSubmission[]; warnings: string[] };
  welcome: { status: string; channel?: string | null; error?: string | null } & Record<string, unknown>;
  checkedInAt: string;
  warnings: string[];
};

/** details de los 409 ROOM_NOT_READY (arrival.service.ts). */
export type RoomNotReadyDetails = {
  code: "ROOM_NOT_READY";
  roomId: string | null;
  roomNumber: string | null;
  etaReady: string | null;
  handoffKind?: string;
};

export type InviteSessionResult = {
  session: CheckInSessionDto;
  /** Solo fuera de producción o cuando la entrega fue simulada. */
  token?: string;
  checkInUrl?: string;
  notification: { dispatched: boolean; simulated: boolean; channel: CheckInChannel | null; reason?: string; deliveryId?: string };
};

export type CheckInPolicyPatch = Partial<Omit<PropertyCheckInPolicyDto, "propertyId" | "updatedAt">>;

export type KioskCreateInput = { name: string; capabilities?: Partial<KioskDeviceCapabilities>; lockProvider?: string | null; config?: Record<string, unknown> };

/** POST /properties/:id/kiosks/:id/pair (kiosk.service.ts startPairing): el código se llama `code` (corrector SEC-10: una sola forma). */
export type KioskPairingResult = { device: KioskDeviceDto; code: string; expiresAt: string };

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

/** `details.code` de un ApiError del módulo (ROOM_NOT_READY, GUEST_REGISTER_INCOMPLETE…) o null. */
export function checkInErrorCode(error: unknown): string | null {
  const details = (error as { details?: unknown } | null)?.details;
  const code = (details as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** `details` de un ApiError del módulo con el código pedido, ya tipado; null en cualquier otro caso. */
export function checkInErrorDetails<T extends { code: string }>(error: unknown, code: T["code"]): T | null {
  return checkInErrorCode(error) === code ? ((error as { details: T }).details ?? null) : null;
}

/** GET /reservations/:id/check-in responde 404 cuando la reserva no tiene sesión de check-in en línea. */
export function isCheckInSessionMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Líneas de la MRZ pegadas por recepción: sin líneas vacías, en mayúsculas y sin espacios (ICAO 9303). */
export function normalizeMrzInput(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase().replace(/\s+/g, ""))
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Rutas de recepción sobre la reserva
// ---------------------------------------------------------------------------

function reservationPath(reservationId: string, suffix = ""): string {
  return `/reservations/${encodeURIComponent(reservationId)}/check-in${suffix}`;
}

export function getCheckInSession(reservationId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<ReservationCheckInView> {
  return apiRequest<ReservationCheckInView>(reservationPath(reservationId), options);
}

/** Escaneo por imagen (`data:image/…;base64,…`); con `checkInGuestId` la captura se persiste y el viajero recibe los datos. */
export function scanDocument(reservationId: string, imageDataUrl: string, checkInGuestId?: string | null, documentType?: string | null): Promise<IdentityCaptureResult> {
  return apiRequest<IdentityCaptureResult>(reservationPath(reservationId, "/scan"), {
    method: "POST",
    body: {
      imageDataUrl,
      ...(checkInGuestId ? { checkInGuestId } : {}),
      ...(documentType ? { documentType } : {})
    }
  });
}

/** MRZ del lector o pegada a mano: mismo endpoint que el escaneo, con `mrzLines` (fuente mrz_reader). */
export function applyMrz(reservationId: string, mrzLines: string | readonly string[], checkInGuestId?: string | null, documentType?: string | null): Promise<IdentityCaptureResult> {
  const lines = typeof mrzLines === "string" ? normalizeMrzInput(mrzLines) : [...mrzLines];
  return apiRequest<IdentityCaptureResult>(reservationPath(reservationId, "/scan"), {
    method: "POST",
    body: {
      mrzLines: lines,
      ...(checkInGuestId ? { checkInGuestId } : {}),
      ...(documentType ? { documentType } : {})
    }
  });
}

/** Firma en el pad de recepción (touch_reception): viajero de la sesión o parte. */
export function signAtReception(reservationId: string, input: SignAtReceptionInput): Promise<SignAtReceptionResult> {
  return apiRequest<SignAtReceptionResult>(reservationPath(reservationId, "/signature"), { method: "POST", body: input });
}

/** Cotejo de identidad en mostrador (por defecto visual_reception); exige guest_register.edit. */
export function verifyIdentity(reservationId: string, input: VerifyIdentityInput): Promise<VerifyIdentityResult> {
  return apiRequest<VerifyIdentityResult>(reservationPath(reservationId, "/verify-identity"), {
    method: "POST",
    body: { checkInGuestId: input.checkInGuestId, method: input.method ?? "visual_reception" }
  });
}

/** Check-in completo: habitación lista, identidad y firmas ya en el API; devuelve habitación, llave, SES y avisos. */
export function completeCheckIn(reservationId: string, body: CompleteCheckInBody): Promise<CompleteCheckInResult> {
  return apiRequest<CompleteCheckInResult>(reservationPath(reservationId, "/complete"), { method: "POST", body: { ...body, dryRun: undefined } });
}

/**
 * Comprobación previa del check-in completo (corrector REV3-03): mismos 409 que
 * completeCheckIn (CHECKIN_INCOMPLETE, IDENTITY_NOT_VERIFIED, GUEST_REGISTER_INCOMPLETE,
 * CHECK_IN_DATE_OUT_OF_RANGE…) SIN asignar, cobrar ni alojar; el cajón la lanza
 * antes del cobro para no dejar un cargo capturado sin check-in.
 */
export function precheckCheckIn(reservationId: string, body: Omit<CompleteCheckInBody, "dryRun">): Promise<PrecheckCheckInResult> {
  return apiRequest<PrecheckCheckInResult>(reservationPath(reservationId, "/complete"), { method: "POST", body: { ...body, dryRun: true } });
}

/** Recepción resuelve una derivación (`handed_off`): la sesión vuelve a ready_for_arrival (partes creados) o in_progress. */
export function resolveCheckInHandoff(reservationId: string, note?: string): Promise<CheckInSessionDto & { resolvedTo: string; missing: unknown[] }> {
  return apiRequest(reservationPath(reservationId, "/resolve-handoff"), { method: "POST", body: note ? { note } : {} });
}

// ---------------------------------------------------------------------------
// Sugerencias de habitación con motivo (room-assignment.routes.ts)
// ---------------------------------------------------------------------------

export function getSuggestions(reservationId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<AssignmentSuggestionsResponse> {
  return apiRequest<AssignmentSuggestionsResponse>(`/reservations/${encodeURIComponent(reservationId)}/assignment-suggestions`, options);
}

export function createSuggestion(reservationId: string, sessionId?: string | null): Promise<AssignmentSuggestionDetail> {
  return apiRequest<AssignmentSuggestionDetail>(`/reservations/${encodeURIComponent(reservationId)}/assignment-suggestions`, {
    method: "POST",
    body: sessionId ? { sessionId } : {}
  });
}

/** Sin `roomId`, la primera candidata; la decisión queda auditada (ASSIGNMENT_SUGGESTION_DECIDED). */
export function confirmSuggestion(suggestionId: string, roomId?: string | null): Promise<ConfirmSuggestionResult> {
  return apiRequest<ConfirmSuggestionResult>(`/assignment-suggestions/${encodeURIComponent(suggestionId)}/confirm`, {
    method: "POST",
    body: roomId ? { roomId } : {}
  });
}

// ---------------------------------------------------------------------------
// Sesiones, política y kioscos de la propiedad
// ---------------------------------------------------------------------------

function propertyPath(propertyId: string, suffix: string): string {
  return `/properties/${encodeURIComponent(propertyId)}${suffix}`;
}

export function inviteSession(propertyId: string, reservationId: string, channel: CheckInChannel = "email"): Promise<InviteSessionResult> {
  return apiRequest<InviteSessionResult>(propertyPath(propertyId, "/check-in/sessions"), { method: "POST", body: { reservationId, channel } });
}

export function getPolicy(propertyId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<PropertyCheckInPolicyDto> {
  return apiRequest<PropertyCheckInPolicyDto>(propertyPath(propertyId, "/check-in/policy"), options);
}

export function putPolicy(propertyId: string, patch: CheckInPolicyPatch): Promise<PropertyCheckInPolicyDto> {
  return apiRequest<PropertyCheckInPolicyDto>(propertyPath(propertyId, "/check-in/policy"), { method: "PUT", body: patch });
}

export function listKiosks(propertyId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<KioskDeviceDto[]> {
  return apiRequest<KioskDeviceDto[]>(propertyPath(propertyId, "/kiosks"), options);
}

export function createKiosk(propertyId: string, input: KioskCreateInput): Promise<KioskDeviceDto> {
  return apiRequest<KioskDeviceDto>(propertyPath(propertyId, "/kiosks"), { method: "POST", body: input });
}

/** Inicia el emparejamiento: el código de 8 dígitos se muestra UNA vez a la persona que lo pide. */
export function pairKiosk(propertyId: string, kioskId: string): Promise<KioskPairingResult> {
  return apiRequest<KioskPairingResult>(propertyPath(propertyId, `/kiosks/${encodeURIComponent(kioskId)}/pair`), { method: "POST", body: {} });
}
