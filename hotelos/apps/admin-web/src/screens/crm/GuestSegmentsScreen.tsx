// CRM · Segmentos de huéspedes — el corazón de las campañas y la
// personalización. Cada segmento es un conjunto de criterios sobre el perfil
// del huésped: nacionalidad, frecuencia, valor de vida, último viaje,
// satisfacción NPS… Persistido en el registro `crm_segment` del backend:
//
//   GET   /crm/segments      — lista real de segmentos de la organización
//   POST  /crm/segments      — crear { name, description, rulesJson }
//   PATCH /crm/segments/:id  — editar reglas / activar / pausar
//
// Esta UI guarda los criterios y el color dentro de `rulesJson`
// ({ criteria: [...], color }) y lee de forma defensiva reglas planas
// heredadas (p. ej. { minStays: 2 }) mostrándolas como criterios de igualdad.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createSegment, fetchSegments, updateSegment, type CrmSegment } from "../../services/crmApi";
import { EmptyState, ErrorState, LoadingBlock } from "../../components/States";
import { useToast } from "../../components/Toast";

type CriterionOp = "equals" | "in" | "gt" | "gte" | "lt" | "lte" | "between" | "contains" | "exists";

type SegmentCriterion = {
  field: string;
  op: CriterionOp;
  value: string;
};

type SegmentView = {
  id: string;
  name: string;
  description: string;
  criteria: SegmentCriterion[];
  active: boolean;
  color: string;
  createdAt: string;
};

type SegmentDraft = {
  /** null → segmento nuevo (POST); id → edición (PATCH). */
  id: string | null;
  name: string;
  description: string;
  color: string;
  criteria: SegmentCriterion[];
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

const OPS: CriterionOp[] = ["equals", "in", "gt", "gte", "lt", "lte", "between", "contains", "exists"];

const DEFAULT_COLOR = "#4ee0a3";

function emptyCriterion(): SegmentCriterion {
  return { field: "country", op: "equals", value: "" };
}

/**
 * Extrae criterios presentables desde rulesJson. Reconoce el formato de esta
 * UI ({ criteria: [{ field, op, value }] }) y degrada a pares clave/valor
 * para reglas planas guardadas por otras herramientas.
 */
function parseCriteria(rules: Record<string, unknown>): SegmentCriterion[] {
  const raw = rules["criteria"];
  if (Array.isArray(raw)) {
    const parsed: SegmentCriterion[] = [];
    for (const item of raw) {
      if (item && typeof item === "object") {
        const c = item as Record<string, unknown>;
        if (typeof c["field"] === "string") {
          const op = typeof c["op"] === "string" && (OPS as string[]).includes(c["op"]) ? (c["op"] as CriterionOp) : "equals";
          parsed.push({ field: c["field"], op, value: typeof c["value"] === "string" ? c["value"] : String(c["value"] ?? "") });
        }
      }
    }
    return parsed;
  }
  return Object.entries(rules)
    .filter(([key]) => key !== "criteria" && key !== "color")
    .map(([key, value]) => ({ field: key, op: "equals" as const, value: String(value ?? "") }));
}

function toView(record: CrmSegment): SegmentView {
  const rules = (record.rulesJson ?? {}) as Record<string, unknown>;
  const color = typeof rules["color"] === "string" && rules["color"].startsWith("#") ? rules["color"] : DEFAULT_COLOR;
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? "",
    criteria: parseCriteria(rules),
    active: record.active,
    color,
    createdAt: record.createdAt
  };
}

function cleanCriteria(criteria: SegmentCriterion[]): SegmentCriterion[] {
  return criteria
    .filter((c) => c.field.trim() !== "" && (c.op === "exists" || c.value.trim() !== ""))
    .map((c) => ({ field: c.field, op: c.op, value: c.value.trim() }));
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function GuestSegmentsScreen() {
  const { showToast } = useToast();
  const [segments, setSegments] = useState<SegmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SegmentDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<SegmentView[] | null> => {
    setError(null);
    try {
      const records = await fetchSegments();
      const views = records.map(toView);
      setSegments(views);
      return views;
    } catch (err) {
      setError(errMsg(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const total = segments.length;
    const active = segments.filter((s) => s.active).length;
    return { total, active, inactive: total - active };
  }, [segments]);

  function startNew() {
    setEditing({ id: null, name: "", description: "", color: DEFAULT_COLOR, criteria: [emptyCriterion()] });
  }

  function startEdit(segment: SegmentView) {
    setEditing({
      id: segment.id,
      name: segment.name,
      description: segment.description,
      color: segment.color,
      criteria: segment.criteria.length > 0 ? segment.criteria.map((c) => ({ ...c })) : [emptyCriterion()]
    });
  }

  async function saveSegment() {
    if (!editing || !editing.name.trim() || saving) return;
    const isEdit = editing.id !== null;
    const criteria = cleanCriteria(editing.criteria);
    const body = {
      name: editing.name.trim(),
      description: editing.description.trim() || undefined,
      rulesJson: { criteria, color: editing.color }
    };
    setSaving(true);
    try {
      if (isEdit && editing.id) {
        const editedId = editing.id;
        await updateSegment(editedId, body);
        const fresh = await load();
        const updated = fresh?.find((s) => s.id === editedId);
        const applied =
          updated !== undefined &&
          updated.name === body.name &&
          updated.description === (body.description ?? "") &&
          updated.color === editing.color &&
          JSON.stringify(updated.criteria) === JSON.stringify(criteria);
        if (applied) {
          showToast(`Segmento «${body.name}» actualizado.`, { variant: "success" });
        } else {
          showToast("La API aceptó la petición, pero el servidor aún no refleja los cambios en la lista.", { variant: "info" });
        }
      } else {
        const created = await createSegment(body);
        await load();
        showToast(`Segmento «${created.name}» creado.`, { variant: "success" });
      }
      setEditing(null);
    } catch (err) {
      showToast(`No se pudo guardar el segmento: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(segment: SegmentView) {
    if (togglingId) return;
    const next = !segment.active;
    setTogglingId(segment.id);
    try {
      await updateSegment(segment.id, { active: next });
      const fresh = await load();
      const updated = fresh?.find((s) => s.id === segment.id);
      if (updated?.active === next) {
        showToast(next ? `Segmento «${segment.name}» activado.` : `Segmento «${segment.name}» pausado.`, { variant: "success" });
      } else {
        showToast("La API aceptó la petición, pero el servidor aún no refleja el cambio de estado.", { variant: "info" });
      }
    } catch (err) {
      showToast(`No se pudo cambiar el estado de «${segment.name}»: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setTogglingId(null);
    }
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
        <button type="button" className="primary" onClick={startNew} disabled={loading}>+ Nuevo segmento</button>
      </header>

      {loading ? (
        <LoadingBlock label="Cargando segmentos…" />
      ) : error ? (
        <ErrorState
          title="No se pudieron cargar los segmentos"
          message={error}
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      ) : (
        <>
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
              <div className="rev-kpi-head"><span className="rev-kpi-label">Inactivos</span><span className="bo-status info">pausados</span></div>
              <div className="rev-kpi-value">{stats.inactive}</div>
            </article>
          </div>

          {editing ? (
            <article className="bo-card" style={{ background: "var(--surface-2, var(--surface))", border: "1px solid var(--accent)" }}>
              <div className="bo-card-head">
                <h3 style={{ color: "var(--ink)" }}>{editing.id !== null ? "Editar segmento" : "Nuevo segmento"}</h3>
                <button type="button" onClick={() => setEditing(null)} disabled={saving}>Cancelar</button>
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
                  <button type="button" onClick={() => setEditing({ ...editing, criteria: [...editing.criteria, emptyCriterion()] })}>
                    + Añadir criterio
                  </button>
                </div>
                {editing.criteria.map((c, i) => (
                  <div key={i} className="bo-row" style={{ gap: 6, marginTop: 6 }}>
                    <select value={c.field} onChange={(e) => {
                      const next = [...editing.criteria];
                      next[i] = { ...c, field: e.target.value };
                      setEditing({ ...editing, criteria: next });
                    }}>
                      {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      {!FIELDS.some((f) => f.value === c.field) ? <option value={c.field}>{c.field}</option> : null}
                    </select>
                    <select value={c.op} onChange={(e) => {
                      const next = [...editing.criteria];
                      next[i] = { ...c, op: e.target.value as CriterionOp };
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
                <button type="button" className="primary" onClick={() => void saveSegment()} disabled={!editing.name.trim() || saving}>
                  {saving ? "Guardando…" : "Guardar"}
                </button>
              </div>
            </article>
          ) : null}

          <article className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head">
              <h3 style={{ color: "var(--ink)" }}>Segmentos definidos</h3>
              <span className="bo-chip">{segments.length}</span>
            </div>
            {segments.length === 0 ? (
              <EmptyState
                title="Sin segmentos todavía"
                message="Crea tu primer segmento para definir audiencias de campañas y exclusiones de marketing."
                actions={<button type="button" className="primary" onClick={startNew}>+ Nuevo segmento</button>}
              />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
                {segments.map((s) => (
                  <article key={s.id} className="bo-card" style={{ background: "var(--surface-2, var(--surface))", borderLeft: `4px solid ${s.color}` }}>
                    <div className="bo-card-head">
                      <div>
                        <strong style={{ color: "var(--ink)" }}>{s.name}</strong>
                        <p className="bo-muted" style={{ margin: "2px 0 0", fontSize: 11 }}>
                          {s.criteria.length} criterio{s.criteria.length === 1 ? "" : "s"} · creado {fmtDate(s.createdAt)}
                        </p>
                      </div>
                      <span className={`bo-status ${s.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{s.active ? "activo" : "inactivo"}</span>
                    </div>
                    {s.description ? <p style={{ fontSize: 12, color: "var(--ink-muted)", margin: "4px 0" }}>{s.description}</p> : null}
                    <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 6 }}>
                      {s.criteria.length === 0 ? (
                        <span>Sin criterios definidos</span>
                      ) : (
                        s.criteria.map((c, i) => (
                          <span key={i}>
                            <code className="mono">{FIELDS.find((f) => f.value === c.field)?.label ?? c.field}</code>
                            {" "}{c.op}{" "}
                            <code className="mono">{c.value}</code>
                            {i < s.criteria.length - 1 ? " · " : ""}
                          </span>
                        ))
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                      <button type="button" onClick={() => startEdit(s)}>Editar</button>
                      <button type="button" onClick={() => void toggleActive(s)} disabled={togglingId === s.id}>
                        {togglingId === s.id ? "Aplicando…" : s.active ? "Pausar" : "Activar"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}
