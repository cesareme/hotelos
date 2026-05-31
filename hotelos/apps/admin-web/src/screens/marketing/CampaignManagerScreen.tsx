// Campañas de marketing — orquesta segmento + canal + plantilla + horario.
// Conecta con la mensajería omnichannel (P1-6) y los segmentos CRM (P1-14).

import { useMemo, useState } from "react";

type Campaign = {
  id: string;
  name: string;
  status: "draft" | "scheduled" | "running" | "paused" | "completed";
  segment: string;
  channel: "email" | "whatsapp" | "sms" | "push";
  template: string;
  goalEur: number;
  audience: number;
  sentCount: number;
  openRate: number;
  conversionRate: number;
  revenueEur: number;
  startsAt: string;
  endsAt: string | null;
};

const INITIAL_CAMPAIGNS: Campaign[] = [
  {
    id: "c_vip_summer",
    name: "VIP · Pre-venta verano 2026",
    status: "running",
    segment: "VIP recurrentes",
    channel: "email",
    template: "vip_preventa_v2",
    goalEur: 18_000,
    audience: 84,
    sentCount: 84,
    openRate: 78.6,
    conversionRate: 14.3,
    revenueEur: 14_280,
    startsAt: "2026-05-10",
    endsAt: "2026-06-30"
  },
  {
    id: "c_winback",
    name: "Vuelve · Huéspedes dormidos",
    status: "running",
    segment: "Dormidos (>12m sin venir)",
    channel: "whatsapp",
    template: "winback_15pct_v1",
    goalEur: 12_000,
    audience: 318,
    sentCount: 312,
    openRate: 92.0,
    conversionRate: 4.8,
    revenueEur: 8_220,
    startsAt: "2026-05-05",
    endsAt: "2026-06-15"
  },
  {
    id: "c_corp_loyalty",
    name: "Corporate ES · Programa B2B Q3",
    status: "scheduled",
    segment: "Corporate España",
    channel: "email",
    template: "corp_b2b_q3",
    goalEur: 35_000,
    audience: 412,
    sentCount: 0,
    openRate: 0,
    conversionRate: 0,
    revenueEur: 0,
    startsAt: "2026-07-01",
    endsAt: "2026-09-30"
  },
  {
    id: "c_first_eu",
    name: "Bienvenida · Primera vez EU",
    status: "running",
    segment: "Primera vez (Europa)",
    channel: "email",
    template: "first_timer_welcome",
    goalEur: 6_000,
    audience: 1_240,
    sentCount: 1_240,
    openRate: 64.1,
    conversionRate: 2.4,
    revenueEur: 5_840,
    startsAt: "2026-04-15",
    endsAt: null
  },
  {
    id: "c_otas_parity",
    name: "Recordatorio paridad · Reserva directa",
    status: "paused",
    segment: "Reservaron OTA en últimos 90 d",
    channel: "email",
    template: "ota_to_direct",
    goalEur: 4_000,
    audience: 287,
    sentCount: 150,
    openRate: 41.2,
    conversionRate: 1.8,
    revenueEur: 720,
    startsAt: "2026-04-22",
    endsAt: null
  }
];

const CHANNEL_ICON: Record<string, string> = {
  email: "📧",
  whatsapp: "💬",
  sms: "📱",
  push: "🔔"
};

const STATUS_BADGE: Record<string, "ok" | "warn" | "info"> = {
  running: "ok",
  scheduled: "info",
  draft: "info",
  paused: "warn",
  completed: "info"
};

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

export function CampaignManagerScreen() {
  const [campaigns, setCampaigns] = useState<Campaign[]>(INITIAL_CAMPAIGNS);
  const [filter, setFilter] = useState<"all" | Campaign["status"]>("all");

  const stats = useMemo(() => {
    const running = campaigns.filter((c) => c.status === "running").length;
    const totalRevenue = campaigns.reduce((s, c) => s + c.revenueEur, 0);
    const totalGoal = campaigns.reduce((s, c) => s + c.goalEur, 0);
    const totalSent = campaigns.reduce((s, c) => s + c.sentCount, 0);
    const avgOpen = campaigns.filter((c) => c.sentCount > 0).reduce((s, c, _, arr) => s + c.openRate / arr.length, 0);
    return { running, totalRevenue, totalGoal, totalSent, avgOpen, goalProgress: (totalRevenue / totalGoal) * 100 };
  }, [campaigns]);

  function toggleStatus(id: string) {
    setCampaigns((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      if (c.status === "running") return { ...c, status: "paused" };
      if (c.status === "paused" || c.status === "scheduled") return { ...c, status: "running" };
      return c;
    }));
  }

  const filtered = filter === "all" ? campaigns : campaigns.filter((c) => c.status === filter);

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Comercial · Marketing
          </p>
          <h2 style={{ color: "var(--ink)" }}>Campañas de marketing</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Cada campaña une un <strong>segmento CRM</strong> con una <strong>plantilla</strong> y un <strong>canal</strong>.
            El motor de mensajería omnichannel se encarga del envío, con cascada de fallback si el canal primario falla.
          </p>
        </div>
        <button type="button" className="primary">+ Nueva campaña</button>
      </header>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Activas</span><span className="bo-status ok">running</span></div>
          <div className="rev-kpi-value">{stats.running}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ingresos atribuidos</span><span className="bo-status info">vs objetivo</span></div>
          <div className="rev-kpi-value">{fmtMoney(stats.totalRevenue)}</div>
          <div style={{ marginTop: 4, height: 4, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, stats.goalProgress)}%`, height: "100%", background: "var(--accent)" }} />
          </div>
          <p className="bo-muted" style={{ fontSize: 11, margin: "2px 0 0" }}>{stats.goalProgress.toFixed(0)}% de {fmtMoney(stats.totalGoal)}</p>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Envíos totales</span></div>
          <div className="rev-kpi-value">{stats.totalSent.toLocaleString("es-ES")}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Open rate medio</span></div>
          <div className="rev-kpi-value">{stats.avgOpen.toFixed(1)} %</div>
        </article>
      </div>

      {/* Filter */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["all", "running", "scheduled", "paused", "completed", "draft"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={filter === f ? "primary" : ""}
            style={{ padding: "6px 12px" }}
          >
            {f === "all" ? "Todas" : f === "running" ? "En curso" : f === "scheduled" ? "Programadas" : f === "paused" ? "Pausadas" : f === "completed" ? "Completadas" : "Borradores"}
          </button>
        ))}
      </div>

      {/* Campaigns table */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Campañas ({filtered.length})</h3>
        </div>
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Campaña</th><th>Segmento</th><th>Canal</th><th>Estado</th>
                <th>Audiencia</th><th>Enviados</th><th>Open</th><th>Conv.</th>
                <th>Ingresos</th><th>Objetivo</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const goalPct = c.goalEur > 0 ? (c.revenueEur / c.goalEur) * 100 : 0;
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <small className="bo-muted" style={{ display: "block" }}>{c.template}</small>
                    </td>
                    <td style={{ fontSize: 12 }}>{c.segment}</td>
                    <td>{CHANNEL_ICON[c.channel]} {c.channel}</td>
                    <td><span className={`bo-status ${STATUS_BADGE[c.status]}`} style={{ fontSize: 10 }}>{c.status}</span></td>
                    <td className="mono">{c.audience.toLocaleString("es-ES")}</td>
                    <td className="mono">{c.sentCount.toLocaleString("es-ES")}</td>
                    <td className="mono">{c.openRate.toFixed(1)} %</td>
                    <td className="mono">{c.conversionRate.toFixed(1)} %</td>
                    <td className="mono">{fmtMoney(c.revenueEur)}</td>
                    <td className="mono" style={{ color: goalPct >= 80 ? "var(--accent)" : goalPct >= 50 ? undefined : "var(--ink-muted)" }}>
                      {goalPct.toFixed(0)}%
                    </td>
                    <td>
                      <button type="button" onClick={() => toggleStatus(c.id)} disabled={c.status === "completed" || c.status === "draft"}>
                        {c.status === "running" ? "Pausar" : c.status === "paused" || c.status === "scheduled" ? "Activar" : "—"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
