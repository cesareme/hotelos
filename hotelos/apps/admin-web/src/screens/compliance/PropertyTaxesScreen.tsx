// Impuestos de la propiedad (Tanda 3 · lote front-fiscal · cierre).
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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState, ErrorState, LoadingBlock } from "../../components/States";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { pageHead } from "../tabs/configuracion/tab-helpers";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { TAXES_INSTRUCTIONS } from "../../content/screen-instructions/taxes";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { date, percent } from "../../lib/format";

const PROPERTY_ID = getActivePropertyId();

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

export function PropertyTaxesScreen({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: render a section head instead.
  const Head = pageHead(embedded);
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

  function requestSaveRate() {
    if (!editor) return;
    const percent = Number(editor.ratePercent.replace(",", "."));
    if (editor.calificacion === "S1" && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
      showToast("Indica un tipo entre 0 y 100.", { variant: "error" });
      return;
    }
    if (editor.calificacion === "S1" && percent === 0 && editor.category !== "not_subject") {
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
        const percent = pending.editor.calificacion === "N1" ? 0 : Number(pending.editor.ratePercent.replace(",", "."));
        await upsertPropertyTaxRate(PROPERTY_ID, {
          category: pending.editor.category,
          ratePercent: percent,
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

  const columns = useMemo<CocoaTableColumn<RateRowView>[]>(
    () => [
      { key: "label", label: "Concepto", render: (row) => <strong>{row.label}</strong> },
      {
        key: "rate",
        label: "Tipo",
        align: "right",
        width: "110px",
        render: (row) =>
          row.rate ? (
            row.rate.calificacion === "N1" ? <span className="bo-muted">no sujeta</span> : fmtPercent(row.rate.ratePercent)
          ) : (
            <span className="bo-status warn" style={{ textTransform: "none" }} title="No hay tipo configurado ni en la BD ni en el catálogo para este concepto">
              sin tipo
            </span>
          )
      },
      {
        key: "calificacion",
        label: "Calificación",
        width: "150px",
        render: (row) => (row.rate ? CALIFICACION_LABELS[row.rate.calificacion] : "—")
      },
      {
        key: "source",
        label: "Fuente",
        width: "170px",
        render: (row) =>
          row.rate ? (
            <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              <span
                className={`bo-status ${isManualTaxSource(row.rate.source) ? "info" : isCatalogTaxSource(row.rate.source) ? "ok" : "warn"}`}
                style={{ textTransform: "none" }}
                title={taxRateSourceDetail(row.rate.source)}
              >
                {taxRateSourceLabel(row.rate.source)}
              </span>
              {isCatalogTaxSource(row.rate.source) ? (
                <span className="bo-muted" style={{ fontSize: 11 }} title={taxRateSourceDetail(row.rate.source)}>
                  {isProvisionedTaxSource(row.rate.source) ? "provisionado" : "sin fila"}
                </span>
              ) : null}
              {row.rate.overridden ? (
                <span className="bo-status warn" style={{ textTransform: "none" }} title="Un tipo manual oculta el tipo del catálogo para este concepto">
                  sobrescribe el catálogo
                </span>
              ) : null}
            </span>
          ) : (
            "—"
          )
      },
      {
        key: "legalBasis",
        label: "Base legal",
        render: (row) => (row.rate?.legalBasis ? <span className="bo-muted">{row.rate.legalBasis}</span> : "—")
      },
      { key: "validFrom", label: "Vigente desde", width: "130px", render: (row) => fmtDate(row.rate?.validFrom) },
      {
        key: "actions",
        label: "",
        align: "right",
        width: "100px",
        render: (row) => (
          <CocoaButton variant="plain" size="small" onClick={() => startEdit(row)} disabled={busy}>
            {row.rate ? "Editar" : "Definir"}
          </CocoaButton>
        )
      }
    ],
    [busy]
  );

  if (loading && !profile) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando impuestos de la propiedad…" />
      </section>
    );
  }
  if (error && !profile) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudo cargar el perfil fiscal" message={error} onRetry={() => void load()} />
      </section>
    );
  }
  if (!profile) return null;

  const regionSourceNote =
    profile.regionSource === "province"
      ? "La región fiscal se ha derivado de la provincia del establecimiento; confírmala en el perfil."
      : profile.regionSource === "default"
        ? "La propiedad no tiene región fiscal configurada: se aplica Península y Baleares por defecto. Configúrala en el perfil antes de facturar."
        : null;

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <Head
        eyebrow="Cumplimiento · Fiscal"
        title="Impuestos de la propiedad"
        subtitle="Tipos de IVA / IGIC / IPSI por concepto de folio, con su base legal y vigencia"
        actions={
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}>
            <CocoaButton variant="plain" onClick={() => navigateTo("TaxComplianceSettings")}>
              Ajustes fiscales
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("FiscalDashboard")}>
              Centro fiscal
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setPending({ kind: "provision" })} disabled={busy}>
              Restaurar catálogo
            </CocoaButton>
          </span>
        }
      />

      <CocoaScreenInstructionsCard
        title="Impuestos de la propiedad"
        description={TAXES_INSTRUCTIONS.whatIsThis}
        steps={TAXES_INSTRUCTIONS.howToUse}
        tip={TAXES_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="property-taxes"
      />

      <div className="bo-pill-row" style={{ display: "flex", flexWrap: "wrap", gap: "var(--cocoa-space-2)", alignItems: "center" }}>
        <span className={`bo-status ${profile.taxRegion ? "info" : "warn"}`} style={{ textTransform: "none" }}>
          {taxRegionLabel(profile.taxRegion)}
        </span>
        <span className="bo-chip">
          {profile.figure} · Impuesto {profile.impuesto}
        </span>
        <span className="bo-chip">
          Región: {profile.regionSource === "property" ? "perfil de la propiedad" : profile.regionSource === "province" ? "derivada de la provincia" : "valor por defecto"}
        </span>
        <span
          className="bo-chip"
          title="Tipos configurados por la propiedad (manual) frente a tipos del catálogo estatutario (provisionados como fila propia o respondidos directamente por el catálogo)"
        >
          {manualRates.length} manual{manualRates.length === 1 ? "" : "es"} · {catalogRates.length} de catálogo
          {catalogRates.length > 0
            ? ` (${provisionedRates.length} provisionado${provisionedRates.length === 1 ? "" : "s"}, ${catalogRates.length - provisionedRates.length} sin fila)`
            : ""}
          {unknownSourceRates.length > 0
            ? ` · ${unknownSourceRates.length} con origen no reconocido (${unknownSourceRates.map((row) => String(row.source)).join(", ")})`
            : ""}
          {overriddenRates.length > 0 ? ` · ${overriddenRates.length} sobrescribe${overriddenRates.length === 1 ? "" : "n"} el catálogo` : ""}
        </span>
        {loading ? <span className="bo-muted">Actualizando…</span> : null}
      </div>

      {provisionError ? (
        <div className="bo-status error" style={{ textTransform: "none", display: "flex", justifyContent: "space-between", gap: "var(--cocoa-space-3)", alignItems: "center", flexWrap: "wrap" }}>
          <span>
            No se pudo restaurar el catálogo{provisionError.status ? ` (HTTP ${provisionError.status})` : ""}: {provisionError.message}
            {provisionError.code ? <span className="bo-muted"> ({provisionError.code})</span> : null}
          </span>
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)" }}>
            {provisionError.code === TAX_RATE_ERROR_CODES.regionMissing ? (
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                Abrir perfil del establecimiento
              </CocoaButton>
            ) : null}
            <CocoaButton variant="plain" size="small" onClick={() => setProvisionError(null)}>
              Cerrar
            </CocoaButton>
          </span>
        </div>
      ) : null}

      {regionSourceNote ? (
        <div className="bo-status warn" style={{ textTransform: "none", display: "flex", justifyContent: "space-between", gap: "var(--cocoa-space-3)", alignItems: "center", flexWrap: "wrap" }}>
          <span>{regionSourceNote}</span>
          <CocoaButton variant="plain" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
            Abrir perfil del establecimiento
          </CocoaButton>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <CocoaCard variant="bordered" padding="md">
          <p className="bo-muted" style={{ marginTop: 0 }}>Avisos del resolutor fiscal</p>
          <ul style={{ margin: 0, paddingLeft: "1.2em", display: "grid", gap: "var(--cocoa-space-1)" }}>
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </CocoaCard>
      ) : null}

      {missingCoreRates.length > 0 ? (
        <div className="bo-status error" style={{ textTransform: "none" }}>
          Faltan tipos para {missingCoreRates.map((row) => row.label.toLowerCase()).join(", ")}: sin ellos la emisión en modo fiscal se bloquea (TAX_NOT_CONFIGURED).
          Usa «Restaurar catálogo» o define cada tipo manualmente.
        </div>
      ) : null}

      <div>
        <h3 style={{ marginBottom: "var(--cocoa-space-3)" }}>Tipos por concepto</h3>
        {rows.length === 0 ? (
          <EmptyState title="Sin catálogo fiscal" message="La propiedad no tiene tipos configurados. Provisiona el catálogo estatutario para empezar." />
        ) : (
          <CocoaTable<RateRowView> columns={columns} rows={rows} rowKey="_key" emptyState="Sin tipos configurados." />
        )}
      </div>

      {lineTypeOverrides.length > 0 ? (
        <CocoaCard variant="bordered" padding="md">
          <p className="bo-muted" style={{ marginTop: 0 }}>Tipos por tipo de línea de folio</p>
          <p style={{ marginTop: 0 }}>
            Filas vigentes vinculadas a un tipo de línea concreto en lugar de a un concepto fiscal (sobrescrituras manuales o semillas heredadas). El
            resolutor las aplica antes que el tipo del concepto; «Restaurar catálogo» no las toca.
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.2em", display: "grid", gap: "var(--cocoa-space-1)" }}>
            {lineTypeOverrides.map((row) => (
              <li key={`${row.lineType}-${row.validFrom}`}>
                <strong>{row.lineType}</strong> · {row.calificacion === "N1" ? "no sujeta (N1)" : fmtPercent(row.ratePercent)} · desde {fmtDate(row.validFrom)} ·
                origen {taxRateSourceLabel(row.source)}
              </li>
            ))}
          </ul>
        </CocoaCard>
      ) : null}

      {editor ? (
        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>
              {rows.find((row) => row.category === editor.category)?.rate ? "Sobrescribir" : "Definir"} tipo · {TAX_CATEGORY_LABELS[editor.category]}
            </h3>
            <CocoaButton
              variant="plain"
              size="small"
              onClick={() => {
                setEditor(null);
                setEditorError(null);
              }}
              disabled={busy}
            >
              Cancelar
            </CocoaButton>
          </div>
          {editorError ? (
            <div className="bo-status error" style={{ textTransform: "none", display: "flex", justifyContent: "space-between", gap: "var(--cocoa-space-3)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--cocoa-space-3)" }}>
              <span>
                El servidor rechazó el tipo{editorError.status ? ` (HTTP ${editorError.status})` : ""}: {editorError.message}
                {editorError.code ? <span className="bo-muted"> ({editorError.code})</span> : null}
                {editorError.code === TAX_RATE_ERROR_CODES.notAllowed && editorError.allowed.length > 0 ? (
                  <span className="bo-muted">
                    {" "}
                    · Tipos legales de «{TAX_CATEGORY_LABELS[editor.category]}» en {profile.figure}: {editorError.allowed.map((percent) => fmtPercent(percent)).join(" / ")}
                  </span>
                ) : null}
              </span>
              {editorError.code === TAX_RATE_ERROR_CODES.regionMissing ? (
                <CocoaButton variant="plain" size="small" onClick={() => navigateTo("PropertyProfileSetupForm")}>
                  Abrir perfil del establecimiento
                </CocoaButton>
              ) : null}
            </div>
          ) : null}
          <div className="bo-grid three">
            <label className="bo-form-field">
              <span>Calificación</span>
              <CocoaSelect
                value={editor.calificacion}
                onChange={(value) => {
                  setEditorError(null);
                  setEditor({ ...editor, calificacion: value as Calificacion });
                }}
                options={[
                  { value: "S1", label: CALIFICACION_LABELS.S1 },
                  { value: "N1", label: CALIFICACION_LABELS.N1 }
                ]}
              />
            </label>
            <label className="bo-form-field">
              <span>Tipo ({profile.figure}) %</span>
              <CocoaInput
                value={editor.ratePercent}
                onChange={(value) => {
                  setEditorError(null);
                  setEditor({ ...editor, ratePercent: value });
                }}
                type="number"
                inputMode="decimal"
                disabled={editor.calificacion === "N1"}
                placeholder={editor.calificacion === "N1" ? "no aplica" : "10"}
                error={Boolean(editorError)}
              />
            </label>
            <label className="bo-form-field">
              <span>Vigente desde</span>
              <input type="date" value={editor.validFrom} onChange={(event) => setEditor({ ...editor, validFrom: event.currentTarget.value })} />
            </label>
          </div>
          <p className="bo-muted" style={{ marginBottom: "var(--cocoa-space-3)" }}>
            El tipo manual prevalece sobre el catálogo a partir de la fecha indicada. Las facturas ya emitidas no cambian.
          </p>
          <div className="bo-actions">
            <CocoaButton variant="filled" tone="accent" onClick={requestSaveRate} disabled={busy}>
              Guardar tipo
            </CocoaButton>
          </div>
        </CocoaCard>
      ) : null}

      <div className="bo-grid two">
        <CocoaCard variant="bordered" padding="md">
          <p className="bo-muted" style={{ marginTop: 0 }}>Tasa turística</p>
          <label className="bo-form-field">
            <span>Tratamiento en la factura</span>
            <CocoaSelect
              value={profile.touristTaxTreatment ?? "none"}
              onChange={(value) => void handleTouristTaxTreatment(value)}
              options={TOURIST_TAX_TREATMENT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              disabled={busy}
            />
          </label>
          <small className="bo-muted">
            {TOURIST_TAX_TREATMENT_OPTIONS.find((option) => option.value === (profile.touristTaxTreatment ?? "none"))?.hint}
          </small>
        </CocoaCard>

        {isIpsi ? (
          <CocoaCard variant="bordered" padding="md">
            <p className="bo-muted" style={{ marginTop: 0 }}>IPSI · ordenanza municipal</p>
            <p style={{ marginTop: 0 }}>
              Los tipos del IPSI cambian por ordenanza anual y dependen de la categoría del establecimiento (1 % / 2 % / 4 %). El bloqueo de emisión en
              producción exige confirmar que los tipos coinciden con la ordenanza vigente.
              {ordinanceRates.length > 0 ? ` Conceptos a verificar: ${ordinanceRates.map((row) => TAX_CATEGORY_LABELS[row.category].toLowerCase()).join(", ")}.` : ""}
            </p>
            <label className="bo-form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={Boolean(profile.ipsiOrdinanceConfirmedAt)}
                onChange={(event) => void handleIpsiConfirmation(event.currentTarget.checked)}
                disabled={busy}
                style={{ width: "auto" }}
              />
              <span style={{ fontWeight: 500 }}>He verificado los tipos con la ordenanza vigente</span>
            </label>
            <small className="bo-muted">
              {profile.ipsiOrdinanceConfirmedAt ? `Confirmado el ${fmtDate(profile.ipsiOrdinanceConfirmedAt)}.` : "Pendiente de confirmación."}
            </small>
          </CocoaCard>
        ) : null}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "provision" ? "¿Restaurar los tipos del catálogo?" : "¿Guardar este tipo manual?"}
        description={
          pending?.kind === "provision"
            ? `Se vuelven a aplicar los tipos estatutarios de ${taxRegionLabel(profile.taxRegion)} en los conceptos sin tipo vigente. Los conceptos que ya tienen un tipo (manual o de catálogo) se omiten; el servidor informa de cuántos se han provisionado y cuántos se han omitido.`
            : pending?.kind === "rate"
              ? `${TAX_CATEGORY_LABELS[pending.editor.category]}: ${pending.editor.calificacion === "N1" ? "no sujeta (N1)" : `${pending.editor.ratePercent} % (S1)`} desde ${fmtDate(pending.editor.validFrom)}. Prevalece sobre el catálogo para cargos y facturas posteriores.`
              : undefined
        }
        confirmLabel={busy ? "Guardando…" : "Confirmar"}
        variant="primary"
        onConfirm={() => void confirmPending()}
        onCancel={() => (busy ? undefined : setPending(null))}
      />
    </section>
  );
}

export default PropertyTaxesScreen;
