// Encuestas post-estancia + NPS — el indicador estándar de satisfacción.
// Configuración de plantillas, ventana de envío, KPIs por canal, breakdown
// de respuestas en vivo.

import { useMemo, useState } from "react";

type SurveyTemplate = {
  id: string;
  name: string;
  triggerEvent: "post_checkout" | "midstay_day_2" | "post_checkin" | "post_dining";
  delayHours: number;
  channel: "email" | "whatsapp" | "sms";
  language: string;
  active: boolean;
};

type NpsResponse = {
  reservationCode: string;
  guestName: string;
  score: number;
  category: "promoter" | "passive" | "detractor";
  comment: string;
  submittedAt: string;
  respondedToInHours: number | null;
};

const TEMPLATES: SurveyTemplate[] = [
  { id: "tpl_checkout", name: "Encuesta principal post check-out", triggerEvent: "post_checkout", delayHours: 24, channel: "email", language: "auto", active: true },
  { id: "tpl_midstay", name: "Pulse mid-estancia (3+ noches)", triggerEvent: "midstay_day_2", delayHours: 0, channel: "whatsapp", language: "auto", active: true },
  { id: "tpl_dining", name: "Restaurante · post comanda", triggerEvent: "post_dining", delayHours: 2, channel: "email", language: "auto", active: false }
];

const RESPONSES: NpsResponse[] = [
  { reservationCode: "RVNX-01861", guestName: "Nina Petrova", score: 10, category: "promoter", comment: "Servicio impecable. Bárbara en recepción me reconoció en cuanto entré. Volveremos.", submittedAt: "2026-05-26T14:20:00Z", respondedToInHours: null },
  { reservationCode: "RVNX-01858", guestName: "James O'Brien", score: 9, category: "promoter", comment: "Great spa, room service was slow on day 1 but improved after we mentioned it.", submittedAt: "2026-05-26T10:15:00Z", respondedToInHours: 1.5 },
  { reservationCode: "RVNX-01856", guestName: "Marie Dubois", score: 7, category: "passive", comment: "Habitación con vistas espectaculares pero el ruido del aire acondicionado nos despertó dos veces.", submittedAt: "2026-05-25T22:40:00Z", respondedToInHours: 0.8 },
  { reservationCode: "RVNX-01852", guestName: "Hans Müller", score: 4, category: "detractor", comment: "Check-in colas largas, llegamos cansados de vuelo. Personal correcto pero la espera no.", submittedAt: "2026-05-25T19:30:00Z", respondedToInHours: 0.5 },
  { reservationCode: "RVNX-01848", guestName: "Sofia Conti", score: 10, category: "promoter", comment: "Tutto perfetto. Il personal della reception parla italiano!", submittedAt: "2026-05-25T11:00:00Z", respondedToInHours: 2.2 },
  { reservationCode: "RVNX-01847", guestName: "Carlos Ruiz", score: 8, category: "passive", comment: "Bien en general. La cama un poco dura para mi gusto.", submittedAt: "2026-05-24T18:00:00Z", respondedToInHours: null },
  { reservationCode: "RVNX-01840", guestName: "Anna Kowalski", score: 9, category: "promoter", comment: "Loved the rooftop bar! Recommendations from the concierge were spot-on.", submittedAt: "2026-05-24T15:20:00Z", respondedToInHours: 4.1 }
];

const CATEGORY_COLOR: Record<string, string> = {
  promoter: "var(--accent)",
  passive: "#f0b46a",
  detractor: "#ef6b6b"
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function SurveysNpsScreen() {
  const [templates, setTemplates] = useState<SurveyTemplate[]>(TEMPLATES);
  const [filter, setFilter] = useState<"all" | "promoter" | "passive" | "detractor">("all");

  const npsStats = useMemo(() => {
    const total = RESPONSES.length;
    const promoters = RESPONSES.filter((r) => r.category === "promoter").length;
    const detractors = RESPONSES.filter((r) => r.category === "detractor").length;
    const passives = RESPONSES.filter((r) => r.category === "passive").length;
    const nps = total > 0 ? Math.round(((promoters - detractors) / total) * 100) : 0;
    const sent = 1842;
    const responseRate = (total / sent) * 100;
    const avgResponseTime = RESPONSES.filter((r) => r.respondedToInHours !== null).reduce((s, r) => s + (r.respondedToInHours ?? 0), 0) / Math.max(1, RESPONSES.filter((r) => r.respondedToInHours !== null).length);
    return { total, promoters, passives, detractors, nps, sent, responseRate, avgResponseTime };
  }, []);

  const filtered = filter === "all" ? RESPONSES : RESPONSES.filter((r) => r.category === filter);

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Experiencia del huésped · Encuestas
          </p>
          <h2 style={{ color: "var(--ink)" }}>Encuestas y NPS</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            NPS = % promotores (9-10) − % detractores (0-6). Las respuestas se enrutan automáticamente al canal preferido
            del huésped. Los detractores generan un caso de calidad automático para que la dirección reaccione.
          </p>
        </div>
      </header>

      {/* NPS hero KPIs */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">NPS</span><span className="bo-status ok">últimos 30 d</span></div>
          <div className="rev-kpi-value" style={{ color: npsStats.nps >= 50 ? "var(--accent)" : npsStats.nps >= 0 ? undefined : "var(--warn-ink)" }}>
            {npsStats.nps > 0 ? "+" : ""}{npsStats.nps}
          </div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Respuestas</span></div>
          <div className="rev-kpi-value">{npsStats.total}</div>
          <p className="bo-muted" style={{ fontSize: 11, margin: 0 }}>de {npsStats.sent.toLocaleString("es-ES")} envíos ({npsStats.responseRate.toFixed(1)}%)</p>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Promotores</span></div>
          <div className="rev-kpi-value" style={{ color: "var(--accent)" }}>{npsStats.promoters}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Detractores</span><span className="bo-status warn">{npsStats.detractors > 0 ? "casos abiertos" : "—"}</span></div>
          <div className="rev-kpi-value" style={{ color: "#ef6b6b" }}>{npsStats.detractors}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tiempo medio respuesta</span></div>
          <div className="rev-kpi-value">{npsStats.avgResponseTime.toFixed(1)} h</div>
        </article>
      </div>

      {/* NPS distribution bar */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Distribución de respuestas</h3></div>
        <div style={{ display: "flex", height: 28, borderRadius: 6, overflow: "hidden", background: "var(--surface-2)" }}>
          <div style={{ width: `${(npsStats.detractors / npsStats.total) * 100}%`, background: CATEGORY_COLOR.detractor, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#0a0d10", fontWeight: 600 }}>
            {((npsStats.detractors / npsStats.total) * 100).toFixed(0)}%
          </div>
          <div style={{ width: `${(npsStats.passives / npsStats.total) * 100}%`, background: CATEGORY_COLOR.passive, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#0a0d10", fontWeight: 600 }}>
            {((npsStats.passives / npsStats.total) * 100).toFixed(0)}%
          </div>
          <div style={{ width: `${(npsStats.promoters / npsStats.total) * 100}%`, background: CATEGORY_COLOR.promoter, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#0a0d10", fontWeight: 600 }}>
            {((npsStats.promoters / npsStats.total) * 100).toFixed(0)}%
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--ink-muted)", marginTop: 6 }}>
          <span>🔴 Detractores 0–6</span>
          <span>🟠 Pasivos 7–8</span>
          <span>🟢 Promotores 9–10</span>
        </div>
      </article>

      {/* Templates */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Plantillas activas</h3></div>
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead><tr><th>Plantilla</th><th>Trigger</th><th>Delay</th><th>Canal</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  <td><code className="mono" style={{ fontSize: 11 }}>{t.triggerEvent}</code></td>
                  <td className="mono">{t.delayHours === 0 ? "inmediato" : `+${t.delayHours}h`}</td>
                  <td>{t.channel === "email" ? "📧" : t.channel === "whatsapp" ? "💬" : "📱"} {t.channel}</td>
                  <td><span className={`bo-status ${t.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{t.active ? "activa" : "pausada"}</span></td>
                  <td>
                    <button type="button" onClick={() => setTemplates((prev) => prev.map((x) => x.id === t.id ? { ...x, active: !x.active } : x))}>
                      {t.active ? "Pausar" : "Activar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {/* Responses */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Respuestas recientes ({filtered.length})</h3>
          <div style={{ display: "flex", gap: 4 }}>
            {(["all", "promoter", "passive", "detractor"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={filter === f ? "primary" : ""} style={{ padding: "4px 10px", fontSize: 12 }}>
                {f === "all" ? "Todas" : f === "promoter" ? "Promotores" : f === "passive" ? "Pasivos" : "Detractores"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((r) => (
            <article key={r.reservationCode} className="bo-card" style={{ background: "var(--surface-2, var(--surface))", borderLeft: `4px solid ${CATEGORY_COLOR[r.category]}` }}>
              <div className="bo-card-head" style={{ marginBottom: 4 }}>
                <div>
                  <strong style={{ color: "var(--ink)" }}>{r.guestName}</strong>
                  <span className="bo-muted" style={{ marginLeft: 8, fontSize: 11 }}>{r.reservationCode} · {fmtDate(r.submittedAt)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 24, fontWeight: 700, color: CATEGORY_COLOR[r.category] }}>{r.score}</span>
                  <span className="bo-muted" style={{ fontSize: 11 }}>/10</span>
                  <span className={`bo-status ${r.category === "promoter" ? "ok" : r.category === "passive" ? "info" : "warn"}`} style={{ fontSize: 10, marginLeft: 4 }}>
                    {r.category}
                  </span>
                </div>
              </div>
              <p style={{ fontSize: 13, color: "var(--ink)", margin: "4px 0 0", fontStyle: "italic" }}>«{r.comment}»</p>
              {r.respondedToInHours !== null ? (
                <p className="bo-muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
                  ✓ Respuesta del hotel enviada en {r.respondedToInHours.toFixed(1)} h
                </p>
              ) : (
                <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--warn-ink, #f0b46a)" }}>
                  ⚠ Sin respuesta del hotel · <button type="button" style={{ display: "inline" }}>Responder ahora</button>
                </p>
              )}
            </article>
          ))}
        </div>
      </article>
    </section>
  );
}
