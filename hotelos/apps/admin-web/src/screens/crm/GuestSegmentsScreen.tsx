// Segmentos de huéspedes — Comercial › Clientes y fidelización › Segmentos
// (/comercial/clientes/segmentos, hosted inside ClientesTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (defined, active, paused)
// → CocoaSection with a CocoaTable of the segments (criteria as badges,
// status, «Editar» / «Pausar» row actions) → a CocoaDrawer creates or edits
// a segment (name, description, criteria rows). «Nuevo segmento» lives in
// the page actions and in ⌘K.
//
// Each segment is a set of criteria over the guest profile (nationality,
// frequency, lifetime value, last stay, NPS…), persisted in the `crm_segment`
// record of the backend (module guest_data_crm_loyalty):
//   GET   /crm/segments      — segments of the organisation
//   POST  /crm/segments      — create { name, description, rulesJson }
//   PATCH /crm/segments/:id  — edit rules / activate / pause
//
// This screen stores the criteria inside `rulesJson` ({ criteria: [...] })
// and reads legacy flat rules (e.g. { minStays: 2 }) defensively as equality
// criteria. A `color` saved by older versions of the screen is preserved on
// every save but no longer edited nor painted (Cocoa 22 paints no colour a
// screen invents, §2 · §6). Module gate (qa#14): nothing is requested until
// the module is known to be enabled; with it off the page paints «Módulo no
// activado» (+ «Activar módulo» for users with modules.enable).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { getActiveProperty } from "../../services/activeProperty";
import { createSegment, fetchSegments, updateSegment, type CrmSegment } from "../../services/crmApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import { XmarkIcon } from "../../components/cocoa-icons/ActionIcons";
import { date, number, plural } from "../../lib/format";
import { moduleDisabledCopy } from "../operations/module-gate";
import { useScreenModuleGate } from "../operations/useScreenModuleGate";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDrawer,
  CocoaField,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

// Menu labels of the tree (Comercial › Clientes y fidelización › Segmentos), never retyped here.
const HEADER = treeHeaderFor("GuestSegmentsReal", { eyebrow: "Comercial · Clientes y fidelización", title: "Segmentos" });

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
  /** Kept as saved by older versions of the screen; not edited nor painted (see header). */
  color?: string;
  createdAt: string;
};

type SegmentDraft = {
  /** null → new segment (POST); id → edit (PATCH). */
  id: string | null;
  name: string;
  description: string;
  color?: string;
  criteria: SegmentCriterion[];
};

const FIELDS = [
  { value: "country", label: "Nacionalidad" },
  { value: "language", label: "Idioma" },
  { value: "tier", label: "Nivel de fidelización" },
  { value: "totalStays", label: "Número total de estancias" },
  { value: "lifetimeValue", label: "Valor de cliente (€)" },
  { value: "lastStayDays", label: "Días desde la última estancia" },
  { value: "nps", label: "NPS de la última encuesta" },
  { value: "channel", label: "Canal habitual" },
  { value: "marketingConsent", label: "Consentimiento de marketing" },
  { value: "ageRange", label: "Rango de edad" }
];

const OPS: CriterionOp[] = ["equals", "in", "gt", "gte", "lt", "lte", "between", "contains", "exists"];

const OP_LABEL: Record<CriterionOp, string> = {
  equals: "=",
  in: "en la lista",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "entre",
  contains: "contiene",
  exists: "tiene valor"
};

const OP_OPTIONS = OPS.map((op) => ({ value: op, label: OP_LABEL[op] }));

const NEW_LABEL = newLabel("m", "segmento");
const MAX_ROWS = 200;

function emptyCriterion(): SegmentCriterion {
  return { field: "country", op: "equals", value: "" };
}

/**
 * Presentable criteria from rulesJson. Recognises this screen's format
 * ({ criteria: [{ field, op, value }] }) and degrades to key/value pairs for
 * flat rules saved by other tools.
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
  const color = typeof rules["color"] === "string" && rules["color"].trim() !== "" ? rules["color"] : undefined;
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? "",
    criteria: parseCriteria(rules),
    active: record.active,
    ...(color ? { color } : {}),
    createdAt: record.createdAt
  };
}

function cleanCriteria(criteria: SegmentCriterion[]): SegmentCriterion[] {
  return criteria
    .filter((c) => c.field.trim() !== "" && (c.op === "exists" || c.value.trim() !== ""))
    .map((c) => ({ field: c.field, op: c.op, value: c.value.trim() }));
}

function fieldLabel(field: string): string {
  return FIELDS.find((f) => f.value === field)?.label ?? field;
}

function criterionText(c: SegmentCriterion): string {
  return c.op === "exists" ? `${fieldLabel(c.field)} ${OP_LABEL.exists}` : `${fieldLabel(c.field)} ${OP_LABEL[c.op]} ${c.value}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Footnote text (description under the name) in the secondary ink; outside a literal `style={{…}}` (rule 6).
const footnoteStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-secondary)" };
// Criterion controls share the drawer row: three controls that shrink alike, the remove button keeps its size.
const controlStyle: CSSProperties = { flex: "1 1 0", minWidth: 0 };

const COLUMNS: CocoaTableColumn<SegmentView>[] = [
  {
    key: "name",
    label: "Segmento",
    minWidth: 180,
    render: (s) => (
      <>
        <strong>{s.name}</strong>
        {s.description ? <span style={footnoteStyle}>{s.description}</span> : null}
      </>
    )
  },
  {
    key: "criteria",
    label: "Criterios",
    minWidth: 200,
    render: (s) =>
      s.criteria.length === 0 ? (
        <span style={footnoteStyle}>Sin criterios definidos</span>
      ) : (
        <span className="cocoa-cluster">
          {s.criteria.map((c, index) => (
            <CocoaBadge key={`${s.id}-${index}`} tone="neutral" uppercase={false}>
              {criterionText(c)}
            </CocoaBadge>
          ))}
        </span>
      )
  },
  {
    key: "status",
    label: FIELD_LABELS.status,
    fit: true,
    render: (s) => (
      <CocoaBadge tone={s.active ? "success" : "neutral"} variant="dot" size="small">
        {s.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}
      </CocoaBadge>
    )
  },
  { key: "createdAt", label: FIELD_LABELS.createdAt, fit: true, hideOnNarrow: true, render: (s) => date(s.createdAt, "medium") }
];

// Mirror skeleton: the KPI strip and the segments table.
function SegmentsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton variant="card" height={280} />
    </div>
  );
}

export function GuestSegmentsScreen() {
  // Hosted inside ClientesTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  // Module gate (qa#14): no request until guest_data_crm_loyalty is known to be enabled.
  const moduleGate = useScreenModuleGate("GuestSegmentsReal");
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
    if (moduleGate.ready) void load();
  }, [load, moduleGate.ready]);

  function reload() {
    setLoading(true);
    void load();
  }

  const stats = useMemo(() => {
    const total = segments.length;
    const active = segments.filter((s) => s.active).length;
    return { total, active, inactive: total - active };
  }, [segments]);

  function startNew() {
    setEditing({ id: null, name: "", description: "", criteria: [emptyCriterion()] });
  }

  function startEdit(segment: SegmentView) {
    setEditing({
      id: segment.id,
      name: segment.name,
      description: segment.description,
      ...(segment.color ? { color: segment.color } : {}),
      criteria: segment.criteria.length > 0 ? segment.criteria.map((c) => ({ ...c })) : [emptyCriterion()]
    });
  }

  function patchCriterion(index: number, patch: Partial<SegmentCriterion>) {
    setEditing((current) => {
      if (!current) return current;
      const next = current.criteria.map((c, i) => (i === index ? { ...c, ...patch } : c));
      return { ...current, criteria: next };
    });
  }

  function removeCriterion(index: number) {
    setEditing((current) => (current ? { ...current, criteria: current.criteria.filter((_, i) => i !== index) } : current));
  }

  function addCriterion() {
    setEditing((current) => (current ? { ...current, criteria: [...current.criteria, emptyCriterion()] } : current));
  }

  async function saveSegment() {
    if (!editing || !editing.name.trim() || saving) return;
    const isEdit = editing.id !== null;
    const criteria = cleanCriteria(editing.criteria);
    const body = {
      name: editing.name.trim(),
      description: editing.description.trim() || undefined,
      rulesJson: { criteria, ...(editing.color ? { color: editing.color } : {}) }
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
          JSON.stringify(updated.criteria) === JSON.stringify(criteria);
        if (applied) {
          showToast(`Segmento «${body.name}» actualizado.`, { variant: "success" });
        } else {
          showToast("La petición se aceptó, pero el servidor aún no refleja los cambios en la lista.", { variant: "info" });
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
        showToast("La petición se aceptó, pero el servidor aún no refleja el cambio de estado.", { variant: "info" });
      }
    } catch (err) {
      showToast(`No se pudo cambiar el estado de «${segment.name}»: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setTogglingId(null);
    }
  }

  const canSave = editing !== null && editing.name.trim() !== "" && !saving;

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading ? "loading" : error ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Audiencias para campañas, ofertas personalizadas y exclusiones (por ejemplo, detractores fuera del marketing). Cada segmento se evalúa sobre el perfil y el historial del huésped."
      actions={
        moduleGate.ready ? (
          <>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={reload} disabled={loading}>
              {ACTIONS.refresh}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" size="small" onClick={startNew} disabled={loading}>
              {NEW_LABEL}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<SegmentsSkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudieron cargar los segmentos", message: error ?? undefined, onRetry: reload }}
      commands={
        moduleGate.ready
          ? [
              { id: "segments-new", label: NEW_LABEL, run: startNew },
              { id: "segments-refresh", label: "Actualizar segmentos", run: reload }
            ]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "segments-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Segmentos">
        <CocoaKpi label="Segmentos definidos" value={number(stats.total)} caption="en la organización" polarity="neutral" status="ok" />
        <CocoaKpi label="Activos" value={number(stats.active)} caption="en uso por campañas" polarity="neutral" status="ok" />
        <CocoaKpi label="Inactivos" value={number(stats.inactive)} caption="pausados" polarity="neutral" status={stats.inactive > 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>

      <CocoaSection
        title="Segmentos definidos"
        meta={plural(segments.length, "segmento", "segmentos")}
        padding={segments.length === 0 ? "md" : "none"}
        style={{ overflow: "clip" }}
      >
        {segments.length === 0 ? (
          <CocoaState
            kind="empty"
            title="Sin segmentos todavía"
            message="Crea el primer segmento para definir audiencias de campañas y exclusiones de marketing. Por ahora los segmentos se guardan en la memoria del servidor y se pierden al reiniciarlo."
            primaryAction={{ label: NEW_LABEL, onClick: startNew }}
          />
        ) : (
          <CocoaTable
            columns={COLUMNS}
            rows={segments.slice(0, MAX_ROWS)}
            rowKey="id"
            rowActions={(s) => (
              <span className="cocoa-cluster">
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => startEdit(s)} disabled={saving}>
                  {ACTIONS.edit}
                </CocoaButton>
                <CocoaButton
                  variant="bordered"
                  tone="neutral"
                  size="small"
                  onClick={() => void toggleActive(s)}
                  loading={togglingId === s.id}
                  disabled={togglingId !== null}
                >
                  {s.active ? "Pausar" : ACTIONS.activate}
                </CocoaButton>
              </span>
            )}
            caption="Segmentos definidos"
            aria-label="Segmentos definidos"
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={editing !== null}
        onClose={() => (saving ? undefined : setEditing(null))}
        title={editing?.id ? "Editar segmento" : NEW_LABEL}
        subtitle="Todos los criterios deben cumplirse."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setEditing(null)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveSegment()} loading={saving} disabled={!canSave}>
              {ACTIONS.save}
            </CocoaButton>
          </>
        }
      >
        {editing ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaField label={FIELD_LABELS.name} required>
              <CocoaInput value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} disabled={saving} autoComplete="off" />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.description}>
              <CocoaInput multiline rows={2} value={editing.description} onChange={(v) => setEditing({ ...editing, description: v })} disabled={saving} />
            </CocoaField>

            <div className="cocoa-stack" data-gap="2" role="group" aria-label="Criterios del segmento">
              <div className="cocoa-row" data-gap="2" data-justify="between">
                <span className="cocoa-caption">Criterios</span>
                <CocoaButton variant="plain" tone="accent" size="small" onClick={addCriterion} disabled={saving}>
                  Añadir criterio
                </CocoaButton>
              </div>
              {editing.criteria.map((c, index) => (
                <div key={index} className="cocoa-row" data-gap="2" data-wrap="nowrap">
                  <CocoaSelect
                    value={c.field}
                    onChange={(v) => patchCriterion(index, { field: v })}
                    options={FIELDS.some((f) => f.value === c.field) ? FIELDS : [...FIELDS, { value: c.field, label: c.field }]}
                    size="small"
                    aria-label={`Campo del criterio ${index + 1}`}
                    disabled={saving}
                    style={controlStyle}
                  />
                  <CocoaSelect
                    value={c.op}
                    onChange={(v) => patchCriterion(index, { op: v as CriterionOp })}
                    options={OP_OPTIONS}
                    size="small"
                    aria-label={`Operador del criterio ${index + 1}`}
                    disabled={saving}
                    style={controlStyle}
                  />
                  <CocoaInput
                    value={c.value}
                    onChange={(v) => patchCriterion(index, { value: v })}
                    placeholder="Valor"
                    size="small"
                    aria-label={`Valor del criterio ${index + 1}`}
                    disabled={saving || c.op === "exists"}
                    style={controlStyle}
                  />
                  <CocoaButton
                    variant="plain"
                    tone="neutral"
                    size="small"
                    icon={<XmarkIcon size={14} />}
                    aria-label={`Quitar criterio ${index + 1}`}
                    onClick={() => removeCriterion(index)}
                    disabled={saving || editing.criteria.length === 1}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}
