import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

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
  if (status === "open") return <span className="cm-pill cm-pill-ok">open</span>;
  if (status === "handoff") return <span className="cm-pill cm-pill-warn">handoff</span>;
  if (status === "closed") return <span className="cm-pill">closed</span>;
  return <span className="cm-pill">{status}</span>;
}

function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const dayCount = Math.round(hours / 24);
  return `${dayCount}d ago`;
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
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Concierge</div>
          <h1 className="bo-page-title">Concierge inbox</h1>
          <p className="bo-page-subtitle">
            Resumen en vivo de las conversaciones con los huéspedes: cobertura de la IA, tiempo de respuesta, sentimiento y peticiones más comunes en los últimos 7 días.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => refresh()}>↻ Refresh</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card">
          <p className="bo-muted">Couldn't load the concierge inbox right now. Refresh to retry.</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${kpis.openConversations > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Open conversations</span></div>
          <div className="rev-kpi-value">{kpis.openConversations}</div>
          <div className="rev-kpi-delta">{loading ? "loading…" : "Awaiting reply or in handoff"}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Messages · 24h</span></div>
          <div className="rev-kpi-value">{kpis.messagesLast24h}</div>
          <div className="rev-kpi-delta">Inbound + outbound</div>
        </article>
        <article className={`rev-kpi ${kpis.avgResponseMinutes > 15 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Avg response time</span></div>
          <div className="rev-kpi-value">{kpis.avgResponseMinutes} min</div>
          <div className="rev-kpi-delta">Guest → staff/AI first reply</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">AI resolution</span></div>
          <div className="rev-kpi-value">{kpis.aiResolutionRatePct}%</div>
          <div className="rev-kpi-delta">No human escalation</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Sentiment</p>
            <h3>Sentimiento del huésped</h3>
          </div>
          <span className="bo-chip">{sentiment.positive + sentiment.neutral + sentiment.negative === 0 ? "no sentiment data" : "last 7 days"}</span>
        </div>
        <div style={{ display: "flex", height: 18, borderRadius: 8, overflow: "hidden", background: "var(--bo-surface-muted, #f4f4f5)" }}>
          <div title={`Positive ${sentiment.positive}%`} style={{ width: `${sentiment.positive}%`, background: "var(--success-bg, #10b981)" }} />
          <div title={`Neutral ${sentiment.neutral}%`} style={{ width: `${sentiment.neutral}%`, background: "var(--bo-muted-bg, #9ca3af)" }} />
          <div title={`Negative ${sentiment.negative}%`} style={{ width: `${sentiment.negative}%`, background: "var(--danger-bg, #ef4444)" }} />
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
            <h3>Conversations by channel</h3>
            <span className="bo-chip">{channels.length} channels</span>
          </div>
          {channels.length === 0 ? (
            <p className="bo-muted">No conversations yet.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th style={{ textAlign: "right" }}>Conversations</th>
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
            <h3>Top guest requests</h3>
            <span className="bo-chip">{requests.length} categories</span>
          </div>
          {requests.length === 0 ? (
            <p className="bo-muted">No tagged requests in window.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th style={{ textAlign: "right" }}>Count</th>
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
          <h3>Recent conversations</h3>
          <span className="bo-chip">{recent.length} shown</span>
        </div>
        {recent.length === 0 ? (
          <p className="bo-muted">No conversations to show.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Conversation</th>
                <th>Guest</th>
                <th>Channel</th>
                <th>Status</th>
                <th>AI</th>
                <th style={{ textAlign: "right" }}>Messages</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id}>
                  <td><code>{row.id}</code></td>
                  <td>{row.guestId ?? "—"}</td>
                  <td>{row.channel}</td>
                  <td>{statusPill(row.status)}</td>
                  <td>{row.aiEnabled ? <span className="cm-pill cm-pill-ok">AI on</span> : <span className="cm-pill">AI off</span>}</td>
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
