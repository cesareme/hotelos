// Impuestos de la propiedad — /cumplimiento/impuestos (Tanda 3 · lote front-fiscal;
// Cocoa 22 · ola 8 · lote 8-C, plantilla ListaTabla; hosted in ImpuestosTabs).
//
// Reads GET /backoffice/properties/:id/taxes (contract C · getPropertyTaxProfile)
// and lets a compliance.configure user override a rate per category (PUT
// …/taxes/rates), re-provision from the statutory catalog (POST …/taxes/provision)
// and set the tourist-tax treatment / IPSI ordinance confirmation through
// PATCH …/compliance-settings. Nothing here is invented: every badge comes from
// the profile payload — `source` "manual" (property override, badge «Manual»)
// vs "db" / "catalog" (statutory, badge «Catálogo»: provisioned row vs direct
// catalogue answer) and `overridden` — and the IPSI card only renders for
// Ceuta/Melilla. A 400 from the legality check (TAX_RATE_NOT_ALLOWED with the
// admitted percentages) is shown verbatim next to the editor.
//
// Page: profile badges → callouts (provision error, region note, missing core
// rates) → «Tipos por concepto» CocoaTable with the row action «Editar» /
// «Definir» → the rate editor as a CocoaSection (three fields, two-button
// footer; the confirmation is a CocoaDialog with `busy`) → tourist tax and
// IPSI ordinance in a 6/6 grid.
//
// Frame: CocoaPage on the host context (hosted in ImpuestosTabs the container
// paints eyebrow and H1); page states (skeleton on the first load, error /
// empty without a profile) and the three ⌘K commands are the page's.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { ApiError } from "../../services/api-client";
import {
  CALIFICACION_LABELS,
  TAX_CATEGORY_LABELS,
  TAX_CATEGORY_ORDER,
  TAX_RATE_ERROR_CODES,
  TOURIST_TAX_TREATMENT_OPTIONS,
  fetchPropertyTaxes,
  isCatalogTaxSource,
  isManualTaxSource,
  isProvisionedTaxSource,
  provisionPropertyTaxes,
  taxRateErrorDetails,
  taxRateSourceDetail,
  taxRateSourceLabel,
  taxRegionLabel,
  upsertPropertyTaxRate,
  type Calificacion,
  type PropertyTaxLineTypeOverride,
  type PropertyTaxProfile,
  type PropertyTaxRateRow,
  type TaxCategory,
  type TouristTaxTreatment
} from "../../services/taxesApi";
import { patchComplianceSettings } from "../../services/complianceApi";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { TAXES_INSTRUCTIONS } from "../../content/screen-instructions/taxes";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { date, percent, plural } from "../../lib/format";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
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
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Cumplimiento › Impuestos), never retyped here.
const HEADER = treeHeaderFor("PropertyTaxesScreen", { eyebrow: "Cumplimiento", title: "Impuestos" });
const RESTORE_LABEL = "Restaurar catálogo";
const OPEN_PROFILE_LABEL = "Abrir perfil del establecimiento";
const EDITOR_SECTION_ID = "property-taxes-rate-editor";
const EDITOR_FIELD_ID = "property-taxes-rate-calificacion";

const TREATMENT_OPTIONS = TOURIST_TAX_TREATMENT_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
const CALIFICACION_OPTIONS = [
  { value: "S1", label: CALIFICACION_LABELS.S1 },
  { value: "N1", label: CALIFICACION_LABELS.N1 }
];

type RateRowView = {
  _key: string;
  category: TaxCategory;
  label: string;
  rate: PropertyTaxRateRow | null;
};

type RateEditor = {
  category: TaxCategory;
  ratePercent: string;
  calificacion: Calificacion;
  validFrom: string;
};

type PendingConfirm = { kind: "rate"; editor: RateEditor } | { kind: "provision" };

/**
 * Server rejection shown verbatim next to the editor (400 legality check
 * TAX_RATE_NOT_ALLOWED with `allowed[]`, TAX_REGION_MISSING, TAX_VALID_FROM_RESERVED…).
 */
type InlineError = { message: string; code: string | null; status: number | null; allowed: number[] };

function toInlineError(error: unknown, fallback: string): InlineError {
  const { code, allowed } = taxRateErrorDetails(error instanceof ApiError ? error.details : null);
  return { message: errorMessage(error, fallback), code, status: error instanceof ApiError ? error.status : null, allowed };
}

function fmtPercent(value: number | null | undefined): string {
  return percent(value, { maximumFractionDigits: 2 });
}

function fmtDate(value: string | null | undefined): string {
  return date(value);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 403) {
    return "No tienes permiso para modificar la configuración fiscal (compliance.configure).";
  }
  return error instanceof Error ? error.message : fallback;
}

function sourceCell(rate: PropertyTaxRateRow) {
  return (
    <span className="cocoa-row" data-gap="1">
      <CocoaBadge tone={isManualTaxSource(rate.source) ? "info" : isCatalogTaxSource(rate.source) ? "success" : "warning"} uppercase={false} title={taxRateSourceDetail(rate.source)}>
        {taxRateSourceLabel(rate.source)}
      </CocoaBadge>
      {isCatalogTaxSource(rate.source) ? (
        <span className="cocoa-caption" title={taxRateSourceDetail(rate.source)}>
          {isProvisionedTaxSource(rate.source) ? "provisionado" : "sin fila"}
        </span>
      ) : null}
      {rate.overridden ? (
        <CocoaBadge tone="warning" uppercase={false} title="Un tipo manual oculta el tipo del catálogo para este concepto">
          sobrescribe el catálogo
        </CocoaBadge>
      ) : null}
    </span>
  );
}

// Columns outside the component (A5): the short ones fit their content, the secondary ones show from laptop (D26); the row action lives in `rowActions`.
const RATE_COLUMNS: CocoaTableColumn<RateRowView>[] = [
  { key: "label", label: "Concepto", minWidth: 160, render: (row) => <strong>{row.label}</strong> },
  {
    key: "rate",
    label: "Tipo",
    align: "right",
    fit: true,
    render: (row) =>
      row.rate ? (
        row.rate.calificacion === "N1" ? (
          <span className="cocoa-caption">no sujeta</span>
        ) : (
          fmtPercent(row.rate.ratePercent)
        )
      ) : (
        <CocoaBadge tone="warning" uppercase={false} title="No hay tipo configurado ni en la BD ni en el catálogo para este concepto">
          sin tipo
        </CocoaBadge>
      )
  },
  { key: "calificacion", label: "Calificación", fit: true, hideOnNarrow: true, render: (row) => (row.rate ? CALIFICACION_LABELS[row.rate.calificacion] : "—") },
  { key: "source", label: "Fuente", render: (row) => (row.rate ? sourceCell(row.rate) : "—") },
  { key: "legalBasis", label: "Base legal", showFrom: "desktop", render: (row) => row.rate?.legalBasis ?? "—" },
  { key: "validFrom", label: "Vigente desde", fit: true, showFrom: "laptop", render: (row) => fmtDate(row.rate?.validFrom) }
];

// Mirror skeleton: badges row, the rates table and the 6/6 grid.
function TaxesSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton variant="card" height={280} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={160} />
    </div>
  );
}

export function PropertyTaxesScreen() {
  const { showToast } = useToast();
  const [profile, setProfile] = useState<PropertyTaxProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<RateEditor | null>(null);
  const [editorError, setEditorError] = useState<InlineError | null>(null);
  const [provisionError, setProvisionError] = useState<InlineError | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProfile(await fetchPropertyTaxes(PROPERTY_ID));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el perfil fiscal de la propiedad.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The editor opens below the table: bring it into view and focus its first control.
  const editorCategory = editor?.category ?? null;
  useEffect(() => {
    if (!editorCategory || typeof document === "undefined") return;
    document.getElementById(EDITOR_SECTION_ID)?.scrollIntoView({ block: "nearest" });
    document.getElementById(EDITOR_FIELD_ID)?.focus();
  }, [editorCategory]);

  const rates = useMemo(() => toArray<PropertyTaxRateRow>(profile?.rates), [profile]);
  const warnings = useMemo(() => toArray<string>(profile?.warnings), [profile]);
  const lineTypeOverrides = useMemo(() => toArray<PropertyTaxLineTypeOverride>(profile?.lineTypeOverrides), [profile]);

  const rows = useMemo<RateRowView[]>(
    () =>
      TAX_CATEGORY_ORDER.map((category) => ({
        _key: category,
        category,
        label: TAX_CATEGORY_LABELS[category],
        rate: rates.find((row) => row.category === category) ?? null
      })),
    [rates]
  );

  const missingCoreRates = rows.filter((row) => !row.rate && ["accommodation", "food_beverage", "general_services"].includes(row.category));
  const isIpsi = profile?.figure === "IPSI" || profile?.taxRegion === "ES_CEUTA" || profile?.taxRegion === "ES_MELILLA";
  const ordinanceRates = rates.filter((row) => row.verifyAgainstOrdinance);
  const manualRates = rates.filter((row) => isManualTaxSource(row.source));
  const catalogRates = rates.filter((row) => isCatalogTaxSource(row.source));
  const provisionedRates = catalogRates.filter((row) => isProvisionedTaxSource(row.source));
  // A source outside the contract (manual / db / catalog) is counted and shown verbatim, never reinterpreted.
  const unknownSourceRates = rates.filter((row) => !isManualTaxSource(row.source) && !isCatalogTaxSource(row.source));
  const overriddenRates = rates.filter((row) => row.overridden === true);

  function startEdit(row: RateRowView) {
    setEditorError(null);
    setEditor({
      category: row.category,
      ratePercent: row.rate ? String(row.rate.ratePercent) : "",
      calificacion: row.rate?.calificacion ?? (row.category === "not_subject" ? "N1" : "S1"),
      validFrom: new Date().toISOString().slice(0, 10)
    });
  }

  function cancelEdit() {
    if (busy) return;
    setEditor(null);
    setEditorError(null);
  }

  function requestSaveRate() {
    if (!editor) return;
    const percentValue = Number(editor.ratePercent.replace(",", "."));
    if (editor.calificacion === "S1" && (!Number.isFinite(percentValue) || percentValue < 0 || percentValue > 100)) {
      showToast("Indica un tipo entre 0 y 100.", { variant: "error" });
      return;
    }
    if (editor.calificacion === "S1" && percentValue === 0 && editor.category !== "not_subject") {
      showToast("Un tipo del 0 % sujeto (S1) no es válido en VeriFactu. Usa «No sujeta (N1)» si la operación no lleva impuesto.", { variant: "error" });
      return;
    }
    setPending({ kind: "rate", editor });
  }

  async function confirmPending() {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "rate") {
        const percentValue = pending.editor.calificacion === "N1" ? 0 : Number(pending.editor.ratePercent.replace(",", "."));
        await upsertPropertyTaxRate(PROPERTY_ID, {
          category: pending.editor.category,
          ratePercent: percentValue,
          calificacion: pending.editor.calificacion,
          validFrom: pending.editor.validFrom || undefined
        });
        showToast(`Tipo de «${TAX_CATEGORY_LABELS[pending.editor.category]}» guardado.`, { variant: "success" });
        setEditor(null);
        setEditorError(null);
      } else {
        const result = await provisionPropertyTaxes(PROPERTY_ID);
        setProvisionError(null);
        if (result.profile) setProfile(result.profile);
        showToast(
          `Catálogo restaurado: ${result.provisioned} tipo${result.provisioned === 1 ? "" : "s"} provisionado${result.provisioned === 1 ? "" : "s"}, ${result.skipped} omitido${result.skipped === 1 ? "" : "s"} por tener ya un tipo vigente.`,
          { variant: "success" }
        );
      }
      setPending(null);
      await load();
    } catch (err) {
      // The server's 400 (legality check per category and figure — e.g. «El tipo
      // 13 % no es un tipo vigente de IVA (4 / 10 / 21 %)» — or TAX_REGION_MISSING)
      // is shown verbatim and inline: the confirm dialog closes so the message
      // is readable and the editor stays open for the correction.
      const inline = toInlineError(err, pending.kind === "rate" ? "No se pudo guardar el tipo." : "No se pudo restaurar el catálogo.");
      if (pending.kind === "rate") setEditorError(inline);
      else setProvisionError(inline);
      setPending(null);
      showToast(inline.message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleTouristTaxTreatment(value: string) {
    setBusy(true);
    try {
      await patchComplianceSettings(PROPERTY_ID, { touristTaxTreatment: value as TouristTaxTreatment });
      showToast("Tratamiento de la tasa turística guardado.", { variant: "success" });
      await load();
    } catch (err) {
      showToast(errorMessage(err, "No se pudo guardar el tratamiento de la tasa turística."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleIpsiConfirmation(confirmed: boolean) {
    setBusy(true);
    try {
      await patchComplianceSettings(PROPERTY_ID, { ipsiOrdinanceConfirmed: confirmed });
      showToast(confirmed ? "Ordenanza IPSI confirmada." : "Confirmación de la ordenanza IPSI retirada.", { variant: "success" });
      await load();
    } catch (err) {
      showToast(errorMessage(err, "No se pudo registrar la confirmación de la ordenanza."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const regionSourceNote =
    profile?.regionSource === "province"
      ? "La región fiscal se ha derivado de la provincia del establecimiento; confírmala en el perfil."
      : profile?.regionSource === "default"
        ? "La propiedad no tiene región fiscal configurada: se aplica Península y Baleares por defecto. Configúrala en el perfil antes de facturar."
        : null;

  const treatmentValue = profile?.touristTaxTreatment ?? "none";
  const treatmentHint = TOURIST_TAX_TREATMENT_OPTIONS.find((option) => option.value === treatmentValue)?.hint;
  const editingRow = editor ? rows.find((row) => row.category === editor.category) : undefined;

  const sourcesSummary = profile
    ? `${plural(manualRates.length, "manual", "manuales", { withCount: true })} · ${catalogRates.length} de catálogo${
        catalogRates.length > 0
          ? ` (${plural(provisionedRates.length, "provisionado", "provisionados", { withCount: true })}, ${catalogRates.length - provisionedRates.length} sin fila)`
          : ""
      }${
        unknownSourceRates.length > 0 ? ` · ${unknownSourceRates.length} con origen no reconocido (${unknownSourceRates.map((row) => String(row.source)).join(", ")})` : ""
      }${overriddenRates.length > 0 ? ` · ${overriddenRates.length} sobrescribe${overriddenRates.length === 1 ? "" : "n"} el catálogo` : ""}`
    : "";

  const actions = (
    <>
      <CocoaButton variant="plain" size="small" onClick={() => navigateTo("TaxComplianceSettings")}>
        Ajustes fiscales
      </CocoaButton>
      <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FiscalDashboard")}>
        Centro fiscal
      </CocoaButton>
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPending({ kind: "provision" })} disabled={busy || !profile}>
        {RESTORE_LABEL}
      </CocoaButton>
    </>
  );

  // Page states (D27) are CocoaPage's: skeleton while the first load runs, error / empty when there is no profile, else the content.
  const pageState = loading && !profile ? "loading" : error && !profile ? "error" : !profile ? "empty" : "ready";
  const onRetry = () => void load();
  let body: ReactNode = null;
  if (profile) {
    body = (
      <>
        <CocoaScreenInstructionsCard
          title="Impuestos de la propiedad"
          description={TAXES_INSTRUCTIONS.whatIsThis}
          steps={TAXES_INSTRUCTIONS.howToUse}
          tip={TAXES_INSTRUCTIONS.tips[0]}
          dismissible
          persistKey="property-taxes"
        />

        <div className="cocoa-row" data-gap="2" role="group" aria-label="Perfil fiscal de la propiedad">
          <CocoaBadge tone={profile.taxRegion ? "info" : "warning"} uppercase={false}>
            {taxRegionLabel(profile.taxRegion)}
          </CocoaBadge>
          <CocoaBadge tone="neutral" uppercase={false}>
            {profile.figure} · Impuesto {profile.impuesto}
          </CocoaBadge>
          <CocoaBadge tone="neutral" uppercase={false}>
            Región: {profile.regionSource === "property" ? "perfil de la propiedad" : profile.regionSource === "province" ? "derivada de la provincia" : "valor por defecto"}
          </CocoaBadge>
          <span
            className="cocoa-caption"
            title="Tipos configurados por la propiedad (manual) frente a tipos del catálogo estatutario (provisionados como fila propia o respondidos directamente por el catálogo)"
          >
            {sourcesSummary}
          </span>
          {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
        </div>

        {provisionError ? (
          <CocoaCallout
            tone="danger"
            role="alert"
            title={`No se pudo restaurar el catálogo${provisionError.status ? ` (HTTP ${provisionError.status})` : ""}`}
            actions={
              <>
                {provisionError.code === TAX_RATE_ERROR_CODES.regionMissing ? (
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                    {OPEN_PROFILE_LABEL}
                  </CocoaButton>
                ) : null}
                <CocoaButton variant="plain" size="small" onClick={() => setProvisionError(null)}>
                  {ACTIONS.close}
                </CocoaButton>
              </>
            }
          >
            {provisionError.message}
            {provisionError.code ? ` (${provisionError.code})` : ""}
          </CocoaCallout>
        ) : null}

        {regionSourceNote ? (
          <CocoaCallout
            tone="warning"
            title="Región fiscal por confirmar"
            actions={
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                {OPEN_PROFILE_LABEL}
              </CocoaButton>
            }
          >
            {regionSourceNote}
          </CocoaCallout>
        ) : null}

        {warnings.length > 0 ? (
          <CocoaSection title="Avisos del resolutor fiscal" meta={plural(warnings.length, "aviso", "avisos", { withCount: true })}>
            <ul className="c22-section__list">
              {warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          </CocoaSection>
        ) : null}

        {missingCoreRates.length > 0 ? (
          <CocoaCallout tone="danger" title="Faltan tipos obligatorios">
            Faltan tipos para {missingCoreRates.map((row) => row.label.toLowerCase()).join(", ")}: sin ellos la emisión en modo fiscal se bloquea (TAX_NOT_CONFIGURED). Usa
            «{RESTORE_LABEL}» o define cada tipo manualmente.
          </CocoaCallout>
        ) : null}

        <CocoaSection
          title="Tipos por concepto"
          meta={plural(rates.length, "tipo vigente", "tipos vigentes", { withCount: true })}
          padding={rows.length > 0 ? "none" : "md"}
          style={{ overflow: "clip" }}
        >
          {rows.length === 0 ? (
            <CocoaState
              kind="empty"
              title="Sin catálogo fiscal"
              message="La propiedad no tiene tipos configurados. Provisiona el catálogo estatutario para empezar."
              primaryAction={{ label: RESTORE_LABEL, onClick: () => setPending({ kind: "provision" }) }}
            />
          ) : (
            <CocoaTable<RateRowView>
              columns={RATE_COLUMNS}
              rows={rows}
              rowKey="_key"
              rowActionsVisible="always"
              rowActions={(row) => (
                <CocoaButton
                  variant="plain"
                  size="small"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    startEdit(row);
                  }}
                >
                  {row.rate ? ACTIONS.edit : "Definir"}
                </CocoaButton>
              )}
              emptyState="Sin tipos configurados."
              caption="Tipos de impuesto por concepto de folio"
              aria-label="Tipos de impuesto por concepto de folio"
            />
          )}
        </CocoaSection>

        {lineTypeOverrides.length > 0 ? (
          <CocoaSection title="Tipos por tipo de línea de folio" meta={plural(lineTypeOverrides.length, "fila vigente", "filas vigentes", { withCount: true })}>
            <p>
              Filas vigentes vinculadas a un tipo de línea concreto en lugar de a un concepto fiscal (sobrescrituras manuales o semillas heredadas). El resolutor las
              aplica antes que el tipo del concepto; «{RESTORE_LABEL}» no las toca.
            </p>
            <ul className="c22-section__list">
              {lineTypeOverrides.map((row) => (
                <li key={`${row.lineType}-${row.validFrom}`}>
                  <span>
                    <strong>{row.lineType}</strong> · {row.calificacion === "N1" ? "no sujeta (N1)" : fmtPercent(row.ratePercent)} · desde {fmtDate(row.validFrom)} · origen{" "}
                    {taxRateSourceLabel(row.source)}
                  </span>
                </li>
              ))}
            </ul>
          </CocoaSection>
        ) : null}

        {editor ? (
          <CocoaSection
            id={EDITOR_SECTION_ID}
            title={`${editingRow?.rate ? "Sobrescribir" : "Definir"} tipo · ${TAX_CATEGORY_LABELS[editor.category]}`}
            footer={
              <div className="cocoa-row" data-gap="2" data-justify="end">
                <CocoaButton variant="bordered" tone="neutral" onClick={cancelEdit} disabled={busy}>
                  {ACTIONS.cancel}
                </CocoaButton>
                <CocoaButton variant="filled" tone="accent" onClick={requestSaveRate} disabled={busy}>
                  Guardar tipo
                </CocoaButton>
              </div>
            }
          >
            {editorError ? (
              <CocoaCallout
                tone="danger"
                role="alert"
                title={`El servidor rechazó el tipo${editorError.status ? ` (HTTP ${editorError.status})` : ""}`}
                actions={
                  editorError.code === TAX_RATE_ERROR_CODES.regionMissing ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                      {OPEN_PROFILE_LABEL}
                    </CocoaButton>
                  ) : undefined
                }
              >
                {editorError.message}
                {editorError.code ? ` (${editorError.code})` : ""}
                {editorError.code === TAX_RATE_ERROR_CODES.notAllowed && editorError.allowed.length > 0
                  ? ` · Tipos legales de «${TAX_CATEGORY_LABELS[editor.category]}» en ${profile.figure}: ${editorError.allowed.map((value) => fmtPercent(value)).join(" / ")}`
                  : ""}
              </CocoaCallout>
            ) : null}
            <CocoaFormRow columns={3}>
              <CocoaField label="Calificación">
                <CocoaSelect
                  id={EDITOR_FIELD_ID}
                  value={editor.calificacion}
                  onChange={(value) => {
                    setEditorError(null);
                    setEditor({ ...editor, calificacion: value as Calificacion });
                  }}
                  options={CALIFICACION_OPTIONS}
                  disabled={busy}
                />
              </CocoaField>
              <CocoaField label={`Tipo (${profile.figure}) %`} help={editor.calificacion === "N1" ? "Una operación no sujeta no lleva tipo." : "Entre 0 y 100."}>
                <CocoaInput
                  value={editor.ratePercent}
                  onChange={(value) => {
                    setEditorError(null);
                    setEditor({ ...editor, ratePercent: value });
                  }}
                  type="number"
                  inputMode="decimal"
                  disabled={busy || editor.calificacion === "N1"}
                  placeholder={editor.calificacion === "N1" ? "no aplica" : "10"}
                  error={Boolean(editorError)}
                />
              </CocoaField>
              <CocoaField label="Vigente desde">
                <CocoaDatePicker value={editor.validFrom} onChange={(value) => setEditor({ ...editor, validFrom: value })} disabled={busy} />
              </CocoaField>
            </CocoaFormRow>
            <p className="cocoa-caption">El tipo manual prevalece sobre el catálogo a partir de la fecha indicada. Las facturas ya emitidas no cambian.</p>
          </CocoaSection>
        ) : null}

        <CocoaGrid align="start" aria-label="Tasa turística e IPSI">
          <CocoaSpan cols={6} min={320}>
            <CocoaSection title="Tasa turística">
              <CocoaField label="Tratamiento en la factura" help={treatmentHint}>
                <CocoaSelect value={treatmentValue} onChange={(value) => void handleTouristTaxTreatment(value)} options={TREATMENT_OPTIONS} disabled={busy} />
              </CocoaField>
            </CocoaSection>
          </CocoaSpan>
          {isIpsi ? (
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="IPSI · ordenanza municipal">
                <p>
                  Los tipos del IPSI cambian por ordenanza anual y dependen de la categoría del establecimiento (1 % / 2 % / 4 %). El bloqueo de emisión en
                  producción exige confirmar que los tipos coinciden con la ordenanza vigente.
                  {ordinanceRates.length > 0 ? ` Conceptos a verificar: ${ordinanceRates.map((row) => TAX_CATEGORY_LABELS[row.category].toLowerCase()).join(", ")}.` : ""}
                </p>
                <CocoaField
                  inline
                  label="He verificado los tipos con la ordenanza vigente"
                  help={profile.ipsiOrdinanceConfirmedAt ? `Confirmado el ${fmtDate(profile.ipsiOrdinanceConfirmedAt)}.` : "Pendiente de confirmación."}
                >
                  <CocoaSwitch checked={Boolean(profile.ipsiOrdinanceConfirmedAt)} onChange={(value) => void handleIpsiConfirmation(value)} disabled={busy} />
                </CocoaField>
              </CocoaSection>
            </CocoaSpan>
          ) : null}
        </CocoaGrid>

        <CocoaDialog
          open={pending !== null}
          onClose={() => {
            if (!busy) setPending(null);
          }}
          title={pending?.kind === "provision" ? "¿Restaurar los tipos del catálogo?" : "¿Guardar este tipo manual?"}
          description={
            pending?.kind === "provision"
              ? `Se vuelven a aplicar los tipos estatutarios de ${taxRegionLabel(profile.taxRegion)} en los conceptos sin tipo vigente. Los conceptos que ya tienen un tipo (manual o de catálogo) se omiten; el servidor informa de cuántos se han provisionado y cuántos se han omitido.`
              : pending?.kind === "rate"
                ? `${TAX_CATEGORY_LABELS[pending.editor.category]}: ${pending.editor.calificacion === "N1" ? "no sujeta (N1)" : `${pending.editor.ratePercent} % (S1)`} desde ${fmtDate(pending.editor.validFrom)}. Prevalece sobre el catálogo para cargos y facturas posteriores.`
                : undefined
          }
          confirmLabel={ACTIONS.confirm}
          busy={busy}
          onConfirm={confirmPending}
        />
      </>
    );
  }

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Tipos de IVA / IGIC / IPSI por concepto de folio, con su base legal y vigencia."
      actions={actions}
      state={pageState}
      skeleton={<TaxesSkeleton />}
      error={{ title: "No se pudo cargar el perfil fiscal", message: error ?? undefined, onRetry }}
      empty={{ title: "Sin perfil fiscal", message: "La propiedad no devolvió ningún perfil fiscal.", onRetry }}
      commands={[
        { id: "impuestos-restaurar-catalogo", label: `${RESTORE_LABEL} de impuestos`, run: () => setPending({ kind: "provision" }) },
        { id: "impuestos-ajustes-fiscales", label: "Abrir ajustes fiscales", run: () => navigateTo("TaxComplianceSettings") },
        { id: "impuestos-centro-fiscal", label: "Abrir el centro fiscal", run: () => navigateTo("FiscalDashboard") }
      ]}
    >
      {body}
    </CocoaPage>
  );
}

export default PropertyTaxesScreen;
