import { useTabHost } from "../tabs/TabHost";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";
import { dateTime, money, number, percent } from "../../lib/format";

type LoyaltyDashboardData = {
  kpis: {
    activeMembers: number;
    totalPointsInCirculation: number;
    redemptions30dCount: number;
    redemptions30dPointsBurned: number;
    staysWithMemberPct: number;
  };
  membersByTier: Array<{ tier: string; count: number; pointsBalance: number }>;
  topMembers: Array<{
    id: string;
    fullName: string;
    tier: string;
    points: number;
    lifetimeSpendEur?: number;
  }>;
  recentEnrollments: Array<{
    id: string;
    fullName: string;
    programName: string;
    enrolledAt: string;
  }>;
};

const EMPTY: LoyaltyDashboardData = {
  kpis: {
    activeMembers: 0,
    totalPointsInCirculation: 0,
    redemptions30dCount: 0,
    redemptions30dPointsBurned: 0,
    staysWithMemberPct: 0
  },
  membersByTier: [],
  topMembers: [],
  recentEnrollments: []
};

function formatDate(iso: string): string {
  return dateTime(iso);
}

function formatInt(n: number): string {
  return number(n, { maximumFractionDigits: 0 });
}

function formatEur(n: number): string {
  return money(n, { decimals: 0 });
}

function tierPillClass(tier: string): string {
  const key = tier.toLowerCase();
  if (key.includes("platinum") || key.includes("diamond")) return "cm-pill cm-pill-ok";
  if (key.includes("gold") || key === "oro") return "cm-pill cm-pill-warn";
  if (key.includes("silver") || key === "plata") return "cm-pill";
  return "cm-pill";
}

export function LoyaltyDashboard() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const embedded = useTabHost() !== null;
  const { data, loading, error, refresh } = useApiData<LoyaltyDashboardData>(
    "/dashboards/loyalty",
    { pollIntervalMs: 300000 }
  );

  const view = data ?? EMPTY;
  const { kpis, membersByTier, topMembers, recentEnrollments } = view;
  const totalTierMembers = membersByTier.reduce((total, row) => total + row.count, 0);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          {embedded ? null : (
            <>
              <div className="bo-page-eyebrow">Comercial · Clientes y fidelización</div>
              <h1 className="bo-page-title">Fidelización</h1>
            </>
          )}
          <p className="bo-page-subtitle">
            Vista de solo lectura del programa de fidelización: miembros activos, distribución por niveles,
            puntos en circulación y altas recientes. Actualización automática cada 5 minutos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => refresh()}>↻ Actualizar</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Error al cargar la fidelización</h3>
            <span className="cm-pill cm-pill-error">error</span>
          </div>
          <p>{error}</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${kpis.activeMembers > 0 ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Miembros activos</span></div>
          <div className="rev-kpi-value">{formatInt(kpis.activeMembers)}</div>
          <div className="rev-kpi-delta">miembros con status activo</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Puntos en circulación</span></div>
          <div className="rev-kpi-value">{formatInt(kpis.totalPointsInCirculation)}</div>
          <div className="rev-kpi-delta">saldo total acumulado</div>
        </article>
        <article className={`rev-kpi ${kpis.redemptions30dCount > 0 ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Redemptions · 30d</span></div>
          <div className="rev-kpi-value">{formatInt(kpis.redemptions30dCount)}</div>
          <div className="rev-kpi-delta">{formatInt(kpis.redemptions30dPointsBurned)} puntos canjeados</div>
        </article>
        <article className={`rev-kpi ${kpis.staysWithMemberPct >= 25 ? "rev-kpi-ok" : kpis.staysWithMemberPct >= 10 ? "rev-kpi-warn" : "rev-kpi-error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Estancias de miembros</span></div>
          <div className="rev-kpi-value">{percent(kpis.staysWithMemberPct, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</div>
          <div className="rev-kpi-delta">reservas con huésped fidelizado</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Distribución por nivel</p>
              <h3>Miembros por nivel</h3>
            </div>
            <span className="bo-chip">{totalTierMembers} miembros activos</span>
          </div>
          {membersByTier.length === 0 ? (
            <p className="bo-muted">Sin miembros activos en el programa.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Nivel</th>
                  <th style={{ textAlign: "right" }}>Miembros</th>
                  <th style={{ textAlign: "right" }}>% del total</th>
                  <th style={{ textAlign: "right" }}>Puntos</th>
                </tr>
              </thead>
              <tbody>
                {membersByTier.map((row) => {
                  const pct = totalTierMembers > 0 ? Math.round((row.count / totalTierMembers) * 100) : 0;
                  return (
                    <tr key={row.tier}>
                      <td><span className={tierPillClass(row.tier)}>{row.tier}</span></td>
                      <td style={{ textAlign: "right" }}>{formatInt(row.count)}</td>
                      <td style={{ textAlign: "right" }}>{pct}%</td>
                      <td style={{ textAlign: "right" }}>{formatInt(row.pointsBalance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Mayor saldo de puntos</p>
              <h3>Principales miembros</h3>
            </div>
            <span className="bo-chip">{topMembers.length} · top 10</span>
          </div>
          {topMembers.length === 0 ? (
            <EmptyState
              title="No hay miembros activos para listar"
              message="Cuando los huéspedes acumulen puntos en el programa, los principales saldos aparecerán aquí."
            />
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Miembro</th>
                  <th>Nivel</th>
                  <th style={{ textAlign: "right" }}>Puntos</th>
                  <th style={{ textAlign: "right" }}>Gasto acumulado</th>
                </tr>
              </thead>
              <tbody>
                {topMembers.map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.fullName}</strong></td>
                    <td><span className={tierPillClass(m.tier)}>{m.tier}</span></td>
                    <td style={{ textAlign: "right" }}>{formatInt(m.points)}</td>
                    <td style={{ textAlign: "right" }}>
                      {m.lifetimeSpendEur !== undefined ? formatEur(m.lifetimeSpendEur) : <span className="bo-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Últimas altas</p>
            <h3>Altas recientes</h3>
          </div>
          <span className="bo-chip">{recentEnrollments.length} · {loading ? "cargando…" : "actualizado"}</span>
        </div>
        {recentEnrollments.length === 0 ? (
          <EmptyState
            title="No hay altas recientes en el programa"
            message="Las nuevas inscripciones al programa de fidelidad aparecerán aquí en cuanto los huéspedes se den de alta."
          />
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Huésped</th>
                <th>Programa</th>
                <th>Alta</th>
              </tr>
            </thead>
            <tbody>
              {recentEnrollments.map((e) => (
                <tr key={e.id}>
                  <td><strong>{e.fullName}</strong></td>
                  <td>{e.programName}</td>
                  <td>{formatDate(e.enrolledAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
