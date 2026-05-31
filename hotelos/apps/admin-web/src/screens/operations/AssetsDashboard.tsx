import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type AssetsDashboardData = {
  kpis: {
    totalAssets: number;
    totalNetBookValueEur: number;
    depreciationMtdEur: number;
    openCapexProjects: number;
    nextWarrantyExpiries: number;
  };
  assetsByCategory: Array<{ category: string; count: number; netBookValueEur: number }>;
  topAssets: Array<{
    id: string;
    name: string;
    category?: string;
    acquisitionValueEur: number;
    netBookValueEur: number;
    acquisitionDate?: string;
  }>;
  capexProjects: Array<{
    id: string;
    name: string;
    status: string;
    budgetEur?: number;
    spentEur?: number;
    progressPct?: number;
  }>;
  upcomingWarrantyExpirations: Array<{ id: string; assetName: string; warrantyEndsAt: string }>;
};

const EMPTY: AssetsDashboardData = {
  kpis: {
    totalAssets: 0,
    totalNetBookValueEur: 0,
    depreciationMtdEur: 0,
    openCapexProjects: 0,
    nextWarrantyExpiries: 0
  },
  assetsByCategory: [],
  topAssets: [],
  capexProjects: [],
  upcomingWarrantyExpirations: []
};

const currencyFormatter = new Intl.NumberFormat("es-ES", { useGrouping: true,
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2
});

const compactCurrencyFormatter = new Intl.NumberFormat("es-ES", { useGrouping: true,
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1
});

function money(value: number | null | undefined): string {
  return currencyFormatter.format(Number.isFinite(value as number) ? (value as number) : 0);
}

function moneyCompact(value: number | null | undefined): string {
  return compactCurrencyFormatter.format(Number.isFinite(value as number) ? (value as number) : 0);
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(d);
}

const CLOSED_STATUSES = new Set(["completed", "closed", "done"]);

function capexStatusPill(status: string) {
  if (CLOSED_STATUSES.has(status)) return <span className="cm-pill cm-pill-ok">{status}</span>;
  if (status === "cancelled") return <span className="cm-pill cm-pill-error">{status}</span>;
  if (status === "in_progress" || status === "approved") return <span className="cm-pill cm-pill-warn">{status}</span>;
  return <span className="cm-pill cm-pill-warn">{status}</span>;
}

function daysUntil(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function warrantyChip(iso: string) {
  const d = daysUntil(iso);
  if (d === null) return null;
  if (d <= 30) return <span className="cm-pill cm-pill-error">{d}d</span>;
  if (d <= 60) return <span className="cm-pill cm-pill-warn">{d}d</span>;
  return <span className="cm-pill cm-pill-ok">{d}d</span>;
}

export function AssetsDashboard() {
  const state = useApiData<AssetsDashboardData>(
    `/dashboards/assets?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 300000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, assetsByCategory, topAssets, capexProjects, upcomingWarrantyExpirations } = data;

  const warrantyStatus =
    kpis.nextWarrantyExpiries > 0 ? "rev-kpi-warn" : "rev-kpi-ok";
  const capexStatus = kpis.openCapexProjects > 0 ? "rev-kpi-warn" : "rev-kpi-ok";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Assets</div>
          <h1 className="bo-page-title">Registro de activos</h1>
          <p className="bo-page-subtitle">
            Vista solo lectura del registro de activos físicos y proyectos de capex.
            Resumen de valor neto contable, depreciación mes a fecha (estimada),
            proyectos abiertos y garantías próximas a vencer. Datos consolidados
            cada 5 minutos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => state.refresh()}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {state.error ? (
        <section className="bo-card">
          <p style={{ color: "var(--danger-ink)" }}>Couldn't load this view right now. Refresh to retry.</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total assets</span></div>
          <div className="rev-kpi-value">{kpis.totalAssets}</div>
          <div className="rev-kpi-delta">in register</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Net book value</span></div>
          <div className="rev-kpi-value">{moneyCompact(kpis.totalNetBookValueEur)}</div>
          <div className="rev-kpi-delta">{money(kpis.totalNetBookValueEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Depreciation MTD</span></div>
          <div className="rev-kpi-value">{moneyCompact(kpis.depreciationMtdEur)}</div>
          <div className="rev-kpi-delta">straight-line estimate</div>
        </article>
        <article className={`rev-kpi ${capexStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Open capex</span></div>
          <div className="rev-kpi-value">{kpis.openCapexProjects}</div>
          <div className="rev-kpi-delta">active projects</div>
        </article>
        <article className={`rev-kpi ${warrantyStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Warranties 30d</span></div>
          <div className="rev-kpi-value">{kpis.nextWarrantyExpiries}</div>
          <div className="rev-kpi-delta">expiring soon</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Assets by category</h3>
            <span className="bo-chip">{assetsByCategory.length} buckets</span>
          </div>
          {assetsByCategory.length === 0 ? (
            <p className="bo-muted">No assets registered.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th style={{ textAlign: "right" }}>Count</th>
                  <th style={{ textAlign: "right" }}>Net book value</th>
                </tr>
              </thead>
              <tbody>
                {assetsByCategory.map((row) => (
                  <tr key={row.category}>
                    <td><strong>{row.category}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                    <td style={{ textAlign: "right" }}>{money(row.netBookValueEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Top assets</h3>
            <span className="bo-chip">{topAssets.length}</span>
          </div>
          {topAssets.length === 0 ? (
            <p className="bo-muted">No assets to display.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Category</th>
                  <th style={{ textAlign: "right" }}>Acquisition</th>
                  <th style={{ textAlign: "right" }}>NBV</th>
                </tr>
              </thead>
              <tbody>
                {topAssets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <strong>{asset.name}</strong>
                      {asset.acquisitionDate ? (
                        <>
                          <br />
                          <small className="bo-muted">acquired {formatDate(asset.acquisitionDate)}</small>
                        </>
                      ) : null}
                    </td>
                    <td>{asset.category ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{money(asset.acquisitionValueEur)}</td>
                    <td style={{ textAlign: "right" }}>{money(asset.netBookValueEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Capex projects</h3>
            <span className="bo-chip">{capexProjects.length}</span>
          </div>
          {capexProjects.length === 0 ? (
            <p className="bo-muted">No capex projects registered.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Budget</th>
                  <th style={{ textAlign: "right" }}>Spent</th>
                  <th>Progress</th>
                </tr>
              </thead>
              <tbody>
                {capexProjects.map((project) => (
                  <tr key={project.id}>
                    <td><strong>{project.name}</strong></td>
                    <td>{capexStatusPill(project.status)}</td>
                    <td style={{ textAlign: "right" }}>
                      {project.budgetEur !== undefined ? money(project.budgetEur) : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {project.spentEur !== undefined ? money(project.spentEur) : "—"}
                    </td>
                    <td>
                      {project.progressPct !== undefined ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div
                            aria-label={`progress ${project.progressPct}%`}
                            style={{
                              flex: 1,
                              height: 6,
                              borderRadius: 3,
                              background: "var(--surface-2, #eee)",
                              overflow: "hidden",
                              minWidth: 60
                            }}
                          >
                            <div
                              style={{
                                width: `${project.progressPct}%`,
                                height: "100%",
                                background:
                                  project.progressPct >= 100
                                    ? "var(--danger-ink, #b42318)"
                                    : project.progressPct >= 80
                                      ? "var(--warn-ink, #b54708)"
                                      : "var(--accent-ink, #2f6feb)"
                              }}
                            />
                          </div>
                          <small className="bo-muted" style={{ minWidth: 40, textAlign: "right" }}>
                            {project.progressPct}%
                          </small>
                        </div>
                      ) : (
                        <small className="bo-muted">—</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Warranty expirations (next 90 days)</h3>
            <span className="bo-chip">{upcomingWarrantyExpirations.length}</span>
          </div>
          {upcomingWarrantyExpirations.length === 0 ? (
            <p className="bo-muted">No warranties expiring in the next 90 days.</p>
          ) : (
            <ul className="bo-list">
              {upcomingWarrantyExpirations.map((row) => (
                <li
                  key={row.id}
                  style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {warrantyChip(row.warrantyEndsAt)}
                    <strong>{row.assetName}</strong>
                  </div>
                  <small className="bo-muted">expires {formatDate(row.warrantyEndsAt)}</small>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </>
  );
}
