// Rate Plans (planes tarifarios) — BAR + variantes derivadas.
//
// Modelo existente: `RatePlan` (packages/database/prisma/schema.prisma) con
// `parentRatePlanId` + `derivationJson` para variantes (% o absoluto).
// Restricciones (MLOS, max LOS, CTA, CTD) viven en `RestrictionDay` por día,
// pero esta UI expone el "perfil por defecto" que el motor aplicará al crear
// días sin override manual.
//
// TODO(backend): no existe todavía endpoint REST
// `/properties/:propertyId/rate-plans` ni `PATCH /rate-plans/:id`. La UI
// detecta el 404 y cae a un set de demo data (BAR + 3 variantes típicas)
// para que el cliente pueda ver el flow y aprobar el diseño antes de
// implementar el backend.

import { useEffect, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  fetchRatePlans, createRatePlan,
  RatePlansNotImplementedError,
  type RatePlan, type RatePlanType, type RestrictionPreset, type CreateRatePlanPayload
} from "../../services/ratePlansApi";
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";
import { useToast } from "../../components/Toast";

const PROPERTY_ID = getActivePropertyId();

const TYPE_LABEL: Record<string, string> = {
  BAR: "BAR · Best Available Rate (base)",
  non_refundable: "No reembolsable",
  flexible: "Flexible",
  corporate: "Corporate",
  package: "Paquete (PKG)",
  promo: "Promocional",
  weekend: "Weekend"
};

const TYPE_BADGE_COLOR: Record<string, "ok" | "info" | "warn"> = {
  BAR: "ok",
  non_refundable: "warn",
  flexible: "info",
  corporate: "info",
  package: "info",
  promo: "info"
};

const MEAL_PLAN_LABEL: Record<string, string> = {
  RO: "Sólo alojamiento (RO)",
  BB: "Bed & Breakfast (BB)",
  HB: "Media pensión (HB)",
  FB: "Pensión completa (FB)",
  AI: "Todo incluido (AI)"
};

// Demo seed que la UI muestra cuando el endpoint aún no existe.
const DEMO_RATE_PLANS: RatePlan[] = [
  {
    id: "rp_demo_bar",
    propertyId: PROPERTY_ID,
    code: "BAR",
    name: "BAR — Best Available Rate",
    ratePlanType: "BAR",
    parentRatePlanId: null,
    derivationJson: {},
    cancellationPolicyId: null,
    mealPlan: "BB",
    active: true,
    createdAt: new Date().toISOString(),
    restrictions: { mlos: 1, maxLos: 30, cta: false, ctd: false }
  },
  {
    id: "rp_demo_nref",
    propertyId: PROPERTY_ID,
    code: "NREF",
    name: "Non-refundable — 10% off BAR",
    ratePlanType: "non_refundable",
    parentRatePlanId: "rp_demo_bar",
    derivationJson: { type: "percent", value: -10 },
    cancellationPolicyId: null,
    mealPlan: "BB",
    active: true,
    createdAt: new Date().toISOString(),
    restrictions: { mlos: 2, maxLos: null, cta: false, ctd: false }
  },
  {
    id: "rp_demo_flex",
    propertyId: PROPERTY_ID,
    code: "FLEX",
    name: "Flexible — +5% BAR · cancelación 24h",
    ratePlanType: "flexible",
    parentRatePlanId: "rp_demo_bar",
    derivationJson: { type: "percent", value: 5 },
    cancellationPolicyId: null,
    mealPlan: "BB",
    active: true,
    createdAt: new Date().toISOString(),
    restrictions: { mlos: 1, maxLos: null, cta: false, ctd: false }
  },
  {
    id: "rp_demo_corp",
    propertyId: PROPERTY_ID,
    code: "CORP",
    name: "Corporate — -15% BAR · LOS≥2",
    ratePlanType: "corporate",
    parentRatePlanId: "rp_demo_bar",
    derivationJson: { type: "percent", value: -15 },
    cancellationPolicyId: null,
    mealPlan: "BB",
    active: true,
    createdAt: new Date().toISOString(),
    restrictions: { mlos: 2, maxLos: null, cta: true, ctd: false }
  }
];

function fmtDerivation(plan: RatePlan): string {
  if (!plan.parentRatePlanId) return "Base";
  const d = plan.derivationJson;
  if (d?.type === "percent" && typeof d.value === "number") {
    const sign = d.value > 0 ? "+" : "";
    return `${sign}${d.value}% sobre BAR`;
  }
  if (d?.type === "absolute" && typeof d.value === "number") {
    const sign = d.value > 0 ? "+" : "";
    return `${sign}${d.value} € sobre BAR`;
  }
  return "Derivado";
}

type Draft = {
  code: string;
  name: string;
  ratePlanType: string;
  parentRatePlanId: string;
  derivationType: "percent" | "absolute" | "none";
  derivationValue: string;
  mealPlan: string;
  active: boolean;
  mlos: string;
  maxLos: string;
  cta: boolean;
  ctd: boolean;
};

function emptyDraft(): Draft {
  return {
    code: "",
    name: "",
    ratePlanType: "flexible",
    parentRatePlanId: "",
    derivationType: "percent",
    derivationValue: "",
    mealPlan: "BB",
    active: true,
    mlos: "1",
    maxLos: "",
    cta: false,
    ctd: false
  };
}

export function RatePlansScreen() {
  const { showToast } = useToast();

  const [plans, setPlans] = useState<RatePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingDemo, setUsingDemo] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());

  async function load() {
    setLoading(true);
    setErrorBanner(null);
    try {
      const items = await fetchRatePlans();
      setPlans(items);
      setUsingDemo(false);
    } catch (e) {
      // FIX 7: solo entramos en modo demo cuando el endpoint NO está implementado
      // (404). Si es un 500/network/timeout no caemos a demo: dejamos el listado
      // anterior y avisamos del error real para que el operador no confunda
      // datos demo con datos reales temporalmente caídos.
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RatePlansNotImplementedError) {
        setPlans(DEMO_RATE_PLANS);
        setUsingDemo(true);
        setErrorBanner(`Endpoint /properties/:propertyId/rate-plans aún no implementado (${message}). Mostrando datos DEMO — los cambios no se persisten.`);
      } else {
        setUsingDemo(false);
        setErrorBanner(`No se pudieron cargar los planes tarifarios: ${message}. Reintenta o contacta a soporte.`);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const parentOptions = plans.filter((p) => p.parentRatePlanId === null);
  const parentName = (id: string | null): string => {
    if (!id) return "—";
    const p = plans.find((x) => x.id === id);
    return p ? `${p.code} — ${p.name}` : id;
  };

  function openCreate() {
    setDraft(emptyDraft());
    setShowForm(true);
    setMsg(null);
  }

  async function save() {
    if (!draft.code.trim() || !draft.name.trim()) { setMsg("Código y nombre son obligatorios."); return; }
    // FIX 8: validar formato del código antes de enviarlo al backend.
    // El backend espera UPPERCASE alfanumérico (`_` y `-` permitidos) entre 2 y 20 chars.
    // Aceptar cualquier cosa rompía constraints en el insert.
    const normalizedCode = draft.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,20}$/.test(normalizedCode)) {
      setMsg("Código inválido. Usa 2-20 caracteres en MAYÚSCULAS, dígitos, '_' o '-'. Ej. BAR, NREF, FLEX_24.");
      return;
    }
    if (draft.ratePlanType !== "BAR" && !draft.parentRatePlanId) {
      setMsg("Las variantes deben tener un plan padre (BAR).");
      return;
    }
    if (draft.derivationType !== "none" && !draft.derivationValue.trim()) {
      setMsg("Indica el valor de la derivación, o cambia el tipo a 'sin derivación'.");
      return;
    }

    // FIX 9: validar rango/NaN del valor de derivación antes de aplicar Number().
    // PCT: [-100, 500] (descuento total o markup 5x). ABS: >= 0 (no admitimos
    // ingresos negativos como "derivación" — eso sería un descuento absoluto
    // y se modela como valor negativo en una sub-tarifa, no como BAR negativa).
    let derivationValueNum: number | undefined;
    if (draft.derivationType !== "none") {
      derivationValueNum = Number(draft.derivationValue);
      if (Number.isNaN(derivationValueNum) || !Number.isFinite(derivationValueNum)) {
        setMsg("El valor de la derivación debe ser un número válido.");
        return;
      }
      if (draft.derivationType === "percent" && (derivationValueNum < -100 || derivationValueNum > 500)) {
        setMsg("El porcentaje de derivación debe estar entre -100% y +500%.");
        return;
      }
      if (draft.derivationType === "absolute" && derivationValueNum < -10000) {
        setMsg("El valor absoluto de derivación es demasiado bajo (mínimo -10000 €).");
        return;
      }
      if (draft.derivationType === "absolute" && derivationValueNum > 10000) {
        setMsg("El valor absoluto de derivación es demasiado alto (máximo +10000 €).");
        return;
      }
    }

    const restrictions: RestrictionPreset = {
      mlos: draft.mlos ? Number(draft.mlos) : null,
      maxLos: draft.maxLos ? Number(draft.maxLos) : null,
      cta: draft.cta,
      ctd: draft.ctd
    };
    const derivation: RatePlan["derivationJson"] = draft.derivationType === "none" || derivationValueNum === undefined
      ? {}
      : { type: draft.derivationType, value: derivationValueNum };

    const payload: CreateRatePlanPayload = {
      code: normalizedCode,
      name: draft.name.trim(),
      ratePlanType: draft.ratePlanType as RatePlanType,
      parentRatePlanId: draft.ratePlanType === "BAR" ? null : (draft.parentRatePlanId || null),
      derivationJson: derivation,
      cancellationPolicyId: null,
      mealPlan: draft.mealPlan || null,
      active: draft.active,
      restrictions
    };

    setBusy(true); setMsg(null);
    try {
      if (usingDemo) {
        // En modo demo, agregamos localmente sin llamar al backend (404).
        const fakeId = `rp_demo_${Date.now()}`;
        const created: RatePlan = {
          ...payload,
          id: fakeId,
          propertyId: PROPERTY_ID,
          createdAt: new Date().toISOString()
        };
        setPlans((prev) => [...prev, created]);
        setMsg(`Plan «${draft.name}» creado en demo. Cuando se implemente el endpoint, esta UI lo persistirá real.`);
        showToast(`Plan «${draft.name}» creado (demo)`, { variant: "info" });
      } else {
        await createRatePlan(payload);
        setMsg(`Plan «${draft.name}» creado.`);
        showToast(`Plan «${draft.name}» creado`, { variant: "success" });
        await load();
      }
      setShowForm(false);
      setDraft(emptyDraft());
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo crear el plan.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const kpis = {
    total: plans.length,
    active: plans.filter((p) => p.active).length,
    base: plans.filter((p) => !p.parentRatePlanId).length,
    variants: plans.filter((p) => !!p.parentRatePlanId).length
  };

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Comercial · Tarifas</p>
          <h2 style={{ color: "var(--ink)" }}>Planes tarifarios (Rate Plans)</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            BAR como tarifa pública base, y variantes derivadas (% o absoluto) con sus propias
            restricciones (MLOS, max LOS, CTA, CTD). El motor calcula el precio diario aplicando
            la derivación sobre la BAR del día y respetando las restricciones por canal y tipo de habitación.
          </p>
        </div>
        <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={load} disabled={loading || busy}>↻ Actualizar</button>
          <button type="button" className="primary" onClick={openCreate} disabled={busy}>+ Nuevo plan</button>
        </div>
      </header>

      {errorBanner ? (
        <p role="alert" className="bo-status warn" style={{ textTransform: "none" }}>
          {errorBanner}
        </p>
      ) : null}
      {msg ? <p role="status" aria-live="polite" className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Planes</span><span className="bo-status info">total</span></div>
          <div className="rev-kpi-value">{kpis.total}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Activos</span><span className="bo-status ok">a la venta</span></div>
          <div className="rev-kpi-value">{kpis.active}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tarifas base</span><span className="bo-status info">BAR</span></div>
          <div className="rev-kpi-value">{kpis.base}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Variantes derivadas</span><span className="bo-status info">child</span></div>
          <div className="rev-kpi-value">{kpis.variants}</div>
        </article>
      </div>

      {loading && plans.length === 0 ? (
        <LoadingBlock label="Cargando planes tarifarios…" />
      ) : plans.length === 0 ? (
        <EmptyState
          title="Sin planes tarifarios"
          message="Empieza por crear una BAR (base) y luego derivar variantes como Non-refundable o Corporate."
          actions={<button type="button" className="primary" onClick={openCreate}>+ Nuevo plan</button>}
        />
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Plan padre</th>
                <th>Derivación</th>
                <th>Régimen</th>
                <th>MLOS</th>
                <th>Max LOS</th>
                <th>CTA</th>
                <th>CTD</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const isBase = !p.parentRatePlanId;
                const typeColor = TYPE_BADGE_COLOR[p.ratePlanType] ?? "info";
                const r = p.restrictions ?? {};
                return (
                  <tr key={p.id} style={isBase ? { background: "var(--surface-alt, rgba(13, 138, 95, 0.04))" } : undefined}>
                    <td className="mono"><strong>{p.code}</strong></td>
                    <td>{p.name}</td>
                    <td>
                      <span className={`bo-status ${typeColor}`} style={{ fontSize: 10 }}>
                        {TYPE_LABEL[p.ratePlanType] ?? p.ratePlanType}
                      </span>
                    </td>
                    <td className="bo-muted">{parentName(p.parentRatePlanId)}</td>
                    <td><strong>{fmtDerivation(p)}</strong></td>
                    <td>{p.mealPlan ? (MEAL_PLAN_LABEL[p.mealPlan] ?? p.mealPlan) : <span className="bo-muted">—</span>}</td>
                    <td>{r.mlos != null ? `${r.mlos} n.` : <span className="bo-muted">—</span>}</td>
                    <td>{r.maxLos != null ? `${r.maxLos} n.` : <span className="bo-muted">—</span>}</td>
                    <td>{r.cta ? <span className="bo-status warn" style={{ fontSize: 10 }}>sí</span> : <span className="bo-muted">—</span>}</td>
                    <td>{r.ctd ? <span className="bo-status warn" style={{ fontSize: 10 }}>sí</span> : <span className="bo-muted">—</span>}</td>
                    <td><span className={`bo-status ${p.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{p.active ? "activo" : "inactivo"}</span></td>
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
            <h3 style={{ color: "var(--ink)", margin: 0 }}>Nuevo plan tarifario</h3>
            <button type="button" onClick={() => setShowForm(false)} aria-label="Cerrar formulario de nuevo plan tarifario" title="Cerrar">✕</button>
          </div>
          <div className="bo-grid two" style={{ gap: 10 }}>
            <label className="bo-form-field">
              <span>Code *</span>
              <input value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value.toUpperCase() }))} placeholder="BAR, NREF, FLEX, CORP…" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Nombre *</span>
              <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Ej. Non-refundable -10% BAR" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Tipo *</span>
              <select value={draft.ratePlanType} onChange={(e) => setDraft((d) => ({ ...d, ratePlanType: e.target.value }))} disabled={busy}>
                {Object.keys(TYPE_LABEL).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Plan padre {draft.ratePlanType !== "BAR" ? "*" : "(opcional)"}</span>
              <select value={draft.parentRatePlanId} onChange={(e) => setDraft((d) => ({ ...d, parentRatePlanId: e.target.value }))} disabled={busy || draft.ratePlanType === "BAR"}>
                <option value="">{draft.ratePlanType === "BAR" ? "Sin padre (base)" : "Selecciona BAR padre…"}</option>
                {parentOptions.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Tipo de derivación</span>
              <select value={draft.derivationType} onChange={(e) => setDraft((d) => ({ ...d, derivationType: e.target.value as "percent" | "absolute" | "none" }))} disabled={busy || draft.ratePlanType === "BAR"}>
                <option value="percent">% sobre BAR (ej. -10)</option>
                <option value="absolute">€ absoluto (ej. +5)</option>
                <option value="none">Sin derivación</option>
              </select>
            </label>
            <label className="bo-form-field">
              <span>Valor de derivación</span>
              <input type="number" step={0.01} value={draft.derivationValue} onChange={(e) => setDraft((d) => ({ ...d, derivationValue: e.target.value }))} placeholder="-10" disabled={busy || draft.ratePlanType === "BAR" || draft.derivationType === "none"} />
            </label>
            <label className="bo-form-field">
              <span>Régimen (meal plan)</span>
              <select value={draft.mealPlan} onChange={(e) => setDraft((d) => ({ ...d, mealPlan: e.target.value }))} disabled={busy}>
                {Object.keys(MEAL_PLAN_LABEL).map((k) => <option key={k} value={k}>{MEAL_PLAN_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Activo</span>
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} disabled={busy} />
            </label>
          </div>

          <article className="bo-card" style={{ background: "var(--surface-alt, var(--surface))", marginTop: 12 }}>
            <div className="bo-card-head" style={{ marginBottom: 6 }}>
              <div>
                <h4 style={{ margin: 0, color: "var(--ink)" }}>Restricciones inline</h4>
                <p className="bo-muted" style={{ margin: "4px 0 0 0", fontSize: 12, textTransform: "none" }}>
                  Perfil por defecto que el motor aplica al crear días sin override. Editable por día desde el calendario de restricciones.
                </p>
              </div>
            </div>
            <div className="bo-grid two" style={{ gap: 10 }}>
              <label className="bo-form-field">
                <span>MLOS (min length of stay)</span>
                <input type="number" min={0} step={1} value={draft.mlos} onChange={(e) => setDraft((d) => ({ ...d, mlos: e.target.value }))} placeholder="1" disabled={busy} />
              </label>
              <label className="bo-form-field">
                <span>Max LOS</span>
                <input type="number" min={0} step={1} value={draft.maxLos} onChange={(e) => setDraft((d) => ({ ...d, maxLos: e.target.value }))} placeholder="30" disabled={busy} />
              </label>
              <label className="bo-form-field">
                <span>CTA (closed to arrival)</span>
                <input type="checkbox" checked={draft.cta} onChange={(e) => setDraft((d) => ({ ...d, cta: e.target.checked }))} disabled={busy} />
              </label>
              <label className="bo-form-field">
                <span>CTD (closed to departure)</span>
                <input type="checkbox" checked={draft.ctd} onChange={(e) => setDraft((d) => ({ ...d, ctd: e.target.checked }))} disabled={busy} />
              </label>
            </div>
          </article>

          <div className="bo-actions" style={{ marginTop: 10 }}>
            <button type="button" className="primary" onClick={save} disabled={busy}>Crear plan</button>
            <button type="button" onClick={() => setShowForm(false)} disabled={busy}>Cancelar</button>
          </div>
        </article>
      ) : null}
    </section>
  );
}
