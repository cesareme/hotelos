import { useApiData } from "../../hooks/useApiData";

type ReputationDashboardData = {
  kpis: {
    avgRating: number;
    reviewsLast7d: number;
    reviewsLast30d: number;
    pendingResponses: number;
    sentimentScore: number;
  };
  ratingDistribution: { star1: number; star2: number; star3: number; star4: number; star5: number };
  reviewsBySource: Array<{ sourceName: string; count: number; avgRating: number }>;
  recentReviews: Array<{
    id: string;
    sourceName: string;
    ratingValue?: number;
    title?: string;
    body?: string;
    createdAt: string;
    respondedAt?: string;
  }>;
};

const EMPTY: ReputationDashboardData = {
  kpis: { avgRating: 0, reviewsLast7d: 0, reviewsLast30d: 0, pendingResponses: 0, sentimentScore: 0 },
  ratingDistribution: { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 },
  reviewsBySource: [],
  recentReviews: []
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function ratingPillClass(rating?: number): string {
  if (rating === undefined || rating === null) return "cm-pill";
  if (rating >= 4.5) return "cm-pill cm-pill-ok";
  if (rating >= 3.5) return "cm-pill";
  if (rating >= 2.5) return "cm-pill cm-pill-warn";
  return "cm-pill cm-pill-error";
}

export function ReputationDashboard() {
  const { data, loading, error, refresh } = useApiData<ReputationDashboardData>(
    "/dashboards/reputation",
    { pollIntervalMs: 120000 }
  );

  const view = data ?? EMPTY;
  const { kpis, ratingDistribution, reviewsBySource, recentReviews } = view;

  const distributionRows: Array<{ label: string; star: 1 | 2 | 3 | 4 | 5; count: number }> = [
    { label: "5 estrellas", star: 5, count: ratingDistribution.star5 },
    { label: "4 estrellas", star: 4, count: ratingDistribution.star4 },
    { label: "3 estrellas", star: 3, count: ratingDistribution.star3 },
    { label: "2 estrellas", star: 2, count: ratingDistribution.star2 },
    { label: "1 estrella", star: 1, count: ratingDistribution.star1 }
  ];
  const totalDistribution = distributionRows.reduce((total, row) => total + row.count, 0);
  const sentimentLabel = kpis.sentimentScore > 0.2
    ? "Positivo"
    : kpis.sentimentScore < -0.2
      ? "Negativo"
      : "Neutro";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Guest experience</div>
          <h1 className="bo-page-title">Reputación</h1>
          <p className="bo-page-subtitle">
            Monitorización en tiempo real de las opiniones de los huéspedes: valoración media, distribución por estrellas,
            volumen por canal y reseñas pendientes de respuesta. Actualización automática cada 2 minutos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => refresh()}>↻ Refresh</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Error loading reputation data</h3>
            <span className="cm-pill cm-pill-error">error</span>
          </div>
          <p>{error}</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${kpis.avgRating >= 4 ? "rev-kpi-ok" : kpis.avgRating >= 3 ? "rev-kpi-warn" : "rev-kpi-error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Avg rating</span></div>
          <div className="rev-kpi-value">{kpis.avgRating.toFixed(1)} ★</div>
          <div className="rev-kpi-delta">Sentiment: {sentimentLabel} ({kpis.sentimentScore.toFixed(2)})</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Reviews · last 7d</span></div>
          <div className="rev-kpi-value">{kpis.reviewsLast7d}</div>
          <div className="rev-kpi-delta">últimos 7 días</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Reviews · last 30d</span></div>
          <div className="rev-kpi-value">{kpis.reviewsLast30d}</div>
          <div className="rev-kpi-delta">últimos 30 días</div>
        </article>
        <article className={`rev-kpi ${kpis.pendingResponses > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pending responses</span></div>
          <div className="rev-kpi-value">{kpis.pendingResponses}</div>
          <div className="rev-kpi-delta">requieren atención</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Distribución por estrellas</p>
              <h3>Star distribution</h3>
            </div>
            <span className="bo-chip">{totalDistribution} reviews</span>
          </div>
          <table className="cm-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Estrellas</th>
                <th>Distribución</th>
                <th style={{ width: 90, textAlign: "right" }}>Count</th>
                <th style={{ width: 70, textAlign: "right" }}>%</th>
              </tr>
            </thead>
            <tbody>
              {distributionRows.map((row) => {
                const pct = totalDistribution > 0 ? Math.round((row.count / totalDistribution) * 100) : 0;
                const fillClass = row.star >= 4 ? "cm-pill-ok" : row.star === 3 ? "cm-pill" : row.star === 2 ? "cm-pill-warn" : "cm-pill-error";
                return (
                  <tr key={row.star}>
                    <td>{"★".repeat(row.star)}<span className="bo-muted">{"★".repeat(5 - row.star)}</span></td>
                    <td>
                      <div style={{ background: "var(--bo-track, #eee)", borderRadius: 4, height: 10, width: "100%", overflow: "hidden" }}>
                        <div
                          className={fillClass}
                          style={{ width: `${pct}%`, height: "100%", display: "block", borderRadius: 4 }}
                        />
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                    <td style={{ textAlign: "right" }}>{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Volumen por canal</p>
              <h3>Reviews by source</h3>
            </div>
            <span className="bo-chip">{reviewsBySource.length} fuentes</span>
          </div>
          {reviewsBySource.length === 0 ? (
            <p className="bo-muted">No hay reseñas en el periodo seleccionado.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Fuente</th>
                  <th style={{ textAlign: "right" }}>Reviews</th>
                  <th style={{ textAlign: "right" }}>Avg rating</th>
                </tr>
              </thead>
              <tbody>
                {reviewsBySource.map((row) => (
                  <tr key={row.sourceName}>
                    <td><strong>{row.sourceName}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                    <td style={{ textAlign: "right" }}>
                      <span className={ratingPillClass(row.avgRating)}>{row.avgRating.toFixed(1)} ★</span>
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
            <p className="bo-muted">Últimas opiniones</p>
            <h3>Recent reviews</h3>
          </div>
          <span className="bo-chip">{recentReviews.length} · {loading ? "cargando…" : "actualizado"}</span>
        </div>
        {recentReviews.length === 0 ? (
          <p className="bo-muted">No hay reseñas recientes.</p>
        ) : (
          <ul className="bo-list">
            {recentReviews.map((review) => {
              const ratingValue = review.ratingValue ?? 0;
              const isFiveStar = ratingValue >= 4.5;
              const responded = Boolean(review.respondedAt);
              return (
                <li key={review.id} style={{ marginBottom: 12 }}>
                  <div className="bo-card-head" style={{ marginBottom: 4 }}>
                    <div>
                      <strong>{review.title || "(sin título)"}</strong>{" "}
                      <span className="bo-muted">· {review.sourceName}</span>
                    </div>
                    <span className={isFiveStar ? "cm-pill cm-pill-ok" : ratingPillClass(review.ratingValue)}>
                      {review.ratingValue !== undefined ? `${review.ratingValue.toFixed(1)} ★` : "sin valoración"}
                    </span>
                  </div>
                  {review.body ? <p style={{ margin: "4px 0" }}>{review.body}</p> : null}
                  <small className="bo-muted">
                    {formatDate(review.createdAt)} ·{" "}
                    {responded
                      ? <span className="cm-pill cm-pill-ok">respondida</span>
                      : <span className="cm-pill cm-pill-warn">pendiente de respuesta</span>}
                  </small>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
