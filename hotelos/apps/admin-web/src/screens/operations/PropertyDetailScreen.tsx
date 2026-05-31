import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo } from "react";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";

const DEFAULT_PROPERTY_ID = getActivePropertyId();

type StatusKind = "ok" | "warn" | "error" | "info";

type PropertyOverview = {
  property: {
    id: string;
    name: string;
    legalName?: string;
    address?: string;
    city?: string;
    region?: string;
    country: string;
    status: string;
    timezone: string;
    roomsCount: number;
    sesHospedajesEnabled: boolean;
    verifactuEnabled: boolean;
  };
  today: {
    arrivals: number;
    departures: number;
    inHouse: number;
    unassignedRooms: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
  };
  finance: {
    revenueMtdEur: number;
    pendingBalanceEur: number;
    pendingFiscalSubmissions: number;
  };
  operations: {
    housekeepingOpen: number;
    maintenanceOpen: number;
    safetyIncidentsOpen: number;
  };
  guestExperience: {
    openConversations: number;
    avgReviewRating: number;
    pendingReviews: number;
  };
  recentReservations: Array<{
    id: string;
    code: string;
    guestName: string;
    arrivalDate: string;
    departureDate: string;
    status: string;
    balanceEur: number;
  }>;
};

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  checked_out: "Checked out",
  cancelled: "Cancelled",
  no_show: "No-show"
};

const RESERVATION_STATUS_KIND: Record<string, StatusKind> = {
  draft: "info",
  confirmed: "info",
  checked_in: "ok",
  checked_out: "ok",
  cancelled: "error",
  no_show: "error"
};

const PROPERTY_STATUS_KIND: Record<string, StatusKind> = {
  open: "ok",
  maintenance: "warn",
  closed: "info"
};

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(value);
}

function fmtEur(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,00 €";
  return new Intl.NumberFormat("es-ES", { useGrouping: true,
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,0 %";
  return `${new Intl.NumberFormat("es-ES", { useGrouping: true, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} %`;
}

function fmtRating(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  return `${new Intl.NumberFormat("es-ES", { useGrouping: true, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} ★`;
}

function pill(kind: StatusKind, label: string) {
  return <span className={`bo-status ${kind}`}>{label}</span>;
}

function reservationStatusPill(status: string) {
  const kind = RESERVATION_STATUS_KIND[status] ?? "info";
  const label = RESERVATION_STATUS_LABELS[status] ?? status;
  return pill(kind, label);
}

function propertyStatusPill(status: string) {
  const kind = PROPERTY_STATUS_KIND[status] ?? "info";
  return pill(kind, status);
}

function balancePill(value: number) {
  if (!Number.isFinite(value) || value === 0) return pill("ok", "settled");
  if (value > 0) return pill("warn", "due");
  return pill("info", "credit");
}

function navTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

function navToReservation(reservationId: string) {
  if (typeof window === "undefined") return;
  // ReservationDetailWorkspaceScreen reads its target id from the last path
  // segment, so push the path before dispatching the nav event.
  window.history.pushState(null, "", `/backoffice/reservations/${reservationId}`);
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ReservationDetailWorkspace" }));
}

function readActivePropertyId(): string {
  if (typeof window === "undefined") return DEFAULT_PROPERTY_ID;
  try {
    return window.localStorage?.getItem("hotelos-active-property") || DEFAULT_PROPERTY_ID;
  } catch {
    return DEFAULT_PROPERTY_ID;
  }
}

export function PropertyDetailScreen() {
  const propertyId = useMemo(() => readActivePropertyId(), []);

  const { data, loading, error, refresh } = useApiData<PropertyOverview>(
    "/dashboards/property-overview",
    { pollIntervalMs: 60000, query: { propertyId } }
  );

  const property = data?.property;
  const today = data?.today;
  const finance = data?.finance;
  const operations = data?.operations;
  const guestExperience = data?.guestExperience;
  const recentReservations = data?.recentReservations ?? [];

  const locationLine = [property?.city, property?.region, property?.country].filter(Boolean).join(" · ");

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <button type="button" onClick={() => navTo("PortfolioDashboard")}>← Back to portfolio</button>
      </div>

      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Group · Property
          </p>
          <h2 style={{ color: "var(--ink)", display: "flex", alignItems: "center", gap: 12 }}>
            {property?.name ?? "Property"}
            {property ? propertyStatusPill(property.status) : null}
          </h2>
          {property ? (
            <p className="bo-muted" style={{ marginTop: 4 }}>
              {property.legalName ? `${property.legalName} · ` : ""}
              {locationLine}
              {property.address ? ` · ${property.address}` : ""}
              {` · ${fmtNumber(property.roomsCount)} rooms · ${property.timezone}`}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {loading ? <span className="bo-status info">loading</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" onClick={refresh}>Refresh</button>
        </div>
      </header>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Arrivals today</span></div>
          <div className="rev-kpi-value">{fmtNumber(today?.arrivals)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Departures today</span></div>
          <div className="rev-kpi-value">{fmtNumber(today?.departures)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">In-house</span></div>
          <div className="rev-kpi-value">{fmtNumber(today?.inHouse)}</div>
          <div className="rev-kpi-delta">currently occupied</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Occupancy</span></div>
          <div className="rev-kpi-value">{fmtPct(today?.occupancyPct)}</div>
          <div className="rev-kpi-delta">month-to-date avg</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">ADR</span></div>
          <div className="rev-kpi-value">{fmtEur(today?.adrEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">RevPAR</span></div>
          <div className="rev-kpi-value">{fmtEur(today?.revparEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Revenue MTD</span></div>
          <div className="rev-kpi-value">{fmtEur(finance?.revenueMtdEur)}</div>
        </article>
        <article className={`rev-kpi ${(finance?.pendingBalanceEur ?? 0) > 5000 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pending balance</span></div>
          <div className="rev-kpi-value">{fmtEur(finance?.pendingBalanceEur)}</div>
          <div className="rev-kpi-delta">open AR today</div>
        </article>
      </div>

      <div className="bo-grid two">
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Operations</h3>
            <span className="bo-chip">backlog</span>
          </div>
          <ul style={{ display: "flex", flexDirection: "column", gap: 12, listStyle: "none", padding: 0, margin: 0 }}>
            <li style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>Housekeeping open <strong>{fmtNumber(operations?.housekeepingOpen)}</strong></span>
              <button type="button" onClick={() => navTo("HousekeepingDashboard")}>Abrir housekeeping</button>
            </li>
            <li style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>Maintenance open <strong>{fmtNumber(operations?.maintenanceOpen)}</strong></span>
              <button type="button" onClick={() => navTo("MaintenanceDashboard")}>Abrir mantenimiento</button>
            </li>
            <li style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>Safety incidents <strong>{fmtNumber(operations?.safetyIncidentsOpen)}</strong></span>
              <button type="button" onClick={() => navTo("SafetyDashboard")}>Abrir seguridad</button>
            </li>
          </ul>
        </article>

        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Guest experience</h3>
            <span className="bo-chip">satisfaction</span>
          </div>
          <ul style={{ display: "flex", flexDirection: "column", gap: 12, listStyle: "none", padding: 0, margin: 0 }}>
            <li style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>Open conversations <strong>{fmtNumber(guestExperience?.openConversations)}</strong></span>
              <button type="button" onClick={() => navTo("ConciergeInboxDashboard")}>Open inbox</button>
            </li>
            <li style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>Avg review rating <strong>{fmtRating(guestExperience?.avgReviewRating)}</strong></span>
              <button type="button" onClick={() => navTo("ReputationDashboard")}>Open reputation</button>
            </li>
            <li style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>Pending reviews <strong>{fmtNumber(guestExperience?.pendingReviews)}</strong></span>
              <button type="button" onClick={() => navTo("ReputationDashboard")}>Respond</button>
            </li>
          </ul>
        </article>

        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Compliance</h3>
            <span className="bo-chip">fiscal posture</span>
          </div>
          <ul style={{ display: "flex", flexDirection: "column", gap: 12, listStyle: "none", padding: 0, margin: 0 }}>
            <li style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>
                Pending fiscal submissions{" "}
                {(finance?.pendingFiscalSubmissions ?? 0) > 0 ? (
                  <span className={`bo-status ${(finance?.pendingFiscalSubmissions ?? 0) > 5 ? "error" : "warn"}`}>
                    {fmtNumber(finance?.pendingFiscalSubmissions)}
                  </span>
                ) : (
                  <strong>0</strong>
                )}
              </span>
              <button type="button" onClick={() => navTo("FiscalDashboard")}>Open fiscal</button>
            </li>
            <li style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>SES Hospedajes</span>
              {property?.sesHospedajesEnabled ? pill("ok", "enabled") : pill("info", "disabled")}
            </li>
            <li style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>VeriFactu</span>
              {property?.verifactuEnabled ? pill("ok", "enabled") : pill("info", "disabled")}
            </li>
          </ul>
        </article>
      </div>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Recent reservations</h3>
          <span className="bo-chip">{fmtNumber(recentReservations.length)} rows · click a row to open</span>
        </div>
        {recentReservations.length === 0 ? (
          <EmptyState
            title="No hay reservas recientes"
            message="Las últimas reservas de esta propiedad aparecerán aquí. Haz click en una fila para abrir el detalle."
          />
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Code</th>
                <th style={{ textAlign: "left" }}>Guest</th>
                <th style={{ textAlign: "left" }}>Arrival</th>
                <th style={{ textAlign: "left" }}>Departure</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "right" }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {recentReservations.map((row) => (
                <tr
                  key={row.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => navToReservation(row.id)}
                  title="Open reservation detail"
                >
                  <td><strong>{row.code}</strong></td>
                  <td>{row.guestName}</td>
                  <td>{row.arrivalDate}</td>
                  <td>{row.departureDate}</td>
                  <td>{reservationStatusPill(row.status)}</td>
                  <td style={{ textAlign: "right", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                    {fmtEur(row.balanceEur)} {balancePill(row.balanceEur)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
    </section>
  );
}
