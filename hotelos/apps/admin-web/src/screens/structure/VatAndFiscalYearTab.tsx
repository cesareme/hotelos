// Configuración › Estructura societaria › IVA y ejercicio —
// /configuracion/estructura-societaria/iva-ejercicio (Tanda 6b · L6; design §5.3, R8/R9).
// Two forms on the same page:
//   · Ajustes de IVA de la sociedad (GET/PUT /fiscal/vat-settings: periodicidad,
//     régimen, prorrata, figura impositiva) — 409 PERIODICITY_FORCED_BY_REGIME
//     when the regime forces monthly, REDEME_REQUIRES_MONTHLY;
//   · Régimen de la sociedad (PATCH /legal-entities/:id): «Gran empresa» and
//     «Sociedad en el SII» switches, variante del PGC with the LSC thresholds
//     warning and mes de inicio del ejercicio — all HIGH RISK: a destructive-tone
//     confirmation resends with `confirmHighRisk: true`; 409
//     VERIFACTU_SUBMISSIONS_PENDING is a blocking callout. Both need
//     organization.structure.manage AND accounting.configure.
// GET /fiscal/regime?year= paints the volumen de operaciones, the threshold and
// the proposal of RIVA 71.3 (the API never writes it). The SII itself (sending
// the books) is not built: the page says so.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PgcVariant, VatSettingsDto } from "@hotelos/shared";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaSwitch
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { money, number, percent } from "../../lib/format";
import { getVatSettings, putVatSettings, type VatSettingsPatch } from "../../services/fiscalApi";
import { getFiscalRegime, patchLegalEntity, type FiscalRegimeReport, type LegalEntityPatchBody } from "../../services/structureApi";
import { useTabHost } from "../tabs/TabHost";
import { MONTH_OPTIONS, TAX_FIGURE_OPTIONS, VAT_PERIODICITY_OPTIONS, VAT_REGIME_OPTIONS, vatPeriodicityLabel } from "../accounting/accounting-ui";
import { StructureActions, StructureSplit, structurePageProps, useWizardState } from "./StructureScreen";
import { currentFiscalYear, useStructureModel } from "./structure-model";
import { PGC_VARIANT_OPTIONS, describeChangeValue, highRiskChangesOf, highRiskFieldLabel, pgcVariantWarning, structureErrorCode, structureErrorMessage } from "./structure-ui";

type VatDraft = { periodicity: string; regime: string; prorrataPct: string; taxFigure: string };
type RegimeDraft = { largeCompany: boolean; siiEnabled: boolean; pgcVariant: PgcVariant; fiscalYearStartMonth: string };

function vatDraftOf(settings: VatSettingsDto): VatDraft {
  return {
    periodicity: settings.sociedad.regimen.persistedPeriodicity ?? settings.periodicity,
    regime: settings.regime,
    prorrataPct: settings.prorrataPct === null ? "" : String(settings.prorrataPct).replace(".", ","),
    taxFigure: settings.taxFigure
  };
}

const REGIME_REASONS: Record<string, string> = {
  siiEnabled: "303, 111 y 115 mensuales (RIVA art. 71.3), 347 y 390 «no se presenta» y VeriFactu deja de aplicar (RD 1007/2023 art. 3.3).",
  largeCompany: "Periodicidad mensual forzada en 303, 111 y 115 (RIVA art. 71.3) y formato de cuentas anuales condicionado.",
  pgcVariant: "Decide qué formato de cuentas anuales es depositable (LSC arts. 257-258).",
  fiscalYearStartMonth: "Redefine el ejercicio social: ejercicios, regularización, cierre y apertura lo siguen."
};

export function StructureVatTab() {
  const hosted = useTabHost() !== null;
  const model = useStructureModel("vat");
  const wizard = useWizardState();
  const { showToast } = useToast();
  const entity = model.legalEntity;
  const canEdit = model.permissions.manage && model.permissions.configureAccounting && !model.redacted;
  const canEditVat = model.permissions.configureAccounting && !model.redacted;

  // ---- VAT settings --------------------------------------------------------------
  const [vat, setVat] = useState<VatSettingsDto | null>(null);
  const [vatError, setVatError] = useState<unknown>(null);
  const [vatNonce, setVatNonce] = useState(0);
  const [regimeReport, setRegimeReport] = useState<FiscalRegimeReport | null>(null);
  const [regimeError, setRegimeError] = useState<unknown>(null);
  useEffect(() => {
    if (model.redacted || !model.structure) return;
    let mounted = true;
    setVatError(null);
    getVatSettings()
      .then((settings) => {
        if (mounted) setVat(settings);
      })
      .catch((err: unknown) => {
        if (mounted) setVatError(err);
      });
    getFiscalRegime(currentFiscalYear())
      .then((report) => {
        if (mounted) setRegimeReport(report);
      })
      .catch((err: unknown) => {
        if (mounted) setRegimeError(err);
      });
    return () => {
      mounted = false;
    };
  }, [vatNonce, model.redacted, model.structure]);

  const vatSaved = useMemo(() => (vat ? vatDraftOf(vat) : null), [vat]);
  const [vatDraft, setVatDraft] = useState<VatDraft | null>(null);
  useEffect(() => {
    setVatDraft(vatSaved);
  }, [vatSaved]);
  const vatDirty = vatDraft !== null && vatSaved !== null && (Object.keys(vatDraft) as Array<keyof VatDraft>).some((key) => vatDraft[key] !== vatSaved[key]);
  const prorrata = vatDraft && vatDraft.prorrataPct.trim() !== "" ? Number(vatDraft.prorrataPct.replace(",", ".")) : null;
  const prorrataError = vatDraft && vatDraft.prorrataPct.trim() !== "" && (prorrata === null || Number.isNaN(prorrata) || prorrata < 0 || prorrata > 100) ? "La prorrata es un porcentaje entre 0 y 100 (vacío = deducción íntegra)." : undefined;
  const forcedBy = vat?.sociedad.regimen.periodicityForcedBy ?? null;
  const [vatSaving, setVatSaving] = useState(false);
  const [vatFailure, setVatFailure] = useState<string | null>(null);

  function setVatField<K extends keyof VatDraft>(key: K, value: VatDraft[K]) {
    setVatDraft((current) => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      if (key === "regime" && value === "redeme") next.periodicity = "monthly";
      return next;
    });
    setVatFailure(null);
  }

  async function saveVat() {
    if (!vatDraft || !vatSaved || !vatDirty || prorrataError || vatSaving) return;
    const body: VatSettingsPatch = {};
    if (vatDraft.periodicity !== vatSaved.periodicity) body.periodicity = vatDraft.periodicity as VatSettingsPatch["periodicity"];
    if (vatDraft.regime !== vatSaved.regime) body.regime = vatDraft.regime as VatSettingsPatch["regime"];
    if (vatDraft.taxFigure !== vatSaved.taxFigure) body.taxFigure = vatDraft.taxFigure as VatSettingsPatch["taxFigure"];
    if (vatDraft.prorrataPct !== vatSaved.prorrataPct) body.prorrataPct = prorrata;
    setVatSaving(true);
    setVatFailure(null);
    try {
      const next = await putVatSettings(body);
      setVat(next);
      showToast("Ajustes de IVA de la sociedad guardados.", { variant: "success" });
    } catch (err) {
      setVatFailure(structureErrorMessage(err, STATUS_LABELS.saveError));
    } finally {
      setVatSaving(false);
    }
  }

  // ---- Régimen de la sociedad (high risk) -------------------------------------------
  const regimeSaved = useMemo<RegimeDraft | null>(
    () => (entity ? { largeCompany: entity.largeCompany, siiEnabled: entity.siiEnabled, pgcVariant: entity.pgcVariant, fiscalYearStartMonth: String(entity.fiscalYearStartMonth) } : null),
    [entity]
  );
  const [regimeDraft, setRegimeDraft] = useState<RegimeDraft | null>(null);
  useEffect(() => {
    setRegimeDraft(regimeSaved);
  }, [regimeSaved]);
  const regimeBody = useMemo<LegalEntityPatchBody>(() => {
    if (!regimeDraft || !regimeSaved) return {};
    const body: LegalEntityPatchBody = {};
    if (regimeDraft.largeCompany !== regimeSaved.largeCompany) body.largeCompany = regimeDraft.largeCompany;
    if (regimeDraft.siiEnabled !== regimeSaved.siiEnabled) body.siiEnabled = regimeDraft.siiEnabled;
    if (regimeDraft.pgcVariant !== regimeSaved.pgcVariant) body.pgcVariant = regimeDraft.pgcVariant;
    if (regimeDraft.fiscalYearStartMonth !== regimeSaved.fiscalYearStartMonth) body.fiscalYearStartMonth = Number(regimeDraft.fiscalYearStartMonth);
    return body;
  }, [regimeDraft, regimeSaved]);
  const regimeDirty = Object.keys(regimeBody).length > 0;
  const [regimeSaving, setRegimeSaving] = useState(false);
  const [regimeFailure, setRegimeFailure] = useState<{ blocking: boolean; message: string } | null>(null);
  const [confirm, setConfirm] = useState<{ body: LegalEntityPatchBody; changes: Array<{ field: string; from: unknown; to: unknown }> } | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);

  function setRegime<K extends keyof RegimeDraft>(key: K, value: RegimeDraft[K]) {
    setRegimeDraft((current) => (current ? { ...current, [key]: value } : current));
    setRegimeFailure(null);
  }

  async function submitRegime(body: LegalEntityPatchBody) {
    if (!entity) return;
    setRegimeSaving(true);
    setRegimeFailure(null);
    try {
      const response = await patchLegalEntity(entity.id, body);
      const { warnings, ...dto } = response;
      void warnings;
      model.patchLegalEntityLocally(dto);
      setConfirm(null);
      setVatNonce((n) => n + 1);
      showToast("Régimen de la sociedad actualizado.", { variant: "success" });
    } catch (err) {
      const code = structureErrorCode(err);
      if (code === "HIGH_RISK_CONFIRMATION_REQUIRED") {
        setConfirm({ body: { ...body, confirmHighRisk: true }, changes: highRiskChangesOf(err) });
        return;
      }
      setRegimeFailure({ blocking: code === "VERIFACTU_SUBMISSIONS_PENDING", message: structureErrorMessage(err, STATUS_LABELS.saveError) });
    } finally {
      setRegimeSaving(false);
    }
  }

  function saveRegime() {
    if (!entity || !regimeSaved || !regimeDirty || regimeSaving) return;
    const changes = (Object.keys(regimeBody) as Array<keyof LegalEntityPatchBody>).map((field) => ({
      field,
      from: field === "fiscalYearStartMonth" ? Number(regimeSaved.fiscalYearStartMonth) : regimeSaved[field as keyof RegimeDraft],
      to: regimeBody[field]
    }));
    setConfirm({ body: { ...regimeBody, confirmHighRisk: true }, changes });
  }

  const discard = confirmDiscard();
  const regimen = vat?.sociedad.regimen ?? regimeReport?.sociedad.regimen ?? null;

  let content: ReactNode = null;
  if (model.structure && !entity) {
    content = (
      <CocoaSection aria-label="Sociedad pendiente">
        <CocoaState kind="empty" title="Sociedad pendiente" message="Sin sociedad no hay régimen que configurar." illustration="box" />
      </CocoaSection>
    );
  } else if (model.redacted) {
    content = (
      <CocoaSection aria-label="Sin acceso al régimen">
        <CocoaState kind="empty" title="Sin acceso al régimen de la sociedad" message="El IVA y el ejercicio son de toda la sociedad: los ve quien tiene el permiso «Finanzas de toda la sociedad»." illustration="box" />
      </CocoaSection>
    );
  } else if (entity && regimeDraft && regimeSaved) {
    content = (
      <>
        {regimen ? (
          <CocoaKpiStrip aria-label="Régimen vigente">
            <CocoaKpi label="Periodicidad efectiva" value={vatPeriodicityLabel(regimen.periodicity)} caption={forcedBy === "sii" ? "forzada por el SII" : forcedBy === "large_company" ? "forzada por gran empresa" : "la guardada en Ajustes de IVA"} polarity="neutral" status={forcedBy ? "warning" : "ok"} />
            <CocoaKpi label="VeriFactu" value={regimen.verifactu.aplica ? "Aplica" : "No aplica"} caption={regimen.verifactu.motivo ?? "obligado tributario del RRSIF"} polarity="neutral" status={regimen.verifactu.aplica ? "ok" : "warning"} />
            <CocoaKpi label="Modelos no presentados" value={regimen.modelosNoPresentados.length > 0 ? regimen.modelosNoPresentados.join(" · ") : "Ninguno"} caption={regimen.modelosNoPresentados.length > 0 ? "exonerados por el SII" : "347 y 390 se presentan"} polarity="neutral" />
          </CocoaKpiStrip>
        ) : null}

        {regimeReport ? (
          <CocoaCallout tone={regimeReport.propuesta.cambia ? "warning" : "info"} title={`Propuesta de régimen ${number(regimeReport.year)}`} role="status">
            {regimeReport.propuesta.motivo}
            {regimeReport.volumenOperaciones !== null ? ` Volumen de operaciones: ${money(regimeReport.volumenOperaciones)} · umbral ${money(regimeReport.umbralGranEmpresa)}.` : " Sin libros del ejercicio: el volumen de operaciones no se puede calcular todavía."}
          </CocoaCallout>
        ) : regimeError ? (
          <CocoaState kind="degraded" inline title="Propuesta de régimen no disponible" message={structureErrorMessage(regimeError)} />
        ) : null}

        {!canEdit ? (
          <CocoaCallout tone="info" title="Solo lectura">
            El régimen de la sociedad (SII, gran empresa, PGC, ejercicio) lo cambia quien gestiona la estructura y configura la contabilidad; los ajustes de IVA, quien configura la contabilidad.
          </CocoaCallout>
        ) : null}

        <CocoaFormSection title="Régimen de la sociedad" description="Una sola fuente para toda la sociedad: gran empresa y SII gobiernan la periodicidad de 303, 111 y 115, los modelos anuales y si VeriFactu aplica. El envío de libros al SII no está construido: aquí solo se declara el régimen.">
          {regimeFailure ? (
            <CocoaCallout tone="danger" title={regimeFailure.blocking ? "Cambio bloqueado" : "No se pudo guardar"} role="alert">
              {regimeFailure.message}
            </CocoaCallout>
          ) : null}
          <CocoaFormRow columns={2}>
            <CocoaField label="Gran empresa" inline help="Volumen de operaciones del año anterior superior a 6.010.121,04 €: 303, 111 y 115 mensuales.">
              <CocoaSwitch checked={regimeDraft.largeCompany} onChange={(value) => setRegime("largeCompany", value)} size="small" disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="Sociedad acogida al SII" inline help="Libros a la AEAT en 4 días; 347 y 390 no se presentan; VeriFactu no aplica.">
              <CocoaSwitch checked={regimeDraft.siiEnabled} onChange={(value) => setRegime("siiEnabled", value)} size="small" disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="Variante del PGC" required help={pgcVariantWarning(regimeDraft.pgcVariant, regimeDraft.largeCompany) ?? undefined}>
              <CocoaSelect value={regimeDraft.pgcVariant} onChange={(value) => setRegime("pgcVariant", value as PgcVariant)} options={[...PGC_VARIANT_OPTIONS]} disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="Mes de inicio del ejercicio" required help="Enero para el año natural.">
              <CocoaSelect value={regimeDraft.fiscalYearStartMonth} onChange={(value) => setRegime("fiscalYearStartMonth", value)} options={[...MONTH_OPTIONS]} disabled={!canEdit} />
            </CocoaField>
          </CocoaFormRow>
          {regimeDraft.siiEnabled && !regimeSaved.siiEnabled ? (
            <CocoaCallout tone="warning" title="Acoger la sociedad al SII">
              La factura se expedirá sin huella ni QR VeriFactu y sin envío a la AEAT; los registros VeriFactu reales pendientes de respuesta bloquean el cambio hasta resolverse.
            </CocoaCallout>
          ) : null}
        </CocoaFormSection>

        <CocoaFormSection title="Ajustes de IVA" description={vat?.persisted ? "Periodicidad y régimen con los que se agrupan los libros registro y se calcula el modelo 303." : "Aún no se han guardado ajustes de IVA: se muestran los valores por defecto (trimestral, régimen general, IVA)."}>
          {vatError ? (
            <CocoaState kind="error" inline title="No se pudieron cargar los ajustes de IVA" message={structureErrorMessage(vatError)} onRetry={() => setVatNonce((n) => n + 1)} />
          ) : !vatDraft ? (
            <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
          ) : (
            <>
              {vatFailure ? (
                <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
                  {vatFailure}
                </CocoaCallout>
              ) : null}
              {forcedBy ? (
                <CocoaCallout tone="warning" title="Periodicidad fijada por el régimen">
                  {forcedBy === "sii" ? "La sociedad está en el SII" : "La sociedad es gran empresa"}: los modelos son mensuales mientras esté marcado, aunque aquí se guarde otra periodicidad.
                </CocoaCallout>
              ) : null}
              <CocoaFormRow columns={2}>
                <CocoaField label="Régimen" required>
                  <CocoaSelect value={vatDraft.regime} onChange={(value) => setVatField("regime", value)} options={[...VAT_REGIME_OPTIONS]} disabled={!canEditVat} />
                </CocoaField>
                <CocoaField label="Periodicidad" required help={vatDraft.regime === "redeme" ? "La devolución mensual obliga a liquidar cada mes." : "Trimestral salvo REDEME, SII o gran empresa."}>
                  <CocoaSelect value={vatDraft.periodicity} onChange={(value) => setVatField("periodicity", value)} options={[...VAT_PERIODICITY_OPTIONS]} disabled={!canEditVat || vatDraft.regime === "redeme" || forcedBy !== null} />
                </CocoaField>
                <CocoaField label="Figura impositiva" required help="Determina el impuesto de los libros registro; Canarias, Ceuta y Melilla quedan fuera del modelo 303.">
                  <CocoaSelect value={vatDraft.taxFigure} onChange={(value) => setVatField("taxFigure", value)} options={[...TAX_FIGURE_OPTIONS]} disabled={!canEditVat} />
                </CocoaField>
                <CocoaField label="Prorrata" hint="opcional" error={prorrataError} help={prorrata !== null && !prorrataError ? `Se deduce el ${percent(prorrata, { maximumFractionDigits: 2 })} del IVA soportado.` : "Porcentaje de IVA soportado deducible cuando hay actividad exenta; vacío = deducción íntegra."}>
                  <CocoaInput value={vatDraft.prorrataPct} onChange={(value) => setVatField("prorrataPct", value)} inputMode="decimal" placeholder="Deducción íntegra" rightSlot={<span aria-hidden="true">%</span>} disabled={!canEditVat} />
                </CocoaField>
              </CocoaFormRow>
              <div className="cocoa-cluster">
                {vat?.sociedad ? (
                  <CocoaBadge tone="neutral" uppercase={false}>
                    Declarante · {vat.sociedad.legalName}
                    {vat.sociedad.taxId ? ` · ${vat.sociedad.taxId}` : ""}
                  </CocoaBadge>
                ) : null}
              </div>
            </>
          )}
        </CocoaFormSection>

        {canEdit || canEditVat ? (
          <CocoaActionBar
            aria-label="Acciones de IVA y ejercicio"
            status={regimeDirty && vatDirty ? "Régimen y ajustes de IVA sin guardar" : regimeDirty ? "Régimen de la sociedad sin guardar" : vatDirty ? "Ajustes de IVA sin guardar" : undefined}
            secondary={{ label: ACTIONS.cancel, disabled: (!regimeDirty && !vatDirty) || regimeSaving || vatSaving, onClick: () => setAskDiscard(true) }}
            primary={{
              label: regimeSaving || vatSaving ? STATUS_LABELS.saving : regimeDirty ? "Confirmar el régimen" : ACTIONS.save,
              loading: regimeSaving || vatSaving,
              disabled: (!regimeDirty && !vatDirty) || Boolean(prorrataError) || regimeSaving || vatSaving,
              onClick: () => {
                if (vatDirty) void saveVat();
                if (regimeDirty) saveRegime();
              }
            }}
            publishToastOffset
          />
        ) : null}

        <CocoaDialog
          open={askDiscard}
          onClose={() => setAskDiscard(false)}
          tone="destructive"
          title={discard.title}
          description={discard.message}
          confirmLabel={discard.confirmLabel}
          cancelLabel={discard.cancelLabel}
          onConfirm={() => {
            setRegimeDraft(regimeSaved);
            setVatDraft(vatSaved);
            setAskDiscard(false);
          }}
        />

        <CocoaDialog
          open={confirm !== null}
          onClose={() => setConfirm(null)}
          tone="destructive"
          title="Confirmar el cambio de régimen de la sociedad"
          description="Cambio de alto riesgo: afecta a los modelos, a la periodicidad y a VeriFactu de toda la sociedad desde ahora. Nada emitido se reescribe."
          confirmLabel="Aplicar el cambio"
          cancelLabel={ACTIONS.cancel}
          busy={regimeSaving}
          onConfirm={() => (confirm ? submitRegime(confirm.body) : undefined)}
          size="md"
        >
          {confirm ? (
            <ul className="c22-section__list" aria-label="Cambios de régimen">
              {confirm.changes.map((change) => (
                <li key={change.field}>
                  <span className="cocoa-stack" data-gap="1">
                    <span>
                      {highRiskFieldLabel(change.field)}: {describeChangeValue(change.from)} → {describeChangeValue(change.to)}
                    </span>
                    {REGIME_REASONS[change.field] ? <span className="cocoa-note">{REGIME_REASONS[change.field]}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </CocoaDialog>
      </>
    );
  }

  return (
    <CocoaPage {...structurePageProps(model, hosted, "Régimen de la sociedad (gran empresa, SII, PGC, ejercicio) y ajustes de IVA: una sola fuente para todos sus centros.")} actions={<StructureActions model={model} wizard={wizard} />}>
      <StructureSplit model={model} wizard={wizard}>
        {content}
      </StructureSplit>
    </CocoaPage>
  );
}

export default StructureVatTab;
