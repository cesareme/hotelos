// Ajustes de facturación (Tanda 3 · lote front-fiscal).
//
// Series de facturación reales (GET/PATCH /backoffice/properties/:id/billing-settings)
// y estado VeriFactu leído de compliance-settings + /compliance/health. La
// antigua tarjeta «No active sequence is configured» era un literal falso.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { ApiError } from "../services/api-client";
import { fetchBillingSettings, patchBillingSettings, type InvoiceSequence, type InvoiceSequencePatch } from "../services/billingApi";
import { fetchComplianceHealth, fetchComplianceSettings, type ComplianceHealthReport, type ComplianceSettings } from "../services/complianceApi";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { CocoaPageHeader } from "../components/cocoa/CocoaPageHeader";
import { pageHead } from "./tabs/configuracion/tab-helpers";
import { CocoaCard } from "../components/cocoa/CocoaCard";
import { CocoaButton } from "../components/cocoa/CocoaButton";
import { CocoaSelect } from "../components/cocoa/CocoaSelect";
import { CocoaInput } from "../components/cocoa/CocoaInput";
import { CocoaTable, type CocoaTableColumn } from "../components/cocoa/CocoaTable";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";

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

const SERIES_PRESETS: Array<{ code: string; label: string; invoiceType: InvoiceSequencePatch["invoiceType"]; prefix: string }> = [
  { code: "FAC", label: "FAC · facturas completas", invoiceType: "full", prefix: "FAC-" },
  { code: "SIM", label: "SIM · facturas simplificadas", invoiceType: "simplified", prefix: "SIM-" },
  { code: "REC", label: "REC · rectificativas", invoiceType: "rectifying", prefix: "REC-" }
];

type SeriesForm = {
  sequenceCode: string;
  invoiceType: InvoiceSequencePatch["invoiceType"];
  prefix: string;
  nextNumber: string;
  padding: string;
  year: string;
  active: boolean;
};

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

export function BillingSettings({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: render a section head instead.
  const Head = pageHead(embedded);
  const { showToast } = useToast();
  const [sequences, setSequences] = useState<InvoiceSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compliance, setCompliance] = useState<ComplianceSettings | null>(null);
  const [health, setHealth] = useState<ComplianceHealthReport | null>(null);
  const [form, setForm] = useState<SeriesForm>(emptySeriesForm());
  const [showForm, setShowForm] = useState(false);
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
    setShowForm(true);
  }

  async function handleSave() {
    const code = form.sequenceCode.trim().toUpperCase();
    const nextNumber = Number(form.nextNumber);
    const padding = Number(form.padding);
    const year = form.year.trim() ? Number(form.year) : undefined;
    if (!code) {
      showToast("Indica el código de la serie (FAC, SIM, REC…).", { variant: "error" });
      return;
    }
    if (!Number.isInteger(nextNumber) || nextNumber < 1) {
      showToast("El próximo número debe ser un entero mayor que 0.", { variant: "error" });
      return;
    }
    if (!Number.isInteger(padding) || padding < 0 || padding > 12) {
      showToast("El relleno debe estar entre 0 y 12 dígitos.", { variant: "error" });
      return;
    }
    if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
      showToast("El año de la serie no es válido.", { variant: "error" });
      return;
    }
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
    () =>
      [...sequences].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.sequenceCode.localeCompare(b.sequenceCode)),
    [sequences]
  );

  const columns = useMemo<CocoaTableColumn<InvoiceSequence>[]>(
    () => [
      { key: "sequenceCode", label: "Código", render: (row) => <strong>{row.sequenceCode}</strong> },
      { key: "prefix", label: "Prefijo", render: (row) => row.prefix || <span className="bo-muted">—</span> },
      { key: "year", label: "Año", width: "80px", render: (row) => (row.year ? String(row.year) : <span className="bo-muted" title="Serie sin ejercicio (numeración continua)">—</span>) },
      { key: "nextNumber", label: "Próximo nº", align: "right", width: "160px", render: (row) => <code>{previewNumber(row)}</code> },
      { key: "invoiceType", label: "Tipo", render: (row) => INVOICE_TYPE_LABELS[row.invoiceType] ?? row.invoiceType },
      {
        key: "active",
        label: "Activa",
        width: "90px",
        render: (row) => <span className={`bo-status ${row.active ? "ok" : "warn"}`} style={{ textTransform: "none" }}>{row.active ? "sí" : "no"}</span>
      },
      {
        key: "actions",
        label: "",
        align: "right",
        width: "90px",
        render: (row) => (
          <CocoaButton variant="plain" size="small" onClick={() => editSequence(row)}>
            Editar
          </CocoaButton>
        )
      }
    ],
    []
  );

  const verifactuHealth = toArray<ComplianceHealthReport["integrations"][number]>(health?.integrations).find((integration) => integration.integration === "verifactu");
  const activeCount = sequences.filter((sequence) => sequence.active).length;

  if (loading && sequences.length === 0 && !error) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando series de facturación…" />
      </section>
    );
  }
  if (error && sequences.length === 0) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudieron cargar los ajustes de facturación" message={error} onRetry={() => void load()} />
      </section>
    );
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <Head
        eyebrow="Finanzas y cumplimiento"
        title="Ajustes de facturación"
        subtitle="Series de numeración por tipo de factura y ejercicio, y estado del registro VeriFactu"
        actions={
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}>
            <CocoaButton variant="plain" onClick={() => navigateTo("BillingCenter")}>
              Centro de facturación
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("ReportingCenter")}>
              Informes
            </CocoaButton>
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={() => {
                setForm(emptySeriesForm());
                setShowForm(true);
              }}
            >
              Nueva serie
            </CocoaButton>
          </span>
        }
      />

      <div className="bo-grid two">
        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>Series de facturación</h3>
            <span className={`bo-status ${activeCount > 0 ? "ok" : "error"}`} style={{ textTransform: "none" }}>
              {activeCount > 0 ? `${activeCount} activa${activeCount === 1 ? "" : "s"}` : "sin serie activa"}
            </span>
          </div>
          <p className="bo-muted" style={{ margin: 0 }}>
            Cada tipo de factura (completa, simplificada, rectificativa) necesita su serie. Con ejercicio, la numeración se reinicia cada año y el
            número se asigna al emitir (nunca al crear el borrador).
          </p>
        </CocoaCard>
        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>VeriFactu</h3>
            <span className={`bo-status ${compliance ? (compliance.verifactuEnabled ? "ok" : "warn") : "info"}`} style={{ textTransform: "none" }}>
              {compliance ? (compliance.verifactuEnabled ? "activado" : "desactivado") : "no disponible"}
            </span>
          </div>
          <p className="bo-muted" style={{ margin: 0 }}>
            {verifactuHealth
              ? `Conector en modo ${verifactuHealth.mode === "production" ? "producción" : verifactuHealth.mode === "preproduction" ? "preproducción" : "pruebas"} · certificado ${verifactuHealth.cert.configured ? "configurado" : "sin configurar"}.`
              : "Estado del conector no disponible."}{" "}
            Las facturas emitidas son inmutables: se corrigen con anulación o rectificativa.
          </p>
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FiscalDashboard")}>
              Centro fiscal
            </CocoaButton>
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("TaxComplianceSettings")}>
              Ajustes fiscales
            </CocoaButton>
          </div>
        </CocoaCard>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Sin series de facturación"
          message="No se puede emitir ninguna factura hasta crear al menos una serie activa (FAC para facturas completas)."
          actions={
            <CocoaButton variant="filled" tone="accent" onClick={() => setShowForm(true)}>
              Crear serie FAC
            </CocoaButton>
          }
        />
      ) : (
        <CocoaTable<InvoiceSequence> columns={columns} rows={rows} rowKey="id" emptyState="Sin series." />
      )}

      {showForm ? (
        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>Serie {form.sequenceCode || "nueva"}</h3>
            <CocoaButton variant="plain" size="small" onClick={() => setShowForm(false)} disabled={saving}>
              Cerrar
            </CocoaButton>
          </div>
          <div className="bo-grid three">
            <label className="bo-form-field">
              <span>Código de serie</span>
              <CocoaSelect
                value={SERIES_PRESETS.some((preset) => preset.code === form.sequenceCode) ? form.sequenceCode : "__custom"}
                onChange={(value) => (value === "__custom" ? setForm({ ...form, sequenceCode: "" }) : applyPreset(value))}
                options={[...SERIES_PRESETS.map((preset) => ({ value: preset.code, label: preset.label })), { value: "__custom", label: "Otro código…" }]}
              />
            </label>
            {!SERIES_PRESETS.some((preset) => preset.code === form.sequenceCode) ? (
              <label className="bo-form-field">
                <span>Código personalizado</span>
                <CocoaInput value={form.sequenceCode} onChange={(value) => setForm({ ...form, sequenceCode: value.toUpperCase() })} placeholder="AUDIT" />
              </label>
            ) : null}
            <label className="bo-form-field">
              <span>Tipo de factura</span>
              <CocoaSelect
                value={form.invoiceType}
                onChange={(value) => setForm({ ...form, invoiceType: value as InvoiceSequencePatch["invoiceType"] })}
                options={[
                  { value: "full", label: INVOICE_TYPE_LABELS.full },
                  { value: "simplified", label: INVOICE_TYPE_LABELS.simplified },
                  { value: "rectifying", label: INVOICE_TYPE_LABELS.rectifying },
                  { value: "credit_note", label: INVOICE_TYPE_LABELS.credit_note }
                ]}
              />
            </label>
            <label className="bo-form-field">
              <span>Ejercicio (año)</span>
              <CocoaInput value={form.year} onChange={(value) => setForm({ ...form, year: value })} type="number" inputMode="numeric" placeholder={String(CURRENT_YEAR)} />
              <small>Vacío = numeración continua sin reinicio anual.</small>
            </label>
            <label className="bo-form-field">
              <span>Prefijo</span>
              <CocoaInput value={form.prefix} onChange={(value) => setForm({ ...form, prefix: value })} placeholder="FAC-2026-" />
            </label>
            <label className="bo-form-field">
              <span>Próximo número</span>
              <CocoaInput value={form.nextNumber} onChange={(value) => setForm({ ...form, nextNumber: value })} type="number" inputMode="numeric" />
            </label>
            <label className="bo-form-field">
              <span>Relleno (dígitos)</span>
              <CocoaInput value={form.padding} onChange={(value) => setForm({ ...form, padding: value })} type="number" inputMode="numeric" />
            </label>
            <label className="bo-form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.currentTarget.checked })} style={{ width: "auto" }} />
              <span style={{ fontWeight: 500 }}>Serie activa</span>
            </label>
          </div>
          <p className="bo-muted">
            Vista previa del próximo número:{" "}
            <code>{previewNumber({ prefix: form.prefix, nextNumber: Number(form.nextNumber) || 1, padding: Number(form.padding) || 0 })}</code>. Cambiar el próximo
            número de una serie con facturas emitidas puede romper la correlatividad exigida por el RD 1619/2012.
          </p>
          <div className="bo-actions">
            <CocoaButton variant="filled" tone="accent" onClick={() => void handleSave()} disabled={saving} loading={saving}>
              Guardar serie
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("FinanceComplianceSetupForm")}>
              Asistente de finanzas y cumplimiento
            </CocoaButton>
          </div>
        </CocoaCard>
      ) : null}
    </section>
  );
}

export default BillingSettings;
