// Front Desk Dashboard — Recepción, the base tab of Mi día (/hoy).
//
// Today's arrivals, departures, in-house stays and unassigned arrivals with
// the 90/60-second check-in / check-out drawers opened in place, the
// prioritised action queue and the first-run welcome card for a property
// without reservations yet.
//
// Cocoa 22 (ola 2 · lote 2-A): `CocoaPage` (hosted the container paints the
// H1; standalone eyebrow + H1 + subtitle), `CocoaKpiStrip` of `CocoaKpi`
// (three headline tiles + three risk tiles behind a toggle), the four tables
// as internal views of one `CocoaSection` (`CocoaSegmentedControl` + CSV
// export in a content toolbar, `CocoaTable` per view), `CocoaBadge` for the
// reservation / balance status, `CocoaState` for the empty tables and the
// shared toast (`useToast`) instead of a fixed local pill.
//
// Tanda UX-1 · lote U6 (docs/design/UX-RECEPCION-FEEL.md §5.1, §5.3, §6.2,
// §7.2, F2, F3, F4, F23, F25, F26, F32, R14):
//   · una acción primaria contextual por fila (`primaryActionFor`, P1): sin
//     habitación abre el cajón con la candidata («Check-in en 118»); no lista
//     lo abre con el override; el resto vive en el menú «⋯» con el id de la
//     reserva («Ver folio», «Asignar / Cambiar habitación», «Marcar no-show…»);
//   · selección múltiple + barra de lote («Check-out de N con saldo 0» en
//     serie con progreso, «Imprimir N fichas», «Asignar habitación a N»);
//   · inspector lateral no modal (Intro / clic en la fila; ↑↓ lo mueve) con la
//     misma barra de comandos, folio abreviado y «Abrir ficha completa» (⌥O);
//   · tiles clicables que filtran, VIP visible, buscador por nombre o
//     habitación (⌥F), Walk-in (⌥W) y Nueva reserva (⌥N) en cabecera;
//   · prefetch de reserva + folio al pasar el ratón o enfocar una fila (solo
//     con puntero fino); tras un check-in/out la fila se reconcilia con
//     `mutate` y los dashboards se invalidan en segundo plano (sin `refresh()`);
//   · recorrido guiado de 3 pasos la primera vez, por persona (localStorage).
// Sin `style={` nuevos (contrato Cocoa 22); los CTA salen de content/actions.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { fetchRoomTypes, fetchRooms } from "../../services/pmsCommerceApi";
import { fetchRatePlans } from "../../services/ratePlansApi";
import { invalidateApi, prefetchApi, useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getUser } from "../../services/auth-storage";
import { getGuideState } from "../../components/guide/guideStore";
import { useCoarsePointer } from "../../lib/useCoarsePointer";
import { exportToCsv, type CsvColumn } from "../../lib/csv";
import { useToast } from "../../components/Toast";
import { navigateTo } from "../../lib/navigate";
import { urlForScreen } from "../../navigation/nav-tree";
import { date, money, number, plural } from "../../lib/format";
import { ACTIONS, FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS, STATUS_LABELS } from "../../content/actions";
import { reservationStatus, roomStatus } from "../../content/status-dictionary";
import { FOCUS_SEARCH_EVENT, OPEN_WALK_IN_EVENT, shortcutKeys } from "../../content/shortcuts-registry";
import { OPEN_CHECKIN_EVENT, type HitActionDetail } from "../../components/CommandPalette";
import { CheckIcon } from "../../components/cocoa-icons/ActionIcons";
import { StarIcon } from "../../components/cocoa-icons/StatusIcons";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { CocoaGuidedTour, type CocoaGuidedTourStep } from "../../components/cocoa-guidance/CocoaGuidedTour";
import { FRONTDESK_COCKPIT_INSTRUCTIONS } from "../../content/screen-instructions/frontdesk-cockpit";
import { PaymentDialog } from "../../components/billing/PaymentDialog";
import { LifecycleDialog } from "../../components/reservations/LifecycleDialog";
import { FrontDeskActionQueue } from "./FrontDeskActionQueue";
import { QuickCheckInDrawer, type QuickCheckInCompleted } from "./QuickCheckInDrawer";
import { QuickCheckOutDrawer, type QuickCheckOutCompleted } from "./QuickCheckOutDrawer";
import { WalkInDrawer } from "./WalkInDrawer";
import { departsToday, primaryActionFor, secondaryActionsFor, type PrimaryAction, type SecondaryActionKind } from "./primaryAction";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaInspector,
  CocoaInspectorLayout,
  CocoaKbd,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaPopover,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaStatusBadge,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTableSelection
} from "../../components/cocoa";
import { BRAND } from "../../config/brand";

const PROPERTY_ID = getActivePropertyId();
const CATALOG_STALE_MS = 5 * 60_000;
const DASHBOARD_STALE_MS = 30_000;
const SEARCH_INPUT_ID = "frontdesk-search";

type Kpis = {
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  unassignedRooms: number;
  overdueDepartures: number;
  pendingBalanceEur: number;
};

/** Campos aditivos por fila (U3 → U6): ids para `mutate` / prefetch y VIP visible. */
type RowIds = {
  roomId?: string;
  roomTypeId?: string;
  assignedRoomId?: string | null;
  vip?: boolean;
};

type ArrivalRow = RowIds & {
  reservationId: string;
  guestName: string;
  arrivalDate: string;
  nights: number;
  roomNumber?: string;
  roomTypeName?: string;
  status: string;
  balanceEur: number;
  specialRequests?: string;
};

type DepartureRow = RowIds & {
  reservationId: string;
  guestName: string;
  departureDate: string;
  roomNumber?: string;
  balanceEur: number;
  status: string;
};

type InHouseRow = RowIds & {
  reservationId: string;
  guestName: string;
  roomNumber?: string;
  departureDate: string;
  nightsRemaining: number;
  balanceEur: number;
  status: string;
};

type UnassignedRow = RowIds & {
  reservationId: string;
  guestName: string;
  arrivalDate: string;
  roomTypeName?: string;
  preferences?: string;
};

export type FrontDeskDashboardData = {
  kpis: Kpis;
  arrivals: ArrivalRow[];
  departures: DepartureRow[];
  inHouse: InHouseRow[];
  unassigned: UnassignedRow[];
};

export type RoomLite = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable?: boolean };

export type FrontDeskTab = "arrivals" | "departures" | "inhouse" | "unassigned";

/** Fila normalizada de Mi día (las cuatro tablas comparten acción primaria, menú, inspector y lote). */
export type FrontDeskRow = {
  tab: FrontDeskTab;
  reservationId: string;
  guestName: string;
  status: string;
  roomId?: string;
  roomNumber?: string;
  roomTypeId?: string;
  roomTypeName?: string;
  arrivalDate?: string;
  departureDate?: string;
  nights?: number;
  nightsRemaining?: number;
  balanceEur: number;
  vip: boolean;
  specialRequests?: string;
};

type FolioLite = {
  folio: { id: string; status: string; currency: string };
  lines: Array<{ id: string; description: string; total: number }>;
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

type ReservationLite = { id: string; code: string; currency?: string; arrivalDate: string; departureDate: string; adults?: number; status: string; propertyId: string };

function fmtNumber(value: number | null | undefined): string {
  return number(value);
}

function fmtEur(value: number | null | undefined): string {
  return money(value);
}

function fmtDay(iso: string | null | undefined): string {
  return date(iso, "dayMonth");
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 6 && h < 13) return "Buenos días";
  if (h >= 13 && h < 20) return "Buenas tardes";
  return "Buenas noches";
}

function todayLabel(): string {
  const label = date(new Date(), "weekday");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Hoy en ISO local (la fecha con la que se decide «sale hoy»). */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Estado de reserva: etiqueta, tono e icono del diccionario común (UX-1 · U2, D5).
function statusBadge(status: string) {
  return <CocoaStatusBadge entry={reservationStatus(status)} />;
}

function balanceBadge(value: number) {
  if (!Number.isFinite(value) || value === 0) return <CocoaBadge tone="success" size="small">saldado</CocoaBadge>;
  if (value > 0) return <CocoaBadge tone="warning" size="small">pendiente</CocoaBadge>;
  // Saldo negativo en un folio abierto = cobro por adelantado (walk-in, depósito): «anticipo», no «a favor» (L-18, P7).
  return <CocoaBadge tone="info" size="small">anticipo</CocoaBadge>;
}

function openSearch() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-open-search"));
  }
}

// Secondary cell text (caption, secondary ink); layout from the utilities.
const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

const mutedCellStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

const bodyTextStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label-secondary)" };

// ---------------------------------------------------------------- U6 · funciones puras (testables sin DOM)

/** «limpia» = housekeepingStatus clean | inspected (vocabulario cerrado de L5-A). */
export function isRoomClean(room: Pick<RoomLite, "housekeepingStatus">): boolean {
  const hk = (room.housekeepingStatus ?? "").trim().toLowerCase();
  return hk === "clean" || hk === "inspected";
}

/** Libre para asignar: vendible y ni ocupada ni bloqueada ni fuera de servicio (F24). */
export function isRoomFree(room: Pick<RoomLite, "status" | "sellable">): boolean {
  if (room.sellable === false) return false;
  const status = (room.status ?? "").trim().toLowerCase();
  return status !== "occupied" && status !== "blocked" && status !== "out_of_order" && status !== "ooo" && status !== "out_of_service";
}

/** Candidatas para una reserva: limpias y libres del tipo, por número. */
export function candidateRoomsFor(rooms: readonly RoomLite[], roomTypeId: string | undefined, exclude: ReadonlySet<string> = new Set()): RoomLite[] {
  if (!roomTypeId) return [];
  return rooms.filter((room) => room.roomTypeId === roomTypeId && !exclude.has(room.id) && isRoomFree(room) && isRoomClean(room)).sort((a, b) => a.number.localeCompare(b.number, "es", { numeric: true }));
}

/** La habitación que el motor propone (R14): la primera limpia y libre del tipo; null si no hay. */
export function suggestedRoomFor(row: Pick<FrontDeskRow, "roomTypeId" | "roomNumber">, rooms: readonly RoomLite[]): RoomLite | null {
  if (row.roomNumber) return null;
  return candidateRoomsFor(rooms, row.roomTypeId)[0] ?? null;
}

/** Las cuatro tablas como filas normalizadas. */
export function toFrontDeskRows(data: FrontDeskDashboardData | null | undefined, tab: FrontDeskTab): FrontDeskRow[] {
  if (!data) return [];
  const base = (row: RowIds & { reservationId: string; guestName: string; roomNumber?: string }) => ({
    reservationId: row.reservationId,
    guestName: row.guestName,
    roomId: row.roomId ?? row.assignedRoomId ?? undefined,
    roomNumber: row.roomNumber,
    roomTypeId: row.roomTypeId,
    vip: row.vip === true
  });
  switch (tab) {
    case "arrivals":
      return data.arrivals.map((row) => ({ ...base(row), tab, status: row.status, roomTypeName: row.roomTypeName, arrivalDate: row.arrivalDate, nights: row.nights, balanceEur: row.balanceEur, specialRequests: row.specialRequests }));
    case "departures":
      return data.departures.map((row) => ({ ...base(row), tab, status: row.status, departureDate: row.departureDate, balanceEur: row.balanceEur }));
    case "inhouse":
      return data.inHouse.map((row) => ({ ...base(row), tab, status: row.status, departureDate: row.departureDate, nightsRemaining: row.nightsRemaining, balanceEur: row.balanceEur }));
    case "unassigned":
      return data.unassigned.map((row) => ({ ...base(row), tab, status: "confirmed", roomTypeName: row.roomTypeName, arrivalDate: row.arrivalDate, balanceEur: 0, specialRequests: row.preferences }));
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Buscador de la pestaña (§5.1 (6)): nombre, habitación, código en las peticiones o id; y el filtro «con saldo» de la tile. */
export function filterFrontDeskRows(rows: readonly FrontDeskRow[], query: string, onlyBalance = false): FrontDeskRow[] {
  const q = normalizeText(query);
  return rows.filter((row) => {
    if (onlyBalance && !(row.balanceEur > 0.005)) return false;
    if (!q) return true;
    return [row.guestName, row.roomNumber, row.reservationId, row.specialRequests, row.roomTypeName].some((field) => normalizeText(field).includes(q));
  });
}

/** Actualización optimista tras un check-in (la reserva devuelta por el API manda). */
export function applyCheckInToDashboard(data: FrontDeskDashboardData, reservationId: string, room: { roomId?: string | null; roomNumber?: string | null }): FrontDeskDashboardData {
  const wasUnassigned = data.unassigned.some((row) => row.reservationId === reservationId);
  const arrivals = data.arrivals.map((row) => (row.reservationId === reservationId ? { ...row, status: "checked_in", roomId: room.roomId ?? row.roomId, assignedRoomId: room.roomId ?? row.assignedRoomId ?? null, roomNumber: room.roomNumber ?? row.roomNumber } : row));
  const unassigned = data.unassigned.filter((row) => row.reservationId !== reservationId);
  const kpis = { ...data.kpis, inHouseNow: data.kpis.inHouseNow + 1, unassignedRooms: Math.max(0, data.kpis.unassignedRooms - (wasUnassigned ? 1 : 0)) };
  return { ...data, kpis, arrivals, unassigned };
}

/** Actualización optimista tras un check-out. */
export function applyCheckOutToDashboard(data: FrontDeskDashboardData, reservationId: string): FrontDeskDashboardData {
  const wasInHouse = data.inHouse.some((row) => row.reservationId === reservationId) || data.departures.some((row) => row.reservationId === reservationId && row.status === "checked_in");
  const departures = data.departures.map((row) => (row.reservationId === reservationId ? { ...row, status: "checked_out", balanceEur: 0 } : row));
  const inHouse = data.inHouse.filter((row) => row.reservationId !== reservationId);
  const kpis = { ...data.kpis, inHouseNow: Math.max(0, data.kpis.inHouseNow - (wasInHouse ? 1 : 0)) };
  return { ...data, kpis, departures, inHouse };
}

/** Actualización optimista tras marcar no-show. */
export function applyNoShowToDashboard(data: FrontDeskDashboardData, reservationId: string): FrontDeskDashboardData {
  const wasUnassigned = data.unassigned.some((row) => row.reservationId === reservationId);
  const wasArrival = data.arrivals.some((row) => row.reservationId === reservationId);
  const arrivals = data.arrivals.map((row) => (row.reservationId === reservationId ? { ...row, status: "no_show" } : row));
  const unassigned = data.unassigned.filter((row) => row.reservationId !== reservationId);
  const kpis = { ...data.kpis, arrivalsToday: Math.max(0, data.kpis.arrivalsToday - (wasArrival ? 1 : 0)), unassignedRooms: Math.max(0, data.kpis.unassignedRooms - (wasUnassigned ? 1 : 0)) };
  return { ...data, kpis, arrivals, unassigned };
}

/** Actualización optimista tras asignar o cambiar la habitación. */
export function applyRoomToDashboard(data: FrontDeskDashboardData, reservationId: string, room: { id: string; number: string }): FrontDeskDashboardData {
  const patch = <T extends RowIds & { reservationId: string; roomNumber?: string }>(row: T): T => (row.reservationId === reservationId ? ({ ...row, roomId: room.id, assignedRoomId: room.id, roomNumber: room.number } as T) : row);
  const wasUnassigned = data.unassigned.some((row) => row.reservationId === reservationId);
  return {
    ...data,
    kpis: { ...data.kpis, unassignedRooms: Math.max(0, data.kpis.unassignedRooms - (wasUnassigned ? 1 : 0)) },
    arrivals: data.arrivals.map(patch),
    departures: data.departures.map(patch),
    inHouse: data.inHouse.map(patch),
    unassigned: data.unassigned.filter((row) => row.reservationId !== reservationId)
  };
}

/**
 * Filas seleccionadas que admiten «Check-out de N con saldo 0»: en el hotel,
 * sin saldo Y que salen hoy o ya debían haber salido (corrector UX1-REV-01:
 * ⌘A sobre «En el hotel» nunca cierra estancias en curso; el check-out no
 * tiene reversa en el API, D9).
 */
export function batchCheckOutCandidates(rows: readonly FrontDeskRow[], selectedKeys: ReadonlyArray<string>, today: string): FrontDeskRow[] {
  const selected = new Set(selectedKeys);
  return rows.filter((row) => selected.has(row.reservationId) && row.status === "checked_in" && !(row.balanceEur > 0.005) && departsToday(row.departureDate, today));
}

/** Texto nominal del diálogo del lote (§4.2: irreversible → diálogo con lo que va a pasar): habitaciones o códigos. */
export function batchCheckOutSummaryText(rows: readonly FrontDeskRow[]): string {
  const labels = rows.map((row) => (row.roomNumber ? `la ${row.roomNumber}` : row.reservationId));
  return `Se cerrarán ${rows.length === 1 ? "la estancia" : `${rows.length} estancias`} con saldo 0 que salen hoy (${labels.join(", ")}). Las habitaciones pasarán a sucia y el check-out no se puede deshacer.`;
}

/** Filas seleccionadas sin habitación con una candidata limpia y libre cada una (una habitación nunca se repite en el lote). */
export function batchAssignPlan(rows: readonly FrontDeskRow[], selectedKeys: ReadonlyArray<string>, rooms: readonly RoomLite[]): Array<{ row: FrontDeskRow; room: RoomLite }> {
  const selected = new Set(selectedKeys);
  const used = new Set<string>();
  const plan: Array<{ row: FrontDeskRow; room: RoomLite }> = [];
  for (const row of rows) {
    if (!selected.has(row.reservationId) || row.roomNumber || row.status !== "confirmed") continue;
    const room = candidateRoomsFor(rooms, row.roomTypeId, used)[0];
    if (!room) continue;
    used.add(room.id);
    plan.push({ row, room });
  }
  return plan;
}

export type BatchOutcome<T> = { done: number; failed: Array<{ item: T; message: string }>; cancelled: boolean };

/** Ejecuta N acciones EN SERIE con progreso y cancelación del resto (§6.1 «Lote de N check-outs»). */
export async function runBatch<T>(items: readonly T[], run: (item: T) => Promise<void>, options: { onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean } = {}): Promise<BatchOutcome<T>> {
  const outcome: BatchOutcome<T> = { done: 0, failed: [], cancelled: false };
  for (const item of items) {
    if (options.isCancelled?.()) {
      outcome.cancelled = true;
      break;
    }
    try {
      await run(item);
      outcome.done += 1;
    } catch (error) {
      outcome.failed.push({ item, message: error instanceof Error ? error.message : "error" });
    }
    options.onProgress?.(outcome.done + outcome.failed.length, items.length);
  }
  return outcome;
}

/** «3 de 5» y, pasados 10 s (NN/g), el porcentaje. */
export function batchProgressLabel(done: number, total: number, elapsedMs: number): string {
  const base = `${done} de ${total}`;
  return elapsedMs > 10_000 && total > 0 ? `${base} · ${Math.round((done / total) * 100)} %` : base;
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

/** Documento imprimible de las fichas de registro seleccionadas (una por página; sin nombres fuera de las filas). */
export function registrationCardsHtml(rows: readonly FrontDeskRow[], propertyName: string): string {
  const cards = rows
    .map(
      (row) => `<section class="card">
  <h2>${escapeHtml(propertyName)} · Ficha de registro</h2>
  <dl>
    <dt>Huésped</dt><dd>${escapeHtml(row.guestName)}</dd>
    <dt>Reserva</dt><dd>${escapeHtml(row.reservationId)}</dd>
    <dt>Habitación</dt><dd>${escapeHtml(row.roomNumber ?? "Sin asignar")}${row.roomTypeName ? ` · ${escapeHtml(row.roomTypeName)}` : ""}</dd>
    <dt>Llegada</dt><dd>${escapeHtml(row.arrivalDate ?? "—")}</dd>
    <dt>Salida</dt><dd>${escapeHtml(row.departureDate ?? "—")}</dd>
    <dt>Peticiones</dt><dd>${escapeHtml(row.specialRequests ?? "—")}</dd>
  </dl>
  <p class="sign">Firma del huésped: ______________________________</p>
</section>`
    )
    .join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Fichas de registro</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}.card{page-break-after:always;border:1px solid;padding:24px;margin-bottom:24px}h2{font-size:18px;margin:0 0 16px}dl{display:grid;grid-template-columns:140px 1fr;gap:8px 16px;margin:0}dt{font-weight:600}dd{margin:0}.sign{margin-top:32px}</style>
</head><body>${cards}</body></html>`;
}

// ---------------------------------------------------------------- U0a · acciones de fila (puras, testables sin DOM)

/**
 * F2 · «Hacer check-in» se ofrece a toda reserva confirmada, tenga o no
 * habitación: el drawer asigna y propone la primera limpia del tipo reservado.
 */
export function canCheckInRow(row: { status: string }): boolean {
  return row.status === "confirmed";
}

/** Tooltip del botón de check-in, coherente con `canCheckInRow`. */
export function checkInTooltipFor(row: { status: string; roomNumber?: string }): string {
  if (row.status === "checked_in") return "Ya hizo el check-in";
  if (row.status === "checked_out") return "Ya hizo el check-out";
  if (row.status === "cancelled" || row.status === "no_show") return "Reserva cerrada";
  if (row.status !== "confirmed") return "La reserva no está confirmada";
  if (!row.roomNumber) return "Sin habitación: el check-in te propondrá una limpia";
  return "Check-in disponible";
}

/** F3 · URL de la ficha de una reserva concreta (`/recepcion/reservas/:id`); null si el árbol no la conoce. */
export function reservationDetailUrl(reservationId: string): string | null {
  return urlForScreen("ReservationDetailWorkspace", { id: reservationId });
}

/** Abre la ficha de la reserva sin perderla (mismo patrón que la cola, FrontDeskActionQueue). */
function openReservationDetail(reservationId: string): void {
  const url = reservationDetailUrl(reservationId);
  if (url) openTabPath(url);
}

// ---------------------------------------------------------------- bienvenida de primera ejecución

type FirstRunStepKey = "rooms" | "roomTypes" | "ratePlans" | "reservation";
type FirstRunStep = { key: FirstRunStepKey; label: string; screen: "RoomInventoryManager" | "RoomTypeManager" | "RevenueSettings" | "ReservationCreate" };
type FirstRunProgress = Record<Exclude<FirstRunStepKey, "reservation">, boolean | null>;

const FIRST_RUN_STEPS: FirstRunStep[] = [
  { key: "rooms", label: "1. Crear habitaciones", screen: "RoomInventoryManager" },
  { key: "roomTypes", label: "2. Tipos de habitación", screen: "RoomTypeManager" },
  { key: "ratePlans", label: "3. Plan tarifario", screen: "RevenueSettings" },
  { key: "reservation", label: "4. Primera reserva", screen: "ReservationCreate" }
];

async function probeHasRows(load: () => Promise<unknown[]>): Promise<boolean | null> {
  try {
    const rows = await load();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    // Endpoint missing or transient failure: unknown, not "pending".
    return null;
  }
}

function FirstRunWelcomeCard({ propertyId }: { propertyId: string }) {
  const [progress, setProgress] = useState<FirstRunProgress>({ rooms: null, roomTypes: null, ratePlans: null });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([probeHasRows(() => fetchRooms(propertyId)), probeHasRows(() => fetchRoomTypes(propertyId)), probeHasRows(() => fetchRatePlans(propertyId))]).then(([rooms, roomTypes, ratePlans]) => {
      if (!cancelled) setProgress({ rooms, roomTypes, ratePlans });
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  const setupDone = progress.rooms === true && progress.roomTypes === true && progress.ratePlans === true;
  const stepDone = (step: FirstRunStep): boolean => step.key !== "reservation" && progress[step.key] === true;

  return (
    <CocoaSection variant="elevated" padding="lg" headingLevel={2} title={setupDone ? "Todo listo: registra la primera reserva" : "Configura tu hotel en 4 pasos"} meta={`Bienvenido a ${BRAND.name}`}>
      <div className="cocoa-stack" data-gap="3">
        <p style={bodyTextStyle}>
          {setupDone
            ? "Habitaciones, tipos de habitación y plan tarifario ya están configurados. Solo falta la primera reserva para que recepción empiece a operar."
            : "Empieza por dar de alta tu inventario y crea la primera reserva. Estos cuatro pasos cubren lo mínimo para que recepción pueda operar."}
        </p>
        <div className="cocoa-row" data-gap="2">
          {FIRST_RUN_STEPS.map((step) => {
            const done = stepDone(step);
            // The only pending step gets the accent so the eye lands on it.
            const isNext = setupDone && step.key === "reservation";
            return (
              <CocoaButton key={step.screen} variant={isNext ? "filled" : "bordered"} tone={isNext ? "accent" : "neutral"} size="regular" icon={done ? <CheckIcon size={14} /> : undefined} onClick={() => navigateTo(step.screen)} aria-label={done ? `${step.label} (hecho) · revisar` : `Ir a ${step.label}`}>
                {step.label}
              </CocoaButton>
            );
          })}
        </div>
      </div>
    </CocoaSection>
  );
}

// Mirror skeleton: KPI strip, the queue card and the tables card.
function FrontDeskSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={200} />
      <CocoaSkeleton.Strip count={3} label="Cargando indicadores de hoy…" />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

// ---------------------------------------------------------------- acciones de fila (primaria + menú «⋯»)

type RowActionHandlers = {
  onPrimary: (row: FrontDeskRow, action: PrimaryAction) => void;
  onSecondary: (row: FrontDeskRow, kind: SecondaryActionKind, room?: RoomLite) => void;
};

const SECONDARY_LABEL: Record<SecondaryActionKind, string> = {
  view_folio: FRONT_DESK_ACTIONS.viewFolio,
  assign_room: FRONT_DESK_ACTIONS.assignRoom,
  change_room: FRONT_DESK_ACTIONS.changeRoom,
  mark_no_show: FRONT_DESK_ACTIONS.markNoShow,
  open_full: FRONT_DESK_ACTIONS.openFullReservation
};

/** Menú «⋯» de una fila (P1: una sola acción `filled`; el resto aquí, siempre con el id de la reserva). */
function RowMenu({ row, rooms, onSecondary, onOpen, size = "small" }: { row: FrontDeskRow; rooms: readonly RoomLite[]; onSecondary: RowActionHandlers["onSecondary"]; onOpen?: () => void; size?: "small" | "regular" }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [picking, setPicking] = useState(false);
  const kinds = secondaryActionsFor(row);
  const candidates = useMemo(() => candidateRoomsFor(rooms, row.roomTypeId, new Set(row.roomId ? [row.roomId] : [])), [rooms, row.roomTypeId, row.roomId]);
  const close = useCallback(() => {
    setOpen(false);
    setPicking(false);
  }, []);
  return (
    <>
      <CocoaButton
        ref={setAnchor}
        variant="plain"
        tone="neutral"
        size={size}
        aria-label={`${ACTIONS.moreActions} de ${row.guestName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={ACTIONS.moreActions}
        onClick={() => {
          onOpen?.();
          setOpen((value) => !value);
        }}
      >
        ⋯
      </CocoaButton>
      <CocoaPopover open={open} anchorEl={anchor} placement="bottom" onClose={close} role="menu" aria-label={`${ACTIONS.moreActions} de ${row.guestName}`}>
        <div className="cocoa-stack" data-gap="1">
          {picking ? (
            <>
              <span className="cocoa-caption">{FRONT_DESK_ACTIONS.changeRoom}</span>
              {candidates.length === 0 ? <span className="cocoa-note">Sin habitaciones limpias y libres de este tipo.</span> : null}
              {candidates.slice(0, 8).map((room) => (
                <CocoaButton
                  key={room.id}
                  role="menuitem"
                  variant="plain"
                  tone="neutral"
                  size="small"
                  fullWidth
                  align="start"
                  onClick={() => {
                    close();
                    onSecondary(row, "change_room", room);
                  }}
                >
                  {FRONT_DESK_ACTIONS.changeRoomTo(room.number)}
                </CocoaButton>
              ))}
              <CocoaButton role="menuitem" variant="plain" tone="neutral" size="small" fullWidth align="start" onClick={() => setPicking(false)}>
                {ACTIONS.back}
              </CocoaButton>
            </>
          ) : (
            kinds.map((kind) => (
              <CocoaButton
                key={kind}
                role="menuitem"
                variant="plain"
                tone={kind === "mark_no_show" ? "destructive" : "neutral"}
                size="small"
                fullWidth
                align="start"
                onClick={() => {
                  if (kind === "change_room") {
                    setPicking(true);
                    return;
                  }
                  close();
                  onSecondary(row, kind);
                }}
              >
                {SECONDARY_LABEL[kind]}
              </CocoaButton>
            ))
          )}
        </div>
      </CocoaPopover>
    </>
  );
}

// ---------------------------------------------------------------- inspector lateral (§5.1 (4), F26)

function RowInspector({ row, rooms, primary, today, onClose, onPrimary, onSecondary, returnFocusTo }: { row: FrontDeskRow; rooms: readonly RoomLite[]; primary: PrimaryAction; today: string; onClose: () => void; onPrimary: RowActionHandlers["onPrimary"]; onSecondary: RowActionHandlers["onSecondary"]; returnFocusTo: () => HTMLElement | null }) {
  const reservationState = useApiData<ReservationLite>(`/reservations/${row.reservationId}`, { staleTime: DASHBOARD_STALE_MS });
  const folioState = useApiData<FolioLite>(`/reservations/${row.reservationId}/folio`, { staleTime: DASHBOARD_STALE_MS });
  const reservation = reservationState.data;
  const folio = folioState.data;
  // El folio manda sobre la fila en cuanto llega (misma derivación que la fila).
  const action = folio ? primaryActionFor({ ...row, balanceEur: folio.balanceDue }, { balanceDue: folio.balanceDue }, today, (amount) => money(amount, folio.folio.currency)) : primary;
  const balance = folio ? folio.balanceDue : row.balanceEur;
  const title = `${reservation?.code ?? row.guestName} · ${reservationStatus(row.status).label}${row.roomNumber ? ` · ${row.roomNumber}` : ""}`;
  return (
    <CocoaInspector open title={title} aria-label={`Detalle de ${row.guestName}`} onClose={onClose} returnFocusTo={returnFocusTo} width="md" commands={
      <>
        <CocoaButton variant="filled" tone="accent" size="small" accessKey="C" onClick={() => onPrimary(row, action)} data-tour="frontdesk-inspector-primary">
          {action.label}
        </CocoaButton>
        {action.kind !== "pay" && balance > 0.005 ? (
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => onPrimary(row, { kind: "pay", label: FRONT_DESK_ACTIONS.collect(fmtEur(balance)), amount: balance })}>
            {FRONT_DESK_ACTIONS.collect(fmtEur(balance))}
          </CocoaButton>
        ) : null}
        <RowMenu row={row} rooms={rooms} onSecondary={onSecondary} size="small" />
      </>
    }>
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-stack" data-gap="1">
          <div className="cocoa-row" data-gap="2">
            <strong>{row.guestName}</strong>
            {row.vip ? (
              <CocoaBadge tone="accent" variant="tinted" size="small" uppercase={false} icon={<StarIcon size={10} />}>
                VIP
              </CocoaBadge>
            ) : null}
          </div>
          <span className="cocoa-note">
            {reservation ? `${fmtDay(reservation.arrivalDate)} → ${fmtDay(reservation.departureDate)}` : row.arrivalDate ? `Llega ${fmtDay(row.arrivalDate)}` : row.departureDate ? `Sale ${fmtDay(row.departureDate)}` : ""}
            {reservation?.adults ? ` · ${plural(reservation.adults, "adulto", "adultos")}` : ""}
            {row.roomTypeName ? ` · ${row.roomTypeName}` : ""}
          </span>
          {row.specialRequests ? <span className="cocoa-note">{row.specialRequests}</span> : null}
        </div>
        <CocoaSection title="Folio" meta={folio ? <CocoaBadge tone={folio.balanceDue > 0.005 ? "warning" : "success"} size="small" uppercase={false}>{fmtEur(folio.balanceDue)}</CocoaBadge> : folioState.loading ? <CocoaBadge tone="info" size="small">{STATUS_LABELS.loading}</CocoaBadge> : undefined}>
          {folioState.error ? (
            <CocoaCallout tone="warning" role="status">
              {folioState.error}
            </CocoaCallout>
          ) : folio ? (
            <ul className="c22-section__list" aria-label="Folio abreviado">
              {folio.lines.slice(0, 5).map((line) => (
                <li key={line.id}>
                  <span>{line.description}</span>
                  <strong>{fmtEur(line.total)}</strong>
                </li>
              ))}
              {folio.lines.length > 5 ? (
                <li>
                  <span className="cocoa-note">{plural(folio.lines.length - 5, "línea más", "líneas más")}</span>
                  <span />
                </li>
              ) : null}
              <li>
                <span>Cargos · pagos</span>
                <strong>
                  {fmtEur(folio.chargesTotal)} · {fmtEur(folio.paymentsTotal)}
                </strong>
              </li>
              <li>
                <span>Saldo</span>
                <strong>{fmtEur(folio.balanceDue)}</strong>
              </li>
            </ul>
          ) : (
            <CocoaSkeleton variant="row" lines={3} />
          )}
        </CocoaSection>
        <div className="cocoa-row" data-gap="2">
          <CocoaButton variant="plain" tone="accent" size="small" accessKey="O" onClick={() => openReservationDetail(row.reservationId)}>
            {FRONT_DESK_ACTIONS.openFullReservation}
          </CocoaButton>
        </div>
      </div>
    </CocoaInspector>
  );
}

// ---------------------------------------------------------------- pantalla

type BatchState = { label: string; done: number; total: number; startedAt: number } | null;

export function FrontDeskDashboard() {
  const { showToast } = useToast();
  const coarse = useCoarsePointer();
  const today = todayIso();
  const { data, loading, error, refresh, mutate } = useApiData<FrontDeskDashboardData>(`/dashboards/front-desk?propertyId=${PROPERTY_ID}`, { pollIntervalMs: 30000, staleTime: DASHBOARD_STALE_MS });

  // Drawers in-place — abren el flujo de check-in/check-out de 90/60 s sin
  // perder el contexto del dashboard. Solo conservamos el reservationId porque
  // los drawers cargan la reserva completa desde la caché compartida.
  const [checkInTarget, setCheckInTarget] = useState<{ reservationId: string; roomId?: string | null } | null>(null);
  const [checkOutTarget, setCheckOutTarget] = useState<string | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<{ row: FrontDeskRow; folioId: string; balanceDue: number; currency: string } | null>(null);
  const [noShowTarget, setNoShowTarget] = useState<{ row: FrontDeskRow; code: string; currency?: string } | null>(null);
  const [activeTab, setActiveTab] = useState<FrontDeskTab>("arrivals");
  const [showRiskKpis, setShowRiskKpis] = useState(false);
  const [search, setSearch] = useState("");
  const [onlyBalance, setOnlyBalance] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchState>(null);
  const batchCancel = useRef(false);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const lastPrefetched = useRef<string | null>(null);

  const arrivals = useMemo(() => data?.arrivals ?? [], [data]);
  const departures = useMemo(() => data?.departures ?? [], [data]);
  const inHouse = useMemo(() => data?.inHouse ?? [], [data]);
  const unassigned = useMemo(() => data?.unassigned ?? [], [data]);

  // Habitaciones (catálogo 5 min): solo cuando hace falta proponer una («Check-in en 118», asignar, cambiar).
  const [roomsWanted, setRoomsWanted] = useState(false);
  const needsRooms = roomsWanted || unassigned.length > 0 || arrivals.some((row) => !row.roomNumber && row.status === "confirmed");
  const roomsState = useApiData<RoomLite[]>(`/properties/${PROPERTY_ID}/rooms`, { staleTime: CATALOG_STALE_MS, enabled: needsRooms });
  const rooms = useMemo(() => roomsState.data ?? [], [roomsState.data]);

  function notify(kind: "ok" | "warn" | "error", text: string) {
    showToast(text, { variant: kind === "ok" ? "success" : kind === "warn" ? "warning" : "error", duration: 5000 });
  }

  const kpis: Kpis = data?.kpis ?? { arrivalsToday: 0, departuresToday: 0, inHouseNow: 0, unassignedRooms: 0, overdueDepartures: 0, pendingBalanceEur: 0 };

  // Filas normalizadas de la pestaña activa, filtradas por el buscador y la tile «Saldo pendiente».
  const tabRows = useMemo(() => toFrontDeskRows(data, activeTab), [data, activeTab]);
  const visibleRows = useMemo(() => filterFrontDeskRows(tabRows, search, onlyBalance), [tabRows, search, onlyBalance]);
  const rowById = useMemo(() => new Map(visibleRows.map((row) => [row.reservationId, row])), [visibleRows]);
  const inspectorRow = inspectorId ? rowById.get(inspectorId) ?? null : null;

  const primaryFor = useCallback(
    (row: FrontDeskRow): PrimaryAction => primaryActionFor({ ...row, suggestedRoomNumber: suggestedRoomFor(row, rooms)?.number ?? null }, null, today, fmtEur),
    [rooms, today]
  );

  // Cambio de pestaña o de filtro: fuera la selección (el inspector sigue si la fila sigue visible).
  useEffect(() => {
    setSelectedKeys([]);
  }, [activeTab]);
  useEffect(() => {
    if (inspectorId && !rowById.has(inspectorId)) setInspectorId(null);
  }, [inspectorId, rowById]);

  // ---------------------------------------------------------------- reconciliación tras los cajones (F23)
  // L-17 / §4.1: la fila pasa a «En el hotel» al pulsar el CTA (optimista) y se reconcilia con la respuesta;
  // si el API rechaza (409 saldo, fecha…), el dashboard se revalida y la fila vuelve a su estado.
  const optimisticCheckIn = useCallback(
    (info: { reservationId: string; roomId: string | null; roomNumber: string | null }) => {
      void mutate((prev) => applyCheckInToDashboard(prev, info.reservationId, { roomId: info.roomId, roomNumber: info.roomNumber }), () => Promise.resolve()).catch(() => undefined);
    },
    [mutate]
  );
  const rollbackCheckIn = useCallback(() => {
    invalidateApi("/dashboards/front-desk");
  }, []);
  const reconcileCheckIn = useCallback(
    (info: QuickCheckInCompleted) => {
      const roomId = info.reservation?.assignedRoomId ?? undefined;
      void mutate((prev) => applyCheckInToDashboard(prev, info.reservationId, { roomId, roomNumber: info.roomNumber }), () => Promise.resolve()).catch(() => undefined);
      invalidateApi("/dashboards/front-desk");
    },
    [mutate]
  );
  const reconcileCheckOut = useCallback(
    (info: QuickCheckOutCompleted) => {
      void mutate((prev) => applyCheckOutToDashboard(prev, info.reservationId), () => Promise.resolve()).catch(() => undefined);
      invalidateApi("/dashboards/front-desk");
    },
    [mutate]
  );

  // ---------------------------------------------------------------- acciones de fila
  const openCheckIn = useCallback(
    (row: FrontDeskRow) => {
      const suggested = suggestedRoomFor(row, rooms);
      setCheckInTarget({ reservationId: row.reservationId, roomId: suggested?.id ?? null });
    },
    [rooms]
  );

  const openPayment = useCallback(
    async (row: FrontDeskRow) => {
      try {
        const folio = await apiRequest<FolioLite>(`/reservations/${row.reservationId}/folio`);
        setPayTarget({ row, folioId: folio.folio.id, balanceDue: folio.balanceDue, currency: folio.folio.currency });
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "No se pudo cargar el folio.");
      }
    },
    // notify es estable (showToast del provider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const handlePrimary = useCallback(
    (row: FrontDeskRow, action: PrimaryAction) => {
      switch (action.kind) {
        case "checkin":
          openCheckIn(row);
          return;
        case "checkout":
          setCheckOutTarget(row.reservationId);
          return;
        case "pay":
          void openPayment(row);
          return;
        case "invoice":
        case "open":
        default:
          openReservationDetail(row.reservationId);
      }
    },
    [openCheckIn, openPayment]
  );

  const assignRoom = useCallback(
    async (row: FrontDeskRow, room: RoomLite, previous: { id: string; number: string } | null) => {
      const message = previous ? FRONT_DESK_TOASTS.roomChanged(previous.number, room.number) : FRONT_DESK_TOASTS.roomAssigned(room.number);
      try {
        await mutate(
          (prev) => applyRoomToDashboard(prev, row.reservationId, room),
          (request) => request<void>(`/reservations/${encodeURIComponent(row.reservationId)}/assign-room`, { method: "POST", body: { roomId: room.id } }),
          {
            announce: message,
            // §4.2: asignar / cambiar es directo con deshacer 8 s (revierte a la anterior); sin anterior no hay reversa en el API.
            // El shell pinta `label` como mensaje del toast: es lo que pasó (corrector UX1-REV-04), como en la ficha.
            undo: previous
              ? {
                  label: message,
                  onUndo: () =>
                    mutate(
                      (prev) => applyRoomToDashboard(prev, row.reservationId, previous),
                      (request) => request<void>(`/reservations/${encodeURIComponent(row.reservationId)}/assign-room`, { method: "POST", body: { roomId: previous.id } })
                    )
                }
              : undefined
          }
        );
        if (!previous) notify("ok", message);
        invalidateApi("/dashboards/front-desk-queue");
        invalidateApi(`/properties/${PROPERTY_ID}/rooms`);
        invalidateApi(`/reservations/${row.reservationId}`);
      } catch (err) {
        // Rollback ya hecho por `mutate`: la fila vuelve a su estado y el mensaje del API se muestra aquí (409 ROOM_OCCUPIED…).
        notify("error", err instanceof Error ? err.message : "No se pudo asignar la habitación.");
      }
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutate]
  );

  const handleSecondary = useCallback(
    (row: FrontDeskRow, kind: SecondaryActionKind, room?: RoomLite) => {
      switch (kind) {
        case "view_folio":
        case "open_full":
          openReservationDetail(row.reservationId);
          return;
        case "assign_room": {
          const suggested = suggestedRoomFor(row, rooms);
          if (!suggested) {
            setRoomsWanted(true);
            notify("warn", `Sin habitación limpia y libre del tipo${row.roomTypeName ? ` ${row.roomTypeName}` : ""}: abre el check-in para elegir otra.`);
            return;
          }
          void assignRoom(row, suggested, null);
          return;
        }
        case "change_room":
          if (room) void assignRoom(row, room, row.roomId && row.roomNumber ? { id: row.roomId, number: row.roomNumber } : null);
          return;
        case "mark_no_show":
          // El diálogo nominal nombra la reserva por su código (la fila solo trae el id): reserva desde la caché.
          void apiRequest<ReservationLite>(`/reservations/${row.reservationId}`)
            .then((reservation) => setNoShowTarget({ row, code: reservation.code, currency: reservation.currency }))
            .catch(() => setNoShowTarget({ row, code: row.reservationId }));
          return;
      }
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms, assignRoom]
  );

  // ---------------------------------------------------------------- lote (§5.1 (3), §6.1)
  const batchRun = useCallback(
    async <T,>(label: string, items: readonly T[], run: (item: T) => Promise<void>) => {
      batchCancel.current = false;
      const startedAt = Date.now();
      setBatch({ label, done: 0, total: items.length, startedAt });
      const outcome = await runBatch(items, run, {
        onProgress: (done, total) => setBatch({ label, done, total, startedAt }),
        isCancelled: () => batchCancel.current
      });
      setBatch(null);
      invalidateApi("/dashboards/front-desk");
      return outcome;
    },
    []
  );

  const [batchCheckOutPrompt, setBatchCheckOutPrompt] = useState<{ selection: CocoaTableSelection; candidates: FrontDeskRow[] } | null>(null);
  const runBatchCheckOut = useCallback(
    async (selection: CocoaTableSelection, candidates: FrontDeskRow[]) => {
      if (candidates.length === 0) return;
      const outcome = await batchRun(FRONT_DESK_ACTIONS.batchCheckOut(candidates.length), candidates, async (row) => {
        await apiRequest(`/reservations/${encodeURIComponent(row.reservationId)}/check-out`, { method: "POST", body: {} });
        void mutate((prev) => applyCheckOutToDashboard(prev, row.reservationId), () => Promise.resolve()).catch(() => undefined);
      });
      selection.clear();
      const summary = outcome.cancelled ? FRONT_DESK_TOASTS.batchCancelled(outcome.done, candidates.length) : FRONT_DESK_TOASTS.batchCheckOutSummary(outcome.done, outcome.failed.length);
      notify(outcome.failed.length > 0 ? "warn" : "ok", outcome.failed.length > 0 ? `${summary}: ${outcome.failed.map((entry) => `${entry.item.roomNumber ?? entry.item.reservationId} (${entry.message})`).join("; ")}` : summary);
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batchRun, mutate]
  );
  // §4.2 / UX1-REV-01: una sola salida cierra directa; N > 1 pasa por el diálogo nominal que lista las habitaciones.
  const batchCheckOut = useCallback(
    (selection: CocoaTableSelection) => {
      const candidates = batchCheckOutCandidates(tabRows, selection.keys, today);
      if (candidates.length === 0) return;
      if (candidates.length === 1) {
        void runBatchCheckOut(selection, candidates);
        return;
      }
      setBatchCheckOutPrompt({ selection, candidates });
    },
    [tabRows, today, runBatchCheckOut]
  );

  const batchAssign = useCallback(
    async (selection: CocoaTableSelection) => {
      const plan = batchAssignPlan(tabRows, selection.keys, rooms);
      if (plan.length === 0) {
        setRoomsWanted(true);
        notify("warn", "Ninguna de las seleccionadas tiene una habitación limpia y libre de su tipo.");
        return;
      }
      const outcome = await batchRun(FRONT_DESK_ACTIONS.batchAssign(plan.length), plan, async ({ row, room }) => {
        await apiRequest(`/reservations/${encodeURIComponent(row.reservationId)}/assign-room`, { method: "POST", body: { roomId: room.id } });
        void mutate((prev) => applyRoomToDashboard(prev, row.reservationId, room), () => Promise.resolve()).catch(() => undefined);
      });
      selection.clear();
      invalidateApi(`/properties/${PROPERTY_ID}/rooms`);
      notify(outcome.failed.length > 0 ? "warn" : "ok", outcome.cancelled ? FRONT_DESK_TOASTS.batchCancelled(outcome.done, plan.length) : FRONT_DESK_TOASTS.batchAssignSummary(outcome.done, outcome.failed.length));
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabRows, rooms, batchRun, mutate]
  );

  const printCards = useCallback(
    (selection: CocoaTableSelection) => {
      const selected = new Set(selection.keys);
      const rowsToPrint = tabRows.filter((row) => selected.has(row.reservationId));
      if (rowsToPrint.length === 0) return;
      const popup = window.open("", "_blank", "noopener,width=800,height=900");
      if (!popup) {
        notify("warn", "El navegador ha bloqueado la ventana de impresión.");
        return;
      }
      popup.document.write(registrationCardsHtml(rowsToPrint, getActiveProperty().propertyName));
      popup.document.close();
      popup.focus();
      popup.print();
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabRows]
  );

  // ---------------------------------------------------------------- eventos del shell (⌥W, ⌥F, ⌘K «Check-in»)
  useEffect(() => {
    const onWalkIn = (event: Event) => {
      event.preventDefault();
      setWalkInOpen(true);
    };
    const onFocusSearch = (event: Event) => {
      const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    const onOpenCheckIn = (event: Event) => {
      const detail = (event as CustomEvent<HitActionDetail>).detail;
      if (!detail?.reservationId) return;
      event.preventDefault();
      setCheckInTarget({ reservationId: detail.reservationId, roomId: null });
    };
    window.addEventListener(OPEN_WALK_IN_EVENT, onWalkIn);
    window.addEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
    window.addEventListener(OPEN_CHECKIN_EVENT, onOpenCheckIn);
    return () => {
      window.removeEventListener(OPEN_WALK_IN_EVENT, onWalkIn);
      window.removeEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
      window.removeEventListener(OPEN_CHECKIN_EVENT, onOpenCheckIn);
    };
  }, []);

  // ---------------------------------------------------------------- prefetch (§6.2: solo con puntero fino)
  const prefetchRow = useCallback(
    (reservationId: string) => {
      if (coarse || lastPrefetched.current === reservationId) return;
      lastPrefetched.current = reservationId;
      void prefetchApi(`/reservations/${reservationId}`, { staleTime: DASHBOARD_STALE_MS });
      void prefetchApi(`/reservations/${reservationId}/folio`, { staleTime: DASHBOARD_STALE_MS });
    },
    [coarse]
  );
  const rowIdFromEvent = useCallback(
    (target: EventTarget | null): string | null => {
      const tr = target instanceof Element ? target.closest("tbody tr") : null;
      if (!tr || !tr.parentElement) return null;
      const index = Array.from(tr.parentElement.children).filter((node) => node.tagName === "TR" && node.getAttribute("data-cocoa") !== "table-sentinel").indexOf(tr);
      return visibleRows[index]?.reservationId ?? null;
    },
    [visibleRows]
  );
  const rowElementFor = useCallback((reservationId: string): HTMLElement | null => {
    const index = visibleRows.findIndex((row) => row.reservationId === reservationId);
    if (index < 0) return null;
    const rows = tableWrapRef.current?.querySelectorAll<HTMLElement>("tbody tr[data-interactive]");
    return rows?.[index] ?? null;
  }, [visibleRows]);

  // ↑↓ mueven el inspector sin cerrarlo (fuera de campos de texto).
  const onTableKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!inspectorId || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const index = visibleRows.findIndex((row) => row.reservationId === inspectorId);
      const next = visibleRows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setInspectorId(next.reservationId);
      prefetchRow(next.reservationId);
      rowElementFor(next.reservationId)?.focus({ preventScroll: false });
    },
    [inspectorId, visibleRows, prefetchRow, rowElementFor]
  );

  // ---------------------------------------------------------------- recorrido de 3 pasos (una vez por persona)
  const user = getUser();
  const tourKey = `frontdesk:${user?.userId ?? "anon"}`;
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (tourOpen || !data || visibleRows.length === 0) return;
    const guide = getGuideState();
    // Solo cuando el aviso de bienvenida del shell ya no está y la persona no hizo el recorrido general (que ya enumera las seis tareas).
    if (!guide.welcomeDismissed || guide.tourCompleted) return;
    setTourOpen(true);
    // Una vez al tener filas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(data), visibleRows.length > 0]);
  const tourSteps = useMemo<CocoaGuidedTourStep[]>(
    () => [
      { target: '[data-cocoa="table"] tbody tr', title: "Cada fila es una reserva", body: "Pulsa la fila (o Intro) y se abre el detalle al lado, sin salir de Mi día. Con ↑ y ↓ pasas a la siguiente." },
      { target: '[data-tour="frontdesk-primary"]', title: "Una acción por fila", body: "El botón dice lo que toca: hacer el check-in, cobrar y cerrar o abrir la ficha. Lo demás está en «⋯»." },
      { target: '[data-tour="frontdesk-walk-in"]', title: `Mantén ${shortcutKeys("access.reveal").replace(" (mantener)", "")} para ver las teclas`, body: `Con ${shortcutKeys("access.reveal").replace(" (mantener)", "")} pulsada cada acción visible muestra su letra. ${shortcutKeys("nav.walk-in")} abre el walk-in, ${shortcutKeys("nav.focus-search")} va al buscador y ${shortcutKeys("global.palette")} busca cualquier cosa.` }
    ],
    []
  );

  // ---------------------------------------------------------------- CSV
  const todayStamp = new Date().toISOString().slice(0, 10);
  const arrivalsColumns: CsvColumn<ArrivalRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "arrivalDate", label: "Llegada" },
    { key: "nights", label: "Noches" },
    { key: "roomNumber", label: "Habitación" },
    { key: "roomTypeName", label: "Tipo habitación" },
    { key: "status", label: "Estado", format: (v) => reservationStatus(String(v ?? "")).label },
    { key: "balanceEur", label: "Saldo (EUR)" },
    { key: "specialRequests", label: "Peticiones" }
  ];
  const departuresColumns: CsvColumn<DepartureRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "departureDate", label: "Salida" },
    { key: "roomNumber", label: "Habitación" },
    { key: "status", label: "Estado", format: (v) => reservationStatus(String(v ?? "")).label },
    { key: "balanceEur", label: "Saldo (EUR)" }
  ];
  const inHouseColumns: CsvColumn<InHouseRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "roomNumber", label: "Habitación" },
    { key: "departureDate", label: "Sale" },
    { key: "nightsRemaining", label: "Noches restantes" },
    { key: "balanceEur", label: "Saldo (EUR)" },
    { key: "status", label: "Estado", format: (v) => reservationStatus(String(v ?? "")).label }
  ];
  const unassignedColumns: CsvColumn<UnassignedRow>[] = [
    { key: "reservationId", label: "Reserva" },
    { key: "guestName", label: "Huésped" },
    { key: "arrivalDate", label: "Llegada" },
    { key: "roomTypeName", label: "Tipo habitación" },
    { key: "preferences", label: "Preferencias" }
  ];

  function handleExport<T extends object>(rows: readonly T[], columns: CsvColumn<T>[], filename: string, label: string) {
    if (rows.length === 0) {
      notify("warn", `${label}: no hay datos para exportar`);
      return;
    }
    exportToCsv(rows, `${filename}-${todayStamp}`, columns);
    notify("ok", `${label} exportadas (${rows.length})`);
  }

  const exportActive: Record<FrontDeskTab, () => void> = {
    arrivals: () => handleExport(arrivals, arrivalsColumns, "llegadas", "Llegadas"),
    departures: () => handleExport(departures, departuresColumns, "salidas", "Salidas"),
    inhouse: () => handleExport(inHouse, inHouseColumns, "en-el-hotel", "Estancias"),
    unassigned: () => handleExport(unassigned, unassignedColumns, "sin-habitacion", "Sin habitación")
  };

  const propertyName = getActiveProperty().propertyName;
  const riskCount = kpis.unassignedRooms + kpis.overdueDepartures;
  const hasRisks = riskCount > 0 || kpis.pendingBalanceEur > 0;

  // Caso "DB vacía" — las 4 colecciones vacías Y no hay error de carga.
  const isCleanSlate = !error && !loading && Boolean(data) && arrivals.length === 0 && departures.length === 0 && inHouse.length === 0 && unassigned.length === 0;

  const summaryParts = [plural(kpis.arrivalsToday, "llegada", "llegadas"), plural(kpis.departuresToday, "salida", "salidas")];
  if (kpis.unassignedRooms > 0) summaryParts.push(`${fmtNumber(kpis.unassignedRooms)} sin habitación`);
  const subtitle = `${greeting()}, ${propertyName}. Hoy tienes ${summaryParts.join(" · ")}.`;

  // ---------------------------------------------------------------- columnas (la acción va en `rowActions`, siempre visible)
  const guestCell = (row: FrontDeskRow) => (
    <div className="cocoa-stack" data-gap="1">
      <span className="cocoa-row" data-gap="1">
        {row.vip ? (
          <CocoaBadge tone="accent" variant="tinted" size="small" uppercase={false} icon={<StarIcon size={10} />} title="VIP">
            VIP
          </CocoaBadge>
        ) : null}
        <strong>{row.guestName}</strong>
      </span>
      {row.specialRequests ? <span style={mutedStyle}>{row.specialRequests}</span> : null}
    </div>
  );
  const roomCell = (row: FrontDeskRow) => {
    if (!row.roomNumber) {
      const suggested = suggestedRoomFor(row, rooms);
      return suggested ? (
        <span className="cocoa-row" data-gap="1">
          <span style={mutedCellStyle}>sin asignar</span>
          <CocoaBadge tone="info" variant="tinted" size="small" uppercase={false} title={`Sugerida: ${suggested.number}`}>
            → {suggested.number}
          </CocoaBadge>
        </span>
      ) : (
        <span style={mutedCellStyle}>sin asignar</span>
      );
    }
    const roomState = rooms.find((room) => room.id === row.roomId);
    return (
      <span className="cocoa-row" data-gap="1">
        <strong>{row.roomNumber}</strong>
        {roomState && row.status === "confirmed" ? <CocoaStatusBadge entry={roomStatus(roomState.housekeepingStatus)} dense short /> : null}
      </span>
    );
  };
  const balanceCell = (row: FrontDeskRow) => (
    <div className="cocoa-stack" data-gap="1">
      <strong>{fmtEur(row.balanceEur)}</strong>
      <span>{balanceBadge(row.balanceEur)}</span>
    </div>
  );

  const columnsByTab: Record<FrontDeskTab, CocoaTableColumn<FrontDeskRow>[]> = {
    arrivals: [
      { key: "guestName", label: "Huésped", render: guestCell },
      { key: "roomNumber", label: "Habitación", render: roomCell },
      { key: "roomTypeName", label: "Tipo", render: (row) => row.roomTypeName ?? <span style={mutedCellStyle}>—</span>, hideOnNarrow: true },
      { key: "nights", label: "Noches", align: "right", render: (row) => fmtNumber(row.nights), hideOnNarrow: true },
      { key: "status", label: "Estado", render: (row) => statusBadge(row.status) },
      { key: "balance", label: "Saldo", align: "right", render: balanceCell }
    ],
    departures: [
      { key: "guestName", label: "Huésped", render: guestCell },
      { key: "roomNumber", label: "Habitación", render: roomCell },
      { key: "status", label: "Estado", render: (row) => statusBadge(row.status) },
      { key: "balance", label: "Saldo", align: "right", render: balanceCell }
    ],
    inhouse: [
      { key: "guestName", label: "Huésped", render: guestCell },
      { key: "roomNumber", label: "Habitación", render: roomCell },
      { key: "departureDate", label: "Sale", render: (row) => fmtDay(row.departureDate) },
      { key: "nightsRemaining", label: "Noches restantes", align: "right", render: (row) => fmtNumber(row.nightsRemaining), hideOnNarrow: true },
      { key: "balance", label: "Saldo", align: "right", render: balanceCell }
    ],
    unassigned: [
      { key: "guestName", label: "Huésped", render: guestCell },
      { key: "arrivalDate", label: "Llegada", render: (row) => fmtDay(row.arrivalDate) },
      { key: "roomTypeName", label: "Tipo", render: (row) => row.roomTypeName ?? <span style={mutedCellStyle}>—</span>, hideOnNarrow: true },
      { key: "roomNumber", label: "Habitación", render: roomCell }
    ]
  };

  const rowActions = (row: FrontDeskRow) => {
    const action = primaryFor(row);
    return (
      <>
        <CocoaButton variant="filled" tone="accent" size="small" onClick={() => handlePrimary(row, action)} title={action.kind === "checkin" ? checkInTooltipFor(row) : action.label} data-tour="frontdesk-primary">
          {action.label}
        </CocoaButton>
        <RowMenu row={row} rooms={rooms} onSecondary={handleSecondary} onOpen={() => setRoomsWanted(true)} />
      </>
    );
  };

  const batchBar = (selection: CocoaTableSelection): ReactNode => {
    const checkOutCount = batchCheckOutCandidates(tabRows, selection.keys, today).length;
    const assignCount = batchAssignPlan(tabRows, selection.keys, rooms).length;
    return (
      <>
        {activeTab === "departures" || activeTab === "inhouse" ? (
          <CocoaButton variant="filled" tone="accent" size="small" disabled={checkOutCount === 0 || Boolean(batch)} onClick={() => batchCheckOut(selection)} title={checkOutCount === 0 ? "Solo salen en lote las estancias sin saldo que salen hoy" : undefined}>
            {FRONT_DESK_ACTIONS.batchCheckOut(checkOutCount)}
          </CocoaButton>
        ) : null}
        {activeTab === "arrivals" || activeTab === "unassigned" ? (
          <CocoaButton variant="bordered" tone="neutral" size="small" disabled={assignCount === 0 || Boolean(batch)} onClick={() => void batchAssign(selection)} title={assignCount === 0 ? "Ninguna seleccionada sin habitación con una limpia y libre de su tipo" : undefined}>
            {FRONT_DESK_ACTIONS.batchAssign(assignCount)}
          </CocoaButton>
        ) : null}
        <CocoaButton variant="bordered" tone="neutral" size="small" disabled={selection.count === 0} onClick={() => printCards(selection)}>
          {FRONT_DESK_ACTIONS.printCards(selection.count)}
        </CocoaButton>
      </>
    );
  };

  const pageActions = (
    <>
      {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
      {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
        {ACTIONS.refresh}
      </CocoaButton>
      <CocoaButton variant="plain" tone="neutral" size="small" onClick={openSearch}>
        Buscar (⌘K)
      </CocoaButton>
      <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("LiveTimeline")}>
        Live Timeline
      </CocoaButton>
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setWalkInOpen(true)} icon={<CocoaKbd>{shortcutKeys("nav.walk-in")}</CocoaKbd>} iconPosition="right" title={`Alta de una llegada sin reserva (${shortcutKeys("nav.walk-in")})`} data-tour="frontdesk-walk-in">
        {FRONT_DESK_ACTIONS.walkIn}
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => navigateTo("ReservationCreate")} icon={<CocoaKbd>{shortcutKeys("nav.reservation-create")}</CocoaKbd>} iconPosition="right" title={`Nueva reserva (${shortcutKeys("nav.reservation-create")})`}>
        Nueva reserva
      </CocoaButton>
    </>
  );

  // Pestañas con el vocabulario común de la lista de reservas (D5): «Llegan hoy · Salen hoy · En el hotel · Sin habitación».
  // L-16: «Salen hoy» separa las pendientes de las salidas ya hechas (la tabla lista las dos).
  const departuresPending = departures.filter((row) => row.status === "checked_in").length;
  const departuresDone = departures.length - departuresPending;
  const tabOptions = [
    { value: "arrivals", label: `Llegan hoy (${fmtNumber(arrivals.length)})` },
    { value: "departures", label: departuresDone > 0 ? `Salen hoy (${fmtNumber(departuresPending)} · ${fmtNumber(departuresDone)} hechas)` : `Salen hoy (${fmtNumber(departures.length)})` },
    { value: "inhouse", label: `En el hotel (${fmtNumber(inHouse.length)})` },
    { value: "unassigned", label: `Sin habitación (${fmtNumber(unassigned.length)})` }
  ];

  const tableCaption: Record<FrontDeskTab, string> = { arrivals: "Llegadas de hoy", departures: "Salidas de hoy", inhouse: "Huéspedes alojados", unassigned: "Llegadas sin habitación asignada" };
  const emptyState: Record<FrontDeskTab, ReactNode> = {
    arrivals: <CocoaState kind="empty" title="No hay llegadas previstas para hoy" message="Cuando se confirmen reservas con entrada hoy aparecerán aquí, listas para asignar habitación y hacer check-in." primaryAction={{ label: "Crear reserva", onClick: () => navigateTo("ReservationCreate") }} />,
    departures: <CocoaState kind="empty" title="No hay salidas previstas para hoy" message="Cuando los huéspedes tengan fecha de salida hoy aparecerán aquí para gestionar el check-out." />,
    inhouse: <CocoaState kind="empty" title="No hay estancias activas ahora mismo" message="Cuando haya huéspedes alojados en el hotel aparecerán aquí." />,
    unassigned: <CocoaState kind="empty" inline title="Todas las llegadas tienen habitación asignada." />
  };

  const selectTab = (tab: FrontDeskTab) => {
    setActiveTab(tab);
    setOnlyBalance(false);
  };

  return (
    <CocoaPage
      eyebrow={`Recepción · ${todayLabel()}`}
      title="Recepción"
      density="operational"
      subtitle={subtitle}
      actions={pageActions}
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<FrontDeskSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "front-desk-refresh", label: "Actualizar recepción", run: refresh },
        { id: "front-desk-walk-in", label: FRONT_DESK_ACTIONS.walkIn, run: () => setWalkInOpen(true), shortcut: shortcutKeys("nav.walk-in") },
        { id: "front-desk-new-reservation", label: "Crear reserva", run: () => navigateTo("ReservationCreate"), shortcut: shortcutKeys("nav.reservation-create") },
        { id: "front-desk-search", label: "Buscar por nombre o habitación", run: () => document.getElementById(SEARCH_INPUT_ID)?.focus(), shortcut: shortcutKeys("nav.focus-search") },
        { id: "front-desk-timeline", label: "Abrir Live Timeline", run: () => navigateTo("LiveTimeline"), shortcut: shortcutKeys("nav.timeline") }
      ]}
    >
      {/* Clean-slate — bienvenida de primera ejecución cuando aún no hay reservas. */}
      {isCleanSlate ? <FirstRunWelcomeCard propertyId={PROPERTY_ID} /> : null}

      {/* Tiles clicables (§5.1 (5)): filtran la tabla. Mismo literal que las pestañas (L-16, D5); la fila de trabajo va justo debajo (L-12). */}
      <CocoaKpiStrip stagger aria-label="Indicadores de hoy">
        <CocoaKpi label="Llegan hoy" value={fmtNumber(kpis.arrivalsToday)} deltaLabel="hoy" polarity="neutral" status="ok" onClick={() => selectTab("arrivals")} />
        <CocoaKpi label="Salen hoy" value={fmtNumber(departuresPending)} deltaLabel={departuresDone > 0 ? `${fmtNumber(departuresDone)} hechas` : "pendientes"} polarity="neutral" status="ok" onClick={() => selectTab("departures")} />
        <CocoaKpi label="En el hotel" value={fmtNumber(kpis.inHouseNow)} deltaLabel="ocupadas" polarity="neutral" status="ok" onClick={() => selectTab("inhouse")} />
      </CocoaKpiStrip>

      {/* DEV #5 — bloque "Riesgos" colapsable: los 3 KPIs operativos
          (sin habitación, retrasos, saldo) se muestran bajo demanda. */}
      <div className="cocoa-row" data-gap="2" data-justify="end">
        {!showRiskKpis && hasRisks ? (
          <CocoaBadge tone="warning" variant="tinted" size="small">
            {plural(riskCount, "alerta", "alertas")}
          </CocoaBadge>
        ) : null}
        <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setShowRiskKpis((v) => !v)} aria-expanded={showRiskKpis} aria-label={showRiskKpis ? "Ocultar KPIs de riesgo" : "Mostrar KPIs de riesgo"}>
          {showRiskKpis ? "Ocultar riesgos" : "Mostrar riesgos"}
        </CocoaButton>
      </div>

      {showRiskKpis ? (
        <CocoaKpiStrip stagger aria-label="Riesgos de hoy">
          <CocoaKpi label="Sin habitación" value={fmtNumber(kpis.unassignedRooms)} deltaLabel={kpis.unassignedRooms > 0 ? "pendiente" : "al día"} polarity="neutral" status={kpis.unassignedRooms > 0 ? "warning" : "ok"} onClick={() => selectTab("unassigned")} />
          <CocoaKpi label="Salidas con retraso" value={fmtNumber(kpis.overdueDepartures)} deltaLabel={kpis.overdueDepartures > 0 ? "con retraso" : "a tiempo"} polarity="neutral" status={kpis.overdueDepartures > 0 ? "critical" : "ok"} onClick={() => selectTab("departures")} />
          <CocoaKpi
            label="Saldo pendiente"
            value={fmtEur(kpis.pendingBalanceEur)}
            deltaLabel={kpis.pendingBalanceEur > 0 ? "por cobrar" : "saldado"}
            polarity="neutral"
            status={kpis.pendingBalanceEur > 0 ? "warning" : "ok"}
            onClick={() => {
              setActiveTab(activeTab === "unassigned" ? "departures" : activeTab);
              setOnlyBalance((value) => !value);
            }}
          />
        </CocoaKpiStrip>
      ) : null}

      {/* Las 4 tablas pasan a vistas internas en una sola sección; el inspector se abre al lado. */}
      <CocoaSection title="Movimientos de hoy">
        <div className="cocoa-stack" data-gap="3">
          <CocoaToolbar
            variant="content"
            aria-label="Vista de recepción"
            leftSlot={<CocoaSegmentedControl size="small" aria-label="Vista de recepción" value={activeTab} onChange={(value) => selectTab(value as FrontDeskTab)} options={tabOptions} />}
            rightSlot={
              <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
                <CocoaSearchInput id={SEARCH_INPUT_ID} value={search} onChange={setSearch} placeholder={FRONT_DESK_ACTIONS.searchPlaceholder} debounceMs={120} aria-label={`Buscar por nombre o habitación (${shortcutKeys("nav.focus-search")})`} />
                {onlyBalance ? (
                  <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => setOnlyBalance(false)} aria-pressed title="Quitar el filtro «con saldo»">
                    Con saldo ×
                  </CocoaButton>
                ) : null}
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={exportActive[activeTab]} aria-label="Descargar la tabla en formato CSV">
                  Exportar CSV
                </CocoaButton>
              </div>
            }
          />

          {batch ? (
            <CocoaCallout
              tone="info"
              role="status"
              title={batch.label}
              actions={
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => (batchCancel.current = true)}>
                  {FRONT_DESK_ACTIONS.cancelRest}
                </CocoaButton>
              }
            >
              {batchProgressLabel(batch.done, batch.total, Date.now() - batch.startedAt)}
            </CocoaCallout>
          ) : null}

          {tabRows.length === 0 ? (
            emptyState[activeTab]
          ) : (
            <CocoaInspectorLayout open={Boolean(inspectorRow)}>
              <div ref={tableWrapRef} onMouseOver={(event) => { const id = rowIdFromEvent(event.target); if (id) prefetchRow(id); }} onFocus={(event) => { const id = rowIdFromEvent(event.target); if (id) prefetchRow(id); }} onKeyDown={onTableKeyDown}>
                <CocoaTable
                  columns={columnsByTab[activeTab]}
                  rows={visibleRows}
                  rowKey="reservationId"
                  caption={tableCaption[activeTab]}
                  density={coarse ? "comfortable" : "compact"}
                  selectable="multiple"
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedKeys}
                  batchBar={batchBar}
                  selectedKey={inspectorRow?.reservationId}
                  onSelect={(row) => {
                    setInspectorId((current) => (current === row.reservationId ? null : row.reservationId));
                    prefetchRow(row.reservationId);
                  }}
                  rowActions={rowActions}
                  rowActionsVisible="always"
                  rowTitle={(row) => `${row.guestName}: Intro abre el detalle`}
                  emptyState={<CocoaState kind="empty" inline title={STATUS_LABELS.noResults} message="Prueba con otro nombre o número de habitación." />}
                />
              </div>
              {inspectorRow ? (
                <RowInspector
                  row={inspectorRow}
                  rooms={rooms}
                  primary={primaryFor(inspectorRow)}
                  today={today}
                  onClose={() => setInspectorId(null)}
                  onPrimary={handlePrimary}
                  onSecondary={handleSecondary}
                  returnFocusTo={() => rowElementFor(inspectorRow.reservationId)}
                />
              ) : null}
            </CocoaInspectorLayout>
          )}
        </div>
      </CocoaSection>

      {/* Cola de acciones priorizada — qué hacer ahora, tras la tabla (L-12: la fila de trabajo primero). */}
      <FrontDeskActionQueue onWalkIn={() => setWalkInOpen(true)} />

      <CocoaScreenInstructionsCard {...FRONTDESK_COCKPIT_INSTRUCTIONS} dismissible persistKey="frontdesk-cockpit" />

      {/* Drawers in-place — abren slide-over sin perder contexto del dashboard. */}
      {checkInTarget ? (
        <QuickCheckInDrawer
          reservationId={checkInTarget.reservationId}
          initialRoomId={checkInTarget.roomId}
          onClose={() => setCheckInTarget(null)}
          onSubmitted={optimisticCheckIn}
          onFailed={rollbackCheckIn}
          onCompleted={reconcileCheckIn}
        />
      ) : null}
      {checkOutTarget ? <QuickCheckOutDrawer reservationId={checkOutTarget} onClose={() => setCheckOutTarget(null)} onCompleted={reconcileCheckOut} /> : null}
      {walkInOpen ? (
        <WalkInDrawer
          propertyId={PROPERTY_ID}
          onClose={() => setWalkInOpen(false)}
          onCompleted={() => {
            invalidateApi("/dashboards/front-desk");
            invalidateApi(`/properties/${PROPERTY_ID}/rooms`);
          }}
        />
      ) : null}
      {payTarget ? (
        <PaymentDialog
          open
          onClose={() => setPayTarget(null)}
          folioId={payTarget.folioId}
          propertyId={PROPERTY_ID}
          currency={payTarget.currency}
          balanceDue={payTarget.balanceDue}
          subject={`${payTarget.row.guestName}${payTarget.row.roomNumber ? ` · Hab. ${payTarget.row.roomNumber}` : ""}`}
          onCaptured={() => {
            invalidateApi(`/reservations/${payTarget.row.reservationId}`);
            invalidateApi("/dashboards/front-desk");
            setPayTarget(null);
          }}
        />
      ) : null}
      <LifecycleDialog
        open={Boolean(noShowTarget)}
        mode="no_show"
        reservation={noShowTarget ? { id: noShowTarget.row.reservationId, code: noShowTarget.code, currency: noShowTarget.currency } : null}
        onClose={() => setNoShowTarget(null)}
        onDone={(result) => {
          void mutate((prev) => applyNoShowToDashboard(prev, result.id), () => Promise.resolve()).catch(() => undefined);
          invalidateApi("/dashboards/front-desk");
        }}
      />
      <CocoaDialog
        open={batchCheckOutPrompt !== null}
        onClose={() => setBatchCheckOutPrompt(null)}
        tone="destructive"
        title={FRONT_DESK_ACTIONS.batchCheckOut(batchCheckOutPrompt?.candidates.length ?? 0)}
        description={batchCheckOutPrompt ? batchCheckOutSummaryText(batchCheckOutPrompt.candidates) : undefined}
        size="sm"
        confirmLabel={FRONT_DESK_ACTIONS.batchCheckOut(batchCheckOutPrompt?.candidates.length ?? 0)}
        cancelLabel={FRONT_DESK_ACTIONS.reviewSelection}
        onConfirm={() => {
          const prompt = batchCheckOutPrompt;
          setBatchCheckOutPrompt(null);
          if (prompt) void runBatchCheckOut(prompt.selection, prompt.candidates);
        }}
      />
      <CocoaGuidedTour steps={tourSteps} open={tourOpen} persistKey={tourKey} onComplete={() => setTourOpen(false)} onSkip={() => setTourOpen(false)} />
    </CocoaPage>
  );
}
