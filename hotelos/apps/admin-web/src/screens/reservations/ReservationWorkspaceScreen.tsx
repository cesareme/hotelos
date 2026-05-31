import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useMemo, useState } from "react";
import {
  assignReservationRoom,
  cancelReservation,
  checkInReservation,
  checkOutReservation,
  fetchGuestActivity,
  fetchReservation,
  fetchReservationFolio,
  fetchReservations,
  fetchRooms,
  fetchRoomTypes,
  noShowReservation,
  postFolioLine,
  postFolioPayment,
  type ActivityItem,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type FolioBalance,
  type GuestActivity
} from "../../services/pmsCommerceApi";
import { LoadingBlock, EmptyState, ErrorState } from "../../components/States";
import { useToast } from "../../components/Toast";
import { exportToCsv, type CsvColumn } from "../../lib/csv";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaSearchInput } from "../../components/cocoa/CocoaSearchInput";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";

const PROPERTY_ID = getActivePropertyId();

function nav(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}
function guestLabel(reservation: AdminReservation) {
  return reservation.bookerName ?? reservation.primaryGuestId ?? "Huésped pendiente";
}
const STATUS_FILTERS = ["all", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"] as const;

const STATUS_LABEL: Record<string, string> = {
  draft: "borrador",
  confirmed: "confirmada",
  checked_in: "alojado",
  checked_out: "salida",
  cancelled: "cancelada",
  no_show: "no-show"
};
const STATUS_FILTER_LABEL: Record<string, string> = {
  all: "Todas",
  confirmed: "Confirmadas",
  checked_in: "Alojados",
  checked_out: "Salidas",
  cancelled: "Canceladas",
  no_show: "No-show"
};

// Status tabs aligned to operational moments (today's arrivals, in-house, today's
// departures, future bookings, cancellations). These are derived dynamically from
// today's date so they remain accurate without a deploy.
type StatusTab = "today_arrivals" | "in_house" | "today_departures" | "future" | "cancelled" | "all";
const STATUS_TABS: { key: StatusTab; label: string }[] = [
  { key: "today_arrivals", label: "Llegan hoy" },
  { key: "in_house", label: "In-house" },
  { key: "today_departures", label: "Salen hoy" },
  { key: "future", label: "Futuras" },
  { key: "cancelled", label: "Canceladas" },
  { key: "all", label: "Todas" }
];

// Sortable columns for the reservations table. Visual sort indicators (▲▼) appear
// on the active column header and the user toggles direction by clicking again.
type SortKey = "code" | "guest" | "arrival" | "departure" | "roomType" | "status" | "total";
type SortDir = "asc" | "desc";

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function fmtShort(iso: string): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const mi = Number(parts[1]) - 1;
  if (mi < 0 || mi > 11) return iso;
  return `${Number(parts[2])} ${MONTHS_ES[mi]}`;
}

// Soft cap on the number of rows rendered before nudging the user to refine the
// search. Keeps the DOM bounded without forcing pagination yet.
const ROW_CAP = 150;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ReservationWorkspaceScreen() {
  const { showToast } = useToast();
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [selected, setSelected] = useState<AdminReservation | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [statusTab, setStatusTab] = useState<StatusTab>("today_arrivals");
  const [sortKey, setSortKey] = useState<SortKey>("arrival");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([fetchReservations(PROPERTY_ID), fetchRoomTypes(PROPERTY_ID)])
      .then(([reservationResponse, roomTypeResponse]) => {
        setReservations(reservationResponse);
        setRoomTypes(roomTypeResponse);
        setSelected((cur) => cur ?? reservationResponse[0] ?? null);
      })
      .catch(() => setError("No se pudieron cargar las reservas. Inténtalo de nuevo."))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  useEffect(() => {
    if (!selected) {
      setFolio(null);
      return;
    }
    void fetchReservationFolio(selected.id).then(setFolio).catch(() => setFolio(null));
  }, [selected]);

  const statusCounts = useMemo(() => {
    return reservations.reduce<Record<string, number>>((counts, reservation) => {
      counts[reservation.status] = (counts[reservation.status] ?? 0) + 1;
      return counts;
    }, {});
  }, [reservations]);

  // Bug fix: arrivals KPI should reflect bookings whose arrival is today or later
  // (dynamic) rather than a hard-coded date that would silently rot.
  const today = todayIso();
  const arrivals = reservations.filter((reservation) => reservation.arrivalDate >= today).length;
  const totalValue = reservations.reduce((total, reservation) => total + reservation.totalAmount, 0);

  function roomTypeName(roomTypeId: string) {
    return roomTypes.find((roomType) => roomType.id === roomTypeId)?.name ?? roomTypeId;
  }

  async function openReservation(reservationId: string) {
    const reservation = await fetchReservation(reservationId);
    setSelected(reservation);
  }

  const q = query.trim().toLowerCase();

  // Tab-based filtering: matches the operational moment chosen by the user (arrivals
  // today, in-house, departures today, future, cancelled). The legacy status pills
  // are still honored after the tab filter for finer slicing.
  function matchesStatusTab(reservation: AdminReservation): boolean {
    switch (statusTab) {
      case "today_arrivals":
        return reservation.arrivalDate === today && reservation.status !== "cancelled" && reservation.status !== "no_show";
      case "in_house":
        return reservation.status === "checked_in";
      case "today_departures":
        return reservation.departureDate === today && reservation.status !== "cancelled";
      case "future":
        return reservation.arrivalDate > today && reservation.status !== "cancelled" && reservation.status !== "no_show";
      case "cancelled":
        return reservation.status === "cancelled" || reservation.status === "no_show";
      case "all":
      default:
        return true;
    }
  }

  const filtered = reservations.filter((r) => {
    if (!matchesStatusTab(r)) return false;
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (!q) return true;
    return [r.code, guestLabel(r), r.arrivalDate, r.departureDate, roomTypeName(r.roomTypeId)]
      .join(" ").toLowerCase().includes(q);
  });

  // Counts per tab so each chip shows actionable volume at a glance.
  const tabCounts = useMemo(() => {
    const counts: Record<StatusTab, number> = {
      today_arrivals: 0, in_house: 0, today_departures: 0, future: 0, cancelled: 0, all: reservations.length
    };
    for (const r of reservations) {
      if (r.arrivalDate === today && r.status !== "cancelled" && r.status !== "no_show") counts.today_arrivals += 1;
      if (r.status === "checked_in") counts.in_house += 1;
      if (r.departureDate === today && r.status !== "cancelled") counts.today_departures += 1;
      if (r.arrivalDate > today && r.status !== "cancelled" && r.status !== "no_show") counts.future += 1;
      if (r.status === "cancelled" || r.status === "no_show") counts.cancelled += 1;
    }
    return counts;
  }, [reservations, today]);

  // Sortable, in-memory sort over the filtered rows. Stable across renders because
  // we always reassign through a new array. Server-side sort can replace this when
  // pagination lands without disturbing the column UI contract.
  const sortedRows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const rows = [...filtered];
    rows.sort((a, b) => {
      switch (sortKey) {
        case "code": return a.code.localeCompare(b.code) * dir;
        case "guest": return guestLabel(a).localeCompare(guestLabel(b)) * dir;
        case "arrival": return a.arrivalDate.localeCompare(b.arrivalDate) * dir;
        case "departure": return a.departureDate.localeCompare(b.departureDate) * dir;
        case "roomType": return roomTypeName(a.roomTypeId).localeCompare(roomTypeName(b.roomTypeId)) * dir;
        case "status": return a.status.localeCompare(b.status) * dir;
        case "total": return (a.totalAmount - b.totalAmount) * dir;
        default: return 0;
      }
    });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir]);

  // Export the currently-filtered list (respects search + tab + status) so the
  // CSV always matches what the user is looking at.
  function handleExportCsv() {
    if (filtered.length === 0) {
      showToast("No hay reservas para exportar", { variant: "info" });
      return;
    }
    const columns: CsvColumn<AdminReservation>[] = [
      { key: "code", label: "Código" },
      { key: "bookerName", label: "Huésped", format: (_v, r) => guestLabel(r) },
      { key: "arrivalDate", label: "Llegada" },
      { key: "departureDate", label: "Salida" },
      { key: "adults", label: "Adultos" },
      { key: "children", label: "Niños" },
      { key: "roomTypeId", label: "Tipo habitación", format: (v) => roomTypeName(String(v)) },
      { key: "channel", label: "Canal" },
      { key: "sourceCode", label: "Origen" },
      { key: "marketSegment", label: "Segmento" },
      { key: "status", label: "Estado", format: (v) => STATUS_LABEL[String(v)] ?? String(v ?? "") },
      { key: "totalAmount", label: "Total" },
      { key: "currency", label: "Divisa" }
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    exportToCsv(filtered, `reservas-${stamp}`, columns);
    showToast(`Exportadas ${filtered.length} reservas a CSV`, { variant: "success" });
  }

  // Status pills via the secondary status filter — kept as a select for finer
  // slicing within the tab. Each option shows the label + a live count.
  const statusFilterOptions = useMemo(
    () =>
      STATUS_FILTERS.map((s) => ({
        value: s,
        label: `${STATUS_FILTER_LABEL[s] ?? s}${s !== "all" ? ` (${statusCounts[s] ?? 0})` : ""}`
      })),
    [statusCounts]
  );

  // The tab options use the live tab counts so each segment shows actionable
  // volume at a glance.
  const tabOptions = useMemo(
    () =>
      STATUS_TABS.map((tab) => ({
        value: tab.key,
        label: `${tab.label} (${tabCounts[tab.key]})`
      })),
    [tabCounts]
  );

  // Columns for the Cocoa table. Render functions keep the existing visual
  // affordances (status pill, monospace total, clickable code) untouched while
  // the table chrome itself is repainted.
  const tableColumns: CocoaTableColumn<AdminReservation>[] = [
    {
      key: "code",
      label: "Código",
      sortable: true,
      render: (r) => (
        <button
          type="button"
          className="bo-link"
          onClick={(event) => {
            event.stopPropagation();
            void openReservation(r.id);
          }}
        >
          {r.code}
        </button>
      )
    },
    { key: "guest", label: "Huésped", sortable: true, render: (r) => guestLabel(r) },
    { key: "arrival", label: "Llegada", sortable: true, render: (r) => fmtShort(r.arrivalDate) },
    { key: "departure", label: "Salida", sortable: true, render: (r) => fmtShort(r.departureDate) },
    { key: "roomType", label: "Tipo", sortable: true, render: (r) => roomTypeName(r.roomTypeId) },
    {
      key: "status",
      label: "Estado",
      sortable: true,
      render: (r) => {
        const kind =
          r.status === "confirmed" || r.status === "checked_in"
            ? "ok"
            : r.status === "cancelled" || r.status === "no_show"
              ? "error"
              : "info";
        return <span className={`bo-status ${kind}`}>{STATUS_LABEL[r.status] ?? r.status}</span>;
      }
    },
    {
      key: "total",
      label: "Total",
      sortable: true,
      align: "right",
      render: (r) => `${r.totalAmount} ${r.currency}`
    }
  ];

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">PMS · Reservas</p>
          <h2>Espacio de reservas</h2>
        </div>
        <span className="bo-chip">{reservations.length} reservas</span>
      </div>
      <p>
        Creación y gestión de reservas. Cada reserva incluye origen y categoría, fechas de estancia, recurso asignado,
        estado del folio, instrucción de cobro y campos para informes.
      </p>

      {/* KPI strip — flat cards stacked on a responsive grid using cocoa tokens. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "var(--cocoa-space-3)",
          marginTop: "var(--cocoa-space-3)"
        }}
      >
        <CocoaCard variant="bordered" padding="md">
          <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Reservas</span>
          <div style={{ fontSize: "var(--cocoa-fs-title-1)", fontWeight: 600, color: "var(--cocoa-label)", marginTop: "var(--cocoa-space-1)" }}>
            {reservations.length}
          </div>
          <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
            Todas las reservas activas e históricas de la demo.
          </p>
        </CocoaCard>
        <CocoaCard variant="bordered" padding="md">
          <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Llegadas en vista</span>
          <div style={{ fontSize: "var(--cocoa-fs-title-1)", fontWeight: 600, color: "var(--cocoa-label)", marginTop: "var(--cocoa-space-1)" }}>
            {arrivals}
          </div>
          <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
            Entrada para los informes de llegadas y salidas.
          </p>
        </CocoaCard>
        <CocoaCard variant="bordered" padding="md">
          <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Valor reservado</span>
          <div style={{ fontSize: "var(--cocoa-fs-title-1)", fontWeight: 600, color: "var(--cocoa-label)", marginTop: "var(--cocoa-space-1)" }}>
            {totalValue} EUR
          </div>
          <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
            Alimenta los informes de facturación e ingresos.
          </p>
        </CocoaCard>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-4)" }}>
        <CocoaButton variant="filled" tone="accent" onClick={() => nav("ReservationAgent")}>Agente de reservas IA</CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" onClick={() => nav("ReservationCreate")}>Crear reserva</CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" onClick={() => nav("GuestsList")}>Huéspedes</CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" onClick={() => nav("CategoryManagerScreen")}>Categorías de reserva</CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" onClick={() => nav("ReportingCenter")}>Informes de reservas</CocoaButton>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(360px, 1fr)",
          gap: "var(--cocoa-space-4)",
          marginTop: "var(--cocoa-space-4)"
        }}
      >
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Lista de reservas</h3>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-2)" }}>
              <span className="bo-chip">{filtered.length} de {reservations.length}</span>
              <CocoaButton variant="bordered" tone="neutral" onClick={handleExportCsv}>Exportar CSV</CocoaButton>
            </div>
          </div>

          {/* Search input filters by name and reservation code (and other quick keys). */}
          <div style={{ marginBottom: "var(--cocoa-space-3)" }}>
            <CocoaSearchInput
              value={query}
              onChange={setQuery}
              placeholder="Nombre o código (p. ej. R-2026-018)…"
            />
          </div>

          {/* Status tabs aligned to operational moments. */}
          <div style={{ marginBottom: "var(--cocoa-space-3)", overflowX: "auto" }}>
            <CocoaSegmentedControl
              aria-label="Estado operativo de las reservas"
              value={statusTab}
              onChange={(v) => setStatusTab(v as StatusTab)}
              options={tabOptions}
            />
          </div>

          {/* Bulk actions bar — disabled placeholder for Q3 (cancel selected, group
              transfer, export). Selection checkboxes drive this state.
              TODO(cocoa): use CocoaSheet for cancel/no-show confirmation */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "var(--cocoa-space-3)",
              flexWrap: "wrap",
              gap: "var(--cocoa-space-2)"
            }}
          >
            <span style={{ color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
              {selectedRowIds.size ? `${selectedRowIds.size} seleccionada(s)` : "Selección múltiple"}
            </span>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              disabled={selectedRowIds.size === 0}
              onClick={() => showToast("Acciones masivas estarán disponibles en Q3", { variant: "info" })}
            >
              Acciones masivas (Q3)
            </CocoaButton>
          </div>

          {/* Secondary status filter (legacy) kept for finer slicing within a tab. */}
          <div style={{ marginBottom: "var(--cocoa-space-3)", maxWidth: "320px" }}>
            <CocoaSelect
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as (typeof STATUS_FILTERS)[number])}
              options={statusFilterOptions}
            />
          </div>

          {/* TODO(cocoa): States primitives — replace LoadingBlock/EmptyState/ErrorState with Cocoa equivalents when they ship. */}
          {loading ? (
            <LoadingBlock label="Cargando reservas…" />
          ) : error ? (
            <ErrorState message={error} onRetry={load} />
          ) : sortedRows.length === 0 ? (
            <EmptyState
              title={reservations.length ? "Sin coincidencias" : "Aún no hay reservas"}
              message={
                reservations.length
                  ? "Ninguna reserva coincide con tu búsqueda, pestaña o filtro."
                  : "Crea una manualmente o deja que el agente de IA tome una solicitud."
              }
              actions={
                <button className="primary" type="button" onClick={() => nav("ReservationAgent")}>
                  Agente de reservas IA
                </button>
              }
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <CocoaTable<AdminReservation>
                columns={tableColumns}
                rows={sortedRows.slice(0, ROW_CAP)}
                rowKey="id"
                selectedKey={selected?.id}
                onSelect={(r) => setSelected(r)}
                sortBy={{ key: sortKey, direction: sortDir }}
                onSort={(s) => {
                  setSortKey(s.key as SortKey);
                  setSortDir(s.direction);
                }}
              />
              {sortedRows.length > ROW_CAP ? (
                <CocoaCard variant="bordered" padding="sm">
                  <span style={{ color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                    y {sortedRows.length - ROW_CAP} más — usa la búsqueda para acotar
                  </span>
                </CocoaCard>
              ) : null}
            </div>
          )}
        </section>

        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Detalle de la reserva</h3>
            <span className="bo-chip">{selected?.code ?? "Selecciona una reserva"}</span>
          </div>
          {selected ? (
            <>
              <dl className="bo-definition-grid">
                <div><dt>Huésped / titular</dt><dd>{guestLabel(selected)}</dd></div>
                <div><dt>Estancia</dt><dd>{fmtShort(selected.arrivalDate)} → {fmtShort(selected.departureDate)}</dd></div>
                <div><dt>Tipo de habitación</dt><dd>{roomTypeName(selected.roomTypeId)}</dd></div>
                <div><dt>Canal</dt><dd>{selected.channel}</dd></div>
                <div><dt>Origen</dt><dd>{selected.sourceCode ?? "Sin definir"}</dd></div>
                <div><dt>Segmento</dt><dd>{selected.marketSegment ?? "Sin definir"}</dd></div>
                <div><dt>Instrucción de cobro</dt><dd>{selected.billingInstruction ?? "Sin definir"}</dd></div>
                <div><dt>Total</dt><dd>{selected.totalAmount} {selected.currency}</dd></div>
              </dl>
              <CocoaCard variant="bordered" padding="md">
                <h3 style={{ margin: 0, marginBottom: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
                  Folio
                </h3>
                {folio ? (
                  <p style={{ color: "var(--cocoa-label-secondary)" }}>
                    Cargos {folio.chargesTotal} · Pagos {folio.paymentsTotal} · Saldo {folio.balanceDue} {folio.folio.currency}
                  </p>
                ) : (
                  <p style={{ color: "var(--cocoa-label-secondary)" }}>Folio aún no cargado.</p>
                )}
              </CocoaCard>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-3)" }}>
                <CocoaButton
                  variant="filled"
                  tone="accent"
                  onClick={() => {
                    window.history.pushState(null, "", `/backoffice/reservations/${selected.id}`);
                    window.dispatchEvent(new PopStateEvent("popstate"));
                  }}
                >
                  Abrir detalle completo
                </CocoaButton>
                {selected.primaryGuestId ? (
                  <CocoaButton
                    variant="bordered"
                    tone="neutral"
                    onClick={() => {
                      window.history.pushState(null, "", `/backoffice/guests/${selected.primaryGuestId}`);
                      window.dispatchEvent(new PopStateEvent("popstate"));
                    }}
                  >
                    Abrir ficha del huésped
                  </CocoaButton>
                ) : null}
                <CocoaButton variant="bordered" tone="neutral" onClick={() => nav("BillingCenter")}>
                  Abrir facturación
                </CocoaButton>
              </div>
            </>
          ) : (
            <EmptyState
              title="No hay ninguna reserva seleccionada"
              message="Selecciona una reserva del listado de la izquierda para ver su detalle, folio y acciones disponibles."
            />
          )}
        </section>
      </div>
    </section>
  );
}

const CHARGE_TYPES = [
  { value: "minibar", label: "Minibar" },
  { value: "breakfast", label: "Desayuno" },
  { value: "parking", label: "Parking" },
  { value: "room", label: "Alojamiento" },
  { value: "adjustment", label: "Ajuste" }
];
const PAYMENT_METHODS = [
  { value: "card", label: "Tarjeta" },
  { value: "cash", label: "Efectivo" },
  { value: "bank_transfer", label: "Transferencia" },
  { value: "payment_link", label: "Link de pago" }
];

// Internal tabs inside the reservation detail workspace. Routing is local (no URL
// segment) so deep-linking still lands on Summary by default; we can lift this to
// the URL when the back-end exposes per-tab data sub-endpoints. Order matches the
// natural flow of a front-desk session: overview → billing → audit → travelers →
// paperwork (the last is a Q3 placeholder pending DMS integration).
type DetailTab = "summary" | "folio" | "activity" | "guests" | "documents";
const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "summary", label: "Resumen" },
  { key: "folio", label: "Folio" },
  { key: "activity", label: "Actividad" },
  { key: "guests", label: "Huéspedes" },
  { key: "documents", label: "Documentos" }
];

// Map activity item kinds to a short Spanish label for the audit timeline.
// TODO(cocoa): activity icon mapping completeness — replace with an icon per kind once the icon set is complete.
const ACTIVITY_KIND_LABEL: Record<ActivityItem["kind"], string> = {
  message: "Mensaje",
  housekeeping: "Housekeeping",
  maintenance: "Mantenimiento",
  service_request: "Petición"
};

// Format an ISO timestamp for the activity timeline: keeps date+time in 24h Spanish
// format and gracefully falls back to the raw string when parsing fails.
function fmtActivityWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = MONTHS_ES[d.getMonth()] ?? "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd} ${mo} · ${hh}:${mi}`;
}

export function ReservationDetailWorkspaceScreen() {
  // Bug fix: only the last path segment that actually matches a reservation slug
  // pattern should be used. We never silently fall back to a hard-coded id, which
  // previously surfaced an unrelated booking when routing was misconfigured.
  const lastSegment = window.location.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const reservationId = /^res_/.test(lastSegment) ? lastSegment : "";
  const [reservation, setReservation] = useState<AdminReservation | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [chargeType, setChargeType] = useState("minibar");
  const [chargeDesc, setChargeDesc] = useState("Minibar");
  const [chargeAmount, setChargeAmount] = useState("12");
  const [payMethod, setPayMethod] = useState("card");
  const [payAmount, setPayAmount] = useState("");
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");
  // Activity feed is fetched lazily on tab open to avoid pulling the audit log when
  // the user is just glancing at the summary. Failure is treated as "empty" — the
  // tab still renders the explanatory copy.
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  async function reload() {
    if (!reservationId) {
      setReservation(null);
      setFolio(null);
      setActivity(null);
      return;
    }
    const res = await fetchReservation(reservationId).catch(() => null);
    setReservation(res);
    if (res) {
      setSelectedRoomId((current) => current || res.assignedRoomId || "");
      void fetchRooms(res.propertyId).then(setRooms).catch(() => setRooms([]));
    }
    void fetchReservationFolio(reservationId).then(setFolio).catch(() => setFolio(null));
    // Invalidate the cached activity so a post-mutation reload (check-in, charge,
    // cancellation…) triggers a fresh fetch the next time the tab is opened.
    setActivity(null);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId]);

  // Lazy-load the activity feed the first time the user opens the Actividad tab.
  // Re-running an action that mutates the reservation (check-in, check-out, etc.)
  // resets it via the reload() side-effect below so the timeline stays in sync.
  useEffect(() => {
    if (activeTab !== "activity" || !reservationId) return;
    if (activity && activity.reservationId === reservationId) return;
    setActivityLoading(true);
    setActivityError(null);
    fetchGuestActivity(reservationId)
      .then((data) => setActivity(data))
      .catch(() => setActivityError("No se pudo cargar la actividad. Inténtalo de nuevo."))
      .finally(() => setActivityLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, reservationId]);

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(`${label}…`);
    try {
      await fn();
      await reload();
      setMessage(`${label} ✓`);
    } catch (error) {
      setMessage(`${label} — ${error instanceof Error ? error.message : "error"}`);
    } finally {
      setBusy(false);
    }
  }

  const status = reservation?.status ?? "";
  const canAssign = status === "confirmed";
  const canCheckIn = status === "confirmed";
  const canCheckOut = status === "checked_in";
  const canCancel = status === "confirmed";
  const folioId = folio?.folio.id;
  const folioOpen = folio?.folio.status === "open";

  // Detail tab options — repainted with the Cocoa segmented control. Badges
  // moved into the labels so the cocoa segmented control (no badge slot) keeps
  // the live counts the v2 control exposed.
  const detailTabOptions = useMemo(
    () =>
      DETAIL_TABS.map((tab) => {
        if (tab.key === "folio" && folio) {
          return { value: tab.key, label: `${tab.label} (${folio.lines.length})` };
        }
        if (tab.key === "activity" && activity) {
          return { value: tab.key, label: `${tab.label} (${activity.items.length})` };
        }
        if (tab.key === "guests" && reservation) {
          return {
            value: tab.key,
            label: `${tab.label} (${(reservation.adults ?? 0) + (reservation.children ?? 0)})`
          };
        }
        return { value: tab.key, label: tab.label };
      }),
    [folio, activity, reservation]
  );

  // Rooms options for the assignment select — keeps the original filter (only
  // sellable rooms, plus the currently-assigned room if any).
  const roomOptions = useMemo(() => {
    if (!reservation) return [{ value: "", label: "Selecciona habitación…" }];
    const filteredRooms = rooms.filter((r) => r.sellable || r.id === reservation.assignedRoomId);
    return [
      { value: "", label: "Selecciona habitación…" },
      ...filteredRooms.map((r) => ({
        value: r.id,
        label: `${r.number} · ${r.housekeepingStatus ?? r.status}`
      }))
    ];
  }, [rooms, reservation]);

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">PMS · Reserva</p>
          <h2>{reservation?.code ?? "Detalle de reserva"}</h2>
        </div>
        {reservation ? (
          <span
            className={`bo-status ${status === "confirmed" || status === "checked_in" ? "ok" : status === "cancelled" || status === "no_show" ? "error" : "warn"}`}
          >
            {STATUS_LABEL[status] ?? status}
          </span>
        ) : null}
      </div>

      {reservation ? (
        <>
          {/* Internal tab navigation built on the Cocoa segmented control: gives
              the detail view a single, calmer affordance for switching context
              (folio, activity, guests, docs) without overwhelming the summary on
              first load. Live counts are encoded into the label since the cocoa
              segmented control does not yet expose a dedicated badge slot. */}
          <div style={{ marginBottom: "var(--cocoa-space-3)", overflowX: "auto" }}>
            <CocoaSegmentedControl
              aria-label="Secciones de la reserva"
              value={activeTab}
              onChange={(v) => setActiveTab(v as DetailTab)}
              options={detailTabOptions}
            />
          </div>

          {activeTab === "summary" ? (
            <CocoaCard variant="bordered" padding="md">
              <h3 style={{ margin: 0, fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>{reservation.code}</h3>
              <p style={{ color: "var(--cocoa-label-secondary)" }}>{guestLabel(reservation)}</p>
              <dl className="bo-definition-grid">
                <div><dt>Estancia</dt><dd>{reservation.arrivalDate} → {reservation.departureDate}</dd></div>
                <div><dt>Adultos / niños</dt><dd>{reservation.adults} / {reservation.children}</dd></div>
                <div><dt>Canal</dt><dd>{[reservation.channel, reservation.sourceCode, reservation.marketSegment].filter(Boolean).join(" / ") || "Directo"}</dd></div>
                <div><dt>Habitación asignada</dt><dd>{rooms.find((r) => r.id === reservation.assignedRoomId)?.number ?? (reservation.assignedRoomId ? reservation.assignedRoomId : "Sin asignar")}</dd></div>
                <div><dt>Garantía</dt><dd>{reservation.guaranteeType ?? "Sin definir"}</dd></div>
                <div><dt>Total</dt><dd>{reservation.totalAmount} {reservation.currency}</dd></div>
              </dl>

              <h3 style={{ margin: 0, marginTop: "var(--cocoa-space-3)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
                Recepción
              </h3>
              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--cocoa-space-1)",
                  marginTop: "var(--cocoa-space-2)"
                }}
              >
                <span style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)" }}>Habitación</span>
                <CocoaSelect
                  value={selectedRoomId}
                  onChange={setSelectedRoomId}
                  options={roomOptions}
                  disabled={busy}
                />
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-3)" }}>
                <CocoaButton
                  variant="tinted"
                  tone="accent"
                  disabled={busy || !canAssign || !selectedRoomId}
                  onClick={() =>
                    void runAction("Asignar habitación", () => assignReservationRoom(reservation.id, { roomId: selectedRoomId }))
                  }
                >
                  Asignar habitación
                </CocoaButton>
                <CocoaButton
                  variant="filled"
                  tone="accent"
                  disabled={busy || !canCheckIn || !selectedRoomId}
                  onClick={() => void runAction("Check-in", () => checkInReservation(reservation.id, { roomId: selectedRoomId }))}
                >
                  Check-in
                </CocoaButton>
                <CocoaButton
                  variant="filled"
                  tone="accent"
                  disabled={busy || !canCheckOut}
                  onClick={() => void runAction("Check-out", () => checkOutReservation(reservation.id))}
                >
                  Check-out
                </CocoaButton>
              </div>
              {/* TODO(cocoa): use CocoaSheet for cancel/no-show confirmation */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-2)" }}>
                <CocoaButton
                  variant="filled"
                  tone="destructive"
                  disabled={busy || !canCancel}
                  onClick={() => void runAction("Cancelar", () => cancelReservation(reservation.id, "Front-desk cancellation"))}
                >
                  Cancelar
                </CocoaButton>
                <CocoaButton
                  variant="filled"
                  tone="destructive"
                  disabled={busy || !canCancel}
                  onClick={() => void runAction("No-show", () => noShowReservation(reservation.id, "No-show at front desk"))}
                >
                  No-show
                </CocoaButton>
              </div>
            </CocoaCard>
          ) : null}

          {activeTab === "folio" ? (
            <CocoaCard variant="bordered" padding="md">
              <h3 style={{ margin: 0, marginBottom: "var(--cocoa-space-2)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
                Folio &amp; facturación
              </h3>
              {folio ? (
                <>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                      gap: "var(--cocoa-space-3)"
                    }}
                  >
                    <CocoaCard variant="bordered" padding="md">
                      <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Cargos</span>
                      <strong style={{ display: "block", marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-title-3)", color: "var(--cocoa-label)" }}>
                        {folio.chargesTotal} {folio.folio.currency}
                      </strong>
                    </CocoaCard>
                    <CocoaCard variant="bordered" padding="md">
                      <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Pagos</span>
                      <strong style={{ display: "block", marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-title-3)", color: "var(--cocoa-label)" }}>
                        {folio.paymentsTotal} {folio.folio.currency}
                      </strong>
                    </CocoaCard>
                    <CocoaCard variant="bordered" padding="md">
                      <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Saldo</span>
                      <strong style={{ display: "block", marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-title-3)", color: "var(--cocoa-label)" }}>
                        {folio.balanceDue} {folio.folio.currency}
                      </strong>
                    </CocoaCard>
                  </div>
                  {folio.lines.length > 0 ? (
                    <table className="bo-table" style={{ marginTop: "var(--cocoa-space-3)" }}>
                      <tbody>
                        {folio.lines.map((l) => (
                          <tr key={l.id}>
                            <td>{l.description}</td>
                            <td style={{ textAlign: "right" }}>
                              {l.total} {folio.folio.currency}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p style={{ color: "var(--cocoa-label-secondary)", marginTop: "var(--cocoa-space-2)" }}>Sin cargos todavía.</p>
                  )}

                  <h3 style={{ margin: 0, marginTop: "var(--cocoa-space-3)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
                    Postear cargo
                  </h3>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                      gap: "var(--cocoa-space-3)",
                      marginTop: "var(--cocoa-space-2)"
                    }}
                  >
                    <label style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)" }}>
                      <span style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)" }}>Tipo</span>
                      <CocoaSelect
                        value={chargeType}
                        onChange={(v) => {
                          setChargeType(v);
                          setChargeDesc(CHARGE_TYPES.find((c) => c.value === v)?.label ?? "");
                        }}
                        options={CHARGE_TYPES}
                        disabled={busy}
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)" }}>
                      <span style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)" }}>Descripción</span>
                      <CocoaInput value={chargeDesc} onChange={setChargeDesc} disabled={busy} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)" }}>
                      <span style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)" }}>Importe (€)</span>
                      <CocoaInput
                        value={chargeAmount}
                        onChange={setChargeAmount}
                        type="number"
                        inputMode="decimal"
                        disabled={busy}
                      />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-2)" }}>
                    <CocoaButton
                      variant="tinted"
                      tone="accent"
                      disabled={busy || !folioId || !folioOpen || !Number(chargeAmount)}
                      onClick={() =>
                        void runAction("Cargo posteado", () =>
                          postFolioLine(folioId!, {
                            type: chargeType,
                            description: chargeDesc || chargeType,
                            quantity: 1,
                            unitPrice: Number(chargeAmount)
                          })
                        )
                      }
                    >
                      Añadir cargo
                    </CocoaButton>
                  </div>

                  <h3 style={{ margin: 0, marginTop: "var(--cocoa-space-3)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
                    Registrar pago
                  </h3>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                      gap: "var(--cocoa-space-3)",
                      marginTop: "var(--cocoa-space-2)"
                    }}
                  >
                    <label style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)" }}>
                      <span style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)" }}>Método</span>
                      <CocoaSelect value={payMethod} onChange={setPayMethod} options={PAYMENT_METHODS} disabled={busy} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)" }}>
                      <span style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)" }}>Importe (€)</span>
                      <CocoaInput
                        value={payAmount}
                        onChange={setPayAmount}
                        type="number"
                        inputMode="decimal"
                        placeholder={String(folio.balanceDue)}
                        disabled={busy}
                      />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-2)" }}>
                    <CocoaButton
                      variant="filled"
                      tone="accent"
                      disabled={busy || !folioId || !folioOpen}
                      onClick={() =>
                        void runAction("Pago registrado", () =>
                          postFolioPayment(folioId!, {
                            amount: Number(payAmount) || folio.balanceDue,
                            method: payMethod,
                            currency: folio.folio.currency
                          })
                        )
                      }
                    >
                      Cobrar
                    </CocoaButton>
                  </div>
                </>
              ) : (
                <LoadingBlock label="Cargando folio…" />
              )}
            </CocoaCard>
          ) : null}

          {activeTab === "guests" ? (
            <CocoaCard variant="bordered" padding="md">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "var(--cocoa-space-2)"
                }}
              >
                <h3 style={{ margin: 0, fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>Huéspedes</h3>
                <span className="bo-chip">{(reservation.adults ?? 0) + (reservation.children ?? 0)} viajeros</span>
              </div>
              <dl className="bo-definition-grid">
                <div><dt>Titular</dt><dd>{guestLabel(reservation)}</dd></div>
                <div><dt>Adultos</dt><dd>{reservation.adults}</dd></div>
                <div><dt>Niños</dt><dd>{reservation.children}</dd></div>
                <div><dt>Booker</dt><dd>{reservation.bookerName ?? "Sin definir"}</dd></div>
                <div><dt>Email booker</dt><dd>{reservation.bookerEmail ?? "Sin definir"}</dd></div>
                <div><dt>Habitación</dt><dd>{rooms.find((r) => r.id === reservation.assignedRoomId)?.number ?? "Sin asignar"}</dd></div>
              </dl>
              <p style={{ marginTop: "var(--cocoa-space-2)", color: "var(--cocoa-label-secondary)" }}>
                La edición inline de acompañantes y parte de viajeros completo llegará con la API
                <code> ReservationGuest </code> en v2.1.
              </p>
              <div style={{ display: "flex", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-2)" }}>
                {reservation.primaryGuestId ? (
                  <CocoaButton
                    variant="bordered"
                    tone="neutral"
                    onClick={() => {
                      window.history.pushState(null, "", `/backoffice/guests/${reservation.primaryGuestId}`);
                      window.dispatchEvent(new PopStateEvent("popstate"));
                    }}
                  >
                    Abrir ficha del huésped
                  </CocoaButton>
                ) : null}
              </div>
            </CocoaCard>
          ) : null}

          {activeTab === "activity" ? (
            <CocoaCard variant="bordered" padding="md">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "var(--cocoa-space-2)"
                }}
              >
                <h3 style={{ margin: 0, fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>Actividad</h3>
                <span className="bo-chip">
                  {activity ? `${activity.items.length} eventos` : "Auditoría"}
                </span>
              </div>
              <p style={{ color: "var(--cocoa-label-secondary)" }}>
                Registro cronológico de cambios sobre la reserva: creación, modificaciones, check-in/out,
                cobros y cancelaciones. Se nutre del endpoint <code>GET /reservations/:id/activity</code>.
              </p>

              {activityLoading ? (
                <LoadingBlock label="Cargando actividad…" />
              ) : activityError ? (
                <ErrorState
                  message={activityError}
                  onRetry={() => {
                    setActivityLoading(true);
                    setActivityError(null);
                    fetchGuestActivity(reservationId)
                      .then((data) => setActivity(data))
                      .catch(() => setActivityError("No se pudo cargar la actividad. Inténtalo de nuevo."))
                      .finally(() => setActivityLoading(false));
                  }}
                />
              ) : !activity || activity.items.length === 0 ? (
                <EmptyState
                  title="Sin actividad registrada"
                  message="Aún no hay eventos sobre esta reserva. Verás aquí la línea de tiempo en cuanto se produzca el primer cambio."
                />
              ) : (
                <table className="bo-table">
                  <thead>
                    <tr>
                      <th>Cuándo</th>
                      <th>Quién</th>
                      <th>Acción</th>
                      <th>Cambios</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...activity.items]
                      .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
                      .map((item) => {
                        const actor = item.channel ?? item.department ?? "system";
                        const kindLabel = ACTIVITY_KIND_LABEL[item.kind] ?? item.kind;
                        const details = [item.detail, item.status, item.priority]
                          .filter((v) => v && String(v).trim().length > 0)
                          .join(" · ");
                        return (
                          <tr key={item.id}>
                            <td>{fmtActivityWhen(item.at)}</td>
                            <td>{actor}</td>
                            <td>
                              <span className="bo-chip" style={{ marginRight: "var(--cocoa-space-2)" }}>{kindLabel}</span>
                              {item.title}
                            </td>
                            <td style={{ color: "var(--cocoa-label-secondary)" }}>{details || "—"}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              )}
              <p style={{ marginTop: "var(--cocoa-space-2)", color: "var(--cocoa-label-secondary)" }}>
                La paginación completa y el filtro por categoría llegarán con el endpoint persistente de
                <code> ReservationActivityLog </code> en v2.1.
              </p>
            </CocoaCard>
          ) : null}

          {activeTab === "documents" ? (
            <CocoaCard variant="bordered" padding="md">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "var(--cocoa-space-2)"
                }}
              >
                <h3 style={{ margin: 0, fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>Documentos</h3>
                <span className="bo-chip">Q3</span>
              </div>
              <EmptyState
                title="Gestor documental — disponible en Q3"
                message="Aquí podrás adjuntar y consultar parte de viajeros, facturas proforma, contratos de grupo y otros documentos vinculados a la reserva. Integración prevista con el DMS del grupo."
              />
            </CocoaCard>
          ) : null}

          {message ? (
            <p style={{ marginTop: "var(--cocoa-space-3)", color: "var(--cocoa-label-secondary)" }}>{message}</p>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-2)" }}>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ReservationWorkspace" }))}
            >
              ← Volver a reservas
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "BillingCenter" }))}
            >
              Centro de facturación
            </CocoaButton>
          </div>
        </>
      ) : (
        <div style={{ padding: "var(--cocoa-space-6)", textAlign: "center" }}>
          <p style={{ color: "var(--cocoa-label-secondary)" }}>No se encontró ninguna reserva con ese identificador.</p>
          <div style={{ display: "flex", justifyContent: "center", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-3)" }}>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ReservationWorkspace" }))}
            >
              ← Volver a reservas
            </CocoaButton>
          </div>
        </div>
      )}
    </section>
  );
}
