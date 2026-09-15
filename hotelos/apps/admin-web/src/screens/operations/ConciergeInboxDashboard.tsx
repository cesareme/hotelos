import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ACTIONS, STATUS_LABELS, UI_STATES } from "../../content/actions";
import { percent, relativeTime } from "../../lib/format";

const PROPERTY_ID = getActivePropertyId();

type ConciergeDashboard = {
  kpis: {
    openConversations: number;
    messagesLast24h: number;
    avgResponseMinutes: number;
    aiResolutionRatePct: number;
    sentimentAggregate: { positive: number; neutral: number; negative: number };
  };
  conversationsByChannel: Array<{ channel: string; count: number }>;
  recentConversations: Array<{
    id: string;
    guestId?: string;
    channel: string;
    status: string;
    aiEnabled: boolean;
    lastMessageAt?: string;
    messageCount: number;
  }>;
  topGuestRequests: Array<{ category: string; count: number }>;
};

function statusPill(status: string) {
  if (status === "open") return <span className="cm-pill cm-pill-ok">abierta</span>;
  if (status === "handoff") return <span className="cm-pill cm-pill-warn">pasada a persona</span>;
  if (status === "closed") return <span className="cm-pill">cerrada</span>;
  return <span className="cm-pill">{status}</span>;
}

function formatRelative(iso?: string): string {
  return relativeTime(iso);
}

export function ConciergeInboxDashboard() {
  const { data, loading, error, refresh } = useApiData<ConciergeDashboard>("/dashboards/concierge", {
    query: { propertyId: PROPERTY_ID },
    pollIntervalMs: 30000
  });

  const kpis = data?.kpis ?? {
    openConversations: 0,
    messagesLast24h: 0,
    avgResponseMinutes: 0,
    aiResolutionRatePct: 0,
    sentimentAggregate: { positive: 0, neutral: 0, negative: 0 }
  };
  const sentiment = kpis.sentimentAggregate;
  const channels = data?.conversationsByChannel ?? [];
  const recent = data?.recentConversations ?? [];
  const requests = data?.topGuestRequests ?? [];

  return (
    <>
      <CocoaPageHeader
        eyebrow="Recepción"
        title="Mensajes de huéspedes"
        subtitle="Resumen en vivo de las conversaciones con los huéspedes: cobertura de la IA, tiempo de respuesta, sentimiento y peticiones más frecuentes de los últimos 7 días."
        actions={<button type="button" className="ghost" onClick={() => refresh()}>↻ {ACTIONS.refresh}</button>}
      />

      {error ? (
        <section className="bo-card">
          <p className="bo-muted">{UI_STATES.error.title}. {UI_STATES.error.message}</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${kpis.openConversations > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Conversaciones abiertas</span></div>
          <div className="rev-kpi-value">{kpis.openConversations}</div>
          <div className="rev-kpi-delta">{loading ? STATUS_LABELS.loading : "Esperan respuesta o están en manos de una persona"}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Mensajes · 24 h</span></div>
          <div className="rev-kpi-value">{kpis.messagesLast24h}</div>
          <div className="rev-kpi-delta">Recibidos y enviados</div>
        </article>
        <article className={`rev-kpi ${kpis.avgResponseMinutes > 15 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tiempo medio de respuesta</span></div>
          <div className="rev-kpi-value">{kpis.avgResponseMinutes} min</div>
          <div className="rev-kpi-delta">Del mensaje del huésped a la primera respuesta (persona o IA)</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Resueltas por la IA</span></div>
          <div className="rev-kpi-value">{kpis.aiResolutionRatePct}%</div>
          <div className="rev-kpi-delta">Sin intervención de una persona</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Sentimiento</p>
            <h3>Sentimiento del huésped</h3>
          </div>
          <span className="bo-chip">{sentiment.positive + sentiment.neutral + sentiment.negative === 0 ? "sin datos de sentimiento" : "últimos 7 días"}</span>
        </div>
        <div style={{ display: "flex", height: 18, borderRadius: 8, overflow: "hidden", background: "var(--bo-surface-muted, #f4f4f5)" }}>
          <div title={`Positivo ${percent(sentiment.positive)}`} style={{ width: `${sentiment.positive}%`, background: "var(--success-bg, #10b981)" }} />
          <div title={`Neutro ${percent(sentiment.neutral)}`} style={{ width: `${sentiment.neutral}%`, background: "var(--bo-muted-bg, #9ca3af)" }} />
          <div title={`Negativo ${percent(sentiment.negative)}`} style={{ width: `${sentiment.negative}%`, background: "var(--danger-bg, #ef4444)" }} />
        </div>
        <div className="bo-pill-row" style={{ marginTop: 12 }}>
          <span className="bo-pill">Positive {sentiment.positive}%</span>
          <span className="bo-pill">Neutral {sentiment.neutral}%</span>
          <span className="bo-pill">Negative {sentiment.negative}%</span>
        </div>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Conversaciones por canal</h3>
            <span className="bo-chip">{channels.length} channels</span>
          </div>
          {channels.length === 0 ? (
            <p className="bo-muted">Aún no hay conversaciones.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th style={{ textAlign: "right" }}>Conversaciones</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((row) => (
                  <tr key={row.channel}>
                    <td>{row.channel}</td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Peticiones más frecuentes</h3>
            <span className="bo-chip">{requests.length} categories</span>
          </div>
          {requests.length === 0 ? (
            <p className="bo-muted">Sin peticiones clasificadas en el periodo.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th style={{ textAlign: "right" }}>Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((row) => (
                  <tr key={row.category}>
                    <td>{row.category}</td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Conversaciones recientes</h3>
          <span className="bo-chip">{recent.length} shown</span>
        </div>
        {recent.length === 0 ? (
          <p className="bo-muted">No hay conversaciones que mostrar.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Conversación</th>
                <th>Huésped</th>
                <th>Canal</th>
                <th>Estado</th>
                <th>AI</th>
                <th style={{ textAlign: "right" }}>Mensajes</th>
                <th>Última actividad</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id}>
                  <td><code>{row.id}</code></td>
                  <td>{row.guestId ?? "—"}</td>
                  <td>{row.channel}</td>
                  <td>{statusPill(row.status)}</td>
                  <td>{row.aiEnabled ? <span className="cm-pill cm-pill-ok">IA activa</span> : <span className="cm-pill">IA desactivada</span>}</td>
                  <td style={{ textAlign: "right" }}>{row.messageCount}</td>
                  <td>{formatRelative(row.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
