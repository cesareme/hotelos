import { getActiveOrganizationId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";

const ORGANIZATION_ID = getActiveOrganizationId();

type PortfolioHealth = "ok" | "warn" | "error";
type PortfolioPropertyStatus = "open" | "closed" | "maintenance";

type PortfolioTotals = {
  propertiesCount: number;
  activePropertiesCount: number;
  roomsCount: number;
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  pendingFiscalSubmissions: number;
  pendingBalanceEur: number;
  unattended: { reservations: number; messages: number; tasks: number };
};

type PortfolioPropertyRow = {
  propertyId: string;
  name: string;
  city?: string;
  region?: string;
  status: PortfolioPropertyStatus;
  roomsCount: number;
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  pendingFiscalSubmissions: number;
  pendingBalanceEur: number;
  health: PortfolioHealth;
};

type PortfolioAlert = {
  propertyId: string;
  severity: "critical" | "warning";
  title: string;
  description: string;
};

type PortfolioDashboardData = {
  organizationId: string;
  asOf: string;
  totals: PortfolioTotals;
  perProperty: PortfolioPropertyRow[];
  alerts: PortfolioAlert[];
};

type SortKey =
  | "name"
  | "status"
  | "roomsCount"
  | "occupancyPct"
  | "adrEur"
  | "revparEur"
  | "revenueMtdEur"
  | "pendingFiscalSubmissions"
  | "pendingBalanceEur"
  | "health";

type SortDirection = "asc" | "desc";

const HEALTH_LABEL: Record<PortfolioHealth, string> = {
  ok: "healthy",
  warn: "attention",
  error: "critical"
};

const STATUS_LABEL: Record<PortfolioPropertyStatus, string> = {
  open: "open",
  closed: "closed",
  maintenance: "maintenance"
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

function healthPill(health: PortfolioHealth) {
  const kind = health === "ok" ? "ok" : health === "warn" ? "warn" : "error";
  return <span className={`bo-status ${kind}`}>{HEALTH_LABEL[health]}</span>;
}

function statusPill(status: PortfolioPropertyStatus) {
  const kind = status === "open" ? "ok" : status === "maintenance" ? "warn" : "info";
  return <span className={`bo-status ${kind}`}>{STATUS_LABEL[status]}</span>;
}

function navigateToProperty(propertyId: string) {
  if (typeof window === "undefined") return;
  // Persist the chosen property scope so the PropertyDetailScreen drill-down
  // (and other downstream dashboards) can read it from this storage key.
  try {
    window.localStorage?.setItem("hotelos-active-property", propertyId);
  } catch {
    // Best-effort only.
  }
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "PropertyDetailScreen" }));
}

function compareRows(a: PortfolioPropertyRow, b: PortfolioPropertyRow, key: SortKey, dir: SortDirection): number {
  const va: number | string = (() => {
    switch (key) {
      case "name":
        return a.name.toLowerCase();
      case "status":
        return a.status;
      case "health":
        return a.health;
      default:
        return a[key] as number;
    }
  })();
  const vb: number | string = (() => {
    switch (key) {
      case "name":
        return b.name.toLowerCase();
      case "status":
        return b.status;
      case "health":
        return b.health;
      default:
        return b[key] as number;
    }
  })();
  let cmp = 0;
  if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
  else cmp = String(va).localeCompare(String(vb));
  return dir === "asc" ? cmp : -cmp;
}

function SortableHeader(props: {
  label: string;
  field: SortKey;
  sort: { key: SortKey; dir: SortDirection };
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = props.sort.key === props.field;
  const indicator = active ? (props.sort.dir === "asc" ? " ↑" : " ↓") : "";
  return (
    <th
      style={{ textAlign: props.align ?? "left", cursor: "pointer", userSelect: "none" }}
      onClick={() => props.onSort(props.field)}
    >
      {props.label}
      <span style={{ color: active ? "var(--ink)" : "var(--ink-muted)" }}>{indicator || "  "}</span>
    </th>
  );
}

const EMPTY_TOTALS: PortfolioTotals = {
  propertiesCount: 0,
  activePropertiesCount: 0,
  roomsCount: 0,
  arrivalsToday: 0,
  departuresToday: 0,
  inHouseNow: 0,
  occupancyPct: 0,
  adrEur: 0,
  revparEur: 0,
  revenueMtdEur: 0,
  pendingFiscalSubmissions: 0,
  pendingBalanceEur: 0,
  unattended: { reservations: 0, messages: 0, tasks: 0 }
};

export function PortfolioDashboard() {
  const { data, loading, error, refresh } = useApiData<PortfolioDashboardData>(
    `/dashboards/portfolio?organizationId=${ORGANIZATION_ID}`,
    { pollIntervalMs: 60000 }
  );

  const totals = data?.totals ?? EMPTY_TOTALS;
  const properties = data?.perProperty ?? [];
  const alerts = data?.alerts ?? [];

  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({ key: "revenueMtdEur", dir: "desc" });

  function onSort(key: SortKey) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      // Default direction: text fields ascending, numeric descending.
      const dir: SortDirection = key === "name" || key === "status" || key === "health" ? "asc" : "desc";
      return { key, dir };
    });
  }

  const sortedProperties = useMemo(() => {
    const copy = properties.slice();
    copy.sort((a, b) => compareRows(a, b, sort.key, sort.dir));
    return copy;
  }, [properties, sort]);

  const noProperties = properties.length === 0 && !loading;
  const singleProperty = properties.length === 1;

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Grupo · Resumen de cartera
          </p>
          <h2 style={{ color: "var(--ink)" }}>Panel de cartera</h2>
          <p className="bo-muted" style={{ marginTop: 4 }}>
            Vista consolidada del grupo hotelero. KPIs agregados con media ponderada por habitaciones y drill-down por
            propiedad. Pensado para cadenas con 3–50+ hoteles.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {loading ? <span className="bo-status info">cargando</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          {singleProperty ? <span className="bo-chip">organización con una sola propiedad</span> : null}
          <button type="button" onClick={refresh}>Actualizar</button>
        </div>
      </header>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Propiedades</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.propertiesCount)}</div>
          <div className="rev-kpi-delta">total en la organización</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Activas</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.activePropertiesCount)}</div>
          <div className="rev-kpi-delta">operando ahora</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Habitaciones</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.roomsCount)}</div>
          <div className="rev-kpi-delta">en todas las propiedades</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Llegadas hoy</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.arrivalsToday)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Salidas hoy</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.departuresToday)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">En casa</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.inHouseNow)}</div>
          <div className="rev-kpi-delta">ocupadas actualmente</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ocupación cartera</span></div>
          <div className="rev-kpi-value">{fmtPct(totals.occupancyPct)}</div>
          <div className="rev-kpi-delta">ponderada por habitaciones</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">ADR cartera</span></div>
          <div className="rev-kpi-value">{fmtEur(totals.adrEur)}</div>
          <div className="rev-kpi-delta">ponderado por habitaciones</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">RevPAR cartera</span></div>
          <div className="rev-kpi-value">{fmtEur(totals.revparEur)}</div>
          <div className="rev-kpi-delta">ponderado por habitaciones</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ingresos del mes</span></div>
          <div className="rev-kpi-value">{fmtEur(totals.revenueMtdEur)}</div>
          <div className="rev-kpi-delta">suma de todas las propiedades</div>
        </article>
      </div>

      <div className="rev-kpi-grid">
        <article className={`rev-kpi ${totals.pendingFiscalSubmissions > 5 ? "rev-kpi-error" : totals.pendingFiscalSubmissions > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pending fiscal submissions</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.pendingFiscalSubmissions)}</div>
          <div className="rev-kpi-delta">VeriFactu · TBAI · IGIC · SES</div>
        </article>
        <article className={`rev-kpi ${totals.pendingBalanceEur > 5000 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pending balance (today)</span></div>
          <div className="rev-kpi-value">{fmtEur(totals.pendingBalanceEur)}</div>
          <div className="rev-kpi-delta">open AR across properties</div>
        </article>
        <article className={`rev-kpi ${totals.unattended.reservations > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Unattended reservations</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.unattended.reservations)}</div>
          <div className="rev-kpi-delta">draft / not confirmed</div>
        </article>
        <article className={`rev-kpi ${totals.unattended.messages > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Unattended messages</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.unattended.messages)}</div>
          <div className="rev-kpi-delta">open conversations</div>
        </article>
        <article className={`rev-kpi ${totals.unattended.tasks > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Unattended tasks</span></div>
          <div className="rev-kpi-value">{fmtNumber(totals.unattended.tasks)}</div>
          <div className="rev-kpi-delta">housekeeping pending</div>
        </article>
      </div>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Properties</h3>
          <span className="bo-chip">{fmtNumber(properties.length)} rows · click a row to drill in</span>
        </div>
        {noProperties ? (
          <p className="bo-muted">
            Esta organización no tiene propiedades configuradas todavía. Da de alta una propiedad para empezar a
            consolidar KPIs aquí.
          </p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <SortableHeader label="Property" field="name" sort={sort} onSort={onSort} />
                <SortableHeader label="Status" field="status" sort={sort} onSort={onSort} />
                <SortableHeader label="Rooms" field="roomsCount" sort={sort} onSort={onSort} align="right" />
                <SortableHeader label="Occ %" field="occupancyPct" sort={sort} onSort={onSort} align="right" />
                <SortableHeader label="ADR" field="adrEur" sort={sort} onSort={onSort} align="right" />
                <SortableHeader label="RevPAR" field="revparEur" sort={sort} onSort={onSort} align="right" />
                <SortableHeader label="Revenue MTD" field="revenueMtdEur" sort={sort} onSort={onSort} align="right" />
                <SortableHeader label="Pending fiscal" field="pendingFiscalSubmissions" sort={sort} onSort={onSort} align="right" />
                <SortableHeader label="AR €" field="pendingBalanceEur" sort={sort} onSort={onSort} align="right" />
                <SortableHeader label="Health" field="health" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sortedProperties.map((row) => (
                <tr
                  key={row.propertyId}
                  style={{ cursor: "pointer" }}
                  onClick={() => navigateToProperty(row.propertyId)}
                  title="Open property dashboard"
                >
                  <td>
                    <strong>{row.name}</strong>
                    {row.city || row.region ? (
                      <div className="bo-muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {[row.city, row.region].filter(Boolean).join(" · ")}
                      </div>
                    ) : null}
                  </td>
                  <td>{statusPill(row.status)}</td>
                  <td style={{ textAlign: "right" }}>{fmtNumber(row.roomsCount)}</td>
                  <td style={{ textAlign: "right" }}>{fmtPct(row.occupancyPct)}</td>
                  <td style={{ textAlign: "right" }}>{fmtEur(row.adrEur)}</td>
                  <td style={{ textAlign: "right" }}>{fmtEur(row.revparEur)}</td>
                  <td style={{ textAlign: "right" }}>
                    <strong>{fmtEur(row.revenueMtdEur)}</strong>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {row.pendingFiscalSubmissions > 0 ? (
                      <span className={`bo-status ${row.pendingFiscalSubmissions > 5 ? "error" : "warn"}`}>
                        {fmtNumber(row.pendingFiscalSubmissions)}
                      </span>
                    ) : (
                      <span className="bo-muted">0</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{fmtEur(row.pendingBalanceEur)}</td>
                  <td>{healthPill(row.health)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Critical alerts</h3>
          <span className="bo-chip">{fmtNumber(alerts.length)} active</span>
        </div>
        {alerts.length === 0 ? (
          <EmptyState
            title="No hay alertas críticas"
            message="Todo el portfolio opera dentro de umbrales. Si alguna propiedad cruza un límite verás aquí la alerta con severidad y enlace directo."
          />
        ) : (
          <ol style={{ display: "flex", flexDirection: "column", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
            {alerts.map((alert, idx) => (
              <li
                key={`${alert.propertyId}-${idx}`}
                className="bo-card"
                style={{
                  background: "var(--surface-elevated)",
                  borderLeft: `4px solid ${alert.severity === "critical" ? "var(--danger-ink)" : "var(--warn-ink)"}`,
                  cursor: "pointer"
                }}
                onClick={() => navigateToProperty(alert.propertyId)}
              >
                <div className="bo-card-head">
                  <h4 style={{ color: "var(--ink)", margin: 0 }}>{alert.title}</h4>
                  <span className={`bo-status ${alert.severity === "critical" ? "error" : "warn"}`}>
                    {alert.severity}
                  </span>
                </div>
                <p className="bo-muted" style={{ marginTop: 6 }}>{alert.description}</p>
              </li>
            ))}
          </ol>
        )}
      </article>
    </section>
  );
}
