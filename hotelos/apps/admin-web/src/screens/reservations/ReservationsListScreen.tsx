// Reservas — Recepción › Reservas › Lista (/recepcion/reservas/lista).
//
// Cocoa 22 · ola 3 · lote 3-A (list archetype, template `ListaTabla`; §6 keeps
// it at the dashboard budget): CocoaPage → guidance card → CocoaKpiStrip with
// the four operational counters (each opens its view) → CocoaToolbar (search,
// segmented views with live counts, «N de M») → CocoaSection padding none +
// CocoaTable (controlled sort, footer with the count and «Cargar más») →
// CocoaState empty / error inside the section so the toolbar stays. Hosted
// inside ReservasTabs the container paints the title and the «Nueva reserva»
// action.
//
// fix:3-A qa#7: a row without booker name only carries the primary guest id;
// the names are resolved through /guests/:id (one request per distinct id,
// cached for the session) and, until they arrive or if the lookup fails, the
// row reads «Huésped pendiente» — never the internal id.
//
// Tanda UX-1 · lote U8 (docs/design/UX-RECEPCION-FEEL.md §5.7, F10, F11, F25,
// F26, F34, §6.2, §10 D5/D11/R13):
//   · capa de datos v2: la página vive en `useApiData` (clave = pestaña +
//     búsqueda; SWR 30 s) y la tabla lleva `keepDataWhileLoading`: al teclear
//     o cambiar de pestaña las filas actuales siguen bajo un velo `aria-busy`
//     (F11); «Cargar más» sigue el cursor y se guarda por clave de filtro;
//   · buscador «nombre, código o habitación» (F10): un término que parece un
//     número de habitación se filtra EN CLIENTE sobre la página cargada por
//     `roomNumber` (R13: el API no indexa la habitación de la reserva; la
//     ampliación mínima queda documentada para el cierre) y no se envía como
//     `q`; el resto va al servidor como antes. ⌥F enfoca el buscador;
//   · inspector lateral (F26): Intro / clic en la fila lo abren, ↑↓ cambian de
//     reserva sin cerrarlo; barra de comandos con `primaryActionFor` (U6),
//     folio abreviado y «Abrir ficha completa»; check-in / check-out / cobro
//     abren los mismos cajones y diálogo que Mi día y reconcilian la fila;
//   · selección múltiple + barra de lote (F25): «Imprimir N fichas», «Asignar
//     habitación a N» y «Check-out de N con saldo 0» (los saldos se comprueban
//     por folio al seleccionar; nunca se promete un cierre a ciegas);
//   · «Columnas ▾» (`columnsPrefsKey="reservas.lista"`, D11, localStorage);
//     la densidad la resuelve CocoaPage (U10);
//   · contadores (F34): el de la pestaña activa sale del `total` del sobre de
//     paginación (0 peticiones); los de los KPI se piden en UN
//     `Promise.allSettled` diferido tras el primer pintado y se cachean 30 s
//     por propiedad y día; «Todas» y «Canceladas» se cuentan al visitarlas.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { urlForScreen } from "../../navigation/nav-tree";
import {
  fetchReservations,
  matchesReservationTab,
  reservationTabQuery,
  todayIsoLocal,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type FolioBalance,
  type Page,
  type ReservationListQuery,
  type ReservationOperationalTab
} from "../../services/pmsCommerceApi";
import { apiRequest } from "../../services/api-client";
import { fetchGuest } from "../../services/guestsApi";
import { invalidateApi, prefetchApi, useApiData } from "../../hooks/useApiData";
import { cacheKeyFor, getCached } from "../../hooks/apiCache";
import { guestFullName, guestNamesFromRows, pendingGuestIds, reservationGuestLabel } from "./reservation-guest-label";
import { useTabHost } from "../tabs/TabHost";
import { navigateTo } from "../../lib/navigate";
import { useCoarsePointer } from "../../lib/useCoarsePointer";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { PlusIcon, UploadIcon } from "../../components/cocoa-icons/ActionIcons";
import { RESERVATIONS_INSTRUCTIONS } from "../../content/screen-instructions/reservations";
import { date, money, number, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS, STATUS_LABELS, newLabel } from "../../content/actions";
import { FOCUS_SEARCH_EVENT, shortcutKeys } from "../../content/shortcuts-registry";
import { reservationStatus, sourceLabel } from "../../content/status-dictionary";
import { primaryActionFor, type PrimaryAction } from "../operations/primaryAction";
import { batchProgressLabel, candidateRoomsFor, registrationCardsHtml, runBatch, type FrontDeskRow, type RoomLite } from "../operations/FrontDeskDashboard";
import { QuickCheckInDrawer, type QuickCheckInCompleted } from "../operations/QuickCheckInDrawer";
import { QuickCheckOutDrawer, type QuickCheckOutCompleted } from "../operations/QuickCheckOutDrawer";
import { PaymentDialog } from "../../components/billing/PaymentDialog";
import {
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaInspector,
  CocoaInspectorLayout,
  INSPECTOR_STACK_BREAKPOINT,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTableSelection,
  type CocoaTableSort
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Tanda 7: «Importar reservas» opens the Importar tab of Reservas (CSV / XLSX wizard).
const IMPORT_PATH = urlForScreen("ReservationImportScreen") ?? "/recepcion/reservas/importar";
const IMPORT_LABEL = "Importar reservas";
const LIST_PATH = `/properties/${PROPERTY_ID}/reservations`;
const SEARCH_INPUT_ID = "reservations-search";
/** Columnas de esta tabla en localStorage (D11: por persona y navegador). */
export const COLUMNS_PREFS_KEY = "reservas.lista";

function openImport() {
  openTabPath(IMPORT_PATH);
}

// Rows fetched per page. The API clamps at 500; 100 keeps the first paint
// light and "Cargar más" walks the cursor for the rest.
export const PAGE_SIZE = 100;
// Window used to count / list today's departures: the API only offers the
// overlap filter, so we pull the in-house window and refine client-side.
export const DEPARTURES_WINDOW_LIMIT = 300;
/** Página de la lista: SWR 30 s (§6.2); catálogos 5 min; reserva y folio del inspector 30 s. */
const LIST_STALE_MS = 30_000;
const CATALOG_STALE_MS = 5 * 60_000;
const DETAIL_STALE_MS = 30_000;
/** Los contadores diferidos valen 30 s por propiedad y día (misma ventana que la lista). */
export const COUNTS_TTL_MS = 30_000;
const CENT = 0.005;
/** Sondeos de saldo de la selección en paralelo (UX1-REV-12). */
export const BALANCE_PROBE_CONCURRENCY = 6;

/**
 * Saldos de `ids` con `probe`, como mucho `concurrency` a la vez (puro):
 * un folio que falla o no devuelve número queda como NaN (fallo marcado, no
 * «pendiente para siempre»).
 */
export async function probeBalances(ids: readonly string[], probe: (id: string) => Promise<number | undefined>, concurrency = BALANCE_PROBE_CONCURRENCY): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor];
      cursor += 1;
      try {
        const value = await probe(id);
        out[id] = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
      } catch {
        out[id] = Number.NaN;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return out;
}

// Operational tabs aligned with the daily front-desk rhythm. Every tab maps to
// a server-side filter (reservationTabQuery); the active tab's count comes from
// the page envelope, the KPI tabs from one deferred batch of limit=1 requests.
type StatusTab = ReservationOperationalTab;

interface ReservationRow extends AdminReservation {
  // Derived display helpers so the table can sort without recomputing.
  guestName: string;
  roomTypeLabel: string;
  roomNumber: string | null;
}

type TabCounts = Partial<Record<StatusTab, number>>;

/** Pestañas cuyo contador pinta un KPI (las demás se cuentan al visitarlas). */
export const KPI_TABS: readonly StatusTab[] = ["today_arrivals", "in_house", "today_departures", "future"];

const TAB_LABEL: Record<StatusTab, string> = {
  all: "Todas",
  today_arrivals: "Llegan hoy",
  in_house: "En el hotel",
  today_departures: "Salen hoy",
  future: "Futuras",
  cancelled: "Canceladas"
};
const TAB_ORDER: StatusTab[] = ["all", "today_arrivals", "in_house", "today_departures", "future", "cancelled"];

const COLUMNS: CocoaTableColumn<ReservationRow>[] = [
  { key: "code", label: "Código", sortable: true, fit: true, render: (row) => <strong>{row.code}</strong> },
  { key: "guestName", label: FIELD_LABELS.guest, sortable: true, minWidth: 160 },
  { key: "roomNumber", label: FIELD_LABELS.room, sortable: true, fit: true, render: (row) => (row.roomNumber ? <strong className="cocoa-mono">{row.roomNumber}</strong> : "—") },
  { key: "arrivalDate", label: "Llegada", sortable: true, fit: true, render: (row) => date(row.arrivalDate, "dayMonth") },
  { key: "departureDate", label: "Sale", sortable: true, fit: true, hideOnNarrow: true, render: (row) => date(row.departureDate, "dayMonth") },
  { key: "roomTypeLabel", label: FIELD_LABELS.roomType, sortable: true, showFrom: "laptop" },
  {
    key: "sourceCode",
    label: "Origen",
    sortable: true,
    fit: true,
    showFrom: "desktop",
    // D5 / L-14: origen por diccionario (bookingSource manda sobre el código de canal), nunca «direct_web».
    render: (row) => (row.bookingSource || row.sourceCode || row.channel ? <CocoaBadge tone="neutral" uppercase={false}>{sourceLabel(row.bookingSource || row.sourceCode || row.channel)}</CocoaBadge> : "—")
  },
  { key: "totalAmount", label: FIELD_LABELS.total, sortable: true, align: "right", render: (row) => <strong>{money(row.totalAmount, row.currency)}</strong> },
  {
    key: "status",
    label: FIELD_LABELS.status,
    sortable: true,
    fit: true,
    render: (row) => <CocoaStatusBadge entry={reservationStatus(row.status)} />
  }
];

// ---------------------------------------------------------------- funciones puras (__tests__/reservations-list.test.mts)

/** Un término que parece un número de habitación («204», «12», «101B»): se filtra en cliente, nunca va como `q`. */
export const ROOM_QUERY = /^\d{1,4}[a-z]?$/i;

export function isRoomQuery(term: string): boolean {
  return ROOM_QUERY.test(term.trim());
}

/**
 * Filtro en cliente por habitación sobre la página cargada (R13): número igual
 * o que empieza por el término («20» → 201…220) o código que lo contiene. Sin
 * término, todas las filas.
 */
export function filterRowsByRoom<T extends { roomNumber?: string | null; code: string }>(rows: readonly T[], term: string): T[] {
  const t = term.trim().toLowerCase();
  if (!t) return [...rows];
  return rows.filter((row) => {
    const room = (row.roomNumber ?? "").toLowerCase();
    return room === t || (room !== "" && room.startsWith(t)) || row.code.toLowerCase().includes(t);
  });
}

/** Query de la lista para una pestaña y un término: el término solo viaja como `q` si NO es una habitación. */
export function reservationListQuery(input: { tab: StatusTab; today: string; term: string; cursor?: string }): ReservationListQuery {
  const term = input.term.trim();
  return {
    ...reservationTabQuery(input.tab, input.today),
    q: term && !isRoomQuery(term) ? term : undefined,
    limit: input.tab === "today_departures" ? DEPARTURES_WINDOW_LIMIT : PAGE_SIZE,
    cursor: input.cursor
  };
}

/** Serialización de `apiRequest` (misma regla que pmsCommerceApi: arrays → csv, booleanos → "1", vacíos fuera). */
export function serializeListQuery(query: ReservationListQuery): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries({ ...query, envelope: true })) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join(",");
    } else if (typeof value === "boolean") {
      if (value) out[key] = "1";
    } else if (typeof value === "number" || typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/** Mapa id → número de habitación del catálogo (pure). */
export function roomNumbersById(rooms: ReadonlyArray<Pick<AdminRoom, "id" | "number">> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const room of rooms ?? []) out[room.id] = room.number;
  return out;
}

/** Pestañas cuyo contador falta y hay que sondear (la activa ya sale del sobre). */
export function tabsToProbe(current: StatusTab, known: TabCounts): StatusTab[] {
  return KPI_TABS.filter((tab) => tab !== current && known[tab] === undefined);
}

export function mergeById(current: AdminReservation[], incoming: AdminReservation[]): AdminReservation[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...incoming.filter((r) => !seen.has(r.id))];
}

function patchItems(page: Page<AdminReservation>, id: string, patch: Partial<AdminReservation>): Page<AdminReservation> {
  return { ...page, items: page.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) };
}

// Deep link to /recepcion/reservas/:id (Detalle tab of the Reservas container,
// Tanda 5): reload + browser history restore the workspace and the detail
// screen parses the id from the trailing slug.
function openReservation(row: Pick<ReservationRow, "id">) {
  const url = urlForScreen("ReservationDetailWorkspace", { id: row.id });
  if (url) openTabPath(url);
}

// ---------------------------------------------------------------- cachés de módulo (comparten montajes)

/** Nombres de huésped por id (qa#7): una petición por id y sesión; sin parpadeo «Huésped pendiente» al volver. */
const GUEST_NAME_CACHE: Record<string, string> = {};
const requestedGuestIds = new Set<string>();

let countsCache: { scope: string; at: number; counts: TabCounts } | null = null;

function readCountsCache(scope: string): TabCounts {
  if (!countsCache || countsCache.scope !== scope || Date.now() - countsCache.at > COUNTS_TTL_MS) return {};
  return countsCache.counts;
}

function writeCountsCache(scope: string, counts: TabCounts, probed: boolean) {
  const at = probed || !countsCache || countsCache.scope !== scope ? Date.now() : countsCache.at;
  countsCache = { scope, at, counts };
}

type ReservationDetail = AdminReservation & { primaryGuest?: { firstName?: string | null; surname1?: string | null; surname2?: string | null; fullName?: string | null } | null };

// ---------------------------------------------------------------- inspector lateral (§5.7 (3), F26)

function ReservationInspector({ row, rooms, today, onClose, onPrimary, returnFocusTo }: { row: ReservationRow; rooms: readonly AdminRoom[]; today: string; onClose: () => void; onPrimary: (row: ReservationRow, action: PrimaryAction) => void; returnFocusTo: () => HTMLElement | null }) {
  const reservationState = useApiData<ReservationDetail>(`/reservations/${row.id}`, { staleTime: DETAIL_STALE_MS });
  const folioState = useApiData<FolioBalance>(`/reservations/${row.id}/folio`, { staleTime: DETAIL_STALE_MS });
  const reservation = reservationState.data;
  const folio = folioState.data;
  const fmt = (amount: number) => money(amount, folio?.folio.currency ?? row.currency);
  const suggested = !row.roomNumber && row.status === "confirmed" ? candidateRoomsFor(rooms, row.roomTypeId)[0] ?? null : null;
  // El folio manda en cuanto llega; sin folio la acción se deriva del estado (nunca se promete un cobro a ciegas).
  const action = primaryActionFor(
    { status: row.status, arrivalDate: row.arrivalDate, departureDate: row.departureDate, roomNumber: row.roomNumber, suggestedRoomNumber: suggested?.number ?? null, balanceEur: folio?.balanceDue ?? null },
    folio ? { balanceDue: folio.balanceDue } : null,
    today,
    fmt
  );
  const balance = folio?.balanceDue ?? 0;
  const guestName = guestFullName(reservation?.primaryGuest) ?? row.guestName;
  const title = `${row.code} · ${reservationStatus(row.status).label}${row.roomNumber ? ` · ${row.roomNumber}` : ""}`;
  return (
    <CocoaInspector
      open
      title={title}
      aria-label={`Detalle de la reserva ${row.code}`}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      width="md"
      commands={
        <>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => onPrimary(row, action)} data-tour="reservations-inspector-primary">
            {action.label}
          </CocoaButton>
          {action.kind !== "pay" && balance > CENT ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => onPrimary(row, { kind: "pay", label: FRONT_DESK_ACTIONS.collect(fmt(balance)), amount: balance })}>
              {FRONT_DESK_ACTIONS.collect(fmt(balance))}
            </CocoaButton>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openReservation(row)}>
            {FRONT_DESK_ACTIONS.openFullReservation}
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-stack" data-gap="1">
          <strong>{guestName}</strong>
          <span className="cocoa-note">
            {`${date(row.arrivalDate, "dayMonth")} → ${date(row.departureDate, "dayMonth")}`}
            {reservation?.adults ? ` · ${plural(reservation.adults, "adulto", "adultos")}` : ""}
            {row.roomTypeLabel ? ` · ${row.roomTypeLabel}` : ""}
            {row.roomNumber ? ` · Hab. ${row.roomNumber}` : " · Sin habitación"}
          </span>
          {reservation?.specialRequests ? <span className="cocoa-note">{reservation.specialRequests}</span> : null}
        </div>
        <CocoaSection
          title="Folio"
          meta={
            folio ? (
              <CocoaBadge tone={folio.balanceDue > CENT ? "warning" : "success"} size="small" uppercase={false}>
                {fmt(folio.balanceDue)}
              </CocoaBadge>
            ) : folioState.loading ? (
              <CocoaBadge tone="info" size="small">
                {STATUS_LABELS.loading}
              </CocoaBadge>
            ) : undefined
          }
        >
          {folioState.error && !folio ? (
            <CocoaCallout tone="warning" role="status">
              {folioState.error}
            </CocoaCallout>
          ) : folio ? (
            <ul className="c22-section__list" aria-label="Folio abreviado">
              {folio.lines.slice(0, 5).map((line) => (
                <li key={line.id}>
                  <span>{line.description}</span>
                  <strong>{fmt(line.total)}</strong>
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
                  {fmt(folio.chargesTotal)} · {fmt(folio.paymentsTotal)}
                </strong>
              </li>
              <li>
                <span>Saldo</span>
                <strong>{fmt(folio.balanceDue)}</strong>
              </li>
            </ul>
          ) : (
            <CocoaSkeleton variant="row" lines={3} />
          )}
        </CocoaSection>
        <span className="cocoa-note">{`Intro o clic en otra fila cambia de reserva; ↑↓ también. Esc cierra el panel.`}</span>
      </div>
    </CocoaInspector>
  );
}

// ---------------------------------------------------------------- pantalla

type BatchState = { label: string; done: number; total: number; startedAt: number } | null;

export function ReservationsListScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const coarse = useCoarsePointer();
  const today = todayIsoLocal();
  const countsScope = `${PROPERTY_ID}|${today}`;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tab, setTab] = useState<StatusTab>("today_arrivals");
  const [sort, setSort] = useState<CocoaTableSort>({ key: "arrivalDate", direction: "asc" });
  const [tabCounts, setTabCounts] = useState<TabCounts>(() => readCountsCache(countsScope));
  const [countsError, setCountsError] = useState<string | null>(null);
  const [guestNames, setGuestNames] = useState<Record<string, string>>(() => ({ ...GUEST_NAME_CACHE }));
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [checkInTarget, setCheckInTarget] = useState<{ reservationId: string; roomId: string | null } | null>(null);
  const [checkOutTarget, setCheckOutTarget] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<{ row: ReservationRow; folioId: string; balanceDue: number; currency: string } | null>(null);
  const [batch, setBatch] = useState<BatchState>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const lastPrefetched = useRef<string | null>(null);
  const mounted = useRef(true);
  const probed = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Debounce the search box: the `q` filter is server-side (a room number stays in the client).
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  // ---------------------------------------------------------------- datos (v2: caché por clave, SWR, keepPreviousData)
  const roomQuery = isRoomQuery(debouncedQuery);
  const listQuery = useMemo(() => reservationListQuery({ tab, today, term: debouncedQuery }), [tab, today, debouncedQuery]);
  const serializedQuery = useMemo(() => serializeListQuery(listQuery), [listQuery]);
  const listKey = JSON.stringify(serializedQuery);
  const page = useApiData<Page<AdminReservation>>(LIST_PATH, { query: serializedQuery, staleTime: LIST_STALE_MS });
  const roomTypesState = useApiData<AdminRoomType[]>(`/properties/${PROPERTY_ID}/room-types`, { staleTime: CATALOG_STALE_MS });
  const roomsState = useApiData<AdminRoom[]>(`/properties/${PROPERTY_ID}/rooms`, { staleTime: CATALOG_STALE_MS });
  const roomTypes = useMemo(() => roomTypesState.data ?? [], [roomTypesState.data]);
  const rooms = useMemo(() => roomsState.data ?? [], [roomsState.data]);
  const roomNumbers = useMemo(() => roomNumbersById(rooms), [rooms]);

  // «Cargar más»: páginas siguientes por clave de filtro (se descartan al cambiar de pestaña o de término).
  const [more, setMore] = useState<{ key: string; items: AdminReservation[]; nextCursor: string | null; total: number } | null>(null);
  const extra = more && more.key === listKey ? more : null;
  const reservations = useMemo(() => (extra ? mergeById(page.data?.items ?? [], extra.items) : page.data?.items ?? []), [page.data, extra]);
  const nextCursor = extra ? extra.nextCursor : page.data?.nextCursor ?? null;
  const total = extra ? extra.total : page.data?.total ?? null;
  // Filas de otra clave bajo el velo: no se refinan con la pestaña nueva (se verían vacías) ni se declaran «sin resultados».
  const stale = page.loading && page.data !== null;

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await fetchReservations(PROPERTY_ID, reservationListQuery({ tab, today, term: debouncedQuery, cursor: nextCursor }));
      if (!mounted.current) return;
      setMore((current) => ({ key: listKey, items: mergeById(current && current.key === listKey ? current.items : [], next.items), nextCursor: next.nextCursor, total: next.total }));
    } catch (err: unknown) {
      if (mounted.current) setMoreError(err instanceof Error ? err.message : "No se pudieron cargar más reservas.");
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  // Nombres de huésped (qa#7): los que trae la página (`primaryGuestName`, L-15) se siembran sin pedir nada;
  // el resto, una petición por id y sesión; un fallo vuelve a intentarse en el siguiente montaje.
  useEffect(() => {
    const seeded = guestNamesFromRows(reservations);
    const fresh = Object.entries(seeded).filter(([id]) => !GUEST_NAME_CACHE[id]);
    if (fresh.length > 0) {
      Object.assign(GUEST_NAME_CACHE, Object.fromEntries(fresh));
      for (const [id] of fresh) requestedGuestIds.add(id);
      setGuestNames((current) => ({ ...current, ...Object.fromEntries(fresh) }));
    }
    const ids = pendingGuestIds(reservations, requestedGuestIds);
    if (ids.length === 0) return;
    ids.forEach((id) => requestedGuestIds.add(id));
    void Promise.allSettled(ids.map((id) => fetchGuest(id))).then((results) => {
      const resolved: Record<string, string> = {};
      results.forEach((result, index) => {
        const name = result.status === "fulfilled" ? guestFullName(result.value.guest) : null;
        if (name) resolved[ids[index]] = name;
        else requestedGuestIds.delete(ids[index]);
      });
      Object.assign(GUEST_NAME_CACHE, resolved);
      if (!mounted.current || Object.keys(resolved).length === 0) return;
      setGuestNames((current) => ({ ...current, ...resolved }));
    });
  }, [reservations]);

  // ---------------------------------------------------------------- contadores (F34)
  const mergeCounts = useCallback(
    (next: TabCounts, probedNow: boolean) => {
      setTabCounts((current) => {
        const merged = { ...current, ...next };
        writeCountsCache(countsScope, merged, probedNow);
        return merged;
      });
    },
    [countsScope]
  );

  // El de la pestaña activa sale del sobre (exacto; salidas refinadas en cliente sobre la ventana), solo sin término.
  useEffect(() => {
    if (!page.data || page.loading || debouncedQuery) return;
    const count = tab === "today_departures" ? page.data.items.filter((r) => matchesReservationTab(r, "today_departures", today)).length : page.data.total;
    mergeCounts({ [tab]: count }, false);
  }, [page.data, page.loading, tab, today, debouncedQuery, mergeCounts]);

  const loadCounts = useCallback(
    async (current: StatusTab) => {
      setCountsError(null);
      const tabs = tabsToProbe(current, readCountsCache(countsScope));
      if (tabs.length === 0) return;
      const results = await Promise.allSettled(
        tabs.map((t) =>
          t === "today_departures"
            ? fetchReservations(PROPERTY_ID, { ...reservationTabQuery(t, today), limit: DEPARTURES_WINDOW_LIMIT }).then((p) => p.items.filter((r) => matchesReservationTab(r, "today_departures", today)).length)
            : fetchReservations(PROPERTY_ID, { ...reservationTabQuery(t, today), limit: 1 }).then((p) => p.total)
        )
      );
      if (!mounted.current) return;
      const next: TabCounts = {};
      let failed = false;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") next[tabs[index]] = result.value;
        else failed = true;
      });
      mergeCounts(next, true);
      if (failed) setCountsError("Algunos contadores no se pudieron calcular.");
    },
    [countsScope, today, mergeCounts]
  );

  // Un solo lote diferido tras el primer pintado de la lista (nunca antes de la primera página).
  useEffect(() => {
    if (!page.data || probed.current) return;
    // La marca se pone al disparar (no al programar): si React limpia el efecto antes (StrictMode), se reprograma.
    const handle = window.setTimeout(() => {
      probed.current = true;
      void loadCounts(tab);
    }, 0);
    return () => window.clearTimeout(handle);
    // Solo la primera vez que hay datos; la pestaña activa ya se contó desde el sobre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.data !== null]);

  // ---------------------------------------------------------------- filas
  const filteredRows: ReservationRow[] = useMemo(() => {
    const roomTypeName = (roomTypeId: string) => roomTypes.find((rt) => rt.id === roomTypeId)?.name ?? roomTypeId;
    const base = stale ? reservations : reservations.filter((r) => matchesReservationTab(r, tab, today));
    const rows = base.map((r) => ({
      ...r,
      guestName: reservationGuestLabel(r, r.primaryGuestId ? guestNames[r.primaryGuestId] : undefined),
      roomTypeLabel: roomTypeName(r.roomTypeId),
      roomNumber: r.assignedRoomId ? roomNumbers[r.assignedRoomId] ?? null : null
    }));
    return roomQuery ? filterRowsByRoom(rows, debouncedQuery) : rows;
  }, [reservations, stale, tab, roomTypes, today, guestNames, roomNumbers, roomQuery, debouncedQuery]);

  const sortedRows = useMemo(() => {
    const dir = sort.direction === "asc" ? 1 : -1;
    const rows = [...filteredRows];
    rows.sort((a, b) => {
      switch (sort.key) {
        case "code":
          return a.code.localeCompare(b.code) * dir;
        case "guestName":
          return a.guestName.localeCompare(b.guestName) * dir;
        case "roomNumber":
          return (a.roomNumber ?? "").localeCompare(b.roomNumber ?? "", "es", { numeric: true }) * dir;
        case "arrivalDate":
          return a.arrivalDate.localeCompare(b.arrivalDate) * dir;
        case "departureDate":
          return a.departureDate.localeCompare(b.departureDate) * dir;
        case "roomTypeLabel":
          return a.roomTypeLabel.localeCompare(b.roomTypeLabel) * dir;
        case "sourceCode":
          return (a.sourceCode ?? "").localeCompare(b.sourceCode ?? "") * dir;
        case "totalAmount":
          return (a.totalAmount - b.totalAmount) * dir;
        case "status":
          return a.status.localeCompare(b.status) * dir;
        default:
          return 0;
      }
    });
    return rows;
  }, [filteredRows, sort]);

  const rowById = useMemo(() => new Map(sortedRows.map((row) => [row.id, row])), [sortedRows]);
  const inspectorRow = inspectorId ? rowById.get(inspectorId) ?? null : null;

  // Cambio de pestaña: fuera la selección; el inspector sigue si la fila sigue visible (y no mientras llega la página nueva).
  useEffect(() => {
    setSelectedKeys([]);
  }, [tab]);
  useEffect(() => {
    if (inspectorId && !stale && !rowById.has(inspectorId)) setInspectorId(null);
  }, [inspectorId, rowById, stale]);
  // < 900 px el panel apila BAJO la tabla (§4 «Inspector lateral»): al abrirlo se trae a la vista (con 51 filas quedaba a 2.000 px).
  const inspectorOpenedRef = useRef(false);
  useEffect(() => {
    const opened = Boolean(inspectorId);
    const justOpened = opened && !inspectorOpenedRef.current;
    inspectorOpenedRef.current = opened;
    if (!justOpened || typeof window === "undefined" || window.innerWidth >= INSPECTOR_STACK_BREAKPOINT) return;
    tableWrapRef.current?.parentElement?.querySelector<HTMLElement>('[data-cocoa="inspector"]')?.scrollIntoView({ block: "nearest" });
  }, [inspectorId]);

  // ---------------------------------------------------------------- prefetch (§6.2: solo con puntero fino)
  const prefetchRow = useCallback(
    (reservationId: string) => {
      if (coarse || lastPrefetched.current === reservationId) return;
      lastPrefetched.current = reservationId;
      void prefetchApi(`/reservations/${reservationId}`, { staleTime: DETAIL_STALE_MS });
      void prefetchApi(`/reservations/${reservationId}/folio`, { staleTime: DETAIL_STALE_MS });
    },
    [coarse]
  );
  const rowIdFromEvent = useCallback(
    (target: EventTarget | null): string | null => {
      const tr = target instanceof Element ? target.closest("tbody tr") : null;
      if (!tr || !tr.parentElement) return null;
      const index = Array.from(tr.parentElement.children).filter((node) => node.tagName === "TR" && node.getAttribute("data-cocoa") !== "table-sentinel").indexOf(tr);
      return sortedRows[index]?.id ?? null;
    },
    [sortedRows]
  );
  const rowElementFor = useCallback(
    (reservationId: string): HTMLElement | null => {
      const index = sortedRows.findIndex((row) => row.id === reservationId);
      if (index < 0) return null;
      const rows = tableWrapRef.current?.querySelectorAll<HTMLElement>("tbody tr[data-interactive]");
      return rows?.[index] ?? null;
    },
    [sortedRows]
  );

  // ↑↓ mueven el inspector sin cerrarlo (fuera de campos de texto).
  const onTableKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!inspectorId || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const index = sortedRows.findIndex((row) => row.id === inspectorId);
      const next = sortedRows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setInspectorId(next.id);
      prefetchRow(next.id);
      rowElementFor(next.id)?.focus({ preventScroll: false });
    },
    [inspectorId, sortedRows, prefetchRow, rowElementFor]
  );

  // ⌥F (registro de U5): enfoca el buscador de esta pantalla.
  useEffect(() => {
    const onFocusSearch = (event: Event) => {
      const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
  }, []);

  // ---------------------------------------------------------------- reconciliación (mismos cajones que Mi día)
  function notify(kind: "ok" | "warn" | "error", text: string) {
    showToast(text, { variant: kind === "ok" ? "success" : kind === "warn" ? "warning" : "error", duration: 5000 });
  }

  const patchRow = useCallback(
    (id: string, patch: Partial<AdminReservation>) => {
      void page.mutate((prev) => patchItems(prev, id, patch), () => Promise.resolve()).catch(() => undefined);
      setMore((current) => (current ? { ...current, items: current.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) } : current));
      invalidateApi(LIST_PATH);
      invalidateApi("/dashboards/front-desk");
      invalidateApi(`/reservations/${id}`);
      // Los KPI cambian con la acción: un solo lote diferido los vuelve a contar (la pestaña activa sale del sobre revalidado).
      countsCache = null;
      window.setTimeout(() => void loadCounts(tab), 0);
    },
    [page, loadCounts, tab]
  );

  const reconcileCheckIn = useCallback(
    (info: QuickCheckInCompleted) => {
      patchRow(info.reservationId, { status: "checked_in", ...(info.reservation?.assignedRoomId ? { assignedRoomId: info.reservation.assignedRoomId } : {}) });
      invalidateApi(`/properties/${PROPERTY_ID}/rooms`);
    },
    [patchRow]
  );
  const reconcileCheckOut = useCallback(
    (info: QuickCheckOutCompleted) => {
      patchRow(info.reservationId, { status: "checked_out" });
      invalidateApi(`/properties/${PROPERTY_ID}/rooms`);
    },
    [patchRow]
  );

  const openPayment = useCallback(
    async (row: ReservationRow) => {
      try {
        await prefetchApi(`/reservations/${row.id}/folio`, { staleTime: DETAIL_STALE_MS });
        const folio = getCached<FolioBalance>(cacheKeyFor({ path: `/reservations/${row.id}/folio` }))?.data ?? (await apiRequest<FolioBalance>(`/reservations/${row.id}/folio`));
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
    (row: ReservationRow, action: PrimaryAction) => {
      switch (action.kind) {
        case "checkin":
          setCheckInTarget({ reservationId: row.id, roomId: row.assignedRoomId ?? candidateRoomsFor(rooms, row.roomTypeId)[0]?.id ?? null });
          return;
        case "checkout":
          setCheckOutTarget(row.id);
          return;
        case "pay":
          void openPayment(row);
          return;
        case "invoice":
        case "open":
        default:
          openReservation(row);
      }
    },
    [rooms, openPayment]
  );

  // ---------------------------------------------------------------- lote (§5.7 (4), F25)
  const selectedRows = useMemo(() => selectedKeys.map((id) => rowById.get(id)).filter((row): row is ReservationRow => Boolean(row)), [selectedKeys, rowById]);
  const selectedInHouse = useMemo(() => selectedRows.filter((row) => row.status === "checked_in"), [selectedRows]);

  // Los saldos de las seleccionadas en el hotel se comprueban por folio (caché 30 s compartida con el inspector),
  // de BALANCE_PROBE_CONCURRENCY en BALANCE_PROBE_CONCURRENCY (⌘A sobre 100 filas no lanza 100 GET a la vez) y un folio que
  // falla queda marcado (NaN): la barra nunca se queda en «Comprobando saldos…» (UX1-REV-12).
  useEffect(() => {
    const missing = selectedInHouse.filter((row) => balances[row.id] === undefined).map((row) => row.id);
    if (missing.length === 0) return;
    let cancelled = false;
    void probeBalances(missing, async (id) => {
      await prefetchApi(`/reservations/${id}/folio`, { staleTime: DETAIL_STALE_MS });
      return getCached<FolioBalance>(cacheKeyFor({ path: `/reservations/${id}/folio` }))?.data?.balanceDue;
    }).then((next) => {
      if (cancelled || !mounted.current) return;
      setBalances((current) => ({ ...current, ...next }));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedInHouse, balances]);

  // UX1-REV-01: solo las que salen hoy o ya debían haber salido; ⌘A sobre «En el hotel» nunca cierra estancias en curso (sin reversa en el API, D9).
  const checkOutCandidates = useMemo(() => selectedInHouse.filter((row) => balances[row.id] !== undefined && balances[row.id] <= CENT && row.departureDate.slice(0, 10) <= today), [selectedInHouse, balances, today]);
  const balancesPending = selectedInHouse.some((row) => balances[row.id] === undefined);
  const balancesFailed = selectedInHouse.filter((row) => Number.isNaN(balances[row.id])).length;
  const assignPlan = useMemo(() => {
    const used = new Set<string>();
    const plan: Array<{ row: ReservationRow; room: RoomLite }> = [];
    for (const row of selectedRows) {
      if (row.assignedRoomId || row.status !== "confirmed") continue;
      const room = candidateRoomsFor(rooms, row.roomTypeId, used)[0];
      if (!room) continue;
      used.add(room.id);
      plan.push({ row, room });
    }
    return plan;
  }, [selectedRows, rooms]);

  const batchRun = useCallback(async <T,>(label: string, items: readonly T[], run: (item: T) => Promise<void>) => {
    const startedAt = Date.now();
    setBatch({ label, done: 0, total: items.length, startedAt });
    const outcome = await runBatch(items, run, { onProgress: (done, count) => setBatch({ label, done, total: count, startedAt }) });
    setBatch(null);
    return outcome;
  }, []);

  const [batchCheckOutPrompt, setBatchCheckOutPrompt] = useState<{ selection: CocoaTableSelection; candidates: ReservationRow[] } | null>(null);
  const runBatchCheckOut = useCallback(
    async (selection: CocoaTableSelection, candidates: ReservationRow[]) => {
      if (candidates.length === 0) return;
      const outcome = await batchRun(FRONT_DESK_ACTIONS.batchCheckOut(candidates.length), candidates, async (row) => {
        await apiRequest(`/reservations/${encodeURIComponent(row.id)}/check-out`, { method: "POST", body: {} });
        patchRow(row.id, { status: "checked_out" });
      });
      selection.clear();
      setBalances({});
      const summary = FRONT_DESK_TOASTS.batchCheckOutSummary(outcome.done, outcome.failed.length);
      notify(outcome.failed.length > 0 ? "warn" : "ok", outcome.failed.length > 0 ? `${summary}: ${outcome.failed.map((entry) => `${entry.item.code} (${entry.message})`).join("; ")}` : summary);
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batchRun, patchRow]
  );
  // §4.2 / UX1-REV-01: una salida cierra directa; N > 1 pasa por el diálogo nominal que lista los códigos.
  const batchCheckOut = useCallback(
    (selection: CocoaTableSelection) => {
      if (checkOutCandidates.length === 0) return;
      if (checkOutCandidates.length === 1) {
        void runBatchCheckOut(selection, checkOutCandidates);
        return;
      }
      setBatchCheckOutPrompt({ selection, candidates: checkOutCandidates });
    },
    [checkOutCandidates, runBatchCheckOut]
  );

  const batchAssign = useCallback(
    async (selection: CocoaTableSelection) => {
      if (assignPlan.length === 0) return;
      const outcome = await batchRun(FRONT_DESK_ACTIONS.batchAssign(assignPlan.length), assignPlan, async ({ row, room }) => {
        await apiRequest(`/reservations/${encodeURIComponent(row.id)}/assign-room`, { method: "POST", body: { roomId: room.id } });
        patchRow(row.id, { assignedRoomId: room.id });
      });
      selection.clear();
      invalidateApi(`/properties/${PROPERTY_ID}/rooms`);
      notify(outcome.failed.length > 0 ? "warn" : "ok", FRONT_DESK_TOASTS.batchAssignSummary(outcome.done, outcome.failed.length));
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assignPlan, batchRun, patchRow]
  );

  const printCards = useCallback(
    (selection: CocoaTableSelection) => {
      if (selectedRows.length === 0) return;
      const popup = window.open("", "_blank", "noopener,width=800,height=900");
      if (!popup) {
        notify("warn", "El navegador ha bloqueado la ventana de impresión.");
        return;
      }
      const cards: FrontDeskRow[] = selectedRows.map((row) => ({
        tab: "arrivals",
        reservationId: row.code,
        guestName: row.guestName,
        status: row.status,
        roomId: row.assignedRoomId ?? undefined,
        roomNumber: row.roomNumber ?? undefined,
        roomTypeId: row.roomTypeId,
        roomTypeName: row.roomTypeLabel,
        arrivalDate: row.arrivalDate,
        departureDate: row.departureDate,
        balanceEur: balances[row.id] ?? 0,
        vip: false,
        specialRequests: row.specialRequests
      }));
      popup.document.write(registrationCardsHtml(cards, getActiveProperty().propertyName));
      popup.document.close();
      popup.focus();
      popup.print();
      selection.clear();
    },
    // notify es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRows, balances]
  );

  const batchBar = (selection: CocoaTableSelection): ReactNode => (
    <>
      {selectedInHouse.length > 0 ? (
        <CocoaButton
          variant="filled"
          tone="accent"
          size="small"
          disabled={checkOutCandidates.length === 0 || balancesPending || Boolean(batch)}
          onClick={() => batchCheckOut(selection)}
          title={balancesPending ? "Comprobando saldos…" : balancesFailed > 0 ? `Saldo sin comprobar en ${balancesFailed}: quita la selección y vuelve a marcarlas para reintentar` : checkOutCandidates.length === 0 ? "Solo salen en lote las estancias sin saldo que salen hoy" : undefined}
        >
          {balancesPending ? "Comprobando saldos…" : FRONT_DESK_ACTIONS.batchCheckOut(checkOutCandidates.length)}
        </CocoaButton>
      ) : null}
      {selectedRows.some((row) => row.status === "confirmed" && !row.assignedRoomId) ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" disabled={assignPlan.length === 0 || Boolean(batch)} onClick={() => void batchAssign(selection)} title={assignPlan.length === 0 ? "Ninguna seleccionada sin habitación con una limpia y libre de su tipo" : undefined}>
          {FRONT_DESK_ACTIONS.batchAssign(assignPlan.length)}
        </CocoaButton>
      ) : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" disabled={selection.count === 0 || Boolean(batch)} onClick={() => printCards(selection)}>
        {FRONT_DESK_ACTIONS.printCards(selection.count)}
      </CocoaButton>
    </>
  );

  // ---------------------------------------------------------------- cabecera, pestañas y cuerpo
  const countLabel = (key: StatusTab): string => (tabCounts[key] === undefined ? "—" : number(tabCounts[key]));
  const countDegraded = (key: StatusTab): boolean => countsError !== null && tabCounts[key] === undefined;

  const segments = TAB_ORDER.map((key) => ({
    value: key,
    label: tabCounts[key] === undefined ? TAB_LABEL[key] : `${TAB_LABEL[key]} (${number(tabCounts[key])})`
  }));

  // Departures are refined client-side, so the server `total` overstates them;
  // for that tab (and for a room search) we report the refined count instead.
  const shownTotal = tab === "today_departures" || roomQuery ? filteredRows.length : total;
  const hasMore = Boolean(nextCursor) && !roomQuery;
  const hasRows = sortedRows.length > 0;
  const listError = page.error && !page.data ? page.error : null;
  const ready = !listError && (hasRows || stale);
  const newReservationLabel = newLabel("f", "reserva");
  const focusSearchLabel = `Buscar en la lista (${shortcutKeys("nav.focus-search")})`;
  const focusSearch = () => window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT, { cancelable: true }));

  const footer = ready ? (
    <>
      <span>
        {sortedRows.length}
        {shownTotal !== null ? ` de ${shownTotal}` : ""} reservas
      </span>
      {moreError ? <CocoaBadge tone="danger">{moreError}</CocoaBadge> : null}
      {hasMore ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMore} onClick={() => void loadMore()}>
          Cargar más
        </CocoaButton>
      ) : null}
    </>
  ) : undefined;

  let body;
  if (listError) {
    body = <CocoaState kind="error" title="No se pudieron cargar las reservas" message={listError} onRetry={page.refresh} />;
  } else if (!page.loading && !hasRows) {
    const emptyAction = roomQuery
      ? tab === "in_house"
        ? { label: ACTIONS.clearFilters, onClick: () => setQuery("") }
        : { label: "Buscar en «En el hotel»", onClick: () => setTab("in_house") }
      : debouncedQuery
        ? { label: ACTIONS.clearFilters, onClick: () => setQuery("") }
        : { label: newReservationLabel, onClick: () => navigateTo("ReservationCreate") };
    body = (
      <CocoaState
        kind="empty"
        illustration={debouncedQuery ? "search" : "box"}
        title={roomQuery ? `Ninguna reserva de esta vista está en la ${debouncedQuery}` : debouncedQuery ? "Ninguna reserva coincide con la búsqueda" : "No hay reservas para este filtro"}
        message={roomQuery ? "La habitación se busca sobre las reservas cargadas de la vista; «En el hotel» tiene todas las ocupadas." : debouncedQuery ? "Prueba con otro nombre, código o número de habitación." : "Cambia de vista o crea una reserva nueva."}
        primaryAction={emptyAction}
      />
    );
  } else {
    body = (
      <CocoaInspectorLayout open={Boolean(inspectorRow)}>
        <div
          ref={tableWrapRef}
          onKeyDown={onTableKeyDown}
          onMouseOver={(event) => {
            const id = rowIdFromEvent(event.target);
            if (id) prefetchRow(id);
          }}
          onFocus={(event) => {
            const id = rowIdFromEvent(event.target);
            if (id) prefetchRow(id);
          }}
        >
          <CocoaTable
            columns={COLUMNS}
            rows={sortedRows}
            rowKey="id"
            sortBy={sort}
            onSort={setSort}
            loading={page.loading}
            keepDataWhileLoading
            selectable="multiple"
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            batchBar={batchBar}
            columnsPrefsKey={COLUMNS_PREFS_KEY}
            selectedKey={inspectorRow?.id}
            onSelect={(row) => {
              setInspectorId((current) => (current === row.id ? null : row.id));
              prefetchRow(row.id);
            }}
            rowActions={(row) => (
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openReservation(row)}>
                {FRONT_DESK_ACTIONS.openReservation}
              </CocoaButton>
            )}
            rowTitle={(row) => `${row.code}: Intro abre el detalle al lado`}
            caption="Reservas"
            aria-label="Reservas"
          />
        </div>
        {inspectorRow ? (
          <ReservationInspector row={inspectorRow} rooms={rooms} today={today} onClose={() => setInspectorId(null)} onPrimary={handlePrimary} returnFocusTo={() => rowElementFor(inspectorRow.id)} />
        ) : null}
      </CocoaInspectorLayout>
    );
  }

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title="Reservas"
      density="operational"
      subtitle={hosted ? undefined : "Búsqueda por nombre, código o habitación, filtros operativos y detalle al lado de la lista."}
      actions={
        hosted ? undefined : (
          <>
            <CocoaButton variant="bordered" tone="neutral" icon={<UploadIcon />} onClick={openImport}>
              {IMPORT_LABEL}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" icon={<PlusIcon />} onClick={() => navigateTo("ReservationCreate")}>
              {newReservationLabel}
            </CocoaButton>
          </>
        )
      }
      commands={[
        { id: "reservas-nueva", label: newReservationLabel, run: () => navigateTo("ReservationCreate") },
        { id: "reservas-buscar", label: focusSearchLabel, run: focusSearch },
        { id: "reservas-importar", label: IMPORT_LABEL, run: openImport }
      ]}
    >
      <CocoaScreenInstructionsCard
        title="Reservas"
        description={RESERVATIONS_INSTRUCTIONS.whatIsThis}
        steps={[...RESERVATIONS_INSTRUCTIONS.howToUse]}
        tip={RESERVATIONS_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="reservations"
      />

      <CocoaKpiStrip stagger aria-label="Reservas de hoy">
        <CocoaKpi
          label="Llegan hoy"
          value={countLabel("today_arrivals")}
          caption="Confirmadas o alojadas con llegada hoy"
          tone={tab === "today_arrivals" ? "accent" : undefined}
          degraded={countDegraded("today_arrivals")}
          onClick={() => setTab("today_arrivals")}
        />
        <CocoaKpi
          label="En el hotel"
          value={countLabel("in_house")}
          caption="Huéspedes actualmente alojados"
          tone={tab === "in_house" ? "accent" : undefined}
          degraded={countDegraded("in_house")}
          onClick={() => setTab("in_house")}
        />
        <CocoaKpi
          label="Salen hoy"
          value={countLabel("today_departures")}
          caption="Alojadas con salida hoy"
          tone={tab === "today_departures" ? "accent" : undefined}
          degraded={countDegraded("today_departures")}
          onClick={() => setTab("today_departures")}
        />
        <CocoaKpi
          label="Futuras"
          value={countLabel("future")}
          caption="Confirmadas y por llegar"
          tone={tab === "future" ? "accent" : undefined}
          degraded={countDegraded("future")}
          onClick={() => setTab("future")}
        />
      </CocoaKpiStrip>

      {countsError ? (
        <CocoaCallout
          tone="warning"
          role="status"
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void loadCounts(tab)}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {countsError}
        </CocoaCallout>
      ) : null}

      {page.error && page.data ? (
        <CocoaCallout tone="warning" role="status" actions={<CocoaButton variant="bordered" tone="neutral" size="small" onClick={page.refresh}>{ACTIONS.retry}</CocoaButton>}>
          {`Datos desactualizados: ${page.error}`}
        </CocoaCallout>
      ) : null}

      {batch ? (
        <CocoaCallout tone="info" role="status" title={batch.label}>
          {batchProgressLabel(batch.done, batch.total, Date.now() - batch.startedAt)}
        </CocoaCallout>
      ) : null}

      <CocoaToolbar
        variant="content"
        aria-label="Búsqueda y vistas de reservas"
        leftSlot={
          <CocoaSearchInput
            id={SEARCH_INPUT_ID}
            value={query}
            onChange={setQuery}
            placeholder="Buscar por nombre, código o habitación…"
            aria-label="Buscar reservas por nombre, código o habitación"
          />
        }
        rightSlot={
          <>
            <CocoaSegmentedControl value={tab} options={segments} onChange={(v) => setTab(v as StatusTab)} size="small" aria-label="Vistas operativas" />
            {shownTotal !== null && !page.loading ? <CocoaBadge tone="neutral">{`${sortedRows.length} de ${shownTotal}`}</CocoaBadge> : null}
          </>
        }
      />

      <CocoaSection padding={ready ? "none" : "md"} footer={footer} style={{ overflow: "clip" }} aria-label="Listado de reservas">
        {body}
      </CocoaSection>

      {/* Cajones y cobro en el sitio: los mismos que Mi día, con la fila reconciliada al terminar. */}
      {checkInTarget ? <QuickCheckInDrawer reservationId={checkInTarget.reservationId} initialRoomId={checkInTarget.roomId} onClose={() => setCheckInTarget(null)} onCompleted={reconcileCheckIn} /> : null}
      {checkOutTarget ? <QuickCheckOutDrawer reservationId={checkOutTarget} onClose={() => setCheckOutTarget(null)} onCompleted={reconcileCheckOut} /> : null}
      {payTarget ? (
        <PaymentDialog
          open
          onClose={() => setPayTarget(null)}
          folioId={payTarget.folioId}
          propertyId={PROPERTY_ID}
          currency={payTarget.currency}
          balanceDue={payTarget.balanceDue}
          subject={`Reserva ${payTarget.row.code}`}
          onCaptured={() => {
            invalidateApi(`/reservations/${payTarget.row.id}/folio`);
            setBalances((current) => {
              const next = { ...current };
              delete next[payTarget.row.id];
              return next;
            });
            setPayTarget(null);
          }}
        />
      ) : null}
      <CocoaDialog
        open={batchCheckOutPrompt !== null}
        onClose={() => setBatchCheckOutPrompt(null)}
        tone="destructive"
        title={FRONT_DESK_ACTIONS.batchCheckOut(batchCheckOutPrompt?.candidates.length ?? 0)}
        description={batchCheckOutPrompt ? `Se cerrarán ${batchCheckOutPrompt.candidates.length} estancias con saldo 0 que salen hoy (${batchCheckOutPrompt.candidates.map((row) => row.code).join(", ")}). Las habitaciones pasarán a sucia y el check-out no se puede deshacer.` : undefined}
        size="sm"
        confirmLabel={FRONT_DESK_ACTIONS.batchCheckOut(batchCheckOutPrompt?.candidates.length ?? 0)}
        cancelLabel={FRONT_DESK_ACTIONS.reviewSelection}
        onConfirm={() => {
          const prompt = batchCheckOutPrompt;
          setBatchCheckOutPrompt(null);
          if (prompt) void runBatchCheckOut(prompt.selection, prompt.candidates);
        }}
      />
    </CocoaPage>
  );
}

export default ReservationsListScreen;
