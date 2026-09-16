// Planes de tarifas — Revenue › Planes de tarifas (/revenue/planes, standalone).
// Cocoa 22 · ola 5 · lote 5-C (migrated from the legacy `.bo-*` screen).
//
// BAR (public base rate) plus its derived variants (percent or absolute) and
// the default stay restrictions (min/max length of stay, closed to arrival or
// departure) the engine applies to days without a manual override.
//
// Model: `RatePlan` (packages/database/prisma/schema.prisma) with
// `parentRatePlanId` + `derivationJson`; restrictions live per day in
// `RestrictionDay`, this screen edits the default profile.
//
// Backend: `GET/POST /properties/:propertyId/rate-plans` (ratePlansApi). If an
// older API still answers 404 the screen shows an honest error state — never
// sample data (Tanda 5: no demo data in front of the hotelier).
//
// Layout: CocoaPage → CocoaKpiStrip (planes · activos · base · derivadas) →
// CocoaSection padding none + CocoaTable (base rows washed with the accent
// tone) → the create form lives in a CocoaDrawer (two CocoaFormSection, two
// footer buttons); errors of the form stay on their CocoaField.

import { useEffect, useMemo, useState } from "react";
import { getActiveProperty } from "../../services/activeProperty";
import {
  fetchRatePlans,
  createRatePlan,
  RatePlansNotImplementedError,
  type RatePlan,
  type RatePlanType,
  type RestrictionPreset,
  type CreateRatePlanPayload
} from "../../services/ratePlansApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, confirmDiscard, newLabel } from "../../content/actions";
import { money, number, percent, plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const TYPE_LABEL: Record<string, string> = {
  BAR: "BAR · Tarifa pública (base)",
  non_refundable: "No reembolsable",
  flexible: "Flexible",
  corporate: "Empresas",
  package: "Paquete (PKG)",
  promo: "Promocional",
  weekend: "Fin de semana"
};

const TYPE_TONE: Record<string, CocoaTone> = {
  BAR: "success",
  non_refundable: "warning",
  flexible: "info",
  corporate: "info",
  package: "info",
  promo: "info"
};

const MEAL_PLAN_LABEL: Record<string, string> = {
  RO: "Solo alojamiento (RO)",
  BB: "Alojamiento y desayuno (BB)",
  HB: "Media pensión (HB)",
  FB: "Pensión completa (FB)",
  AI: "Todo incluido (AI)"
};

const TYPE_OPTIONS = Object.keys(TYPE_LABEL).map((value) => ({ value, label: TYPE_LABEL[value] }));
const MEAL_PLAN_OPTIONS = Object.keys(MEAL_PLAN_LABEL).map((value) => ({ value, label: MEAL_PLAN_LABEL[value] }));
const DERIVATION_OPTIONS = [
  { value: "percent", label: "Porcentaje sobre la BAR (ej. −10)" },
  { value: "absolute", label: "Importe sobre la BAR (ej. +5)" },
  { value: "none", label: "Sin derivación" }
];

// The backend expects an UPPERCASE alphanumeric code (`_` and `-` allowed), 2–20 characters.
const CODE = /^[A-Z0-9_-]{2,20}$/;

function fmtDerivation(plan: RatePlan): string {
  if (!plan.parentRatePlanId) return "Base";
  const d = plan.derivationJson;
  if (d?.type === "percent" && typeof d.value === "number") {
    return `${percent(d.value, { signDisplay: "always", maximumFractionDigits: 2 })} sobre BAR`;
  }
  if (d?.type === "absolute" && typeof d.value === "number") {
    return `${money(d.value, { signDisplay: "always" })} sobre BAR`;
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

type DraftErrors = Partial<Record<"code" | "name" | "parentRatePlanId" | "derivationValue", string>>;

/** Client-side checks (same rules the legacy screen applied before sending): every message lands on its field. */
function validate(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  const normalizedCode = draft.code.trim().toUpperCase();
  if (!normalizedCode) errors.code = "El código es obligatorio.";
  else if (!CODE.test(normalizedCode)) errors.code = "Código inválido. Usa 2-20 caracteres en MAYÚSCULAS, dígitos, '_' o '-'. Ej. BAR, NREF, FLEX_24.";
  if (!draft.name.trim()) errors.name = "El nombre es obligatorio.";
  if (draft.ratePlanType !== "BAR" && !draft.parentRatePlanId) errors.parentRatePlanId = "Las variantes deben tener un plan padre (BAR).";
  if (draft.ratePlanType !== "BAR" && draft.derivationType !== "none") {
    if (!draft.derivationValue.trim()) {
      errors.derivationValue = "Indica el valor de la derivación, o cambia el tipo a 'sin derivación'.";
    } else {
      // Range check before Number(): percent in [-100, 500] (full discount or 5x markup), absolute in [-10000, 10000].
      const value = Number(draft.derivationValue);
      if (Number.isNaN(value) || !Number.isFinite(value)) errors.derivationValue = "El valor de la derivación debe ser un número válido.";
      else if (draft.derivationType === "percent" && (value < -100 || value > 500)) errors.derivationValue = "El porcentaje de derivación debe estar entre -100% y +500%.";
      else if (draft.derivationType === "absolute" && value < -10000) errors.derivationValue = "El valor absoluto de derivación es demasiado bajo (mínimo -10000 €).";
      else if (draft.derivationType === "absolute" && value > 10000) errors.derivationValue = "El valor absoluto de derivación es demasiado alto (máximo +10000 €).";
    }
  }
  return errors;
}

type RatePlanRow = RatePlan & { parentLabel: string };

const COLUMNS: CocoaTableColumn<RatePlanRow>[] = [
  { key: "code", label: "Código", fit: true, render: (p) => <strong>{p.code}</strong> },
  { key: "name", label: FIELD_LABELS.name, minWidth: 160 },
  {
    key: "ratePlanType",
    label: FIELD_LABELS.type,
    fit: true,
    render: (p) => (
      <CocoaBadge tone={TYPE_TONE[p.ratePlanType] ?? "info"} size="small">
        {TYPE_LABEL[p.ratePlanType] ?? p.ratePlanType}
      </CocoaBadge>
    )
  },
  { key: "parentLabel", label: "Plan padre", showFrom: "laptop", render: (p) => p.parentLabel },
  { key: "derivation", label: "Derivación", fit: true, render: (p) => <strong>{fmtDerivation(p)}</strong> },
  { key: "mealPlan", label: "Régimen", showFrom: "desktop", render: (p) => (p.mealPlan ? MEAL_PLAN_LABEL[p.mealPlan] ?? p.mealPlan : "—") },
  { key: "mlos", label: "Mín. noches", align: "right", fit: true, hideOnNarrow: true, render: (p) => (p.restrictions?.mlos != null ? number(p.restrictions.mlos) : "—") },
  { key: "maxLos", label: "Máx. noches", align: "right", fit: true, hideOnNarrow: true, render: (p) => (p.restrictions?.maxLos != null ? number(p.restrictions.maxLos) : "—") },
  {
    key: "cta",
    label: "Cierre a la llegada",
    fit: true,
    showFrom: "desktop",
    render: (p) => (p.restrictions?.cta ? <CocoaBadge tone="warning" size="small">{STATUS_LABELS.yes}</CocoaBadge> : "—")
  },
  {
    key: "ctd",
    label: "Cierre a la salida",
    fit: true,
    showFrom: "desktop",
    render: (p) => (p.restrictions?.ctd ? <CocoaBadge tone="warning" size="small">{STATUS_LABELS.yes}</CocoaBadge> : "—")
  },
  {
    key: "active",
    label: FIELD_LABELS.status,
    fit: true,
    render: (p) => <CocoaBadge tone={p.active ? "success" : "neutral"}>{p.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}</CocoaBadge>
  }
];

function RatePlansSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={280} />
    </div>
  );
}

export function RatePlansScreen() {
  const { showToast } = useToast();
  const property = getActiveProperty();

  const [plans, setPlans] = useState<RatePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [touched, setTouched] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [initialDraft, setInitialDraft] = useState<Draft>(emptyDraft());
  const [askDiscard, setAskDiscard] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const discard = confirmDiscard();

  async function load() {
    setLoading(true);
    setErrorBanner(null);
    try {
      const items = await fetchRatePlans();
      setPlans(items);
    } catch (e) {
      // A 404 means this API does not serve rate plans yet; any other failure
      // keeps the previous list and shows the real error. Never sample data.
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RatePlansNotImplementedError) {
        setPlans([]);
        setErrorBanner("Este servidor aún no ofrece los planes de tarifas. Actualiza la aplicación o contacta con soporte.");
      } else {
        setErrorBanner(`No se pudieron cargar los planes de tarifas: ${message}. Reintenta o contacta con soporte.`);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const parentOptions = useMemo(
    () => plans.filter((p) => p.parentRatePlanId === null).map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
    [plans]
  );
  const rows = useMemo<RatePlanRow[]>(() => {
    const parentName = (id: string | null): string => {
      if (!id) return "—";
      const p = plans.find((x) => x.id === id);
      return p ? `${p.code} — ${p.name}` : id;
    };
    return plans.map((p) => ({ ...p, parentLabel: parentName(p.parentRatePlanId) }));
  }, [plans]);

  const newPlanLabel = newLabel("m", "plan");
  const errors = validate(draft);
  const valid = Object.keys(errors).length === 0;
  const isBar = draft.ratePlanType === "BAR";
  const fieldError = (key: keyof DraftErrors) => (touched ? errors[key] : undefined);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    const next = emptyDraft();
    setDraft(next);
    setInitialDraft(next);
    setTouched(false);
    setFormError(null);
    setNotice(null);
    setShowForm(true);
  }

  // Esc, the scrim and «Cancelar» ask before dropping a half-filled plan (dirty guard, plan §4.4).
  function closeForm() {
    if (busy) return;
    if (dirty) {
      setAskDiscard(true);
      return;
    }
    setShowForm(false);
  }

  function discardForm() {
    setAskDiscard(false);
    setShowForm(false);
    setDraft(emptyDraft());
  }

  async function save() {
    setTouched(true);
    if (!valid || busy) return;
    const normalizedCode = draft.code.trim().toUpperCase();
    const derivationValueNum = !isBar && draft.derivationType !== "none" ? Number(draft.derivationValue) : undefined;

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
      parentRatePlanId: isBar ? null : (draft.parentRatePlanId || null),
      derivationJson: derivation,
      cancellationPolicyId: null,
      mealPlan: draft.mealPlan || null,
      active: draft.active,
      restrictions
    };

    setBusy(true);
    setFormError(null);
    try {
      await createRatePlan(payload);
      setNotice(`Plan «${draft.name}» creado.`);
      showToast(`Plan «${draft.name}» creado`, { variant: "success" });
      await load();
      setShowForm(false);
      setDraft(emptyDraft());
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo crear el plan.";
      setFormError(message);
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
  const ready = !loading && plans.length > 0;

  let body;
  if (errorBanner && plans.length === 0) {
    body = <CocoaState kind="error" title="No se pudieron cargar los planes de tarifas" message={errorBanner} onRetry={() => void load()} />;
  } else if (plans.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration="box"
        title="Sin planes tarifarios"
        message="Empieza por crear una BAR (base) y luego derivar variantes como No reembolsable o Empresas."
        primaryAction={{ label: newPlanLabel, onClick: openCreate }}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={rows}
        rowKey="id"
        loading={loading && plans.length === 0}
        rowTone={(p) => (p.parentRatePlanId ? undefined : "accent")}
        caption="Planes de tarifas"
        aria-label="Planes de tarifas"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow={`Revenue · ${property.propertyName}`}
      title="Planes de tarifas"
      subtitle="La tarifa pública (BAR) como base y sus variantes derivadas (porcentaje o importe) con sus restricciones de estancia mínima y máxima y de llegada o salida. El precio de cada día se calcula sobre la BAR del día."
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading && plans.length > 0} disabled={loading || busy}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={openCreate} disabled={busy}>
            {newPlanLabel}
          </CocoaButton>
        </>
      }
      state={loading && plans.length === 0 && !errorBanner ? "loading" : "ready"}
      skeleton={<RatePlansSkeleton />}
      commands={[
        { id: "rate-plans-new", label: newPlanLabel, run: openCreate },
        { id: "rate-plans-refresh", label: "Actualizar los planes de tarifas", run: () => void load() }
      ]}
    >
      {errorBanner && plans.length > 0 ? (
        <CocoaCallout
          tone="danger"
          role="alert"
          title={STATUS_LABELS.loadError}
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {errorBanner}
        </CocoaCallout>
      ) : null}
      {notice ? (
        <CocoaCallout tone="success" role="status" title={STATUS_LABELS.saved}>
          {notice}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Resumen de planes de tarifas">
        <CocoaKpi label="Planes" value={number(kpis.total)} caption="total" polarity="neutral" status="ok" />
        <CocoaKpi label="Activos" value={number(kpis.active)} caption="a la venta" polarity="neutral" status="ok" />
        <CocoaKpi label="Tarifas base" value={number(kpis.base)} caption="BAR" polarity="neutral" status="ok" />
        <CocoaKpi label="Variantes derivadas" value={number(kpis.variants)} caption="sobre la BAR" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaSection
        title="Planes"
        meta={ready ? plural(plans.length, "plan", "planes") : undefined}
        padding={ready ? "none" : "md"}
        style={{ overflow: "clip" }}
        aria-label="Listado de planes de tarifas"
      >
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={showForm}
        onClose={closeForm}
        title="Nuevo plan tarifario"
        subtitle="La variante hereda el precio de la BAR del día y aplica su derivación."
        side="right"
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={busy} disabled={busy || (touched && !valid)}>
              Crear plan
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {formError ? (
            <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.saveError}>
              {formError}
            </CocoaCallout>
          ) : null}

          <CocoaFormSection title="Identidad y derivación" description="Una BAR no tiene plan padre; cualquier otro tipo es una variante derivada de una BAR.">
            <CocoaFormRow columns={2}>
              <CocoaField label="Código" required error={fieldError("code")} help="Entre 2 y 20 caracteres: mayúsculas, dígitos, «_» o «-».">
                <CocoaInput value={draft.code} onChange={(v) => set("code", v.toUpperCase())} placeholder="BAR, NREF, FLEX, CORP…" maxLength={20} disabled={busy} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.name} required error={fieldError("name")}>
                <CocoaInput value={draft.name} onChange={(v) => set("name", v)} placeholder="Ej. No reembolsable −10 % sobre BAR" disabled={busy} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.type} required>
                <CocoaSelect value={draft.ratePlanType} onChange={(v) => set("ratePlanType", v)} options={TYPE_OPTIONS} disabled={busy} />
              </CocoaField>
              <CocoaField label="Plan padre" required={!isBar} hint={isBar ? STATUS_LABELS.optional.toLowerCase() : undefined} error={fieldError("parentRatePlanId")}>
                <CocoaSelect
                  value={draft.parentRatePlanId}
                  onChange={(v) => set("parentRatePlanId", v)}
                  options={[{ value: "", label: isBar ? "Sin padre (base)" : "Selecciona la BAR padre…" }, ...parentOptions]}
                  disabled={busy || isBar}
                />
              </CocoaField>
              <CocoaField label="Tipo de derivación">
                <CocoaSelect value={draft.derivationType} onChange={(v) => set("derivationType", v as Draft["derivationType"])} options={DERIVATION_OPTIONS} disabled={busy || isBar} />
              </CocoaField>
              <CocoaField label="Valor de derivación" error={fieldError("derivationValue")} help={draft.derivationType === "percent" ? "Porcentaje sobre la BAR: −10 rebaja un 10 %." : draft.derivationType === "absolute" ? "Importe en euros sobre la BAR: +5 suma 5 €." : undefined}>
                <CocoaInput
                  type="number"
                  inputMode="decimal"
                  step={0.01}
                  value={draft.derivationValue}
                  onChange={(v) => set("derivationValue", v)}
                  placeholder="-10"
                  disabled={busy || isBar || draft.derivationType === "none"}
                />
              </CocoaField>
              <CocoaField label="Régimen">
                <CocoaSelect value={draft.mealPlan} onChange={(v) => set("mealPlan", v)} options={MEAL_PLAN_OPTIONS} disabled={busy} />
              </CocoaField>
              <CocoaField label="Plan activo" inline help="Un plan inactivo no se vende ni se publica en los canales.">
                <CocoaSwitch checked={draft.active} onChange={(v) => set("active", v)} size="small" disabled={busy} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection
            title="Restricciones por defecto"
            description="Perfil que el motor aplica al crear días sin ajuste manual. Se puede editar por día desde el calendario de restricciones."
          >
            <CocoaFormRow columns={2}>
              <CocoaField label="Estancia mínima (noches)">
                <CocoaInput type="number" inputMode="numeric" min={0} step={1} value={draft.mlos} onChange={(v) => set("mlos", v)} placeholder="1" disabled={busy} />
              </CocoaField>
              <CocoaField label="Estancia máxima (noches)">
                <CocoaInput type="number" inputMode="numeric" min={0} step={1} value={draft.maxLos} onChange={(v) => set("maxLos", v)} placeholder="30" disabled={busy} />
              </CocoaField>
              <CocoaField label="Cierre a la llegada (CTA)" inline help="No se puede llegar ese día con este plan.">
                <CocoaSwitch checked={draft.cta} onChange={(v) => set("cta", v)} size="small" disabled={busy} />
              </CocoaField>
              <CocoaField label="Cierre a la salida (CTD)" inline help="No se puede salir ese día con este plan.">
                <CocoaSwitch checked={draft.ctd} onChange={(v) => set("ctd", v)} size="small" disabled={busy} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>
        </div>
      </CocoaDrawer>

      <CocoaDialog
        open={askDiscard}
        onClose={() => setAskDiscard(false)}
        tone="destructive"
        title={discard.title}
        description={discard.message}
        confirmLabel={discard.confirmLabel}
        cancelLabel={discard.cancelLabel}
        onConfirm={discardForm}
      />
    </CocoaPage>
  );
}
