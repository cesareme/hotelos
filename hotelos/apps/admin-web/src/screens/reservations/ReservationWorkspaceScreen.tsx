// Detalle de la reserva — Recepción › Reservas › Detalle (/recepcion/reservas/:id).
//
// Cocoa 22 · ola 3 · lote 3-A (workspace archetype, templates `Workspace` and
// `Detalle`): CocoaPage with the reservation code, its status badge and the
// inner views (Resumen · Folio · Actividad · Huéspedes · Documentos) as
// `tabs` → CocoaGrid 8/4: the view on the left, an aside with CocoaStat
// (total, saldo, cargos, cobrado) and the deep links on the right → every
// write through CocoaButton; «Cobrar» / «Devolver» keep the Tanda 6
// PaymentDialog / RefundDialog (enum method, clientRequestId per attempt, 202
// → PSP, 409 PSP_NOT_CONFIGURED). The id follows the URL (usePathname →
// reservationIdFromPathname); hosted inside ReservasTabs the container paints
// the title. fix:3-A qa#7: the meta of «Resumen» and the Huéspedes view name
// the primary guest the API joins in /reservations/:id, never its internal id.
//
// Tanda L3 · lote F1 (2026-09-18): «Añadir cargo» offers the manual charge
// types of the fiscal catalogue (components/billing/charge-types) and an
// explicit «Categoría fiscal» sent as `taxCategory` (POST /folios/:id/lines);
// cancel / no-show read GET /reservations/:id/cancellation-charge (?mode=)
// when they open and show the penalty; the reason is required; confirm sends
// `applyPolicy` (L3-B) and the toast names the penalty posted.
//
// Tanda UX-1 · lote U7 (docs/design/UX-RECEPCION-FEEL.md §5.5-5.6, F7 F8 F13
// F14 F20, §4.2, §7.1 2.5.7 / 3.3.7):
//   · cabecera = barra de comandos: estado (CocoaStatusBadge) + UNA primaria
//     `filled` derivada con `primaryActionFor` (screens/operations/primaryAction,
//     U6) + ≤ 2 `bordered` («Cobrar X €» ⌥P · «Cambiar habitación» ⌥M) + «Más ▾»
//     (CocoaPopover: cancelar, no-show, bloquear la habitación, devolver, ir a…);
//     la región lleva `data-cocoa="reservation-command-bar"` (contrato ≤ 1 filled);
//   · «Cambiar habitación» para confirmadas Y alojadas (F7): select + Intro →
//     POST assign-room con `mutate` optimista y «Deshacer» 8 s que vuelve a la
//     anterior; el traslado transaccional de un alojado lo hace el API;
//   · fechas editables (F8): CocoaDatePicker con aritmética («+7», «hoy»),
//     «−1 / +1 noche», recotización visible (POST availability/quote) antes de
//     aplicar si cambia el total; alojada = bloqueado con la explicación (REC-03);
//     PATCH con deshacer 8 s;
//   · check-in desde la ficha con el mismo `checkinRunner` que el cajón (SES leído
//     con honestidad; sin cobro: el cobro es «Cobrar X €»); check-out con saldo =
//     «Cobrar X € y cerrar» (PaymentDialog `closeAfter` → check-out tras cobrar);
//   · cargo (F13): <form> con importe vacío que se limpia, línea optimista y
//     «Deshacer» 8 s — el API no tiene DELETE de líneas ni admite importes
//     negativos (CreateFolioLineSchema `unitPrice ≥ 0`), así que la escritura se
//     difiere 8 s (o hasta salir de la ficha) y deshacer la cancela antes de enviarla;
//   · nota con deshacer (PATCH `notes`; una alojada no admite PATCH salvo habitación);
//   · Documentos: «Factura a huésped» / «Factura a empresa» → InvoiceFromReservationDialog
//     (razón social / NIF recordados, 3.3.7) → issueFolioInvoice → toast con número real;
//   · cancelar / no-show → LifecycleDialog (U6) con la renuncia y el PIN de supervisor;
//   · nada de `await reload()`: useApiData v2 (`mutate` + `invalidateApi('/reservations/'+id)`);
//     dinero con `loading` en el botón (§1.2);
//   · reclama `hotelos-open-payment` (⌘K, U5) cuando el id coincide.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { financeErrorMessage } from "../../services/finance-contracts";
import { TAX_CATEGORY_LABELS, TAX_CATEGORY_OPTIONS, type TaxCategory } from "../../services/taxesApi";
import { chargeTypeLabel, defaultTaxCategoryForType, manualChargeTypeOptions, taxCategoryOptionsForType } from "../../components/billing/charge-types";
import { usePathname } from "../tabs/usePathname";
import { reservationIdFromPathname } from "./reservation-route";
import { guestFullName, reservationGuestLabel, type GuestNameParts } from "./reservation-guest-label";
import {
  balanceDueConflict,
  fetchGuestActivity,
  postFolioPayment,
  quoteStayTotal,
  stayDatesError,
  stayDatesLockedReason,
  stayDatesPatch,
  stayNights,
  stayWithNights,
  type ActivityItem,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type BalanceDueConflict,
  type FolioBalance,
  type GuestActivity,
  type Page,
  type ReservationPatch,
  type StayDates
} from "../../services/pmsCommerceApi";
import { ApiError, apiRequest } from "../../services/api-client";
import { getUser } from "../../services/auth-storage";
import { newClientRequestId } from "../../services/finance-contracts";
import { queueSesSubmissions, sesQueueOutcomeFromError, sesQueueOutcomeFromResponse, type SesQueueOutcome } from "../../services/complianceApi";
import { listReservationGuestRegisterRecords, markGuestRegisterIdentityVerified } from "../../services/guestRegisterApi";
import { CheckinRunError, runCheckin } from "../operations/checkinRunner";
import { primaryActionFor, type PrimaryAction } from "../operations/primaryAction";
import { invalidateApi, useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { OPEN_PAYMENT_EVENT, type HitActionDetail } from "../../components/CommandPalette";
import { useTabHost } from "../tabs/TabHost";
import { urlForScreen } from "../../navigation/nav-tree";
import { navigateTo } from "../../lib/navigate";
import { channelLabel, dateRange, dateTime, marketSegmentLabel, money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS, RESERVATION_ACTIONS, RESERVATION_NOTES, RESERVATION_TOASTS } from "../../content/actions";
import { reservationStatus, roomStatus } from "../../content/status-dictionary";
import { PaymentDialog } from "../../components/billing/PaymentDialog";
import { RefundDialog } from "../../components/billing/RefundDialog";
import { InvoiceFromReservationDialog } from "../../components/billing/InvoiceFromReservationDialog";
import { refundablePayments } from "../../components/billing/payment-flow";
import { LifecycleDialog, type LifecycleMode } from "../../components/reservations/LifecycleDialog";
import type { FolioInvoiceCustomerType } from "../../services/pmsCommerceApi";
import {
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaPopover,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

// /reservations/:id joins the primary guest (firstName · surname1 · surname2;
// also documentNumber, read by InvoiceFromReservationDialog when present);
// the shared list type does not declare it, so it is narrowed here.
type ReservationDetail = AdminReservation & { primaryGuest?: GuestNameParts | null };

function primaryGuestName(reservation: ReservationDetail): string | null {
  return guestFullName(reservation.primaryGuest);
}

function guestLabel(reservation: ReservationDetail): string {
  return reservationGuestLabel(reservation, primaryGuestName(reservation));
}

// «Añadir cargo»: the manual types of the fiscal catalogue, labelled like the
// folio column (components/billing/charge-types; every code is inferable by
// the API). The fiscal category is preselected from the type and editable.
const CHARGE_TYPE_OPTIONS = manualChargeTypeOptions();
const DEFAULT_CHARGE_TYPE = "minibar";
/** `id` of the amount field («Añadir cargo» from ⌘K focuses it). */
export const CHARGE_AMOUNT_ID = "reserva-cargo-importe";
/** `id` of the room select of «Cambiar habitación» (focused when the picker opens). */
export const ROOM_PICKER_SELECT_ID = "reserva-habitacion-destino";
/** Ventana de deshacer de un cargo (§4.2: 8 s); la escritura se envía al agotarse o al salir de la ficha. */
export const CHARGE_UNDO_MS = 8000;
const RESERVATION_STALE_MS = 30_000;
const CATALOG_STALE_MS = 5 * 60_000;

// Inner views of the reservation workspace. Routing is local (no URL
// segment) so deep-linking still lands on Resumen by default. Order follows a
// front-desk session: overview → billing → audit → travellers → paperwork.
type DetailTab = "summary" | "folio" | "activity" | "guests" | "documents";
const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "summary", label: "Resumen" },
  { key: "folio", label: "Folio" },
  { key: "activity", label: "Actividad" },
  { key: "guests", label: "Huéspedes" },
  { key: "documents", label: "Documentos" }
];

// Activity item kinds → short Spanish label for the audit timeline.
const ACTIVITY_KIND_LABEL: Record<ActivityItem["kind"], string> = {
  message: "Mensaje",
  housekeeping: "Limpieza",
  maintenance: "Mantenimiento",
  service_request: "Petición"
};

type FolioLine = FolioBalance["lines"][number];

const ACTIVITY_COLUMNS: CocoaTableColumn<ActivityItem>[] = [
  { key: "at", label: "Cuándo", fit: true, render: (item) => dateTime(item.at, { style: "dayMonth" }) },
  { key: "actor", label: "Quién", fit: true, hideOnNarrow: true, render: (item) => item.channel ?? item.department ?? "sistema" },
  {
    key: "title",
    label: "Acción",
    minWidth: 200,
    render: (item) => (
      <span className="cocoa-cluster">
        <CocoaBadge tone="neutral" size="small">
          {ACTIVITY_KIND_LABEL[item.kind] ?? item.kind}
        </CocoaBadge>
        {item.title}
      </span>
    )
  },
  {
    key: "details",
    label: "Cambios",
    showFrom: "laptop",
    render: (item) =>
      [item.detail, item.status, item.priority]
        .filter((v) => v && String(v).trim().length > 0)
        .join(" · ") || "—"
  }
];

// ---------------------------------------------------------------- barra de comandos (pura, testada)

/** Hoy en ISO local (la fecha con la que se decide «sale hoy»). */
export function todayIsoLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export type MoreActionKind = "pay" | "refund" | "cancel" | "no_show" | "block_room" | "journey" | "guest" | "billing" | "back";

export type CommandBar = {
  /** La única acción `filled`; null cuando el estado no tiene tarea de mostrador (salida hecha, cancelada, no-show). */
  primary: PrimaryAction | null;
  /** «Cobrar X €» como bordered cuando hay saldo y el cobro no es ya la primaria. */
  pay: { label: string; amount: number } | null;
  /** «Asignar habitación» (sin asignar) / «Cambiar habitación» (confirmada o alojada), F7. */
  room: "assign" | "change" | null;
  more: MoreActionKind[];
};

export type CommandBarInput = {
  status: string;
  arrivalDate?: string | null;
  departureDate?: string | null;
  assignedRoomNumber?: string | null;
  /** La habitación asignada ya está fuera de venta (no se ofrece «Bloquear»). */
  assignedRoomSellable?: boolean | null;
  /** La sesión tiene `housekeeping.task.manage` (POST /rooms/:id/sellable responde 403 sin él): sin permiso no se pinta «Bloquear» (P7). */
  canBlockRoom?: boolean;
  hasPrimaryGuest?: boolean;
};

export type CommandBarFolio = { balanceDue: number; open: boolean; refundable: boolean } | null;

/**
 * Deriva la barra de comandos de la ficha (§4 «Barra de comandos de reserva»,
 * P1): una primaria contextual («Hacer check-in» → «Cobrar X € y cerrar» /
 * «Hacer check-out» → «Cobrar X €»), «Cobrar» una sola vez, la acción de
 * habitación para confirmadas y alojadas y los destructivos en «Más». Pura.
 */
export function commandBarFor(reservation: CommandBarInput, folio: CommandBarFolio, today: string, formatAmount: (amount: number) => string): CommandBar {
  const status = (reservation.status ?? "").trim().toLowerCase();
  const derived = primaryActionFor(
    { status, arrivalDate: reservation.arrivalDate, departureDate: reservation.departureDate, roomNumber: reservation.assignedRoomNumber ?? null, balanceEur: folio?.balanceDue ?? 0 },
    folio ? { balanceDue: folio.balanceDue } : null,
    today,
    formatAmount
  );
  // «Abrir ficha» no tiene sentido dentro de la ficha: sin primaria (P7).
  const primary = derived.kind === "open" ? null : derived;
  const owes = Boolean(folio && folio.open && folio.balanceDue > 0.005);
  const payIsPrimary = primary !== null && (primary.kind === "pay" || (primary.kind === "checkout" && primary.amount !== null));
  const pay = owes && !payIsPrimary && folio ? { label: FRONT_DESK_ACTIONS.collect(formatAmount(folio.balanceDue)), amount: folio.balanceDue } : null;
  const room: CommandBar["room"] = status === "confirmed" || status === "checked_in" ? (reservation.assignedRoomNumber ? "change" : "assign") : null;
  const more: MoreActionKind[] = [];
  if (folio?.open && !owes && !payIsPrimary) more.push("pay");
  if (folio?.refundable) more.push("refund");
  if (status === "confirmed") more.push("cancel", "no_show");
  if (reservation.canBlockRoom && reservation.assignedRoomNumber && reservation.assignedRoomSellable !== false && (status === "confirmed" || status === "checked_in")) more.push("block_room");
  more.push("journey");
  if (reservation.hasPrimaryGuest) more.push("guest");
  more.push("billing", "back");
  return { primary, pay, room, more };
}

/** Habitaciones que otras reservas activas (confirmadas o alojadas) tienen asignadas en la ventana de la estancia: el API las rechaza (409), así que no se ofrecen (P7). */
export function heldRoomIds(reservations: readonly Pick<AdminReservation, "id" | "assignedRoomId">[], excludeReservationId: string): Set<string> {
  const held = new Set<string>();
  for (const item of reservations) {
    if (item.id !== excludeReservationId && item.assignedRoomId) held.add(item.assignedRoomId);
  }
  return held;
}

/**
 * Candidatas al cambio (F7): limpias, libres y no asignadas a otra reserva;
 * primero las del mismo tipo y después el resto (mejora o cambio de tipo),
 * cada bloque por número; la asignada va al final para mostrarla como actual.
 */
export function roomCandidatesFor(rooms: readonly AdminRoom[], reservation: Pick<AdminReservation, "roomTypeId" | "assignedRoomId">, held: ReadonlySet<string> = new Set()): AdminRoom[] {
  const byNumber = (a: AdminRoom, b: AdminRoom) => a.number.localeCompare(b.number, "es", { numeric: true });
  const free = rooms.filter((room) => {
    if (room.id === reservation.assignedRoomId) return false;
    if (room.sellable === false || held.has(room.id)) return false;
    const status = (room.status ?? "").trim().toLowerCase();
    const hk = (room.housekeepingStatus ?? "").trim().toLowerCase();
    const available = status !== "occupied" && status !== "blocked" && status !== "out_of_order" && status !== "ooo" && status !== "out_of_service";
    return available && (hk === "clean" || hk === "inspected");
  });
  const sameType = free.filter((room) => room.roomTypeId === reservation.roomTypeId).sort(byNumber);
  const otherType = free.filter((room) => room.roomTypeId !== reservation.roomTypeId).sort(byNumber);
  const current = rooms.filter((room) => room.id === reservation.assignedRoomId);
  return [...sameType, ...otherType, ...current];
}

/** «Bloquear la NNN» exige `housekeeping.task.manage` en el API; una sesión sin lista de permisos (API de demo) lo ofrece y el API decide. */
export function canBlockRoom(user: { permissions?: string[] } | null | undefined): boolean {
  return !user?.permissions || user.permissions.includes("housekeeping.task.manage");
}

/** Etiqueta de una habitación en el selector: «301 · Limpia», «101 · Doble · Limpia» (otro tipo) o «310 · Asignada»; diccionario, nunca el enum crudo. */
export function roomOptionLabel(room: Pick<AdminRoom, "number" | "status" | "housekeepingStatus">, current: boolean, typeName?: string | null): string {
  if (current) return `${room.number} · Asignada`;
  const entry = roomStatus(room.housekeepingStatus ?? room.status);
  return typeName ? `${room.number} · ${typeName} · ${entry.label}` : `${room.number} · ${entry.label}`;
}

/** Línea optimista de un cargo (id temporal; el folio real llega al reconciliar). */
export function optimisticFolioLine(input: { type: string; description: string; unitPrice: number; taxCategory: string; id?: string }): FolioLine {
  return { id: input.id ?? `tmp_${Date.now()}`, type: input.type, description: input.description, quantity: 1, unitPrice: input.unitPrice, taxCategory: input.taxCategory, total: input.unitPrice };
}

/** Folio con la línea añadida y los totales recalculados (optimismo local). */
export function folioWithLine(folio: FolioBalance, line: FolioLine): FolioBalance {
  const chargesTotal = Math.round((folio.chargesTotal + line.total) * 100) / 100;
  return { ...folio, lines: [...folio.lines, line], chargesTotal, balanceDue: Math.round((chargesTotal - folio.paymentsTotal) * 100) / 100 };
}

class ChargeUndoneError extends Error {
  constructor() {
    super("charge-undone");
    this.name = "ChargeUndoneError";
  }
}

export type DeferredFlushReason = "timeout" | "manual" | "pagehide";

/**
 * Escritura diferida con deshacer: `wait()` resuelve true al agotarse la
 * ventana o al vaciar, false si se deshizo. `reason()` dice por qué se envió
 * (UX1-REV-02: en `pagehide` el POST viaja con `keepalive`; antes de cobrar o
 * cerrar la estancia se vacía a mano para que el saldo cobrado sea el real).
 */
export function deferredCommit(ms: number): { wait: () => Promise<boolean>; cancel: () => void; flush: (reason?: DeferredFlushReason) => void; settled: () => boolean; reason: () => DeferredFlushReason | null } {
  let settled = false;
  let reason: DeferredFlushReason | null = null;
  let resolveWait: ((go: boolean) => void) | null = null;
  const promise = new Promise<boolean>((resolve) => {
    resolveWait = resolve;
  });
  const timer = setTimeout(() => finish(true, "timeout"), ms);
  function finish(go: boolean, why: DeferredFlushReason | null) {
    if (settled) return;
    settled = true;
    reason = go ? why : null;
    clearTimeout(timer);
    resolveWait?.(go);
  }
  return { wait: () => promise, cancel: () => finish(false, null), flush: (why = "manual") => finish(true, why), settled: () => settled, reason: () => reason };
}

/** Texto corto del resultado SES tras un check-in desde la ficha (honestidad: nunca «enviado» en falso). */
export function sesOutcomeNote(outcome: SesQueueOutcome): string | null {
  switch (outcome.kind) {
    case "queued":
      return null;
    case "no_records":
      return "Sin registros de viajeros: no se ha encolado ningún parte SES.";
    case "partial":
      return `Parte SES: ${outcome.queued} encolado${outcome.queued === 1 ? "" : "s"}, ${outcome.failed.length} sin encolar.`;
    case "incomplete":
      return "Parte SES no encolado: faltan datos del establecimiento (Ajustes fiscales).";
    case "disabled":
      return "Parte SES no encolado: SES.HOSPEDAJES está desactivado para este establecimiento.";
    case "invalid":
      return `Parte SES no encolado: ${outcome.message}`;
    default:
      return `Parte SES no encolado: ${outcome.message}`;
  }
}

// Cobro pedido desde otra pantalla (⌘K «Cobrar» sobre una reserva de hoy, U5):
// si la ficha montada es otra, el evento no se reclama, la paleta navega a la
// ficha correcta y esta abre el cobro al montar con el folio cargado.
let pendingPaymentReservationId: string | null = null;

export function ReservationDetailWorkspaceScreen() {
  // The id comes from the URL and follows it (popstate, tab changes, shell
  // navigations) so ⌘K, the list row and a pasted deep link all land here.
  const pathname = usePathname();
  const reservationId = useMemo(() => reservationIdFromPathname(pathname), [pathname]);
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();

  // Capa de datos v2 (U3): caché por ruta, SWR y `mutate` optimista con rollback.
  const reservationState = useApiData<ReservationDetail>(reservationId ? `/reservations/${reservationId}` : null, { staleTime: RESERVATION_STALE_MS });
  const folioState = useApiData<FolioBalance>(reservationId ? `/reservations/${reservationId}/folio` : null, { staleTime: RESERVATION_STALE_MS });
  const reservation = reservationState.data;
  const roomsState = useApiData<AdminRoom[]>(reservation ? `/properties/${reservation.propertyId}/rooms` : null, { staleTime: CATALOG_STALE_MS });
  const folio = folioState.data;
  const rooms = useMemo(() => roomsState.data ?? [], [roomsState.data]);
  const loadError = reservationState.error;
  const folioError = folioState.error;

  const [busy, setBusy] = useState(false);
  const [chargeType, setChargeType] = useState(DEFAULT_CHARGE_TYPE);
  const [chargeDesc, setChargeDesc] = useState(chargeTypeLabel(DEFAULT_CHARGE_TYPE));
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeTaxCategory, setChargeTaxCategory] = useState<TaxCategory>(defaultTaxCategoryForType(DEFAULT_CHARGE_TYPE));
  const [focusChargeAmount, setFocusChargeAmount] = useState(false);
  const [payment, setPayment] = useState<{ closeAfter: boolean } | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [invoiceTarget, setInvoiceTarget] = useState<FolioInvoiceCustomerType | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleMode | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [roomAnchor, setRoomAnchor] = useState<HTMLElement | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");
  // Fechas de la estancia (F8): borradores sincronizados con la reserva y recotización pendiente.
  const [stayDraft, setStayDraft] = useState<StayDates | null>(null);
  const [stayQuote, setStayQuote] = useState<{ next: StayDates; total: number; currency: string } | null>(null);
  const [stayBusy, setStayBusy] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  // Activity feed is fetched lazily on tab open to avoid pulling the audit log
  // when the user is just glancing at the summary.
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  // REC-08: pending balance reported by /check-out (409 BALANCE_DUE). The
  // operator must choose between collecting it and leaving with the balance.
  const [balancePrompt, setBalancePrompt] = useState<BalanceDueConflict | null>(null);
  // Cargos con la escritura diferida (deshacer): se vacían al salir de la ficha.
  const pendingCharges = useRef(new Set<ReturnType<typeof deferredCommit>>());

  const status = reservation?.status ?? "";
  const folioId = folio?.folio.id;
  const folioOpen = folio?.folio.status === "open";
  const currency = folio?.folio.currency ?? reservation?.currency;
  const lines = folio?.lines ?? [];
  const payments = folio?.payments ?? [];
  const today = todayIsoLocal();
  const formatAmount = useCallback((amount: number) => money(amount, currency), [currency]);
  const assignedRoom = reservation ? (rooms.find((r) => r.id === reservation.assignedRoomId) ?? null) : null;
  const assignedRoomNumber = reservation ? (assignedRoom?.number ?? (reservation.assignedRoomId ? reservation.assignedRoomId : null)) : null;
  const datesLocked = stayDatesLockedReason(status);

  // Al cambiar de reserva: borradores de estancia y nota desde el registro, habitación seleccionada = asignada.
  useEffect(() => {
    if (!reservation) return;
    setStayDraft({ arrivalDate: reservation.arrivalDate.slice(0, 10), departureDate: reservation.departureDate.slice(0, 10) });
    setNoteDraft(reservation.notes ?? "");
    // Sincroniza con el registro (id, fechas, nota); los borradores en edición no se pisan mientras el id es el mismo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservation?.id, reservation?.arrivalDate, reservation?.departureDate, reservation?.notes]);

  useEffect(() => {
    setActivity(null);
    setStayQuote(null);
    setBalancePrompt(null);
    setSelectedRoomId("");
  }, [reservationId]);

  // Los cargos pendientes se envían al salir de la ficha (o al cerrar la pestaña, sin esperar los 8 s; con
  // `keepalive` en pagehide) y ANTES de cobrar o cerrar la estancia (UX1-REV-02: nunca se cobra un saldo
  // que incluya un cargo que aún puede deshacerse).
  const flushPendingCharges = useCallback((reason: DeferredFlushReason = "manual") => {
    for (const pending of pendingCharges.current) pending.flush(reason);
  }, []);
  useEffect(() => {
    const onPageHide = () => flushPendingCharges("pagehide");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushPendingCharges("manual");
    };
  }, [flushPendingCharges]);
  /** Abre el cobro con los cargos diferidos ya enviados. */
  const openPaymentDialog = useCallback(
    (options: { closeAfter: boolean }) => {
      flushPendingCharges("manual");
      setPayment(options);
    },
    [flushPendingCharges]
  );

  /** Marca caducadas la reserva y su folio (misma clave de prefijo) y la actividad. */
  const invalidateReservation = useCallback(() => {
    if (reservationId) invalidateApi(`/reservations/${reservationId}`);
    setActivity(null);
  }, [reservationId]);

  const afterStayWrite = useCallback(() => {
    invalidateReservation();
    invalidateApi("/dashboards/front-desk");
    if (reservation) invalidateApi(`/properties/${reservation.propertyId}/rooms`);
  }, [invalidateReservation, reservation]);

  function loadActivity() {
    if (!reservationId) return;
    setActivityLoading(true);
    setActivityError(null);
    fetchGuestActivity(reservationId)
      .then((data) => setActivity(data))
      .catch(() => setActivityError("No se pudo cargar la actividad. Inténtalo de nuevo."))
      .finally(() => setActivityLoading(false));
  }

  // Lazy-load the activity feed the first time the user opens the Actividad tab.
  useEffect(() => {
    if (activeTab !== "activity" || !reservationId) return;
    if (activity && activity.reservationId === reservationId) return;
    loadActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, reservationId]);

  // «Añadir cargo» desde ⌘K: pestaña Folio y foco en el importe en cuanto se
  // pinta (y otra vez al cerrarse la paleta, que devuelve el foco a su disparador).
  useEffect(() => {
    if (!focusChargeAmount || activeTab !== "folio") return;
    const focusAmount = () => {
      const input = document.getElementById(CHARGE_AMOUNT_ID);
      if (input instanceof HTMLElement) input.focus();
    };
    focusAmount();
    const timer = setTimeout(() => {
      focusAmount();
      setFocusChargeAmount(false);
    }, 350);
    return () => clearTimeout(timer);
  }, [focusChargeAmount, activeTab, folio]);

  // Cobro pedido con id (⌘K «Cobrar», F3): la ficha lo reclama si es la suya; si no, lo recuerda para la ficha correcta.
  useEffect(() => {
    function onOpenPayment(event: Event) {
      const detail = (event as CustomEvent<HitActionDetail>).detail;
      if (!detail?.reservationId) return;
      if (detail.reservationId === reservationId) {
        event.preventDefault();
        setActiveTab("folio");
        openPaymentDialog({ closeAfter: false });
        return;
      }
      pendingPaymentReservationId = detail.reservationId;
    }
    window.addEventListener(OPEN_PAYMENT_EVENT, onOpenPayment);
    return () => window.removeEventListener(OPEN_PAYMENT_EVENT, onOpenPayment);
  }, [reservationId]);

  useEffect(() => {
    if (!reservationId || pendingPaymentReservationId !== reservationId || !folioOpen) return;
    pendingPaymentReservationId = null;
    setActiveTab("folio");
    openPaymentDialog({ closeAfter: false });
  }, [reservationId, folioOpen]);

  // ---------------------------------------------------------------- acciones de mostrador

  const bar = useMemo<CommandBar | null>(
    () =>
      reservation
        ? commandBarFor(
            {
              status,
              arrivalDate: reservation.arrivalDate,
              departureDate: reservation.departureDate,
              assignedRoomNumber,
              assignedRoomSellable: assignedRoom ? assignedRoom.sellable : null,
              canBlockRoom: canBlockRoom(getUser()),
              hasPrimaryGuest: Boolean(reservation.primaryGuestId)
            },
            folio ? { balanceDue: folio.balanceDue, open: folioOpen, refundable: refundablePayments(payments).length > 0 } : null,
            today,
            formatAmount
          )
        : null,
    [reservation, status, assignedRoomNumber, assignedRoom, folio, folioOpen, payments, today, formatAmount]
  );

  // Al abrir el selector: reservas activas que solapan la estancia (sus
  // habitaciones no se ofrecen) y los tipos, para etiquetar las de otro tipo.
  const overlapQuery = useMemo(
    () => (reservation ? { from: reservation.arrivalDate.slice(0, 10), to: reservation.departureDate.slice(0, 10), status: "confirmed,checked_in", limit: 500, envelope: 1 } : undefined),
    [reservation]
  );
  const overlapState = useApiData<Page<AdminReservation>>(reservation && roomPickerOpen ? `/properties/${reservation.propertyId}/reservations` : null, { query: overlapQuery, staleTime: RESERVATION_STALE_MS });
  const roomTypesState = useApiData<AdminRoomType[]>(reservation && roomPickerOpen ? `/properties/${reservation.propertyId}/room-types` : null, { staleTime: CATALOG_STALE_MS });
  const held = useMemo(() => heldRoomIds(overlapState.data?.items ?? [], reservation?.id ?? ""), [overlapState.data, reservation?.id]);
  const roomCandidates = useMemo(() => (reservation ? roomCandidatesFor(rooms, reservation, held) : []), [rooms, reservation, held]);
  const roomOptions = useMemo(() => {
    const typeName = new Map((roomTypesState.data ?? []).map((type) => [type.id, type.name] as const));
    return roomCandidates.map((room) => ({
      value: room.id,
      label: roomOptionLabel(room, room.id === reservation?.assignedRoomId, room.roomTypeId !== reservation?.roomTypeId ? (typeName.get(room.roomTypeId) ?? "otro tipo") : null)
    }));
  }, [roomCandidates, roomTypesState.data, reservation?.assignedRoomId, reservation?.roomTypeId]);
  const roomPickerLoading = roomPickerOpen && !overlapState.data && (overlapState.loading || overlapState.isValidating);

  function openRoomPicker() {
    if (!reservation) return;
    setSelectedRoomId("");
    setRoomPickerOpen(true);
  }

  // La primera candidata se preselecciona en cuanto se sabe qué habitaciones
  // están libres de verdad, y el foco entra en el selector (2.4.3: Intro confirma
  // sin ratón; Esc devuelve el foco al botón de la barra).
  useEffect(() => {
    if (!roomPickerOpen || roomPickerLoading) return;
    if (!selectedRoomId) {
      const first = roomCandidates.find((room) => room.id !== reservation?.assignedRoomId);
      if (first) setSelectedRoomId(first.id);
    }
    const select = document.getElementById(ROOM_PICKER_SELECT_ID);
    if (select instanceof HTMLElement && document.activeElement !== select) select.focus();
  }, [roomPickerOpen, roomPickerLoading, roomCandidates, selectedRoomId, reservation?.assignedRoomId]);

  function closeRoomPicker() {
    setRoomPickerOpen(false);
    roomAnchor?.focus();
  }

  /** Asignar / cambiar de habitación (F7, §4.2): optimista + «Deshacer» 8 s que vuelve a la anterior. */
  async function changeRoom(room: AdminRoom) {
    if (!reservation) return;
    const previous = assignedRoom;
    if (previous && previous.id === room.id) {
      setRoomPickerOpen(false);
      return;
    }
    const message = previous ? FRONT_DESK_TOASTS.roomChanged(previous.number, room.number) : FRONT_DESK_TOASTS.roomAssigned(room.number);
    // El foco vuelve al botón «Cambiar habitación» al confirmar (L-11 (d)), no a BODY.
    closeRoomPicker();
    try {
      await reservationState.mutate(
        (prev) => ({ ...prev, assignedRoomId: room.id }),
        (request) => request<void>(`/reservations/${encodeURIComponent(reservation.id)}/assign-room`, { method: "POST", body: { roomId: room.id } }),
        {
          announce: message,
          undo: previous
            ? {
                label: message,
                onUndo: async () => {
                  await reservationState.mutate(
                    (prev) => ({ ...prev, assignedRoomId: previous.id }),
                    (request) => request<void>(`/reservations/${encodeURIComponent(reservation.id)}/assign-room`, { method: "POST", body: { roomId: previous.id } })
                  );
                  // L-11 (c): el deshacer también se confirma (toast + región viva del shell).
                  showToast(FRONT_DESK_TOASTS.roomChangeUndone(previous.number), { variant: "info" });
                  afterStayWrite();
                }
              }
            : undefined
        }
      );
      if (!previous) showToast(message, { variant: "success" });
      afterStayWrite();
    } catch (error) {
      // Rollback ya hecho por `mutate`: el mensaje del API (409 ocupada…) se muestra aquí.
      showToast(error instanceof Error ? error.message : "No se pudo cambiar la habitación.", { variant: "error" });
    }
  }

  function onRoomPickerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const room = roomCandidates.find((candidate) => candidate.id === selectedRoomId);
    if (room) void changeRoom(room);
  }

  /** Intro sobre el selector nativo confirma (un selector no dispara el envío implícito del formulario). */
  function onRoomPickerKeyDown(event: ReactKeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (!(event.target instanceof HTMLSelectElement)) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }

  /** Check-in con el runner del cajón (cobro aparte; SES leído con honestidad). */
  async function doCheckIn() {
    if (!reservation) return;
    const roomId = reservation.assignedRoomId ?? selectedRoomId;
    if (!roomId) {
      showToast("Elige una habitación para hacer el check-in.", { variant: "warning" });
      openRoomPicker();
      return;
    }
    const room = rooms.find((candidate) => candidate.id === roomId) ?? null;
    setBusy(true);
    try {
      let outcome: SesQueueOutcome | null = null;
      await reservationState.mutate(
        (prev) => ({ ...prev, status: "checked_in", assignedRoomId: roomId }),
        async (request) => {
          // UX1-REV-10: el runner escribe con el `request` vigilado de R4 (rutas con dinero prohibidas al optimismo).
          const result = await runCheckin(
            { reservationId: reservation.id, propertyId: reservation.propertyId, assignedRoomId: reservation.assignedRoomId ?? null, roomId, currency: reservation.currency, payment: null },
            {
              request,
              postPayment: (id, body) => postFolioPayment(id, body),
              listPartes: () => listReservationGuestRegisterRecords(reservation.id, { retries: 0 }),
              markIdentity: (parteId) => markGuestRegisterIdentityVerified(parteId, "visual_document_check"),
              queueSes: (pid, rid) => queueSesSubmissions(pid, rid).then(sesQueueOutcomeFromResponse, sesQueueOutcomeFromError),
              newClientRequestId,
              isForbidden: (err) => err instanceof ApiError && err.status === 403
            }
          );
          outcome = result.ses;
          return result.reservation ? { status: result.reservation.status, assignedRoomId: result.reservation.assignedRoomId ?? roomId } : undefined;
        },
        { announce: FRONT_DESK_TOASTS.checkInDone(room?.number ?? null) }
      );
      const ses = outcome as SesQueueOutcome | null;
      if (ses && ses.kind === "queued") showToast(FRONT_DESK_TOASTS.checkInDoneSes(room?.number ?? null, ses.queued), { variant: "success" });
      else {
        showToast(FRONT_DESK_TOASTS.checkInDone(room?.number ?? null), { variant: "success" });
        const note = ses ? sesOutcomeNote(ses) : null;
        if (note) showToast(note, { variant: ses && ses.kind === "no_records" ? "info" : "warning", duration: 9000 });
      }
      afterStayWrite();
    } catch (error) {
      const message = error instanceof CheckinRunError || error instanceof Error ? error.message : "Error ejecutando check-in";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  /** Check-out (optimista; 409 BALANCE_DUE → rollback + aviso con «Cobrar» / «Salir con saldo pendiente»). */
  async function doCheckOut(options: { acknowledgeBalance?: boolean; afterPayment?: boolean } = {}) {
    if (!reservation) return;
    flushPendingCharges("manual");
    setBusy(true);
    setBalancePrompt(null);
    try {
      await reservationState.mutate(
        (prev) => ({ ...prev, status: "checked_out" }),
        (request) => request<void>(`/reservations/${encodeURIComponent(reservation.id)}/check-out`, { method: "POST", body: { acknowledgeBalance: options.acknowledgeBalance } }),
        { announce: FRONT_DESK_TOASTS.checkOutDone(assignedRoomNumber) }
      );
      showToast(options.afterPayment ? RESERVATION_TOASTS.paymentClosed(assignedRoomNumber) : options.acknowledgeBalance ? RESERVATION_TOASTS.checkOutWithBalance : FRONT_DESK_TOASTS.checkOutDone(assignedRoomNumber), { variant: "success" });
      afterStayWrite();
    } catch (error) {
      const conflict = balanceDueConflict(error);
      if (conflict) {
        setBalancePrompt({ ...conflict, balanceDue: conflict.balanceDue ?? folio?.balanceDue ?? null });
        showToast(conflict.message, { variant: "warning" });
      } else {
        showToast(error instanceof Error ? error.message : "No se pudo completar la acción.", { variant: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  function runPrimary(action: PrimaryAction) {
    switch (action.kind) {
      case "checkin":
        void doCheckIn();
        return;
      case "checkout":
        if (action.amount !== null && action.amount > 0) {
          openPaymentDialog({ closeAfter: true });
        } else {
          void doCheckOut();
        }
        return;
      case "pay":
        openPaymentDialog({ closeAfter: false });
        return;
      case "invoice":
        setActiveTab("documents");
        setInvoiceTarget(reservation?.companyName ? "company" : "guest");
        return;
      default:
        return;
    }
  }

  function runMore(kind: MoreActionKind) {
    setMoreOpen(false);
    if (!reservation) return;
    switch (kind) {
      case "pay":
        openPaymentDialog({ closeAfter: false });
        return;
      case "refund":
        setRefundOpen(true);
        return;
      case "cancel":
        setLifecycle("cancellation");
        return;
      case "no_show":
        setLifecycle("no_show");
        return;
      case "block_room":
        setBlockOpen(true);
        return;
      case "journey": {
        const url = urlForScreen("GuestJourneyWorkspace", { id: reservation.id });
        if (url) openTabPath(url);
        return;
      }
      case "guest":
        if (reservation.primaryGuestId) openTabPath(urlForScreen("GuestDetail", { id: reservation.primaryGuestId }) ?? "/recepcion/huespedes");
        return;
      case "billing":
        navigateTo("BillingCenter");
        return;
      case "back":
        goToList();
        return;
      default:
        return;
    }
  }

  /** «Bloquear la 310» (§4.2: afecta al inventario → diálogo nominal): POST /rooms/:id/sellable { false }. */
  async function blockRoom() {
    if (!assignedRoom) return;
    setBusy(true);
    try {
      await apiRequest(`/rooms/${encodeURIComponent(assignedRoom.id)}/sellable`, { method: "POST", body: { sellable: false } });
      setBlockOpen(false);
      showToast(RESERVATION_TOASTS.roomBlocked(assignedRoom.number), { variant: "success" });
      invalidateApi(`/properties/${reservation?.propertyId}/rooms`);
      invalidateApi("/dashboards/front-desk");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "No se pudo bloquear la habitación.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- fechas (F8)

  /** Aplica la estancia (PATCH fechas + total recotizado) con deshacer 8 s que restaura fechas y total anteriores. */
  async function applyStay(next: StayDates, quotedTotal: number | null) {
    if (!reservation) return;
    const previous: StayDates & { totalAmount: number } = { arrivalDate: reservation.arrivalDate.slice(0, 10), departureDate: reservation.departureDate.slice(0, 10), totalAmount: reservation.totalAmount };
    const patch = stayDatesPatch(previous, next, quotedTotal);
    setStayQuote(null);
    if (Object.keys(patch).length === 0) return;
    const nights = stayNights(next.arrivalDate, next.departureDate);
    const message = RESERVATION_TOASTS.datesChanged(dateRange(next.arrivalDate, next.departureDate, { style: "dayMonth" }), nights);
    const revert: ReservationPatch = { arrivalDate: previous.arrivalDate, departureDate: previous.departureDate, ...(patch.totalAmount !== undefined ? { totalAmount: previous.totalAmount } : {}) };
    setStayBusy(true);
    try {
      await reservationState.mutate(
        (prev) => ({ ...prev, ...patch }) as ReservationDetail,
        (request) => request<void>(`/reservations/${encodeURIComponent(reservation.id)}`, { method: "PATCH", body: patch }),
        {
          announce: message,
          undo: {
            label: message,
            onUndo: async () => {
              await reservationState.mutate(
                (prev) => ({ ...prev, ...revert }) as ReservationDetail,
                (request) => request<void>(`/reservations/${encodeURIComponent(reservation.id)}`, { method: "PATCH", body: revert })
              );
              showToast(RESERVATION_TOASTS.datesRestored(dateRange(previous.arrivalDate, previous.departureDate, { style: "dayMonth" })), { variant: "info" });
              afterStayWrite();
            }
          }
        }
      );
      afterStayWrite();
    } catch (error) {
      setStayDraft(previous);
      showToast(error instanceof Error ? error.message : "No se pudieron cambiar las fechas.", { variant: "error" });
    } finally {
      setStayBusy(false);
    }
  }

  /** Cambio de fechas: valida, recotiza y aplica directo si el total no cambia (o no hay cotización); si cambia, lo enseña antes. */
  async function changeStay(next: StayDates) {
    if (!reservation) return;
    if (datesLocked) {
      showToast(RESERVATION_TOASTS.datesLocked, { variant: "warning" });
      setStayDraft({ arrivalDate: reservation.arrivalDate.slice(0, 10), departureDate: reservation.departureDate.slice(0, 10) });
      return;
    }
    const error = stayDatesError(next);
    if (error) {
      showToast(error, { variant: "error" });
      return;
    }
    setStayDraft(next);
    if (next.arrivalDate === reservation.arrivalDate.slice(0, 10) && next.departureDate === reservation.departureDate.slice(0, 10)) return;
    setStayBusy(true);
    const quote = await quoteStayTotal(reservation.propertyId, reservation, next);
    setStayBusy(false);
    if (!quote) {
      showToast(RESERVATION_TOASTS.quoteUnavailable, { variant: "info" });
      await applyStay(next, null);
      return;
    }
    if (Math.abs(quote.total - reservation.totalAmount) < 0.005) {
      await applyStay(next, null);
      return;
    }
    setStayQuote({ next, total: quote.total, currency: quote.currency });
  }

  function shiftNights(delta: number) {
    if (!reservation || !stayDraft) return;
    void changeStay(stayWithNights(stayDraft, delta));
  }

  // ---------------------------------------------------------------- cargo y nota (F13)

  /** Cargo con deshacer: línea optimista, escritura diferida 8 s (o al salir) y toast con «Deshacer» que la cancela. */
  async function addCharge() {
    const amount = Number(chargeAmount.replace(",", "."));
    if (!folio || !folioId || !folioOpen || !Number.isFinite(amount) || amount <= 0) return;
    const line = optimisticFolioLine({ type: chargeType, description: chargeDesc.trim() || chargeTypeLabel(chargeType), unitPrice: Math.round(amount * 100) / 100, taxCategory: chargeTaxCategory });
    const pending = deferredCommit(CHARGE_UNDO_MS);
    pendingCharges.current.add(pending);
    const amountText = formatAmount(line.total);
    // Formulario limpio al instante (F13: nunca un doble cargo por olvido).
    setChargeAmount("");
    setChargeDesc(chargeTypeLabel(chargeType));
    showToast(RESERVATION_TOASTS.chargeAdded(amountText), {
      variant: "success",
      duration: CHARGE_UNDO_MS,
      action: { label: ACTIONS.undo, onAction: () => pending.cancel() },
      announce: RESERVATION_TOASTS.chargeAdded(amountText)
    });
    try {
      await folioState.mutate(
        (prev) => folioWithLine(prev, line),
        async (request) => {
          const go = await pending.wait();
          if (!go) throw new ChargeUndoneError();
          await request<unknown>(`/folios/${encodeURIComponent(folioId)}/lines`, {
            method: "POST",
            body: { type: line.type, description: line.description, quantity: 1, unitPrice: line.unitPrice, taxCategory: chargeTaxCategory },
            keepalive: pending.reason() === "pagehide"
          });
        }
      );
      invalidateReservation();
      invalidateApi("/dashboards/front-desk");
    } catch (error) {
      if (error instanceof ChargeUndoneError) {
        showToast(RESERVATION_TOASTS.chargeUndone(amountText), { variant: "info" });
      } else {
        showToast(`${RESERVATION_TOASTS.chargeFailed}: ${error instanceof Error ? error.message : "error"}`, { variant: "error" });
      }
    } finally {
      pendingCharges.current.delete(pending);
    }
  }

  function onChargeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void addCharge();
  }

  /** Nota de la reserva con deshacer (PATCH `notes`; alojada → el API no admite PATCH salvo habitación). */
  async function saveNote() {
    if (!reservation) return;
    const next = noteDraft.trim();
    const previous = reservation.notes ?? "";
    if (next === previous.trim()) return;
    try {
      await reservationState.mutate(
        (prev) => ({ ...prev, notes: next }),
        (request) => request<void>(`/reservations/${encodeURIComponent(reservation.id)}`, { method: "PATCH", body: { notes: next || null } }),
        {
          announce: RESERVATION_TOASTS.noteSaved,
          undo: {
            label: RESERVATION_TOASTS.noteSaved,
            onUndo: async () => {
              await reservationState.mutate(
                (prev) => ({ ...prev, notes: previous }),
                (request) => request<void>(`/reservations/${encodeURIComponent(reservation.id)}`, { method: "PATCH", body: { notes: previous || null } })
              );
              setNoteDraft(previous);
              showToast(RESERVATION_TOASTS.noteRestored, { variant: "info" });
              invalidateReservation();
            }
          }
        }
      );
      invalidateReservation();
    } catch (error) {
      setNoteDraft(previous);
      showToast(error instanceof Error ? error.message : "No se pudo guardar la nota.", { variant: "error" });
    }
  }

  // ---------------------------------------------------------------- navegación

  function goToList() {
    navigateTo("ReservationWorkspace");
  }
  function openGuest(guestId: string) {
    openTabPath(urlForScreen("GuestDetail", { id: guestId }) ?? "/recepcion/huespedes");
  }

  // Inner view options with live counts in the label.
  const tabOptions = useMemo(
    () =>
      DETAIL_TABS.map((tab) => {
        if (tab.key === "folio" && folio) return { value: tab.key, label: `${tab.label} (${folio.lines.length})` };
        if (tab.key === "activity" && activity) return { value: tab.key, label: `${tab.label} (${activity.items.length})` };
        if (tab.key === "guests" && reservation) return { value: tab.key, label: `${tab.label} (${(reservation.adults ?? 0) + (reservation.children ?? 0)})` };
        return { value: tab.key, label: tab.label };
      }),
    [folio, activity, reservation]
  );

  const lineColumns = useMemo<CocoaTableColumn<FolioLine>[]>(
    () => [
      { key: "description", label: FIELD_LABELS.description, minWidth: 160, render: (line) => <strong>{line.description}</strong> },
      { key: "type", label: FIELD_LABELS.type, fit: true, hideOnNarrow: true, render: (line) => chargeTypeLabel(line.type) },
      {
        key: "taxCategory",
        label: "Categoría fiscal",
        fit: true,
        hideOnNarrow: true,
        render: (line) =>
          line.taxCategory && line.taxCategory in TAX_CATEGORY_LABELS ? (
            <CocoaBadge tone={line.taxCategory === "not_subject" ? "info" : "neutral"} size="small" uppercase={false}>
              {TAX_CATEGORY_LABELS[line.taxCategory as TaxCategory]}
            </CocoaBadge>
          ) : (
            "—"
          )
      },
      { key: "quantity", label: "Cantidad × precio", align: "right", hideOnNarrow: true, render: (line) => `${line.quantity} × ${money(line.unitPrice, currency)}` },
      { key: "total", label: FIELD_LABELS.total, align: "right", render: (line) => <strong>{money(line.total, currency)}</strong> }
    ],
    [currency]
  );

  const pageState = !reservationId ? "empty" : loadError && !reservation ? "error" : !reservation ? "loading" : "ready";
  const subtitle = reservation
    ? `${guestLabel(reservation)} · ${dateRange(reservation.arrivalDate, reservation.departureDate, { style: "dayMonth" })} · ${plural(reservation.adults, "adulto", "adultos")}`
    : "Resumen, folio, actividad y huéspedes de una reserva.";
  const nights = stayDraft ? stayNights(stayDraft.arrivalDate, stayDraft.departureDate) : 0;
  const moneyBusy = busy || stayBusy;

  const MORE_LABEL: Record<MoreActionKind, string> = {
    pay: `${FRONT_DESK_ACTIONS.collect("").trim()}…`,
    refund: `${RESERVATION_ACTIONS.refund}…`,
    cancel: RESERVATION_ACTIONS.cancelReservation,
    no_show: RESERVATION_ACTIONS.markNoShow,
    block_room: RESERVATION_ACTIONS.blockRoom(assignedRoomNumber ?? ""),
    journey: "Recorrido del huésped",
    guest: "Ficha del huésped",
    billing: "Centro de facturación",
    back: RESERVATION_ACTIONS.backToReservations
  };

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title={reservation?.code ?? "Detalle de reserva"}
      density="operational"
      subtitle={hosted ? undefined : subtitle}
      tabs={reservation ? tabOptions : undefined}
      activeTab={activeTab}
      onTabChange={(value) => setActiveTab(value as DetailTab)}
      actions={
        reservation && bar ? (
          <div className="cocoa-row" data-gap="2" role="group" aria-label="Acciones de la reserva" data-cocoa="reservation-command-bar">
            <CocoaStatusBadge entry={reservationStatus(status)} />
            {bar.primary ? (
              <CocoaButton variant="filled" tone="accent" size="small" accessKey="C" loading={busy} disabled={moneyBusy} onClick={() => runPrimary(bar.primary!)}>
                {bar.primary.label}
              </CocoaButton>
            ) : null}
            {bar.pay ? (
              <CocoaButton variant="bordered" tone="neutral" size="small" accessKey="P" disabled={moneyBusy || !folioId} onClick={() => openPaymentDialog({ closeAfter: false })}>
                {bar.pay.label}
              </CocoaButton>
            ) : null}
            {bar.room ? (
              <CocoaButton
                ref={setRoomAnchor}
                variant="bordered"
                tone="neutral"
                size="small"
                accessKey="M"
                aria-haspopup="dialog"
                aria-expanded={roomPickerOpen}
                disabled={moneyBusy}
                onClick={() => (roomPickerOpen ? closeRoomPicker() : openRoomPicker())}
              >
                {bar.room === "change" ? RESERVATION_ACTIONS.changeRoom : RESERVATION_ACTIONS.assignRoom}
              </CocoaButton>
            ) : null}
            <CocoaButton ref={setMoreAnchor} variant="plain" tone="neutral" size="small" aria-haspopup="menu" aria-expanded={moreOpen} disabled={moneyBusy} onClick={() => setMoreOpen((value) => !value)}>
              {RESERVATION_ACTIONS.more} ▾
            </CocoaButton>
          </div>
        ) : undefined
      }
      state={pageState}
      skeleton={<CocoaSkeleton.Grid rows={[[8, 4]]} height={280} />}
      error={{ title: "No se pudo cargar la reserva", message: loadError ?? undefined, onRetry: reservationState.refresh }}
      empty={{
        title: "Esta dirección no lleva ninguna reserva",
        message: "Vuelve a la lista y abre una reserva para ver su detalle.",
        illustration: "search",
        primaryAction: { label: RESERVATION_ACTIONS.backToReservations, onClick: goToList }
      }}
      commands={
        reservation
          ? [
              ...(bar?.primary ? [{ id: "reserva-primaria", label: `${bar.primary.label} · ${reservation.code}`, shortcut: "⌥C", run: () => runPrimary(bar.primary!) }] : []),
              ...(folioId && folioOpen
                ? [
                    {
                      id: "reserva-cobrar",
                      label: `Cobrar en ${reservation.code}`,
                      shortcut: "⌥P",
                      run: () => {
                        setActiveTab("folio");
                        openPaymentDialog({ closeAfter: false });
                      }
                    },
                    {
                      id: "reserva-cargo",
                      label: `${RESERVATION_ACTIONS.addCharge} en ${reservation.code}`,
                      run: () => {
                        setActiveTab("folio");
                        setFocusChargeAmount(true);
                      }
                    },
                    { id: "reserva-factura-huesped", label: `${RESERVATION_ACTIONS.invoiceToGuest} · ${reservation.code}`, run: () => setInvoiceTarget("guest") },
                    { id: "reserva-factura-empresa", label: `${RESERVATION_ACTIONS.invoiceToCompany} · ${reservation.code}`, run: () => setInvoiceTarget("company") }
                  ]
                : []),
              ...(bar?.room ? [{ id: "reserva-habitacion", label: bar.room === "change" ? RESERVATION_ACTIONS.changeRoom : RESERVATION_ACTIONS.assignRoom, shortcut: "⌥M", run: openRoomPicker }] : []),
              ...(!datesLocked
                ? [
                    { id: "reserva-noche-mas", label: `${RESERVATION_ACTIONS.plusNight} · ${reservation.code}`, run: () => shiftNights(1) },
                    { id: "reserva-noche-menos", label: `${RESERVATION_ACTIONS.minusNight} · ${reservation.code}`, run: () => shiftNights(-1) }
                  ]
                : []),
              ...(status === "confirmed"
                ? [
                    { id: "reserva-cancelar", label: `${RESERVATION_ACTIONS.cancelReservation} ${reservation.code}`, run: () => setLifecycle("cancellation") },
                    { id: "reserva-no-show", label: `${RESERVATION_ACTIONS.markNoShow} ${reservation.code}`, run: () => setLifecycle("no_show") }
                  ]
                : []),
              { id: "reserva-volver", label: "Volver a la lista de reservas", run: goToList }
            ]
          : undefined
      }
    >
      {reservation ? (
        <CocoaGrid align="start" aria-label="Detalle de la reserva">
          <CocoaSpan cols={8} min={480}>
            {activeTab === "summary" ? (
              <div className="cocoa-stack" data-gap="3">
                <CocoaSection title="Estancia" meta={`${plural(nights, "noche", "noches")} · ${dateRange(reservation.arrivalDate, reservation.departureDate, { style: "dayMonth" })}`}>
                  {datesLocked ? (
                    <div className="cocoa-stack" data-gap="2">
                      <p>
                        <strong>{dateRange(reservation.arrivalDate, reservation.departureDate, { style: "dayMonth" })}</strong> · {plural(stayNights(reservation.arrivalDate, reservation.departureDate), "noche", "noches")}
                      </p>
                      <p className="cocoa-note" data-cocoa="stay-locked">
                        {datesLocked}
                      </p>
                    </div>
                  ) : stayDraft ? (
                    <form
                      className="cocoa-stack"
                      data-gap="2"
                      aria-label="Fechas de la estancia"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void changeStay(stayDraft);
                      }}
                    >
                      <div className="cocoa-row" data-gap="2" data-align="end">
                        <CocoaField label="Llegada" help={RESERVATION_NOTES.datesArithmetic}>
                          <CocoaDatePicker
                            value={stayDraft.arrivalDate}
                            arithmetic
                            today={today}
                            disabled={stayBusy}
                            onChange={(value) => {
                              const next = { ...stayDraft, arrivalDate: value };
                              setStayDraft(next);
                              if (/^\d{4}-\d{2}-\d{2}$/.test(value)) void changeStay(next);
                            }}
                          />
                        </CocoaField>
                        <CocoaField label="Salida">
                          <CocoaDatePicker
                            value={stayDraft.departureDate}
                            arithmetic
                            today={today}
                            min={stayDraft.arrivalDate}
                            disabled={stayBusy}
                            onChange={(value) => {
                              const next = { ...stayDraft, departureDate: value };
                              setStayDraft(next);
                              if (/^\d{4}-\d{2}-\d{2}$/.test(value)) void changeStay(next);
                            }}
                          />
                        </CocoaField>
                        <CocoaButton variant="bordered" tone="neutral" size="small" disabled={stayBusy || nights <= 1} onClick={() => shiftNights(-1)} aria-label="Una noche menos">
                          {RESERVATION_ACTIONS.minusNight}
                        </CocoaButton>
                        <CocoaButton variant="bordered" tone="neutral" size="small" disabled={stayBusy} onClick={() => shiftNights(1)} aria-label="Una noche más">
                          {RESERVATION_ACTIONS.plusNight}
                        </CocoaButton>
                      </div>
                      {stayQuote ? (
                        <CocoaCallout
                          tone="warning"
                          role="status"
                          title={`Nuevo total ${money(stayQuote.total, stayQuote.currency)} (antes ${money(reservation.totalAmount, reservation.currency)})`}
                          actions={
                            <>
                              <CocoaButton variant="tinted" tone="accent" size="small" loading={stayBusy} onClick={() => void applyStay(stayQuote.next, stayQuote.total)}>
                                {RESERVATION_ACTIONS.applyDatesAndPrice(money(stayQuote.total, stayQuote.currency))}
                              </CocoaButton>
                              <CocoaButton
                                variant="plain"
                                tone="neutral"
                                size="small"
                                disabled={stayBusy}
                                onClick={() => {
                                  setStayQuote(null);
                                  setStayDraft({ arrivalDate: reservation.arrivalDate.slice(0, 10), departureDate: reservation.departureDate.slice(0, 10) });
                                }}
                              >
                                {RESERVATION_ACTIONS.keepDates}
                              </CocoaButton>
                            </>
                          }
                        >
                          {dateRange(stayQuote.next.arrivalDate, stayQuote.next.departureDate, { style: "dayMonth" })} · {plural(stayNights(stayQuote.next.arrivalDate, stayQuote.next.departureDate), "noche", "noches")} con la tarifa publicada.
                        </CocoaCallout>
                      ) : null}
                    </form>
                  ) : null}
                </CocoaSection>

                <CocoaSection title="Resumen" meta={guestLabel(reservation)}>
                  <ul className="c22-section__list">
                    <li>
                      <span>Adultos / niños</span>
                      <strong>
                        {reservation.adults} / {reservation.children}
                      </strong>
                    </li>
                    <li>
                      <span>{FIELD_LABELS.channel}</span>
                      <strong title={[reservation.channel, reservation.sourceCode, reservation.marketSegment].filter(Boolean).join(" / ") || undefined}>
                        {[
                          channelLabel(reservation.channel, { empty: "" }),
                          channelLabel(reservation.sourceCode, { empty: "" }),
                          marketSegmentLabel(reservation.marketSegment, { empty: "" })
                        ]
                          .filter(Boolean)
                          .join(" / ") || "Directo"}
                      </strong>
                    </li>
                    <li>
                      <span>Habitación asignada</span>
                      <strong className="cocoa-cluster">
                        <span data-cocoa="assigned-room">{assignedRoomNumber ?? "Sin asignar"}</span>
                        {assignedRoom ? <CocoaStatusBadge entry={roomStatus(assignedRoom.housekeepingStatus ?? assignedRoom.status)} dense /> : null}
                      </strong>
                    </li>
                    <li>
                      <span>Garantía</span>
                      <strong>{reservation.guaranteeType ?? "Sin definir"}</strong>
                    </li>
                    {reservation.companyName ? (
                      <li>
                        <span>Empresa (facturación)</span>
                        <strong>{reservation.companyName}</strong>
                      </li>
                    ) : null}
                    <li>
                      <span>{FIELD_LABELS.total}</span>
                      <strong>{money(reservation.totalAmount, reservation.currency)}</strong>
                    </li>
                  </ul>
                  {balancePrompt ? (
                    <CocoaCallout
                      tone="warning"
                      role="alert"
                      title={`Saldo pendiente${balancePrompt.balanceDue !== null ? `: ${money(balancePrompt.balanceDue, reservation.currency)}` : ""}`}
                      actions={
                        <>
                          <CocoaButton variant="tinted" tone="accent" size="small" disabled={busy} onClick={() => openPaymentDialog({ closeAfter: true })}>
                            {FRONT_DESK_ACTIONS.collectAndClose(money(balancePrompt.balanceDue ?? folio?.balanceDue ?? 0, reservation.currency))}
                          </CocoaButton>
                          <CocoaButton variant="bordered" tone="destructive" size="small" disabled={busy} onClick={() => void doCheckOut({ acknowledgeBalance: true })}>
                            {FRONT_DESK_ACTIONS.leaveWithBalance}
                          </CocoaButton>
                        </>
                      }
                    >
                      {balancePrompt.message} Cobra el saldo o confirma la salida dejando el saldo pendiente.
                    </CocoaCallout>
                  ) : null}
                </CocoaSection>

                <CocoaSection title={FIELD_LABELS.notes} meta={reservation.notes ? "guardada" : "sin nota"}>
                  <form
                    className="cocoa-stack"
                    data-gap="2"
                    aria-label="Nota de la reserva"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveNote();
                    }}
                  >
                    <CocoaField label="Nota" help={datesLocked ? RESERVATION_NOTES.noteLocked : RESERVATION_NOTES.noteHelp}>
                      <CocoaInput value={noteDraft} onChange={setNoteDraft} multiline rows={2} maxLength={2000} disabled={Boolean(datesLocked)} placeholder="Llega tarde; cuna en la habitación…" />
                    </CocoaField>
                    <div className="cocoa-row" data-gap="2">
                      <CocoaButton type="submit" variant="tinted" tone="accent" size="small" disabled={Boolean(datesLocked) || noteDraft.trim() === (reservation.notes ?? "").trim()}>
                        {RESERVATION_ACTIONS.saveNote}
                      </CocoaButton>
                    </div>
                  </form>
                </CocoaSection>
              </div>
            ) : null}

            {activeTab === "folio" ? (
              <div className="cocoa-stack" data-gap="3">
                <CocoaSection
                  title="Cargos"
                  meta={folio ? plural(lines.length, "línea", "líneas") : undefined}
                  padding={folio && lines.length > 0 ? "none" : "md"}
                  style={{ overflow: "clip" }}
                  footer={folio && lines.length > 0 ? <span>Total cargos {money(folio.chargesTotal, currency)}</span> : undefined}
                >
                  {folio ? (
                    lines.length > 0 ? (
                      <CocoaTable columns={lineColumns} rows={lines} rowKey="id" caption="Cargos del folio" aria-label="Cargos del folio" />
                    ) : (
                      <CocoaState kind="empty" inline title="Sin cargos todavía." />
                    )
                  ) : folioError ? (
                    <CocoaState kind="error" title="No se pudo cargar el folio" message={folioError} onRetry={folioState.refresh} />
                  ) : (
                    <CocoaTable columns={lineColumns} rows={[]} loading aria-label="Cargos del folio" />
                  )}
                </CocoaSection>

                {folio ? (
                  <>
                    <CocoaSection title={RESERVATION_ACTIONS.addCharge} meta={folioOpen ? "folio abierto" : "folio cerrado"}>
                      <form className="cocoa-stack" data-gap="2" aria-label={RESERVATION_ACTIONS.addCharge} onSubmit={onChargeSubmit}>
                        <CocoaFormRow columns={4} min={150}>
                          <CocoaField label={FIELD_LABELS.type}>
                            <CocoaSelect
                              value={chargeType}
                              onChange={(v) => {
                                setChargeType(v);
                                // Keep a description the operator already edited; refresh the default one.
                                setChargeDesc((current) => (current.trim() === "" || current === chargeTypeLabel(chargeType) ? chargeTypeLabel(v) : current));
                                setChargeTaxCategory(defaultTaxCategoryForType(v));
                              }}
                              options={CHARGE_TYPE_OPTIONS}
                              disabled={!folioOpen}
                            />
                          </CocoaField>
                          <CocoaField label={FIELD_LABELS.description}>
                            <CocoaInput value={chargeDesc} onChange={setChargeDesc} maxLength={500} disabled={!folioOpen} />
                          </CocoaField>
                          <CocoaField label="Importe (€)" help={RESERVATION_NOTES.chargeAmount} htmlFor={CHARGE_AMOUNT_ID}>
                            <CocoaInput id={CHARGE_AMOUNT_ID} value={chargeAmount} onChange={setChargeAmount} type="number" inputMode="decimal" min={0} step={0.01} placeholder="0,00" disabled={!folioOpen} />
                          </CocoaField>
                          <CocoaField label="Categoría fiscal" help="Determina el tipo de IVA al facturar; solo las categorías compatibles con el tipo de cargo.">
                            <CocoaSelect
                              value={chargeTaxCategory}
                              onChange={(v) => setChargeTaxCategory(v as TaxCategory)}
                              options={taxCategoryOptionsForType(chargeType, TAX_CATEGORY_OPTIONS).map((option) => ({ value: option.value, label: option.label }))}
                              disabled={!folioOpen}
                            />
                          </CocoaField>
                        </CocoaFormRow>
                        <div className="cocoa-row" data-gap="2">
                          <CocoaButton type="submit" variant="tinted" tone="accent" disabled={!folioId || !folioOpen || !(Number(chargeAmount.replace(",", ".")) > 0)}>
                            {RESERVATION_ACTIONS.addCharge}
                          </CocoaButton>
                          <span className="cocoa-note">{TAX_CATEGORY_LABELS[chargeTaxCategory]}</span>
                        </div>
                      </form>
                    </CocoaSection>

                    <CocoaSection title="Cobros y devoluciones" meta={plural(payments.length, "movimiento", "movimientos")}>
                      <p>
                        {payments.length > 0
                          ? `${plural(payments.length, "movimiento", "movimientos")} · cobrado neto ${money(folio.paymentsTotal, currency)}`
                          : "Sin cobros registrados en el folio."}
                      </p>
                      <div className="cocoa-row" data-gap="2">
                        <CocoaButton variant="bordered" tone="neutral" disabled={busy || refundablePayments(payments).length === 0} onClick={() => setRefundOpen(true)}>
                          Devolver un cobro
                        </CocoaButton>
                      </div>
                    </CocoaSection>
                  </>
                ) : null}
              </div>
            ) : null}

            {activeTab === "guests" ? (
              <CocoaSection title="Huéspedes" meta={plural((reservation.adults ?? 0) + (reservation.children ?? 0), "viajero", "viajeros")}>
                <ul className="c22-section__list">
                  <li>
                    <span>Titular</span>
                    <strong>{guestLabel(reservation)}</strong>
                  </li>
                  <li>
                    <span>Adultos</span>
                    <strong>{reservation.adults}</strong>
                  </li>
                  <li>
                    <span>Niños</span>
                    <strong>{reservation.children}</strong>
                  </li>
                  <li>
                    <span>Reserva a nombre de</span>
                    <strong>{reservation.bookerName ?? "Sin definir"}</strong>
                  </li>
                  <li>
                    <span>Huésped principal</span>
                    <strong>{primaryGuestName(reservation) ?? "Sin vincular"}</strong>
                  </li>
                  <li>
                    <span>Correo de contacto</span>
                    <strong>{reservation.bookerEmail ?? "Sin definir"}</strong>
                  </li>
                  <li>
                    <span>{FIELD_LABELS.room}</span>
                    <strong>{assignedRoomNumber ?? "Sin asignar"}</strong>
                  </li>
                </ul>
                <p>Los acompañantes y el parte de viajeros completo se gestionan en Cumplimiento › Registro de viajeros.</p>
                {reservation.primaryGuestId ? (
                  <div className="cocoa-row" data-gap="2">
                    <CocoaButton variant="bordered" tone="neutral" onClick={() => openGuest(reservation.primaryGuestId!)}>
                      Abrir ficha del huésped
                    </CocoaButton>
                  </div>
                ) : null}
              </CocoaSection>
            ) : null}

            {activeTab === "activity" ? (
              <CocoaSection
                title="Actividad"
                meta={activity ? plural(activity.items.length, "evento", "eventos") : "Auditoría"}
                padding={activity && activity.items.length > 0 ? "none" : "md"}
                style={{ overflow: "clip" }}
              >
                {activityLoading ? (
                  <CocoaTable columns={ACTIVITY_COLUMNS} rows={[]} loading aria-label="Actividad de la reserva" />
                ) : activityError ? (
                  <CocoaState kind="error" title="No se pudo cargar la actividad" message={activityError} onRetry={loadActivity} />
                ) : !activity || activity.items.length === 0 ? (
                  <CocoaState
                    kind="empty"
                    title="Sin actividad registrada"
                    message="Aún no hay eventos sobre esta reserva. Verás aquí la cronología en cuanto se produzca el primer cambio."
                  />
                ) : (
                  <CocoaTable
                    columns={ACTIVITY_COLUMNS}
                    rows={[...activity.items].sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))}
                    rowKey="id"
                    caption="Actividad de la reserva"
                    aria-label="Actividad de la reserva"
                  />
                )}
              </CocoaSection>
            ) : null}

            {activeTab === "documents" ? (
              <CocoaSection title="Documentos" meta={folio ? plural(lines.length, "cargo en el folio", "cargos en el folio") : undefined}>
                <div className="cocoa-stack" data-gap="3">
                  <p>El parte de viajeros se consulta en Cumplimiento › Registro de viajeros. La factura se crea aquí con los cargos del folio y se consulta en Finanzas › Facturación.</p>
                  <div className="cocoa-row" data-gap="2" role="group" aria-label="Factura desde la reserva">
                    <CocoaButton variant="bordered" tone="neutral" disabled={busy || !folioId || lines.length === 0} onClick={() => setInvoiceTarget("guest")}>
                      {RESERVATION_ACTIONS.invoiceToGuest}
                    </CocoaButton>
                    <CocoaButton variant="bordered" tone="neutral" disabled={busy || !folioId || lines.length === 0} onClick={() => setInvoiceTarget("company")}>
                      {RESERVATION_ACTIONS.invoiceToCompany}
                    </CocoaButton>
                  </div>
                  {folio && lines.length === 0 ? <p className="cocoa-note">El folio no tiene cargos que facturar todavía.</p> : null}
                </div>
              </CocoaSection>
            ) : null}
          </CocoaSpan>

          <CocoaSpan cols={4} min={240}>
            <div className="cocoa-stack" data-gap="3">
              <CocoaSection title="Importes" meta={folio ? (folioOpen ? "folio abierto" : "folio cerrado") : folioError ? "folio no disponible" : "cargando folio"}>
                <div className="cocoa-stack" data-gap="3">
                  <CocoaStat label="Total de la reserva" value={money(reservation.totalAmount, reservation.currency)} size="large" />
                  <CocoaStat
                    label="Saldo pendiente"
                    value={folio ? money(folio.balanceDue, currency) : "—"}
                    tone={folio ? (folio.balanceDue > 0 ? "warning" : folio.balanceDue < 0 ? "info" : "success") : undefined}
                    hint={folioError ?? undefined}
                  />
                  <CocoaStat label="Cargos" value={folio ? money(folio.chargesTotal, currency) : "—"} hint={folio ? plural(lines.length, "línea", "líneas") : undefined} />
                  <CocoaStat label="Cobrado neto" value={folio ? money(folio.paymentsTotal, currency) : "—"} hint={folio ? plural(payments.length, "movimiento", "movimientos") : undefined} />
                </div>
              </CocoaSection>
            </div>
          </CocoaSpan>
        </CocoaGrid>
      ) : null}

      {reservation && bar ? (
        <>
          <CocoaPopover open={roomPickerOpen} anchorEl={roomAnchor} placement="bottom" onClose={closeRoomPicker} role="dialog" aria-label={bar.room === "change" ? RESERVATION_ACTIONS.changeRoom : RESERVATION_ACTIONS.assignRoom}>
            <form className="cocoa-stack" data-gap="2" aria-label={bar.room === "change" ? RESERVATION_ACTIONS.changeRoom : RESERVATION_ACTIONS.assignRoom} onSubmit={onRoomPickerSubmit} onKeyDown={onRoomPickerKeyDown}>
              <CocoaField label={FIELD_LABELS.room} help={roomPickerLoading ? "Comprobando qué habitaciones están libres…" : roomCandidates.length <= (reservation.assignedRoomId ? 1 : 0) ? RESERVATION_NOTES.roomPickerEmpty : RESERVATION_NOTES.roomPickerHelp}>
                <CocoaSelect id={ROOM_PICKER_SELECT_ID} value={selectedRoomId} onChange={setSelectedRoomId} options={roomOptions} placeholder={roomPickerLoading ? "Cargando…" : "Selecciona habitación…"} disabled={roomPickerLoading || roomCandidates.length === 0} />
              </CocoaField>
              <div className="cocoa-row" data-gap="2">
                <CocoaButton type="submit" variant="tinted" tone="accent" size="small" disabled={!selectedRoomId || selectedRoomId === reservation.assignedRoomId}>
                  {selectedRoomId && selectedRoomId !== reservation.assignedRoomId ? RESERVATION_ACTIONS.moveTo(roomCandidates.find((room) => room.id === selectedRoomId)?.number ?? "") : ACTIONS.confirm}
                </CocoaButton>
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={closeRoomPicker}>
                  {ACTIONS.cancel}
                </CocoaButton>
              </div>
            </form>
          </CocoaPopover>
          <CocoaPopover open={moreOpen} anchorEl={moreAnchor} placement="bottom" onClose={() => setMoreOpen(false)} role="menu" aria-label={`${ACTIONS.moreActions} de ${reservation.code}`}>
            <div className="cocoa-stack" data-gap="1">
              {bar.more.map((kind) => (
                <CocoaButton key={kind} role="menuitem" variant="plain" tone={kind === "cancel" || kind === "no_show" || kind === "block_room" ? "destructive" : "neutral"} size="small" fullWidth align="start" onClick={() => runMore(kind)}>
                  {MORE_LABEL[kind]}
                </CocoaButton>
              ))}
            </div>
          </CocoaPopover>
        </>
      ) : null}

      {reservation && folioId && folio ? (
        <>
          <PaymentDialog
            open={payment !== null}
            onClose={() => setPayment(null)}
            folioId={folioId}
            propertyId={reservation.propertyId}
            currency={folio.folio.currency}
            balanceDue={folio.balanceDue}
            subject={`Reserva ${reservation.code}${assignedRoomNumber ? ` · Hab. ${assignedRoomNumber}` : ""}`}
            closeAfter={Boolean(payment?.closeAfter)}
            onCaptured={(_result, meta) => {
              invalidateReservation();
              invalidateApi("/dashboards/front-desk");
              if (meta.closeAfter) void doCheckOut({ afterPayment: true });
            }}
            onIntent={() => showToast("Intento de cobro creado: pendiente de la pasarela.", { variant: "info" })}
          />
          <RefundDialog
            open={refundOpen}
            onClose={() => setRefundOpen(false)}
            payments={folio.payments}
            currency={folio.folio.currency}
            onRefunded={() => {
              invalidateReservation();
              invalidateApi("/dashboards/front-desk");
            }}
          />
          <InvoiceFromReservationDialog
            open={invoiceTarget !== null}
            onClose={() => setInvoiceTarget(null)}
            folioId={folioId}
            reservation={reservation}
            customerType={invoiceTarget ?? undefined}
            onDone={() => {
              invalidateReservation();
              invalidateApi("/dashboards/front-desk");
            }}
          />
        </>
      ) : null}

      {reservation ? (
        <>
          <LifecycleDialog
            open={lifecycle !== null}
            mode={lifecycle ?? "cancellation"}
            reservation={{ id: reservation.id, code: reservation.code, currency: reservation.currency, propertyId: reservation.propertyId }}
            allowWaiver
            onClose={() => setLifecycle(null)}
            onDone={(result) => {
              void reservationState.mutate((prev) => ({ ...prev, status: result.status }), () => Promise.resolve()).catch(() => undefined);
              afterStayWrite();
            }}
          />
          <CocoaDialog
            open={blockOpen && assignedRoom !== null}
            onClose={() => setBlockOpen(false)}
            tone="destructive"
            title={`¿${RESERVATION_ACTIONS.blockRoomConfirm(assignedRoomNumber ?? "")}?`}
            description="La habitación sale del inventario vendible (fuera de servicio si está libre; si está ocupada, deja de venderse al salir el huésped). Se audita como cambio de estado."
            size="sm"
            confirmLabel={busy ? "Bloqueando…" : RESERVATION_ACTIONS.blockRoomConfirm(assignedRoomNumber ?? "")}
            cancelLabel={RESERVATION_ACTIONS.keepRoomOnSale}
            busy={busy}
            onConfirm={() => void blockRoom()}
          />
        </>
      ) : null}
    </CocoaPage>
  );
}
