// Ajustes de facturación — Configuración › Facturación y pagos › Facturación
// (/configuracion/facturacion-pagos, base tab of FacturacionPagosTabs).
// Cocoa 22 · ola 10 · lote 10-D, archetype «formulario / ajustes»
// (docs/design/COCOA-22.md §4): CocoaPage (hosted: the container paints eyebrow
// and title) → two CocoaSection panels on the 12-column grid (series summary
// with the link to the sociedad-wide view of Estructura societaria · VeriFactu
// status read from compliance-settings + /compliance/health) → CocoaTable of
// the real invoice series (GET /backoffice/properties/:id/billing-settings)
// with «Editar» per row → CocoaDrawer editor (CocoaField controls, the server
// rules mirrored in CocoaField.error, «Guardar serie» through PATCH
// /backoffice/properties/:id/billing-settings). The fiscal identity of the
// issuer (NIF, razón social) belongs to the legal entity and is only linked
// from here. The old «No active sequence is configured» card was a false literal.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { ApiError } from "../services/api-client";
import { fetchBillingSettings, patchBillingSettings, type InvoiceSequence, type InvoiceSequencePatch } from "../services/billingApi";
import { fetchComplianceHealth, fetchComplianceSettings, type ComplianceHealthReport, type ComplianceSettings } from "../services/complianceApi";
import { useToast } from "../components/Toast";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn
} from "../components/cocoa";
import { ACTIONS, STATUS_LABELS } from "../content/actions";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { EMPTY, plural } from "../lib/format";
import { treeHeaderFor } from "./tabs/tab-helpers";

const PROPERTY_ID = getActivePropertyId();

const INVOICE_TYPE_LABELS: Record<string, string> = {
  full: "Completa (F1)",
  simplified: "Simplificada (F2)",
  rectifying: "Rectificativa (R)",
  credit_note: "Abono",
  F1: "Completa (F1)",
  F2: "Simplificada (F2)",
  R1: "Rectificativa (R1 · error fundado)",
  R2: "Rectificativa (R2 · art. 80.3)",
  R3: "Rectificativa (R3 · art. 80.4)",
  R4: "Rectificativa (R4 · resto)",
  R5: "Rectificativa (R5 · simplificada)"
};

const INVOICE_TYPE_OPTIONS = [
  { value: "full", label: INVOICE_TYPE_LABELS.full },
  { value: "simplified", label: INVOICE_TYPE_LABELS.simplified },
  { value: "rectifying", label: INVOICE_TYPE_LABELS.rectifying },
  { value: "credit_note", label: INVOICE_TYPE_LABELS.credit_note }
];

const SERIES_PRESETS: Array<{ code: string; label: string; invoiceType: InvoiceSequencePatch["invoiceType"]; prefix: string }> = [
  { code: "FAC", label: "FAC · facturas completas", invoiceType: "full", prefix: "FAC-" },
  { code: "SIM", label: "SIM · facturas simplificadas", invoiceType: "simplified", prefix: "SIM-" },
  { code: "REC", label: "REC · rectificativas", invoiceType: "rectifying", prefix: "REC-" }
];

/** Value of the code picker that opens the free-text code field. */
const CUSTOM_CODE = "__custom";

const CODE_OPTIONS = [...SERIES_PRESETS.map((preset) => ({ value: preset.code, label: preset.label })), { value: CUSTOM_CODE, label: "Otro código…" }];

type SeriesForm = {
  sequenceCode: string;
  invoiceType: InvoiceSequencePatch["invoiceType"];
  prefix: string;
  nextNumber: string;
  padding: string;
  year: string;
  active: boolean;
};

type SeriesErrors = Partial<Record<"sequenceCode" | "nextNumber" | "padding" | "year", string>>;

const CURRENT_YEAR = new Date().getFullYear();

function emptySeriesForm(): SeriesForm {
  return { sequenceCode: "FAC", invoiceType: "full", prefix: `FAC-${CURRENT_YEAR}-`, nextNumber: "1", padding: "6", year: String(CURRENT_YEAR), active: true };
}

// Persisted rows may carry AEAT codes (F1/F2/R1…R5) instead of the form enum.
function toFormInvoiceType(value: string): InvoiceSequencePatch["invoiceType"] {
  if (value === "F1") return "full";
  if (value === "F2") return "simplified";
  if (/^R[1-5]$/.test(value)) return "rectifying";
  return value as InvoiceSequencePatch["invoiceType"];
}

function previewNumber(sequence: { prefix?: string | null; nextNumber: number; padding: number }): string {
  return `${sequence.prefix ?? ""}${String(sequence.nextNumber).padStart(Math.max(0, sequence.padding), "0")}`;
}

/** Client mirror of the PATCH rules; the messages are the ones the toast used to show. Empty = valid. */
function validateSeries(form: SeriesForm): SeriesErrors {
  const errors: SeriesErrors = {};
  if (!form.sequenceCode.trim()) errors.sequenceCode = "Indica el código de la serie (FAC, SIM, REC…).";
  const nextNumber = Number(form.nextNumber);
  if (!Number.isInteger(nextNumber) || nextNumber < 1) errors.nextNumber = "El próximo número debe ser un entero mayor que 0.";
  const padding = Number(form.padding);
  if (!Number.isInteger(padding) || padding < 0 || padding > 12) errors.padding = "El relleno debe estar entre 0 y 12 dígitos.";
  if (form.year.trim()) {
    const year = Number(form.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.year = "El año de la serie no es válido.";
  }
  return errors;
}

function firstSeriesError(errors: SeriesErrors): string | undefined {
  return errors.sequenceCode ?? errors.nextNumber ?? errors.padding ?? errors.year;
}

function modeLabel(mode: string | undefined): string {
  if (mode === "production") return "producción";
  if (mode === "preproduction") return "preproducción";
  return "pruebas";
}

const SEQUENCE_COLUMNS: CocoaTableColumn<InvoiceSequence>[] = [
  { key: "sequenceCode", label: "Código", fit: true, render: (row) => <strong className="cocoa-tabular">{row.sequenceCode}</strong> },
  { key: "prefix", label: "Prefijo", render: (row) => row.prefix || EMPTY },
  {
    key: "year",
    label: "Año",
    fit: true,
    render: (row) => (row.year ? <span className="cocoa-tabular">{String(row.year)}</span> : <span title="Serie sin ejercicio (numeración continua)">{EMPTY}</span>)
  },
  { key: "nextNumber", label: "Próximo nº", align: "right", fit: true, render: (row) => <span className="cocoa-tabular">{previewNumber(row)}</span> },
  { key: "invoiceType", label: "Tipo", hideOnNarrow: true, render: (row) => INVOICE_TYPE_LABELS[row.invoiceType] ?? row.invoiceType },
  {
    key: "active",
    label: "Activa",
    fit: true,
    render: (row) => <CocoaBadge tone={row.active ? "success" : "warning"}>{row.active ? STATUS_LABELS.yes : STATUS_LABELS.no}</CocoaBadge>
  }
];

export function BillingSettings() {
  const header = treeHeaderFor("BillingSettings", { eyebrow: "Finanzas y cumplimiento", title: "Ajustes de facturación" });
  const { showToast } = useToast();
  const [sequences, setSequences] = useState<InvoiceSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compliance, setCompliance] = useState<ComplianceSettings | null>(null);
  const [health, setHealth] = useState<ComplianceHealthReport | null>(null);
  const [form, setForm] = useState<SeriesForm>(emptySeriesForm());
  const [showForm, setShowForm] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [billing, complianceResult, healthResult] = await Promise.allSettled([
      fetchBillingSettings(PROPERTY_ID),
      fetchComplianceSettings(PROPERTY_ID),
      fetchComplianceHealth()
    ]);
    if (billing.status === "fulfilled") {
      setSequences(toArray<InvoiceSequence>(billing.value.invoiceSequences));
    } else {
      setError(billing.reason instanceof Error ? billing.reason.message : "No se pudieron cargar las series de facturación.");
    }
    setCompliance(complianceResult.status === "fulfilled" ? complianceResult.value : null);
    setHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function applyPreset(code: string) {
    const preset = SERIES_PRESETS.find((candidate) => candidate.code === code);
    setForm((current) => ({
      ...current,
      sequenceCode: code,
      invoiceType: preset?.invoiceType ?? current.invoiceType,
      prefix: preset ? `${preset.prefix}${current.year || CURRENT_YEAR}-` : current.prefix
    }));
  }

  function openNewSeries() {
    setForm(emptySeriesForm());
    setEditingCode(null);
    setShowForm(true);
  }

  function editSequence(sequence: InvoiceSequence) {
    setForm({
      sequenceCode: sequence.sequenceCode,
      invoiceType: toFormInvoiceType(String(sequence.invoiceType)),
      prefix: sequence.prefix ?? "",
      nextNumber: String(sequence.nextNumber),
      padding: String(sequence.padding),
      year: sequence.year ? String(sequence.year) : "",
      active: sequence.active
    });
    setEditingCode(sequence.sequenceCode);
    setShowForm(true);
  }

  function closeForm() {
    if (saving) return;
    setShowForm(false);
  }

  const errors = useMemo(() => validateSeries(form), [form]);

  async function handleSave() {
    const firstError = firstSeriesError(errors);
    if (firstError) {
      showToast(firstError, { variant: "error" });
      return;
    }
    const code = form.sequenceCode.trim().toUpperCase();
    const nextNumber = Number(form.nextNumber);
    const padding = Number(form.padding);
    const year = form.year.trim() ? Number(form.year) : undefined;
    setSaving(true);
    try {
      await patchBillingSettings(PROPERTY_ID, {
        sequenceCode: code,
        invoiceType: form.invoiceType,
        prefix: form.prefix,
        nextNumber,
        padding,
        active: form.active,
        ...(year !== undefined ? { year } : {})
      });
      showToast(`Serie ${code}${year ? ` (${year})` : ""} guardada.`, { variant: "success" });
      setShowForm(false);
      setForm(emptySeriesForm());
      setEditingCode(null);
      await load();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? "No tienes permiso para configurar la facturación (billing.configure)."
          : err instanceof Error
            ? err.message
            : "No se pudo guardar la serie.";
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const rows = useMemo(
    () => [...sequences].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.sequenceCode.localeCompare(b.sequenceCode)),
    [sequences]
  );

  const verifactuHealth = toArray<ComplianceHealthReport["integrations"][number]>(health?.integrations).find((integration) => integration.integration === "verifactu");
  const activeCount = sequences.filter((sequence) => sequence.active).length;
  const isPreset = SERIES_PRESETS.some((preset) => preset.code === form.sequenceCode);
  const preview = previewNumber({ prefix: form.prefix, nextNumber: Number(form.nextNumber) || 1, padding: Number(form.padding) || 0 });

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="Series de numeración por tipo de factura y ejercicio, y estado del registro VeriFactu"
      actions={
        <>
          <CocoaButton variant="plain" onClick={() => navigateTo("BillingCenter")}>
            Centro de facturación
          </CocoaButton>
          <CocoaButton variant="plain" onClick={() => navigateTo("ReportingCenter")}>
            Informes
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={openNewSeries}>
            Nueva serie
          </CocoaButton>
        </>
      }
      state={loading && sequences.length === 0 && !error ? "loading" : error && sequences.length === 0 ? "error" : "ready"}
      skeleton={<CocoaSkeleton.Grid rows={[[6, 6], [12]]} height={160} label="Cargando series de facturación…" />}
      error={{ title: "No se pudieron cargar los ajustes de facturación", message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "billing-settings-new-series", label: "Nueva serie de facturación", run: openNewSeries },
        { id: "billing-settings-refresh", label: "Actualizar los ajustes de facturación", run: () => void load() }
      ]}
      id="billing-settings"
    >
      <CocoaGrid aria-label="Series de facturación y VeriFactu">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Series de facturación"
            meta={
              <CocoaBadge tone={activeCount > 0 ? "success" : "danger"}>
                {activeCount > 0 ? plural(activeCount, "activa", "activas") : "sin serie activa"}
              </CocoaBadge>
            }
            footer={
              <div className="cocoa-cluster">
                <CocoaButton variant="plain" size="small" onClick={() => navigateTo("StructureSeriesTab")}>
                  Series de toda la sociedad
                </CocoaButton>
                <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FinanceComplianceSetupForm")}>
                  Asistente de finanzas y cumplimiento
                </CocoaButton>
              </div>
            }
          >
            <p>
              Cada tipo de factura (completa, simplificada, rectificativa) necesita su serie. Con ejercicio, la numeración se reinicia cada año y el número se
              asigna al emitir (nunca al crear el borrador).
            </p>
            <p className="cocoa-note">
              La identidad fiscal del emisor (NIF y razón social) es de la sociedad y se consulta en Configuración › Estructura societaria; aquí solo se
              numeran las facturas de este establecimiento.
            </p>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="VeriFactu"
            meta={
              <CocoaBadge tone={compliance ? (compliance.verifactuEnabled ? "success" : "warning") : "neutral"}>
                {compliance ? (compliance.verifactuEnabled ? STATUS_LABELS.enabled : STATUS_LABELS.disabled) : "no disponible"}
              </CocoaBadge>
            }
            footer={
              <div className="cocoa-cluster">
                <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FiscalDashboard")}>
                  Centro fiscal
                </CocoaButton>
                <CocoaButton variant="plain" size="small" onClick={() => navigateTo("TaxComplianceSettings")}>
                  Ajustes fiscales
                </CocoaButton>
              </div>
            }
          >
            <p>
              {verifactuHealth
                ? `Conector en modo ${modeLabel(verifactuHealth.mode)} · certificado ${verifactuHealth.cert.configured ? "configurado" : "sin configurar"}.`
                : "Estado del conector no disponible."}{" "}
              Las facturas emitidas son inmutables: se corrigen con anulación o rectificativa.
            </p>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Series de la propiedad" meta={plural(rows.length, "serie", "series")} padding={rows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {rows.length === 0 ? (
          <CocoaState
            kind="empty"
            dashed
            title="Sin series de facturación"
            message="No se puede emitir ninguna factura hasta crear al menos una serie activa (FAC para facturas completas)."
            primaryAction={{ label: "Crear serie FAC", onClick: openNewSeries }}
          />
        ) : (
          <CocoaTable<InvoiceSequence>
            columns={SEQUENCE_COLUMNS}
            rows={rows}
            rowKey="id"
            caption="Series de facturación de la propiedad"
            aria-label="Series de facturación de la propiedad"
            emptyState="Sin series."
            rowActionsVisible="always"
            rowActions={(row) => (
              <CocoaButton
                variant="plain"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  editSequence(row);
                }}
              >
                {ACTIONS.edit}
              </CocoaButton>
            )}
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={showForm}
        onClose={closeForm}
        title={editingCode ? `Serie ${editingCode}` : "Nueva serie"}
        subtitle="Numeración por tipo de factura y ejercicio"
        size="md"
        footer={
          <>
            <CocoaButton variant="plain" tone="neutral" onClick={closeForm} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void handleSave()} loading={saving} disabled={saving || Boolean(firstSeriesError(errors))}>
              Guardar serie
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          <CocoaFormRow columns={2}>
            <CocoaField label="Código de serie" required>
              <CocoaSelect value={isPreset ? form.sequenceCode : CUSTOM_CODE} onChange={(value) => (value === CUSTOM_CODE ? setForm({ ...form, sequenceCode: "" }) : applyPreset(value))} options={CODE_OPTIONS} />
            </CocoaField>
            {!isPreset ? (
              <CocoaField label="Código personalizado" required error={errors.sequenceCode}>
                <CocoaInput value={form.sequenceCode} onChange={(value) => setForm({ ...form, sequenceCode: value.toUpperCase() })} placeholder="AUDIT" maxLength={12} />
              </CocoaField>
            ) : null}
            <CocoaField label="Tipo de factura" required>
              <CocoaSelect value={form.invoiceType} onChange={(value) => setForm({ ...form, invoiceType: value as InvoiceSequencePatch["invoiceType"] })} options={INVOICE_TYPE_OPTIONS} />
            </CocoaField>
            <CocoaField label="Ejercicio (año)" error={errors.year} help="Vacío = numeración continua sin reinicio anual.">
              <CocoaInput value={form.year} onChange={(value) => setForm({ ...form, year: value })} type="number" inputMode="numeric" placeholder={String(CURRENT_YEAR)} min={2000} max={2100} />
            </CocoaField>
            <CocoaField label="Prefijo">
              <CocoaInput value={form.prefix} onChange={(value) => setForm({ ...form, prefix: value })} placeholder={`FAC-${CURRENT_YEAR}-`} />
            </CocoaField>
            <CocoaField label="Próximo número" required error={errors.nextNumber}>
              <CocoaInput value={form.nextNumber} onChange={(value) => setForm({ ...form, nextNumber: value })} type="number" inputMode="numeric" min={1} />
            </CocoaField>
            <CocoaField label="Relleno (dígitos)" required error={errors.padding}>
              <CocoaInput value={form.padding} onChange={(value) => setForm({ ...form, padding: value })} type="number" inputMode="numeric" min={0} max={12} />
            </CocoaField>
            <CocoaField label="Serie activa" inline>
              <CocoaSwitch checked={form.active} onChange={(value) => setForm({ ...form, active: value })} size="small" />
            </CocoaField>
          </CocoaFormRow>
          <CocoaCallout tone="warning" title={`Vista previa del próximo número: ${preview}`}>
            Cambiar el próximo número de una serie con facturas emitidas puede romper la correlatividad exigida por el RD 1619/2012.
          </CocoaCallout>
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default BillingSettings;
