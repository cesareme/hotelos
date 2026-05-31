// CRM · Segmentos de huéspedes — el corazón de las campañas y la
// personalización. Cada segmento es un conjunto de criterios sobre el perfil
// del huésped: nacionalidad, frecuencia, valor de vida, último viaje,
// satisfacción NPS… El backend ya tiene `MarketSegment` y `Guest`, esta
// pantalla los expone para configurar.

import { useMemo, useState } from "react";

type SegmentCriterion = {
  field: string;
  op: "equals" | "in" | "gt" | "gte" | "lt" | "lte" | "between" | "contains" | "exists";
  value: string;
};

type Segment = {
  id: string;
  name: string;
  description: string;
  criteria: SegmentCriterion[];
  active: boolean;
  estimatedSize: number;
  lastUsedAt: string | null;
  color: string;
};

const FIELDS = [
  { value: "country", label: "Nacionalidad" },
  { value: "language", label: "Idioma" },
  { value: "tier", label: "Tier de fidelización" },
  { value: "totalStays", label: "Nº total de estancias" },
  { value: "lifetimeValue", label: "Lifetime value (€)" },
  { value: "lastStayDays", label: "Días desde última estancia" },
  { value: "nps", label: "NPS última encuesta" },
  { value: "channel", label: "Canal habitual" },
  { value: "marketingConsent", label: "Consentimiento marketing" },
  { value: "ageRange", label: "Rango de edad" }
];

const INITIAL_SEGMENTS: Segment[] = [
  {
    id: "seg_vip",
    name: "VIP recurrentes",
    description: "Huéspedes con ≥ 5 estancias y NPS ≥ 9. Reciben upgrades automáticos y bienvenida personalizada.",
    criteria: [
      { field: "totalStays", op: "gte", value: "5" },
      { field: "nps", op: "gte", value: "9" }
    ],
    active: true,
    estimatedSize: 84,
    lastUsedAt: "2026-05-12T10:30:00Z",
    color: "#4ee0a3"
  },
  {
    id: "seg_lapsed",
    name: "Dormidos (>12m sin venir)",
    description: "Huéspedes sin estancia en los últimos 12 meses. Candidatos para campaña «vuelve» con oferta personalizada.",
    criteria: [
      { field: "lastStayDays", op: "gt", value: "365" },
      { field: "totalStays", op: "gte", value: "2" }
    ],
    active: true,
    estimatedSize: 318,
    lastUsedAt: "2026-04-28T09:15:00Z",
    color: "#f0b46a"
  },
  {
    id: "seg_corp_es",
    name: "Corporate España",
    description: "Reservas marcadas como business desde compañías españolas. Objetivo de retención con cuenta nominal.",
    criteria: [
      { field: "country", op: "equals", value: "ES" },
      { field: "channel", op: "in", value: "corporate, travel_agent" }
    ],
    active: true,
    estimatedSize: 412,
    lastUsedAt: "2026-05-20T16:45:00Z",
    color: "#7aa9ff"
  },
  {
    id: "seg_first_timer_eu",
    name: "Primera vez (Europa)",
    description: "Huéspedes europeos con 1 estancia completada. Objetivo: convertir a recurrente con email de seguimiento +14 días.",
    criteria: [
      { field: "totalStays", op: "equals", value: "1" },
      { field: "country", op: "in", value: "FR, DE, IT, UK, NL, BE" }
    ],
    active: true,
    estimatedSize: 1240,
    lastUsedAt: "2026-05-01T08:00:00Z",
    color: "#e8eef3"
  },
  {
    id: "seg_detractors",
    name: "Detractores (NPS ≤ 6)",
    description: "Salieron del hotel con experiencia negativa. Excluidos automáticamente de campañas comerciales.",
    criteria: [{ field: "nps", op: "lte", value: "6" }],
    active: false,
    estimatedSize: 47,
    lastUsedAt: null,
    color: "#ef6b6b"
  }
];

function fmtDate(iso: string | null): string {
  if (!iso) return "Nunca";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" });
}

export function GuestSegmentsScreen() {
  const [segments, setSegments] = useState<Segment[]>(INITIAL_SEGMENTS);
  const [editing, setEditing] = useState<Segment | null>(null);

  const stats = useMemo(() => {
    const total = segments.length;
    const active = segments.filter((s) => s.active).length;
    const reach = segments.filter((s) => s.active).reduce((sum, s) => sum + s.estimatedSize, 0);
    return { total, active, reach };
  }, [segments]);

  function toggleActive(id: string) {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, active: !s.active } : s)));
  }

  function startNew() {
    setEditing({
      id: `seg_${Date.now()}`,
      name: "",
      description: "",
      criteria: [{ field: "country", op: "equals", value: "" }],
      active: true,
      estimatedSize: 0,
      lastUsedAt: null,
      color: "#4ee0a3"
    });
  }

  function saveSegment() {
    if (!editing || !editing.name.trim()) return;
    setSegments((prev) => {
      const exists = prev.some((s) => s.id === editing.id);
      return exists ? prev.map((s) => (s.id === editing.id ? editing : s)) : [...prev, editing];
    });
    setEditing(null);
  }

  function addCriterion() {
    if (!editing) return;
    setEditing({ ...editing, criteria: [...editing.criteria, { field: "country", op: "equals", value: "" }] });
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            CRM · Segmentos
          </p>
          <h2 style={{ color: "var(--ink)" }}>Segmentación de huéspedes</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Define audiencias para campañas, ofertas personalizadas y exclusiones (p. ej. detractores fuera del marketing).
            Cada segmento se evalúa sobre el perfil + historial del huésped en tiempo real.
          </p>
        </div>
        <button type="button" className="primary" onClick={startNew}>+ Nuevo segmento</button>
      </header>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Segmentos definidos</span><span className="bo-status info">total</span></div>
          <div className="rev-kpi-value">{stats.total}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Activos</span><span className="bo-status ok">en uso</span></div>
          <div className="rev-kpi-value">{stats.active}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Audiencia agregada</span><span className="bo-status info">huéspedes</span></div>
          <div className="rev-kpi-value">{stats.reach.toLocaleString("es-ES")}</div>
        </article>
      </div>

      {editing ? (
        <article className="bo-card" style={{ background: "var(--surface-2, var(--surface))", border: "1px solid var(--accent)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>{segments.some((s) => s.id === editing.id) ? "Editar segmento" : "Nuevo segmento"}</h3>
            <button type="button" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Nombre<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>Color<input type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} /></label>
            <label style={{ gridColumn: "1 / -1" }}>Descripción
              <textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="bo-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--ink)" }}>Criterios (todos deben cumplirse)</strong>
              <button type="button" onClick={addCriterion}>+ Añadir criterio</button>
            </div>
            {editing.criteria.map((c, i) => (
              <div key={i} className="bo-row" style={{ gap: 6, marginTop: 6 }}>
                <select value={c.field} onChange={(e) => {
                  const next = [...editing.criteria];
                  next[i] = { ...c, field: e.target.value };
                  setEditing({ ...editing, criteria: next });
                }}>
                  {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <select value={c.op} onChange={(e) => {
                  const next = [...editing.criteria];
                  next[i] = { ...c, op: e.target.value as SegmentCriterion["op"] };
                  setEditing({ ...editing, criteria: next });
                }}>
                  <option value="equals">=</option>
                  <option value="in">∈ (en lista)</option>
                  <option value="gt">&gt;</option>
                  <option value="gte">≥</option>
                  <option value="lt">&lt;</option>
                  <option value="lte">≤</option>
                  <option value="between">entre</option>
                  <option value="contains">contiene</option>
                  <option value="exists">tiene valor</option>
                </select>
                <input
                  value={c.value}
                  onChange={(e) => {
                    const next = [...editing.criteria];
                    next[i] = { ...c, value: e.target.value };
                    setEditing({ ...editing, criteria: next });
                  }}
                  placeholder="Valor"
                  style={{ flex: "1 1 0%" }}
                />
                <button type="button" onClick={() => {
                  setEditing({ ...editing, criteria: editing.criteria.filter((_, j) => j !== i) });
                }} disabled={editing.criteria.length === 1}>×</button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button type="button" className="primary" onClick={saveSegment} disabled={!editing.name.trim()}>
              Guardar
            </button>
          </div>
        </article>
      ) : null}

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Segmentos definidos</h3>
          <span className="bo-chip">{segments.length}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
          {segments.map((s) => (
            <article key={s.id} className="bo-card" style={{ background: "var(--surface-2, var(--surface))", borderLeft: `4px solid ${s.color}` }}>
              <div className="bo-card-head">
                <div>
                  <strong style={{ color: "var(--ink)" }}>{s.name}</strong>
                  <p className="bo-muted" style={{ margin: "2px 0 0", fontSize: 11 }}>
                    {s.estimatedSize.toLocaleString("es-ES")} huéspedes · último uso {fmtDate(s.lastUsedAt)}
                  </p>
                </div>
                <span className={`bo-status ${s.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{s.active ? "activo" : "inactivo"}</span>
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-muted)", margin: "4px 0" }}>{s.description}</p>
              <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 6 }}>
                {s.criteria.map((c, i) => (
                  <span key={i}>
                    <code className="mono">{FIELDS.find((f) => f.value === c.field)?.label ?? c.field}</code>
                    {" "}{c.op}{" "}
                    <code className="mono">{c.value}</code>
                    {i < s.criteria.length - 1 ? " · " : ""}
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                <button type="button" onClick={() => setEditing(s)}>Editar</button>
                <button type="button" onClick={() => toggleActive(s.id)}>{s.active ? "Pausar" : "Activar"}</button>
              </div>
            </article>
          ))}
        </div>
      </article>
    </section>
  );
}
