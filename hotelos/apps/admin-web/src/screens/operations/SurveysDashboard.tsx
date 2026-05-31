import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";

type SurveysDashboardData = {
  kpis: {
    nps90d: number;
    responseRatePct: number;
    totalResponses90d: number;
    promoters: number;
    passives: number;
    detractors: number;
  };
  scoreDistribution: Array<{ score: number; count: number }>;
  recentResponses: Array<{
    id: string;
    surveyName: string;
    score?: number;
    sentiment?: string;
    comment?: string;
    submittedAt: string;
  }>;
  topThemes: Array<{ theme: string; count: number }>;
};

const EMPTY: SurveysDashboardData = {
  kpis: { nps90d: 0, responseRatePct: 0, totalResponses90d: 0, promoters: 0, passives: 0, detractors: 0 },
  scoreDistribution: Array.from({ length: 11 }, (_, score) => ({ score, count: 0 })),
  recentResponses: [],
  topThemes: []
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function npsKpiClass(nps: number): string {
  if (nps >= 50) return "rev-kpi rev-kpi-ok";
  if (nps >= 0) return "rev-kpi rev-kpi-warn";
  return "rev-kpi rev-kpi-error";
}

function scoreBarClass(score: number): string {
  if (score >= 9) return "cm-pill-ok";
  if (score >= 7) return "cm-pill";
  return "cm-pill-error";
}

function scorePillClass(score?: number): string {
  if (score === undefined || score === null) return "cm-pill";
  if (score >= 9) return "cm-pill cm-pill-ok";
  if (score >= 7) return "cm-pill";
  return "cm-pill cm-pill-error";
}

function sentimentPillClass(sentiment?: string): string {
  if (!sentiment) return "cm-pill";
  const normalized = sentiment.toLowerCase();
  if (normalized.includes("pos") || normalized.includes("happy") || normalized === "positive") return "cm-pill cm-pill-ok";
  if (normalized.includes("neg") || normalized.includes("angry") || normalized === "negative") return "cm-pill cm-pill-error";
  if (normalized.includes("mix") || normalized.includes("warn")) return "cm-pill cm-pill-warn";
  return "cm-pill";
}

export function SurveysDashboard() {
  const { data, loading, error, refresh } = useApiData<SurveysDashboardData>(
    "/dashboards/surveys",
    { pollIntervalMs: 300000 }
  );

  const view = data ?? EMPTY;
  const { kpis, scoreDistribution, recentResponses, topThemes } = view;

  const totalScored = kpis.promoters + kpis.passives + kpis.detractors;
  const promoterPct = totalScored > 0 ? Math.round((kpis.promoters / totalScored) * 100) : 0;
  const passivePct = totalScored > 0 ? Math.round((kpis.passives / totalScored) * 100) : 0;
  const detractorPct = totalScored > 0 ? Math.max(0, 100 - promoterPct - passivePct) : 0;

  const maxDistributionCount = scoreDistribution.reduce(
    (max: number, row: { score: number; count: number }) => (row.count > max ? row.count : max),
    0
  );

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Guest experience</div>
          <h1 className="bo-page-title">Surveys & NPS</h1>
          <p className="bo-page-subtitle">
            Métricas de las encuestas post-estancia: NPS de los últimos 90 días, tasa de respuesta,
            distribución de puntuaciones, comentarios recientes y temas más mencionados.
            Actualización automática cada 5 minutos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => refresh()}>↻ Refresh</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Error loading surveys data</h3>
            <span className="cm-pill cm-pill-error">error</span>
          </div>
          <p>{error}</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={npsKpiClass(kpis.nps90d)}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">NPS · 90d</span></div>
          <div className="rev-kpi-value">{kpis.nps90d.toFixed(1)}</div>
          <div className="rev-kpi-delta">Promotores - Detractores · % sobre respuestas con score</div>
        </article>
        <article className={`rev-kpi ${kpis.responseRatePct >= 25 ? "rev-kpi-ok" : kpis.responseRatePct >= 10 ? "rev-kpi-warn" : "rev-kpi-error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Response rate</span></div>
          <div className="rev-kpi-value">{kpis.responseRatePct.toFixed(1)}%</div>
          <div className="rev-kpi-delta">respuestas / salidas en ventana</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Respuestas · 90d</span></div>
          <div className="rev-kpi-value">{kpis.totalResponses90d}</div>
          <div className="rev-kpi-delta">total recibidas en el periodo</div>
        </article>
        <article className={`rev-kpi ${kpis.detractors > kpis.promoters ? "rev-kpi-error" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Detractores</span></div>
          <div className="rev-kpi-value">{kpis.detractors}</div>
          <div className="rev-kpi-delta">score ≤ 6 · requiere seguimiento</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Breakdown</p>
              <h3>Promotores / Pasivos / Detractores</h3>
            </div>
            <span className="bo-chip">{totalScored} con score</span>
          </div>
          <table className="cm-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>Categoría</th>
                <th>Distribución</th>
                <th style={{ width: 90, textAlign: "right" }}>Count</th>
                <th style={{ width: 70, textAlign: "right" }}>%</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Promotores</strong><br /><small className="bo-muted">9-10</small></td>
                <td>
                  <div style={{ background: "var(--bo-track, #eee)", borderRadius: 4, height: 10, width: "100%", overflow: "hidden" }}>
                    <div className="cm-pill-ok" style={{ width: `${promoterPct}%`, height: "100%", display: "block", borderRadius: 4 }} />
                  </div>
                </td>
                <td style={{ textAlign: "right" }}>{kpis.promoters}</td>
                <td style={{ textAlign: "right" }}>{promoterPct}%</td>
              </tr>
              <tr>
                <td><strong>Pasivos</strong><br /><small className="bo-muted">7-8</small></td>
                <td>
                  <div style={{ background: "var(--bo-track, #eee)", borderRadius: 4, height: 10, width: "100%", overflow: "hidden" }}>
                    <div className="cm-pill-warn" style={{ width: `${passivePct}%`, height: "100%", display: "block", borderRadius: 4 }} />
                  </div>
                </td>
                <td style={{ textAlign: "right" }}>{kpis.passives}</td>
                <td style={{ textAlign: "right" }}>{passivePct}%</td>
              </tr>
              <tr>
                <td><strong>Detractores</strong><br /><small className="bo-muted">0-6</small></td>
                <td>
                  <div style={{ background: "var(--bo-track, #eee)", borderRadius: 4, height: 10, width: "100%", overflow: "hidden" }}>
                    <div className="cm-pill-error" style={{ width: `${detractorPct}%`, height: "100%", display: "block", borderRadius: 4 }} />
                  </div>
                </td>
                <td style={{ textAlign: "right" }}>{kpis.detractors}</td>
                <td style={{ textAlign: "right" }}>{detractorPct}%</td>
              </tr>
            </tbody>
          </table>
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Distribución 0-10</p>
              <h3>Score distribution</h3>
            </div>
            <span className="bo-chip">{maxDistributionCount} pico</span>
          </div>
          <table className="cm-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>Score</th>
                <th>Volumen</th>
                <th style={{ width: 90, textAlign: "right" }}>Count</th>
              </tr>
            </thead>
            <tbody>
              {scoreDistribution.map((row) => {
                const widthPct = maxDistributionCount > 0 ? Math.round((row.count / maxDistributionCount) * 100) : 0;
                return (
                  <tr key={row.score}>
                    <td><strong>{row.score}</strong></td>
                    <td>
                      <div style={{ background: "var(--bo-track, #eee)", borderRadius: 4, height: 10, width: "100%", overflow: "hidden" }}>
                        <div
                          className={scoreBarClass(row.score)}
                          style={{ width: `${widthPct}%`, height: "100%", display: "block", borderRadius: 4 }}
                        />
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Comentarios recientes</p>
              <h3>Recent responses</h3>
            </div>
            <span className="bo-chip">{recentResponses.length} · {loading ? "cargando…" : "actualizado"}</span>
          </div>
          {recentResponses.length === 0 ? (
            <EmptyState
              title="No hay respuestas recientes"
              message="Cuando los huéspedes contesten las encuestas, sus comentarios aparecerán aquí con score y sentimiento."
            />
          ) : (
            <ul className="bo-list">
              {recentResponses.map((response) => (
                <li key={response.id} style={{ marginBottom: 12 }}>
                  <div className="bo-card-head" style={{ marginBottom: 4 }}>
                    <div>
                      <strong>{response.surveyName}</strong>
                      {response.sentiment ? (
                        <>
                          {" "}
                          <span className={sentimentPillClass(response.sentiment)}>{response.sentiment}</span>
                        </>
                      ) : null}
                    </div>
                    <span className={scorePillClass(response.score)}>
                      {response.score !== undefined ? `${response.score.toFixed(1)}` : "sin score"}
                    </span>
                  </div>
                  {response.comment ? <p style={{ margin: "4px 0" }}>{response.comment}</p> : null}
                  <small className="bo-muted">{formatDate(response.submittedAt)}</small>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Temas mencionados</p>
              <h3>Top themes</h3>
            </div>
            <span className="bo-chip">{topThemes.length} temas</span>
          </div>
          {topThemes.length === 0 ? (
            <EmptyState
              title="No hay temas categorizados"
              message="Cuando haya respuestas con texto suficiente, la IA agrupará los temas y los mostrará aquí ordenados por menciones."
            />
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Tema</th>
                  <th style={{ width: 90, textAlign: "right" }}>Menciones</th>
                </tr>
              </thead>
              <tbody>
                {topThemes.map((row) => (
                  <tr key={row.theme}>
                    <td><strong>{row.theme}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
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
