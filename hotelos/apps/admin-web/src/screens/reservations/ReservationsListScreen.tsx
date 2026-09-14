import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
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
import { PageHeader } from "../../components/v2/PageHeader";
import { SearchInput } from "../../components/v2/SearchInput";
import {
  SegmentedControl,
  type SegmentOption
} from "../../components/v2/SegmentedControl";
import { StatTile } from "../../components/v2/StatTile";
import { StatusBadge, type StatusBadgeVariant } from "../../components/v2/StatusBadge";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSort
} from "../../components/v2/DataTable";
import { LoadingBlock, ErrorState } from "../../components/States";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { RESERVATIONS_INSTRUCTIONS } from "../../content/screen-instructions/reservations";

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

function statusVariant(status: string): StatusBadgeVariant {
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
      return "warn";
    default:
      return "neutral";
  }
}

const MONTHS_ES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic"
];

function fmtShortDate(iso: string): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const mi = Number(parts[1]) - 1;
  if (mi < 0 || mi > 11) return iso;
  return `${Number(parts[2])} ${MONTHS_ES[mi]}`;
}

function guestLabel(reservation: AdminReservation): string {
  return (
    reservation.bookerName ?? reservation.primaryGuestId ?? "Huésped pendiente"
  );
}

// Lightweight chip used for "Source" cells. Mirrors the StatusBadge spacing
// but uses neutral palette so it never competes with the status column.
function SourceChip({ value }: { value?: string }) {
  if (!value) return <span style={{ color: "var(--ink-muted, #6a6a6a)" }}>—</span>;
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    background: "var(--neutral-bg, #f0eee8)",
    color: "var(--neutral-ink, #424242)",
    border: "1px solid var(--neutral-line, #d8d4ca)",
    borderRadius: "var(--radius-full, 999px)",
    fontSize: "var(--fs-xs, 11px)",
    fontWeight: 600,
    whiteSpace: "nowrap"
  };
  return <span style={style}>{value}</span>;
}

function navTo(screen: string) {
  // The App router listens for the `hotelos-nav` CustomEvent and reads
  // `detail` as the target screen key.
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}


interface ReservationRow extends AdminReservation {
  // Derived display helpers so DataTable columns can sort cleanly without
  // recomputing on each render.
  guestName: string;
  roomTypeLabel: string;
}

type TabCounts = Partial<Record<StatusTab, number>>;

const COUNT_TABS: StatusTab[] = ["all", "today_arrivals", "in_house", "future", "cancelled"];

function mergeById(current: AdminReservation[], incoming: AdminReservation[]): AdminReservation[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...incoming.filter((r) => !seen.has(r.id))];
}

export function ReservationsListScreen() {
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
  const [sort, setSort] = useState<DataTableSort>({
    key: "arrivalDate",
    direction: "asc"
  });
  // Guards against out-of-order responses when the user switches tabs quickly.
  const requestSeq = useRef(0);

  const today = todayIsoLocal();

  // Debounce the search box: the `q` filter is server-side now.
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
        // Auditoría 2026-07: NUNCA fabricar reservas mock ante un fallo de API.
        // Bajo el gate de auth de producción esto pintaba reservas inventadas
        // (res_mock_*) como si fueran reales delante del usuario/inversor.
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
  // A failed count shows "—" instead of a fabricated 0.
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

  function roomTypeName(roomTypeId: string): string {
    return roomTypes.find((rt) => rt.id === roomTypeId)?.name ?? roomTypeId;
  }

  // The server filter is exact for every tab but "today_departures"; the
  // refinement is applied uniformly so the two definitions never diverge.
  const filteredRows: ReservationRow[] = useMemo(() => {
    return reservations
      .filter((r) => matchesReservationTab(r, tab, today))
      .map((r) => ({
        ...r,
        guestName: guestLabel(r),
        roomTypeLabel: roomTypeName(r.roomTypeId)
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, roomTypes, today]);

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

  const badge = (key: StatusTab): number | string | undefined => tabCounts[key];
  const tileValue = (key: StatusTab): number | string => tabCounts[key] ?? "—";

  const segments: SegmentOption[] = [
    { value: "all", label: "Todas", badge: badge("all") },
    {
      value: "today_arrivals",
      label: "Llegan hoy",
      badge: badge("today_arrivals")
    },
    { value: "in_house", label: "In-house", badge: badge("in_house") },
    {
      value: "today_departures",
      label: "Salen hoy",
      badge: badge("today_departures")
    },
    { value: "future", label: "Futuras", badge: badge("future") },
    { value: "cancelled", label: "Canceladas", badge: badge("cancelled") }
  ];

  const columns: DataTableColumn<ReservationRow>[] = [
    {
      key: "code",
      label: "Código",
      sortable: true,
      render: (row) => (
        <span style={{ fontWeight: 600, color: "var(--ink, #1a1a1a)" }}>
          {row.code}
        </span>
      )
    },
    {
      key: "guestName",
      label: "Huésped",
      sortable: true,
      render: (row) => row.guestName
    },
    {
      key: "arrivalDate",
      label: "Llegada",
      sortable: true,
      render: (row) => fmtShortDate(row.arrivalDate)
    },
    {
      key: "departureDate",
      label: "Salida",
      sortable: true,
      render: (row) => fmtShortDate(row.departureDate)
    },
    {
      key: "roomTypeLabel",
      label: "Tipo hab.",
      sortable: true,
      render: (row) => row.roomTypeLabel
    },
    {
      key: "sourceCode",
      label: "Source",
      sortable: true,
      render: (row) => <SourceChip value={row.sourceCode} />
    },
    {
      key: "totalAmount",
      label: "Total",
      sortable: true,
      align: "right",
      render: (row) => (
        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
          {row.totalAmount.toLocaleString("es-ES")} {row.currency}
        </span>
      )
    },
    {
      key: "status",
      label: "Estado",
      sortable: true,
      render: (row) => (
        <StatusBadge variant={statusVariant(row.status)} size="sm">
          {STATUS_LABEL[row.status] ?? row.status}
        </StatusBadge>
      )
    }
  ];

  function openReservation(row: ReservationRow) {
    // Push the deep-link path so reload + browser-history both restore the
    // workspace. The detail screen parses `res_*` from the trailing slug.
    window.history.pushState(
      null,
      "",
      `/backoffice/reservations/${row.id}`
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    // Also fire `hotelos-nav` for environments where the router watches the
    // CustomEvent instead of (or in addition to) the popstate URL.
    navTo("ReservationDetailWorkspace");
  }

  const wrapperStyle: CSSProperties = {
    padding: "var(--space-6, 24px)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5, 20px)"
  };

  const toolbarStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3, 12px)",
    flexWrap: "wrap"
  };

  const kpiGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "var(--space-4, 16px)"
  };

  // Departures are refined client-side, so the server `total` overstates them;
  // for that tab we report the refined count instead.
  const shownTotal = tab === "today_departures" ? filteredRows.length : total;
  const hasMore = Boolean(nextCursor);

  return (
    <section style={wrapperStyle}>
      <PageHeader
        eyebrow="PMS · Reservas"
        title="Reservas"
        subtitle="Búsqueda, filtros operativos y acceso al espacio de cada reserva."
        actions={
          <CocoaButton
            variant="filled"
            tone="accent"
            icon={<PlusIcon />}
            onClick={() => navTo("ReservationCreate")}
          >
            Nueva reserva
          </CocoaButton>
        }
      />

      <CocoaScreenInstructionsCard
        title="Reservas"
        description={RESERVATIONS_INSTRUCTIONS.whatIsThis}
        steps={[...RESERVATIONS_INSTRUCTIONS.howToUse]}
        tip={RESERVATIONS_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="reservations"
      />

      <div style={kpiGridStyle}>
        <StatTile
          label="Llegadas hoy"
          value={tileValue("today_arrivals")}
          color="ok"
          helper="Confirmadas o alojadas con llegada hoy"
          loading={loading && tabCounts.today_arrivals === undefined}
          onClick={() => setTab("today_arrivals")}
        />
        <StatTile
          label="In-house"
          value={tileValue("in_house")}
          color="default"
          helper="Huéspedes actualmente alojados"
          loading={loading && tabCounts.in_house === undefined}
          onClick={() => setTab("in_house")}
        />
        <StatTile
          label="Salidas"
          value={tileValue("today_departures")}
          color="warn"
          helper="Departure = hoy"
          loading={loading && tabCounts.today_departures === undefined}
          onClick={() => setTab("today_departures")}
        />
        <StatTile
          label="Futuras"
          value={tileValue("future")}
          color="default"
          helper="Confirmadas y por llegar"
          loading={loading && tabCounts.future === undefined}
          onClick={() => setTab("future")}
        />
      </div>
      {countsError ? (
        <p style={{ margin: 0, fontSize: "var(--fs-xs, 12px)", color: "var(--ink-muted, #6a6a6a)" }}>
          {countsError}{" "}
          <button type="button" className="bo-link" onClick={() => void loadCounts()}>
            Reintentar
          </button>
        </p>
      ) : null}

      <div style={toolbarStyle}>
        <div style={{ flex: "1 1 260px", maxWidth: 360 }}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Buscar por nombre o código…"
            ariaLabel="Buscar reservas"
          />
        </div>
        <SegmentedControl
          value={tab}
          options={segments}
          onChange={(v) => setTab(v as StatusTab)}
          size="md"
          ariaLabel="Filtros operativos"
        />
        {shownTotal !== null && !loading ? (
          <span style={{ fontSize: "var(--fs-xs, 12px)", color: "var(--ink-muted, #6a6a6a)" }}>
            {sortedRows.length} de {shownTotal}
          </span>
        ) : null}
      </div>

      {loading ? (
        <LoadingBlock label="Cargando reservas…" />
      ) : error ? (
        <ErrorState
          title="No se pudieron cargar las reservas"
          message={error}
          onRetry={load}
          retryLabel="Reintentar"
        />
      ) : (
        <>
          <DataTable<ReservationRow>
            columns={columns}
            rows={sortedRows}
            rowKey="id"
            sortBy={sort}
            onSort={setSort}
            onRowClick={openReservation}
            density="comfortable"
            emptyState={
              debouncedQuery
                ? "Ninguna reserva coincide con la búsqueda."
                : "No hay reservas para este filtro."
            }
          />
          {hasMore ? (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <CocoaButton
                variant="bordered"
                tone="neutral"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                loading={loadingMore}
              >
                Cargar más
              </CocoaButton>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default ReservationsListScreen;
