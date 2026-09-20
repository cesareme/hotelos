// Llegada del check-in automatizado (Tanda CHK · lote W3-A; diseño §4c tabla
// «Llegada», §4d excepciones, R3 y R17).
//
// `completeCheckIn` es la ÚNICA puerta por la que el huésped (portal/móvil), un
// kiosco emparejado o la recepción (drawer) cierran la llegada. Precondiciones
// DETERMINISTAS, cada una con su 409 tipado, en este orden:
//   1. actor y sesión: guest/kiosk por token opaco del portal (401
//      GUEST_SESSION_INVALID si no abre la reserva); recepción con su UserContext
//      (404 opaco fuera de la organización). Reserva `confirmed` (409 sin código
//      si ya está alojada o cerrada) y sesión `ready_for_arrival|arrived` para
//      guest/kiosk; recepción desde cualquier estado con los datos completos
//      (409 CHECKIN_INCOMPLETE { missing }).
//   2. ventana ±1 día sobre la fecha de negocio (misma regla que
//      checkInReservation, pms.service.ts) → 409 CHECK_IN_DATE_OUT_OF_RANGE;
//      solo recepción puede forzarla con allowEarlyCheckIn + overrideReason.
//   3. identidad del titular verificada por un método admitido por la política
//      (allowedVerificationMethods): identityVerifiedAt con método admitido en
//      CheckInGuest o en su parte (markGuestRegisterIdentityVerified,
//      compliance.service.ts); `mrz_checksum` sin identityVerifiedAt cuenta SOLO si
//      la política lo admite y el actor no es un kiosco con
//      requireVisualCheckAtKiosk → 409 IDENTITY_NOT_VERIFIED.
//   4. partes firmados de todos los viajeros mayores (menores < 14 sin firma;
//      R3: signatureObjectKey debe ser el id de una Signature real, nunca un
//      literal sig_*) → 409 GUEST_REGISTER_INCOMPLETE { missing }.
//   5. saldo según depositPolicy (guest/kiosk; recepción es «pago en recepción»):
//      none no exige; balance → folio saldado o paymentStatus
//      paid|authorized|at_reception; first_night/fixed → cobrado ≥ importe →
//      409 BALANCE_DUE.
//   6. habitación: la asignada (o la elegida en la sugerencia confirmada, o la
//      indicada por recepción) libre, sin bloqueo y limpia (`inspected` si
//      requireInspectedRoom, roomStateOf de housekeeping/room-state.service.ts);
//      si no está lista → suggestForReservation (W2-C) filtrada a la misma
//      categoría y a habitaciones listas → confirmSuggestion reasigna; si ninguna
//      → sesión `arrived` con handoffKind room_not_ready y 409 ROOM_NOT_READY
//      { etaReady: dueAt más próximo de la cola de pisos o null }.
// Ejecución con el contexto adecuado (checkInServiceContext para guest/kiosk,
// el usuario para recepción; nunca demoStore.userContext): ensurePrimaryFolio →
// checkInReservation (signatureObjectKey = id de la firma del titular) → llave
// issueWalletPass (sin certificado Apple sigue sin firmar y se dice) → perfiles
// Guest completados SOLO en los campos vacíos con lo capturado en el viajero
// (profileFillFromTraveller: la comunicación SES lee los perfiles de la reserva,
// ses-submission.service.ts processSubmission, y un acompañante con perfil parcial
// haría fallar TODAS las filas con GUEST_REGISTER_INVALID; nunca se pisa un dato
// existente) → SES queueSesHospedajesSubmission por parte tolerando los 409 SES_DISABLED,
// SES_ESTABLISHMENT_INCOMPLETE, GUEST_REGISTER_INVALID y SES_SUBMISSION_IN_FLIGHT
// como avisos (nunca finge encolado) → bienvenida sendWelcomeMessage (W2-D) →
// sesión checked_in + checkedInAt → auditoría GUEST_SELF_CHECKED_IN (guest/kiosk)
// o GUEST_CHECKED_IN_ASSISTED (recepción) con CheckInSession.id.
//
// Dependencias inyectables (ArrivalDeps): los tests unitarios usan dobles en
// memoria (__tests__/arrival.test.mts); producción, Prisma y los servicios reales.

import type { IdentityVerificationMethod, PropertyCheckInPolicyDto } from "@hotelos/shared";
import { IDENTITY_VERIFICATION_METHODS } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { queueSesHospedajesSubmission } from "../compliance/compliance.service.js";
import { ensurePrimaryFolio, findReservationFolio } from "../folio/folio.service.js";
import { verifyGuestToken } from "../guest-portal/guest-portal-auth.service.js";
import { GuestPortalAuthError } from "../guest-portal/guest-portal.service.js";
import { roomStateOf } from "../housekeeping/room-state.service.js";
import { sendWelcomeMessage } from "../messaging/messaging.service.js";
import { issueWalletPass } from "../mobile-keys/wallet-pass.service.js";
import { getCurrentBusinessDate } from "../night-audit/night-audit.service.js";
import { checkInReservation, findOverlappingRoomBlock, todayInTimezone } from "../pms/pms.service.js";
import { confirmSuggestion, suggestForReservation } from "../pms/room-assignment.service.js";
import { getPolicy } from "./checkin-policy.service.js";
import { GUEST_SESSION_INVALID_MESSAGE, ensureGuestRegisterRecordsForSession, missingForSession, type MissingTraveller } from "./checkin-session.service.js";
import { checkInServiceContext, type CheckInActor } from "./service-context.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Ventana de check-in (misma que pms.service.ts CHECK_IN_WINDOW_DAYS). */
export const ARRIVAL_WINDOW_DAYS = 1;
/** Estados de la sesión desde los que el huésped o el kiosco pueden llegar. */
export const ARRIVAL_SESSION_STATUSES: readonly string[] = Object.freeze(["ready_for_arrival", "arrived"]);
/** paymentStatus que satisfacen el saldo sin mirar el folio (corrector REV3-02: `at_reception` solo si la política admite el pago en recepción). */
export const SETTLED_PAYMENT_STATUSES: readonly string[] = Object.freeze(["paid", "authorized"]);
/** Sin PSP el enlace de pago deja este estado; para el huésped/kiosco vale solo con `allowPayAtReception`. */
export const AT_RECEPTION_PAYMENT_STATUS = "at_reception";
export const HANDOFF_PAYMENT_FAILED = "payment_failed";
/** 409 del encolado SES que se toleran como aviso (el check-in ya está hecho; nunca se finge encolado). */
export const TOLERATED_SES_CODES: readonly string[] = Object.freeze(["SES_DISABLED", "SES_ESTABLISHMENT_INCOMPLETE", "GUEST_REGISTER_INVALID", "SES_SUBMISSION_IN_FLIGHT"]);
/** R3: un signatureObjectKey con este prefijo es un literal antiguo, no una firma. */
export const LEGACY_SIGNATURE_PREFIX = "sig_";
export const AUDIT_SELF_CHECKED_IN = "GUEST_SELF_CHECKED_IN";
export const AUDIT_ASSISTED_CHECKED_IN = "GUEST_CHECKED_IN_ASSISTED";
export const HANDOFF_ROOM_NOT_READY = "room_not_ready";
const BALANCE_EPSILON = 0.005;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Tipos (forma estructural: fila Prisma o doble de test)
// ---------------------------------------------------------------------------

export type ArrivalActorKind = "guest" | "kiosk" | "user";

export type CompleteCheckInInput = {
  actor: ArrivalActorKind;
  /** guest/kiosk: token opaco de GuestPortalSession (x-guest-token). */
  token?: string | null;
  /** user: contexto de la persona de recepción. */
  context?: UserContext;
  reservationId: string;
  /** Solo recepción: habitación elegida a mano (si no está lista → 409 ROOM_NOT_READY, sin reasignar). */
  roomId?: string | null;
  verification?: { method?: IdentityVerificationMethod | null; kioskDeviceId?: string | null } | null;
  /** Solo recepción (checkInReservation exige pms.reservation.modify + motivo). */
  allowEarlyCheckIn?: boolean;
  overrideReason?: string;
  correlationId?: string;
};

/** Campos del viajero que pueden completar un perfil Guest vacío (misma clave en ambos salvo phoneMobile → mobilePhone y residenceFullAddress → residenceAddress). */
export type TravellerProfileFields = {
  surname1?: string | null;
  surname2?: string | null;
  sex?: string | null;
  nationality?: string | null;
  dateOfBirth?: Date | null;
  documentType?: string | null;
  documentNumber?: string | null;
  documentSupportNumber?: string | null;
  documentExpiryDate?: Date | null;
  email?: string | null;
  phoneMobile?: string | null;
  residenceFullAddress?: string | null;
  residenceLocality?: string | null;
  residenceCountry?: string | null;
};

export type ArrivalGuestRow = TravellerProfileFields & {
  id: string;
  guestId: string | null;
  guestRegisterRecordId: string | null;
  isPrimary: boolean;
  ordinal: number;
  status: string;
  isMinor: boolean;
  identityVerificationMethod: string | null;
  identityVerifiedAt: Date | null;
  firstName: string | null;
};

/** Subconjunto del perfil Guest que la llegada puede completar (fila Prisma o doble). */
export type GuestProfileRow = {
  id: string;
  surname1: string | null;
  surname2: string | null;
  sex: string | null;
  nationality: string | null;
  dateOfBirth: Date | null;
  documentType: string | null;
  documentNumber: string | null;
  documentSupportNumber: string | null;
  documentExpiryDate: Date | null;
  email: string | null;
  mobilePhone: string | null;
  residenceAddress: string | null;
  residenceLocality: string | null;
  residenceCountry: string | null;
};

export type GuestProfilePatch = Partial<Omit<GuestProfileRow, "id">>;

/** Fila completa de checkin_guests (la usa missingForSession para recepción); los dobles solo necesitan ArrivalGuestRow. */
type FullGuestRow = Parameters<typeof missingForSession>[0][number];

export type ArrivalSessionRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  status: string;
  arrivedAt: Date | null;
  checkedInAt: Date | null;
  paymentStatus: string;
  kioskDeviceId: string | null;
  guests: ArrivalGuestRow[];
};

export type ArrivalReservationRow = {
  id: string;
  code: string;
  propertyId: string;
  status: string;
  arrivalDate: Date;
  departureDate: Date;
  roomTypeId: string | null;
  assignedRoomId: string | null;
  totalAmount: unknown;
};

export type ArrivalRoomRow = {
  id: string;
  propertyId: string;
  number: string;
  floor: string | null;
  roomTypeId: string | null;
  status: string;
  housekeepingStatus: string | null;
  maintenanceStatus: string | null;
  sellable: boolean;
};

export type ArrivalRecordRow = {
  id: string;
  guestId: string | null;
  status: string;
  isMinor: boolean;
  signedAt: Date | null;
  signatureObjectKey: string | null;
  identityVerified: boolean;
  identityVerificationMethod: string | null;
};

export type ArrivalFolioBalance = { balanceDue: number; paymentsTotal: number; currency: string | null } | null;

export type ArrivalRoomBlock = { id: string; fromDate: string; toDate: string; reason: string };

export type ArrivalDeps = {
  now: () => Date;
  createId: (prefix: string) => string;
  verifyGuestToken: (token: string | null | undefined) => Promise<{ reservationId: string; propertyId: string } | null>;
  loadSession: (reservationId: string) => Promise<ArrivalSessionRow | null>;
  loadReservation: (reservationId: string) => Promise<ArrivalReservationRow | null>;
  loadProperty: (propertyId: string) => Promise<{ organizationId: string; timezone: string | null } | null>;
  loadPolicy: (propertyId: string) => Promise<PropertyCheckInPolicyDto>;
  /** Campos del parte que faltan por viajero (missingForSession de checkin-session.service.ts). */
  missingFields: (guests: readonly ArrivalGuestRow[]) => MissingTraveller[];
  loadRecords: (ids: readonly string[]) => Promise<ArrivalRecordRow[]>;
  loadRoom: (roomId: string) => Promise<ArrivalRoomRow | null>;
  loadRooms: (roomIds: readonly string[]) => Promise<ArrivalRoomRow[]>;
  /** RoomBlock que solape la estancia (corrector REV3-01: filtro duro, diseño §4b) o null. */
  loadRoomBlock: (roomId: string, arrivalDate: Date, departureDate: Date) => Promise<ArrivalRoomBlock | null>;
  /** Recepción (corrector REV3-04): partes de los viajeros con datos completos que aún no lo tienen; devuelve los viajeros releídos. */
  ensureGuestRegisterRecords: (session: ArrivalSessionRow, context: UserContext, correlationId: string) => Promise<ArrivalGuestRow[]>;
  /** Última sugerencia decidida (confirmed | changed | auto_assigned) con habitación elegida. */
  loadChosenRoomId: (reservationId: string) => Promise<string | null>;
  /** dueAt más próximo de una tarea de pisos abierta sobre la habitación, o null. */
  loadHousekeepingEta: (roomId: string) => Promise<Date | null>;
  folioBalance: (reservationId: string) => Promise<ArrivalFolioBalance>;
  /** Perfil Guest por consulta de primer nivel (descifrado) o null. */
  loadGuestProfile: (guestId: string) => Promise<GuestProfileRow | null>;
  /** Completa SOLO los campos del parche (vacíos en el perfil). */
  updateGuestProfile: (guestId: string, patch: GuestProfilePatch) => Promise<unknown>;
  businessDate: (propertyId: string) => Promise<string>;
  todayInTimezone: (timezone: string) => string;
  serviceContext: (propertyId: string, actor: CheckInActor) => Promise<UserContext>;
  suggestForReservation: typeof suggestForReservation;
  confirmSuggestion: typeof confirmSuggestion;
  ensurePrimaryFolio: typeof ensurePrimaryFolio;
  checkInReservation: typeof checkInReservation;
  issueWalletPass: typeof issueWalletPass;
  queueSesHospedajesSubmission: typeof queueSesHospedajesSubmission;
  sendWelcomeMessage: typeof sendWelcomeMessage;
  updateSession: (sessionId: string, data: { status?: string; arrivedAt?: Date; checkedInAt?: Date; kioskDeviceId?: string | null; handoffKind?: string | null; handoffReason?: string | null }) => Promise<unknown>;
  recordAuditEvent: typeof recordAuditEvent;
  recordDomainEvent: typeof recordDomainEvent;
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
  actor: ArrivalActorKind;
  room: { id: string; number: string; floor: string | null };
  /** true cuando la habitación asignada no estaba lista y se reasignó a otra de la misma categoría. */
  reassigned: boolean;
  key: ArrivalKey;
  ses: { status: "queued" | "partial" | "warning"; submissions: ArrivalSesSubmission[]; warnings: string[] };
  welcome: Awaited<ReturnType<typeof sendWelcomeMessage>>;
  checkedInAt: string;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Dependencias por defecto e inyección para tests
// ---------------------------------------------------------------------------

function defaultDeps(): ArrivalDeps {
  return {
    now: () => new Date(),
    createId,
    verifyGuestToken,
    // Filas completas de checkin_guests por consulta DE PRIMER NIVEL (missingForSession
    // necesita los campos del parte descifrados; la extensión de cifrado no descifra
    // las filas alcanzadas por `include`, checkin-session.service.ts loadProfiles).
    loadSession: async (reservationId) => {
      const session = await prisma.checkInSession.findUnique({ where: { reservationId } });
      if (!session) return null;
      const guests = await prisma.checkInGuest.findMany({ where: { sessionId: session.id }, orderBy: { ordinal: "asc" } });
      return { ...session, guests };
    },
    loadReservation: (reservationId) =>
      prisma.reservation.findFirst({
        where: { id: reservationId, deletedAt: null },
        select: { id: true, code: true, propertyId: true, status: true, arrivalDate: true, departureDate: true, roomTypeId: true, assignedRoomId: true, totalAmount: true }
      }),
    loadProperty: (propertyId) => prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true, timezone: true } }),
    loadPolicy: getPolicy,
    missingFields: (guests) => missingForSession(guests as FullGuestRow[]),
    loadRecords: (ids) =>
      ids.length === 0
        ? Promise.resolve([])
        : prisma.guestRegisterRecord.findMany({
            where: { id: { in: [...ids] } },
            select: { id: true, guestId: true, status: true, isMinor: true, signedAt: true, signatureObjectKey: true, identityVerified: true, identityVerificationMethod: true }
          }),
    loadRoom: (roomId) => prisma.room.findUnique({ where: { id: roomId }, select: ROOM_SELECT }),
    loadRooms: (roomIds) => (roomIds.length === 0 ? Promise.resolve([]) : prisma.room.findMany({ where: { id: { in: [...roomIds] } }, select: ROOM_SELECT })),
    loadRoomBlock: (roomId, arrivalDate, departureDate) => findOverlappingRoomBlock(prisma, { roomId, arrivalDate: isoDay(arrivalDate), departureDate: isoDay(departureDate) }),
    ensureGuestRegisterRecords: async (session, context, correlationId) => {
      const row = await prisma.checkInSession.findUnique({ where: { id: session.id } });
      if (!row) return session.guests;
      const guests = await prisma.checkInGuest.findMany({ where: { sessionId: session.id }, orderBy: { ordinal: "asc" } });
      const result = await ensureGuestRegisterRecordsForSession({ session: { ...row, guests }, context, correlationId, onlyMissing: true });
      return result.guests;
    },
    loadChosenRoomId: async (reservationId) => {
      const row = await prisma.assignmentSuggestion.findFirst({
        where: { reservationId, status: { in: ["confirmed", "changed", "auto_assigned"] }, chosenRoomId: { not: null } },
        orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
        select: { chosenRoomId: true }
      });
      return row?.chosenRoomId ?? null;
    },
    loadHousekeepingEta: async (roomId) => {
      const task = await prisma.housekeepingTask.findFirst({
        where: { roomId, status: { in: ["pending", "in_progress"] }, dueAt: { not: null } },
        orderBy: { dueAt: "asc" },
        select: { dueAt: true }
      });
      return task?.dueAt ?? null;
    },
    folioBalance: async (reservationId) => {
      const folio = await findReservationFolio(reservationId);
      return folio ? { balanceDue: folio.reservationBalanceDue, paymentsTotal: folio.paymentsTotal, currency: folio.folio.currency ?? null } : null;
    },
    loadGuestProfile: (guestId) => prisma.guest.findFirst({ where: { id: guestId, deletedAt: null }, select: GUEST_PROFILE_SELECT }),
    updateGuestProfile: (guestId, patch) => prisma.guest.update({ where: { id: guestId }, data: patch, select: { id: true } }),
    businessDate: getCurrentBusinessDate,
    todayInTimezone,
    serviceContext: checkInServiceContext,
    suggestForReservation,
    confirmSuggestion,
    ensurePrimaryFolio,
    checkInReservation,
    issueWalletPass,
    queueSesHospedajesSubmission,
    sendWelcomeMessage,
    updateSession: (sessionId, data) => prisma.checkInSession.update({ where: { id: sessionId }, data, select: { id: true } }),
    recordAuditEvent,
    recordDomainEvent
  };
}

const ROOM_SELECT = { id: true, propertyId: true, number: true, floor: true, roomTypeId: true, status: true, housekeepingStatus: true, maintenanceStatus: true, sellable: true } as const;
const GUEST_PROFILE_SELECT = { id: true, surname1: true, surname2: true, sex: true, nationality: true, dateOfBirth: true, documentType: true, documentNumber: true, documentSupportNumber: true, documentExpiryDate: true, email: true, mobilePhone: true, residenceAddress: true, residenceLocality: true, residenceCountry: true } as const;

let overrides: Partial<ArrivalDeps> | null = null;
function currentDeps(): ArrivalDeps {
  return overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}
/** Sustituye dependencias (tests sin Prisma). Sin argumento restaura las reales. */
export function resetArrivalServiceForTests(deps?: Partial<ArrivalDeps>): void {
  overrides = deps ?? null;
}

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los tests)
// ---------------------------------------------------------------------------

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Días enteros de `fromIso` a `toIso` (positivo si `toIso` es posterior). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${toIso}T00:00:00.000Z`).getTime() - new Date(`${fromIso}T00:00:00.000Z`).getTime()) / DAY_MS);
}

/** Ventana ±ARRIVAL_WINDOW_DAYS entre la fecha de referencia (la mayor de negocio/hoy local) y la llegada. */
export function arrivalWindow(input: { businessDate: string; localToday: string; arrivalDate: Date }): { referenceDate: string; arrivalDate: string; offsetDays: number; withinWindow: boolean } {
  const referenceDate = input.businessDate > input.localToday ? input.businessDate : input.localToday;
  const arrivalDate = isoDay(input.arrivalDate);
  const offsetDays = daysBetweenIso(referenceDate, arrivalDate);
  return { referenceDate, arrivalDate, offsetDays, withinWindow: Math.abs(offsetDays) <= ARRIVAL_WINDOW_DAYS };
}

export type IdentityVerdict = { verified: true; method: IdentityVerificationMethod } | { verified: false; method: string | null; reason: "no_method" | "method_not_allowed" | "not_confirmed" | "kiosk_visual_check" };

/**
 * ¿Está verificada la identidad de un viajero según la política? Cuenta el
 * método con `identityVerifiedAt` en CheckInGuest o `identityVerified` en su
 * parte (recepción). `mrz_checksum` sin fecha cuenta solo si la política lo
 * admite y el actor no es un kiosco obligado al cotejo visual.
 */
export function identityVerdict(input: {
  guest: Pick<ArrivalGuestRow, "identityVerificationMethod" | "identityVerifiedAt">;
  record: Pick<ArrivalRecordRow, "identityVerified" | "identityVerificationMethod"> | null;
  allowedMethods: readonly string[];
  actor: ArrivalActorKind;
  requireVisualCheckAtKiosk: boolean;
}): IdentityVerdict {
  const allowed = (method: string | null | undefined): method is IdentityVerificationMethod =>
    typeof method === "string" && (IDENTITY_VERIFICATION_METHODS as readonly string[]).includes(method) && input.allowedMethods.includes(method);
  const recordMethod = input.record?.identityVerified ? (input.record.identityVerificationMethod ?? "visual_reception") : null;
  if (recordMethod && allowed(recordMethod)) return { verified: true, method: recordMethod };
  const method = input.guest.identityVerificationMethod;
  if (!method && !recordMethod) return { verified: false, method: null, reason: "no_method" };
  if (input.guest.identityVerifiedAt && allowed(method)) return { verified: true, method };
  if (method === "mrz_checksum" && !input.guest.identityVerifiedAt) {
    if (!allowed(method)) return { verified: false, method, reason: "method_not_allowed" };
    if (input.actor === "kiosk" && input.requireVisualCheckAtKiosk) return { verified: false, method, reason: "kiosk_visual_check" };
    return { verified: true, method };
  }
  if (!allowed(method ?? recordMethod)) return { verified: false, method: method ?? recordMethod, reason: "method_not_allowed" };
  return { verified: false, method: method ?? recordMethod, reason: "not_confirmed" };
}

export type SignatureGap = { checkInGuestId: string; ordinal: number; reason: "guest_register_record" | "signature" | "legacy_signature" };

/** R3: partes firmados de los adultos (signatureObjectKey = id real de Signature); los menores < 14 no firman. */
export function signatureGaps(guests: readonly ArrivalGuestRow[], records: ReadonlyMap<string, ArrivalRecordRow>): SignatureGap[] {
  const gaps: SignatureGap[] = [];
  for (const guest of guests) {
    const record = guest.guestRegisterRecordId ? records.get(guest.guestRegisterRecordId) : undefined;
    if (!record) {
      gaps.push({ checkInGuestId: guest.id, ordinal: guest.ordinal, reason: "guest_register_record" });
      continue;
    }
    if (guest.isMinor || record.isMinor) continue;
    if (!record.signedAt || !record.signatureObjectKey) {
      gaps.push({ checkInGuestId: guest.id, ordinal: guest.ordinal, reason: "signature" });
      continue;
    }
    if (record.signatureObjectKey.startsWith(LEGACY_SIGNATURE_PREFIX)) gaps.push({ checkInGuestId: guest.id, ordinal: guest.ordinal, reason: "legacy_signature" });
  }
  return gaps;
}

export type BalanceVerdict = { ok: true } | { ok: false; required: number; paid: number; balanceDue: number };

/**
 * Saldo exigido por depositPolicy (none · balance · first_night · fixed) frente
 * al folio y al paymentStatus de la sesión. `at_reception` (sin PSP) solo cuenta
 * como pagado si la política admite el pago en recepción (corrector REV3-02:
 * antes bastaba pedir el enlace sin PSP para saltarse el depósito).
 */
export function balanceVerdict(input: {
  policy: Pick<PropertyCheckInPolicyDto, "depositPolicy" | "depositAmount"> & Partial<Pick<PropertyCheckInPolicyDto, "allowPayAtReception">>;
  paymentStatus: string;
  folio: ArrivalFolioBalance;
  reservation: Pick<ArrivalReservationRow, "totalAmount" | "arrivalDate" | "departureDate">;
}): BalanceVerdict {
  if (input.policy.depositPolicy === "none") return { ok: true };
  if (SETTLED_PAYMENT_STATUSES.includes(input.paymentStatus)) return { ok: true };
  if (input.paymentStatus === AT_RECEPTION_PAYMENT_STATUS && input.policy.allowPayAtReception === true) return { ok: true };
  const balanceDue = input.folio?.balanceDue ?? 0;
  const paid = input.folio?.paymentsTotal ?? 0;
  if (input.policy.depositPolicy === "balance") {
    return balanceDue <= BALANCE_EPSILON ? { ok: true } : { ok: false, required: balanceDue, paid, balanceDue };
  }
  const total = Number(input.reservation.totalAmount ?? 0) || 0;
  const nights = Math.max(1, daysBetweenIso(isoDay(input.reservation.arrivalDate), isoDay(input.reservation.departureDate)));
  const required = input.policy.depositPolicy === "fixed" ? Number(input.policy.depositAmount ?? 0) || 0 : Math.round((total / nights) * 100) / 100;
  const outstanding = Math.min(required, balanceDue);
  if (outstanding <= BALANCE_EPSILON || paid + BALANCE_EPSILON >= required) return { ok: true };
  return { ok: false, required, paid, balanceDue };
}

/**
 * Lista para alojar: libre, sin bloqueo de mantenimiento/venta NI RoomBlock que
 * solape la estancia (`roomBlock`, corrector REV3-01), limpia (inspeccionada si
 * la política lo exige) y de la propiedad.
 */
export function isRoomReady(room: ArrivalRoomRow, input: { propertyId: string; requireInspectedRoom: boolean; roomBlock?: ArrivalRoomBlock | null }): boolean {
  if (room.propertyId !== input.propertyId) return false;
  if (input.roomBlock) return false;
  const state = roomStateOf(room);
  if (state.occupancy !== "vacant" || state.isBlocked) return false;
  return input.requireInspectedRoom ? state.cleanliness === "inspected" : state.isClean;
}

const PROFILE_FIELD_MAP: ReadonlyArray<readonly [keyof TravellerProfileFields, keyof GuestProfilePatch]> = [
  ["surname1", "surname1"],
  ["surname2", "surname2"],
  ["sex", "sex"],
  ["nationality", "nationality"],
  ["dateOfBirth", "dateOfBirth"],
  ["documentType", "documentType"],
  ["documentNumber", "documentNumber"],
  ["documentSupportNumber", "documentSupportNumber"],
  ["documentExpiryDate", "documentExpiryDate"],
  ["email", "email"],
  ["phoneMobile", "mobilePhone"],
  ["residenceFullAddress", "residenceAddress"],
  ["residenceLocality", "residenceLocality"],
  ["residenceCountry", "residenceCountry"]
];

/**
 * Parche PURO para completar un perfil Guest con lo capturado en el viajero:
 * solo entran los campos VACÍOS del perfil con valor en el viajero; nunca se
 * sobrescribe un dato existente (la ficha del huésped manda). Vacío = {}.
 */
export function profileFillFromTraveller(profile: Omit<GuestProfileRow, "id">, traveller: TravellerProfileFields): GuestProfilePatch {
  const patch: GuestProfilePatch = {};
  for (const [from, to] of PROFILE_FIELD_MAP) {
    const current = profile[to];
    const value = traveller[from];
    const empty = current === null || current === undefined || (typeof current === "string" && current.trim() === "");
    const present = value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
    if (empty && present) (patch as Record<string, unknown>)[to] = value;
  }
  return patch;
}

function conflict(message: string, details: Record<string, unknown>): ConflictError {
  return new ConflictError(message, details);
}

function is409WithCode(error: unknown, codes: readonly string[]): error is HttpError {
  if (!(error instanceof HttpError) || error.statusCode !== 409) return false;
  const code = (error.details as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && codes.includes(code);
}

// ---------------------------------------------------------------------------
// completeCheckIn
// ---------------------------------------------------------------------------

/** Resultado de las precondiciones (pasos 1-5) que comparten precheckCheckIn y completeCheckIn. */
type PreparedArrival = {
  deps: ArrivalDeps;
  correlationId: string;
  now: Date;
  warnings: string[];
  reservation: ArrivalReservationRow;
  property: { organizationId: string; timezone: string | null };
  session: ArrivalSessionRow;
  context: UserContext;
  policy: PropertyCheckInPolicyDto;
  primary: ArrivalGuestRow;
  records: Map<string, ArrivalRecordRow>;
  verdict: Extract<IdentityVerdict, { verified: true }>;
  signatureObjectKey: string;
  allowEarly: boolean;
};

export type PrecheckCheckInResult = {
  ok: true;
  dryRun: true;
  reservationId: string;
  sessionId: string;
  actor: ArrivalActorKind;
  identityMethod: IdentityVerificationMethod;
  /** Partes creados por recepción desde los viajeros con datos completos (0 si ya existían). */
  recordsCreated: number;
  warnings: string[];
};

/**
 * Pasos 1-5 de completeCheckIn (actor y sesión, ventana, identidad, firmas,
 * saldo). Lanza los 409 tipados; no asigna, no cobra, no aloja. La única
 * escritura es la de recepción (actor user): los partes de los viajeros con
 * datos completos que aún no lo tienen (corrector REV3-04) — es lo que
 * permite firmar en el mostrador una sesión que el huésped no cerró.
 */
async function prepareArrival(input: CompleteCheckInInput): Promise<PreparedArrival> {
  const deps = currentDeps();
  const correlationId = input.correlationId ?? deps.createId("corr");
  const now = deps.now();
  const warnings: string[] = [];

  // 1. Actor, reserva, sesión y propiedad.
  const reservation = await deps.loadReservation(input.reservationId);
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const property = await deps.loadProperty(reservation.propertyId);
  if (!property) throw new NotFoundError("Reserva no encontrada.");

  if (input.actor === "user") {
    if (!input.context) throw new BadRequestError("La llegada asistida necesita el contexto de recepción.");
    requirePermissions(input.context, ["pms.checkin.execute"]);
    if (property.organizationId !== input.context.organizationId && input.context.isPlatformAdmin !== true) throw new NotFoundError("Reserva no encontrada.");
  } else {
    const verified = await deps.verifyGuestToken(input.token);
    if (!verified || verified.reservationId !== reservation.id || verified.propertyId !== reservation.propertyId) throw new GuestPortalAuthError(GUEST_SESSION_INVALID_MESSAGE);
  }

  let session = await deps.loadSession(reservation.id);
  if (!session) {
    throw conflict("La reserva no tiene sesión de check-in en línea: invítala o usa el check-in clásico de recepción.", { code: "CHECKIN_INCOMPLETE", missing: [{ field: "session" }] });
  }
  if (session.propertyId !== reservation.propertyId) throw new NotFoundError("Reserva no encontrada.");
  // Contexto: el de recepción, o el de servicio con userId guest:<sessionId> / kiosk:<deviceId> (R17).
  const serviceActor: CheckInActor = input.actor === "kiosk" && input.verification?.kioskDeviceId ? { kind: "kiosk", deviceId: input.verification.kioskDeviceId } : { kind: "guest", sessionId: session.id };
  const context: UserContext = input.actor === "user" ? input.context! : await deps.serviceContext(reservation.propertyId, serviceActor);

  if (reservation.status !== "confirmed") {
    if (reservation.status === "checked_in" || session.status === "checked_in") {
      throw conflict(`La reserva ${reservation.code} ya está alojada.`, { code: "CHECKIN_ALREADY_DONE", status: reservation.status, sessionStatus: session.status });
    }
    throw new ConflictError(`La reserva ${reservation.code} no está lista para el check-in (estado: ${reservation.status}).`);
  }
  if (input.actor !== "user" && !ARRIVAL_SESSION_STATUSES.includes(session.status)) {
    throw conflict("El pre-check-in no está cerrado: completa los datos de los viajeros antes de llegar.", { code: "CHECKIN_INCOMPLETE", status: session.status, missing: deps.missingFields(session.guests) });
  }
  if (input.actor === "user") {
    const missing = deps.missingFields(session.guests);
    if (missing.length > 0) throw conflict("Faltan datos de viajeros para cerrar el check-in.", { code: "CHECKIN_INCOMPLETE", status: session.status, missing });
    // Corrector REV3-04: recepción cierra sesiones que el huésped no cerró (invited / in_progress / handed_off):
    // los partes se crean desde los viajeros con datos completos, como hace completePreArrival.
    if (session.guests.some((guest) => !guest.guestRegisterRecordId)) {
      const guests = await deps.ensureGuestRegisterRecords(session, context, correlationId);
      session = { ...session, guests };
    }
  }

  // 2. Ventana ±1 día (misma regla que checkInReservation, comprobada ANTES de tocar habitaciones).
  const window = arrivalWindow({ businessDate: await deps.businessDate(reservation.propertyId), localToday: deps.todayInTimezone(property.timezone ?? "UTC"), arrivalDate: reservation.arrivalDate });
  const allowEarly = input.actor === "user" && input.allowEarlyCheckIn === true;
  if (!window.withinWindow && !allowEarly) {
    throw conflict(`La reserva ${reservation.code} tiene llegada el ${window.arrivalDate} y la fecha de negocio es ${window.referenceDate}: el check-in solo se admite con ±${ARRIVAL_WINDOW_DAYS} día de margen.`, {
      code: "CHECK_IN_DATE_OUT_OF_RANGE",
      arrivalDate: window.arrivalDate,
      businessDate: window.referenceDate,
      offsetDays: window.offsetDays
    });
  }

  // 3. Identidad del titular verificada por un método admitido.
  const policy = await deps.loadPolicy(reservation.propertyId);
  const primary = session.guests.find((guest) => guest.isPrimary) ?? session.guests[0];
  if (!primary) throw conflict("La sesión no tiene viajeros.", { code: "CHECKIN_INCOMPLETE", missing: [{ field: "travellers" }] });
  const recordIds = session.guests.map((guest) => guest.guestRegisterRecordId).filter((id): id is string => Boolean(id));
  const records = new Map((await deps.loadRecords(recordIds)).map((record) => [record.id, record] as const));
  const verdict = identityVerdict({
    guest: primary,
    record: primary.guestRegisterRecordId ? (records.get(primary.guestRegisterRecordId) ?? null) : null,
    allowedMethods: policy.allowedVerificationMethods,
    actor: input.actor,
    requireVisualCheckAtKiosk: policy.requireVisualCheckAtKiosk
  });
  if (!verdict.verified) {
    throw conflict("La identidad del titular no está verificada por un método admitido por la propiedad.", {
      code: "IDENTITY_NOT_VERIFIED",
      checkInGuestId: primary.id,
      method: verdict.method,
      reason: verdict.reason,
      allowedMethods: policy.allowedVerificationMethods
    });
  }
  for (const guest of session.guests) {
    if (guest.id === primary.id || guest.isMinor) continue;
    const companion = identityVerdict({ guest, record: guest.guestRegisterRecordId ? (records.get(guest.guestRegisterRecordId) ?? null) : null, allowedMethods: policy.allowedVerificationMethods, actor: input.actor, requireVisualCheckAtKiosk: policy.requireVisualCheckAtKiosk });
    if (!companion.verified) warnings.push(`acompañante ${guest.ordinal + 1} sin identidad verificada (${companion.reason})`);
  }

  // 4. Partes firmados (R3).
  const gaps = signatureGaps(session.guests, records);
  if (gaps.length > 0) {
    throw conflict("Faltan firmas del parte de viajeros.", { code: "GUEST_REGISTER_INCOMPLETE", missing: gaps });
  }
  const primaryRecord = primary.guestRegisterRecordId ? records.get(primary.guestRegisterRecordId) : undefined;
  const signerRecord = primaryRecord && primaryRecord.signatureObjectKey && !primaryRecord.isMinor ? primaryRecord : session.guests.map((guest) => (guest.guestRegisterRecordId ? records.get(guest.guestRegisterRecordId) : undefined)).find((record) => record && !record.isMinor && record.signatureObjectKey);
  if (!signerRecord?.signatureObjectKey) {
    throw conflict("Ningún adulto de la reserva ha firmado el parte.", { code: "GUEST_REGISTER_INCOMPLETE", missing: [{ checkInGuestId: primary.id, reason: "signature" }] });
  }
  const signatureObjectKey = signerRecord.signatureObjectKey;

  // 5. Saldo según política (recepción = pago en recepción, nunca bloqueada).
  if (input.actor !== "user") {
    const balance = balanceVerdict({ policy, paymentStatus: session.paymentStatus, folio: await deps.folioBalance(reservation.id), reservation });
    if (!balance.ok) {
      // Sin PSP (`at_reception`) y sin pago en recepción admitido: la sesión pasa a recepción (cola
      // payment_failed, §4d) para que el mostrador cobre y cierre el check-in con el cajón.
      const handoff = session.paymentStatus === AT_RECEPTION_PAYMENT_STATUS && session.status !== "handed_off";
      if (handoff) {
        const reason = `Saldo pendiente ${balance.balanceDue.toFixed(2)} sin PSP; la política no admite el pago en recepción para el check-in autónomo`;
        await deps.updateSession(session.id, { status: "handed_off", arrivedAt: session.arrivedAt ?? now, handoffKind: HANDOFF_PAYMENT_FAILED, handoffReason: reason, ...(input.actor === "kiosk" && input.verification?.kioskDeviceId ? { kioskDeviceId: input.verification.kioskDeviceId } : {}) });
        deps.recordAuditEvent({
          organizationId: session.organizationId,
          propertyId: reservation.propertyId,
          actorUserId: context.userId,
          actorType: "system",
          action: "CheckInHandedOff",
          entityType: "checkin_session",
          entityId: session.id,
          afterJson: { handoffKind: HANDOFF_PAYMENT_FAILED, reason, required: balance.required, paid: balance.paid, balanceDue: balance.balanceDue, depositPolicy: policy.depositPolicy },
          deviceId: context.deviceId,
          correlationId
        });
      }
      throw conflict("La reserva tiene saldo pendiente: paga con el enlace o en recepción antes del check-in.", {
        code: "BALANCE_DUE",
        required: balance.required,
        paid: balance.paid,
        balanceDue: balance.balanceDue,
        depositPolicy: policy.depositPolicy,
        paymentStatus: session.paymentStatus,
        ...(handoff ? { handoffKind: HANDOFF_PAYMENT_FAILED } : {})
      });
    }
  }

  return { deps, correlationId, now, warnings, reservation, property, session, context, policy, primary, records, verdict, signatureObjectKey, allowEarly };
}

/**
 * Comprobación previa (corrector REV3-03): las mismas precondiciones que
 * completeCheckIn (sesión, ventana, identidad, firmas, saldo) SIN asignar,
 * cobrar ni alojar, para que el cajón no cobre antes de saber que el check-in
 * completo va a pasar. Recepción: crea los partes que falten (única escritura).
 */
export async function precheckCheckIn(input: CompleteCheckInInput): Promise<PrecheckCheckInResult> {
  const before = await currentDeps().loadSession(input.reservationId);
  const prepared = await prepareArrival(input);
  const recordsBefore = before?.guests.filter((guest) => guest.guestRegisterRecordId).length ?? 0;
  const recordsAfter = prepared.session.guests.filter((guest) => guest.guestRegisterRecordId).length;
  return {
    ok: true,
    dryRun: true,
    reservationId: prepared.reservation.id,
    sessionId: prepared.session.id,
    actor: input.actor,
    identityMethod: prepared.verdict.method,
    recordsCreated: Math.max(0, recordsAfter - recordsBefore),
    warnings: prepared.warnings
  };
}

export async function completeCheckIn(input: CompleteCheckInInput): Promise<CompleteCheckInResult> {
  const prepared = await prepareArrival(input);
  const { deps, correlationId, now, warnings, reservation, session, context, policy, primary, records, verdict, signatureObjectKey, allowEarly } = prepared;

  // 6. Habitación lista (o reasignación de la misma categoría por W2-C).
  const requestedRoomId = input.actor === "user" ? input.roomId?.trim() || null : null;
  const preferredRoomId = requestedRoomId ?? reservation.assignedRoomId ?? (await deps.loadChosenRoomId(reservation.id));
  const readiness = { propertyId: reservation.propertyId, requireInspectedRoom: policy.requireInspectedRoom };
  // Corrector REV3-01: un RoomBlock que solape la estancia deja la habitación como NO lista (reasignación de la misma categoría).
  const blockOf = (roomId: string) => deps.loadRoomBlock(roomId, reservation.arrivalDate, reservation.departureDate);
  let room: ArrivalRoomRow | null = preferredRoomId ? await deps.loadRoom(preferredRoomId) : null;
  if (preferredRoomId && !room) throw new NotFoundError("Reserva o habitación no encontrada.");
  const preferredBlock = room ? await blockOf(room.id) : null;
  let reassigned = false;
  if (!room || !isRoomReady(room, { ...readiness, roomBlock: preferredBlock })) {
    const notReady = room;
    const notReadyState = notReady ? (preferredBlock ? `bloqueada del ${preferredBlock.fromDate} al ${preferredBlock.toDate} (${preferredBlock.reason})` : roomStateOf(notReady).cleanliness) : null;
    if (requestedRoomId && notReady) {
      throw conflict(`La habitación ${notReady.number} no está lista (${notReadyState}); elige otra o espera a pisos.`, {
        code: preferredBlock ? "ROOM_BLOCKED" : "ROOM_NOT_READY",
        roomId: notReady.id,
        roomNumber: notReady.number,
        etaReady: preferredBlock ? null : ((await deps.loadHousekeepingEta(notReady.id))?.toISOString() ?? null),
        ...(preferredBlock ? { blockId: preferredBlock.id, fromDate: preferredBlock.fromDate, toDate: preferredBlock.toDate, reason: preferredBlock.reason } : {})
      });
    }
    const suggestion = await deps.suggestForReservation({ context, reservationId: reservation.id, sessionId: session.id, persist: true });
    const candidateRooms = await deps.loadRooms(suggestion.candidates.map((candidate) => candidate.roomId));
    let ready: ArrivalRoomRow | undefined;
    for (const candidate of suggestion.candidates) {
      const candidateRoom = candidateRooms.find((row) => row.id === candidate.roomId);
      if (!candidateRoom || (reservation.roomTypeId && candidateRoom.roomTypeId !== reservation.roomTypeId)) continue;
      if (isRoomReady(candidateRoom, { ...readiness, roomBlock: await blockOf(candidateRoom.id) })) {
        ready = candidateRoom;
        break;
      }
    }
    if (!ready || !suggestion.persisted) {
      const etaReady = notReady && !preferredBlock ? await deps.loadHousekeepingEta(notReady.id) : null;
      const reason = notReady ? `Habitación ${notReady.number} ${notReadyState}; sin alternativa lista de la misma categoría` : "Sin habitación asignada ni alternativa lista de la misma categoría";
      await deps.updateSession(session.id, { status: "arrived", arrivedAt: session.arrivedAt ?? now, handoffKind: HANDOFF_ROOM_NOT_READY, handoffReason: reason, ...(input.actor === "kiosk" && input.verification?.kioskDeviceId ? { kioskDeviceId: input.verification.kioskDeviceId } : {}) });
      deps.recordAuditEvent({
        organizationId: session.organizationId,
        propertyId: reservation.propertyId,
        actorUserId: context.userId,
        actorType: input.actor === "user" ? "user" : "system",
        action: "CheckInHandedOff",
        entityType: "checkin_session",
        entityId: session.id,
        afterJson: { handoffKind: HANDOFF_ROOM_NOT_READY, reason, roomId: notReady?.id ?? null, etaReady: etaReady?.toISOString() ?? null, suggestionId: suggestion.persisted ? suggestion.id : null },
        deviceId: context.deviceId,
        correlationId
      });
      throw conflict(notReady ? `Tu habitación (${notReady.number}) aún no está lista${etaReady ? `: estará a las ${etaReady.toISOString()}` : ""}; te avisamos en cuanto pisos la termine.` : "No hay ninguna habitación lista de tu categoría; recepción te avisará.", {
        code: "ROOM_NOT_READY",
        roomId: notReady?.id ?? null,
        roomNumber: notReady?.number ?? null,
        etaReady: etaReady?.toISOString() ?? null,
        handoffKind: HANDOFF_ROOM_NOT_READY
      });
    }
    const confirmed = await deps.confirmSuggestion({ context, suggestionId: suggestion.id, roomId: ready.id, correlationId });
    room = ready;
    reassigned = Boolean(notReady) && notReady!.id !== ready.id;
    if (reassigned) warnings.push(`habitación ${notReady!.number} no lista (${notReadyState}): reasignada a la ${ready.number} (misma categoría)`);
    if (confirmed.reservation.assignedRoomId && confirmed.reservation.assignedRoomId !== ready.id) throw new ConflictError("La reasignación no dejó la habitación esperada; recarga y vuelve a intentarlo.");
  }

  // Ejecución (contexto de servicio o usuario).
  await deps.ensurePrimaryFolio({ context, reservationId: reservation.id, correlationId });
  await deps.checkInReservation({
    context,
    reservationId: reservation.id,
    roomId: room.id,
    signatureObjectKey,
    ...(allowEarly ? { allowEarlyCheckIn: true, overrideReason: input.overrideReason } : {}),
    correlationId
  });

  // Llave (sin certificado Apple sigue sin firmar y se dice).
  let key: ArrivalKey = null;
  try {
    const pass = await deps.issueWalletPass({ context, reservationId: reservation.id });
    key = { serialNumber: pass.serialNumber, qr: pass.mobileKey.qrPayload, validFrom: pass.validFrom, validUntil: pass.validUntil, wallet: { apple: { signedByApple: pass.signedByApple, pass: pass.appleWalletPass }, google: pass.googleWalletObject } };
    if (!pass.signedByApple) warnings.push("llave móvil sin firmar por Apple (sin certificado): vale el QR; recoge la tarjeta en recepción si la puerta no lo admite");
  } catch (error) {
    warnings.push(`llave móvil no emitida: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Perfiles Guest completados SOLO en los campos vacíos con lo capturado en el
  // viajero: la comunicación SES lee los perfiles de la reserva y un acompañante
  // con perfil parcial haría fallar todas las filas con GUEST_REGISTER_INVALID.
  const profilesFilled: Array<{ guestId: string; fields: string[] }> = [];
  for (const traveller of session.guests) {
    if (!traveller.guestId) continue;
    const profile = await deps.loadGuestProfile(traveller.guestId);
    if (!profile) continue;
    const patch = profileFillFromTraveller(profile, traveller);
    const fields = Object.keys(patch);
    if (fields.length === 0) continue;
    await deps.updateGuestProfile(profile.id, patch);
    profilesFilled.push({ guestId: profile.id, fields });
  }
  if (profilesFilled.length > 0) {
    deps.recordAuditEvent({
      organizationId: session.organizationId,
      propertyId: reservation.propertyId,
      actorUserId: context.userId,
      actorType: input.actor === "user" ? "user" : "system",
      action: "CheckInGuestProfileFilled",
      entityType: "checkin_session",
      entityId: session.id,
      // Solo los nombres de los campos completados, nunca sus valores.
      afterJson: { reservationId: reservation.id, profiles: profilesFilled },
      deviceId: context.deviceId,
      correlationId
    });
  }

  // SES: un encolado por parte; los 409 tipados se toleran como aviso.
  const ses: CompleteCheckInResult["ses"] = { status: "queued", submissions: [], warnings: [] };
  for (const record of records.values()) {
    try {
      const view = await deps.queueSesHospedajesSubmission({ context, guestRegisterRecordId: record.id, submissionType: "checkin", correlationId });
      ses.submissions.push({ guestRegisterRecordId: record.id, submissionId: view.id, status: view.status, code: null });
    } catch (error) {
      const code = is409WithCode(error, TOLERATED_SES_CODES) ? String((error.details as { code: string }).code) : null;
      const message = error instanceof Error ? error.message : String(error);
      ses.submissions.push({ guestRegisterRecordId: record.id, submissionId: null, status: "not_queued", code: code ?? "SES_QUEUE_FAILED" });
      ses.warnings.push(`parte ${record.id}: ${code ?? "error"} · ${message}`);
      if (!code) warnings.push(`SES no encolado para el parte ${record.id}: ${message}`);
    }
  }
  ses.status = ses.warnings.length === 0 ? "queued" : ses.submissions.some((item) => item.submissionId) ? "partial" : "warning";
  if (ses.status !== "queued") warnings.push(...ses.warnings.map((line) => `SES: ${line}`));

  // Bienvenida (W2-D, nunca rompe el check-in).
  const welcome = await deps.sendWelcomeMessage({
    context,
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    guestId: primary.guestId ?? "",
    roomNumber: room.number,
    channelOrder: policy.welcomeChannelOrder,
    correlationId
  });
  if (welcome.status !== "sent" && welcome.status !== "simulated") warnings.push(`bienvenida ${welcome.status}${welcome.error ? `: ${welcome.error}` : ""}`);

  // Sesión → checked_in; auditoría con CheckInSession.id.
  await deps.updateSession(session.id, {
    status: "checked_in",
    arrivedAt: session.arrivedAt ?? now,
    checkedInAt: now,
    ...(input.actor === "kiosk" && input.verification?.kioskDeviceId ? { kioskDeviceId: input.verification.kioskDeviceId } : {}),
    handoffKind: null,
    handoffReason: null
  });
  const action = input.actor === "user" ? AUDIT_ASSISTED_CHECKED_IN : AUDIT_SELF_CHECKED_IN;
  const summary = {
    reservationId: reservation.id,
    actor: input.actor,
    kioskDeviceId: input.actor === "kiosk" ? (input.verification?.kioskDeviceId ?? null) : null,
    identityMethod: verdict.method,
    roomId: room.id,
    roomNumber: room.number,
    reassigned,
    signatureObjectKey,
    keySerial: key?.serialNumber ?? null,
    ses: { status: ses.status, queued: ses.submissions.filter((item) => item.submissionId).length, total: ses.submissions.length },
    welcome: { status: welcome.status, channel: welcome.channel },
    warnings
  };
  deps.recordAuditEvent({
    organizationId: session.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: context.userId,
    actorType: input.actor === "user" ? "user" : "system",
    action,
    entityType: "checkin_session",
    entityId: session.id,
    beforeJson: { status: session.status },
    afterJson: { status: "checked_in", checkedInAt: now.toISOString(), ...summary },
    deviceId: context.deviceId,
    correlationId
  });
  deps.recordDomainEvent({
    organizationId: session.organizationId,
    propertyId: reservation.propertyId,
    entityType: "checkin_session",
    entityId: session.id,
    eventType: input.actor === "user" ? "CheckInCompletedAssisted" : "CheckInCompletedSelf",
    payload: { sessionId: session.id, checkedInAt: now.toISOString(), ...summary },
    actorType: input.actor === "user" ? "user" : "system",
    actorUserId: context.userId,
    correlationId
  });

  return {
    reservationId: reservation.id,
    sessionId: session.id,
    actor: input.actor,
    room: { id: room.id, number: room.number, floor: room.floor ?? null },
    reassigned,
    key,
    ses,
    welcome,
    checkedInAt: now.toISOString(),
    warnings
  };
}
