import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type CrmDashboardData = {
  kpis: {
    totalGuests: number;
    activeProfiles: number;
    vipCount: number;
    avgLifetimeValueEur: number;
    churnRate90dPct: number;
  };
  topSegments: Array<{ segmentName: string; memberCount: number; revenue90dEur: number }>;
  activeCampaigns: Array<{ id: string; name: string; status: string; recipients: number; ctrPct?: number }>;
  upcomingBirthdays: Array<{ id: string; fullName: string; dateOfBirth: string; daysAway: number }>;
  recentGuests: Array<{ id: string; fullName: string; lastStayAt?: string; totalStays: number; totalRevenue?: number }>;
};

const EMPTY: CrmDashboardData = {
  kpis: {
    totalGuests: 0,
    activeProfiles: 0,
    vipCount: 0,
    avgLifetimeValueEur: 0,
    churnRate90dPct: 0
  },
  topSegments: [],
  activeCampaigns: [],
  upcomingBirthdays: [],
  recentGuests: []
};

const eurFormat = new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR" });
const numFormat = new Intl.NumberFormat("es-ES", { useGrouping: true });

const ACTIVE_CAMPAIGN_STATUSES = new Set(["active", "running", "scheduled", "live"]);

function formatEur(value: number): string {
  return eurFormat.format(value);
}

function formatNumber(value: number): string {
  return numFormat.format(value);
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-ES");
  } catch {
    return iso;
  }
}

function formatBirthday(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
  } catch {
    return iso;
  }
}

function campaignStatusPill(status: string) {
  const key = status.toLowerCase();
  if (ACTIVE_CAMPAIGN_STATUSES.has(key)) return <span className="cm-pill cm-pill-ok">{status}</span>;
  if (key === "paused") return <span className="cm-pill cm-pill-warn">{status}</span>;
  return <span className="cm-pill cm-pill-warn">{status}</span>;
}

export function CrmDashboard() {
  const state = useApiData<CrmDashboardData>(
    `/dashboards/crm?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 120000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, topSegments, activeCampaigns, upcomingBirthdays, recentGuests } = data;

  const maxSegmentCount = topSegments.reduce((max, row) => Math.max(max, row.memberCount), 0);

  const totalStatus = kpis.totalGuests > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const profilesStatus = kpis.activeProfiles > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const vipStatus = kpis.vipCount > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const ltvStatus = kpis.avgLifetimeValueEur > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const churnStatus =
    kpis.churnRate90dPct < 20 ? "rev-kpi-ok" : kpis.churnRate90dPct < 40 ? "rev-kpi-warn" : "rev-kpi-error";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Commercial · CRM</div>
          <h1 className="bo-page-title">CRM y campañas</h1>
          <p className="bo-page-subtitle">
            Vista de solo lectura del CRM: base de contactos, perfiles activos, VIPs, valor medio
            por cliente y tasa de churn a 90 días. Incluye segmentos principales, campañas activas,
            próximos cumpleaños y huéspedes recientes. Refresco automático cada dos minutos.
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
        <article className={`rev-kpi ${totalStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total guests</span></div>
          <div className="rev-kpi-value">{formatNumber(kpis.totalGuests)}</div>
          <div className="rev-kpi-delta">contacts in the CRM base</div>
        </article>
        <article className={`rev-kpi ${profilesStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Active profiles</span></div>
          <div className="rev-kpi-value">{formatNumber(kpis.activeProfiles)}</div>
          <div className="rev-kpi-delta">deduplicated guest profiles</div>
        </article>
        <article className={`rev-kpi ${vipStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">VIPs</span></div>
          <div className="rev-kpi-value">{formatNumber(kpis.vipCount)}</div>
          <div className="rev-kpi-delta">profiles with VIP level set</div>
        </article>
        <article className={`rev-kpi ${ltvStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Avg. lifetime value</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.avgLifetimeValueEur)}</div>
          <div className="rev-kpi-delta">across active profiles</div>
        </article>
        <article className={`rev-kpi ${churnStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Churn 90d</span></div>
          <div className="rev-kpi-value">{kpis.churnRate90dPct}%</div>
          <div className="rev-kpi-delta">guests with last stay {">"} 90 days ago</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Top segments</h3>
            <span className="bo-chip">{topSegments.length} segments</span>
          </div>
          {topSegments.length === 0 ? (
            <p className="bo-muted">No CRM segments configured yet.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Segment</th>
                  <th style={{ textAlign: "right" }}>Members</th>
                  <th>Reach</th>
                  <th style={{ textAlign: "right" }}>Revenue 90d</th>
                </tr>
              </thead>
              <tbody>
                {topSegments.map((row) => {
                  const widthPct = maxSegmentCount > 0 ? Math.round((row.memberCount / maxSegmentCount) * 100) : 0;
                  return (
                    <tr key={row.segmentName}>
                      <td><strong>{row.segmentName}</strong></td>
                      <td style={{ textAlign: "right" }}>{formatNumber(row.memberCount)}</td>
                      <td style={{ minWidth: 120 }}>
                        <div
                          style={{
                            background: "var(--brand-soft, #d8e3ff)",
                            height: 8,
                            borderRadius: 4,
                            width: `${widthPct}%`,
                            minWidth: row.memberCount > 0 ? 4 : 0
                          }}
                          aria-label={`${row.memberCount} members`}
                        />
                      </td>
                      <td style={{ textAlign: "right" }}>{formatEur(row.revenue90dEur)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Active campaigns</h3>
            <span className="bo-chip">{activeCampaigns.length} campaigns</span>
          </div>
          {activeCampaigns.length === 0 ? (
            <p className="bo-muted">No active CRM campaigns.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Campaign</th>
                  <th style={{ textAlign: "right" }}>Recipients</th>
                  <th style={{ textAlign: "right" }}>CTR</th>
                </tr>
              </thead>
              <tbody>
                {activeCampaigns.map((c) => (
                  <tr key={c.id}>
                    <td>{campaignStatusPill(c.status)}</td>
                    <td><strong>{c.name}</strong></td>
                    <td style={{ textAlign: "right" }}>{formatNumber(c.recipients)}</td>
                    <td style={{ textAlign: "right" }}>{c.ctrPct !== undefined ? `${c.ctrPct}%` : "—"}</td>
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
            <h3>Upcoming birthdays</h3>
            <span className="bo-chip">next 30 days · {upcomingBirthdays.length}</span>
          </div>
          {upcomingBirthdays.length === 0 ? (
            <p className="bo-muted">No birthdays in the next 30 days.</p>
          ) : (
            <ul className="bo-list">
              {upcomingBirthdays.map((g) => (
                <li key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingBottom: 6 }}>
                  <span className="bo-pill">{g.daysAway === 0 ? "today" : `in ${g.daysAway}d`}</span>
                  <strong>{g.fullName || "Unknown guest"}</strong>
                  <small className="bo-muted">{formatBirthday(g.dateOfBirth)}</small>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Recent guests</h3>
            <span className="bo-chip">{recentGuests.length}</span>
          </div>
          {recentGuests.length === 0 ? (
            <p className="bo-muted">No recent guests at this property.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Last stay</th>
                  <th style={{ textAlign: "right" }}>Stays</th>
                  <th style={{ textAlign: "right" }}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {recentGuests.map((g) => (
                  <tr key={g.id}>
                    <td><strong>{g.fullName || "Unknown guest"}</strong></td>
                    <td>{formatDate(g.lastStayAt)}</td>
                    <td style={{ textAlign: "right" }}>{formatNumber(g.totalStays)}</td>
                    <td style={{ textAlign: "right" }}>{g.totalRevenue !== undefined ? formatEur(g.totalRevenue) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>
    </>
  );
}
