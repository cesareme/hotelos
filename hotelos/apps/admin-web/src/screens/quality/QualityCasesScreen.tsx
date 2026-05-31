// Casos de calidad — quejas, incidencias y reclamaciones que escalan a
// dirección. Se abren automáticamente desde NPS detractor o desde el chat
// del huésped, y se cierran cuando la dirección documenta la resolución.

import { useMemo, useState } from "react";

type QualityCase = {
  id: string;
  code: string;
  title: string;
  source: "nps_detractor" | "guest_chat" | "front_desk" | "ota_review" | "social_media";
  reservationCode: string | null;
  guestName: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "investigating" | "responded" | "resolved" | "escalated";
  category: "service" | "facilities" | "f_and_b" | "billing" | "accessibility" | "noise" | "cleanliness";
  description: string;
  assignedTo: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionMinutes: number | null;
  resolutionNotes: string;
};

const CASES: QualityCase[] = [
  {
    id: "qc_001",
    code: "QC-2026-0142",
    title: "Aire acondicionado ruidoso · Hab. 412",
    source: "nps_detractor",
    reservationCode: "RVNX-01852",
    guestName: "Marie Dubois",
    severity: "medium",
    status: "investigating",
    category: "noise",
    description: "Huésped indica en encuesta NPS (puntuación 7) que el aire acondicionado le despertó dos veces durante la estancia.",
    assignedTo: "Javier Soto · Mantenimiento",
    createdAt: "2026-05-25T22:45:00Z",
    resolvedAt: null,
    resolutionMinutes: null,
    resolutionNotes: ""
  },
  {
    id: "qc_002",
    code: "QC-2026-0141",
    title: "Cola de check-in · 25 min de espera",
    source: "nps_detractor",
    reservationCode: "RVNX-01852",
    guestName: "Hans Müller",
    severity: "high",
    status: "responded",
    category: "service",
    description: "Detractor NPS (4/10): «check-in colas largas, llegamos cansados de vuelo». Coincidió con dos llegadas simultáneas de grupo.",
    assignedTo: "Ana Martínez · Recepción",
    createdAt: "2026-05-25T19:35:00Z",
    resolvedAt: null,
    resolutionMinutes: null,
    resolutionNotes: "Disculpas formales enviadas + voucher 50€ para próxima estancia. Pendiente confirmar refuerzo en horas pico."
  },
  {
    id: "qc_003",
    code: "QC-2026-0140",
    title: "Cargo duplicado en factura",
    source: "guest_chat",
    reservationCode: "RVNX-01839",
    guestName: "Sophie Martin",
    severity: "high",
    status: "resolved",
    category: "billing",
    description: "Huésped contactó por chat indicando que vio el cargo de spa duplicado en la factura.",
    assignedTo: "Carmen López · Recepción",
    createdAt: "2026-05-23T11:20:00Z",
    resolvedAt: "2026-05-23T12:05:00Z",
    resolutionMinutes: 45,
    resolutionNotes: "Verificado en folio: una de las dos era cargo erróneo. Factura rectificativa emitida (REC-2026-0034). Huésped confirmó corrección."
  },
  {
    id: "qc_004",
    code: "QC-2026-0139",
    title: "Comida fría en room service",
    source: "guest_chat",
    reservationCode: "RVNX-01838",
    guestName: "David Chen",
    severity: "medium",
    status: "resolved",
    category: "f_and_b",
    description: "Plato principal llegó frío. Pedido a las 21:45, llegó a las 22:30.",
    assignedTo: "Roberto Vega · F&B",
    createdAt: "2026-05-22T22:35:00Z",
    resolvedAt: "2026-05-22T22:55:00Z",
    resolutionMinutes: 20,
    resolutionNotes: "Plato repuesto + postre cortesía. Conversación con cocina sobre tiempos en horario pico."
  },
  {
    id: "qc_005",
    code: "QC-2026-0138",
    title: "Acceso silla de ruedas obstaculizado",
    source: "guest_chat",
    reservationCode: "RVNX-01836",
    guestName: "Robert Hawkins",
    severity: "critical",
    status: "escalated",
    category: "accessibility",
    description: "Huésped con movilidad reducida indica que la rampa lateral estaba bloqueada por material de obra durante 2 días.",
    assignedTo: "Director · escalado",
    createdAt: "2026-05-21T14:00:00Z",
    resolvedAt: null,
    resolutionMinutes: null,
    resolutionNotes: "Escalado a dirección. Revisión completa de accesibilidad programada para próxima semana."
  },
  {
    id: "qc_006",
    code: "QC-2026-0137",
    title: "Review 2★ en Booking · limpieza baño",
    source: "ota_review",
    reservationCode: "RVNX-01828",
    guestName: "Jennifer Wong",
    severity: "high",
    status: "resolved",
    category: "cleanliness",
    description: "Review en Booking.com 2★ con foto de pelos en el baño. Visibilidad pública alta.",
    assignedTo: "Pilar Sánchez · Gobernanta",
    createdAt: "2026-05-19T10:10:00Z",
    resolvedAt: "2026-05-19T17:00:00Z",
    resolutionMinutes: 410,
    resolutionNotes: "Respuesta pública en Booking ofreciendo disculpas + invitación a volver. Equipo de pisos revisó protocolo de inspección con la camarera asignada."
  }
];

const SEVERITY_COLOR: Record<string, string> = {
  low: "#7aa9ff",
  medium: "#f0b46a",
  high: "#ef6b6b",
  critical: "#ef6b6b"
};

const SOURCE_LABEL: Record<string, string> = {
  nps_detractor: "NPS detractor",
  guest_chat: "Chat del huésped",
  front_desk: "Recepción",
  ota_review: "Review OTA",
  social_media: "Redes sociales"
};

const CATEGORY_ICON: Record<string, string> = {
  service: "👤",
  facilities: "🏨",
  f_and_b: "🍽",
  billing: "💳",
  accessibility: "♿",
  noise: "🔊",
  cleanliness: "🧹"
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function QualityCasesScreen() {
  const [filter, setFilter] = useState<"all" | QualityCase["status"]>("all");

  const stats = useMemo(() => {
    const open = CASES.filter((c) => c.status === "open" || c.status === "investigating").length;
    const resolved = CASES.filter((c) => c.status === "resolved").length;
    const critical = CASES.filter((c) => c.severity === "critical").length;
    const avgResolution = CASES
      .filter((c) => c.resolutionMinutes !== null)
      .reduce((s, c, _, arr) => s + (c.resolutionMinutes ?? 0) / arr.length, 0);
    return { open, resolved, critical, avgResolution, total: CASES.length };
  }, []);

  const filtered = filter === "all" ? CASES : CASES.filter((c) => c.status === filter);

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Experiencia del huésped · Calidad
          </p>
          <h2 style={{ color: "var(--ink)" }}>Casos de calidad y quejas</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Cada caso une <strong>fuente</strong> (NPS / chat / review OTA), <strong>severidad</strong>, <strong>responsable</strong> y <strong>notas de resolución</strong>.
            Los detractores NPS abren caso automáticamente.
          </p>
        </div>
      </header>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Abiertos</span><span className="bo-status warn">requieren acción</span></div>
          <div className="rev-kpi-value" style={{ color: stats.open > 0 ? "var(--warn-ink, #f0b46a)" : undefined }}>{stats.open}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Críticos</span></div>
          <div className="rev-kpi-value" style={{ color: stats.critical > 0 ? "#ef6b6b" : undefined }}>{stats.critical}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Resueltos</span></div>
          <div className="rev-kpi-value" style={{ color: "var(--accent)" }}>{stats.resolved}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Resolución media</span></div>
          <div className="rev-kpi-value">{Math.round(stats.avgResolution)} min</div>
        </article>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["all", "open", "investigating", "responded", "resolved", "escalated"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={filter === f ? "primary" : ""} style={{ padding: "6px 12px" }}>
            {f === "all" ? "Todos" : f === "open" ? "Abiertos" : f === "investigating" ? "Investigando" : f === "responded" ? "Respondidos" : f === "resolved" ? "Resueltos" : "Escalados"}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((c) => (
          <article key={c.id} className="bo-card" style={{ background: "var(--surface)", borderLeft: `4px solid ${SEVERITY_COLOR[c.severity]}` }}>
            <div className="bo-card-head" style={{ marginBottom: 4 }}>
              <div>
                <strong style={{ color: "var(--ink)" }}>{CATEGORY_ICON[c.category]} {c.title}</strong>
                <p className="bo-muted" style={{ margin: "2px 0 0", fontSize: 11 }}>
                  <code>{c.code}</code> · {c.guestName} {c.reservationCode ? `(${c.reservationCode})` : ""} · {SOURCE_LABEL[c.source]} · {fmtDate(c.createdAt)}
                </p>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span className={`bo-status ${c.severity === "critical" || c.severity === "high" ? "warn" : "info"}`} style={{ fontSize: 10 }}>
                  {c.severity}
                </span>
                <span className={`bo-status ${c.status === "resolved" ? "ok" : c.status === "escalated" ? "warn" : "info"}`} style={{ fontSize: 10 }}>
                  {c.status}
                </span>
              </div>
            </div>
            <p style={{ fontSize: 13, color: "var(--ink)", margin: "8px 0 0" }}>{c.description}</p>
            {c.resolutionNotes ? (
              <p style={{ fontSize: 12, color: "var(--ink)", margin: "8px 0 0", paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                <strong>Resolución:</strong> {c.resolutionNotes}
              </p>
            ) : null}
            <p className="bo-muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
              Asignado a: <strong>{c.assignedTo ?? "—"}</strong>
              {c.resolutionMinutes !== null ? ` · Resuelto en ${c.resolutionMinutes} min` : ""}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
