// Políticas de cancelación — Revenue › Políticas de cancelación
// (/revenue/politicas-cancelacion, standalone). Cocoa 22 · ola 5 · lote 5-C
// (migrated from the legacy `.bo-*` screen), archetype «formulario».
//
// GET /properties/:propertyId/cancellation-policies (polling 60 s) lists the
// policies; create / update / delete go through services/cancellationApi.
// Layout: CocoaPage → CocoaSection padding none + CocoaTable (a row opens the
// policy in a CocoaDrawer that is the create AND edit form: three
// CocoaFormSection, two footer buttons; «Eliminar» per row → CocoaDialog with
// `busy`).
//
// Progressive penalties (the closer to check-in, the higher the charge) are
// modelled as pairs {hoursBefore, penaltyPct}, the usual Booking / Expedia /
// Mews shape for semi-flexible policies. The current model only stores one
// pair (freeCancelHours + penaltyType/Value), so the windows travel encoded at
// the end of `description` (SLIDING_PREFIX + JSON) until the backend exposes
// `slidingScale` on `CancellationPolicy`; the table paints them as badges.

import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import {
  createCancellationPolicy, updateCancellationPolicy, deleteCancellationPolicy,
  type CancellationPolicy, type PenaltyType
} from "../../services/cancellationApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, confirmDelete, confirmDiscard, newLabel } from "../../content/actions";
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
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const PENALTY_LABEL: Record<PenaltyType, string> = {
  first_night: "Primera noche",
  percent: "Porcentaje del total",
  fixed_amount: "Importe fijo (€)",
  all_stay: "Estancia completa",
  none: "Sin cargo"
};
const PENALTY_OPTIONS = (Object.keys(PENALTY_LABEL) as PenaltyType[]).map((value) => ({ value, label: PENALTY_LABEL[value] }));

type SlidingWindow = { hoursBefore: number; penaltyPct: number };

type Draft = {
  code: string; name: string; description: string;
  freeCancelHours: string;
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
    code: "", name: "", description: "", freeCancelHours: "48",
    penaltyType: "first_night", penaltyValue: "",
    noShowPenaltyType: "first_night", noShowPenaltyValue: "",
    slidingScale: [],
    active: true
  };
}

/** «Primera noche» · «Porcentaje del total (50 %)» · «Importe fijo (€) (30,00 €)». */
function penaltyText(type: PenaltyType, value: number | null): string {
  if (value == null) return PENALTY_LABEL[type];
  return `${PENALTY_LABEL[type]} (${type === "percent" ? percent(value) : money(value)})`;
}

const COLUMNS: CocoaTableColumn<CancellationPolicy>[] = [
  { key: "code", label: "Código", fit: true, render: (p) => <strong>{p.code}</strong> },
  { key: "name", label: FIELD_LABELS.name, minWidth: 160 },
  {
    key: "freeCancelHours",
    label: "Cancelación gratuita",
    fit: true,
    render: (p) => (p.freeCancelHours > 0 ? `${number(p.freeCancelHours)} h antes` : <CocoaBadge tone="warning" size="small">No reembolsable</CocoaBadge>)
  },
  {
    key: "sliding",
    label: "Escalado",
    showFrom: "laptop",
    render: (p) => {
      const { sliding } = parseSliding(p.description ?? null);
      if (sliding.length === 0) return penaltyText(p.penaltyType, p.penaltyValue);
      return (
        <span className="cocoa-cluster">
          {sliding.map((w, i) => (
            <CocoaBadge key={i} tone="neutral" size="small" uppercase={false}>
              T−{number(w.hoursBefore)} h · {percent(w.penaltyPct)}
            </CocoaBadge>
          ))}
        </span>
      );
    }
  },
  { key: "noShow", label: "No-show", showFrom: "desktop", render: (p) => penaltyText(p.noShowPenaltyType, p.noShowPenaltyValue) },
  {
    key: "active",
    label: FIELD_LABELS.status,
    fit: true,
    render: (p) => <CocoaBadge tone={p.active ? "success" : "neutral"}>{p.active ? "Activa" : "Inactiva"}</CocoaBadge>
  }
];

export function CancellationPoliciesScreen() {
  const { showToast } = useToast();
  const property = getActiveProperty();
  const { data, loading, error, refresh } = useApiData<{ items: CancellationPolicy[] }>(
    `/properties/${PROPERTY_ID}/cancellation-policies`,
    { pollIntervalMs: 60000 }
  );
  const policies = data?.items ?? [];

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CancellationPolicy | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [touched, setTouched] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [initialDraft, setInitialDraft] = useState<Draft>(emptyDraft());
  const [askDiscard, setAskDiscard] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CancellationPolicy | null>(null);

  const newPolicyLabel = newLabel("f", "política");
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const discard = confirmDiscard();
  const errors = {
    code: draft.code.trim() ? undefined : "El código es obligatorio.",
    name: draft.name.trim() ? undefined : "El nombre es obligatorio."
  };
  const valid = !errors.code && !errors.name;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    const next = emptyDraft();
    setEditing(null);
    setDraft(next);
    setInitialDraft(next);
    setTouched(false);
    setFormError(null);
    setNotice(null);
    setShowForm(true);
  }
  function openEdit(p: CancellationPolicy) {
    const { sliding, clean } = parseSliding(p.description ?? null);
    const next: Draft = {
      code: p.code, name: p.name, description: clean,
      freeCancelHours: String(p.freeCancelHours),
      penaltyType: p.penaltyType, penaltyValue: p.penaltyValue?.toString() ?? "",
      noShowPenaltyType: p.noShowPenaltyType, noShowPenaltyValue: p.noShowPenaltyValue?.toString() ?? "",
      slidingScale: sliding,
      active: p.active
    };
    setEditing(p);
    setDraft(next);
    setInitialDraft(next);
    setTouched(false);
    setFormError(null);
    setNotice(null);
    setShowForm(true);
  }
  // Esc, the scrim and «Cancelar» ask before dropping unsaved changes (dirty guard, plan §4.4).
  function closeForm() {
    if (busy) return;
    if (dirty) {
      setAskDiscard(true);
      return;
    }
    setShowForm(false);
    setEditing(null);
  }
  function discardForm() {
    setAskDiscard(false);
    setShowForm(false);
    setEditing(null);
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
    setTouched(true);
    if (!valid || busy) return;
    // Progressive windows: hours never negative, penalty between 0 and 100 %.
    for (const w of draft.slidingScale) {
      if (w.hoursBefore < 0) { setFormError("Las horas de las penalizaciones progresivas no pueden ser negativas."); return; }
      if (w.penaltyPct < 0 || w.penaltyPct > 100) { setFormError("La penalización debe estar entre 0 y 100%."); return; }
    }
    setBusy(true);
    setFormError(null);
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
      setNotice(editing ? "Política actualizada." : "Política creada.");
      showToast(editing ? `Política «${draft.name}» actualizada` : `Política «${draft.name}» creada`, { variant: "success" });
      setShowForm(false); setEditing(null);
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo guardar.";
      setFormError(message);
      showToast(message, { variant: "error" });
    } finally { setBusy(false); }
  }

  async function confirmRemove() {
    const p = pendingDelete;
    if (!p) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteCancellationPolicy(p.id);
      setNotice("Política eliminada.");
      showToast(`Política «${p.name}» eliminada`, { variant: "success" });
      setPendingDelete(null);
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo eliminar.";
      setNotice(null);
      setPendingDelete(null);
      showToast(message, { variant: "error" });
    } finally { setBusy(false); }
  }

  const ready = !loading && !error && policies.length > 0;
  const deleteCopy = pendingDelete ? confirmDelete(`la política «${pendingDelete.name}»`) : null;

  let body;
  if (loading && policies.length === 0) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Políticas de cancelación" />;
  } else if (error) {
    body = <CocoaState kind="error" title="No se pudieron cargar las políticas" message={error} onRetry={refresh} />;
  } else if (policies.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration="box"
        title="Sin políticas"
        message="Crea la primera política de cancelación para empezar a aplicarla en reservas."
        primaryAction={{ label: newPolicyLabel, onClick: openCreate }}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={policies}
        rowKey="id"
        selectedKey={editing?.id}
        onSelect={openEdit}
        rowTitle={() => "Abrir la política para editarla"}
        rowActions={(p) => (
          <CocoaButton
            variant="plain"
            tone="destructive"
            size="small"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              setPendingDelete(p);
            }}
          >
            {ACTIONS.delete}
          </CocoaButton>
        )}
        caption="Políticas de cancelación"
        aria-label="Políticas de cancelación"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow={`Revenue · ${property.propertyName}`}
      title="Políticas de cancelación"
      subtitle="Ventana de cancelación gratuita, penalización aplicable y, si quieres, penalizaciones progresivas (cuanto más cerca de la entrada, mayor el cargo). El cargo se aplica al folio al cancelar o en el cierre del día."
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={loading && policies.length > 0} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={openCreate} disabled={busy}>
            {newPolicyLabel}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "cancellation-policies-new", label: newPolicyLabel, run: openCreate },
        { id: "cancellation-policies-refresh", label: "Actualizar las políticas de cancelación", run: refresh }
      ]}
    >
      {notice ? (
        <CocoaCallout tone="success" role="status" title={STATUS_LABELS.saved}>
          {notice}
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title="Políticas"
        meta={ready ? plural(policies.length, "política", "políticas") : undefined}
        padding={ready ? "none" : "md"}
        style={{ overflow: "clip" }}
        aria-label="Listado de políticas de cancelación"
      >
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={showForm}
        onClose={closeForm}
        title={editing ? `Editar «${editing.name}»` : "Nueva política"}
        subtitle={editing ? `${editing.code} · ${editing.active ? "Activa" : "Inactiva"}` : undefined}
        side="right"
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={busy} disabled={busy || (touched && !valid)}>
              {editing ? ACTIONS.saveChanges : "Crear política"}
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

          <CocoaFormSection title="Identificación" description="El código identifica la política en los planes de tarifas y no se cambia una vez creada.">
            <CocoaFormRow columns={2}>
              <CocoaField label="Código" required error={touched ? errors.code : undefined}>
                <CocoaInput value={draft.code} onChange={(v) => set("code", v)} placeholder="FLEX, SEMI, NREF…" disabled={busy || !!editing} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.name} required error={touched ? errors.name : undefined}>
                <CocoaInput value={draft.name} onChange={(v) => set("name", v)} disabled={busy} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.description} fullWidth hint={STATUS_LABELS.optional.toLowerCase()}>
                <CocoaInput value={draft.description} onChange={(v) => set("description", v)} multiline rows={2} disabled={busy} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="Cancelación y penalizaciones" description="Dentro de la ventana gratuita no hay cargo; fuera de ella se aplica la penalización por defecto salvo que haya tramos progresivos.">
            <CocoaFormRow columns={2}>
              <CocoaField label="Horas gratis antes de la llegada" help="0 convierte la política en no reembolsable.">
                <CocoaInput type="number" inputMode="numeric" min={0} value={draft.freeCancelHours} onChange={(v) => set("freeCancelHours", v)} disabled={busy} />
              </CocoaField>
              <CocoaField label="Política activa" inline help="Una política inactiva no se puede asignar a nuevos planes.">
                <CocoaSwitch checked={draft.active} onChange={(v) => set("active", v)} size="small" disabled={busy} />
              </CocoaField>
              <CocoaField label="Penalización por cancelación (por defecto)">
                <CocoaSelect value={draft.penaltyType} onChange={(v) => set("penaltyType", v as PenaltyType)} options={PENALTY_OPTIONS} disabled={busy} />
              </CocoaField>
              <CocoaField label="Valor (si % o €)">
                <CocoaInput value={draft.penaltyValue} onChange={(v) => set("penaltyValue", v)} inputMode="decimal" placeholder="50" disabled={busy} />
              </CocoaField>
              <CocoaField label="Penalización por no-show">
                <CocoaSelect value={draft.noShowPenaltyType} onChange={(v) => set("noShowPenaltyType", v as PenaltyType)} options={PENALTY_OPTIONS} disabled={busy} />
              </CocoaField>
              <CocoaField label="Valor (si % o €)">
                <CocoaInput value={draft.noShowPenaltyValue} onChange={(v) => set("noShowPenaltyValue", v)} inputMode="decimal" placeholder="50" disabled={busy} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection
            title="Penalizaciones progresivas"
            description="Tramos según se acerca la llegada. Ej. T−72 h · 25 %, T−48 h · 50 %, T−24 h · 100 %. Si no hay tramos, se usa la penalización por defecto."
            actions={
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={addWindow} disabled={busy}>
                Añadir ventana
              </CocoaButton>
            }
          >
            {draft.slidingScale.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin tramos: se aplica la penalización por defecto." />
            ) : (
              <div className="cocoa-stack" data-gap="3">
                {draft.slidingScale.map((w, i) => (
                  <div key={i} className="cocoa-row" data-gap="2" data-align="end">
                    <CocoaField label="Horas antes de la llegada (T−)">
                      <CocoaInput type="number" inputMode="numeric" min={0} step={1} value={String(w.hoursBefore)} onChange={(v) => updateWindow(i, { hoursBefore: Number(v) })} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Penalización (%)">
                      <CocoaInput type="number" inputMode="numeric" min={0} max={100} step={1} value={String(w.penaltyPct)} onChange={(v) => updateWindow(i, { penaltyPct: Number(v) })} disabled={busy} />
                    </CocoaField>
                    <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => removeWindow(i)} disabled={busy} aria-label={`Eliminar el tramo T−${number(w.hoursBefore)} h`}>
                      {ACTIONS.delete}
                    </CocoaButton>
                  </div>
                ))}
              </div>
            )}
          </CocoaFormSection>
        </div>
      </CocoaDrawer>

      <CocoaDialog
        open={pendingDelete !== null}
        onClose={() => { if (!busy) setPendingDelete(null); }}
        tone="destructive"
        title={deleteCopy?.title ?? ""}
        description={deleteCopy?.message}
        confirmLabel={deleteCopy?.confirmLabel}
        cancelLabel={deleteCopy?.cancelLabel}
        busy={busy}
        onConfirm={confirmRemove}
      />

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
