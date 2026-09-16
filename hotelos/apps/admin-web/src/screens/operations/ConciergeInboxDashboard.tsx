// Mensajes de huéspedes — Recepción › Mensajes (/recepcion/mensajes).
//
// Cocoa 22 (ola 3 · lote 3-C): CocoaPage (standalone) → CocoaKpiStrip with
// the four live counters → «Sentimiento del huésped» as three
// CocoaChart.Progress bars → CocoaGrid 6/6 with the conversations by channel
// and the most frequent requests (CocoaTable) → «Conversaciones recientes»
// CocoaTable (fit / showFrom columns, badges for status and AI). Same data:
// GET /dashboards/concierge?propertyId (polling 30 s); a failed refresh with
// stale data shows a danger callout instead of zeros.

import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { EMPTY, number, percent, plural, relativeTime } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type ConversationRow = {
  id: string;
  guestId?: string;
  channel: string;
  status: string;
  aiEnabled: boolean;
  lastMessageAt?: string;
  messageCount: number;
};

type ChannelRow = { channel: string; count: number };
type RequestRow = { category: string; count: number };

type ConciergeDashboard = {
  kpis: {
    openConversations: number;
    messagesLast24h: number;
    avgResponseMinutes: number;
    aiResolutionRatePct: number;
    sentimentAggregate: { positive: number; neutral: number; negative: number };
  };
  conversationsByChannel: ChannelRow[];
  recentConversations: ConversationRow[];
  topGuestRequests: RequestRow[];
};

function conversationStatus(status: string): { label: string; tone: CocoaTone } {
  if (status === "open") return { label: "abierta", tone: "success" };
  if (status === "handoff") return { label: "pasada a persona", tone: "warning" };
  if (status === "closed") return { label: "cerrada", tone: "neutral" };
  return { label: status, tone: "neutral" };
}

const CHANNEL_COLUMNS: CocoaTableColumn<ChannelRow>[] = [
  { key: "channel", label: "Canal" },
  { key: "count", label: "Conversaciones", align: "right", fit: true, render: (r) => number(r.count) }
];

const REQUEST_COLUMNS: CocoaTableColumn<RequestRow>[] = [
  { key: "category", label: "Categoría" },
  { key: "count", label: "Cantidad", align: "right", fit: true, render: (r) => number(r.count) }
];

const RECENT_COLUMNS: CocoaTableColumn<ConversationRow>[] = [
  { key: "id", label: "Conversación", fit: true, render: (r) => <span className="cocoa-mono">{r.id}</span> },
  { key: "guestId", label: "Huésped", hideOnNarrow: true, render: (r) => r.guestId ?? EMPTY },
  { key: "channel", label: "Canal", fit: true },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (r) => {
      const s = conversationStatus(r.status);
      return <CocoaBadge tone={s.tone}>{s.label}</CocoaBadge>;
    }
  },
  {
    key: "aiEnabled",
    label: "IA",
    fit: true,
    showFrom: "tablet",
    render: (r) => (r.aiEnabled ? <CocoaBadge tone="ai">IA activa</CocoaBadge> : <CocoaBadge tone="neutral">IA desactivada</CocoaBadge>)
  },
  { key: "messageCount", label: "Mensajes", align: "right", fit: true, render: (r) => number(r.messageCount) },
  { key: "lastMessageAt", label: "Última actividad", fit: true, render: (r) => relativeTime(r.lastMessageAt) }
];

function ConciergeSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={140} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={220} />
    </div>
  );
}

export function ConciergeInboxDashboard() {
  const { data, loading, error, refresh } = useApiData<ConciergeDashboard>("/dashboards/concierge", {
    query: { propertyId: PROPERTY_ID },
    pollIntervalMs: 30000
  });

  const kpis = data?.kpis;
  const sentiment = kpis?.sentimentAggregate ?? { positive: 0, neutral: 0, negative: 0 };
  const sentimentTotal = sentiment.positive + sentiment.neutral + sentiment.negative;
  const channels = toArray<ChannelRow>(data?.conversationsByChannel);
  const recent = toArray<ConversationRow>(data?.recentConversations);
  const requests = toArray<RequestRow>(data?.topGuestRequests);

  return (
    <CocoaPage
      eyebrow="Recepción · Mensajes"
      title="Mensajes de huéspedes"
      subtitle="Resumen en vivo de las conversaciones con los huéspedes: cobertura de la IA, tiempo de respuesta, sentimiento y peticiones más frecuentes de los últimos 7 días."
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => refresh()} loading={loading && Boolean(data)}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<ConciergeSkeleton />}
      error={{ title: UI_STATES.error.title, message: error ?? UI_STATES.error.message, onRetry: () => refresh() }}
      commands={[{ id: "concierge-refresh", label: "Actualizar mensajes de huéspedes", run: () => refresh() }]}
    >
      {error && data ? (
        <CocoaCallout tone="danger" title={UI_STATES.error.title} role="status">
          {error}
        </CocoaCallout>
      ) : null}

      {kpis ? (
        <CocoaKpiStrip stagger aria-label="Indicadores de mensajería">
          <CocoaKpi
            label="Conversaciones abiertas"
            value={number(kpis.openConversations)}
            caption="Esperan respuesta o están en manos de una persona"
            polarity="negative-good"
            status={kpis.openConversations > 0 ? "warning" : "ok"}
          />
          <CocoaKpi label="Mensajes · 24 h" value={number(kpis.messagesLast24h)} caption="Recibidos y enviados" polarity="neutral" />
          <CocoaKpi
            label="Tiempo medio de respuesta"
            value={number(kpis.avgResponseMinutes)}
            unit="min"
            caption="Del mensaje del huésped a la primera respuesta (persona o IA)"
            polarity="negative-good"
            status={kpis.avgResponseMinutes > 15 ? "warning" : "ok"}
          />
          <CocoaKpi label="Resueltas por la IA" value={percent(kpis.aiResolutionRatePct)} caption="Sin intervención de una persona" polarity="positive-good" />
        </CocoaKpiStrip>
      ) : null}

      <CocoaSection title="Sentimiento del huésped" meta={sentimentTotal === 0 ? "Sin datos de sentimiento" : "Últimos 7 días"}>
        {sentimentTotal === 0 ? (
          <CocoaState kind="empty" inline title="Sin datos de sentimiento en el periodo." />
        ) : (
          <>
            <CocoaChart.Progress value={sentiment.positive} tone="success" label="Positivo" valueLabel={percent(sentiment.positive)} aria-label={`Sentimiento positivo ${percent(sentiment.positive)}`} />
            <CocoaChart.Progress value={sentiment.neutral} tone="neutral" label="Neutro" valueLabel={percent(sentiment.neutral)} aria-label={`Sentimiento neutro ${percent(sentiment.neutral)}`} />
            <CocoaChart.Progress value={sentiment.negative} tone="danger" label="Negativo" valueLabel={percent(sentiment.negative)} aria-label={`Sentimiento negativo ${percent(sentiment.negative)}`} />
          </>
        )}
      </CocoaSection>

      <CocoaGrid align="start" aria-label="Canales y peticiones">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Conversaciones por canal" meta={plural(channels.length, "canal", "canales")} padding={channels.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {channels.length === 0 ? (
              <CocoaState kind="empty" inline title="Aún no hay conversaciones." />
            ) : (
              <CocoaTable columns={CHANNEL_COLUMNS} rows={channels} rowKey="channel" caption="Conversaciones por canal" aria-label="Conversaciones por canal" />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Peticiones más frecuentes" meta={plural(requests.length, "categoría", "categorías")} padding={requests.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {requests.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin peticiones clasificadas en el periodo." />
            ) : (
              <CocoaTable columns={REQUEST_COLUMNS} rows={requests} rowKey="category" caption="Peticiones más frecuentes" aria-label="Peticiones más frecuentes" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Conversaciones recientes" meta={plural(recent.length, "conversación mostrada", "conversaciones mostradas")} padding={recent.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {recent.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay conversaciones que mostrar." />
        ) : (
          <CocoaTable columns={RECENT_COLUMNS} rows={recent} rowKey="id" caption="Conversaciones recientes" aria-label="Conversaciones recientes" />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
