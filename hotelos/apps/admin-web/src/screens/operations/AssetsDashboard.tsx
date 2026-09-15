import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { date, money as formatMoney, percent } from "../../lib/format";

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

function money(value: number | null | undefined): string {
  return formatMoney(value);
}

function moneyCompact(value: number | null | undefined): string {
  return formatMoney(value, { compact: true });
}

function formatDate(value?: string): string {
  return date(value);
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
      <CocoaPageHeader
        eyebrow="Operaciones"
        title="Activos"
        subtitle="Registro de activos físicos y proyectos de inversión: valor neto contable, amortización del mes (estimada), proyectos abiertos y garantías próximas a vencer. Datos consolidados cada 5 minutos."
        actions={<button type="button" className="ghost" onClick={() => state.refresh()}>↻ {ACTIONS.refresh}</button>}
      />

      {state.error ? (
        <section className="bo-card">
          <p style={{ color: "var(--danger-ink)" }}>{UI_STATES.error.title}. {UI_STATES.error.message}</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Activos</span></div>
          <div className="rev-kpi-value">{kpis.totalAssets}</div>
          <div className="rev-kpi-delta">en el registro</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Valor neto contable</span></div>
          <div className="rev-kpi-value">{moneyCompact(kpis.totalNetBookValueEur)}</div>
          <div className="rev-kpi-delta">{money(kpis.totalNetBookValueEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Amortización del mes</span></div>
          <div className="rev-kpi-value">{moneyCompact(kpis.depreciationMtdEur)}</div>
          <div className="rev-kpi-delta">estimación lineal</div>
        </article>
        <article className={`rev-kpi ${capexStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Inversiones abiertas</span></div>
          <div className="rev-kpi-value">{kpis.openCapexProjects}</div>
          <div className="rev-kpi-delta">proyectos activos</div>
        </article>
        <article className={`rev-kpi ${warrantyStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Garantías · 30 días</span></div>
          <div className="rev-kpi-value">{kpis.nextWarrantyExpiries}</div>
          <div className="rev-kpi-delta">vencen pronto</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Activos por categoría</h3>
            <span className="bo-chip">{assetsByCategory.length} buckets</span>
          </div>
          {assetsByCategory.length === 0 ? (
            <p className="bo-muted">No hay activos registrados.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th style={{ textAlign: "right" }}>Cantidad</th>
                  <th style={{ textAlign: "right" }}>Valor neto contable</th>
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
            <h3>Activos de mayor valor</h3>
            <span className="bo-chip">{topAssets.length}</span>
          </div>
          {topAssets.length === 0 ? (
            <p className="bo-muted">No hay activos que mostrar.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Activo</th>
                  <th>Categoría</th>
                  <th style={{ textAlign: "right" }}>Adquisición</th>
                  <th style={{ textAlign: "right" }}>Valor neto</th>
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
            <h3>Proyectos de inversión</h3>
            <span className="bo-chip">{capexProjects.length}</span>
          </div>
          {capexProjects.length === 0 ? (
            <p className="bo-muted">No hay proyectos de inversión registrados.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Proyecto</th>
                  <th>Estado</th>
                  <th style={{ textAlign: "right" }}>Presupuesto</th>
                  <th style={{ textAlign: "right" }}>Gastado</th>
                  <th>Avance</th>
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
                            aria-label={`Avance ${percent(project.progressPct)}`}
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
            <h3>Garantías que vencen (próximos 90 días)</h3>
            <span className="bo-chip">{upcomingWarrantyExpirations.length}</span>
          </div>
          {upcomingWarrantyExpirations.length === 0 ? (
            <p className="bo-muted">Ninguna garantía vence en los próximos 90 días.</p>
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
                  <small className="bo-muted">vence el {formatDate(row.warrantyEndsAt)}</small>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </>
  );
}
