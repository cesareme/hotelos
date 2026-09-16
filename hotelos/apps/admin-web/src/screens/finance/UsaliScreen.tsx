// USALI — /finanzas/estados-contables/usali (Tanda 6 · Finanzas · lote 6-F).
//
// Hosted in EstadosContablesTabs (useTabHost → the container paints eyebrow
// and H1). Cocoa 22 dashboard archetype for the summary operating statement
// and the comparisons, form archetype for the account → USALI line editor.
// Zero inline `style` attributes on purpose (rule 13 of tests/cocoa-22-contract.test.mjs: the
// global inline-style ceiling only goes down): layout comes from the
// primitives and the `cocoa-stack` / `cocoa-row` / `c22-section__list` classes.
//
// Data (services/financialStatementsApi.ts on financial-statements-types.ts):
//   GET    /accounting/usali/pnl?from&to&propertyId[&format]        getUsaliPnl · downloadStatement("usali")
//   GET    /accounting/usali/coverage?from&to                        getUsaliCoverage
//   GET    /accounting/usali/compare?from&to                         compareUsaliProperties
//   GET    /accounting/usali/periods?periods=a..b,c..d&propertyId    compareUsaliPeriods (2–6 periods; the first is the base)
//   GET    /accounting/usali/mappings?from&to                        getUsaliMappings (rules + coverage + resolutions)
//   PATCH  /accounting/usali/mappings                                patchUsaliMappings (accounting.configure; upsert by prefix)
//   DELETE /accounting/usali/mappings/:mappingId                     deleteUsaliMapping
//
// Money is a decimal string ("1234.56") and a ratio is null when its
// denominator is 0 (no rooms available): both reach the screen untouched and
// lib/format turns them into text («—» for null, never a fake 0). The «Sin
// asignar» block is always painted (runbook §8) and the PGC reconciliation is
// shown next to it.
//
// Tanda 6b · L7 (design §5.3): the header carries the ONE «Ámbito» (sociedad by
// default, a centre as filter → `propertyId`); the «Por centro» view asks
// GET /accounting/usali/compare?includeCorporate=1[&allocation=none] so the
// hotels come with the «Oficina central» and «Sin asignar» columns, the
// rollup «Total sociedad = Σ hoteles + Oficina central + Sin asignar» and the
// informative allocation row (never posted) behind a CocoaSwitch.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CorporateAllocationResult,
  UsaliAccountAmount,
  UsaliAccountResolution,
  UsaliCoverage,
  UsaliDepartmentKey,
  UsaliLineKey,
  UsaliMappingRow,
  UsaliMappingSource,
  UsaliMappingsResponse,
  UsaliOperatingDepartment,
  UsaliPeriodComparison,
  UsaliPnl,
  UsaliPropertyComparison,
  UsaliRollupLine,
  UsaliUndistributedDepartment
} from "@hotelos/shared";
import { useNavGate } from "../../navigation/useEnabledModules";
import { apiRequest } from "../../services/api-client";
import type { NamedDownload } from "../../services/accountingApi";
import { compactQuery, financeErrorCode, financeErrorDetails, financeErrorStatus } from "../../services/finance-contracts";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { ALLOCATION_ROW_LABEL, CORPORATE_COLUMN_LABEL, ENTITY_TOTAL_FOOTNOTE, ENTITY_TOTAL_LABEL, UNASSIGNED_COLUMN_LABEL, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import {
  compareUsaliPeriods,
  deleteUsaliMapping,
  downloadStatement,
  getUsaliCoverage,
  getUsaliMappings,
  getUsaliPnl,
  patchUsaliMappings,
  statementsErrorMessage
} from "../../services/financialStatementsApi";
import { date, dateRange, dateTime, isoDate, money, number, percent, plural, toNumber } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, UI_STATES, confirmDelete } from "../../content/actions";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { canDo } from "../accounting/accounting-ui";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaBarsDatum,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// ---------------------------------------------------------------------------
// Vocabulary (labels of the shared unions; the mappings response carries the
// authoritative Spanish labels and admitted lines per department)
// ---------------------------------------------------------------------------

type View = "explotacion" | "propiedades" | "periodos" | "mapeo";

const VIEWS: Array<{ value: View; label: string }> = [
  { value: "explotacion", label: "Cuenta de explotación" },
  { value: "propiedades", label: "Por centro" },
  { value: "periodos", label: "Comparar periodos" },
  { value: "mapeo", label: "Mapeo de cuentas" }
];

/** GET /accounting/usali/compare?from&to&includeCorporate=1[&allocation=none] (Tanda 6b): hotels + «Oficina central» + «Sin asignar» + rollup + informative allocation. */
function compareUsaliCentres(window: { from: string; to: string; applyAllocation: boolean }): Promise<UsaliPropertyComparison> {
  return apiRequest<UsaliPropertyComparison>("/accounting/usali/compare", {
    query: compactQuery({ from: window.from, to: window.to, includeCorporate: "1", allocation: window.applyAllocation ? undefined : "none" })
  });
}

type Preset = "mes" | "trimestre" | "anio" | "personalizado";

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: "mes", label: "Mes en curso" },
  { value: "trimestre", label: "Trimestre en curso" },
  { value: "anio", label: "Año en curso" },
  { value: "personalizado", label: "Personalizado" }
];

const LINE_LABELS: Record<UsaliLineKey, string> = {
  revenue: "Ingresos",
  cost_of_sales: "Coste de ventas",
  labor: "Personal",
  other_expense: "Otros gastos",
  management_fee: "Honorarios de gestión",
  rent: "Alquileres",
  property_taxes: "Impuestos sobre la propiedad",
  insurance: "Seguros",
  other: "Otros",
  interest: "Intereses",
  depreciation_amortization: "Amortización",
  income_tax: "Impuesto sobre beneficios"
};

const DEPARTMENT_LABELS: Record<UsaliDepartmentKey, string> = {
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operados",
  misc_income: "Ingresos varios",
  admin_general: "Administración y general",
  it: "Tecnología de la información",
  sales_marketing: "Ventas y marketing",
  pom: "Mantenimiento y operación de la propiedad",
  utilities: "Suministros",
  management_fees: "Honorarios de gestión",
  non_operating: "No operativos",
  below_ebitda: "Bajo el EBITDA"
};

const SOURCE_LABELS: Record<UsaliMappingSource, { label: string; tone: CocoaTone }> = {
  mapping: { label: "Regla propia", tone: "accent" },
  account: { label: "Cuenta del plan", tone: "neutral" },
  template: { label: "Plantilla", tone: "info" },
  none: { label: "Sin mapeo", tone: "warning" }
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_PREFIX = /^[67][0-9]{0,7}(\.[0-9]{1,4})?$/;
type DownloadFormat = "pdf" | "xlsx" | "csv";
const DOWNLOAD_FORMATS: DownloadFormat[] = ["pdf", "xlsx", "csv"];
const FORMAT_LABELS: Record<DownloadFormat, string> = { pdf: "PDF", xlsx: "Hoja de cálculo", csv: "CSV" };
const MAX_PERIODS = 6;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Loader keyed by the query: a new key drops the previous data (no stale figures under new filters); `refresh` keeps them. */
function useStatement<T>(key: string | null, load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(key));
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const ticket = useRef(0);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!key) {
      setLoading(false);
      return;
    }
    const current = ++ticket.current;
    if (lastKey.current !== key) setData(null);
    lastKey.current = key;
    setLoading(true);
    setError(null);
    load()
      .then((value) => {
        if (ticket.current !== current) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ticket.current !== current) return;
        setError(err);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return { data, loading, error, refresh: () => setNonce((n) => n + 1), replace: (value: T) => setData(value) };
}

/** Spanish text for an API failure: 403 → RBAC copy; 400 VALIDATION_ERROR / USALI_LINE_NOT_ADMITTED → the issues; else the finance dictionary / API message. */
function errorText(error: unknown, fallback: string): string {
  if (financeErrorStatus(error) === 403) return UI_STATES.forbidden.message;
  const code = financeErrorCode(error);
  const details = financeErrorDetails(error);
  if ((code === "VALIDATION_ERROR" || code === "USALI_LINE_NOT_ADMITTED") && Array.isArray(details?.issues)) {
    const issues = (details.issues as Array<{ message?: unknown }>).map((issue) => (typeof issue.message === "string" ? issue.message : "")).filter(Boolean);
    if (issues.length > 0) return `${code === "USALI_LINE_NOT_ADMITTED" ? "Combinación no admitida" : "Revisa los datos"}: ${issues.join("; ")}.`;
  }
  return statementsErrorMessage(error, fallback);
}

function saveDownload(file: NamedDownload): void {
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function validWindow(from: string, to: string): boolean {
  return ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to;
}

/** Calendar range of a preset up to today (hotel time). */
function presetWindow(preset: Exclude<Preset, "personalizado">, today: string): { from: string; to: string } {
  const year = today.slice(0, 4);
  const month = Number(today.slice(5, 7));
  if (preset === "anio") return { from: `${year}-01-01`, to: today };
  if (preset === "trimestre") return { from: `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`, to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** The range of the same length that ends the day before `from` (base of the period comparison). */
function previousWindow(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  const days = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  const previousEnd = new Date(start.getTime() - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - days * 86_400_000);
  return { from: isoDate(previousStart) ?? from, to: isoDate(previousEnd) ?? to };
}

/** «—» for a null ratio (denominator 0), money otherwise. */
function ratio(value: string | null, currency: string): string {
  return value === null ? "—" : money(value, currency);
}

function pct(value: string | null | undefined): string {
  return value === null || value === undefined ? "—" : percent(value, { maximumFractionDigits: 2 });
}

function signedPct(value: string | null): string {
  return value === null ? "—" : percent(value, { signDisplay: "always", maximumFractionDigits: 1 });
}

function amountCell(value: string, currency: string) {
  return <span className="cocoa-tabular">{money(value, currency)}</span>;
}

function departmentLabel(pnl: UsaliPnl | null, key: UsaliDepartmentKey): string {
  const found = pnl?.operatingDepartments.find((department) => department.department === key) ?? pnl?.undistributed.find((department) => department.department === key);
  return found?.label ?? DEPARTMENT_LABELS[key] ?? key;
}

function UsaliSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={120} />
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[8, 4], [6, 6]]} />
    </div>
  );
}

function WarningList({ items, title }: { items: string[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <CocoaCallout tone="warning" title={title}>
      <ul className="c22-section__list">
        {items.map((item, index) => (
          <li key={index}>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </CocoaCallout>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function UsaliScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  // Tanda 6b · L7: the «Ámbito» of the header (sociedad by default, a centre as filter) is the `propertyId` of the statement.
  const finance = useFinanceScope(financeScopePolicy("UsaliScreen"));
  const propertyId = finance.propertyId ?? "";
  // Real grants of the active property (never the demo union of the login payload):
  // unknown while the profile loads → enabled, the API answers 403 if it must.
  const configurable = canDo(useNavGate(), "accounting.configure");
  const today = isoDate(new Date()) ?? "";

  const [view, setView] = useState<View>("explotacion");
  const [preset, setPreset] = useState<Preset>("anio");
  const [range, setRange] = useState(() => presetWindow("anio", today));
  const [applyAllocation, setApplyAllocation] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const windowOk = validWindow(range.from, range.to);
  const scopeKey = windowOk ? `${range.from}..${range.to}:${propertyId}` : null;
  const property = finance.centre;

  const pnl = useStatement<UsaliPnl>(view === "explotacion" ? scopeKey : null, () => getUsaliPnl({ from: range.from, to: range.to, propertyId: propertyId || undefined }));
  const coverage = useStatement<UsaliCoverage>(view === "explotacion" && windowOk ? `${range.from}..${range.to}` : null, () => getUsaliCoverage({ from: range.from, to: range.to }));
  const comparison = useStatement<UsaliPropertyComparison>(view === "propiedades" && windowOk ? `${range.from}..${range.to}:${applyAllocation ? "reparto" : "sin-reparto"}` : null, () => compareUsaliCentres({ from: range.from, to: range.to, applyAllocation }));
  const mappings = useStatement<UsaliMappingsResponse>(view === "mapeo" && windowOk ? `${range.from}..${range.to}` : null, () => getUsaliMappings({ from: range.from, to: range.to }));

  function choosePreset(value: string) {
    const next = value as Preset;
    setPreset(next);
    if (next !== "personalizado") setRange(presetWindow(next, today));
  }

  async function download(format: DownloadFormat) {
    setDownloading(format);
    try {
      saveDownload(await downloadStatement("usali", { from: range.from, to: range.to, propertyId: propertyId || undefined }, format));
    } catch (err) {
      showToast(errorText(err, "No se pudo descargar la cuenta de explotación."), { variant: "error" });
    } finally {
      setDownloading(null);
    }
  }

  const active = view === "explotacion" ? pnl : view === "propiedades" ? comparison : view === "mapeo" ? mappings : null;
  // The period section stays mounted while a view loads (no focus loss while
  // typing a date): loading / error live below it, never as the page state.
  const activePending = Boolean(active && active.loading && !active.data);
  const activeFailed = Boolean(active && active.error && !active.data);
  const loadErrorMessage = active?.error ? errorText(active.error, "No se pudo generar la información USALI.") : undefined;
  const scopeLabel = `${dateRange(range.from, range.to)} · ${finance.scope.label}`;

  const actions = (
    <>
      {active && active.loading && active.data ? <CocoaBadge tone="info">actualizando</CocoaBadge> : null}
      <FinanceScopeSelector scope={finance} />
      {view === "explotacion"
        ? DOWNLOAD_FORMATS.map((format) => (
            <CocoaButton key={format} variant="bordered" tone="neutral" size="small" disabled={!pnl.data} loading={downloading === format} onClick={() => void download(format)}>
              {`${ACTIONS.download} ${FORMAT_LABELS[format]}`}
            </CocoaButton>
          ))
        : null}
      {active ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={active.refresh}>
          {ACTIONS.refresh}
        </CocoaButton>
      ) : null}
    </>
  );

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title="USALI"
      subtitle={hosted ? undefined : `Cuenta de explotación por departamentos según USALI (11.ª edición), ratios por habitación disponible y ocupada, y mapeo de cuentas PGC · ${scopeLabel}`}
      actions={actions}
      tabs={VIEWS}
      activeTab={view}
      onTabChange={(value) => setView(value as View)}
      commands={[
        { id: "usali-actualizar", label: "Actualizar USALI", run: () => active?.refresh() },
        { id: "usali-mapeo", label: "Abrir el mapeo de cuentas USALI", run: () => setView("mapeo") },
        { id: "usali-pdf", label: "Descargar la cuenta de explotación USALI en PDF", run: () => void download("pdf") }
      ]}
    >
      <CocoaSection
        title="Periodo y ámbito"
        meta={pnl.data ? `generado ${dateTime(pnl.data.generatedAt)}` : undefined}
        footer={view === "propiedades" ? "La vista por centro usa el periodo y recorre todos los centros de la sociedad: hoteles, oficina central y asientos sin centro." : view === "mapeo" ? "El periodo sirve para señalar las cuentas sin mapeo que además tienen movimientos." : undefined}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaSegmentedControl value={preset} onChange={choosePreset} options={PRESETS} aria-label="Periodo" />
          <CocoaFormRow columns={3} min={200}>
            <CocoaField label={FIELD_LABELS.from} error={ISO_DAY.test(range.from) && ISO_DAY.test(range.to) && range.from > range.to ? "La fecha de inicio no puede ser posterior a la de fin." : undefined}>
              <CocoaDatePicker
                value={range.from}
                onChange={(value) => {
                  setPreset("personalizado");
                  setRange((current) => ({ ...current, from: value }));
                }}
              />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.to}>
              <CocoaDatePicker
                value={range.to}
                onChange={(value) => {
                  setPreset("personalizado");
                  setRange((current) => ({ ...current, to: value }));
                }}
              />
            </CocoaField>
            {view === "propiedades" ? (
              <CocoaField label="Aplicar reparto de oficina central (informativo)" inline help="Reparte el coste de la oficina entre los hoteles con la clave configurada en Estructura societaria › Reparto. Nunca se contabiliza.">
                <CocoaSwitch checked={applyAllocation} onChange={setApplyAllocation} size="small" />
              </CocoaField>
            ) : null}
          </CocoaFormRow>
        </div>
      </CocoaSection>

      {!windowOk ? <CocoaState kind="empty" title="Indica un periodo válido" message="La fecha de inicio no puede ser posterior a la de fin." /> : null}
      {windowOk && activePending ? <UsaliSkeleton /> : null}
      {windowOk && activeFailed ? <CocoaState kind="error" title={STATUS_LABELS.loadError} message={loadErrorMessage} onRetry={active?.refresh} /> : null}

      {windowOk && view === "explotacion" && pnl.data ? <OperatingStatementView pnl={pnl.data} coverage={coverage.data} onOpenMapping={() => setView("mapeo")} /> : null}
      {windowOk && view === "propiedades" && comparison.data ? <PropertiesComparisonView comparison={comparison.data} applyAllocation={applyAllocation} /> : null}
      {windowOk && view === "periodos" ? <PeriodsComparisonView range={range} propertyId={propertyId} propertyName={property?.name ?? null} /> : null}
      {windowOk && view === "mapeo" && mappings.data ? <MappingEditorView response={mappings.data} configurable={configurable} onReplace={mappings.replace} /> : null}
    </CocoaPage>
  );
}

// ---------------------------------------------------------------------------
// Cuenta de explotación
// ---------------------------------------------------------------------------

type DepartmentDetail = { title: string; subtitle: string; accounts: UsaliAccountAmount[] };

const OPERATING_COLUMNS_BASE = (currency: string): CocoaTableColumn<UsaliOperatingDepartment>[] => [
  { key: "label", label: "Departamento", render: (row) => <strong>{row.label}</strong> },
  { key: "revenue", label: "Ingresos", align: "right", render: (row) => amountCell(row.revenue, currency) },
  { key: "costOfSales", label: "Coste de ventas", align: "right", hideOnNarrow: true, render: (row) => amountCell(row.costOfSales, currency) },
  { key: "labor", label: "Personal", align: "right", hideOnNarrow: true, render: (row) => amountCell(row.labor, currency) },
  { key: "otherExpense", label: "Otros gastos", align: "right", hideOnNarrow: true, render: (row) => amountCell(row.otherExpense, currency) },
  { key: "totalExpenses", label: "Gastos", align: "right", hideOnNarrow: true, render: (row) => amountCell(row.totalExpenses, currency) },
  { key: "departmentalProfit", label: "Beneficio departamental", align: "right", render: (row) => <strong className="cocoa-tabular">{money(row.departmentalProfit, currency)}</strong> }
];

const UNDISTRIBUTED_COLUMNS = (currency: string): CocoaTableColumn<UsaliUndistributedDepartment>[] => [
  { key: "label", label: "Departamento", render: (row) => <strong>{row.label}</strong> },
  { key: "labor", label: "Personal", align: "right", hideOnNarrow: true, render: (row) => amountCell(row.labor, currency) },
  { key: "otherExpense", label: "Otros gastos", align: "right", hideOnNarrow: true, render: (row) => amountCell(row.otherExpense, currency) },
  { key: "total", label: "Total", align: "right", render: (row) => <strong className="cocoa-tabular">{money(row.total, currency)}</strong> }
];

type RatioRow = UsaliPnl["ratios"]["perDepartment"][number] & { label: string };

const RATIO_COLUMNS = (currency: string): CocoaTableColumn<RatioRow>[] => [
  { key: "label", label: "Departamento", render: (row) => <strong>{row.label}</strong> },
  { key: "revenuePAR", label: "Ingresos PAR", align: "right", render: (row) => <span className="cocoa-tabular">{ratio(row.revenuePAR, currency)}</span> },
  { key: "revenuePOR", label: "Ingresos POR", align: "right", hideOnNarrow: true, render: (row) => <span className="cocoa-tabular">{ratio(row.revenuePOR, currency)}</span> },
  { key: "expensePAR", label: "Gastos PAR", align: "right", hideOnNarrow: true, render: (row) => <span className="cocoa-tabular">{ratio(row.expensePAR, currency)}</span> },
  { key: "expensePOR", label: "Gastos POR", align: "right", hideOnNarrow: true, render: (row) => <span className="cocoa-tabular">{ratio(row.expensePOR, currency)}</span> },
  { key: "profitPAR", label: "Beneficio PAR", align: "right", render: (row) => <span className="cocoa-tabular">{ratio(row.profitPAR, currency)}</span> },
  { key: "profitPOR", label: "Beneficio POR", align: "right", hideOnNarrow: true, render: (row) => <span className="cocoa-tabular">{ratio(row.profitPOR, currency)}</span> }
];

type UnassignedRow = UsaliPnl["unassigned"]["accounts"][number];

const UNASSIGNED_COLUMNS = (currency: string): CocoaTableColumn<UnassignedRow>[] => [
  { key: "code", label: "Cuenta", render: (row) => <span className="cocoa-mono">{row.code}</span> },
  { key: "name", label: FIELD_LABELS.name, render: (row) => <span>{row.name}</span> },
  { key: "kind", label: FIELD_LABELS.type, hideOnNarrow: true, render: (row) => <CocoaBadge tone={row.kind === "income" ? "success" : "neutral"}>{row.kind === "income" ? "ingreso" : "gasto"}</CocoaBadge> },
  { key: "amount", label: FIELD_LABELS.amount, align: "right", render: (row) => amountCell(row.amount, currency) }
];

function OperatingStatementView({ pnl, coverage, onOpenMapping }: { pnl: UsaliPnl; coverage: UsaliCoverage | null; onOpenMapping: () => void }) {
  const currency = pnl.currency;
  const [detail, setDetail] = useState<DepartmentDetail | null>(null);
  const operatingColumns = useMemo(() => OPERATING_COLUMNS_BASE(currency), [currency]);
  const undistributedColumns = useMemo(() => UNDISTRIBUTED_COLUMNS(currency), [currency]);
  const ratioColumns = useMemo(() => RATIO_COLUMNS(currency), [currency]);
  const unassignedColumns = useMemo(() => UNASSIGNED_COLUMNS(currency), [currency]);

  const unassignedCount = pnl.unassigned.accounts.length;
  const stats = pnl.statistics;
  const ratios = pnl.ratios;
  const gop = toNumber(pnl.gop) ?? 0;
  const ebitda = toNumber(pnl.ebitda) ?? 0;
  const net = toNumber(pnl.netIncome) ?? 0;

  const profitBars: CocoaBarsDatum[] = pnl.operatingDepartments.map((department) => ({ label: department.label, value: toNumber(department.departmentalProfit) ?? 0, hint: `Ingresos ${money(department.revenue, currency)}` }));
  const bridgeBars: CocoaBarsDatum[] = [
    { label: "Dept.", value: toNumber(pnl.totalDepartmentalProfit) ?? 0, hint: "Beneficio departamental total" },
    { label: "No distr.", value: -(toNumber(pnl.totalUndistributed) ?? 0), hint: "Gastos no distribuidos" },
    { label: "GOP", value: gop, hint: "Beneficio operativo bruto", tone: "accent" },
    { label: "Gestión", value: -(toNumber(pnl.managementFees) ?? 0), hint: "Honorarios de gestión" },
    { label: "No oper.", value: -(toNumber(pnl.nonOperating.total) ?? 0), hint: "Alquileres, impuestos, seguros y otros" },
    { label: "EBITDA", value: ebitda, hint: "Resultado antes de intereses, impuestos y amortización", tone: "accent" },
    { label: "Neto", value: net, hint: "Resultado neto USALI", tone: "accent" }
  ];
  const ratioRows: RatioRow[] = ratios.perDepartment.map((row) => ({ ...row, label: departmentLabel(pnl, row.department) }));
  const noRooms = stats.roomsAvailable === 0;

  return (
    <>
      {!pnl.reconciliation.ok ? (
        <CocoaCallout tone="danger" variant="banner" title="La cuenta USALI no cuadra con el resultado PGC de las mismas filas" role="alert">
          Resultado PGC {money(pnl.reconciliation.pgcResult, currency)} frente a resultado USALI más «Sin asignar» {money(pnl.reconciliation.usaliNetIncomePlusUnassigned, currency)}. Revisa el mapeo antes de usar estas cifras.
        </CocoaCallout>
      ) : null}
      {unassignedCount > 0 ? (
        <CocoaCallout
          tone="warning"
          variant="banner"
          title={`${plural(unassignedCount, "cuenta con movimientos sin línea USALI", "cuentas con movimientos sin línea USALI")} · ${money(pnl.unassigned.net, currency)} netos en «Sin asignar»`}
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={onOpenMapping}>
              Asignar cuentas
            </CocoaButton>
          }
        >
          Los importes están en el bloque «Sin asignar» de abajo, nunca ocultos: el GOP y el EBITDA no los incluyen hasta que asignes cada cuenta a un departamento y una línea.
        </CocoaCallout>
      ) : null}
      {coverage && coverage.unmappedAccounts.length > unassignedCount ? (
        <CocoaCallout tone="info" title={`${plural(coverage.unmappedAccounts.length, "cuenta del plan sin línea USALI", "cuentas del plan sin línea USALI")} (${plural(coverage.unmappedWithMovements.length, "con movimientos", "con movimientos")} en el periodo)`}>
          Las cuentas sin movimientos no afectan a esta cuenta de explotación, pero conviene asignarlas antes de que los tengan.
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores USALI del periodo">
        <CocoaKpi label="Ingresos operativos" value={money(pnl.totalOperatingRevenue, currency)} deltaLabel={dateRange(pnl.period.from, pnl.period.to)} polarity="neutral" />
        <CocoaKpi label="GOP" value={money(pnl.gop, currency)} deltaLabel="beneficio operativo bruto" polarity="positive-good" status={gop < 0 ? "warning" : "ok"} />
        <CocoaKpi label="EBITDA" value={money(pnl.ebitda, currency)} polarity="positive-good" status={ebitda < 0 ? "warning" : "ok"} />
        <CocoaKpi label="Resultado neto" value={money(pnl.netIncome, currency)} deltaLabel={unassignedCount > 0 ? `+ ${money(pnl.unassigned.net, currency)} sin asignar` : undefined} polarity="positive-good" status={net < 0 ? "warning" : "ok"} />
        <CocoaKpi label="RevPAR" value={ratio(ratios.revpar, currency)} deltaLabel={noRooms ? "sin habitaciones disponibles" : "ingresos de habitaciones por habitación disponible"} polarity="neutral" />
        <CocoaKpi label="TRevPAR" value={ratio(ratios.trevpar, currency)} deltaLabel={noRooms ? "sin habitaciones disponibles" : "ingresos totales por habitación disponible"} polarity="neutral" />
        <CocoaKpi label="GOPPAR" value={ratio(ratios.goppar, currency)} deltaLabel={noRooms ? "sin habitaciones disponibles" : "GOP por habitación disponible"} polarity="neutral" />
        <CocoaKpi label="Ocupación" value={pct(stats.occupancyPct)} deltaLabel={`${number(stats.roomsOccupied)} de ${number(stats.roomsAvailable)} noches de habitación`} polarity="neutral" />
      </CocoaKpiStrip>

      <CocoaGrid aria-label="Departamentos operativos" align="start">
        <CocoaSpan cols={8} min={480}>
          <CocoaSection title="Departamentos operativos" meta={`beneficio departamental ${money(pnl.totalDepartmentalProfit, currency)}`} footer="Pulsa un departamento para ver las cuentas PGC que lo componen.">
            <CocoaTable
              columns={operatingColumns}
              rows={pnl.operatingDepartments}
              rowKey="department"
              density="compact"
              caption="Departamentos operativos"
              aria-label="Departamentos operativos"
              onSelect={(row) => setDetail({ title: row.label, subtitle: `Beneficio departamental ${money(row.departmentalProfit, currency)}`, accounts: row.accounts })}
              footer={{
                label: <strong>Total operativo</strong>,
                revenue: <strong className="cocoa-tabular">{money(pnl.totalOperatingRevenue, currency)}</strong>,
                totalExpenses: <strong className="cocoa-tabular">{money(pnl.totalDepartmentalExpenses, currency)}</strong>,
                departmentalProfit: <strong className="cocoa-tabular">{money(pnl.totalDepartmentalProfit, currency)}</strong>
              }}
            />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Beneficio por departamento" meta={plural(pnl.operatingDepartments.length, "departamento", "departamentos")}>
            <CocoaChart.Bars data={profitBars} height={160} valueFormat={(value) => money(value, currency, { decimals: "auto" })} aria-label="Beneficio departamental por departamento operativo" />
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid aria-label="Gastos no distribuidos y puente al resultado" align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Gastos no distribuidos" meta={money(pnl.totalUndistributed, currency)}>
            <CocoaTable
              columns={undistributedColumns}
              rows={pnl.undistributed}
              rowKey="department"
              density="compact"
              caption="Gastos no distribuidos"
              aria-label="Gastos no distribuidos"
              onSelect={(row) => setDetail({ title: row.label, subtitle: `Total ${money(row.total, currency)}`, accounts: row.accounts })}
              footer={{ label: <strong>Total no distribuido</strong>, total: <strong className="cocoa-tabular">{money(pnl.totalUndistributed, currency)}</strong> }}
            />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Del beneficio departamental al resultado neto" meta="USALI 11.ª">
            <ul className="c22-section__list">
              <li>
                <span>Beneficio departamental total</span>
                <strong>{money(pnl.totalDepartmentalProfit, currency)}</strong>
              </li>
              <li>
                <span>− Gastos no distribuidos</span>
                <strong>{money(pnl.totalUndistributed, currency)}</strong>
              </li>
              <li>
                <strong>= GOP</strong>
                <strong>{money(pnl.gop, currency)}</strong>
              </li>
              <li>
                <span>− Honorarios de gestión</span>
                <strong>{money(pnl.managementFees, currency)}</strong>
              </li>
              <li>
                <span>= Resultado antes de partidas no operativas</span>
                <strong>{money(pnl.incomeBeforeNonOperating, currency)}</strong>
              </li>
              <li>
                <span>− Alquileres</span>
                <strong>{money(pnl.nonOperating.rent, currency)}</strong>
              </li>
              <li>
                <span>− Impuestos sobre la propiedad</span>
                <strong>{money(pnl.nonOperating.propertyTaxes, currency)}</strong>
              </li>
              <li>
                <span>− Seguros</span>
                <strong>{money(pnl.nonOperating.insurance, currency)}</strong>
              </li>
              <li>
                <span>− Otros no operativos</span>
                <strong>{money(pnl.nonOperating.other, currency)}</strong>
              </li>
              <li>
                <strong>= EBITDA</strong>
                <strong>{money(pnl.ebitda, currency)}</strong>
              </li>
              <li>
                <span>− Intereses</span>
                <strong>{money(pnl.belowEbitda.interest, currency)}</strong>
              </li>
              <li>
                <span>− Amortización</span>
                <strong>{money(pnl.belowEbitda.depreciationAmortization, currency)}</strong>
              </li>
              <li>
                <span>− Impuesto sobre beneficios</span>
                <strong>{money(pnl.belowEbitda.incomeTax, currency)}</strong>
              </li>
              <li>
                <strong>= Resultado neto</strong>
                <strong>{money(pnl.netIncome, currency)}</strong>
              </li>
            </ul>
            <CocoaChart.Bars data={bridgeBars} height={120} valueFormat={(value) => money(value, currency, { decimals: "auto" })} aria-label="Puente del beneficio departamental al resultado neto" />
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid aria-label="Sin asignar y cuadre con el PGC" align="start">
        <CocoaSpan cols={7} min={320}>
          <CocoaSection
            title="Sin asignar"
            meta={unassignedCount > 0 ? <CocoaBadge tone="warning">{plural(unassignedCount, "cuenta", "cuentas")}</CocoaBadge> : <CocoaBadge tone="success">todo asignado</CocoaBadge>}
            action={
              <CocoaButton variant="plain" tone="accent" size="small" onClick={onOpenMapping}>
                Mapeo de cuentas
              </CocoaButton>
            }
            footer="Cuentas de los grupos 6 y 7 con movimientos en el periodo y sin departamento ni línea USALI. Este bloque se muestra siempre."
          >
            <div className="cocoa-row" data-gap="4">
              <CocoaStat label="Ingresos" value={money(pnl.unassigned.revenue, currency)} />
              <CocoaStat label="Gastos" value={money(pnl.unassigned.expense, currency)} />
              <CocoaStat label="Neto" value={money(pnl.unassigned.net, currency)} tone={unassignedCount > 0 ? "warning" : undefined} />
            </div>
            {unassignedCount > 0 ? (
              <CocoaTable columns={unassignedColumns} rows={pnl.unassigned.accounts} rowKey="code" density="compact" caption="Cuentas sin asignar" aria-label="Cuentas sin asignar" />
            ) : (
              <CocoaState kind="empty" inline title="Todas las cuentas con movimiento tienen departamento y línea USALI." />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={5} min={320}>
          <CocoaSection title="Cuadre con el PGC" meta={<CocoaBadge tone={pnl.reconciliation.ok ? "success" : "danger"}>{pnl.reconciliation.ok ? "cuadra" : "no cuadra"}</CocoaBadge>} footer="Resultado PGC de las mismas filas del libro = resultado neto USALI + neto sin asignar.">
            <ul className="c22-section__list">
              <li>
                <span>Ingresos PGC (grupo 7)</span>
                <strong>{money(pnl.reconciliation.pgcRevenue, currency)}</strong>
              </li>
              <li>
                <span>Gastos PGC (grupo 6)</span>
                <strong>{money(pnl.reconciliation.pgcExpense, currency)}</strong>
              </li>
              <li>
                <span>Resultado PGC</span>
                <strong>{money(pnl.reconciliation.pgcResult, currency)}</strong>
              </li>
              <li>
                <span>Resultado neto USALI + sin asignar</span>
                <strong>{money(pnl.reconciliation.usaliNetIncomePlusUnassigned, currency)}</strong>
              </li>
            </ul>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid aria-label="Estadísticas y ratios por departamento" align="start">
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Estadísticas del PMS" meta="estancias reales" footer="Disponibles = habitaciones activas × noches del periodo; las habitaciones fuera de servicio no se descuentan porque el PMS aún no las registra por noche.">
            <ul className="c22-section__list">
              <li>
                <span>Noches del periodo</span>
                <strong>{number(stats.nights)}</strong>
              </li>
              <li>
                <span>Habitaciones activas</span>
                <strong>{number(stats.roomsInventory)}</strong>
              </li>
              <li>
                <span>Noches de habitación disponibles</span>
                <strong>{number(stats.roomsAvailable)}</strong>
              </li>
              <li>
                <span>Noches de habitación ocupadas</span>
                <strong>{number(stats.roomsOccupied)}</strong>
              </li>
              <li>
                <span>Ocupación</span>
                <strong>{pct(stats.occupancyPct)}</strong>
              </li>
              <li>
                <span>ADR</span>
                <strong>{ratio(ratios.adr, currency)}</strong>
              </li>
              <li>
                <span>Ingresos totales por habitación ocupada</span>
                <strong>{ratio(ratios.totalRevenuePOR, currency)}</strong>
              </li>
              <li>
                <span>GOP por habitación ocupada</span>
                <strong>{ratio(ratios.gopPOR, currency)}</strong>
              </li>
              <li>
                <span>EBITDA por habitación disponible</span>
                <strong>{ratio(ratios.ebitdaPAR, currency)}</strong>
              </li>
              <li>
                <span>No distribuidos por habitación disponible</span>
                <strong>{ratio(ratios.undistributedPAR, currency)}</strong>
              </li>
            </ul>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={8} min={480}>
          <CocoaSection title="Ratios por departamento" meta="PAR = por habitación disponible · POR = por habitación ocupada" footer="Un guion indica que el denominador es cero (sin habitaciones disponibles u ocupadas en el periodo) o que la línea no aplica al departamento.">
            <CocoaTable columns={ratioColumns} rows={ratioRows} rowKey="department" density="compact" caption="Ratios por departamento" aria-label="Ratios por departamento" />
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaDrawer open={detail !== null} onClose={() => setDetail(null)} title={detail?.title ?? "Departamento"} subtitle={detail?.subtitle} size="sm">
        {detail && detail.accounts.length > 0 ? (
          <ul className="c22-section__list">
            {detail.accounts.map((account) => (
              <li key={`${account.code}-${account.line}`}>
                <span className="cocoa-cluster">
                  <span>
                    <span className="cocoa-mono">{account.code}</span> {account.name} · {LINE_LABELS[account.line] ?? account.line}
                  </span>
                  {/* Tanda 6c: the amount reached the department through the cost centre of the entry (coste de personal importado), not through the account mapping. */}
                  {account.source === "cost_center" ? (
                    <CocoaBadge tone="info" size="small" title="Importe enrutado por el centro de coste del apunte, no por el mapeo de la cuenta">
                      Centro de coste
                    </CocoaBadge>
                  ) : null}
                </span>
                <strong>{money(account.amount, currency)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <CocoaState kind="empty" inline title="Sin cuentas con movimiento en este departamento durante el periodo." />
        )}
      </CocoaDrawer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Por centro (hoteles · Oficina central · Sin asignar · Total sociedad)
// ---------------------------------------------------------------------------

type MetricRow = { key: string; label: string; values: Record<string, string> };

/** Extra columns of the Tanda 6b comparison (`includeCorporate=1`): the office / other centres and the society-level entries. */
function extraColumns(comparison: UsaliPropertyComparison): Array<{ key: string; pnl: UsaliPnl }> {
  const out: Array<{ key: string; pnl: UsaliPnl }> = [];
  if (comparison.corporate) out.push({ key: "corporate", pnl: comparison.corporate.pnl });
  if (comparison.unassigned) out.push({ key: "unassigned", pnl: comparison.unassigned });
  return out;
}

function metricRows(comparison: UsaliPropertyComparison): MetricRow[] {
  const columns = [...comparison.properties.map((entry) => ({ key: entry.propertyId, pnl: entry.pnl })), ...extraColumns(comparison), { key: "consolidated", pnl: comparison.consolidated }];
  const metric = (key: string, label: string, pick: (pnl: UsaliPnl) => string): MetricRow => ({
    key,
    label,
    values: Object.fromEntries(columns.map((column) => [column.key, pick(column.pnl)]))
  });
  return [
    metric("revenue", "Ingresos operativos", (pnl) => money(pnl.totalOperatingRevenue, pnl.currency)),
    metric("departmental", "Beneficio departamental", (pnl) => money(pnl.totalDepartmentalProfit, pnl.currency)),
    metric("undistributed", "Gastos no distribuidos", (pnl) => money(pnl.totalUndistributed, pnl.currency)),
    metric("gop", "GOP", (pnl) => money(pnl.gop, pnl.currency)),
    metric("ebitda", "EBITDA", (pnl) => money(pnl.ebitda, pnl.currency)),
    metric("net", "Resultado neto", (pnl) => money(pnl.netIncome, pnl.currency)),
    metric("unassigned", "Sin asignar (neto)", (pnl) => money(pnl.unassigned.net, pnl.currency)),
    metric("roomsAvailable", "Noches de habitación disponibles", (pnl) => number(pnl.statistics.roomsAvailable)),
    metric("occupancy", "Ocupación", (pnl) => pct(pnl.statistics.occupancyPct)),
    metric("adr", "ADR", (pnl) => ratio(pnl.ratios.adr, pnl.currency)),
    metric("revpar", "RevPAR", (pnl) => ratio(pnl.ratios.revpar, pnl.currency)),
    metric("trevpar", "TRevPAR", (pnl) => ratio(pnl.ratios.trevpar, pnl.currency)),
    metric("goppar", "GOPPAR", (pnl) => ratio(pnl.ratios.goppar, pnl.currency))
  ];
}

// The currency comes from the statement (`consolidated.currency`), never a literal.
const ROLLUP_COLUMNS = (currency: string): CocoaTableColumn<UsaliRollupLine>[] => [
  { key: "label", label: "Indicador", render: (row) => <strong>{row.label}</strong> },
  { key: "hotels", label: "Σ hoteles", align: "right", render: (row) => amountCell(row.hotels, currency) },
  { key: "corporate", label: CORPORATE_COLUMN_LABEL, align: "right", hideOnNarrow: true, render: (row) => amountCell(row.corporate, currency) },
  { key: "unassigned", label: UNASSIGNED_COLUMN_LABEL, align: "right", hideOnNarrow: true, render: (row) => amountCell(row.unassigned, currency) },
  { key: "total", label: ENTITY_TOTAL_LABEL, align: "right", render: (row) => <strong className="cocoa-tabular">{money(row.total, currency)}</strong> },
  { key: "ok", label: "Cuadra", render: (row) => <CocoaBadge tone={row.ok ? "success" : "danger"} variant="dot">{row.ok ? "Sí" : "No"}</CocoaBadge> }
];

type AllocationShareRow = { propertyId: string; name: string; allocated: string; gopAfter: string; ebitdaAfter: string };

const ALLOCATION_COLUMNS = (currency: string): CocoaTableColumn<AllocationShareRow>[] => [
  { key: "name", label: "Hotel", render: (row) => <strong>{row.name}</strong> },
  { key: "allocated", label: "Coste repartido", align: "right", render: (row) => amountCell(row.allocated, currency) },
  { key: "gopAfter", label: "GOP tras reparto", align: "right", render: (row) => amountCell(row.gopAfter, currency) },
  { key: "ebitdaAfter", label: "EBITDA tras reparto", align: "right", hideOnNarrow: true, render: (row) => amountCell(row.ebitdaAfter, currency) }
];

function AllocationSection({ comparison, allocation, applied }: { comparison: UsaliPropertyComparison; allocation: CorporateAllocationResult | null | undefined; applied: boolean }) {
  const currency = comparison.consolidated.currency;
  const columns = useMemo(() => ALLOCATION_COLUMNS(currency), [currency]);
  const rows: AllocationShareRow[] = comparison.properties.filter((entry) => entry.allocation).map((entry) => ({ propertyId: entry.propertyId, name: entry.propertyName, allocated: entry.allocation!.allocated, gopAfter: entry.allocation!.gopAfterAllocation, ebitdaAfter: entry.allocation!.ebitdaAfterAllocation }));
  return (
    <CocoaSection title={ALLOCATION_ROW_LABEL} meta={allocation ? allocation.basisLabel : undefined} footer="Solo cambia esta vista: el Diario y los impuestos no se tocan (R5).">
      {!applied ? (
        <CocoaState kind="empty" inline title="Reparto desactivado: activa «Aplicar reparto de oficina central» para ver el GOP de cada hotel tras absorber el coste de la oficina." />
      ) : !allocation || allocation.method === "none" ? (
        <CocoaState kind="empty" inline title="La clave de reparto de la sociedad es «ninguno»: se configura en Configuración › Estructura societaria › Reparto." />
      ) : (
        <div className="cocoa-stack" data-gap="3">
          <div className="cocoa-row" data-gap="4" data-align="start">
            <CocoaStat label="Coste corporativo" value={money(allocation.corporateCost, currency)} hint={allocation.applied ? `${allocation.basisLabel} · repartido ${money(allocation.allocated, currency)}` : "no se ha repartido nada"} />
            <CocoaStat label="Contabilizado" value={<CocoaBadge tone="info">No: solo informativo</CocoaBadge>} tabular={false} />
          </div>
          {rows.length > 0 ? <CocoaTable columns={columns} rows={rows} rowKey="propertyId" density="compact" caption="Reparto informativo por hotel" aria-label="Reparto informativo por hotel" /> : null}
          {allocation.warnings.length > 0 ? <WarningList items={allocation.warnings} title="Avisos del reparto" /> : null}
        </div>
      )}
    </CocoaSection>
  );
}

function PropertiesComparisonView({ comparison, applyAllocation }: { comparison: UsaliPropertyComparison; applyAllocation: boolean }) {
  const rows = useMemo(() => metricRows(comparison), [comparison]);
  const rollupColumns = useMemo(() => ROLLUP_COLUMNS(comparison.consolidated.currency), [comparison.consolidated.currency]);
  const withStructure = comparison.corporate !== undefined || comparison.unassigned !== undefined;
  const columns = useMemo<CocoaTableColumn<MetricRow>[]>(
    () => [
      { key: "label", label: "Indicador", render: (row) => <strong>{row.label}</strong> },
      ...comparison.properties.map<CocoaTableColumn<MetricRow>>((entry) => ({
        key: entry.propertyId,
        label: entry.propertyCode ? `${entry.propertyName} (${entry.propertyCode})` : entry.propertyName,
        align: "right",
        render: (row) => <span className="cocoa-tabular">{row.values[entry.propertyId] ?? "—"}</span>
      })),
      ...(comparison.corporate ? [{ key: "corporate", label: CORPORATE_COLUMN_LABEL, align: "right" as const, hideOnNarrow: true, render: (row: MetricRow) => <span className="cocoa-tabular">{row.values.corporate ?? "—"}</span> }] : []),
      ...(comparison.unassigned ? [{ key: "unassigned", label: UNASSIGNED_COLUMN_LABEL, align: "right" as const, hideOnNarrow: true, render: (row: MetricRow) => <span className="cocoa-tabular">{row.values.unassigned ?? "—"}</span> }] : []),
      { key: "consolidated", label: withStructure ? ENTITY_TOTAL_LABEL : "Consolidado", align: "right", render: (row) => <strong className="cocoa-tabular">{row.values.consolidated ?? "—"}</strong> }
    ],
    [comparison.properties, comparison.corporate, comparison.unassigned, withStructure]
  );
  const gopBars: CocoaBarsDatum[] = comparison.properties.map((entry) => ({ label: entry.propertyName, value: toNumber(entry.pnl.gop) ?? 0, hint: `${entry.propertyName} · ingresos ${money(entry.pnl.totalOperatingRevenue, entry.pnl.currency)}` }));
  const revparBars: CocoaBarsDatum[] = comparison.properties.map((entry) => ({ label: entry.propertyName, value: toNumber(entry.pnl.ratios.revpar) ?? 0, hint: entry.pnl.ratios.revpar === null ? `${entry.propertyName} · sin habitaciones disponibles` : entry.propertyName }));
  const currency = comparison.consolidated.currency;
  const unassigned = comparison.properties.filter((entry) => entry.pnl.unassigned.accounts.length > 0);

  if (comparison.properties.length === 0) {
    return <CocoaState kind="empty" title="Sin hoteles que comparar" message="La sociedad no tiene hoteles con actividad en el periodo." />;
  }

  const entityName = comparison.entity?.legalName ?? "la sociedad";
  const totalLabel = withStructure ? ENTITY_TOTAL_LABEL.toLowerCase() : "consolidado";

  return (
    <>
      <WarningList items={unassigned.map((entry) => `${entry.propertyName}: ${plural(entry.pnl.unassigned.accounts.length, "cuenta sin asignar", "cuentas sin asignar")} (${money(entry.pnl.unassigned.net, entry.pnl.currency)} netos)`)} title="Cuentas sin línea USALI en el periodo" />
      <CocoaKpiStrip stagger aria-label={`Total de ${entityName}`}>
        <CocoaKpi label="Ingresos operativos" value={money(comparison.consolidated.totalOperatingRevenue, currency)} deltaLabel={totalLabel} polarity="neutral" />
        <CocoaKpi label="GOP" value={money(comparison.consolidated.gop, currency)} deltaLabel={totalLabel} polarity="positive-good" />
        <CocoaKpi label="EBITDA" value={money(comparison.consolidated.ebitda, currency)} deltaLabel={totalLabel} polarity="positive-good" />
        {comparison.corporate ? <CocoaKpi label={CORPORATE_COLUMN_LABEL} caption={plural(comparison.corporate.centres.length, "centro no alojativo", "centros no alojativos")} value={money(comparison.corporate.pnl.gop, currency)} deltaLabel="GOP" polarity="neutral" /> : null}
        <CocoaKpi label="Hoteles" value={number(comparison.properties.length)} deltaLabel={dateRange(comparison.period.from, comparison.period.to)} polarity="neutral" />
      </CocoaKpiStrip>
      <CocoaSection title="Centros comparados" meta={`generado ${dateTime(comparison.generatedAt)}`} footer={withStructure ? ENTITY_TOTAL_FOOTNOTE : "El consolidado es el libro completo de la sociedad cuando se comparan todos los centros."}>
        <CocoaTable columns={columns} rows={rows} rowKey="key" density="compact" stickyFirstColumn caption="Comparación entre centros de trabajo" aria-label="Comparación entre centros de trabajo" />
      </CocoaSection>
      {comparison.rollup && comparison.rollup.length > 0 ? (
        <CocoaSection title={ENTITY_TOTAL_LABEL} meta="Σ hoteles + Oficina central + Sin asignar">
          <CocoaTable columns={rollupColumns} rows={comparison.rollup} rowKey="metric" density="compact" caption="Comprobación del total de la sociedad" aria-label="Comprobación del total de la sociedad" />
        </CocoaSection>
      ) : null}
      {withStructure ? <AllocationSection comparison={comparison} allocation={comparison.allocation} applied={applyAllocation} /> : null}
      <CocoaGrid aria-label="Gráficos de la comparación" align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="GOP por propiedad">
            <CocoaChart.Bars data={gopBars} height={160} valueFormat={(value) => money(value, currency, { decimals: "auto" })} aria-label="GOP por propiedad" />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="RevPAR por propiedad">
            <CocoaChart.Bars data={revparBars} height={160} valueFormat={(value) => money(value, currency)} aria-label="RevPAR por propiedad" />
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </>
  );
}

// ---------------------------------------------------------------------------
// Comparar periodos
// ---------------------------------------------------------------------------

type PeriodInput = { from: string; to: string };
type DeltaLine = UsaliPeriodComparison["deltas"][number]["lines"][number];

function deltaValue(line: DeltaLine, value: string | null): string {
  if (value === null) return "—";
  return /ocupaci/i.test(line.label) ? pct(value) : money(value);
}

const DELTA_COLUMNS: CocoaTableColumn<DeltaLine>[] = [
  { key: "label", label: "Indicador", render: (row) => <span>{row.label}</span> },
  { key: "base", label: "Base", align: "right", render: (row) => <span className="cocoa-tabular">{deltaValue(row, row.base)}</span> },
  { key: "compared", label: "Comparado", align: "right", render: (row) => <span className="cocoa-tabular">{deltaValue(row, row.compared)}</span> },
  { key: "delta", label: "Variación", align: "right", hideOnNarrow: true, render: (row) => <span className="cocoa-tabular">{row.delta === null ? "—" : /ocupaci/i.test(row.label) ? percent(row.delta, { signDisplay: "always", maximumFractionDigits: 2 }) : money(row.delta, { signDisplay: "always" })}</span> },
  {
    key: "deltaPct",
    label: "Variación %",
    align: "right",
    render: (row) => (row.deltaPct === null ? <span>—</span> : <CocoaBadge tone={(toNumber(row.deltaPct) ?? 0) < 0 ? "danger" : (toNumber(row.deltaPct) ?? 0) > 0 ? "success" : "neutral"}>{signedPct(row.deltaPct)}</CocoaBadge>)
  }
];

function PeriodsComparisonView({ range, propertyId, propertyName }: { range: PeriodInput; propertyId: string; propertyName: string | null }) {
  const [periods, setPeriods] = useState<PeriodInput[]>(() => [range, previousWindow(range.from, range.to)]);
  const [applied, setApplied] = useState<PeriodInput[]>(periods);

  useEffect(() => {
    setPeriods((current) => [range, ...current.slice(1)]);
  }, [range]);

  const invalid = periods.some((period) => !validWindow(period.from, period.to));
  const key = applied.every((period) => validWindow(period.from, period.to)) && applied.length >= 2 ? `${applied.map((period) => `${period.from}..${period.to}`).join(",")}:${propertyId}` : null;
  const comparison = useStatement<UsaliPeriodComparison>(key, () => compareUsaliPeriods(applied, propertyId || undefined));
  const data = comparison.data;
  const errorMessage = comparison.error ? errorText(comparison.error, "No se pudo comparar los periodos.") : null;

  function updatePeriod(index: number, patch: Partial<PeriodInput>) {
    setPeriods((current) => current.map((period, position) => (position === index ? { ...period, ...patch } : period)));
  }

  function addPeriod() {
    setPeriods((current) => {
      const last = current[current.length - 1] ?? range;
      return current.length >= MAX_PERIODS ? current : [...current, previousWindow(last.from, last.to)];
    });
  }

  const gopBars: CocoaBarsDatum[] = (data?.periods ?? []).map((period) => ({ label: dateRange(period.from, period.to, { style: "dayMonth" }), value: toNumber(period.pnl.gop) ?? 0, hint: `${dateRange(period.from, period.to)} · GOP` }));
  const currency = data?.periods[0]?.pnl.currency;

  return (
    <>
      <CocoaSection title="Periodos a comparar" meta={`${plural(periods.length, "periodo", "periodos")} · el primero es la base`} footer={propertyName ? `Ámbito: ${propertyName}.` : "Ámbito: toda la sociedad."}>
        <div className="cocoa-stack" data-gap="3">
          {periods.map((period, index) => (
            <CocoaFormRow key={index} columns={3} min={200}>
              <CocoaField label={index === 0 ? "Base · desde" : `Periodo ${index + 1} · desde`} error={ISO_DAY.test(period.from) && ISO_DAY.test(period.to) && period.from > period.to ? "La fecha de inicio no puede ser posterior a la de fin." : undefined}>
                <CocoaDatePicker value={period.from} onChange={(value) => updatePeriod(index, { from: value })} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.to}>
                <CocoaDatePicker value={period.to} onChange={(value) => updatePeriod(index, { to: value })} />
              </CocoaField>
              <CocoaField label="Quitar" hint={index < 2 ? "mínimo dos periodos" : undefined}>
                <CocoaButton variant="bordered" tone="neutral" disabled={periods.length <= 2} onClick={() => setPeriods((current) => current.filter((_, position) => position !== index))}>
                  {ACTIONS.remove}
                </CocoaButton>
              </CocoaField>
            </CocoaFormRow>
          ))}
          <div className="cocoa-row" data-justify="between">
            <CocoaButton variant="bordered" tone="neutral" disabled={periods.length >= MAX_PERIODS} onClick={addPeriod}>
              Añadir periodo
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" disabled={invalid} loading={comparison.loading} onClick={() => setApplied(periods)}>
              Comparar
            </CocoaButton>
          </div>
        </div>
      </CocoaSection>

      {errorMessage ? <CocoaState kind="error" title={STATUS_LABELS.loadError} message={errorMessage} onRetry={comparison.refresh} /> : null}
      {!errorMessage && comparison.loading && !data ? <CocoaSkeleton.Grid rows={[[12]]} height={200} /> : null}
      {data ? (
        <>
          <CocoaSection title="GOP por periodo" meta={`generado ${dateTime(data.generatedAt)}`}>
            <CocoaChart.Bars data={gopBars} height={140} valueFormat={(value) => money(value, currency, { decimals: "auto" })} aria-label="GOP de cada periodo comparado" />
          </CocoaSection>
          {data.deltas.map((delta) => (
            <CocoaSection key={`${delta.from}..${delta.to}`} title={`${dateRange(delta.from, delta.to)} frente a la base ${dateRange(data.periods[0]?.from, data.periods[0]?.to)}`} footer="Variación % respecto a la base; un guion cuando la base es cero o el ratio no existe en alguno de los periodos.">
              <CocoaTable columns={DELTA_COLUMNS} rows={delta.lines} rowKey="label" density="compact" caption={`Variación ${dateRange(delta.from, delta.to)}`} aria-label={`Variación del periodo ${dateRange(delta.from, delta.to)}`} />
            </CocoaSection>
          ))}
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mapeo de cuentas
// ---------------------------------------------------------------------------

type MappingFilter = "todas" | "sin_mapeo" | "regla";

type MappingForm = {
  mappingId: string | null;
  accountPrefix: string;
  usaliDepartment: string;
  usaliLine: string;
  priority: string;
  active: boolean;
};

const EMPTY_FORM: MappingForm = { mappingId: null, accountPrefix: "", usaliDepartment: "", usaliLine: "", priority: "0", active: true };

function MappingEditorView({ response, configurable, onReplace }: { response: UsaliMappingsResponse; configurable: boolean; onReplace: (value: UsaliMappingsResponse) => void }) {
  const { showToast } = useToast();
  const [filter, setFilter] = useState<MappingFilter>("todas");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<MappingForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<UsaliMappingRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const departmentLabelOf = useMemo(() => new Map(response.departments.map((department) => [department.key, department.label])), [response.departments]);
  const lineLabelOf = useMemo(() => new Map(response.lines.map((line) => [line.key, line.label])), [response.lines]);
  const admittedLines = useMemo(() => new Map(response.departments.map((department) => [department.key, department.lines])), [response.departments]);
  const labelDepartment = (key: UsaliDepartmentKey | null) => (key ? departmentLabelOf.get(key) ?? DEPARTMENT_LABELS[key] ?? key : "—");
  const labelLine = (key: UsaliLineKey | null) => (key ? lineLabelOf.get(key) ?? LINE_LABELS[key] ?? key : "—");

  const { coverage, mappings } = response;
  const resolutions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return coverage.resolutions.filter((row) => {
      if (filter === "sin_mapeo" && row.usaliDepartment !== null && row.issue === null) return false;
      if (filter === "regla" && row.source !== "mapping") return false;
      if (needle && !row.code.toLowerCase().includes(needle) && !row.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [coverage.resolutions, filter, search]);

  function openForm(seed: Partial<MappingForm>) {
    setFormError(null);
    setForm({ ...EMPTY_FORM, ...seed });
  }

  function openFromResolution(row: UsaliAccountResolution) {
    const existing = row.mappingId ? mappings.find((mapping) => mapping.id === row.mappingId) : null;
    openForm(
      existing
        ? { mappingId: existing.id, accountPrefix: existing.accountPrefix, usaliDepartment: existing.usaliDepartment, usaliLine: existing.usaliLine, priority: String(existing.priority), active: existing.active }
        : { accountPrefix: row.code, usaliDepartment: row.usaliDepartment ?? "", usaliLine: row.usaliLine ?? "" }
    );
  }

  function openFromRule(row: UsaliMappingRow) {
    openForm({ mappingId: row.id, accountPrefix: row.accountPrefix, usaliDepartment: row.usaliDepartment, usaliLine: row.usaliLine, priority: String(row.priority), active: row.active });
  }

  const linesForDepartment = form?.usaliDepartment ? admittedLines.get(form.usaliDepartment as UsaliDepartmentKey) ?? [] : [];
  const prefixError = form && form.accountPrefix !== "" && !ACCOUNT_PREFIX.test(form.accountPrefix.trim()) ? "Indica un código o prefijo de los grupos 6 o 7 (p. ej. 62, 629.1, 705.1)." : undefined;
  const priorityNumber = form ? toNumber(form.priority) : null;
  const priorityError = form && form.priority !== "" && (priorityNumber === null || !Number.isInteger(priorityNumber) || priorityNumber < 0 || priorityNumber > 1000) ? "Entero entre 0 y 1000." : undefined;
  const formReady = Boolean(form && form.accountPrefix.trim() && form.usaliDepartment && form.usaliLine && !prefixError && !priorityError);

  async function save() {
    if (!form || !formReady) return;
    setSaving(true);
    setFormError(null);
    try {
      const next = await patchUsaliMappings({
        mappings: [
          {
            accountPrefix: form.accountPrefix.trim(),
            usaliDepartment: form.usaliDepartment as UsaliDepartmentKey,
            usaliLine: form.usaliLine as UsaliLineKey,
            priority: form.priority === "" ? undefined : priorityNumber ?? undefined,
            active: form.active
          }
        ]
      });
      onReplace(next);
      showToast(`Regla guardada: ${form.accountPrefix.trim()} → ${labelDepartment(form.usaliDepartment as UsaliDepartmentKey)} · ${labelLine(form.usaliLine as UsaliLineKey)}`, { variant: "success" });
      setForm(null);
    } catch (err) {
      setFormError(errorText(err, "No se pudo guardar la regla."));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const next = await deleteUsaliMapping(deleting.id);
      onReplace(next);
      showToast(`Regla eliminada: ${deleting.accountPrefix}. La cuenta vuelve al mapeo de su ficha o de la plantilla.`, { variant: "success" });
      setDeleting(null);
    } catch (err) {
      showToast(errorText(err, "No se pudo eliminar la regla."), { variant: "error" });
    } finally {
      setDeleteBusy(false);
    }
  }

  const resolutionColumns = useMemo<CocoaTableColumn<UsaliAccountResolution>[]>(
    () => [
      {
        key: "code",
        label: "Cuenta",
        render: (row) => (
          <span>
            <span className="cocoa-mono">{row.code}</span> {row.name}
          </span>
        )
      },
      { key: "kind", label: FIELD_LABELS.type, hideOnNarrow: true, render: (row) => <CocoaBadge tone={row.kind === "income" ? "success" : "neutral"}>{row.kind === "income" ? "ingreso" : "gasto"}</CocoaBadge> },
      { key: "usaliDepartment", label: "Departamento", render: (row) => <span>{labelDepartment(row.usaliDepartment)}</span> },
      { key: "usaliLine", label: "Línea", hideOnNarrow: true, render: (row) => <span>{labelLine(row.usaliLine)}</span> },
      { key: "source", label: "Origen", hideOnNarrow: true, render: (row) => <CocoaBadge tone={SOURCE_LABELS[row.source].tone}>{SOURCE_LABELS[row.source].label}</CocoaBadge> },
      { key: "issue", label: "Aviso", hideOnNarrow: true, render: (row) => (row.issue ? <CocoaBadge tone="warning" variant="tinted" uppercase={false}>{row.issue}</CocoaBadge> : <span>—</span>) }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [departmentLabelOf, lineLabelOf]
  );

  const ruleColumns = useMemo<CocoaTableColumn<UsaliMappingRow>[]>(
    () => [
      { key: "accountPrefix", label: "Cuenta o prefijo", render: (row) => <span className="cocoa-mono">{row.accountPrefix}</span> },
      { key: "usaliDepartment", label: "Departamento", render: (row) => <span>{labelDepartment(row.usaliDepartment)}</span> },
      { key: "usaliLine", label: "Línea", render: (row) => <span>{labelLine(row.usaliLine)}</span> },
      { key: "priority", label: "Prioridad", align: "right", hideOnNarrow: true, render: (row) => <span className="cocoa-tabular">{number(row.priority)}</span> },
      { key: "active", label: FIELD_LABELS.status, hideOnNarrow: true, render: (row) => <CocoaBadge tone={row.active ? "success" : "neutral"}>{row.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}</CocoaBadge> },
      { key: "updatedAt", label: FIELD_LABELS.updatedAt, hideOnNarrow: true, render: (row) => <span>{date(row.updatedAt, "short")}</span> }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [departmentLabelOf, lineLabelOf]
  );

  const unmappedWithMovements = coverage.unmappedWithMovements;
  const deleteCopy = deleting ? confirmDelete(`la regla ${deleting.accountPrefix}`, { message: "Las cuentas afectadas vuelven al mapeo de su ficha del plan o de la plantilla; si no lo tienen, pasan a «Sin asignar»." }) : null;

  return (
    <>
      <CocoaKpiStrip stagger aria-label="Cobertura del mapeo USALI">
        <CocoaKpi label="Cuentas de PyG" value={number(coverage.totalAccounts)} deltaLabel="grupos 6 y 7 imputables" polarity="neutral" />
        <CocoaKpi label="Con línea USALI" value={number(coverage.mapped)} deltaLabel={coverage.totalAccounts > 0 ? percent((coverage.mapped / coverage.totalAccounts) * 100, { maximumFractionDigits: 0 }) : undefined} polarity="positive-good" />
        <CocoaKpi label="Sin mapeo" value={number(coverage.unmapped)} deltaLabel={coverage.period ? `${number(unmappedWithMovements.length)} con movimientos` : undefined} polarity="negative-good" status={coverage.unmapped > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Reglas propias" value={number(mappings.length)} deltaLabel={`${number(coverage.bySource.mapping)} cuentas resueltas por regla`} polarity="neutral" />
      </CocoaKpiStrip>

      {coverage.unmappedAccounts.length > 0 ? (
        <CocoaCallout
          tone="warning"
          variant="banner"
          title={`${plural(coverage.unmappedAccounts.length, "cuenta sin línea USALI", "cuentas sin línea USALI")}: ${coverage.unmappedAccounts.map((row) => row.code).join(", ")}`}
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setFilter("sin_mapeo")}>
              Ver solo sin mapeo
            </CocoaButton>
          }
        >
          {unmappedWithMovements.length > 0 ? `${plural(unmappedWithMovements.length, "de ellas tiene", "de ellas tienen")} movimientos en el periodo y aparecen en «Sin asignar» de la cuenta de explotación.` : "Ninguna tiene movimientos en el periodo; asígnalas para que la cuenta de explotación siga cuadrando cuando los tengan."}
        </CocoaCallout>
      ) : (
        <CocoaCallout tone="success" variant="banner" title="Todas las cuentas de PyG tienen departamento y línea USALI" role="status">
          Orden de resolución: regla propia (mayor prioridad y prefijo más largo) → ficha de la cuenta → plantilla del plan → «Sin asignar».
        </CocoaCallout>
      )}

      <CocoaSection
        title="Reglas propias de la sociedad"
        meta={mappings.length > 0 ? plural(mappings.length, "regla", "reglas") : undefined}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" disabled={!configurable} onClick={() => openForm({})}>
            Nueva regla
          </CocoaButton>
        }
        footer={configurable ? "Una regla se aplica a la cuenta exacta o a todas las que empiezan por el prefijo; gana la de mayor prioridad y, a igual prioridad, el prefijo más largo." : "Necesitas el permiso de configuración contable para crear, editar o eliminar reglas."}
      >
        {mappings.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin reglas propias: las cuentas se resuelven por su ficha del plan o por la plantilla." />
        ) : (
          <CocoaTable
            columns={ruleColumns}
            rows={mappings}
            rowKey="id"
            density="compact"
            caption="Reglas propias"
            aria-label="Reglas propias"
            rowActions={(row) => (
              <span className="cocoa-cluster">
                <CocoaButton
                  variant="plain"
                  tone="accent"
                  size="small"
                  disabled={!configurable}
                  onClick={(event) => {
                    event.stopPropagation();
                    openFromRule(row);
                  }}
                >
                  {ACTIONS.edit}
                </CocoaButton>
                <CocoaButton
                  variant="plain"
                  tone="destructive"
                  size="small"
                  disabled={!configurable}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleting(row);
                  }}
                >
                  {ACTIONS.delete}
                </CocoaButton>
              </span>
            )}
          />
        )}
      </CocoaSection>

      <CocoaSection
        title="Cuentas de pérdidas y ganancias"
        meta={`${number(resolutions.length)} de ${number(coverage.resolutions.length)}`}
        footer="Pulsa «Asignar» para crear o editar la regla de una cuenta; la regla se guarda con el código exacto salvo que lo cambies por un prefijo."
      >
        <div className="cocoa-stack" data-gap="3">
          <div className="cocoa-row" data-justify="between">
            <CocoaSegmentedControl
              value={filter}
              onChange={(value) => setFilter(value as MappingFilter)}
              options={[
                { value: "todas", label: STATUS_LABELS.all },
                { value: "sin_mapeo", label: "Sin mapeo o con aviso" },
                { value: "regla", label: "Con regla propia" }
              ]}
              size="small"
              aria-label="Filtro de cuentas"
            />
            <CocoaSearchInput value={search} onChange={setSearch} placeholder="Código o nombre de cuenta" aria-label="Buscar cuenta" />
          </div>
          {resolutions.length === 0 ? (
            <CocoaState kind="empty" inline title={STATUS_LABELS.noResults} message="Prueba con otro filtro o término de búsqueda." />
          ) : (
            <CocoaTable
              columns={resolutionColumns}
              rows={resolutions}
              rowKey="code"
              density="compact"
              caption="Cuentas de pérdidas y ganancias y su línea USALI"
              aria-label="Cuentas de pérdidas y ganancias y su línea USALI"
              rowTone={(row) => (row.usaliDepartment === null || row.issue ? "warning" : undefined)}
              rowActions={(row) => (
                <CocoaButton
                  variant="plain"
                  tone="accent"
                  size="small"
                  disabled={!configurable}
                  onClick={(event) => {
                    event.stopPropagation();
                    openFromResolution(row);
                  }}
                >
                  {row.source === "mapping" ? ACTIONS.edit : ACTIONS.assign}
                </CocoaButton>
              )}
            />
          )}
        </div>
      </CocoaSection>

      <CocoaDrawer
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.mappingId ? "Editar regla USALI" : "Nueva regla USALI"}
        subtitle="Cuenta o prefijo PGC → departamento y línea USALI"
        size="sm"
        footer={
          <div className="cocoa-row" data-justify="end">
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setForm(null)}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" disabled={!formReady || !configurable} loading={saving} onClick={() => void save()}>
              {ACTIONS.save}
            </CocoaButton>
          </div>
        }
      >
        {form ? (
          <div className="cocoa-stack" data-gap="3">
            {formError ? (
              <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
                {formError}
              </CocoaCallout>
            ) : null}
            <CocoaField label="Cuenta o prefijo" required help="Código exacto (705.1) o prefijo (62) de los grupos 6 o 7. Se guarda una regla por prefijo." error={prefixError}>
              <CocoaInput value={form.accountPrefix} onChange={(value) => setForm({ ...form, accountPrefix: value })} placeholder="705.1" inputMode="decimal" />
            </CocoaField>
            <CocoaField label="Departamento" required>
              <CocoaSelect
                value={form.usaliDepartment}
                onChange={(value) => {
                  const lines = admittedLines.get(value as UsaliDepartmentKey) ?? [];
                  setForm({ ...form, usaliDepartment: value, usaliLine: lines.length === 1 ? lines[0] : lines.includes(form.usaliLine as UsaliLineKey) ? form.usaliLine : "" });
                }}
                placeholder="Elige un departamento"
                options={response.departments.map((department) => ({ value: department.key, label: department.label }))}
              />
            </CocoaField>
            <CocoaField label="Línea" required help={form.usaliDepartment ? `Líneas admitidas en ${labelDepartment(form.usaliDepartment as UsaliDepartmentKey)}.` : "Elige antes el departamento."}>
              <CocoaSelect
                value={form.usaliLine}
                onChange={(value) => setForm({ ...form, usaliLine: value })}
                disabled={!form.usaliDepartment}
                placeholder="Elige una línea"
                options={linesForDepartment.map((line) => ({ value: line, label: labelLine(line) }))}
              />
            </CocoaField>
            <CocoaField label="Prioridad" help="A igual prefijo gana la prioridad más alta (0 a 1000)." error={priorityError}>
              <CocoaInput value={form.priority} onChange={(value) => setForm({ ...form, priority: value })} type="number" inputMode="numeric" min={0} max={1000} step={1} />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.status} inline>
              <CocoaSwitch checked={form.active} onChange={(value) => setForm({ ...form, active: value })} label={form.active ? "Regla activa" : "Regla inactiva (se ignora)"} />
            </CocoaField>
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleteCopy?.title ?? ""}
        description={deleteCopy?.message}
        tone="destructive"
        confirmLabel={deleteCopy?.confirmLabel}
        cancelLabel={deleteCopy?.cancelLabel}
        onConfirm={remove}
        busy={deleteBusy}
      />
    </>
  );
}

export default UsaliScreen;
