// Contabilidad — Configuración › Contabilidad y fiscal › Contabilidad
// (/configuracion/contabilidad-fiscal, base tab of ContabilidadFiscalTabs).
// Cocoa 22 · ola 10 · lote 10-D, archetype «formulario / ajustes»
// (docs/design/COCOA-22.md §4): CocoaPage (hosted: the container paints eyebrow
// and title) → two CocoaSection panels on the 12-column grid (plan contable
// and fiscal-year start read from GET /backoffice/properties/:id/accounting-settings;
// cierre de ejercicio) → CocoaTable of the cost centres of the same payload →
// CocoaTable of the fiscal periods (GET /accounting/fiscal-periods?propertyId=)
// with CocoaState empty / error inside the section. Nothing is edited here:
// the plan and the periods are managed from the wizard and Cierre de
// ejercicio, and the fiscal identity of the sociedad (NIF, razón social, IVA)
// from Configuración › Estructura societaria, only linked from this page.
//
// FIX-1 · F3 (B-2): the ONE thing edited here is the opening balance to
// offset of the VAT (casilla 110 · `openingCompensation` +
// `openingCompensationPeriod` of GET/PUT /fiscal/vat-settings,
// `accounting.configure`, audited VAT_SETTINGS_UPDATED by the API): the
// quotas carried from the periods before the first settlement of ehotelOS.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { fetchAccountingSettings, fetchFiscalPeriods, type AccountingSettings as AccountingSettingsPayload, type CostCenter, type FiscalPeriod } from "../services/billingApi";
import { BRAND } from "../config/brand";
import { getVatSettings, putVatSettings, type VatSettingsDto } from "../services/fiscalApi";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";
import { useToast } from "../components/Toast";
import { STATUS_LABELS } from "../content/actions";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { date, dateRange, money, plural } from "../lib/format";
import { useNavGate } from "../navigation/useEnabledModules";
import { canDo } from "./accounting/accounting-ui";
import { fiscalErrorText, formatOpeningPeriod, openingCompensationDraft } from "./fiscal/fiscal-shared";
import { treeHeaderFor } from "./tabs/tab-helpers";

const PROPERTY_ID = getActivePropertyId();

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const PERIOD_STATUS: Record<FiscalPeriod["status"], { label: string; tone: CocoaTone }> = {
  open: { label: "Abierto", tone: "success" },
  closing: { label: "En cierre", tone: "warning" },
  closed: { label: "Cerrado", tone: "neutral" }
};

const PERIOD_TYPE: Record<FiscalPeriod["periodType"], string> = { month: "Mes", quarter: "Trimestre", year: "Ejercicio" };

const PERIOD_COLUMNS: CocoaTableColumn<FiscalPeriod>[] = [
  { key: "periodCode", label: "Periodo", fit: true, render: (row) => <strong className="cocoa-tabular">{row.periodCode}</strong> },
  { key: "periodType", label: "Tipo", fit: true, render: (row) => PERIOD_TYPE[row.periodType] ?? row.periodType },
  { key: "range", label: "Fechas", render: (row) => dateRange(row.startDate, row.endDate) },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => {
      const meta = PERIOD_STATUS[row.status] ?? { label: row.status, tone: "neutral" as CocoaTone };
      return <CocoaBadge tone={meta.tone}>{meta.label}</CocoaBadge>;
    }
  },
  { key: "closedAt", label: "Cerrado", fit: true, hideOnNarrow: true, render: (row) => date(row.closedAt) }
];

/** FIX-1 · F3 (B-2): «Saldo inicial a compensar (casilla 110)» + «Aplicar desde el periodo» → PUT /fiscal/vat-settings. */
function OpeningCompensationSection() {
  const { showToast } = useToast();
  const gate = useNavGate();
  const canConfigure = canDo(gate, "accounting.configure");
  const [vat, setVat] = useState<VatSettingsDto | null>(null);
  const [vatError, setVatError] = useState<string | null>(null);
  const [amountRaw, setAmountRaw] = useState("");
  const [periodRaw, setPeriodRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getVatSettings();
      setVat(next);
      setAmountRaw(next.openingCompensation > 0 ? String(next.openingCompensation) : "");
      setPeriodRaw(formatOpeningPeriod(next.openingCompensationPeriod));
      setVatError(null);
    } catch (err) {
      setVatError(fiscalErrorText(err, "No se pudieron cargar los ajustes de IVA de la sociedad."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = openingCompensationDraft(amountRaw, periodRaw);
  const dirty = vat !== null && (draft.amount !== vat.openingCompensation || draft.period !== vat.openingCompensationPeriod);
  const valid = !draft.amountError && !draft.periodError;

  async function save() {
    if (!vat || !dirty || !valid || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      const next = await putVatSettings({ openingCompensation: draft.amount, openingCompensationPeriod: draft.period });
      setVat(next);
      setAmountRaw(next.openingCompensation > 0 ? String(next.openingCompensation) : "");
      setPeriodRaw(formatOpeningPeriod(next.openingCompensationPeriod));
      showToast(next.openingCompensation > 0 ? `Saldo inicial a compensar guardado: ${money(next.openingCompensation)} desde ${formatOpeningPeriod(next.openingCompensationPeriod)}.` : "Saldo inicial a compensar retirado.", { variant: "success" });
    } catch (err) {
      setFailure(fiscalErrorText(err, STATUS_LABELS.saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CocoaSection
      title="Compensación inicial del IVA (casilla 110)"
      meta={vat ? (vat.openingCompensation > 0 ? `${money(vat.openingCompensation)} desde ${formatOpeningPeriod(vat.openingCompensationPeriod)}` : "sin saldo inicial") : undefined}
      action={
        <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void save()} loading={saving} disabled={!vat || !dirty || !valid || !canConfigure}>
          Guardar saldo inicial
        </CocoaButton>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <p className="cocoa-note">
          Cuotas a compensar arrastradas de periodos anteriores a la primera liquidación de {BRAND.name}. El Modelo 303 las suma a la casilla 110 desde el periodo indicado, junto con el saldo de 4700 que dejan las liquidaciones contabilizadas (propias e importadas de Sage). Cada cambio queda auditado.
        </p>
        {vatError ? <CocoaState kind="error" inline title="Ajustes de IVA no disponibles" message={vatError} onRetry={() => void load()} /> : null}
        {failure ? (
          <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
            {failure}
          </CocoaCallout>
        ) : null}
        {!canConfigure ? (
          <CocoaCallout tone="info" title="Solo lectura">
            El saldo inicial a compensar lo edita quien configura la contabilidad.
          </CocoaCallout>
        ) : null}
        <CocoaFormRow columns={2}>
          <CocoaField label="Saldo inicial a compensar (casilla 110)" error={draft.amountError} help="Importe en euros, mayor o igual que 0; vacío = sin saldo.">
            <CocoaInput value={amountRaw} onChange={setAmountRaw} inputMode="decimal" placeholder="0,00" disabled={!vat || !canConfigure} />
          </CocoaField>
          <CocoaField label="Aplicar desde el periodo" error={draft.periodError} help="Periodo de liquidación desde el que se arrastra (1T 2025 trimestral · 2025-01 mensual).">
            <CocoaInput value={periodRaw} onChange={setPeriodRaw} placeholder="1T 2025" maxLength={10} disabled={!vat || !canConfigure} />
          </CocoaField>
        </CocoaFormRow>
      </div>
    </CocoaSection>
  );
}

const COST_CENTER_COLUMNS: CocoaTableColumn<CostCenter>[] = [
  { key: "code", label: "Código", fit: true, render: (row) => <strong className="cocoa-tabular">{row.code}</strong> },
  { key: "name", label: "Nombre" },
  { key: "type", label: "Tipo", fit: true, hideOnNarrow: true },
  {
    key: "active",
    label: "Activo",
    fit: true,
    render: (row) => <CocoaBadge tone={row.active ? "success" : "warning"}>{row.active ? STATUS_LABELS.yes : STATUS_LABELS.no}</CocoaBadge>
  }
];

export function AccountingSettings() {
  const header = treeHeaderFor("AccountingSettings", { eyebrow: "Finanzas y cumplimiento", title: "Contabilidad" });
  const [payload, setPayload] = useState<AccountingSettingsPayload | null>(null);
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [periodsError, setPeriodsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [settingsResult, periodsResult] = await Promise.allSettled([fetchAccountingSettings(PROPERTY_ID), fetchFiscalPeriods(PROPERTY_ID)]);
    if (settingsResult.status === "fulfilled") {
      setPayload(settingsResult.value);
    } else {
      setError(settingsResult.reason instanceof Error ? settingsResult.reason.message : "No se pudo cargar la configuración contable.");
    }
    if (periodsResult.status === "fulfilled") {
      setPeriods(toArray<FiscalPeriod>(periodsResult.value));
      setPeriodsError(null);
    } else {
      setPeriods([]);
      setPeriodsError(periodsResult.reason instanceof Error ? periodsResult.reason.message : "No se pudieron cargar los periodos fiscales.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const costCenters = useMemo(() => toArray<CostCenter>(payload?.costCenters), [payload]);
  const settings = payload?.settings;
  const startMonth = settings ? (MONTHS[(settings.fiscalYearStartMonth ?? 1) - 1] ?? String(settings.fiscalYearStartMonth)) : null;

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="Plan contable, ejercicio, centros de coste y periodos fiscales"
      actions={
        <>
          <CocoaButton variant="plain" onClick={() => navigateTo("TrialBalanceScreen")}>
            Balance de sumas y saldos
          </CocoaButton>
          <CocoaButton variant="plain" onClick={() => navigateTo("Modelo303Screen")}>
            Modelo 303
          </CocoaButton>
          <CocoaButton variant="plain" onClick={() => navigateTo("FinancePositionDashboard")}>
            Posición financiera
          </CocoaButton>
        </>
      }
      state={loading && !payload ? "loading" : error && !payload ? "error" : "ready"}
      skeleton={<CocoaSkeleton.Grid rows={[[6, 6], [12], [12]]} height={140} label="Cargando configuración contable…" />}
      error={{ title: "No se pudo cargar la configuración contable", message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "accounting-settings-refresh", label: "Actualizar la configuración contable", run: () => void load() },
        { id: "accounting-settings-year-end", label: "Abrir Cierre de ejercicio", run: () => navigateTo("YearEndCloseScreen") }
      ]}
      id="accounting-settings"
    >
      <CocoaGrid aria-label="Plan contable y cierre de ejercicio">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Plan contable"
            meta={<CocoaBadge tone={settings?.chartTemplate ? "success" : "warning"}>{settings?.chartTemplate ? settings.chartTemplate : "sin plantilla"}</CocoaBadge>}
            footer={
              <div className="cocoa-cluster">
                <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FinanceComplianceSetupForm")}>
                  Asistente de finanzas y cumplimiento
                </CocoaButton>
                <CocoaButton variant="plain" size="small" onClick={() => navigateTo("StructureScreen")}>
                  Estructura societaria
                </CocoaButton>
              </div>
            }
          >
            {settings ? (
              <p>
                Inicio del ejercicio: <strong>{startMonth}</strong>
              </p>
            ) : (
              <p className="cocoa-note">
                La propiedad no tiene configuración contable guardada. Sin plan de cuentas, los asientos automáticos y el modelo 303 no pueden generarse.
              </p>
            )}
            {settings?.updatedAt ? <p className="cocoa-note">Actualizado {date(settings.updatedAt)}.</p> : null}
            <p className="cocoa-note">
              El NIF, la razón social y el régimen de IVA son de la sociedad: se consultan en Configuración › Estructura societaria y aquí solo se enlazan.
            </p>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Cierre de ejercicio"
            action={
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("YearEndCloseScreen")}>
                Cierre de ejercicio
              </CocoaButton>
            }
          >
            <p className="cocoa-note">Los cierres de periodo y de ejercicio bloquean nuevos asientos en fechas cerradas. Se gestionan desde la pantalla de cierre.</p>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <OpeningCompensationSection />

      <CocoaSection title="Centros de coste" meta={plural(costCenters.length, "centro", "centros")} padding={costCenters.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {costCenters.length === 0 ? (
          <CocoaState
            kind="empty"
            dashed
            title="Sin centros de coste"
            message="Esta propiedad no tiene centros de coste definidos. La imputación por departamento (habitaciones, restauración, mantenimiento…) no está disponible hasta que se creen; hoy no existe un formulario de alta en el back office."
          />
        ) : (
          <CocoaTable<CostCenter> columns={COST_CENTER_COLUMNS} rows={costCenters} rowKey="id" caption="Centros de coste de la propiedad" aria-label="Centros de coste de la propiedad" emptyState="Sin centros de coste." />
        )}
      </CocoaSection>

      <CocoaSection title="Periodos fiscales" meta={plural(periods.length, "periodo", "periodos")} padding={periods.length > 0 && !periodsError ? "none" : "md"} style={{ overflow: "clip" }}>
        {periodsError ? (
          <CocoaState kind="error" inline title="No se pudieron cargar los periodos fiscales" message={periodsError} onRetry={() => void load()} />
        ) : periods.length === 0 ? (
          <CocoaState
            kind="empty"
            dashed
            title="Sin periodos fiscales"
            message="Aún no se ha abierto ningún periodo contable para esta propiedad. Los periodos se abren y cierran desde Cierre de ejercicio."
            primaryAction={{ label: "Cierre de ejercicio", onClick: () => navigateTo("YearEndCloseScreen") }}
          />
        ) : (
          <CocoaTable<FiscalPeriod> columns={PERIOD_COLUMNS} rows={periods} rowKey="id" caption="Periodos fiscales de la propiedad" aria-label="Periodos fiscales de la propiedad" emptyState="Sin periodos." />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}

export default AccountingSettings;
