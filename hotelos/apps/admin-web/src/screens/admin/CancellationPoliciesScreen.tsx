import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  createCancellationPolicy, updateCancellationPolicy, deleteCancellationPolicy,
  type CancellationPolicy, type PenaltyType
} from "../../services/cancellationApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";

const PROPERTY_ID = getActivePropertyId();

const PENALTY_LABEL: Record<PenaltyType, string> = {
  first_night: "Primera noche",
  percent: "Porcentaje del total",
  fixed_amount: "Importe fijo (€)",
  all_stay: "Estancia completa",
  none: "Sin cargo"
};

// Sliding scale = ventanas progresivas: cuánto más cerca del check-in, mayor
// la penalización. Se modela como array de pares {hoursBefore, penaltyPct}.
// Industria estándar Booking / Expedia / Mews para políticas Semi-Flexible.
//
// TODO(backend): el modelo actual sólo soporta un único par
// (freeCancelHours + penaltyType/Value). Cuando el backend exponga
// `slidingScale: Array<{hoursBefore, penaltyPct}>` en `CancellationPolicy`,
// el form ya está preparado: editamos derivationJson en `description` como
// JSON para mostrar las ventanas en la tabla como chips.
type SlidingWindow = { hoursBefore: number; penaltyPct: number };

type Draft = {
  code: string; name: string; description: string;
  freeCancelHours: number;
  penaltyType: PenaltyType; penaltyValue: string;
  noShowPenaltyType: PenaltyType; noShowPenaltyValue: string;
  slidingScale: SlidingWindow[];
  active: boolean;
};

const SLIDING_PREFIX = "::SLIDING::";

function parseSliding(description: string | null): { sliding: SlidingWindow[]; clean: string } {
  if (!description) return { sliding: [], clean: "" };
  const idx = description.indexOf(SLIDING_PREFIX);
  if (idx < 0) return { sliding: [], clean: description };
  const clean = description.slice(0, idx).trim();
  const raw = description.slice(idx + SLIDING_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as SlidingWindow[];
    if (Array.isArray(parsed)) return { sliding: parsed, clean };
  } catch { /* ignore */ }
  return { sliding: [], clean };
}

function encodeSliding(clean: string, sliding: SlidingWindow[]): string | undefined {
  const cleanTrim = clean.trim();
  if (sliding.length === 0) return cleanTrim || undefined;
  return `${cleanTrim ? cleanTrim + "\n" : ""}${SLIDING_PREFIX}${JSON.stringify(sliding)}`;
}

function emptyDraft(): Draft {
  return {
    code: "", name: "", description: "", freeCancelHours: 48,
    penaltyType: "first_night", penaltyValue: "",
    noShowPenaltyType: "first_night", noShowPenaltyValue: "",
    slidingScale: [],
    active: true
  };
}

export function CancellationPoliciesScreen() {
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<{ items: CancellationPolicy[] }>(
    `/properties/${PROPERTY_ID}/cancellation-policies`,
    { pollIntervalMs: 60000 }
  );
  const policies = data?.items ?? [];

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<CancellationPolicy | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [pendingDelete, setPendingDelete] = useState<CancellationPolicy | null>(null);

  function openCreate() {
    setEditing(null);
    setDraft(emptyDraft());
    setShowForm(true);
    setMsg(null);
  }
  function openEdit(p: CancellationPolicy) {
    const { sliding, clean } = parseSliding(p.description ?? null);
    setEditing(p);
    setDraft({
      code: p.code, name: p.name, description: clean,
      freeCancelHours: p.freeCancelHours,
      penaltyType: p.penaltyType, penaltyValue: p.penaltyValue?.toString() ?? "",
      noShowPenaltyType: p.noShowPenaltyType, noShowPenaltyValue: p.noShowPenaltyValue?.toString() ?? "",
      slidingScale: sliding,
      active: p.active
    });
    setShowForm(true);
    setMsg(null);
  }

  function addWindow() {
    setDraft((d) => ({
      ...d,
      slidingScale: [...d.slidingScale, { hoursBefore: 24, penaltyPct: 50 }].sort((a, b) => b.hoursBefore - a.hoursBefore)
    }));
  }
  function removeWindow(index: number) {
    setDraft((d) => ({ ...d, slidingScale: d.slidingScale.filter((_, i) => i !== index) }));
  }
  function updateWindow(index: number, patch: Partial<SlidingWindow>) {
    setDraft((d) => ({
      ...d,
      slidingScale: d.slidingScale.map((w, i) => (i === index ? { ...w, ...patch } : w))
    }));
  }

  async function save() {
    if (!draft.code.trim() || !draft.name.trim()) { setMsg("Code y nombre son obligatorios."); return; }
    // Validar sliding: ordenadas decreciente por hours, penaltyPct 0-100
    for (const w of draft.slidingScale) {
      if (w.hoursBefore < 0) { setMsg("Las horas en la sliding scale no pueden ser negativas."); return; }
      if (w.penaltyPct < 0 || w.penaltyPct > 100) { setMsg("La penalización debe estar entre 0 y 100%."); return; }
    }
    setBusy(true); setMsg(null);
    try {
      const payload = {
        code: draft.code.trim(), name: draft.name.trim(),
        description: encodeSliding(draft.description, draft.slidingScale),
        freeCancelHours: Number(draft.freeCancelHours) || 0,
        penaltyType: draft.penaltyType,
        penaltyValue: draft.penaltyValue ? Number(draft.penaltyValue) : null,
        noShowPenaltyType: draft.noShowPenaltyType,
        noShowPenaltyValue: draft.noShowPenaltyValue ? Number(draft.noShowPenaltyValue) : null,
        active: draft.active
      };
      if (editing) await updateCancellationPolicy(editing.id, payload);
      else await createCancellationPolicy(payload);
      setMsg(editing ? "Política actualizada." : "Política creada.");
      showToast(editing ? `Política «${draft.name}» actualizada` : `Política «${draft.name}» creada`, { variant: "success" });
      setShowForm(false); setEditing(null);
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo guardar.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally { setBusy(false); }
  }

  async function confirmRemove() {
    const p = pendingDelete;
    if (!p) return;
    setPendingDelete(null);
    setBusy(true); setMsg(null);
    try {
      await deleteCancellationPolicy(p.id);
      setMsg("Política eliminada.");
      showToast(`Política "${p.name}" eliminada`, { variant: "success" });
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo eliminar.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally { setBusy(false); }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Comercial · Políticas</p>
          <h2 style={{ color: "var(--ink)" }}>Políticas de cancelación</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Define la ventana de cancelación gratuita, la penalización aplicable y opcionalmente una
            <strong> sliding scale</strong> (penalizaciones progresivas: cuánto más cerca del check-in, mayor el cargo).
            El motor postea el cargo automáticamente al folio al cancelar o durante el Night Audit.
          </p>
        </div>
        <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
          <button type="button" className="primary" onClick={openCreate} disabled={busy}>+ Nueva política</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {loading && policies.length === 0 ? (
        <LoadingBlock label="Cargando políticas…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={refresh} />
      ) : policies.length === 0 ? (
        <EmptyState title="Sin políticas" message="Crea la primera política de cancelación para empezar a aplicarla en reservas." />
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Code</th><th>Nombre</th><th>Cancelación gratuita</th><th>Sliding scale</th><th>No-show</th><th>Activa</th><th></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                const { sliding } = parseSliding(p.description ?? null);
                return (
                  <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => openEdit(p)}>
                    <td className="mono"><strong>{p.code}</strong></td>
                    <td>{p.name}</td>
                    <td>{p.freeCancelHours > 0 ? `${p.freeCancelHours} h antes` : <span className="bo-status warn" style={{ fontSize: 10 }}>No reembolsable</span>}</td>
                    <td>
                      {sliding.length === 0 ? (
                        <span className="bo-muted" style={{ fontSize: 12 }}>
                          {PENALTY_LABEL[p.penaltyType]}{p.penaltyValue != null ? ` (${p.penaltyValue}${p.penaltyType === "percent" ? "%" : "€"})` : ""}
                        </span>
                      ) : (
                        <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {sliding.map((w, i) => (
                            <span key={i} className="bo-chip" style={{ fontSize: 11 }}>
                              T−{w.hoursBefore}h · {w.penaltyPct}%
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td>
                      {PENALTY_LABEL[p.noShowPenaltyType]}
                      {p.noShowPenaltyValue != null ? ` (${p.noShowPenaltyValue}${p.noShowPenaltyType === "percent" ? "%" : "€"})` : ""}
                    </td>
                    <td><span className={`bo-status ${p.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{p.active ? "sí" : "no"}</span></td>
                    <td onClick={(e) => { e.stopPropagation(); setPendingDelete(p); }}><button type="button" className="bo-link" disabled={busy}>Eliminar</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>{editing ? `Editar «${editing.name}»` : "Nueva política"}</h3>
            <button type="button" onClick={() => { setShowForm(false); setEditing(null); }}>✕</button>
          </div>
          <div className="bo-grid two" style={{ gap: 10 }}>
            <label className="bo-form-field">
              <span>Code *</span>
              <input value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))} placeholder="FLEX, SEMI, NREF…" disabled={busy || !!editing} />
            </label>
            <label className="bo-form-field">
              <span>Nombre *</span>
              <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} disabled={busy} />
            </label>
            <label className="bo-form-field" style={{ gridColumn: "1 / -1" }}>
              <span>Descripción</span>
              <input value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Horas gratis antes de la llegada</span>
              <input type="number" min={0} value={draft.freeCancelHours} onChange={(e) => setDraft((d) => ({ ...d, freeCancelHours: Number(e.target.value) }))} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Activa</span>
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Penalización por cancelación (fallback)</span>
              <select value={draft.penaltyType} onChange={(e) => setDraft((d) => ({ ...d, penaltyType: e.target.value as PenaltyType }))} disabled={busy}>
                {(Object.keys(PENALTY_LABEL) as PenaltyType[]).map((t) => <option key={t} value={t}>{PENALTY_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Valor (si % o €)</span>
              <input value={draft.penaltyValue} onChange={(e) => setDraft((d) => ({ ...d, penaltyValue: e.target.value }))} placeholder="50" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Penalización por no-show</span>
              <select value={draft.noShowPenaltyType} onChange={(e) => setDraft((d) => ({ ...d, noShowPenaltyType: e.target.value as PenaltyType }))} disabled={busy}>
                {(Object.keys(PENALTY_LABEL) as PenaltyType[]).map((t) => <option key={t} value={t}>{PENALTY_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Valor (si % o €)</span>
              <input value={draft.noShowPenaltyValue} onChange={(e) => setDraft((d) => ({ ...d, noShowPenaltyValue: e.target.value }))} placeholder="50" disabled={busy} />
            </label>
          </div>

          {/* Sliding scale editor */}
          <article className="bo-card" style={{ background: "var(--surface-alt, var(--surface))", marginTop: 12 }}>
            <div className="bo-card-head" style={{ marginBottom: 6 }}>
              <div>
                <h4 style={{ margin: 0, color: "var(--ink)" }}>Sliding scale (opcional)</h4>
                <p className="bo-muted" style={{ margin: "4px 0 0 0", fontSize: 12, textTransform: "none" }}>
                  Penalizaciones progresivas según se acerca la llegada. Ej. T−72h · 25%, T−48h · 50%, T−24h · 100%.
                  Si está vacío, se usa el fallback de arriba.
                </p>
              </div>
              <button type="button" onClick={addWindow} disabled={busy}>+ Añadir ventana</button>
            </div>
            {draft.slidingScale.length === 0 ? (
              <p className="bo-muted" style={{ fontSize: 12, margin: 0, fontStyle: "italic" }}>
                Sin ventanas. Pulsa <strong>+ Añadir ventana</strong> para definir penalizaciones por tramo.
              </p>
            ) : (
              <div className="bo-stack" style={{ gap: 6 }}>
                {draft.slidingScale.map((w, i) => (
                  <div key={i} className="bo-row" style={{ gap: 8, alignItems: "center" }}>
                    <span className="bo-muted" style={{ fontSize: 12, minWidth: 50 }}>T−</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={w.hoursBefore}
                      onChange={(e) => updateWindow(i, { hoursBefore: Number(e.target.value) })}
                      disabled={busy}
                      style={{ width: 80 }}
                    />
                    <span className="bo-muted" style={{ fontSize: 12 }}>h →</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={w.penaltyPct}
                      onChange={(e) => updateWindow(i, { penaltyPct: Number(e.target.value) })}
                      disabled={busy}
                      style={{ width: 80 }}
                    />
                    <span className="bo-muted" style={{ fontSize: 12 }}>%</span>
                    <button type="button" className="bo-link" onClick={() => removeWindow(i)} disabled={busy}>Eliminar</button>
                  </div>
                ))}
              </div>
            )}
          </article>

          <div className="bo-actions" style={{ marginTop: 10 }}>
            <button type="button" className="primary" onClick={save} disabled={busy}>{editing ? "Guardar cambios" : "Crear política"}</button>
            <button type="button" onClick={() => { setShowForm(false); setEditing(null); }} disabled={busy}>Cancelar</button>
          </div>
        </article>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `¿Eliminar la política «${pendingDelete.name}»?` : ""}
        description="Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        variant="danger"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
