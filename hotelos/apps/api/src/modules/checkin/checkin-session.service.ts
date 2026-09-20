// Sesión de pre-llegada del check-in automatizado (Tanda CHK · lote W2-A;
// diseño §4a pasos 1-2, 6 y 9, §6 CheckInSession/CheckInGuest/DocumentCapture,
// §7.1 rutas de huésped y §7.2 arrivals/sessions).
//
// Qué hace este fichero:
//   · ensureSession: 1 CheckInSession `invited` por reserva + 1 CheckInGuest por
//     viajero (titular y acompañantes desde reservation_guests, isPrimary
//     primero, rellenados desde Guest —la extensión de cifrado descifra Guest y
//     cifra CheckInGuest—; huecos hasta adults+children como `pending` sin
//     datos); ageAtArrival con ageAtDate (compliance.service.ts) e isMinor < 14.
//   · inviteReservation: ensureSession + GuestPortalSession con token opaco
//     (randomBytes(32).hex, hash sha256 en tokenHash, misma forma que
//     guest-portal-auth.service.ts; TTL = salida + 1 día) + dispatch de
//     `checkin_invitation` por el canal disponible con consentimiento (email si
//     hay correo; whatsapp si hay móvil y opt-in; sms si hay teléfono).
//     `template_not_found` NO rompe la invitación: { dispatched:false, reason }.
//   · getSessionForToken / getSessionView: verifyGuestToken → CheckInSessionDto
//     con viajeros, política de la propiedad y pasos. Un token de otra
//     propiedad no localiza nada (GuestPortalAuthError → 401).
//   · updateSession: ETA → Reservation.eta (normalizeArrivalEta) y etaDeclared;
//     preferencias filtradas por PREFERENCE_VOCABULARY a la sesión y a
//     Guest.preferencesJson (string[]) del titular; texto libre a
//     Reservation.specialRequests si no existe; consentimientos fechados.
//   · upsertGuest / removeGuest: alta hasta adults+children (409
//     CHECKIN_GUEST_LIMIT), un menor exige providedByCheckInGuestId adulto de la
//     sesión (por defecto el titular adulto).
//   · applyMrz: parseMrz (W1-B) válida → campos con source mrz_reader en
//     DocumentCapture (sin imagen, solo campos no PII en fieldsJson), viajero
//     document_captured + identityVerificationMethod mrz_checksum SIN marcar
//     identityVerifiedAt (el checksum no verifica a la persona);
//     inválida → 400 MRZ_CHECKSUM_FAILED.
//   · completePreArrival: todos los viajeros con los datos del parte completos
//     (validateSpainGuestRegisterRecord sin exigir la firma; menores < 14 sin
//     firma) → ready_for_arrival, completedAt, evento CheckInPreArrivalCompleted
//     y parte por viajero (createSpainGuestRegisterRecord / patch si ya existe,
//     dedupe por (reservationId, guestId)) con el contexto de servicio;
//     si faltan datos 409 CHECKIN_INCOMPLETE { missing }.
//   · listArrivals: llegadas del día con preCheckIn, suggestion y key para Mi día.
//
// Permisos: las escrituras de dominio van con checkInServiceContext (actor
// guest/system; nunca demoStore.userContext ni request.userContext del
// huésped). Auditoría con actorType "system" y actorUserId = context.userId.
// Privacidad: ningún DTO ni evento lleva PII más allá del nombre y los 3
// últimos caracteres del documento; los destinatarios de la invitación salen
// enmascarados.

import { createHash, randomBytes } from "node:crypto";
import type {
  CheckInChannel,
  CheckInConsentDto,
  CheckInGuestDto,
  CheckInGuestStatus,
  CheckInPaymentStatus,
  CheckInSessionDto,
  CheckInSessionStatus,
  DocumentCaptureFields,
  GuestPreferenceCode,
  IdentityVerificationMethod,
  MrzChecks,
  PropertyCheckInPolicyDto
} from "@hotelos/shared";
import {
  CHECKIN_CHANNELS,
  CHECKIN_GUEST_STATUSES,
  CHECKIN_PAYMENT_STATUSES,
  CHECKIN_SESSION_STATUSES,
  DOCUMENT_CAPTURE_NON_PII_FIELDS,
  IDENTITY_VERIFICATION_METHODS,
  PREFERENCE_VOCABULARY
} from "@hotelos/shared";
import { parseMrz, validateSpainGuestRegisterRecord, type MrzFields, type SpainGuestRegisterRecordInput } from "@hotelos/compliance";
import { prisma, type Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { createId, nowIso } from "../../lib/ids.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import {
  GUEST_REGISTER_MINOR_AGE,
  ageAtDate,
  createSpainGuestRegisterRecord,
  patchSpainGuestRegisterRecord,
  type GuestRegisterWriteInput
} from "../compliance/compliance.service.js";
import { verifyGuestToken, type VerifiedGuestSession } from "../guest-portal/guest-portal-auth.service.js";
import { GuestPortalAuthError, normalizeArrivalEta } from "../guest-portal/guest-portal.service.js";
import { dispatch } from "../notifications/dispatcher.service.js";
import { readCheckInConfig } from "./checkin-config.js";
import { getPolicy } from "./checkin-policy.service.js";
import type { ConsentInput, GuestInput } from "./checkin.schemas.js";
import { IDENTITY_MISMATCH_WARNING, identityNameMatches, type ReservationGuestName } from "./identity-capture.service.js";
import { checkInServiceContext, type CheckInActor } from "./service-context.js";

type SessionRow = Prisma.CheckInSessionGetPayload<Record<string, never>>;
type GuestRow = Prisma.CheckInGuestGetPayload<Record<string, never>>;
type SessionWithGuests = SessionRow & { guests: GuestRow[] };
type ReservationRow = Prisma.ReservationGetPayload<{ include: { reservationGuests: { include: { guest: true } } } }>;
type GuestProfileRow = Prisma.GuestGetPayload<Record<string, never>>;

export const CHECKIN_INVITATION_TEMPLATE = "checkin_invitation";
export const GUEST_SESSION_INVALID_MESSAGE = "Sesión del portal del huésped no válida o caducada.";
const SESSION_NOT_FOUND = "Sesión de check-in no encontrada.";
const GUEST_NOT_FOUND = "Viajero no encontrado.";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Estados en los que el huésped ya no puede modificar la sesión. */
export const CLOSED_SESSION_STATUSES: readonly CheckInSessionStatus[] = Object.freeze(["arrived", "checked_in", "handed_off", "expired", "cancelled"]);

// ── Funciones puras (tests sin BD) ───────────────────────────────────────────

/** Viajeros declarados en la reserva: adultos + niños (mínimo 1; los bebés no llevan parte). */
export function travellerCapacity(reservation: { adults: number; children: number }): number {
  return Math.max(1, (reservation.adults ?? 0) + (reservation.children ?? 0));
}

export type TravellerSeed = { guestId: string | null; isPrimary: boolean; relationshipType: string | null };

/**
 * Plan de viajeros de la sesión: enlaces reales (titular primero; si ninguno
 * está marcado, el primero actúa de titular) + huecos `pending` hasta
 * adults+children. Nunca recorta un enlace real aunque supere la capacidad.
 */
export function planTravellerSlots(input: { adults: number; children: number; linked: TravellerSeed[] }): TravellerSeed[] {
  const capacity = travellerCapacity(input);
  const ordered = [...input.linked].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  if (ordered.length > 0 && !ordered.some((link) => link.isPrimary)) ordered[0] = { ...ordered[0]!, isPrimary: true };
  const slots: TravellerSeed[] = ordered.map((link, index) => ({ ...link, isPrimary: index === 0 }));
  while (slots.length < capacity) slots.push({ guestId: null, isPrimary: slots.length === 0, relationshipType: null });
  return slots;
}

/** Edad a la llegada (años cumplidos) o null si no hay fecha de nacimiento. */
export function ageAtArrival(dateOfBirth: Date | string | null | undefined, arrivalDate: Date | string): number | null {
  const age = ageAtDate(dateOfBirth, arrivalDate);
  return age === undefined ? null : age;
}

/** RD 933/2021: menor de 14 años → sin firma, datos aportados por un adulto. */
export function isMinorAge(age: number | null | undefined): boolean {
  return age !== null && age !== undefined && age < GUEST_REGISTER_MINOR_AGE;
}

/** Filtra preferencias al vocabulario cerrado (únicas, en el orden recibido) y separa el texto libre. */
export function filterPreferences(input: unknown): { codes: GuestPreferenceCode[]; freeText: string | null } {
  const rawCodes: unknown[] = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { codes?: unknown }).codes)
      ? ((input as { codes: unknown[] }).codes)
      : [];
  const codes: GuestPreferenceCode[] = [];
  for (const raw of rawCodes) {
    if (typeof raw !== "string") continue;
    const code = raw.trim().toLowerCase();
    if ((PREFERENCE_VOCABULARY as readonly string[]).includes(code) && !codes.includes(code as GuestPreferenceCode)) codes.push(code as GuestPreferenceCode);
  }
  const freeTextRaw = input && typeof input === "object" && !Array.isArray(input) ? (input as { freeText?: unknown }).freeText : undefined;
  const freeText = typeof freeTextRaw === "string" && freeTextRaw.trim() !== "" ? freeTextRaw.trim() : null;
  return { codes, freeText };
}

/** Campos del viajero que alimentan el parte (forma estructural: fila Prisma o doble de test). */
export type TravellerFields = {
  firstName?: string | null;
  surname1?: string | null;
  surname2?: string | null;
  sex?: string | null;
  nationality?: string | null;
  dateOfBirth?: Date | string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  documentSupportNumber?: string | null;
  residenceFullAddress?: string | null;
  residenceLocality?: string | null;
  residenceCountry?: string | null;
  phoneMobile?: string | null;
  email?: string | null;
  isMinor?: boolean;
  ageAtArrival?: number | null;
  /** Guest.id del adulto que aporta los datos (solo menores). */
  providedByAdultGuestId?: string | null;
  kinship?: string | null;
};

function isoDay(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function orUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : value;
}

/**
 * ISO 3166-1 alfa-2 → alfa-3 (corrector CHK · REV3-15): la MRZ trae alfa-3
 * (ICAO) y los perfiles antiguos alfa-2; el parte y el XML SES van en alfa-3.
 * Un código desconocido se devuelve tal cual (en mayúsculas), nunca se inventa.
 */
const ALPHA2_TO_ALPHA3: Readonly<Record<string, string>> = Object.freeze({
  AD: "AND", AE: "ARE", AR: "ARG", AT: "AUT", AU: "AUS", BE: "BEL", BG: "BGR", BR: "BRA", CA: "CAN", CH: "CHE", CL: "CHL", CN: "CHN", CO: "COL",
  CU: "CUB", CY: "CYP", CZ: "CZE", DE: "DEU", DK: "DNK", DO: "DOM", DZ: "DZA", EC: "ECU", EE: "EST", EG: "EGY", ES: "ESP", FI: "FIN", FR: "FRA",
  GB: "GBR", GR: "GRC", HR: "HRV", HU: "HUN", IE: "IRL", IL: "ISR", IN: "IND", IS: "ISL", IT: "ITA", JP: "JPN", KR: "KOR", LT: "LTU", LU: "LUX",
  LV: "LVA", MA: "MAR", MT: "MLT", MX: "MEX", NL: "NLD", NO: "NOR", NZ: "NZL", PA: "PAN", PE: "PER", PH: "PHL", PL: "POL", PT: "PRT", PY: "PRY",
  RO: "ROU", RS: "SRB", RU: "RUS", SA: "SAU", SE: "SWE", SI: "SVN", SK: "SVK", TR: "TUR", UA: "UKR", US: "USA", UY: "URY", VE: "VEN", ZA: "ZAF"
});

/** Código de país normalizado a alfa-3 cuando se conoce; vacío → undefined. Puro. */
export function toAlpha3(code: string | null | undefined): string | undefined {
  const value = orUndefined(code)?.trim().toUpperCase();
  if (!value) return undefined;
  if (value.length === 2) return ALPHA2_TO_ALPHA3[value] ?? value;
  return value;
}

/** Entrada del validador SES a partir de los campos del viajero (sin contrato ni firma). */
export function spainInputFromTraveller(fields: TravellerFields): SpainGuestRegisterRecordInput {
  const minor = fields.isMinor === true || isMinorAge(fields.ageAtArrival ?? null);
  return {
    recordType: "checkin",
    firstName: orUndefined(fields.firstName),
    surname1: orUndefined(fields.surname1),
    surname2: orUndefined(fields.surname2),
    sex: orUndefined(fields.sex),
    nationality: toAlpha3(fields.nationality),
    dateOfBirth: isoDay(fields.dateOfBirth),
    documentType: orUndefined(fields.documentType),
    documentNumber: orUndefined(fields.documentNumber),
    documentSupportNumber: orUndefined(fields.documentSupportNumber),
    residenceFullAddress: orUndefined(fields.residenceFullAddress),
    residenceLocality: orUndefined(fields.residenceLocality),
    residenceCountry: toAlpha3(fields.residenceCountry),
    phoneMobile: orUndefined(fields.phoneMobile),
    email: orUndefined(fields.email),
    travellerCount: 1,
    isMinor: minor,
    age: fields.ageAtArrival ?? undefined,
    providedByAdultGuestId: minor ? orUndefined(fields.providedByAdultGuestId) : undefined,
    kinshipRelationIfMinor: minor ? orUndefined(fields.kinship) : undefined,
    signatureRequired: !minor,
    idImageDiscarded: true
  };
}

/** paymentType del parte a partir del estado de pago de la sesión (Anexo I A.4): tarjeta si ya hay cobro/garantía en línea; si no, se deja vacío. Puro. */
export function paymentTypeForSession(paymentStatus: string): "card" | undefined {
  return paymentStatus === "paid" || paymentStatus === "authorized" || paymentStatus === "link_sent" ? "card" : undefined;
}

/**
 * Campos obligatorios del parte que faltan a un viajero (validador SES sobre
 * los datos, SIN la firma —la aporta el paso 5— y con contrato/check-in
 * simulados para que solo asomen los datos del viajero). Devuelve el nombre
 * del campo (o el código del validador cuando no apunta a uno).
 */
export function missingTravellerFields(fields: TravellerFields): string[] {
  const validation = validateSpainGuestRegisterRecord({
    ...spainInputFromTraveller(fields),
    contractReference: "pending",
    checkinAt: "2000-01-01T00:00:00.000Z"
  });
  const missing: string[] = [];
  for (const issue of validation.issues) {
    if (issue.severity !== "blocking" || issue.code === "signature_required") continue;
    const key = issue.field ? String(issue.field) : issue.code;
    if (!missing.includes(key)) missing.push(key);
  }
  return missing;
}

/** Estado del viajero según sus datos; signed/verified nunca retroceden. */
export function deriveGuestStatus(current: string, missing: readonly string[], hasDocument: boolean): CheckInGuestStatus {
  if (current === "signed" || current === "verified") return current;
  if (missing.length === 0) return "data_complete";
  return hasDocument ? "document_captured" : "pending";
}

export function consentFromJson(value: unknown): CheckInConsentDto {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const iso = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    gdprAt: iso(source.gdprAt),
    aiDisclosureAt: iso(source.aiDisclosureAt),
    marketing: source.marketing === true,
    whatsappOptInAt: iso(source.whatsappOptInAt)
  };
}

/** Consentimientos fechados: true fija la fecha (si no la había), false la retira. */
export function applyConsent(current: CheckInConsentDto, input: ConsentInput, now: string): CheckInConsentDto {
  return {
    gdprAt: input.gdpr === undefined ? current.gdprAt : input.gdpr ? (current.gdprAt ?? now) : null,
    aiDisclosureAt: input.aiDisclosure === undefined ? current.aiDisclosureAt : input.aiDisclosure ? (current.aiDisclosureAt ?? now) : null,
    marketing: input.marketing === undefined ? current.marketing : input.marketing,
    whatsappOptInAt: input.whatsappOptIn === undefined ? current.whatsappOptInAt : input.whatsappOptIn ? (current.whatsappOptInAt ?? now) : null
  };
}

/** consentJson con los consentimientos sustituidos y el resto de claves (p. ej. `otp`) intactas. Puro. */
export function mergeConsentJson(current: unknown, consent: CheckInConsentDto): Record<string, unknown> {
  const source = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  return { ...source, ...consent };
}

/** Destinatario enmascarado para respuestas y auditoría (nunca el correo/teléfono completo). */
export function maskRecipient(value: string): string {
  const at = value.indexOf("@");
  if (at > 0) return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 3 ? `***${digits.slice(-3)}` : "***";
}

// ── DTO ──────────────────────────────────────────────────────────────────────

function preferencesFromJson(value: unknown): GuestPreferenceCode[] {
  return filterPreferences(value).codes;
}

export function toGuestDto(row: GuestRow): CheckInGuestDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    guestId: row.guestId ?? null,
    guestRegisterRecordId: row.guestRegisterRecordId ?? null,
    isPrimary: row.isPrimary,
    ordinal: row.ordinal,
    status: (CHECKIN_GUEST_STATUSES as readonly string[]).includes(row.status) ? (row.status as CheckInGuestStatus) : "pending",
    ageAtArrival: row.ageAtArrival ?? null,
    isMinor: row.isMinor,
    providedByCheckInGuestId: row.providedByCheckInGuestId ?? null,
    kinship: row.kinship ?? null,
    guardianTitle: row.guardianTitle ?? null,
    identityVerificationMethod:
      row.identityVerificationMethod && (IDENTITY_VERIFICATION_METHODS as readonly string[]).includes(row.identityVerificationMethod)
        ? (row.identityVerificationMethod as IdentityVerificationMethod)
        : null,
    identityVerifiedAt: row.identityVerifiedAt ? row.identityVerifiedAt.toISOString() : null,
    firstName: row.firstName ?? null,
    surname1: row.surname1 ?? null,
    surname2: row.surname2 ?? null,
    nationality: row.nationality ?? null,
    documentType: row.documentType ?? null,
    documentNumberLast3: row.documentNumber ? row.documentNumber.slice(-3) : null,
    hasEmail: Boolean(row.email),
    hasPhoneMobile: Boolean(row.phoneMobile),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toSessionDto(session: SessionRow, guests: GuestRow[]): CheckInSessionDto {
  return {
    id: session.id,
    propertyId: session.propertyId,
    reservationId: session.reservationId,
    status: (CHECKIN_SESSION_STATUSES as readonly string[]).includes(session.status) ? (session.status as CheckInSessionStatus) : "invited",
    channel: (CHECKIN_CHANNELS as readonly string[]).includes(session.channel) ? (session.channel as CheckInChannel) : "manual",
    invitedAt: session.invitedAt ? session.invitedAt.toISOString() : null,
    reminderAt: session.reminderAt ? session.reminderAt.toISOString() : null,
    completedAt: session.completedAt ? session.completedAt.toISOString() : null,
    arrivedAt: session.arrivedAt ? session.arrivedAt.toISOString() : null,
    checkedInAt: session.checkedInAt ? session.checkedInAt.toISOString() : null,
    etaDeclared: session.etaDeclared ?? null,
    preferences: preferencesFromJson(session.preferencesJson),
    consent: consentFromJson(session.consentJson),
    paymentStatus: (CHECKIN_PAYMENT_STATUSES as readonly string[]).includes(session.paymentStatus) ? (session.paymentStatus as CheckInPaymentStatus) : "none",
    handoffKind: session.handoffKind ?? null,
    handoffReason: session.handoffReason ?? null,
    kioskDeviceId: session.kioskDeviceId ?? null,
    guests: [...guests].sort((a, b) => a.ordinal - b.ordinal).map(toGuestDto),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

export type CheckInStepStatus = "pending" | "done" | "optional" | "not_required";
export type CheckInStepDto = { key: "travellers" | "identity" | "details" | "preferences" | "signature" | "payment" | "complete"; status: CheckInStepStatus };

/** Pasos del portal a partir del estado de la sesión y de los viajeros. */
export function buildSteps(session: { status: string; etaDeclared: string | null; preferences: readonly string[]; paymentStatus: string }, guests: GuestRow[]): CheckInStepDto[] {
  const withData = guests.filter((guest) => guest.firstName || guest.documentNumber);
  const allWithDocument = guests.length > 0 && guests.every((guest) => Boolean(guest.documentNumber));
  const allComplete = guests.length > 0 && guests.every((guest) => ["data_complete", "signed", "verified"].includes(guest.status));
  const signers = guests.filter((guest) => !guest.isMinor);
  const allSigned = signers.every((guest) => guest.status === "signed" || guest.status === "verified");
  const completed = ["ready_for_arrival", "arrived", "checked_in", "handed_off"].includes(session.status);
  return [
    { key: "travellers", status: withData.length === guests.length && guests.length > 0 ? "done" : "pending" },
    { key: "identity", status: allWithDocument ? "done" : "pending" },
    { key: "details", status: allComplete ? "done" : "pending" },
    { key: "preferences", status: session.etaDeclared || session.preferences.length > 0 ? "done" : "optional" },
    { key: "signature", status: signers.length === 0 ? "not_required" : allSigned ? "done" : "pending" },
    { key: "payment", status: session.paymentStatus === "paid" || session.paymentStatus === "authorized" || session.paymentStatus === "at_reception" ? "done" : session.paymentStatus === "none" ? "optional" : "pending" },
    { key: "complete", status: completed ? "done" : "pending" }
  ];
}

export type CheckInSessionView = CheckInSessionDto & { policy: PropertyCheckInPolicyDto; steps: CheckInStepDto[] };

export async function toSessionView(session: SessionRow, guests: GuestRow[]): Promise<CheckInSessionView> {
  const dto = toSessionDto(session, guests);
  const policy = await getPolicy(session.propertyId);
  return { ...dto, policy, steps: buildSteps(dto, guests) };
}

// ── Carga ────────────────────────────────────────────────────────────────────

async function loadReservation(reservationId: string): Promise<ReservationRow | null> {
  return prisma.reservation.findFirst({
    where: { id: reservationId, deletedAt: null },
    include: { reservationGuests: { include: { guest: true }, orderBy: [{ isPrimary: "desc" }, { id: "asc" }] } }
  });
}

/**
 * Perfiles de huésped por consulta DE PRIMER NIVEL: la extensión de cifrado
 * (packages/database/src/crypto-fields.ts, decryptResultForModel) solo descifra
 * el modelo consultado, NO las filas alcanzadas por un `include` de relación
 * (reservationGuests.guest llega con correo, móvil y documento cifrados).
 */
async function loadProfiles(guestIds: readonly string[]): Promise<Map<string, GuestProfileRow>> {
  if (guestIds.length === 0) return new Map();
  const rows = await prisma.guest.findMany({ where: { id: { in: [...guestIds] } } });
  return new Map(rows.map((row) => [row.id, row] as const));
}

/**
 * Viajeros por consulta DE PRIMER NIVEL (corrector CHK · REV3-07): la extensión
 * de cifrado no descifra las filas alcanzadas por `include`, así que un
 * `include: { guests }` devolvía documentNumber/email/phoneMobile como envelope
 * (`v1.…`) y `documentNumberLast3` eran los 3 últimos caracteres del cifrado.
 */
async function loadSessionGuests(sessionId: string): Promise<GuestRow[]> {
  return prisma.checkInGuest.findMany({ where: { sessionId }, orderBy: { ordinal: "asc" } });
}

async function loadSessionByReservation(reservationId: string): Promise<SessionWithGuests | null> {
  const session = await prisma.checkInSession.findUnique({ where: { reservationId } });
  return session ? { ...session, guests: await loadSessionGuests(session.id) } : null;
}

async function loadSessionById(sessionId: string): Promise<SessionWithGuests | null> {
  const session = await prisma.checkInSession.findUnique({ where: { id: sessionId } });
  return session ? { ...session, guests: await loadSessionGuests(session.id) } : null;
}

type ProfileFields = Partial<Pick<Prisma.CheckInGuestUncheckedCreateInput, "firstName" | "surname1" | "surname2" | "sex" | "nationality" | "dateOfBirth" | "documentType" | "documentNumber" | "documentSupportNumber" | "documentExpiryDate" | "email" | "phoneMobile" | "residenceFullAddress" | "residenceLocality" | "residenceCountry">>;

function fieldsFromProfile(guest: GuestProfileRow): ProfileFields {
  return {
    firstName: guest.firstName,
    surname1: guest.surname1 ?? null,
    surname2: guest.surname2 ?? null,
    sex: guest.sex ?? null,
    nationality: guest.nationality ?? null,
    dateOfBirth: guest.dateOfBirth ?? null,
    documentType: guest.documentType ?? null,
    documentNumber: guest.documentNumber ?? null,
    documentSupportNumber: guest.documentSupportNumber ?? null,
    documentExpiryDate: guest.documentExpiryDate ?? null,
    email: guest.email ?? null,
    phoneMobile: guest.mobilePhone ?? guest.phone ?? null,
    residenceFullAddress: guest.residenceAddress ?? null,
    residenceLocality: guest.residenceLocality ?? null,
    residenceCountry: guest.residenceCountry ?? null
  };
}

function travellerFieldsOf(row: GuestRow, providedByAdultGuestId: string | null): TravellerFields {
  return {
    firstName: row.firstName,
    surname1: row.surname1,
    surname2: row.surname2,
    sex: row.sex,
    nationality: row.nationality,
    dateOfBirth: row.dateOfBirth,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    documentSupportNumber: row.documentSupportNumber,
    residenceFullAddress: row.residenceFullAddress,
    residenceLocality: row.residenceLocality,
    residenceCountry: row.residenceCountry,
    phoneMobile: row.phoneMobile,
    email: row.email,
    isMinor: row.isMinor,
    ageAtArrival: row.ageAtArrival,
    providedByAdultGuestId,
    kinship: row.kinship
  };
}

/** Guest.id del adulto que aporta los datos de un menor (o un marcador si el adulto aún no tiene perfil). */
function providedByAdultGuestIdOf(row: GuestRow, guests: GuestRow[]): string | null {
  if (!row.isMinor) return null;
  const adult = row.providedByCheckInGuestId ? guests.find((guest) => guest.id === row.providedByCheckInGuestId) : undefined;
  if (!adult) return null;
  return adult.guestId ?? `checkin_guest:${adult.id}`;
}

export type MissingTraveller = { checkInGuestId: string; ordinal: number; isPrimary: boolean; fields: string[] };

export function missingForSession(guests: GuestRow[]): MissingTraveller[] {
  const out: MissingTraveller[] = [];
  for (const guest of guests) {
    const fields = missingTravellerFields(travellerFieldsOf(guest, providedByAdultGuestIdOf(guest, guests)));
    if (fields.length > 0) out.push({ checkInGuestId: guest.id, ordinal: guest.ordinal, isPrimary: guest.isPrimary, fields });
  }
  return out;
}

function audit(context: UserContext, input: { action: string; entityType: string; entityId: string; beforeJson?: unknown; afterJson?: unknown; correlationId: string; actorType?: "user" | "system" }): void {
  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId: context.propertyId,
    actorUserId: context.userId,
    actorType: input.actorType ?? "system",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson: input.beforeJson,
    afterJson: input.afterJson,
    deviceId: context.deviceId,
    correlationId: input.correlationId
  });
}

// ── ensureSession ────────────────────────────────────────────────────────────

export async function ensureSession(input: {
  reservationId: string;
  channel: CheckInChannel;
  actor: CheckInActor;
  correlationId?: string;
}): Promise<{ session: SessionWithGuests; reservation: ReservationRow; created: boolean }> {
  const reservation = await loadReservation(input.reservationId);
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const existing = await loadSessionByReservation(reservation.id);
  if (existing) return { session: existing, reservation, created: false };

  const context = await checkInServiceContext(reservation.propertyId, input.actor);
  const correlationId = input.correlationId ?? createId("corr");
  const linked = reservation.reservationGuests.filter((link) => Boolean(link.guest));
  const profiles = await loadProfiles(linked.map((link) => link.guestId));
  const slots = planTravellerSlots({
    adults: reservation.adults,
    children: reservation.children,
    linked: linked.map((link) => ({ guestId: link.guestId, isPrimary: link.isPrimary, relationshipType: link.relationshipType ?? null }))
  });
  const primarySlot = slots.find((slot) => slot.isPrimary);
  const primaryProfile = primarySlot?.guestId ? profiles.get(primarySlot.guestId) : undefined;
  const preferences = primaryProfile ? filterPreferences(primaryProfile.preferencesJson).codes : [];

  const session = await prisma.checkInSession.create({
    data: {
      organizationId: context.organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      status: "invited",
      channel: input.channel,
      invitedAt: new Date(),
      preferencesJson: preferences,
      consentJson: {}
    }
  });

  const rows: GuestRow[] = [];
  let primaryId: string | null = null;
  let primaryIsAdult = false;
  for (const [index, slot] of slots.entries()) {
    const profile = slot.guestId ? profiles.get(slot.guestId) : undefined;
    const fields: ProfileFields = profile ? fieldsFromProfile(profile) : {};
    const age: number | null = profile ? ageAtArrival(profile.dateOfBirth, reservation.arrivalDate) : null;
    const minor: boolean = isMinorAge(age);
    const providedBy: string | null = minor && !slot.isPrimary && primaryIsAdult ? primaryId : null;
    const providedByAdultGuestId = providedBy ? (profiles.get(primarySlot?.guestId ?? "")?.id ?? `checkin_guest:${providedBy}`) : null;
    const missing = missingTravellerFields({ ...(fields as TravellerFields), isMinor: minor, ageAtArrival: age, providedByAdultGuestId, kinship: slot.relationshipType });
    const row: GuestRow = await prisma.checkInGuest.create({
      data: {
        sessionId: session.id,
        propertyId: reservation.propertyId,
        guestId: slot.guestId,
        isPrimary: slot.isPrimary,
        ordinal: index,
        status: deriveGuestStatus("pending", missing, Boolean((fields as TravellerFields).documentNumber)),
        ageAtArrival: age,
        isMinor: minor,
        providedByCheckInGuestId: providedBy,
        kinship: slot.relationshipType,
        ...fields
      }
    });
    rows.push(row);
    if (slot.isPrimary) {
      primaryId = row.id;
      primaryIsAdult = !minor;
    }
  }

  audit(context, {
    action: "CheckInSessionCreated",
    entityType: "checkin_session",
    entityId: session.id,
    afterJson: { reservationId: reservation.id, channel: input.channel, travellers: rows.length, linked: linked.length },
    correlationId
  });
  return { session: { ...session, guests: rows }, reservation, created: true };
}

// ── inviteReservation ────────────────────────────────────────────────────────

export type InvitationResult = {
  session: CheckInSessionDto;
  /** Token en claro SOLO si no se entregó de verdad (simulado / sin plantilla), fuera de producción o con GUEST_PORTAL_RETURN_TOKEN=true; nunca se guarda en claro. */
  token?: string;
  checkInUrl?: string;
  notification: {
    dispatched: boolean;
    simulated: boolean;
    channel: CheckInChannel | null;
    recipient: string | null;
    reason: string | null;
    deliveryId: string | null;
  };
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function formatArrivalDate(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

/** Canal disponible con consentimiento: el pedido si se puede; si no email → whatsapp → sms. */
export function pickInvitationChannel(input: {
  requested: CheckInChannel;
  email: string | null;
  mobile: string | null;
  whatsappOptIn: boolean;
}): { channel: CheckInChannel; recipient: string } | null {
  const options: Array<{ channel: CheckInChannel; recipient: string | null; allowed: boolean }> = [
    { channel: "email", recipient: input.email, allowed: Boolean(input.email) },
    { channel: "whatsapp", recipient: input.mobile, allowed: Boolean(input.mobile) && input.whatsappOptIn },
    { channel: "sms", recipient: input.mobile, allowed: Boolean(input.mobile) }
  ];
  const requested = options.find((option) => option.channel === input.requested && option.allowed && option.recipient);
  const chosen = requested ?? options.find((option) => option.allowed && option.recipient);
  return chosen && chosen.recipient ? { channel: chosen.channel, recipient: chosen.recipient } : null;
}

export async function inviteReservation(input: {
  reservationId: string;
  channel: CheckInChannel;
  context: UserContext;
  correlationId: string;
  /** Base pública del portal (por defecto GUEST_WEB_BASE_URL o http://localhost:5174). */
  guestWebBaseUrl?: string;
  /** Código de plantilla (por defecto checkin_invitation; los tests de integración fuerzan uno inexistente). */
  templateCode?: string;
}): Promise<InvitationResult> {
  requirePermissions(input.context, ["pms.reservation.modify"]);
  const { session, reservation } = await ensureSession({
    reservationId: input.reservationId,
    channel: input.channel,
    actor: { kind: "system", job: "invitation" },
    correlationId: input.correlationId
  });
  if (reservation.propertyId !== input.context.propertyId && input.context.isPlatformAdmin !== true) {
    throw new NotFoundError("Reserva no encontrada.");
  }
  const property = await prisma.property.findUnique({ where: { id: reservation.propertyId }, select: { organizationId: true, name: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  // Token opaco del portal (misma forma que guest-portal-auth.service.ts). Un
  // reenvío revoca el anterior: solo el último enlace sigue abriendo la sesión.
  if (session.guestPortalSessionId) {
    await prisma.guestPortalSession.updateMany({ where: { id: session.guestPortalSessionId, status: "active" }, data: { status: "revoked" } });
  }
  const primaryLink = reservation.reservationGuests.find((link) => link.isPrimary) ?? reservation.reservationGuests[0];
  const primaryProfile = primaryLink ? ((await loadProfiles([primaryLink.guestId])).get(primaryLink.guestId) ?? null) : null;
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Math.max(reservation.departureDate.getTime() + DAY_MS, Date.now() + DAY_MS));
  const portalSession = await prisma.guestPortalSession.create({
    data: {
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: primaryProfile?.id ?? null,
      tokenHash: hashToken(token),
      status: "active",
      expiresAt
    }
  });
  const now = new Date();
  const updated = await prisma.checkInSession.update({
    where: { id: session.id },
    data: {
      guestPortalSessionId: portalSession.id,
      invitedAt: now,
      channel: input.channel,
      ...(session.status === "expired" || session.status === "cancelled" ? { status: "invited" } : {})
    }
  });

  const baseUrl = (input.guestWebBaseUrl ?? process.env.GUEST_WEB_BASE_URL ?? "http://localhost:5174").replace(/\/+$/, "");
  const checkInUrl = `${baseUrl}/checkin?token=${encodeURIComponent(token)}&property=${encodeURIComponent(reservation.propertyId)}`;
  const consent = consentFromJson(session.consentJson);
  const flags = primaryProfile?.gdprConsentFlags && typeof primaryProfile.gdprConsentFlags === "object" ? (primaryProfile.gdprConsentFlags as Record<string, unknown>) : {};
  const target = pickInvitationChannel({
    requested: input.channel,
    email: primaryProfile?.email ?? reservation.bookerEmail ?? null,
    mobile: primaryProfile?.mobilePhone ?? primaryProfile?.phone ?? null,
    whatsappOptIn: Boolean(consent.whatsappOptInAt) || flags.whatsappOptIn === true
  });

  const notification: InvitationResult["notification"] = { dispatched: false, simulated: false, channel: null, recipient: null, reason: null, deliveryId: null };
  if (!target) {
    notification.reason = "no_recipient";
  } else {
    notification.channel = target.channel;
    notification.recipient = maskRecipient(target.recipient);
    try {
      const delivery = await dispatch({
        organizationId: property.organizationId,
        propertyId: reservation.propertyId,
        templateCode: input.templateCode ?? CHECKIN_INVITATION_TEMPLATE,
        channel: target.channel,
        recipient: target.recipient,
        language: primaryProfile?.languagePreference ?? "es",
        notificationId: `checkin_invitation:${portalSession.id}`,
        variables: {
          guestFirstName: primaryProfile?.firstName ?? reservation.bookerName ?? "",
          propertyName: property.name,
          arrivalDate: formatArrivalDate(reservation.arrivalDate),
          checkInUrl
        },
        // Corrector SEC-1: el token del enlace mágico NUNCA se persiste en notification_deliveries
        // (solo viaja al proveedor); en la fila queda `token=[redacted]` y la variable enmascarada.
        redact: { variables: ["checkInUrl"], values: [token] }
      });
      notification.dispatched = delivery.status === "sent";
      notification.simulated = typeof delivery.errorMessage === "string" && delivery.errorMessage.startsWith("SIMULADO");
      notification.deliveryId = delivery.id;
      if (!notification.dispatched) notification.reason = delivery.errorMessage ?? delivery.status;
    } catch (error) {
      if (error instanceof Error && error.message === "template_not_found") {
        notification.reason = "template_not_found";
      } else {
        throw error;
      }
    }
  }

  audit(input.context, {
    action: "CheckInInvited",
    entityType: "checkin_session",
    entityId: session.id,
    actorType: "user",
    afterJson: { reservationId: reservation.id, channel: notification.channel, dispatched: notification.dispatched, simulated: notification.simulated, reason: notification.reason },
    correlationId: input.correlationId
  });

  // Misma regla que requestSignIn (guest-portal-auth.service.ts): el token en
  // claro solo viaja al personal cuando NO se entregó de verdad (sin proveedor
  // = SIMULADO, o sin destinatario/plantilla), fuera de producción, o con
  // GUEST_PORTAL_RETURN_TOKEN=true. Nunca se persiste en claro.
  const delivered = notification.dispatched && !notification.simulated;
  const returnToken = process.env.GUEST_PORTAL_RETURN_TOKEN === "true" || !delivered || process.env.NODE_ENV !== "production";
  return {
    session: toSessionDto(updated, session.guests),
    ...(returnToken ? { token, checkInUrl } : {}),
    notification
  };
}

// ── Sesión por token ─────────────────────────────────────────────────────────

async function requireSessionForToken(token: string | null | undefined): Promise<{ verified: VerifiedGuestSession; session: SessionWithGuests }> {
  const verified = await verifyGuestToken(token);
  if (!verified || !verified.reservationId) throw new GuestPortalAuthError(GUEST_SESSION_INVALID_MESSAGE);
  let session = await loadSessionByReservation(verified.reservationId);
  if (!session) {
    // Un huésped que entró por el sign-in del portal (sin invitación) también hace el check-in.
    session = (await ensureSession({ reservationId: verified.reservationId, channel: "manual", actor: { kind: "system", job: "portal-sign-in" } })).session;
  }
  if (session.propertyId !== verified.propertyId) throw new GuestPortalAuthError(GUEST_SESSION_INVALID_MESSAGE);
  return { verified, session };
}

export async function getSessionForToken(token: string | null | undefined): Promise<CheckInSessionView> {
  const { session } = await requireSessionForToken(token);
  return toSessionView(session, session.guests);
}

/** Vista de personal (GET /properties/:propertyId/check-in/sessions/:id). */
export async function getSessionById(sessionId: string): Promise<CheckInSessionView> {
  const session = await loadSessionById(sessionId);
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  return toSessionView(session, session.guests);
}

function assertOpen(session: SessionRow): void {
  if ((CLOSED_SESSION_STATUSES as readonly string[]).includes(session.status)) {
    throw new ConflictError("La sesión de check-in ya no admite cambios desde el portal.");
  }
}

async function progressStatus(session: SessionRow): Promise<void> {
  if (session.status === "invited") await prisma.checkInSession.update({ where: { id: session.id }, data: { status: "in_progress" } });
}

// ── updateSession ────────────────────────────────────────────────────────────

export async function updateSession(input: {
  token: string | null | undefined;
  eta?: string | null;
  preferences?: unknown;
  consent?: ConsentInput;
  correlationId?: string;
}): Promise<CheckInSessionView> {
  const { session } = await requireSessionForToken(input.token);
  assertOpen(session);
  const context = await checkInServiceContext(session.propertyId, { kind: "guest", sessionId: session.id });
  const correlationId = input.correlationId ?? createId("corr");
  const data: Prisma.CheckInSessionUncheckedUpdateInput = {};
  const changed: string[] = [];

  if (input.eta !== undefined) {
    const eta = input.eta === null || input.eta.trim() === "" ? null : normalizeArrivalEta(input.eta);
    if (input.eta !== null && input.eta.trim() !== "" && eta === null) throw new BadRequestError("Hora de llegada no válida: usa HH:MM.");
    await prisma.reservation.update({ where: { id: session.reservationId }, data: { eta } });
    data.etaDeclared = eta;
    changed.push("eta");
  }

  if (input.preferences !== undefined) {
    const { codes, freeText } = filterPreferences(input.preferences);
    data.preferencesJson = codes;
    changed.push("preferences");
    const primary = session.guests.find((guest) => guest.isPrimary);
    if (primary?.guestId) {
      const profile = await prisma.guest.findUnique({ where: { id: primary.guestId }, select: { preferencesJson: true } });
      const current = Array.isArray(profile?.preferencesJson) ? (profile.preferencesJson as unknown[]).filter((item): item is string => typeof item === "string") : [];
      const merged = [...new Set([...current, ...codes])];
      await prisma.guest.update({ where: { id: primary.guestId }, data: { preferencesJson: merged } });
    }
    if (freeText) {
      const reservation = await prisma.reservation.findUnique({ where: { id: session.reservationId }, select: { specialRequests: true } });
      if (!reservation?.specialRequests || reservation.specialRequests.trim() === "") {
        await prisma.reservation.update({ where: { id: session.reservationId }, data: { specialRequests: freeText } });
        changed.push("specialRequests");
      }
    }
  }

  if (input.consent !== undefined) {
    // Corrector CHK (REV3-08): consentJson también guarda el OTP pendiente (otp.service.ts, clave `otp`);
    // se conservan las claves ajenas al consentimiento en vez de reescribir el Json entero.
    data.consentJson = mergeConsentJson(session.consentJson, applyConsent(consentFromJson(session.consentJson), input.consent, nowIso())) as Prisma.InputJsonValue;
    changed.push("consent");
  }

  if (session.status === "invited") data.status = "in_progress";
  const updated = await prisma.checkInSession.update({ where: { id: session.id }, data });
  audit(context, {
    action: "CheckInSessionUpdated",
    entityType: "checkin_session",
    entityId: session.id,
    afterJson: { changed, etaDeclared: updated.etaDeclared, preferences: preferencesFromJson(updated.preferencesJson), status: updated.status },
    correlationId
  });
  return toSessionView(updated, session.guests);
}

// ── Viajeros ─────────────────────────────────────────────────────────────────

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const GUEST_TEXT_FIELDS = [
  "firstName",
  "surname1",
  "surname2",
  "sex",
  "nationality",
  "documentType",
  "documentNumber",
  "documentSupportNumber",
  "email",
  "phoneMobile",
  "residenceFullAddress",
  "residenceLocality",
  "residenceCountry",
  "kinship",
  "guardianTitle"
] as const;

export async function upsertGuest(input: {
  token: string | null | undefined;
  checkInGuestId?: string;
  input: GuestInput;
  correlationId?: string;
}): Promise<{ guest: CheckInGuestDto; missing: string[]; session: CheckInSessionView }> {
  const { session } = await requireSessionForToken(input.token);
  assertOpen(session);
  const context = await checkInServiceContext(session.propertyId, { kind: "guest", sessionId: session.id });
  return applyGuestInput({ session, context, actorType: "system", checkInGuestId: input.checkInGuestId, input: input.input, correlationId: input.correlationId ?? createId("corr") });
}

/**
 * Edición de un viajero por recepción (corrector CHK · REV3-04; PATCH
 * /reservations/:id/check-in/guests/:gid, guest_register.edit): misma lógica que
 * el portal pero con el usuario como actor y sin exigir que la sesión esté
 * abierta al huésped (una sesión `handed_off` se corrige desde el mostrador; una
 * `checked_in` / `cancelled` / `expired` no admite cambios). Si el viajero ya
 * tiene parte, el parte se actualiza con los datos corregidos.
 */
export async function updateGuestByStaff(input: {
  context: UserContext;
  reservationId: string;
  checkInGuestId: string;
  input: GuestInput;
  correlationId?: string;
}): Promise<{ guest: CheckInGuestDto; missing: string[]; session: CheckInSessionView }> {
  requirePermissions(input.context, ["guest_register.edit"]);
  const session = await loadSessionByReservation(input.reservationId);
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  if (session.status === "checked_in" || session.status === "cancelled" || session.status === "expired") {
    throw new ConflictError(`La sesión de check-in no admite cambios en estado ${session.status}.`, { code: "CHECKIN_SESSION_CLOSED", status: session.status });
  }
  const correlationId = input.correlationId ?? createId("corr");
  const result = await applyGuestInput({ session, context: input.context, actorType: "user", checkInGuestId: input.checkInGuestId, input: input.input, correlationId });
  const updated = result.session.guests.find((guest) => guest.id === input.checkInGuestId);
  if (updated?.guestRegisterRecordId && result.missing.length === 0) {
    const refreshed = await loadSessionById(session.id);
    await ensureGuestRegisterRecordsForSession({ session: refreshed!, context: input.context, correlationId });
    const again = await loadSessionById(session.id);
    return { ...result, session: await toSessionView(again!, again!.guests) };
  }
  return result;
}

/**
 * Recepción resuelve una derivación (corrector CHK · REV3-04; POST
 * /reservations/:id/check-in/resolve-handoff): la sesión `handed_off` (o
 * `arrived` con handoffKind) vuelve a `ready_for_arrival` si todos los viajeros
 * tienen los datos completos (creando los partes que falten) o a `in_progress`
 * si aún faltan datos; handoffKind/handoffReason se vacían y queda auditado.
 */
export async function resolveHandoff(input: { context: UserContext; reservationId: string; note?: string | null; correlationId?: string }): Promise<CheckInSessionView & { resolvedTo: CheckInSessionStatus; missing: MissingTraveller[] }> {
  requirePermissions(input.context, ["pms.checkin.execute"]);
  const session = await loadSessionByReservation(input.reservationId);
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  if (session.status !== "handed_off" && !(session.status === "arrived" && session.handoffKind)) {
    throw new ConflictError(`La sesión no está derivada a recepción (estado ${session.status}).`, { code: "CHECKIN_NOT_HANDED_OFF", status: session.status, handoffKind: session.handoffKind ?? null });
  }
  const correlationId = input.correlationId ?? createId("corr");
  const missing = missingForSession(session.guests);
  let resolvedTo: CheckInSessionStatus = "in_progress";
  if (missing.length === 0) {
    await ensureGuestRegisterRecordsForSession({ session, context: input.context, correlationId, onlyMissing: true });
    resolvedTo = "ready_for_arrival";
  }
  const updated = await prisma.checkInSession.update({
    where: { id: session.id },
    data: { status: resolvedTo, handoffKind: null, handoffReason: null, ...(resolvedTo === "ready_for_arrival" ? { completedAt: session.completedAt ?? new Date() } : {}) }
  });
  audit(input.context, {
    action: "CheckInHandoffResolved",
    entityType: "checkin_session",
    entityId: session.id,
    actorType: "user",
    beforeJson: { status: session.status, handoffKind: session.handoffKind ?? null, handoffReason: session.handoffReason ?? null },
    afterJson: { status: resolvedTo, note: input.note?.trim() || null, missing: missing.map((item) => ({ checkInGuestId: item.checkInGuestId, fields: item.fields })) },
    correlationId
  });
  const guests = await loadSessionGuests(session.id);
  return { ...(await toSessionView(updated, guests)), resolvedTo, missing };
}

/** Lógica compartida de alta/edición de un viajero (portal con contexto de servicio; recepción con su usuario). */
async function applyGuestInput(input: {
  session: SessionWithGuests;
  context: UserContext;
  actorType: "user" | "system";
  checkInGuestId?: string;
  input: GuestInput;
  correlationId: string;
}): Promise<{ guest: CheckInGuestDto; missing: string[]; session: CheckInSessionView }> {
  const { session, context, correlationId } = input;
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: session.reservationId }, select: { adults: true, children: true, arrivalDate: true } });

  let target: GuestRow | null = null;
  if (input.checkInGuestId) {
    target = session.guests.find((guest) => guest.id === input.checkInGuestId) ?? null;
    if (!target) throw new NotFoundError(GUEST_NOT_FOUND);
  } else {
    target = session.guests.find((guest) => !guest.guestId && guest.status === "pending" && !guest.firstName && !guest.documentNumber) ?? null;
    if (!target && session.guests.length >= travellerCapacity(reservation)) {
      throw new ConflictError("La reserva ya tiene todos los viajeros declarados.", {
        code: "CHECKIN_GUEST_LIMIT",
        limit: travellerCapacity(reservation),
        current: session.guests.length
      });
    }
  }

  const data: Prisma.CheckInGuestUncheckedUpdateInput = {};
  const touched: string[] = [];
  for (const key of GUEST_TEXT_FIELDS) {
    const value = input.input[key];
    if (value !== undefined) {
      (data as Record<string, unknown>)[key] = value;
      touched.push(key);
    }
  }
  if (input.input.dateOfBirth !== undefined) {
    data.dateOfBirth = toDate(input.input.dateOfBirth);
    touched.push("dateOfBirth");
  }
  if (input.input.documentExpiryDate !== undefined) {
    data.documentExpiryDate = toDate(input.input.documentExpiryDate);
    touched.push("documentExpiryDate");
  }

  const dateOfBirth = input.input.dateOfBirth !== undefined ? toDate(input.input.dateOfBirth) : (target?.dateOfBirth ?? null);
  const age = ageAtArrival(dateOfBirth, reservation.arrivalDate);
  const minor = isMinorAge(age);
  data.ageAtArrival = age;
  data.isMinor = minor;

  let providedBy: string | null = null;
  if (minor) {
    const requested = input.input.providedByCheckInGuestId ?? target?.providedByCheckInGuestId ?? null;
    const adults = session.guests.filter((guest) => !guest.isMinor && guest.id !== target?.id && (guest.firstName || guest.guestId));
    const adult = requested ? adults.find((guest) => guest.id === requested) : (adults.find((guest) => guest.isPrimary) ?? adults[0]);
    if (!adult) throw new BadRequestError("Un menor de 14 años debe ir acompañado de un adulto de la misma reserva (providedByCheckInGuestId).");
    providedBy = adult.id;
  }
  data.providedByCheckInGuestId = providedBy;

  const merged: TravellerFields = {
    ...(target ? travellerFieldsOf(target, null) : {}),
    ...Object.fromEntries(touched.map((key) => [key, (data as Record<string, unknown>)[key]])),
    isMinor: minor,
    ageAtArrival: age,
    providedByAdultGuestId: providedBy ? `checkin_guest:${providedBy}` : null,
    kinship: input.input.kinship !== undefined ? input.input.kinship : (target?.kinship ?? null)
  };
  const missing = missingTravellerFields(merged);
  data.status = deriveGuestStatus(target?.status ?? "pending", missing, Boolean(merged.documentNumber));

  const row = target
    ? await prisma.checkInGuest.update({ where: { id: target.id }, data })
    : await prisma.checkInGuest.create({
        data: {
          ...(data as Prisma.CheckInGuestUncheckedCreateInput),
          sessionId: session.id,
          propertyId: session.propertyId,
          isPrimary: false,
          ordinal: session.guests.reduce((max, guest) => Math.max(max, guest.ordinal), -1) + 1
        }
      });
  await progressStatus(session);
  audit(context, {
    action: target ? "CheckInGuestUpdated" : "CheckInGuestAdded",
    entityType: "checkin_guest",
    entityId: row.id,
    actorType: input.actorType,
    afterJson: { sessionId: session.id, fields: touched, status: row.status, isMinor: row.isMinor, missing },
    correlationId
  });
  const refreshed = await loadSessionById(session.id);
  return { guest: toGuestDto(row), missing, session: await toSessionView(refreshed!, refreshed!.guests) };
}

export async function removeGuest(input: { token: string | null | undefined; checkInGuestId: string; correlationId?: string }): Promise<{ removed: true; session: CheckInSessionView }> {
  const { session } = await requireSessionForToken(input.token);
  assertOpen(session);
  const context = await checkInServiceContext(session.propertyId, { kind: "guest", sessionId: session.id });
  const target = session.guests.find((guest) => guest.id === input.checkInGuestId);
  if (!target) throw new NotFoundError(GUEST_NOT_FOUND);
  if (target.isPrimary) throw new ConflictError("El titular de la reserva no se puede eliminar.");
  if (target.guestRegisterRecordId) throw new ConflictError("El viajero ya tiene parte de viajeros: pide el cambio en recepción.");
  if (session.guests.some((guest) => guest.providedByCheckInGuestId === target.id)) {
    throw new ConflictError("El viajero aporta los datos de un menor: cambia primero el adulto responsable.");
  }
  await prisma.checkInGuest.delete({ where: { id: target.id } });
  audit(context, {
    action: "CheckInGuestRemoved",
    entityType: "checkin_guest",
    entityId: target.id,
    beforeJson: { sessionId: session.id, ordinal: target.ordinal, status: target.status },
    correlationId: input.correlationId ?? createId("corr")
  });
  const refreshed = await loadSessionById(session.id);
  return { removed: true, session: await toSessionView(refreshed!, refreshed!.guests) };
}

// ── MRZ ──────────────────────────────────────────────────────────────────────

export type MrzApplyResult = {
  guest: CheckInGuestDto;
  missing: string[];
  capture: { id: string; source: "mrz_reader"; format: string | null; checks: MrzChecks; needsReview: string[]; fields: Partial<DocumentCaptureFields> };
  /** Avisos (p. ej. discrepancia de nombre con la reserva: los campos NO se aplican al viajero). */
  warnings: string[];
};

/** Nombres de la reserva (vínculos Guest) + viajeros ya declarados en la sesión: candidatos del cotejo de identidad (§4d). */
export async function reservationIdentityCandidates(reservationId: string, guests: readonly GuestRow[]): Promise<ReservationGuestName[]> {
  const links = await prisma.reservationGuest.findMany({ where: { reservationId }, select: { guest: { select: { firstName: true, surname1: true, surname2: true } } } });
  const candidates: ReservationGuestName[] = links.map((link) => link.guest);
  for (const guest of guests) {
    if (guest.firstName && guest.surname1) candidates.push({ firstName: guest.firstName, surname1: guest.surname1, surname2: guest.surname2 ?? null });
  }
  return candidates;
}

/** Campos NO PII de una lectura MRZ (los únicos que se persisten en fieldsJson). */
export function nonPiiCaptureFields(fields: MrzFields, format: string | null): Partial<DocumentCaptureFields> {
  const all: DocumentCaptureFields = {
    documentType: fields.documentType,
    mrzFormat: format === "TD1" || format === "TD3" ? format : undefined,
    issuingCountry: fields.issuingCountry,
    nationality: fields.nationality,
    sex: fields.sex,
    dateOfBirth: fields.dateOfBirth || undefined,
    documentExpiryDate: fields.expiryDate || undefined
  };
  const out: Partial<DocumentCaptureFields> = {};
  for (const key of DOCUMENT_CAPTURE_NON_PII_FIELDS) {
    const value = all[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export async function applyMrz(input: { token: string | null | undefined; checkInGuestId: string; lines: string[] | string; correlationId?: string }): Promise<MrzApplyResult> {
  const { session } = await requireSessionForToken(input.token);
  assertOpen(session);
  const target = session.guests.find((guest) => guest.id === input.checkInGuestId);
  if (!target) throw new NotFoundError(GUEST_NOT_FOUND);
  const context = await checkInServiceContext(session.propertyId, { kind: "guest", sessionId: session.id });
  const correlationId = input.correlationId ?? createId("corr");
  const startedAt = Date.now();
  const parsed = parseMrz(input.lines);
  if (!parsed.valid || !parsed.fields) {
    const error = new BadRequestError("La MRZ no supera los dígitos de control: repite la lectura o introduce los datos a mano.");
    error.details = { code: "MRZ_CHECKSUM_FAILED", format: parsed.format, checks: parsed.checks, errors: parsed.errors };
    throw error;
  }
  const fields = parsed.fields;
  const checks: MrzChecks = { document: parsed.checks.document, birth: parsed.checks.birth, expiry: parsed.checks.expiry, composite: parsed.checks.composite };
  const now = new Date();
  const nonPii = nonPiiCaptureFields(fields, parsed.format);

  // Corrector CHK (REV3-05) · §4d: misma comprobación de discrepancia que captureDocument
  // (identity-capture.service.ts). Si el nombre del documento no coincide con ningún
  // viajero de la reserva, la captura queda registrada (métrica y revisión) pero los
  // datos NO se aplican al viajero: recepción coteja (needsReview identity_mismatch).
  const candidates = await reservationIdentityCandidates(session.reservationId, session.guests);
  if (fields.firstName && fields.surname1 && !identityNameMatches(fields, candidates)) {
    const capture = await prisma.documentCapture.create({
      data: {
        checkInGuestId: target.id,
        propertyId: session.propertyId,
        source: "mrz_reader",
        mrzFormat: parsed.format,
        checksJson: checks as unknown as Prisma.InputJsonValue,
        fieldsJson: nonPii as Prisma.InputJsonValue,
        confidenceJson: Object.fromEntries(Object.keys(nonPii).map((key) => [key, 1])) as Prisma.InputJsonValue,
        needsReviewJson: ["identity_mismatch"],
        imageStored: false,
        imageDiscardedAt: now,
        processingMs: Date.now() - startedAt,
        purgeAt: new Date(now.getTime() + readCheckInConfig().capturePurgeDays * DAY_MS)
      }
    });
    audit(context, {
      action: "CheckInMrzMismatch",
      entityType: "checkin_guest",
      entityId: target.id,
      // Nunca el nombre del documento: solo el formato, los checks y el motivo.
      afterJson: { sessionId: session.id, captureId: capture.id, format: parsed.format, checks, needsReview: ["identity_mismatch"] },
      correlationId
    });
    return {
      guest: toGuestDto(target),
      missing: missingTravellerFields(travellerFieldsOf(target, providedByAdultGuestIdOf(target, session.guests))),
      capture: { id: capture.id, source: "mrz_reader", format: parsed.format, checks, needsReview: ["identity_mismatch"], fields: nonPii },
      warnings: [IDENTITY_MISMATCH_WARNING]
    };
  }

  const data: Prisma.CheckInGuestUncheckedUpdateInput = {
    documentType: fields.documentType,
    documentNumber: fields.documentNumber,
    ...(fields.documentSupportNumber ? { documentSupportNumber: fields.documentSupportNumber } : {}),
    firstName: fields.firstName,
    surname1: fields.surname1,
    surname2: fields.surname2 ?? null,
    sex: fields.sex,
    nationality: fields.nationality,
    ...(fields.dateOfBirth ? { dateOfBirth: new Date(`${fields.dateOfBirth}T00:00:00.000Z`) } : {}),
    ...(fields.expiryDate ? { documentExpiryDate: new Date(`${fields.expiryDate}T00:00:00.000Z`) } : {}),
    identityVerificationMethod: "mrz_checksum"
  };
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: session.reservationId }, select: { arrivalDate: true } });
  const age = fields.dateOfBirth ? ageAtArrival(fields.dateOfBirth, reservation.arrivalDate) : target.ageAtArrival;
  data.ageAtArrival = age;
  data.isMinor = isMinorAge(age);
  const merged: TravellerFields = {
    ...travellerFieldsOf(target, providedByAdultGuestIdOf(target, session.guests)),
    documentType: fields.documentType,
    documentNumber: fields.documentNumber,
    documentSupportNumber: fields.documentSupportNumber ?? target.documentSupportNumber,
    firstName: fields.firstName,
    surname1: fields.surname1,
    surname2: fields.surname2 ?? null,
    sex: fields.sex,
    nationality: fields.nationality,
    dateOfBirth: fields.dateOfBirth || target.dateOfBirth,
    isMinor: isMinorAge(age),
    ageAtArrival: age
  };
  const missing = missingTravellerFields(merged);
  data.status = deriveGuestStatus(target.status, missing, true);
  const row = await prisma.checkInGuest.update({ where: { id: target.id }, data });
  const capture = await prisma.documentCapture.create({
    data: {
      checkInGuestId: row.id,
      propertyId: session.propertyId,
      source: "mrz_reader",
      mrzFormat: parsed.format,
      checksJson: checks as unknown as Prisma.InputJsonValue,
      fieldsJson: nonPii as Prisma.InputJsonValue,
      confidenceJson: Object.fromEntries(Object.keys(nonPii).map((key) => [key, 1])) as Prisma.InputJsonValue,
      needsReviewJson: [],
      imageStored: false,
      imageDiscardedAt: now,
      processingMs: Date.now() - startedAt,
      purgeAt: new Date(now.getTime() + readCheckInConfig().capturePurgeDays * DAY_MS)
    }
  });
  await progressStatus(session);
  audit(context, {
    action: "CheckInMrzApplied",
    entityType: "checkin_guest",
    entityId: row.id,
    afterJson: { sessionId: session.id, captureId: capture.id, format: parsed.format, checks, documentType: fields.documentType, status: row.status, missing },
    correlationId
  });
  return { guest: toGuestDto(row), missing, capture: { id: capture.id, source: "mrz_reader", format: parsed.format, checks, needsReview: [], fields: nonPii }, warnings: [] };
}

// ── completePreArrival ───────────────────────────────────────────────────────

async function ensureGuestProfile(row: GuestRow, organizationId: string, reservationId: string): Promise<string> {
  if (row.guestId) return row.guestId;
  const profile = await prisma.guest.create({
    data: {
      organizationId,
      firstName: row.firstName ?? "",
      surname1: row.surname1 ?? null,
      surname2: row.surname2 ?? null,
      sex: row.sex ?? null,
      nationality: row.nationality ?? null,
      dateOfBirth: row.dateOfBirth ?? null,
      documentType: row.documentType ?? null,
      documentNumber: row.documentNumber ?? null,
      documentSupportNumber: row.documentSupportNumber ?? null,
      documentExpiryDate: row.documentExpiryDate ?? null,
      email: row.email ?? null,
      mobilePhone: row.phoneMobile ?? null,
      residenceAddress: row.residenceFullAddress ?? null,
      residenceLocality: row.residenceLocality ?? null,
      residenceCountry: row.residenceCountry ?? null
    },
    select: { id: true }
  });
  await prisma.reservationGuest.create({ data: { reservationId, guestId: profile.id, isPrimary: false, relationshipType: row.kinship ?? null } });
  await prisma.checkInGuest.update({ where: { id: row.id }, data: { guestId: profile.id } });
  return profile.id;
}

/**
 * Partes de viajeros de la sesión (corrector CHK · REV3-04, extraído de
 * completePreArrival para que recepción también lo use): perfil Guest para los
 * acompañantes sin él, un GuestRegisterRecord por viajero (crear o patch, dedupe
 * por (reservationId, guestId)) y `guestRegisterRecordId` + estado en el viajero.
 * Exige los datos completos (409 CHECKIN_INCOMPLETE { missing } si faltan).
 * `context` es el de servicio (portal) o el del usuario de recepción.
 */
export async function ensureGuestRegisterRecordsForSession(input: {
  session: SessionWithGuests;
  context: UserContext;
  correlationId: string;
  /** Solo los viajeros sin parte (recepción); por defecto todos (cierre del pre-check-in). */
  onlyMissing?: boolean;
}): Promise<{ guests: GuestRow[]; recordIds: string[]; created: number; patched: number }> {
  const { session, context, correlationId } = input;
  const targets = input.onlyMissing ? session.guests.filter((row) => !row.guestRegisterRecordId) : session.guests;
  const missing = missingForSession(session.guests).filter((item) => targets.some((row) => row.id === item.checkInGuestId));
  if (missing.length > 0) {
    throw new ConflictError("Faltan datos de viajeros para crear el parte.", { code: "CHECKIN_INCOMPLETE", missing });
  }
  if (targets.length === 0) return { guests: session.guests, recordIds: session.guests.map((row) => row.guestRegisterRecordId).filter((id): id is string => Boolean(id)), created: 0, patched: 0 };
  const reservation = await prisma.reservation.findUniqueOrThrow({
    where: { id: session.reservationId },
    select: { id: true, code: true, arrivalDate: true, departureDate: true, propertyId: true }
  });

  // Perfiles de los acompañantes sin Guest (el parte y el check-in enlazan por guestId).
  const guestIds = new Map<string, string>();
  for (const row of session.guests) guestIds.set(row.id, await ensureGuestProfile(row, context.organizationId, reservation.id));

  const checkinAt = nowIso();
  const checkoutAt = reservation.departureDate.toISOString();
  const paymentType = paymentTypeForSession(session.paymentStatus);
  const recordIds: string[] = [];
  let created = 0;
  let patched = 0;
  for (const row of targets) {
    const guestId = guestIds.get(row.id)!;
    const providedByAdultGuestId = row.isMinor && row.providedByCheckInGuestId ? (guestIds.get(row.providedByCheckInGuestId) ?? null) : null;
    const payload: GuestRegisterWriteInput = {
      ...spainInputFromTraveller(travellerFieldsOf(row, providedByAdultGuestId)),
      ...(paymentType ? { paymentType } : {}),
      isPrimaryGuest: row.isPrimary,
      contractReference: reservation.code,
      checkinAt,
      checkoutAt
    };
    const existingId =
      row.guestRegisterRecordId ??
      (await prisma.guestRegisterRecord.findFirst({ where: { reservationId: reservation.id, guestId }, select: { id: true } }))?.id ??
      null;
    const record = existingId
      ? await patchSpainGuestRegisterRecord({ context, recordId: existingId, patch: payload, correlationId })
      : await createSpainGuestRegisterRecord({ context, propertyId: reservation.propertyId, reservationId: reservation.id, payload: { ...payload, guestId }, correlationId });
    if (existingId) patched += 1;
    else created += 1;
    recordIds.push(record.id);
    await prisma.checkInGuest.update({
      where: { id: row.id },
      data: { guestRegisterRecordId: record.id, status: deriveGuestStatus(row.status, [], Boolean(row.documentNumber)) }
    });
  }
  const guests = await loadSessionGuests(session.id);
  return { guests, recordIds: guests.map((row) => row.guestRegisterRecordId).filter((id): id is string => Boolean(id)), created, patched };
}

export async function completePreArrival(input: { token: string | null | undefined; correlationId?: string }): Promise<CheckInSessionView> {
  const { session } = await requireSessionForToken(input.token);
  assertOpen(session);
  const missing = missingForSession(session.guests);
  if (missing.length > 0) {
    throw new ConflictError("Faltan datos de viajeros para cerrar el pre-check-in.", { code: "CHECKIN_INCOMPLETE", missing });
  }
  const context = await checkInServiceContext(session.propertyId, { kind: "guest", sessionId: session.id });
  const correlationId = input.correlationId ?? createId("corr");
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: session.reservationId }, select: { id: true } });
  const { recordIds } = await ensureGuestRegisterRecordsForSession({ session, context, correlationId });

  const now = new Date();
  const updated = await prisma.checkInSession.update({
    where: { id: session.id },
    data: { status: "ready_for_arrival", completedAt: session.completedAt ?? now }
  });
  recordDomainEvent({
    organizationId: context.organizationId,
    propertyId: session.propertyId,
    entityType: "checkin_session",
    entityId: session.id,
    eventType: "CheckInPreArrivalCompleted",
    payload: { reservationId: reservation.id, sessionId: session.id, travellers: session.guests.length, guestRegisterRecordIds: recordIds, completedAt: updated.completedAt?.toISOString() ?? now.toISOString() },
    actorType: "system",
    actorUserId: context.userId,
    correlationId
  });
  audit(context, {
    action: "CheckInPreArrivalCompleted",
    entityType: "checkin_session",
    entityId: session.id,
    beforeJson: { status: session.status },
    afterJson: { status: updated.status, travellers: session.guests.length, guestRegisterRecordIds: recordIds },
    correlationId
  });
  const refreshed = await loadSessionById(session.id);
  return toSessionView(refreshed!, refreshed!.guests);
}

// ── Llegadas (Mi día) ────────────────────────────────────────────────────────

export type ArrivalDto = {
  reservationId: string;
  code: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  eta: string | null;
  roomTypeId: string | null;
  assignedRoomId: string | null;
  assignedRoomNumber: string | null;
  primaryGuest: { firstName: string; surname1: string | null } | null;
  preCheckIn: { sessionId: string; status: CheckInSessionStatus; completedGuests: number; totalGuests: number; etaDeclared: string | null } | null;
  suggestion: { id: string; status: string; topRoomId: string | null; topRoomNumber: string | null; confidence: number; createdAt: string } | null;
  /** `signed`: pase firmado por Apple (certificado) — la métrica «llaves sin recepción» solo cuenta estas (corrector REV3-13). */
  key: { serialNumber: string | null; validUntil: string | null; issuedAt: string | null; signed: boolean } | null;
};

function dayStart(value: string | undefined): Date {
  const day = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00.000Z`);
}

export async function listArrivals(input: { propertyId: string; date?: string }): Promise<{ date: string; items: ArrivalDto[] }> {
  const date = dayStart(input.date);
  const reservations = await prisma.reservation.findMany({
    where: { propertyId: input.propertyId, deletedAt: null, arrivalDate: date, status: { in: ["confirmed", "checked_in"] } },
    include: { reservationGuests: { where: { isPrimary: true }, take: 1, include: { guest: { select: { firstName: true, surname1: true } } } } },
    orderBy: [{ eta: "asc" }, { code: "asc" }]
  });
  const ids = reservations.map((reservation) => reservation.id);
  const [sessions, suggestions, keys, rooms] = ids.length
    ? await Promise.all([
        prisma.checkInSession.findMany({ where: { reservationId: { in: ids } }, include: { guests: { select: { status: true } } } }),
        prisma.assignmentSuggestion.findMany({ where: { propertyId: input.propertyId, reservationId: { in: ids }, status: "suggested" }, orderBy: { createdAt: "desc" } }),
        prisma.guestPortalAction.findMany({ where: { propertyId: input.propertyId, reservationId: { in: ids }, actionType: "mobile_key", status: "active" }, orderBy: { createdAt: "desc" } }),
        prisma.room.findMany({ where: { propertyId: input.propertyId }, select: { id: true, number: true } })
      ])
    : [[], [], [], []];
  const roomNumber = new Map(rooms.map((room) => [room.id, room.number] as const));
  const sessionByReservation = new Map(sessions.map((session) => [session.reservationId, session] as const));
  const suggestionByReservation = new Map<string, (typeof suggestions)[number]>();
  for (const suggestion of suggestions) if (!suggestionByReservation.has(suggestion.reservationId)) suggestionByReservation.set(suggestion.reservationId, suggestion);
  const keyByReservation = new Map<string, (typeof keys)[number]>();
  for (const key of keys) if (key.reservationId && !keyByReservation.has(key.reservationId)) keyByReservation.set(key.reservationId, key);

  const items: ArrivalDto[] = reservations.map((reservation) => {
    const session = sessionByReservation.get(reservation.id);
    const suggestion = suggestionByReservation.get(reservation.id);
    const key = keyByReservation.get(reservation.id);
    const candidates = suggestion && Array.isArray(suggestion.candidatesJson) ? (suggestion.candidatesJson as Array<{ roomId?: string; number?: string }>) : [];
    const payload = key && key.payloadJson && typeof key.payloadJson === "object" ? (key.payloadJson as Record<string, unknown>) : {};
    const primary = reservation.reservationGuests[0]?.guest ?? null;
    return {
      reservationId: reservation.id,
      code: reservation.code,
      status: reservation.status,
      arrivalDate: reservation.arrivalDate.toISOString().slice(0, 10),
      departureDate: reservation.departureDate.toISOString().slice(0, 10),
      adults: reservation.adults,
      children: reservation.children,
      eta: reservation.eta ?? null,
      roomTypeId: reservation.roomTypeId ?? null,
      assignedRoomId: reservation.assignedRoomId ?? null,
      assignedRoomNumber: reservation.assignedRoomId ? (roomNumber.get(reservation.assignedRoomId) ?? null) : null,
      primaryGuest: primary ? { firstName: primary.firstName, surname1: primary.surname1 ?? null } : null,
      preCheckIn: session
        ? {
            sessionId: session.id,
            status: (CHECKIN_SESSION_STATUSES as readonly string[]).includes(session.status) ? (session.status as CheckInSessionStatus) : "invited",
            completedGuests: session.guests.filter((guest) => ["data_complete", "signed", "verified"].includes(guest.status)).length,
            totalGuests: session.guests.length,
            etaDeclared: session.etaDeclared ?? null
          }
        : null,
      suggestion: suggestion
        ? {
            id: suggestion.id,
            status: suggestion.status,
            topRoomId: candidates[0]?.roomId ?? null,
            topRoomNumber: candidates[0]?.number ?? (candidates[0]?.roomId ? (roomNumber.get(candidates[0].roomId) ?? null) : null),
            confidence: Number(suggestion.confidence),
            createdAt: suggestion.createdAt.toISOString()
          }
        : null,
      key: key
        ? {
            serialNumber: typeof payload.serialNumber === "string" ? payload.serialNumber : null,
            validUntil: typeof payload.validUntil === "string" ? payload.validUntil : null,
            issuedAt: typeof payload.issuedAt === "string" ? payload.issuedAt : null,
            signed: payload.signedByApple === true
          }
        : null
    };
  });
  return { date: date.toISOString().slice(0, 10), items };
}
