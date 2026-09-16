// Reservas — Recepción › Reservas › Lista (/recepcion/reservas/lista).
//
// Cocoa 22 · ola 3 · lote 3-A (list archetype, template `ListaTabla`; §6 keeps
// it at the dashboard budget): CocoaPage → guidance card → CocoaKpiStrip with
// the four operational counters (each opens its view) → CocoaToolbar (search,
// segmented views with live counts, «N de M») → CocoaSection padding none +
// CocoaTable (controlled sort, a row opens /recepcion/reservas/:id, footer
// with the count and «Cargar más») → CocoaState empty / error inside the
// section so the toolbar stays. Same queries, page size and 300 ms debounce
// as before. Hosted inside ReservasTabs the container paints the title and
// the «Nueva reserva» action.
//
// fix:3-A qa#7: a row without booker name only carries the primary guest id;
// the names are resolved through /guests/:id (one request per distinct id
// per mount) and, until they arrive or if the lookup fails, the row reads
// «Huésped pendiente» — never the internal id.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { urlForScreen } from "../../navigation/nav-tree";
import {
  fetchReservations,
  fetchRoomTypes,
  matchesReservationTab,
  reservationTabQuery,
  todayIsoLocal,
  type AdminReservation,
  type AdminRoomType,
  type ReservationListQuery,
  type ReservationOperationalTab
} from "../../services/pmsCommerceApi";
import { fetchGuest } from "../../services/guestsApi";
import { guestFullName, pendingGuestIds, reservationGuestLabel } from "./reservation-guest-label";
import { useTabHost } from "../tabs/TabHost";
import { navigateTo } from "../../lib/navigate";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { RESERVATIONS_INSTRUCTIONS } from "../../content/screen-instructions/reservations";
import { date, money, number } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTableSort,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

// Rows fetched per page. The API clamps at 500; 100 keeps the first paint
// light and "Cargar más" walks the cursor for the rest.
const PAGE_SIZE = 100;
// Window used to count / list today's departures: the API only offers the
// overlap filter, so we pull the in-house window and refine client-side.
const DEPARTURES_WINDOW_LIMIT = 300;

// Operational tabs aligned with the daily front-desk rhythm. Every tab maps to
// a server-side filter (reservationTabQuery); counts come from `total` of a
// limit=1 request per tab so the badges stay accurate without loading everything.
type StatusTab = ReservationOperationalTab;

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  checked_in: "Alojada",
  checked_out: "Salida",
  cancelled: "Cancelada",
  no_show: "No-show"
};

function statusTone(status: string): CocoaTone {
  switch (status) {
    case "confirmed":
    case "checked_in":
      return "success";
    case "checked_out":
      return "info";
    case "cancelled":
    case "no_show":
      return "danger";
    case "draft":
      return "warning";
    default:
      return "neutral";
  }
}

interface ReservationRow extends AdminReservation {
  // Derived display helpers so the table can sort without recomputing.
  guestName: string;
  roomTypeLabel: string;
}

type TabCounts = Partial<Record<StatusTab, number>>;

const COUNT_TABS: StatusTab[] = ["all", "today_arrivals", "in_house", "future", "cancelled"];

const TAB_LABEL: Record<StatusTab, string> = {
  all: "Todas",
  today_arrivals: "Llegan hoy",
  in_house: "En casa",
  today_departures: "Salen hoy",
  future: "Futuras",
  cancelled: "Canceladas"
};
const TAB_ORDER: StatusTab[] = ["all", "today_arrivals", "in_house", "today_departures", "future", "cancelled"];

const COLUMNS: CocoaTableColumn<ReservationRow>[] = [
  { key: "code", label: "Código", sortable: true, fit: true, render: (row) => <strong>{row.code}</strong> },
  { key: "guestName", label: FIELD_LABELS.guest, sortable: true, minWidth: 160 },
  { key: "arrivalDate", label: "Llegada", sortable: true, fit: true, render: (row) => date(row.arrivalDate, "dayMonth") },
  { key: "departureDate", label: "Salida", sortable: true, fit: true, hideOnNarrow: true, render: (row) => date(row.departureDate, "dayMonth") },
  { key: "roomTypeLabel", label: FIELD_LABELS.roomType, sortable: true, showFrom: "laptop" },
  {
    key: "sourceCode",
    label: "Origen",
    sortable: true,
    fit: true,
    showFrom: "desktop",
    render: (row) => (row.sourceCode ? <CocoaBadge tone="neutral">{row.sourceCode}</CocoaBadge> : "—")
  },
  { key: "totalAmount", label: FIELD_LABELS.total, sortable: true, align: "right", render: (row) => <strong>{money(row.totalAmount, row.currency)}</strong> },
  {
    key: "status",
    label: FIELD_LABELS.status,
    sortable: true,
    fit: true,
    render: (row) => <CocoaBadge tone={statusTone(row.status)}>{STATUS_LABEL[row.status] ?? row.status}</CocoaBadge>
  }
];

function mergeById(current: AdminReservation[], incoming: AdminReservation[]): AdminReservation[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...incoming.filter((r) => !seen.has(r.id))];
}

// Deep link to /recepcion/reservas/:id (Detalle tab of the Reservas container,
// Tanda 5): reload + browser history restore the workspace and the detail
// screen parses the id from the trailing slug.
function openReservation(row: ReservationRow) {
  const url = urlForScreen("ReservationDetailWorkspace", { id: row.id });
  if (url) openTabPath(url);
}

export function ReservationsListScreen() {
  const hosted = useTabHost() !== null;
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tab, setTab] = useState<StatusTab>("today_arrivals");
  const [tabCounts, setTabCounts] = useState<TabCounts>({});
  const [countsError, setCountsError] = useState<string | null>(null);
  const [sort, setSort] = useState<CocoaTableSort>({ key: "arrivalDate", direction: "asc" });
  // Guards against out-of-order responses when the user switches tabs quickly.
  const requestSeq = useRef(0);
  // Primary guest names by id for the rows without booker name (qa#7). The
  // list endpoint does not join the guest, so each distinct id is requested
  // once per mount; a failed lookup keeps «Huésped pendiente» and is not
  // retried until the screen mounts again.
  const [guestNames, setGuestNames] = useState<Record<string, string>>({});
  const requestedGuestIds = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const ids = pendingGuestIds(reservations, requestedGuestIds.current);
    if (ids.length === 0) return;
    ids.forEach((id) => requestedGuestIds.current.add(id));
    void Promise.allSettled(ids.map((id) => fetchGuest(id))).then((results) => {
      if (!mounted.current) return;
      const resolved: Record<string, string> = {};
      results.forEach((result, index) => {
        const name = result.status === "fulfilled" ? guestFullName(result.value.guest) : null;
        if (name) resolved[ids[index]] = name;
      });
      if (Object.keys(resolved).length > 0) setGuestNames((current) => ({ ...current, ...resolved }));
    });
  }, [reservations]);

  const today = todayIsoLocal();

  // Debounce the search box: the `q` filter is server-side.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const buildQuery = useCallback(
    (cursor?: string): ReservationListQuery => ({
      ...reservationTabQuery(tab, today),
      q: debouncedQuery || undefined,
      limit: tab === "today_departures" ? DEPARTURES_WINDOW_LIMIT : PAGE_SIZE,
      cursor
    }),
    [tab, today, debouncedQuery]
  );

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchReservations(PROPERTY_ID, buildQuery()),
      roomTypes.length > 0 ? Promise.resolve(roomTypes) : fetchRoomTypes(PROPERTY_ID)
    ])
      .then(([page, types]) => {
        if (seq !== requestSeq.current) return;
        setReservations(page.items);
        setNextCursor(page.nextCursor);
        setTotal(page.total);
        setRoomTypes(types);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        // Auditoría 2026-07: never fabricate reservations when the API fails.
        setReservations([]);
        setNextCursor(null);
        setTotal(null);
        setError(err instanceof Error ? err.message : "No se pudieron cargar las reservas.");
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
    // roomTypes is only read to skip a refetch; it must not retrigger the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildQuery]);

  useEffect(() => {
    load();
  }, [load]);

  // Per-tab counts for the KPI tiles and segment badges. One limit=1 request
  // per exact server filter; departures need the overlap window + refinement.
  // A failed count shows «—» instead of a fabricated 0.
  const loadCounts = useCallback(async () => {
    setCountsError(null);
    const results = await Promise.allSettled([
      ...COUNT_TABS.map((t) => fetchReservations(PROPERTY_ID, { ...reservationTabQuery(t, today), limit: 1 })),
      fetchReservations(PROPERTY_ID, { ...reservationTabQuery("today_departures", today), limit: DEPARTURES_WINDOW_LIMIT })
    ]);
    const next: TabCounts = {};
    let failed = false;
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") {
        failed = true;
        return;
      }
      if (index < COUNT_TABS.length) {
        next[COUNT_TABS[index]] = result.value.total;
      } else {
        next.today_departures = result.value.items.filter((r) => matchesReservationTab(r, "today_departures", today)).length;
      }
    });
    setTabCounts(next);
    if (failed) setCountsError("Algunos contadores no se pudieron calcular.");
  }, [today]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchReservations(PROPERTY_ID, buildQuery(nextCursor));
      setReservations((current) => mergeById(current, page.items));
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar más reservas.");
    } finally {
      setLoadingMore(false);
    }
  }

  // The server filter is exact for every tab but "today_departures"; the
  // refinement is applied uniformly so the two definitions never diverge.
  const filteredRows: ReservationRow[] = useMemo(() => {
    const roomTypeName = (roomTypeId: string) => roomTypes.find((rt) => rt.id === roomTypeId)?.name ?? roomTypeId;
    return reservations
      .filter((r) => matchesReservationTab(r, tab, today))
      .map((r) => ({
        ...r,
        guestName: reservationGuestLabel(r, r.primaryGuestId ? guestNames[r.primaryGuestId] : undefined),
        roomTypeLabel: roomTypeName(r.roomTypeId)
      }));
  }, [reservations, tab, roomTypes, today, guestNames]);

  const sortedRows = useMemo(() => {
    const dir = sort.direction === "asc" ? 1 : -1;
    const rows = [...filteredRows];
    rows.sort((a, b) => {
      switch (sort.key) {
        case "code":
          return a.code.localeCompare(b.code) * dir;
        case "guestName":
          return a.guestName.localeCompare(b.guestName) * dir;
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

  const countLabel = (key: StatusTab): string => (tabCounts[key] === undefined ? "—" : number(tabCounts[key]));
  const countDegraded = (key: StatusTab): boolean => countsError !== null && tabCounts[key] === undefined;

  const segments = TAB_ORDER.map((key) => ({
    value: key,
    label: tabCounts[key] === undefined ? TAB_LABEL[key] : `${TAB_LABEL[key]} (${number(tabCounts[key])})`
  }));

  // Departures are refined client-side, so the server `total` overstates them;
  // for that tab we report the refined count instead.
  const shownTotal = tab === "today_departures" ? filteredRows.length : total;
  const hasMore = Boolean(nextCursor);
  const ready = !loading && !error && sortedRows.length > 0;
  const newReservationLabel = newLabel("f", "reserva");

  const footer = ready ? (
    <>
      <span>
        {sortedRows.length}
        {shownTotal !== null ? ` de ${shownTotal}` : ""} reservas
      </span>
      {hasMore ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMore} onClick={() => void loadMore()}>
          Cargar más
        </CocoaButton>
      ) : null}
    </>
  ) : undefined;

  let body;
  if (loading) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Reservas" />;
  } else if (error) {
    body = <CocoaState kind="error" title="No se pudieron cargar las reservas" message={error} onRetry={load} />;
  } else if (sortedRows.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={debouncedQuery ? "search" : "box"}
        title={debouncedQuery ? "Ninguna reserva coincide con la búsqueda" : "No hay reservas para este filtro"}
        message={debouncedQuery ? "Prueba con otro nombre o código." : "Cambia de vista o crea una reserva nueva."}
        primaryAction={debouncedQuery ? { label: ACTIONS.clearFilters, onClick: () => setQuery("") } : { label: newReservationLabel, onClick: () => navigateTo("ReservationCreate") }}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={sortedRows}
        rowKey="id"
        sortBy={sort}
        onSort={setSort}
        onSelect={openReservation}
        rowTitle={() => "Abrir el detalle de la reserva"}
        caption="Reservas"
        aria-label="Reservas"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title="Reservas"
      subtitle={hosted ? undefined : "Búsqueda, filtros operativos y acceso al espacio de cada reserva."}
      actions={
        hosted ? undefined : (
          <CocoaButton variant="filled" tone="accent" icon={<PlusIcon />} onClick={() => navigateTo("ReservationCreate")}>
            {newReservationLabel}
          </CocoaButton>
        )
      }
      commands={[{ id: "reservas-nueva", label: newReservationLabel, run: () => navigateTo("ReservationCreate") }]}
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
          label="Llegadas hoy"
          value={countLabel("today_arrivals")}
          caption="Confirmadas o alojadas con llegada hoy"
          tone={tab === "today_arrivals" ? "accent" : undefined}
          degraded={countDegraded("today_arrivals")}
          onClick={() => setTab("today_arrivals")}
        />
        <CocoaKpi
          label="En casa"
          value={countLabel("in_house")}
          caption="Huéspedes actualmente alojados"
          tone={tab === "in_house" ? "accent" : undefined}
          degraded={countDegraded("in_house")}
          onClick={() => setTab("in_house")}
        />
        <CocoaKpi
          label="Salidas hoy"
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
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void loadCounts()}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {countsError}
        </CocoaCallout>
      ) : null}

      <CocoaToolbar
        variant="content"
        aria-label="Búsqueda y vistas de reservas"
        leftSlot={
          <CocoaSearchInput
            id="reservations-search"
            value={query}
            onChange={setQuery}
            placeholder="Buscar por nombre o código…"
            aria-label="Buscar reservas por nombre o código"
          />
        }
        rightSlot={
          <>
            <CocoaSegmentedControl value={tab} options={segments} onChange={(v) => setTab(v as StatusTab)} size="small" aria-label="Vistas operativas" />
            {shownTotal !== null && !loading ? <CocoaBadge tone="neutral">{`${sortedRows.length} de ${shownTotal}`}</CocoaBadge> : null}
          </>
        }
      />

      <CocoaSection padding={ready ? "none" : "md"} footer={footer} style={{ overflow: "clip" }} aria-label="Listado de reservas">
        {body}
      </CocoaSection>
    </CocoaPage>
  );
}

export default ReservationsListScreen;
