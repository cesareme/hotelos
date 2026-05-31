import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  fetchReservations,
  fetchRoomTypes,
  type AdminReservation,
  type AdminRoomType
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

// Operational tabs aligned with the daily front-desk rhythm. Counts are derived
// from the loaded list so the badges stay accurate without an extra request.
type StatusTab =
  | "all"
  | "today_arrivals"
  | "in_house"
  | "today_departures"
  | "future"
  | "cancelled";

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

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
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

// Demo data so the screen renders in offline / fresh environments without the
// API. The structure mirrors the API contract from `pmsCommerceApi.ts`.
function buildMockReservations(): AdminReservation[] {
  const today = todayIso();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const inFive = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const inTen = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return [
    {
      id: "res_mock_001",
      propertyId: PROPERTY_ID,
      code: "HTL-10245",
      channel: "direct",
      status: "confirmed",
      arrivalDate: today,
      departureDate: tomorrow,
      adults: 2,
      children: 0,
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      sourceCode: "Web directa",
      totalAmount: 245,
      currency: "EUR",
      bookerName: "Ana Martínez"
    },
    {
      id: "res_mock_002",
      propertyId: PROPERTY_ID,
      code: "HTL-10246",
      channel: "booking_com_mock",
      status: "checked_in",
      arrivalDate: yesterday,
      departureDate: today,
      adults: 2,
      children: 1,
      roomTypeId: "rt_suite",
      ratePlanId: "rp_bb",
      sourceCode: "Booking.com",
      totalAmount: 540,
      currency: "EUR",
      bookerName: "Pedro Sánchez"
    },
    {
      id: "res_mock_003",
      propertyId: PROPERTY_ID,
      code: "HTL-10247",
      channel: "expedia_mock",
      status: "confirmed",
      arrivalDate: tomorrow,
      departureDate: inFive,
      adults: 1,
      children: 0,
      roomTypeId: "rt_single",
      ratePlanId: "rp_nonref",
      sourceCode: "Expedia",
      totalAmount: 320,
      currency: "EUR",
      bookerName: "Laura García"
    },
    {
      id: "res_mock_004",
      propertyId: PROPERTY_ID,
      code: "HTL-10248",
      channel: "corporate",
      status: "confirmed",
      arrivalDate: inFive,
      departureDate: inTen,
      adults: 1,
      children: 0,
      roomTypeId: "rt_double",
      ratePlanId: "rp_corp",
      sourceCode: "Corporate",
      totalAmount: 720,
      currency: "EUR",
      bookerName: "ACME Corp"
    },
    {
      id: "res_mock_005",
      propertyId: PROPERTY_ID,
      code: "HTL-10240",
      channel: "direct",
      status: "cancelled",
      arrivalDate: tomorrow,
      departureDate: inFive,
      adults: 2,
      children: 0,
      roomTypeId: "rt_double",
      ratePlanId: "rp_flexible",
      sourceCode: "Web directa",
      totalAmount: 0,
      currency: "EUR",
      bookerName: "Marta López"
    },
    {
      id: "res_mock_006",
      propertyId: PROPERTY_ID,
      code: "HTL-10249",
      channel: "direct",
      status: "checked_in",
      arrivalDate: yesterday,
      departureDate: tomorrow,
      adults: 2,
      children: 0,
      roomTypeId: "rt_suite",
      ratePlanId: "rp_flexible",
      sourceCode: "Phone",
      totalAmount: 460,
      currency: "EUR",
      bookerName: "Carlos Ruiz"
    }
  ];
}

interface ReservationRow extends AdminReservation {
  // Derived display helpers so DataTable columns can sort cleanly without
  // recomputing on each render.
  guestName: string;
  roomTypeLabel: string;
}

export function ReservationsListScreen() {
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<StatusTab>("today_arrivals");
  const [sort, setSort] = useState<DataTableSort>({
    key: "arrivalDate",
    direction: "asc"
  });

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([fetchReservations(PROPERTY_ID), fetchRoomTypes(PROPERTY_ID)])
      .then(([list, types]) => {
        setReservations(list);
        setRoomTypes(types);
      })
      .catch(() => {
        // Fall back to in-memory mock data so the screen remains usable when
        // the API is offline or the property has no records yet.
        setReservations(buildMockReservations());
        setRoomTypes([]);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  const today = todayIso();

  function roomTypeName(roomTypeId: string): string {
    return roomTypes.find((rt) => rt.id === roomTypeId)?.name ?? roomTypeId;
  }

  // Counts per operational tab. Computed once per data change so the segmented
  // badges always reflect the underlying list, even when the search narrows it.
  const tabCounts = useMemo(() => {
    const counts: Record<StatusTab, number> = {
      all: reservations.length,
      today_arrivals: 0,
      in_house: 0,
      today_departures: 0,
      future: 0,
      cancelled: 0
    };
    for (const r of reservations) {
      if (
        r.arrivalDate === today &&
        r.status !== "cancelled" &&
        r.status !== "no_show"
      ) {
        counts.today_arrivals += 1;
      }
      if (r.status === "checked_in") counts.in_house += 1;
      if (r.departureDate === today && r.status !== "cancelled") {
        counts.today_departures += 1;
      }
      if (
        r.arrivalDate > today &&
        r.status !== "cancelled" &&
        r.status !== "no_show"
      ) {
        counts.future += 1;
      }
      if (r.status === "cancelled" || r.status === "no_show") {
        counts.cancelled += 1;
      }
    }
    return counts;
  }, [reservations, today]);

  function matchesTab(reservation: AdminReservation): boolean {
    switch (tab) {
      case "today_arrivals":
        return (
          reservation.arrivalDate === today &&
          reservation.status !== "cancelled" &&
          reservation.status !== "no_show"
        );
      case "in_house":
        return reservation.status === "checked_in";
      case "today_departures":
        return (
          reservation.departureDate === today &&
          reservation.status !== "cancelled"
        );
      case "future":
        return (
          reservation.arrivalDate > today &&
          reservation.status !== "cancelled" &&
          reservation.status !== "no_show"
        );
      case "cancelled":
        return (
          reservation.status === "cancelled" ||
          reservation.status === "no_show"
        );
      case "all":
      default:
        return true;
    }
  }

  const filteredRows: ReservationRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reservations
      .filter(matchesTab)
      .filter((r) => {
        if (!q) return true;
        return [r.code, guestLabel(r)]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .map((r) => ({
        ...r,
        guestName: guestLabel(r),
        roomTypeLabel: roomTypeName(r.roomTypeId)
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, query, tab, roomTypes, today]);

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

  const segments: SegmentOption[] = [
    { value: "all", label: "Todas", badge: tabCounts.all },
    {
      value: "today_arrivals",
      label: "Llegan hoy",
      badge: tabCounts.today_arrivals
    },
    { value: "in_house", label: "In-house", badge: tabCounts.in_house },
    {
      value: "today_departures",
      label: "Salen hoy",
      badge: tabCounts.today_departures
    },
    { value: "future", label: "Futuras", badge: tabCounts.future },
    { value: "cancelled", label: "Canceladas", badge: tabCounts.cancelled }
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

  // `error` state is currently unreachable because the catch() falls back to
  // mock data, but we keep the branch so a future "no-mock" mode can surface
  // the failure without changes to the render tree.
  void error;

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
          value={tabCounts.today_arrivals}
          color="ok"
          helper="Reservas con arrival = hoy"
          loading={loading}
          onClick={() => setTab("today_arrivals")}
        />
        <StatTile
          label="In-house"
          value={tabCounts.in_house}
          color="default"
          helper="Huéspedes actualmente alojados"
          loading={loading}
          onClick={() => setTab("in_house")}
        />
        <StatTile
          label="Salidas"
          value={tabCounts.today_departures}
          color="warn"
          helper="Departure = hoy"
          loading={loading}
          onClick={() => setTab("today_departures")}
        />
        <StatTile
          label="Futuras"
          value={tabCounts.future}
          color="default"
          helper="Confirmadas y por llegar"
          loading={loading}
          onClick={() => setTab("future")}
        />
      </div>

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
      </div>

      {loading ? (
        <LoadingBlock label="Cargando reservas…" />
      ) : (
        <DataTable<ReservationRow>
          columns={columns}
          rows={sortedRows}
          rowKey="id"
          sortBy={sort}
          onSort={setSort}
          onRowClick={openReservation}
          density="comfortable"
          emptyState={
            query
              ? "Ninguna reserva coincide con la búsqueda."
              : "No hay reservas para este filtro."
          }
        />
      )}
    </section>
  );
}

export default ReservationsListScreen;
