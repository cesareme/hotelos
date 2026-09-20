// Quick Check-in Drawer — flujo guiado de ≤ 90 segundos en una sola pantalla.
//
// Directriz ehotelOS (Nov 2026):
//   "Diseñar check-in/check-out de 90 segundos. Buscar reserva, validar
//    identidad, confirmar datos, ver alertas importantes, asignar habitación
//    limpia, cobrar saldo o depósito, firmar digitalmente, emitir llave, enviar
//    mensaje de bienvenida. Evitar saltos entre pantallas."
//
// Este drawer concentra todo el flujo en una sola vista deslizante:
//   1. Huésped + identidad + alertas (VIP, recurrente, peticiones)
//   2. Habitación asignada + estado HK (con sugerencia de cambio si no lista y
//      override con motivo si el recepcionista decide seguir: F18)
//   3. Folio + saldo + método de pago (cobrar saldo · cobrar depósito · sin cobro, U0b)
//   4. Compliance (parte viajeros SES) + firma
// Un único CTA que dice lo que hará («Cobrar 120,00 € y hacer check-in» /
// «Hacer check-in») ejecuta el runner compartido `checkinRunner.ts`:
//   - POST /reservations/:id/assign-room (si hay que reasignar)
//   - POST /folios/:id/payments (saldo o depósito; un fallo aborta)
//   - POST /reservations/:id/check-in (con `overrideReason` si la habitación
//     no está limpia; el API no exige limpieza y el motivo queda auditado)
//   - partes de viajeros + identidad verificada (best-effort)
//   - POST /properties/:id/ses/submissions → resultado leído de verdad
//     (Tanda 3 · cierre): «encolado» solo si queued > 0 y failed vacío; nunca
//     «enviado» en falso.
// Mostramos cronómetro: la directriz exige < 90 s.
//
// Cocoa 22 (ola 2 · lote 2-A): the panel is a `CocoaDrawer` (portal, scrim,
// focus trap, Esc, bottom sheet on phones); each step is a `CocoaSection`
// with a badge as meta; controls are `CocoaField` + `CocoaSelect` /
// `CocoaSegmentedControl`; notices are `CocoaCallout`.
//
// Tanda L5 (L5-A / L5-B4): «limpia» = housekeepingStatus ∈ {clean, inspected};
// paso 4 lista los partes reales de la reserva con «Principal» / «Menor»;
// casilla opcional «Identidad verificada en mostrador» (guest_register.edit).
//
// Tanda UX-1 · lote U6 (docs/design/UX-RECEPCION-FEEL.md §5.2, §6.2, F18, F23,
// F24, D8): apertura en UNA ronda — reserva ∥ folio ∥ rooms ∥ room-types por
// la caché compartida de `useApiData` (catálogos 5 min, reserva y folio 30 s;
// si la fila de Mi día hizo prefetch, el cajón abre ya con datos) y cronología
// del huésped + partes al llegar la reserva; esqueleto espejo de 4 secciones
// tras 300 ms; el cuerpo es un `<form>` (Intro confirma); foco inicial en la
// sección incompleta (habitación → pago → CTA); la sugerencia de habitación
// nunca es una ocupada (F24); al éxito, la fila de Mi día se reconcilia con la
// reserva que devuelve el API y el cajón se cierra al instante con un toast
// que dice qué pasó («Check-in de la 204 hecho · parte enviado a SES (1)»).
// Sin la palabra «preautorizar» (D8).
//
// Tanda CHK · lote W4-A (docs/design/CHECKIN-AUTOMATIZADO-IA.md §8 «Drawer de
// check-in», D12: montado ENCIMA del runner y del cajón de UX-1, sin reescribir
// el <form>, la acción contextual ni el cobro). Con sesión de check-in en línea
// (GET /reservations/:id/check-in, services/checkinApi.ts):
//   · paso 1: «Escanear documento» (CocoaFileInput → POST …/check-in/scan) o
//     «Pegar MRZ» (mismo endpoint con mrzLines) → campos con origen (MRZ / IA /
//     Manual) y confianza; viajeros de la sesión con estado (documento · firma ·
//     cotejo) y chip «Menor»;
//   · paso 2: top-3 del motor (§4b) con motivos en CocoaPopover, «Confirmar»
//     (POST /assignment-suggestions/:id/confirm, decisión auditada) u «Otra…»
//     (el selector de candidatas limpias de siempre); isRoomClean y el override
//     F18 se conservan;
//   · paso 4: «Firmado en el portal el dd/mm HH:MM» si el titular ya firmó; si
//     no, CocoaSheet con SignaturePad → POST …/check-in/signature
//     (touch_reception); «Identidad cotejada» → POST …/verify-identity
//     (visual_reception), solo con guest_register.edit (canDo(useNavGate()));
//   · CTA: el runner recibe `completeCheckIn` → POST …/check-in/complete (sin
//     sello sig_*); el resultado trae habitación, llave móvil, SES y avisos.
//     Un 409 ROOM_NOT_READY se muestra con la hora prevista de pisos y ofrece
//     «Buscar alternativa» (nueva sugerencia del motor).
// Sin sesión (o con el override de limpieza activo, que POST …/complete no
// admite) el cajón sigue por el check-in clásico. Presupuesto de `style=`: 4
// (sin cambios); lógica pura exportada para __tests__/checkin-drawer.test.mts.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { AssignmentCandidate, AssignmentSuggestionDto, DocumentCaptureSource } from "@hotelos/shared";
import { useToast } from "../../components/Toast";
import { ApiError, apiRequest } from "../../services/api-client";
import { getUser } from "../../services/auth-storage";
import { getActivePropertyId } from "../../services/activeProperty";
import { invalidateApi, useApiData } from "../../hooks/useApiData";
import { postFolioPayment } from "../../services/pmsCommerceApi";
import { newClientRequestId } from "../../services/finance-contracts";
import {
  QUICK_CHECKIN_METHOD_OPTIONS,
  QUICK_CHECKIN_PAYMENT_MODE_LABELS,
  defaultQuickCheckinPaymentMode,
  resolveQuickCheckinAmount,
  readStoredCheckinAttempt,
  storeCheckinAttempt,
  type QuickCheckinMethodOption,
  type QuickCheckinPaymentAttempt,
  type QuickCheckinPaymentMode
} from "./quickCheckinPayment";
import { CheckinRunError, isOverrideReasonValid, overrideReasonFor, progressLabel, runCheckin, type CheckedInReservation, type CheckinProgress } from "./checkinRunner";
import {
  applyMrz,
  completeCheckIn,
  precheckCheckIn,
  confirmSuggestion,
  createSuggestion,
  getCheckInSession,
  getSuggestions,
  isCheckInSessionMissing,
  normalizeMrzInput,
  scanDocument,
  signAtReception,
  verifyIdentity as verifyCheckInIdentity,
  type ArrivalKey,
  type AssignmentSuggestionDetail,
  type IdentityCaptureFieldKey,
  type IdentityCaptureResult,
  type ReservationCheckInGuest,
  type ReservationCheckInView,
  type RoomNotReadyDetails
} from "../../services/checkinApi";
import { SignaturePad, type SignatureOutput } from "../../components/cocoa-extras/SignaturePad";
import { canDo } from "../accounting/accounting-ui";
import { useNavGate } from "../../navigation/useEnabledModules";
import {
  guestRegisterIssueLabel,
  queueSesSubmissions,
  sesEstablishmentIssueLabel,
  sesFailureMessages,
  sesQueueOutcomeFromError,
  sesQueueOutcomeFromResponse,
  type SesQueueOutcome
} from "../../services/complianceApi";
import {
  guestRegisterStatusLabel,
  listReservationGuestRegisterRecords,
  markGuestRegisterIdentityVerified,
  type GuestRegisterRecord
} from "../../services/guestRegisterApi";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { navigateTo } from "../../lib/navigate";
import { urlForScreen } from "../../navigation/nav-tree";
import { reservationStatusLabel, roomOptionLabel } from "./frontdesk-labels";
import { roomStatus } from "../../content/status-dictionary";
import { DEFAULT_CURRENCY, date, dateTime, money, plural, time } from "../../lib/format";
import { ACTIONS, FRONT_DESK_ACTIONS, FRONT_DESK_NOTES, FRONT_DESK_TOASTS, STATUS_LABELS } from "../../content/actions";
import { ChatBubbleIcon, ClockIcon, InfoCircleIcon, StarIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaInput,
  CocoaPopover,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSheet,
  CocoaSkeleton,
  CocoaState,
  CocoaStatusBadge,
  CocoaSwitch,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";

// =============================================================== shapes

type Reservation = {
  id: string;
  propertyId: string;
  code: string;
  channel: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  roomTypeId: string;
  assignedRoomId?: string;
  ratePlanId?: string;
  boardType?: string;
  specialRequests?: string;
  notes?: string;
  cancellationPolicyCode?: string;
  totalAmount: number;
  /** Depósito de la política comercial (GET /reservations/:id lo devuelve; ausente = sin depósito). */
  depositAmount?: number | null;
  currency: string;
  primaryGuest?: Guest | null;
};

type Guest = {
  id: string;
  firstName: string;
  surname1?: string;
  surname2?: string;
  documentType?: string;
  documentNumber?: string;
  email?: string;
  phone?: string;
  nationality?: string;
  vipCode?: string;
  loyaltyTier?: string;
  loyaltyNumber?: string;
};

type Room = {
  id: string;
  number: string;
  floor?: string;
  status: string;
  housekeepingStatus?: string;
  roomTypeId: string;
  sellable?: boolean;
};

type RoomType = { id: string; name: string };

// Only what the check-in reads from GET /guests/:id/timeline (guest 360).
type GuestTimelineLite = { metrics?: { totalStays?: number } };

type FolioBalance = {
  folio: { id: string; status: string; currency: string };
  lines: Array<{ id: string; type: string; description: string; total: number }>;
  payments: Array<{ id: string; amount: number; method: string; status: string }>;
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

export type QuickCheckInCompleted = {
  reservationId: string;
  elapsedSeconds: number;
  /** Reserva que devuelve POST check-in (estado `checked_in` + habitación): para reconciliar la fila sin recargar. */
  reservation: CheckedInReservation | null;
  roomNumber: string | null;
  ses: SesQueueOutcome;
  /** Tanda CHK: llave móvil emitida por POST …/check-in/complete (null en el check-in clásico o si no se emitió). */
  key?: ArrivalKey;
  /** Avisos del check-in completo (llave sin firmar por Apple, reasignación, SES parcial…). */
  warnings?: string[];
};

export type QuickCheckInProps = {
  reservationId: string;
  onClose: () => void;
  onCompleted?: (info: QuickCheckInCompleted) => void;
  /** L-17: se dispara al pulsar el CTA, antes del runner (Mi día pinta la fila «En el hotel» al instante). */
  onSubmitted?: (info: { reservationId: string; roomId: string | null; roomNumber: string | null }) => void;
  /** L-17: el runner falló (cobro, 409 de fecha o saldo…): Mi día revalida y la fila vuelve a su estado. */
  onFailed?: (reservationId: string) => void;
  /** Habitación candidata que propone Mi día (R14: la del motor si la hay); si no, la primera limpia y libre del tipo. */
  initialRoomId?: string | null;
};

// U0b · D8: «Cobrar saldo» · «Cobrar depósito» · «Sin cobro»; ninguna garantía
// que el contrato PSP no ofrece. Modos, métodos y cuerpo del cobro viven en
// quickCheckinPayment.ts: solo métodos que el API captura en la misma llamada.
type PaymentMode = QuickCheckinPaymentMode;
type PaymentMethod = QuickCheckinMethodOption;

const PAYMENT_METHOD_OPTIONS = QUICK_CHECKIN_METHOD_OPTIONS;
const CATALOG_STALE_MS = 5 * 60_000;
const RESERVATION_STALE_MS = 30_000;

// =============================================================== utils

function fmtEur(value: number | undefined | null): string {
  return money(value);
}

function fmtName(g: Guest | null | undefined): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1, g.surname2].filter(Boolean).join(" ").trim() || "Huésped";
}

function nightsBetween(arrival: string, departure: string): number {
  const a = new Date(arrival).getTime();
  const d = new Date(departure).getTime();
  return Math.max(0, Math.round((d - a) / 86400000));
}

function elapsedText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function issueLabels(issues: string[]): string {
  return issues.map(guestRegisterIssueLabel).join(", ");
}

/** «limpia» per the closed vocabulary of Tanda L5-A: housekeepingStatus clean | inspected, nothing else. */
export function isRoomClean(room: Pick<Room, "housekeepingStatus">): boolean {
  const hk = (room.housekeepingStatus ?? "").trim().toLowerCase();
  return hk === "clean" || hk === "inspected";
}

/** Libre para asignar: vendible y ni ocupada ni bloqueada ni fuera de servicio (F24: la caché de rooms trae `status`). */
export function isRoomFree(room: Pick<Room, "status" | "sellable">): boolean {
  if (room.sellable === false) return false;
  const status = (room.status ?? "").trim().toLowerCase();
  return status !== "occupied" && status !== "blocked" && status !== "out_of_order" && status !== "ooo" && status !== "out_of_service";
}

/** Candidatas: limpias y libres del tipo de la reserva, por número; la asignada actual siempre cuenta. */
export function candidateRoomsFor(rooms: readonly Room[], roomTypeId: string, assignedRoomId?: string | null): Room[] {
  return rooms
    .filter((room) => room.id === assignedRoomId || (room.roomTypeId === roomTypeId && isRoomFree(room) && isRoomClean(room)))
    .sort((a, b) => a.number.localeCompare(b.number, "es", { numeric: true }));
}

/** Habitación con la que abre el cajón: la asignada, la que propone Mi día (si sigue limpia y libre) o la primera candidata. */
export function initialRoomFor(reservation: Pick<Reservation, "assignedRoomId" | "roomTypeId">, rooms: readonly Room[], initialRoomId?: string | null): string | undefined {
  if (reservation.assignedRoomId) return reservation.assignedRoomId;
  const proposed = initialRoomId ? rooms.find((room) => room.id === initialRoomId) : undefined;
  if (proposed && proposed.roomTypeId === reservation.roomTypeId && isRoomFree(proposed) && isRoomClean(proposed)) return proposed.id;
  return candidateRoomsFor(rooms, reservation.roomTypeId)[0]?.id;
}

// ---------------------------------------------------------------- Tanda CHK · lógica pura del cajón
// (sin React ni red; la ejecuta node --test en __tests__/checkin-drawer.test.mts)

/** Origen de un campo leído del documento (CocoaBadge): MRZ (lector o visión sobre la banda), IA (visión del anverso) o Manual. */
export function fieldOriginLabel(source: DocumentCaptureSource | string | null | undefined): { label: "MRZ" | "IA" | "Manual"; tone: CocoaTone } {
  switch (source) {
    case "mrz_reader":
    case "mrz_ai":
      return { label: "MRZ", tone: "success" };
    case "ai_vision":
      return { label: "IA", tone: "info" };
    default:
      return { label: "Manual", tone: "neutral" };
  }
}

/** «98 %» de una confianza 0..1; «—» sin dato. */
export function confidenceLabel(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)} %`;
}

/** «···321»: el cajón nunca pinta el número completo (mismo contrato que documentNumberLast3 de la vista). */
export function maskDocumentNumber(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "—";
  return `···${text.slice(-3)}`;
}

/** «Dígitos de control 4/4» (solo los aplicables; «—» si ninguno aplica). */
export function mrzChecksLabel(checks: { document: boolean | null; birth: boolean | null; expiry: boolean | null; composite: boolean | null } | null | undefined): string {
  if (!checks) return "—";
  const values = [checks.document, checks.birth, checks.expiry, checks.composite].filter((value): value is boolean => typeof value === "boolean");
  if (values.length === 0) return "—";
  return `Dígitos de control ${values.filter(Boolean).length}/${values.length}`;
}

export type TravellerStatus = { document: boolean; signature: boolean; verified: boolean; label: string; tone: CocoaTone };

/** Estado de un viajero de la sesión (documento leído · firmado · identidad cotejada) en una frase con su tono. */
export function travellerStatusLabel(guest: Pick<ReservationCheckInGuest, "status" | "isMinor" | "identityVerifiedAt" | "captures" | "signatures">): TravellerStatus {
  const document = guest.captures.length > 0 || guest.status === "document_captured" || guest.status === "data_complete" || guest.status === "signed" || guest.status === "verified";
  const signature = guest.signatures.length > 0 || guest.status === "signed" || guest.status === "verified";
  const verified = Boolean(guest.identityVerifiedAt);
  if (guest.isMinor) return { document, signature: true, verified, label: document ? "Menor · datos del adulto" : "Menor · sin datos", tone: document ? "info" : "warning" };
  if (signature && verified) return { document, signature, verified, label: "Firmado y cotejado", tone: "success" };
  if (signature) return { document, signature, verified, label: "Firmado · sin cotejar", tone: "info" };
  if (document) return { document, signature, verified, label: "Documento leído · sin firma", tone: "warning" };
  return { document, signature, verified, label: "Sin documento", tone: "warning" };
}

/** Top-3 del motor (§4b) sobre el catálogo de la reserva: la asignada si la hay; si no, la primera candidata limpia, libre y del tipo; undefined si ninguna vale ahora mismo. */
export function pickSuggestionRoom(candidates: readonly Pick<AssignmentCandidate, "roomId">[], rooms: readonly Room[], roomTypeId: string, assignedRoomId?: string | null): string | undefined {
  if (assignedRoomId) return assignedRoomId;
  for (const candidate of candidates.slice(0, 3)) {
    const room = rooms.find((row) => row.id === candidate.roomId);
    if (room && room.roomTypeId === roomTypeId && isRoomFree(room) && isRoomClean(room)) return room.id;
  }
  return undefined;
}

export type SignatureState = { kind: "portal" | "kiosk" | "reception" | "paper" | "pending" | "not_required"; signedAt: string | null; label: string };

const SIGNATURE_PLACE: Readonly<Record<string, { kind: SignatureState["kind"]; place: string }>> = Object.freeze({
  touch_portal: { kind: "portal", place: "el portal" },
  touch_kiosk: { kind: "kiosk", place: "el kiosco" },
  touch_reception: { kind: "reception", place: "recepción" },
  paper_scanned: { kind: "paper", place: "papel" }
});

/** «dd/mm HH:MM» de un instante ISO (fecha corta sin año + hora de Madrid). */
export function shortDateTime(iso: string): string {
  return `${date(iso, "short").slice(0, 5)} ${time(iso)}`;
}

/** Firma del titular tal y como la ve recepción: dónde firmó (portal, kiosco, mostrador, papel) y cuándo, o pendiente; los menores no firman. */
export function signatureStateOf(guest: Pick<ReservationCheckInGuest, "isMinor" | "signatures"> | null | undefined): SignatureState {
  if (!guest) return { kind: "pending", signedAt: null, label: "Sin viajero en la sesión: la firma se recoge en el registro de viajeros." };
  if (guest.isMinor) return { kind: "not_required", signedAt: null, label: "Menor de 14 años: no firma (lo declara el adulto)." };
  const last = [...guest.signatures].sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0];
  if (!last) return { kind: "pending", signedAt: null, label: "Pendiente de firma." };
  const place = SIGNATURE_PLACE[last.method] ?? { kind: "reception" as const, place: "recepción" };
  return { kind: place.kind, signedAt: last.signedAt, label: `Firmado en ${place.place} el ${shortDateTime(last.signedAt)}` };
}

/** Estados de sesión en los que el huésped cerró el pre-check-in: el check-in completo tiene partes y firmas del portal. */
const COMPLETE_PATH_STATUSES: ReadonlySet<string> = new Set(["ready_for_arrival", "arrived"]);

/**
 * Camino del CTA: «complete» (POST …/check-in/complete, Tanda CHK) solo con
 * sesión en línea, sin override de limpieza — ese endpoint no admite una
 * habitación sin limpiar (409 ROOM_NOT_READY); con override el check-in
 * clásico sigue auditando el motivo (F18) — y, corrector REV3-04, cuando la
 * sesión está cerrada por el huésped (ready_for_arrival · arrived) o el
 * titular ya firmó en el mostrador (`signed`); una sesión invited /
 * in_progress / handed_off sin firma va por el check-in clásico en vez de
 * estrellarse contra 409 GUEST_REGISTER_INCOMPLETE.
 */
export function checkinPathFor(input: { hasSession: boolean; overrideActive: boolean; sessionStatus?: string | null; signed?: boolean }): "complete" | "legacy" {
  if (!input.hasSession || input.overrideActive) return "legacy";
  if (input.sessionStatus === undefined && input.signed === undefined) return "complete";
  return (input.sessionStatus && COMPLETE_PATH_STATUSES.has(input.sessionStatus)) || input.signed === true ? "complete" : "legacy";
}

/** Mensaje de mostrador del 409 ROOM_NOT_READY con la hora prevista de pisos (`etaReady`). */
export function roomNotReadyMessage(details: Pick<RoomNotReadyDetails, "roomNumber" | "etaReady"> | null | undefined, fallback: string): string {
  if (!details) return fallback;
  const room = details.roomNumber ? `La ${details.roomNumber}` : "La habitación";
  const eta = details.etaReady ? ` Pisos prevé tenerla lista a las ${time(details.etaReady)}.` : " Pisos no ha dado hora prevista.";
  return `${room} no está lista.${eta} Busca una alternativa limpia del mismo tipo o espera a pisos.`;
}

const SESSION_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  invited: "Invitado",
  in_progress: "En curso",
  ready_for_arrival: "Listo para llegar",
  arrived: "Ha llegado",
  checked_in: "Alojado",
  handed_off: "Pasado a recepción",
  expired: "Caducado",
  cancelled: "Cancelado"
});

/** Estado de la sesión de check-in en línea en español. */
export function sessionStatusLabel(status: string): string {
  return SESSION_STATUS_LABELS[status] ?? status;
}

const VERIFICATION_METHOD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  visual_reception: "cotejo visual",
  mrz_checksum: "MRZ",
  otp_phone: "OTP móvil",
  otp_email: "OTP correo",
  payment_match: "pago",
  midni_qr: "MiDNI",
  reader_hardware: "lector"
});

function verificationMethodLabel(method: string | null | undefined): string {
  return method ? (VERIFICATION_METHOD_LABELS[method] ?? method) : "—";
}

function travellerName(guest: Pick<ReservationCheckInGuest, "firstName" | "surname1" | "surname2" | "ordinal"> | null | undefined): string {
  if (!guest) return "Viajero";
  return [guest.firstName, guest.surname1, guest.surname2].filter(Boolean).join(" ").trim() || `Viajero ${guest.ordinal + 1}`;
}

/** Imagen del escáner: el API acota el decodificado (CHECKIN_DOCUMENT_MAX_BYTES, 6 MiB) y el cuerpo (8 MB). */
const SCAN_MAX_BYTES = 6 * 1024 * 1024;

const CAPTURE_FIELD_LABELS: ReadonlyArray<readonly [IdentityCaptureFieldKey, string]> = [
  ["documentType", "Tipo de documento"],
  ["documentNumber", "Número"],
  ["documentSupportNumber", "Soporte"],
  ["firstName", "Nombre"],
  ["surname1", "Primer apellido"],
  ["surname2", "Segundo apellido"],
  ["nationality", "Nacionalidad"],
  ["sex", "Sexo"],
  ["dateOfBirth", "Nacimiento"],
  ["documentExpiryDate", "Caducidad"],
  ["issuingCountry", "País emisor"]
];

/** F3: la ficha de la reserva con su id (`/recepcion/reservas/:id`), nunca la lista. */
function openReservationDetail(reservationId: string): void {
  const url = urlForScreen("ReservationDetailWorkspace", { id: reservationId });
  if (url) openTabPath(url);
  else navigateTo("ReservationDetailWorkspace");
}

// Legacy named styles (pre-U6) kept only where no utility class exists; the
// secondary prose now uses `.cocoa-note`. Layout comes from `cocoa-stack` /
// `cocoa-row` and `c22-section__list`.
const nameStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)"
};

const bulletListStyle: CSSProperties = { margin: 0, paddingLeft: "var(--cocoa-space-5)" };

// Mirror skeleton of the four steps (§5.2 (3)).
function CheckInSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={96} />
      <CocoaSkeleton variant="card" height={88} />
      <CocoaSkeleton variant="card" height={140} />
      <CocoaSkeleton variant="card" height={96} />
    </div>
  );
}

// =============================================================== component

export function QuickCheckInDrawer({ reservationId, onClose, onCompleted, onSubmitted, onFailed, initialRoomId }: QuickCheckInProps) {
  const { showToast } = useToast();
  const roomSelectId = useId();
  const paymentMethodId = useId();
  const overrideReasonId = useId();
  const submitId = useId();
  const formId = useId();
  const activePropertyId = getActivePropertyId();

  // One round (§6.2): reservation ∥ folio ∥ rooms ∥ room-types, every one from the shared cache.
  const reservationState = useApiData<Reservation>(`/reservations/${reservationId}`, { staleTime: RESERVATION_STALE_MS });
  const folioState = useApiData<FolioBalance>(`/reservations/${reservationId}/folio`, { staleTime: RESERVATION_STALE_MS });
  const reservation = reservationState.data;
  const propertyId = reservation?.propertyId ?? activePropertyId;
  const roomsState = useApiData<Room[]>(`/properties/${propertyId}/rooms`, { staleTime: CATALOG_STALE_MS });
  const roomTypesState = useApiData<RoomType[]>(`/properties/${propertyId}/room-types`, { staleTime: CATALOG_STALE_MS });
  const guest = reservation?.primaryGuest ?? null;
  const timelineState = useApiData<GuestTimelineLite>(guest?.id ? `/guests/${guest.id}/timeline` : null, { staleTime: CATALOG_STALE_MS });

  const folio = folioState.data;
  const folioError = folioState.error;
  const folioLoading = folioState.loading || (folioState.isValidating && !folio);
  const availableRooms = useMemo(() => roomsState.data ?? [], [roomsState.data]);
  const roomType = useMemo(() => (reservation ? roomTypesState.data?.find((t) => t.id === reservation.roomTypeId) ?? null : null), [reservation, roomTypesState.data]);
  const priorStays = Math.max(0, Math.floor(timelineState.data?.metrics?.totalStays ?? 0));

  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);
  const roomInitialised = useRef(false);
  // U0b · F19: por defecto «Cobrar saldo»; al cargar el folio pasa a «Sin cobro»
  // si ya está saldado (defaultQuickCheckinPaymentMode).
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("balance");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  // Clave de idempotencia del intento de cobro en curso (U0b): se conserva entre
  // renders para que un reintento del mismo cobro repita en vez de cobrar dos veces.
  const paymentAttempt = useRef<QuickCheckinPaymentAttempt | null>(null);
  // F18 · override de limpieza con motivo (auditado en el check-in).
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CheckinProgress | null>(null);
  // Tras un check-in, la reserva y el folio de la caché caducan al cerrar (ver executeCheckIn).
  const staleOnClose = useRef(false);
  const close = useCallback(() => {
    if (staleOnClose.current) {
      staleOnClose.current = false;
      invalidateApi(`/reservations/${reservationId}`);
    }
    onClose();
  }, [onClose, reservationId]);
  const [completed, setCompleted] = useState<{ elapsedSeconds: number } | null>(null);
  // Real result of the SES queue call after the check-in (null until then).
  const [sesOutcome, setSesOutcome] = useState<SesQueueOutcome | null>(null);
  // Partes de viajeros of the reservation (real rows; empty until the check-in
  // creates one per guest unless a scan / the guest portal prepared them).
  const [partes, setPartes] = useState<GuestRegisterRecord[]>([]);
  const [partesError, setPartesError] = useState<string | null>(null);
  // Optional desk verification of the travellers' documents (guest_register.edit).
  const [verifyIdentity, setVerifyIdentity] = useState(false);
  const [identityNotice, setIdentityNotice] = useState<string | null>(null);

  // Tanda CHK · W4-A: sesión de check-in en línea (null = sin sesión → check-in
  // clásico), lectura del documento, top-3 del motor, firma en el pad y cotejo.
  // La vista se relee de GET /reservations/:id/check-in tras cada escritura.
  const navGate = useNavGate();
  const canVerifyAtDesk = canDo(navGate, "guest_register.edit");
  const mrzFieldId = useId();
  const [checkInSession, setCheckInSession] = useState<ReservationCheckInView | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [capture, setCapture] = useState<IdentityCaptureResult | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanFileName, setScanFileName] = useState<string | null>(null);
  const [mrzOpen, setMrzOpen] = useState(false);
  const [mrzText, setMrzText] = useState("");
  const [scanTargetId, setScanTargetId] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<AssignmentSuggestionDetail | AssignmentSuggestionDto | null>(null);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [reasonsFor, setReasonsFor] = useState<{ roomId: string; anchor: HTMLElement } | null>(null);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  // Habitación confirmada desde la sugerencia (el API ya la asignó): el runner no la reasigna.
  const [confirmedRoomId, setConfirmedRoomId] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [signBusy, setSignBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [notReady, setNotReady] = useState<RoomNotReadyDetails | null>(null);
  const [completionKey, setCompletionKey] = useState<ArrivalKey>(null);
  const [completionWarnings, setCompletionWarnings] = useState<string[]>([]);

  // Cronómetro — empieza al abrir, congela al completar.
  const [tick, setTick] = useState(0);
  const startedAt = useMemo(() => Date.now(), []);
  useEffect(() => {
    logBreadcrumb("checkin.opened", "ui", { reservationId });
    // Corrector REV3-03: un cobro registrado en una apertura anterior del cajón (check-in completo
    // fallido después) conserva su clave de idempotencia; reabrir el cajón no vuelve a cobrar.
    paymentAttempt.current = readStoredCheckinAttempt(reservationId);
    // El efecto se ejecuta una sola vez al montar; reservationId es estable
    // durante la vida del drawer (cambiar reserva implica reabrirlo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (completed) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [completed]);
  void tick;
  const elapsedSeconds = completed ? completed.elapsedSeconds : Math.floor((Date.now() - startedAt) / 1000);
  const elapsedLabel = elapsedText(elapsedSeconds);
  const timerTone: CocoaTone = elapsedSeconds < 90 ? "success" : elapsedSeconds < 120 ? "warning" : "danger";

  // Partes de viajeros: best-effort (GET needs guest_register.read; a failure is
  // shown in step 4, never as a fake «sin partes»). Returns the fresh list so
  // the runner can act on it without waiting for React state.
  const loadPartes = useCallback(async (): Promise<GuestRegisterRecord[]> => {
    try {
      const rows = await listReservationGuestRegisterRecords(reservationId, { retries: 0 });
      setPartes(rows);
      setPartesError(null);
      return rows;
    } catch (err) {
      setPartesError(err instanceof Error ? err.message : "No se pudieron cargar los partes de viajeros.");
      return [];
    }
  }, [reservationId]);

  // Second round only once the reservation is here: partes (the timeline is a hook above).
  useEffect(() => {
    if (!reservation) return;
    void loadPartes();
  }, [reservation?.id, loadPartes, reservation]);

  // Room with which the drawer opens (assigned → proposed by Mi día → first clean and free of the type).
  useEffect(() => {
    if (roomInitialised.current || !reservation || !roomsState.data) return;
    roomInitialised.current = true;
    setSelectedRoomId(initialRoomFor(reservation, roomsState.data, initialRoomId));
  }, [reservation, roomsState.data, initialRoomId]);

  // U0b · F19: el modo por defecto depende del saldo real del folio (no del
  // total de la reserva): «Cobrar saldo» si hay saldo, «Sin cobro» si está saldado.
  const folioModeApplied = useRef(false);
  useEffect(() => {
    if (!folio || folioModeApplied.current) return;
    folioModeApplied.current = true;
    setPaymentMode(defaultQuickCheckinPaymentMode(folio.balanceDue));
  }, [folio]);

  // ------------------------------------------------------------- derived

  const selectedRoom = useMemo(() => (selectedRoomId ? availableRooms.find((r) => r.id === selectedRoomId) : undefined), [selectedRoomId, availableRooms]);

  // Tanda L5-A: «limpia» is the closed housekeeping vocabulary only (clean |
  // inspected). `status` is occupancy (occupied / out_of_order…) and «ready»
  // no longer exists as a persisted value: neither is a cleanliness signal.
  const roomIsClean = useMemo(() => (selectedRoom ? isRoomClean(selectedRoom) : false), [selectedRoom]);

  const candidateRooms = useMemo(() => (reservation ? candidateRoomsFor(availableRooms, reservation.roomTypeId, reservation.assignedRoomId).filter((room) => isRoomClean(room) && isRoomFree(room)) : []), [availableRooms, reservation]);

  // Identity verification at the desk needs guest_register.edit; a session
  // without a permission list (demo mode) still offers it, as the layout does
  // for the readiness banner (BackOfficeLayout · SetupPendingBanner).
  const canVerifyIdentity = useMemo(() => {
    const user = getUser();
    return !user?.permissions || user.permissions.includes("guest_register.edit");
  }, []);

  // Options of the room select: "Sin asignar" is a real choice (the legacy
  // select offered it), then the clean and free rooms of the same type, then
  // the room currently selected when it is not clean (so the control never loses it).
  const roomOptions = useMemo(() => {
    const options = [{ value: "", label: "Sin asignar" }];
    for (const r of candidateRooms) options.push({ value: r.id, label: roomOptionLabel(r, roomStatus(r.housekeepingStatus).label) });
    if (selectedRoom && !candidateRooms.some((c) => c.id === selectedRoom.id)) {
      options.push({ value: selectedRoom.id, label: roomOptionLabel(selectedRoom, roomStatus(selectedRoom.housekeepingStatus).label) });
    }
    return options;
  }, [candidateRooms, selectedRoom]);

  // null = unknown (folio not loaded). The reservation total is NOT a balance:
  // it ignores deposits already captured, so it is never used as a fallback.
  const balanceDue: number | null = folio ? folio.balanceDue : null;
  // U0b · F19: importe según el modo — saldo del folio o lo que falte del
  // depósito de la política (`depositAmount`), nunca `totalAmount`. null = nada que cobrar.
  const depositAmount = reservation?.depositAmount ?? null;
  const amountToCollect: number | null = folio ? resolveQuickCheckinAmount(paymentMode, { balanceDue: folio.balanceDue, paymentsTotal: folio.paymentsTotal, depositAmount }) : null;
  const canCollectDeposit = folio ? resolveQuickCheckinAmount("deposit", { balanceDue: folio.balanceDue, paymentsTotal: folio.paymentsTotal, depositAmount }) !== null : false;
  const paymentRequiresFolio = paymentMode !== "none";
  const overrideReady = overrideEnabled && isOverrideReasonValid(overrideReason);
  const currency = reservation?.currency || DEFAULT_CURRENCY;

  // ------------------------------------------------------------- Tanda CHK · sesión, lectura, motor, firma y cotejo
  const messageOf = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

  const loadSession = useCallback(async (): Promise<ReservationCheckInView | null> => {
    try {
      const view = await getCheckInSession(reservationId);
      setCheckInSession(view);
      setSessionError(null);
      return view;
    } catch (err) {
      if (isCheckInSessionMissing(err)) {
        setCheckInSession(null);
        setSessionError(null);
      } else {
        setSessionError(messageOf(err, "No se pudo leer la sesión de check-in en línea."));
      }
      return null;
    } finally {
      setSessionLoaded(true);
    }
  }, [reservationId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const sessionGuests = useMemo(() => checkInSession?.guests ?? [], [checkInSession]);
  const primaryTraveller = useMemo(() => sessionGuests.find((row) => row.isPrimary) ?? sessionGuests[0] ?? null, [sessionGuests]);
  const scanTarget = useMemo(() => sessionGuests.find((row) => row.id === scanTargetId) ?? primaryTraveller, [sessionGuests, scanTargetId, primaryTraveller]);
  const primarySignature = useMemo(() => signatureStateOf(primaryTraveller), [primaryTraveller]);
  const checkinPath = checkinPathFor({
    hasSession: Boolean(checkInSession),
    overrideActive: !roomIsClean && overrideReady,
    sessionStatus: checkInSession?.status ?? null,
    signed: primarySignature.kind !== "pending" && primarySignature.kind !== "not_required"
  });

  // Top-3 del motor: la sugerencia vigente (o la última decidida, para ver los
  // motivos de la habitación ya asignada) y, sin habitación ni sugerencia, una
  // nueva persistida.
  const suggestionRequested = useRef(false);
  useEffect(() => {
    if (suggestionRequested.current || !reservation || !sessionLoaded || reservation.status !== "confirmed") return;
    suggestionRequested.current = true;
    let cancelled = false;
    (async () => {
      setSuggestionBusy(true);
      try {
        const list = await getSuggestions(reservation.id);
        const current = list.current ?? (reservation.assignedRoomId ? (list.history[0] ?? null) : await createSuggestion(reservation.id, checkInSession?.id ?? null));
        if (!cancelled) setSuggestion(current);
      } catch (err) {
        if (!cancelled) setSuggestionError(messageOf(err, "El motor de asignación no respondió."));
      } finally {
        if (!cancelled) setSuggestionBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservation, sessionLoaded, checkInSession?.id]);

  const topCandidates = useMemo(() => (suggestion ? suggestion.candidates.slice(0, 3) : []), [suggestion]);

  // Sin habitación inicial, la top-1 limpia y libre pasa a ser la elegida (una sola vez).
  const suggestionApplied = useRef(false);
  useEffect(() => {
    if (suggestionApplied.current || !suggestion || !reservation || !roomInitialised.current) return;
    suggestionApplied.current = true;
    if (selectedRoomId) return;
    const picked = pickSuggestionRoom(suggestion.candidates, availableRooms, reservation.roomTypeId, reservation.assignedRoomId);
    if (picked) setSelectedRoomId(picked);
  }, [suggestion, reservation, availableRooms, selectedRoomId]);

  async function runCapture(run: () => Promise<IdentityCaptureResult>): Promise<void> {
    setScanBusy(true);
    setCaptureError(null);
    try {
      const result = await run();
      setCapture(result);
      logBreadcrumb("checkin.scan", "mutation", { reservationId, source: result.source, persisted: result.persisted, needsReview: result.needsReview.length });
      await loadSession();
      if (!result.persisted) showToast("Documento leído, pero sin viajero de la sesión al que vincularlo.", { variant: "warning" });
    } catch (err) {
      setCaptureError(messageOf(err, "No se pudo leer el documento."));
    } finally {
      setScanBusy(false);
    }
  }

  function onScanFile(file: File): void {
    setScanFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        setCaptureError("No se pudo leer el fichero de imagen.");
        return;
      }
      void runCapture(() => scanDocument(reservationId, dataUrl, scanTarget?.id ?? null));
    };
    reader.onerror = () => setCaptureError("No se pudo leer el fichero de imagen.");
    reader.readAsDataURL(file);
  }

  const mrzLines = normalizeMrzInput(mrzText);

  function onApplyMrz(): void {
    if (mrzLines.length < 2) return;
    void runCapture(() => applyMrz(reservationId, mrzLines, scanTarget?.id ?? null));
  }

  async function onConfirmSuggestion(roomId: string): Promise<void> {
    if (!suggestion || !reservation) return;
    setSuggestionBusy(true);
    setSuggestionError(null);
    try {
      const result = await confirmSuggestion(suggestion.id, roomId);
      const assigned = result.reservation.assignedRoomId ?? roomId;
      setSuggestion(result.suggestion);
      setConfirmedRoomId(assigned);
      setSelectedRoomId(assigned);
      setRoomPickerOpen(false);
      setNotReady(null);
      invalidateApi(`/properties/${reservation.propertyId}/rooms`);
      staleOnClose.current = true;
      const number = availableRooms.find((row) => row.id === assigned)?.number ?? suggestion.candidates.find((row) => row.roomId === assigned)?.number ?? assigned;
      showToast(FRONT_DESK_TOASTS.roomAssigned(number), { variant: "success" });
    } catch (err) {
      setSuggestionError(messageOf(err, "No se pudo confirmar la sugerencia."));
    } finally {
      setSuggestionBusy(false);
    }
  }

  /** «Buscar alternativa» tras un 409 ROOM_NOT_READY: nueva sugerencia del motor y la primera limpia pasa a elegida. */
  async function findAlternative(): Promise<void> {
    if (!reservation) return;
    setSuggestionBusy(true);
    setSuggestionError(null);
    try {
      const fresh = await createSuggestion(reservation.id, checkInSession?.id ?? null);
      setSuggestion(fresh);
      invalidateApi(`/properties/${reservation.propertyId}/rooms`);
      const picked = pickSuggestionRoom(fresh.candidates, availableRooms, reservation.roomTypeId, null);
      if (picked) setSelectedRoomId(picked);
      else setSuggestionError("El motor no encontró ninguna habitación lista del mismo tipo: espera a pisos o elige a mano.");
      setNotReady(null);
      setError(null);
    } catch (err) {
      setSuggestionError(messageOf(err, "El motor de asignación no respondió."));
    } finally {
      setSuggestionBusy(false);
    }
  }

  async function onSignature(output: SignatureOutput): Promise<void> {
    if (!primaryTraveller) return;
    setSignBusy(true);
    setSignError(null);
    try {
      const result = await signAtReception(reservationId, { checkInGuestId: primaryTraveller.id, pngBase64: output.pngBase64, svg: output.svg, strokeMeta: output.strokeMeta });
      logBreadcrumb("checkin.signature", "mutation", { reservationId, signatureId: result.signatureId, method: result.method, points: output.strokeMeta.points });
      setSignOpen(false);
      showToast(`Firma registrada en recepción (${result.signatureId})`, { variant: "success" });
      await Promise.all([loadSession(), loadPartes()]);
    } catch (err) {
      setSignError(messageOf(err, "No se pudo registrar la firma."));
    } finally {
      setSignBusy(false);
    }
  }

  async function onVerifyIdentity(guest: ReservationCheckInGuest): Promise<void> {
    setVerifyBusy(true);
    setIdentityNotice(null);
    try {
      await verifyCheckInIdentity(reservationId, { checkInGuestId: guest.id, method: "visual_reception" });
      logBreadcrumb("checkin.identity", "mutation", { reservationId, checkInGuestId: guest.id, method: "visual_reception" });
      showToast(`Identidad de ${travellerName(guest)} cotejada en mostrador`, { variant: "success" });
      await Promise.all([loadSession(), loadPartes()]);
    } catch (err) {
      setIdentityNotice(messageOf(err, "No se pudo marcar la identidad cotejada."));
    } finally {
      setVerifyBusy(false);
    }
  }

  // ------------------------------------------------------------- execute
  const canSubmit = Boolean(reservation && selectedRoomId && guest && reservation.status === "confirmed" && (folio || !paymentRequiresFolio) && (roomIsClean || overrideReady));
  const blockingReason = !reservation
    ? ""
    : reservation.status !== "confirmed"
      ? `Reserva en estado «${reservationStatusLabel(reservation.status)}»: el check-in solo procede con la reserva confirmada.`
      : !selectedRoomId
        ? "Asigna una habitación primero."
        : !guest
          ? "Sin huésped principal vinculado."
          : !roomIsClean && !overrideReady
            ? `${FRONT_DESK_NOTES.roomNotClean} Cambia de habitación o marca «${FRONT_DESK_ACTIONS.overrideCheckIn}» con un motivo.`
            : !folio && paymentRequiresFolio
              ? "No se pudo cargar el folio: reintenta o elige «Sin cobro» de forma explícita."
              : "";

  // Foco inicial en la sección incompleta (§5.2 (4)): habitación si falta, pago si hay saldo, CTA si todo está.
  // Se decide UNA vez, cuando reserva, habitaciones y folio (dato o error) han llegado; `focusKey` se lo dice al cajón.
  const [focusKey, setFocusKey] = useState<"loading" | "room" | "payment" | "submit">("loading");
  useEffect(() => {
    if (focusKey !== "loading" || !reservation || !roomsState.data || (!folioState.data && !folioState.error)) return;
    const room = initialRoomFor(reservation, roomsState.data, initialRoomId);
    const balance = folioState.data?.balanceDue ?? 0;
    setFocusKey(!room ? "room" : balance > 0 ? "payment" : "submit");
  }, [focusKey, reservation, roomsState.data, folioState.data, folioState.error, initialRoomId]);
  const initialFocus = useCallback(() => {
    if (focusKey === "room") return document.getElementById(roomSelectId);
    if (focusKey === "payment") return document.getElementById(paymentMethodId) ?? document.getElementById(submitId);
    if (focusKey === "submit") return document.getElementById(submitId);
    return null;
  }, [focusKey, roomSelectId, paymentMethodId, submitId]);

  const ctaLabel = !folio || amountToCollect === null ? FRONT_DESK_ACTIONS.checkIn : FRONT_DESK_ACTIONS.collectAndCheckIn(fmtEur(amountToCollect));

  async function executeCheckIn() {
    if (!reservation || !selectedRoomId || !canSubmit) return;
    setBusy(true);
    setError(null);
    logBreadcrumb("checkin.submitted", "mutation", {
      reservationId: reservation.id,
      paymentMode,
      reassignRoom: selectedRoomId !== reservation.assignedRoomId,
      override: !roomIsClean
    });
    // QC-06: sin folio cargado no se puede cobrar; la UI exige "Sin cobro"
    // explícito antes de llegar aquí, y este guard lo hace imposible de saltar.
    if (paymentMode !== "none" && !folio) {
      setBusy(false);
      setError("No se pudo cargar el folio: no es posible cobrar. Reintenta o elige «Sin cobro».");
      return;
    }
    const payment = folio && amountToCollect !== null ? { folioId: folio.folio.id, amount: amountToCollect, method: paymentMethod } : null;
    // L-17 (§4.1): la fila de Mi día cambia al instante; el resultado del runner la reconcilia o la revierte.
    setNotReady(null);
    onSubmitted?.({ reservationId: reservation.id, roomId: selectedRoomId, roomNumber: selectedRoom?.number ?? null });
    try {
      const result = await runCheckin(
        {
          reservationId: reservation.id,
          propertyId: reservation.propertyId,
          // La habitación confirmada desde la sugerencia ya está asignada en el API: no se reasigna.
          assignedRoomId: confirmedRoomId ?? reservation.assignedRoomId ?? null,
          roomId: selectedRoomId,
          currency,
          payment,
          overrideReason: !roomIsClean && overrideReady ? overrideReasonFor(overrideReason, selectedRoom?.number) : null,
          // Con sesión en línea el cotejo es el botón «Identidad cotejada» (ya en el API); el interruptor es del camino clásico.
          verifyIdentity: checkinPath === "legacy" ? verifyIdentity : false
        },
        {
          request: apiRequest,
          postPayment: (folioId, body) => postFolioPayment(folioId, body),
          listPartes: loadPartes,
          markIdentity: (parteId) => markGuestRegisterIdentityVerified(parteId, "visual_document_check"),
          queueSes: (pid, rid) => queueSesSubmissions(pid, rid).then(sesQueueOutcomeFromResponse, sesQueueOutcomeFromError),
          // Tanda CHK: POST …/check-in/complete (sin sello sig_*) cuando hay sesión y no hay override de limpieza;
          // corrector REV3-03: con `dryRun` ANTES de asignar y cobrar (las precondiciones fallan sin cargo ni habitación).
          ...(checkinPath === "complete"
            ? {
                completeCheckIn: (rid: string, body: Parameters<typeof completeCheckIn>[1]) => completeCheckIn(rid, body),
                precheckCheckIn: (rid: string, body: Parameters<typeof precheckCheckIn>[1]) => precheckCheckIn(rid, body)
              }
            : {}),
          newClientRequestId,
          previousAttempt: paymentAttempt.current,
          isForbidden: (err) => err instanceof ApiError && err.status === 403,
          onProgress: setProgress
        }
      );
      paymentAttempt.current = result.paymentAttempt;
      // Check-in hecho: la memoria del cobro ya no hace falta.
      storeCheckinAttempt(reservation.id, null);
      setIdentityNotice(result.identityNote);
      setSesOutcome(result.ses);
      setCompletionKey(result.completion?.key ?? null);
      setCompletionWarnings(result.completion?.warnings ?? []);
      logBreadcrumb("checkin.ses", "mutation", { reservationId: reservation.id, outcome: result.ses.kind, path: checkinPath, key: Boolean(result.completion?.key), warnings: result.completion?.warnings.length ?? 0 });
      // La habitación pasa a ocupada: el catálogo de Mi día se revalida. La
      // reserva y el folio se marcan caducados al CERRAR el cajón (sus hooks
      // siguen montados mientras se lee el resultado SES: invalidarlos aquí
      // costaría dos GET que nadie mira; §6.2).
      invalidateApi(`/properties/${reservation.propertyId}/rooms`);
      staleOnClose.current = true;

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      // Con el check-in completo la habitación es la que devuelve el API (puede haber reasignado).
      const roomNumber = result.completion?.room.number ?? selectedRoom?.number ?? null;
      const key = result.completion?.key ?? null;
      const warnings = result.completion?.warnings ?? [];
      setCompleted({ elapsedSeconds: elapsed });
      onCompleted?.({ reservationId: reservation.id, elapsedSeconds: elapsed, reservation: result.reservation, roomNumber, ses: result.ses, key, warnings });
      if (result.ses.kind === "queued") {
        // Cierre inmediato (§5.2 (6)): el toast dice qué pasó (habitación, SES, llave y avisos) y ofrece la ficha.
        const keyText = key ? ` · llave móvil ${key.serialNumber}` : "";
        const warningText = warnings.length > 0 ? ` · ${plural(warnings.length, "aviso", "avisos")}` : "";
        showToast(`${FRONT_DESK_TOASTS.checkInDoneSes(roomNumber, result.ses.queued)}${keyText}${warningText}`, {
          variant: "success",
          action: { label: FRONT_DESK_ACTIONS.openReservation, onAction: () => openReservationDetail(reservation.id) }
        });
        close();
      } else {
        // The drawer stays open: the SES callout inside it (role=alert) is the ONE notice of what is missing (L-04); the toast only says the check-in is done.
        showToast(FRONT_DESK_TOASTS.checkInDone(roomNumber), { variant: "success" });
      }
    } catch (err) {
      const runError = err instanceof CheckinRunError ? err : null;
      if (runError) {
        paymentAttempt.current = runError.paymentAttempt;
        // Corrector REV3-03: el intento sobrevive al cierre del cajón (misma clave al reintentar) y, si el cobro
        // llegó a registrarse, el folio se relee para que «Pagos hasta ahora» no siga en 0,00 €.
        storeCheckinAttempt(reservation.id, runError.paymentAttempt);
        if (runError.progress.payment === "done") void folioState.refresh();
      }
      // 409 ROOM_NOT_READY (POST …/complete): hora prevista de pisos y «Buscar alternativa» en el paso 2.
      const roomNotReady = runError?.code === "ROOM_NOT_READY" ? (runError.details as RoomNotReadyDetails) : null;
      if (roomNotReady) setNotReady(roomNotReady);
      const message = runError && roomNotReady ? roomNotReadyMessage(roomNotReady, runError.message) : err instanceof Error ? err.message : "Error ejecutando check-in";
      setError(message);
      // El callout del cajón (role=alert) ya lo anuncia; el toast no se duplica (L-04).
      showToast(message, { variant: "error", announce: false });
      onFailed?.(reservation.id);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void executeCheckIn();
  }

  // =============================================================== render
  const nights = reservation ? nightsBetween(reservation.arrivalDate, reservation.departureDate) : 0;
  const loadingReservation = !reservation && (reservationState.loading || reservationState.isValidating);
  const catalogLoading = !roomsState.data && (roomsState.loading || roomsState.isValidating);

  let body: ReactNode;
  if (!reservation && reservationState.error) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={reservationState.error} onRetry={reservationState.refresh} />;
  } else if (!reservation) {
    body = <CocoaState kind="error" title="No se encontró la reserva." onRetry={reservationState.refresh} />;
  } else if (completed) {
    body = (
      <CompletedView
        elapsed={elapsedLabel}
        guest={fmtName(guest)}
        roomNumber={selectedRoom?.number}
        ses={sesOutcome}
        partes={partes}
        partesError={partesError}
        identityNotice={identityNotice}
        keyOutcome={completionKey}
        warnings={completionWarnings}
      />
    );
  } else {
    body = (
      <form id={formId} onSubmit={onSubmit} className="cocoa-stack" data-gap="3" aria-label="Check-in rápido">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
        {progress ? (
          <CocoaCallout tone="info" role="status">
            {progressLabel(progress)}
          </CocoaCallout>
        ) : null}

        {/* STEP 1: huésped + alertas */}
        <Step title="1 · Huésped" badge={guest?.vipCode ? undefined : priorStays > 0 ? "Recurrente" : undefined} badgeTone="info">
          <div className="cocoa-stack" data-gap="2">
            <strong style={nameStyle}>{fmtName(guest)}</strong>
            <p className="cocoa-note">
              {guest?.documentType ?? "Documento"} {guest?.documentNumber ?? "—"} · {guest?.nationality ?? "?"}
              {guest?.email ? ` · ${guest.email}` : ""}
            </p>
            {guest?.vipCode ? (
              <div className="cocoa-row" data-gap="2">
                <CocoaBadge tone="accent" variant="tinted" uppercase={false} icon={<StarIcon size={12} />}>
                  VIP {guest.vipCode}
                  {guest.loyaltyTier ? ` · ${guest.loyaltyTier}` : ""}
                </CocoaBadge>
              </div>
            ) : null}
            {priorStays > 0 ? (
              <div className="cocoa-row" data-gap="2">
                <CocoaBadge tone="info" variant="tinted" uppercase={false}>
                  Cliente recurrente · {plural(priorStays, "estancia previa", "estancias previas")}
                </CocoaBadge>
              </div>
            ) : null}
            {reservation.specialRequests || reservation.notes ? (
              <CocoaCallout tone="neutral" icon={<ChatBubbleIcon size={16} />}>
                {reservation.specialRequests ?? reservation.notes}
              </CocoaCallout>
            ) : null}

            {/* Tanda CHK: escaneo / MRZ y viajeros de la sesión en línea */}
            {sessionError ? (
              <CocoaCallout tone="warning" role="status">
                {sessionError}
              </CocoaCallout>
            ) : null}
            {checkInSession ? (
              <div className="cocoa-stack" data-gap="2">
                <div className="cocoa-row" data-gap="2" data-align="center">
                  <CocoaBadge tone={checkInSession.status === "ready_for_arrival" || checkInSession.status === "arrived" ? "success" : checkInSession.status === "expired" || checkInSession.status === "cancelled" ? "danger" : "info"} size="small">
                    Pre-check-in · {sessionStatusLabel(checkInSession.status)}
                  </CocoaBadge>
                  {checkInSession.etaDeclared ? <span className="cocoa-note">ETA {checkInSession.etaDeclared}</span> : null}
                  {checkInSession.handoffKind ? <span className="cocoa-note">· pasado a recepción: {checkInSession.handoffReason ?? checkInSession.handoffKind}</span> : null}
                </div>
                <div className="cocoa-row" data-gap="2" data-align="center">
                  <CocoaFileInput accept="image/*" maxBytes={SCAN_MAX_BYTES} label="Escanear documento" fileName={scanFileName} onPick={onScanFile} onReject={setCaptureError} disabled={busy || scanBusy} />
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setMrzOpen((open) => !open)} disabled={busy || scanBusy} aria-expanded={mrzOpen} aria-controls={mrzFieldId}>
                    Pegar MRZ
                  </CocoaButton>
                  {sessionGuests.length > 1 ? (
                    <CocoaSelect aria-label="Viajero al que se vincula la lectura" value={scanTarget?.id ?? ""} onChange={(value) => setScanTargetId(value || null)} options={sessionGuests.map((row) => ({ value: row.id, label: travellerName(row) }))} disabled={busy || scanBusy} />
                  ) : null}
                </div>
                {mrzOpen ? (
                  <div className="cocoa-stack" data-gap="2">
                    <CocoaField label="MRZ del lector (2 o 3 líneas)" htmlFor={mrzFieldId} help="Pega las líneas tal cual: se validan los dígitos de control ICAO 9303.">
                      <CocoaInput id={mrzFieldId} value={mrzText} onChange={setMrzText} multiline rows={3} disabled={busy || scanBusy} autoComplete="off" />
                    </CocoaField>
                    <div className="cocoa-row" data-gap="2" data-justify="end">
                      <CocoaButton variant="filled" tone="accent" size="small" onClick={onApplyMrz} disabled={busy || scanBusy || mrzLines.length < 2} loading={scanBusy}>
                        Aplicar MRZ
                      </CocoaButton>
                    </div>
                  </div>
                ) : null}
                {captureError ? (
                  <CocoaCallout tone="danger" role="alert">
                    {captureError}
                  </CocoaCallout>
                ) : null}
                {capture ? <CaptureFields capture={capture} /> : null}
                <ul className="c22-section__list" aria-label="Viajeros del check-in">
                  {sessionGuests.map((row) => {
                    const status = travellerStatusLabel(row);
                    return (
                      <li key={row.id}>
                        <span className="cocoa-row" data-gap="2" data-align="center">
                          {travellerName(row)}
                          {row.isPrimary ? (
                            <CocoaBadge tone="accent" variant="tinted" size="small" uppercase={false}>
                              Principal
                            </CocoaBadge>
                          ) : null}
                          {row.isMinor ? (
                            <CocoaBadge tone="info" variant="tinted" size="small" uppercase={false}>
                              Menor
                            </CocoaBadge>
                          ) : null}
                          {row.documentNumberLast3 ? <span className="cocoa-note">doc. ···{row.documentNumberLast3}</span> : null}
                        </span>
                        {/* Envuelto en <span>: un badge (overflow hidden) como ítem flex directo se encoge a 0 y se corta con elipsis. */}
                        <span>
                          <CocoaBadge tone={status.tone} size="small">
                            {status.label}
                          </CocoaBadge>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : sessionLoaded ? (
              <p className="cocoa-note">Sin sesión de check-in en línea: check-in clásico (el parte se crea al confirmar y se firma después en el registro de viajeros).</p>
            ) : null}
          </div>
        </Step>

        {/* STEP 2: habitación */}
        <Step title="2 · Habitación" badgeNode={selectedRoom ? <CocoaStatusBadge entry={roomStatus(selectedRoom.housekeepingStatus)} dense /> : <CocoaBadge tone="warning" size="small">Sin asignar</CocoaBadge>}>
          <div className="cocoa-stack" data-gap="2">
            <div className="cocoa-row" data-gap="2" data-align="baseline">
              <strong>{selectedRoom ? `Hab. ${selectedRoom.number}` : "Sin asignar"}</strong>
              {selectedRoom?.floor ? <span className="cocoa-note">Planta {selectedRoom.floor}</span> : null}
              {roomType ? <span className="cocoa-note">· {roomType.name}</span> : null}
              {catalogLoading ? <span className="cocoa-note">· cargando habitaciones…</span> : null}
            </div>
            {notReady ? (
              <CocoaCallout
                tone="danger"
                title="Habitación no lista"
                role="alert"
                actions={
                  <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => void findAlternative()} disabled={busy || suggestionBusy} loading={suggestionBusy}>
                    Buscar alternativa
                  </CocoaButton>
                }
              >
                {roomNotReadyMessage(notReady, error ?? FRONT_DESK_NOTES.roomNotClean)}
              </CocoaCallout>
            ) : null}
            {suggestionError ? (
              <CocoaCallout tone="warning" role="status">
                {suggestionError}
              </CocoaCallout>
            ) : null}
            {/* Tanda CHK: top-3 del motor con motivos (§4b); «Confirmar» asigna con decisión auditada, «Otra…» abre el selector de candidatas. */}
            {topCandidates.length > 0 && suggestion ? (
              <ul className="c22-section__list" aria-label="Sugerencias de habitación">
                {topCandidates.map((candidate, index) => {
                  const room = availableRooms.find((row) => row.id === candidate.roomId);
                  const ready = room ? isRoomClean(room) && isRoomFree(room) : false;
                  return (
                    <li key={candidate.roomId}>
                      <span className="cocoa-row" data-gap="2" data-align="center">
                        <strong>Hab. {candidate.number}</strong>
                        {index === 0 ? (
                          <CocoaBadge tone="accent" variant="tinted" size="small" uppercase={false}>
                            Top 1
                          </CocoaBadge>
                        ) : null}
                        {room ? <CocoaStatusBadge entry={roomStatus(room.housekeepingStatus)} dense /> : null}
                        <span className="cocoa-note">{candidate.score} pts</span>
                        <CocoaButton variant="plain" tone="neutral" size="small" onClick={(event) => setReasonsFor({ roomId: candidate.roomId, anchor: event.currentTarget })} aria-haspopup="dialog" aria-expanded={reasonsFor?.roomId === candidate.roomId}>
                          Motivos ({candidate.reasons.length})
                        </CocoaButton>
                      </span>
                      <span className="cocoa-row" data-gap="2" data-align="center">
                        {selectedRoomId === candidate.roomId ? (
                          <span>
                            <CocoaBadge tone="success" variant="tinted" size="small" uppercase={false}>
                              Elegida
                            </CocoaBadge>
                          </span>
                        ) : null}
                        {suggestion.status === "suggested" ? (
                          <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => void onConfirmSuggestion(candidate.roomId)} disabled={busy || suggestionBusy || !ready} title={ready ? "Asigna la habitación con el motivo auditado" : "Ahora mismo no está limpia y libre"}>
                            Confirmar
                          </CocoaButton>
                        ) : selectedRoomId !== candidate.roomId ? (
                          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setSelectedRoomId(candidate.roomId)} disabled={busy || !ready}>
                            Elegir
                          </CocoaButton>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : suggestionBusy ? (
              <p className="cocoa-note">Pidiendo sugerencias al motor…</p>
            ) : null}
            {suggestion && "dataNotes" in suggestion && suggestion.dataNotes.length > 0 ? <p className="cocoa-note">{suggestion.dataNotes.join(" · ")}</p> : null}
            <CocoaPopover open={reasonsFor !== null} anchorEl={reasonsFor?.anchor ?? null} onClose={() => setReasonsFor(null)} aria-label="Motivos de la sugerencia">
              {(() => {
                const candidate = topCandidates.find((row) => row.roomId === reasonsFor?.roomId);
                if (!candidate) return null;
                return (
                  <div className="cocoa-stack" data-gap="2">
                    <strong>Hab. {candidate.number}</strong>
                    {candidate.reasons.length > 0 ? (
                      <ul className="c22-section__list">
                        {candidate.reasons.map((reason) => (
                          <li key={reason.rule}>
                            <span>{reason.detail}</span>
                            <strong>{reason.weight > 0 ? `+${reason.weight}` : reason.weight}</strong>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="cocoa-note">Sin motivos puntuables: todas las candidatas empatan.</p>
                    )}
                    {candidate.warnings.map((warning) => (
                      <p className="cocoa-note" key={warning}>
                        {warning}
                      </p>
                    ))}
                  </div>
                );
              })()}
            </CocoaPopover>
            {!suggestion && selectedRoom && !roomIsClean && candidateRooms.length > 0 ? (
              <CocoaCallout
                tone="info"
                title="Sugerencia"
                icon={<InfoCircleIcon size={16} />}
                actions={
                  <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => setSelectedRoomId(candidateRooms[0].id)} disabled={busy}>
                    {FRONT_DESK_ACTIONS.changeRoomTo(candidateRooms[0].number)}
                  </CocoaButton>
                }
              >
                La {candidateRooms[0].number} está limpia, libre y es del mismo tipo.
              </CocoaCallout>
            ) : null}
            {topCandidates.length > 0 && !roomPickerOpen ? (
              <div className="cocoa-row" data-gap="2">
                <CocoaButton id={roomSelectId} variant="bordered" tone="neutral" size="small" onClick={() => setRoomPickerOpen(true)} disabled={busy}>
                  Otra…
                </CocoaButton>
              </div>
            ) : (
              <CocoaField label={FRONT_DESK_ACTIONS.changeRoom} htmlFor={roomSelectId}>
                <CocoaSelect id={roomSelectId} value={selectedRoomId ?? ""} onChange={(value) => setSelectedRoomId(value || undefined)} options={roomOptions} disabled={busy} />
              </CocoaField>
            )}
            {selectedRoom && !roomIsClean ? (
              <div className="cocoa-stack" data-gap="2">
                <CocoaSwitch checked={overrideEnabled} onChange={setOverrideEnabled} size="small" disabled={busy} label={`${FRONT_DESK_ACTIONS.overrideCheckIn} (la limpieza sigue siendo de pisos; el motivo queda auditado)`} />
                {overrideEnabled ? (
                  <CocoaField label={FRONT_DESK_NOTES.overrideReasonLabel} required htmlFor={overrideReasonId} help="Mínimo 3 caracteres.">
                    <CocoaInput id={overrideReasonId} value={overrideReason} onChange={setOverrideReason} maxLength={400} disabled={busy} autoComplete="off" placeholder="El huésped lo acepta; la limpian en 10 minutos" />
                  </CocoaField>
                ) : null}
              </div>
            ) : null}
          </div>
        </Step>

        {/* STEP 3: pago */}
        <Step
          title="3 · Pago"
          badge={folioLoading ? "Cargando folio…" : balanceDue === null ? "Folio no disponible" : balanceDue > 0 ? `${fmtEur(balanceDue)} pendiente` : "Saldado"}
          badgeTone={folioLoading ? "info" : balanceDue === null ? "danger" : balanceDue > 0 ? "warning" : "success"}
        >
          <div className="cocoa-stack" data-gap="2">
            {!folio && !folioLoading ? (
              <CocoaCallout
                tone="danger"
                title={`No se pudo cargar el folio${folioError ? `: ${folioError}` : "."}`}
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={folioState.refresh} disabled={busy}>
                    {ACTIONS.retry}
                  </CocoaButton>
                }
              >
                Sin folio no se puede cobrar. Reintenta o elige «Sin cobro» de forma explícita.
              </CocoaCallout>
            ) : null}
            <ul className="c22-section__list">
              <li>
                <span>Total estancia ({plural(nights, "noche", "noches")})</span>
                <strong>{fmtEur(reservation.totalAmount)}</strong>
              </li>
              <li>
                <span>Pagos hasta ahora</span>
                <strong>{folio ? fmtEur(folio.paymentsTotal) : "No disponible"}</strong>
              </li>
              <li>
                <span>Saldo pendiente</span>
                <strong>{balanceDue === null ? "No disponible (folio no cargado)" : fmtEur(balanceDue)}</strong>
              </li>
            </ul>
            <CocoaSegmentedControl
              size="small"
              aria-label="Modo de cobro"
              value={paymentMode}
              onChange={(value) => setPaymentMode(value as PaymentMode)}
              options={[
                { value: "balance", label: QUICK_CHECKIN_PAYMENT_MODE_LABELS.balance, disabled: !folio || balanceDue === null || balanceDue <= 0 },
                { value: "deposit", label: QUICK_CHECKIN_PAYMENT_MODE_LABELS.deposit, disabled: !canCollectDeposit },
                { value: "none", label: QUICK_CHECKIN_PAYMENT_MODE_LABELS.none }
              ]}
            />
            {!folio || amountToCollect !== null ? <p className="cocoa-note">{!folio ? "Cobrar requiere el folio cargado." : `Se cobrarán ${fmtEur(amountToCollect)} al confirmar.`}</p> : null}
            {paymentMode !== "none" ? (
              <CocoaField label="Método" htmlFor={paymentMethodId}>
                <CocoaSelect id={paymentMethodId} value={paymentMethod} onChange={(value) => setPaymentMethod(value as PaymentMethod)} options={PAYMENT_METHOD_OPTIONS} disabled={busy} />
              </CocoaField>
            ) : null}
          </div>
        </Step>

        {/* STEP 4: compliance — real partes of the reservation (Tanda L5 · L5-B4) */}
        <Step
          title="4 · Cumplimiento"
          badge={partesError ? "Partes no disponibles" : partes.length > 0 ? plural(partes.length, "parte", "partes") : "Se crean al confirmar"}
          badgeTone={partesError ? "warning" : "info"}
        >
          <div className="cocoa-stack" data-gap="2">
            <PartesList partes={partes} error={partesError} emptyText={checkInSession ? "Sin partes todavía: se crean al cerrar el pre-check-in en el portal." : "Sin partes de viajeros todavía: el check-in crea uno por huésped vinculado a la reserva."} />
            {checkInSession ? (
              <div className="cocoa-stack" data-gap="2">
                {/* Tanda CHK: firma real del titular (portal / kiosco / pad de recepción) y cotejo de identidad en mostrador. */}
                <div className="cocoa-row" data-gap="2" data-align="center">
                  <CocoaBadge tone={primarySignature.kind === "pending" ? "warning" : primarySignature.kind === "not_required" ? "info" : "success"} size="small">
                    {primarySignature.kind === "pending" ? "Firma pendiente" : primarySignature.kind === "not_required" ? "Sin firma" : "Firmado"}
                  </CocoaBadge>
                  <span className="cocoa-note">{primarySignature.label}</span>
                </div>
                {signError && !signOpen ? (
                  <CocoaCallout tone="danger" role="alert">
                    {signError}
                  </CocoaCallout>
                ) : null}
                <div className="cocoa-row" data-gap="2" data-align="center">
                  {primarySignature.kind === "pending" && primaryTraveller ? (
                    <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => setSignOpen(true)} disabled={busy} aria-haspopup="dialog">
                      Firmar en el pad
                    </CocoaButton>
                  ) : null}
                  {primaryTraveller?.identityVerifiedAt ? (
                    <CocoaBadge tone="success" variant="tinted" size="small" uppercase={false}>
                      Identidad cotejada ({verificationMethodLabel(primaryTraveller.identityVerificationMethod)} · {shortDateTime(primaryTraveller.identityVerifiedAt)})
                    </CocoaBadge>
                  ) : canVerifyAtDesk && primaryTraveller && !primaryTraveller.isMinor ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void onVerifyIdentity(primaryTraveller)} disabled={busy || verifyBusy} loading={verifyBusy} title="Documento cotejado a la vista (visual_reception); se anota en el parte y en el viajero">
                      Identidad cotejada
                    </CocoaButton>
                  ) : primaryTraveller && !primaryTraveller.isMinor ? (
                    <span className="cocoa-note">Sin permiso guest_register.edit para cotejar la identidad.</span>
                  ) : null}
                </div>
                {identityNotice ? (
                  <CocoaCallout tone="warning" role="status">
                    {identityNotice}
                  </CocoaCallout>
                ) : null}
              </div>
            ) : canVerifyIdentity ? (
              <CocoaSwitch checked={verifyIdentity} onChange={setVerifyIdentity} disabled={busy} label="Identidad verificada en mostrador (documento cotejado; se anota en cada parte antes del envío SES)" />
            ) : null}
            <ul style={bulletListStyle}>
              <li>Al confirmar se encola el parte de viajeros (SES.HOSPEDAJES); aquí verás el resultado real del encolado.</li>
              <li>
                {checkinPath === "complete"
                  ? "Check-in completo: el API exige la firma real del titular y su identidad verificada; devuelve habitación, llave móvil y SES."
                  : checkInSession
                    ? "Con el override de limpieza el check-in va por el camino clásico (el motivo queda auditado); el parte se firma después en el registro de viajeros."
                    : "Check-in clásico: sin firma real en este paso; el parte queda pendiente de firma en el registro de viajeros."}
              </li>
              <li>Política de cancelación: {reservation.cancellationPolicyCode ?? "estándar"}.</li>
            </ul>
          </div>
        </Step>

        {blockingReason ? (
          <CocoaCallout tone="warning" role="status">
            {blockingReason}
          </CocoaCallout>
        ) : null}
      </form>
    );
  }

  return (
    <CocoaDrawer
      open
      onClose={close}
      title="Check-in"
      subtitle={reservation ? `${fmtName(guest)} · ${reservation.code}` : undefined}
      side="right"
      size="md"
      loading={loadingReservation}
      skeleton={<CheckInSkeleton />}
      focusKey={`${focusKey}:${canSubmit ? "ready" : "wait"}`}
      initialFocus={initialFocus}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={close} disabled={busy}>
            {ACTIONS.cancel}
          </CocoaButton>
          {completed ? (
            <CocoaButton variant="filled" tone="accent" onClick={close}>
              {ACTIONS.close}
            </CocoaButton>
          ) : (
            <CocoaButton id={submitId} variant="filled" tone="accent" type="submit" form={formId} disabled={!canSubmit || busy} loading={busy} title={blockingReason || "Intro también confirma"} data-tour="checkin-submit">
              {progress ? progressLabel(progress) : ctaLabel}
            </CocoaButton>
          )}
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-row" data-gap="2">
          <CocoaBadge tone={timerTone} icon={<ClockIcon size={12} />} title="Objetivo: < 90 segundos" aria-label={`Cronómetro ${elapsedLabel}`}>
            {elapsedLabel}
          </CocoaBadge>
          {completed ? (
            <CocoaBadge tone="success" variant="tinted">
              {STATUS_LABELS.completed}
            </CocoaBadge>
          ) : null}
        </div>
        {body}
      </div>
      {/* Tanda CHK: firma del titular en el pad (CocoaSheet encima del cajón; POST …/check-in/signature, touch_reception). */}
      <CocoaSheet
        open={signOpen}
        onClose={() => {
          if (!signBusy) setSignOpen(false);
        }}
        title={`Firma del parte · ${travellerName(primaryTraveller)}`}
        size="sm"
        dismissible={!signBusy}
      >
        <div className="cocoa-stack" data-gap="3">
          <p className="cocoa-note">El titular firma el parte de viajeros en el pad: la firma (PNG y hash) se archiva 3 años y el parte pasa a «firmado».</p>
          {signError ? (
            <CocoaCallout tone="danger" role="alert">
              {signError}
            </CocoaCallout>
          ) : null}
          <SignaturePad onAccept={(output) => void onSignature(output)} busy={signBusy} aria-label="Área de firma del parte de viajeros" />
        </div>
      </CocoaSheet>
    </CocoaDrawer>
  );
}

// =============================================================== sub-components

/** Campos leídos del documento con su origen (MRZ / IA / Manual) y confianza; el número siempre enmascarado; avisos y revisión del API tal cual. */
function CaptureFields({ capture }: { capture: IdentityCaptureResult }) {
  const origin = fieldOriginLabel(capture.source);
  const review = new Set(capture.needsReview);
  const rows = CAPTURE_FIELD_LABELS.filter(([key]) => capture.fields[key] !== undefined && capture.fields[key] !== "");
  return (
    <div className="cocoa-stack" data-gap="2">
      <div className="cocoa-row" data-gap="2" data-align="center">
        <CocoaBadge tone={origin.tone} size="small">
          Lectura {origin.label}
          {capture.mrzFormat ? ` · ${capture.mrzFormat}` : ""}
        </CocoaBadge>
        <span className="cocoa-note">{mrzChecksLabel(capture.checks)}</span>
        <span className="cocoa-note">· {capture.processingMs} ms</span>
        {!capture.persisted ? (
          <CocoaBadge tone="warning" size="small">
            Sin vincular
          </CocoaBadge>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <ul className="c22-section__list" aria-label="Campos leídos del documento">
          {rows.map(([key, label]) => (
            <li key={key}>
              <span className="cocoa-row" data-gap="2" data-align="center">
                {label}
                <CocoaBadge tone={origin.tone} variant="tinted" size="small" uppercase={false}>
                  {origin.label} · {confidenceLabel(capture.confidence[key])}
                </CocoaBadge>
                {review.has(key) ? (
                  <CocoaBadge tone="warning" variant="tinted" size="small" uppercase={false}>
                    Revisar
                  </CocoaBadge>
                ) : null}
              </span>
              <strong>{key === "documentNumber" || key === "documentSupportNumber" ? maskDocumentNumber(capture.fields[key]) : capture.fields[key]}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cocoa-note">La lectura no devolvió campos.</p>
      )}
      {review.has("identity_mismatch") ? (
        <CocoaCallout tone="warning" role="status">
          El documento no coincide con el titular ni con los acompañantes de la reserva: el viajero no recibe los datos hasta que recepción lo revise.
        </CocoaCallout>
      ) : null}
      {capture.warnings.map((warning) => (
        <p className="cocoa-note" key={warning}>
          {warning}
        </p>
      ))}
    </div>
  );
}

function Step({ title, badge, badgeTone = "neutral", badgeNode, children }: { title: string; badge?: string; badgeTone?: CocoaTone; badgeNode?: ReactNode; children: ReactNode }) {
  return (
    <CocoaSection
      title={title}
      meta={
        badgeNode ??
        (badge ? (
          <CocoaBadge tone={badgeTone} size="small">
            {badge}
          </CocoaBadge>
        ) : undefined)
      }
    >
      {children}
    </CocoaSection>
  );
}

/** Real SES queue outcome after the check-in: never claims "enviado" unless every record was queued. */
function SesOutcomeBlock({ outcome }: { outcome: SesQueueOutcome | null }) {
  if (!outcome) {
    return <p className="cocoa-note">Sin resultado del parte de viajeros todavía.</p>;
  }
  if (outcome.kind === "queued") {
    return (
      <CocoaCallout tone="success" title={`Parte de viajeros encolado en SES.HOSPEDAJES (${outcome.queued})`} role="status">
        Encolado no es aceptado: el envío real al MIR se ve en el Centro de envíos.
      </CocoaCallout>
    );
  }
  const tone: CocoaTone = outcome.kind === "no_records" || outcome.kind === "disabled" || outcome.kind === "invalid" ? "warning" : "danger";
  const title =
    outcome.kind === "no_records"
      ? "No se ha encolado ningún parte de viajeros"
      : outcome.kind === "partial"
        ? `Parte SES parcial: ${outcome.queued} encolado${outcome.queued === 1 ? "" : "s"}, ${outcome.failed.length} sin encolar`
        : outcome.kind === "incomplete"
          ? "Parte SES no encolado: faltan datos del establecimiento"
          : outcome.kind === "disabled"
            ? "Parte SES no encolado: SES desactivado para este establecimiento"
            : outcome.kind === "invalid"
              ? `Parte SES no encolado: parte incompleto${outcome.issues.length > 0 ? `, faltan ${issueLabels(outcome.issues)}` : ""}`
              : "Parte SES no encolado";
  const missing = outcome.kind === "partial" || outcome.kind === "incomplete" ? outcome.missing : [];
  const issues = outcome.kind === "invalid" ? outcome.issues : [];
  const detail =
    outcome.kind === "no_records"
      ? "La reserva no tiene registros de viajeros. Completa el registro de viajeros y vuelve a encolar el parte desde la bandeja de cumplimiento."
      : outcome.kind === "disabled"
        ? "El envío a SES.HOSPEDAJES está desactivado en este hotel: actívalo en Ajustes de cumplimiento y vuelve a encolar el parte desde la bandeja."
        : outcome.kind === "invalid"
          ? "El parte de viajeros está incompleto: completa los datos (y la firma si procede) en el registro de viajeros y vuelve a encolarlo."
          : outcome.kind === "error"
            ? `${outcome.message}${outcome.code ? ` (${outcome.code})` : ""}`
            : outcome.kind === "incomplete" && missing.length === 0
              ? outcome.message
              : null;
  // Per-parte server messages (failed[]), verbatim; the one already used as `detail` is not repeated.
  const failed = outcome.kind === "no_records" ? [] : outcome.failed;
  const headlineMessage = outcome.kind === "incomplete" || outcome.kind === "error" || outcome.kind === "disabled" || outcome.kind === "invalid" ? outcome.message : null;
  const failureMessages = sesFailureMessages(failed).filter((message) => message !== headlineMessage);
  const failedCount = failed.length;
  return (
    <CocoaCallout tone={tone} variant="banner" title={title} role="alert">
      <div className="cocoa-stack" data-gap="2">
        {/* Establishment fields (incomplete / partial) or parte fields (invalid): one list, never both at once. */}
        {missing.length > 0 || issues.length > 0 ? (
          <ul style={bulletListStyle}>
            {missing.map((issue) => (
              <li key={`establishment:${issue}`}>{sesEstablishmentIssueLabel(issue)}</li>
            ))}
            {issues.map((issue) => (
              <li key={`parte:${issue}`}>{guestRegisterIssueLabel(issue)}</li>
            ))}
          </ul>
        ) : null}
        {detail ? <p className="cocoa-note">{detail}</p> : null}
        {failureMessages.length > 0 ? (
          <div className="cocoa-note">
            Motivo{failedCount === 1 ? "" : "s"} del servidor ({plural(failedCount, "parte", "partes")} sin encolar):
            <ul style={bulletListStyle}>
              {failureMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="cocoa-row" data-gap="2">
          {outcome.kind === "incomplete" || outcome.kind === "partial" ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("TaxComplianceSettings")}>
              Ajustes fiscales
            </CocoaButton>
          ) : null}
          {outcome.kind === "no_records" || outcome.kind === "invalid" ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("GuestRegisterSettings")}>
              Registro de huéspedes
            </CocoaButton>
          ) : null}
          {outcome.kind === "disabled" ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("SesHospedajesSettings")}>
              Ajustes de cumplimiento
            </CocoaButton>
          ) : null}
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("ComplianceInbox")}>
            Bandeja de cumplimiento
          </CocoaButton>
        </div>
        <p className="cocoa-note">El check-in sí se ha realizado. Esta ventana no se cierra sola para que puedas revisar el parte.</p>
      </div>
    </CocoaCallout>
  );
}

function CompletedView({
  elapsed,
  guest,
  roomNumber,
  ses,
  partes,
  partesError,
  identityNotice,
  keyOutcome = null,
  warnings = []
}: {
  elapsed: string;
  guest: string;
  roomNumber?: string;
  ses: SesQueueOutcome | null;
  partes: GuestRegisterRecord[];
  partesError: string | null;
  identityNotice: string | null;
  /** Tanda CHK: llave móvil de POST …/check-in/complete (null en el check-in clásico). */
  keyOutcome?: ArrivalKey;
  /** Avisos del check-in completo, tal cual los da el API. */
  warnings?: string[];
}) {
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaState kind="empty" illustration="success" title="Check-in completado" message={`${guest} alojado en ${roomNumber ? `Hab. ${roomNumber}` : "su habitación"}.`} role="status" />
      <div className="cocoa-row" data-gap="2" data-justify="center">
        <CocoaBadge tone="success" icon={<ClockIcon size={12} />}>
          {elapsed} · objetivo &lt; 1:30
        </CocoaBadge>
      </div>
      {keyOutcome ? (
        <CocoaSection title="Llave móvil" meta={<CocoaBadge tone={keyOutcome.wallet.apple.signedByApple ? "success" : "warning"} size="small">{keyOutcome.wallet.apple.signedByApple ? "Wallet firmada" : "QR válido · Wallet sin firmar"}</CocoaBadge>}>
          <ul className="c22-section__list">
            <li>
              <span>Número de serie</span>
              <strong className="cocoa-mono">{keyOutcome.serialNumber}</strong>
            </li>
            <li>
              <span>Válida</span>
              <strong>
                {dateTime(keyOutcome.validFrom)} – {dateTime(keyOutcome.validUntil)}
              </strong>
            </li>
          </ul>
        </CocoaSection>
      ) : null}
      {warnings.length > 0 ? (
        <CocoaCallout tone="warning" title={`${plural(warnings.length, "aviso", "avisos")} del check-in`} role="status">
          <ul className="c22-section__list">
            {warnings.map((warning) => (
              <li key={warning}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}
      <CocoaSection title="Partes de viajeros" meta={partes.length > 0 ? plural(partes.length, "parte", "partes") : undefined}>
        <div className="cocoa-stack" data-gap="2">
          <PartesList partes={partes} error={partesError} emptyText="El check-in no ha creado partes: la reserva no tiene huéspedes vinculados." />
          {identityNotice ? (
            <CocoaCallout tone="warning" role="status">
              {identityNotice}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaSection>
      <SesOutcomeBlock outcome={ses} />
    </div>
  );
}

function parteTone(status: string): CocoaTone {
  if (status === "accepted") return "success";
  if (status === "rejected" || status === "failed") return "danger";
  if (status === "missing_data" || status === "annulled" || status === "corrected" || status === "expired") return "warning";
  return "info";
}

function parteName(parte: GuestRegisterRecord): string {
  return [parte.firstName, parte.surname1, parte.surname2].filter(Boolean).join(" ").trim() || "Viajero sin nombre";
}

/** Real partes of the reservation with their Spanish status and the «Principal» / «Menor» marks (Tanda L5 · L5-B4). */
function PartesList({ partes, error, emptyText }: { partes: GuestRegisterRecord[]; error: string | null; emptyText: string }) {
  if (error) {
    return (
      <CocoaCallout tone="warning" role="status">
        No se pudieron cargar los partes de viajeros: {error}
      </CocoaCallout>
    );
  }
  if (partes.length === 0) {
    return <p className="cocoa-note">{emptyText}</p>;
  }
  return (
    <ul className="c22-section__list" aria-label="Partes de viajeros">
      {partes.map((parte) => (
        <li key={parte.id}>
          <span className="cocoa-row" data-gap="2" data-align="center">
            {parteName(parte)}
            {parte.isPrimaryGuest ? (
              <CocoaBadge tone="accent" variant="tinted" size="small" uppercase={false}>
                Principal
              </CocoaBadge>
            ) : null}
            {parte.isMinor ? (
              <CocoaBadge tone="info" variant="tinted" size="small" uppercase={false}>
                Menor
              </CocoaBadge>
            ) : null}
            {parte.identityVerified ? (
              <CocoaBadge tone="success" variant="tinted" size="small" uppercase={false}>
                Identidad verificada
              </CocoaBadge>
            ) : null}
          </span>
          <CocoaBadge tone={parteTone(parte.status)} size="small">
            {guestRegisterStatusLabel(parte.status)}
          </CocoaBadge>
        </li>
      ))}
    </ul>
  );
}
