// Cuentas anuales — /finanzas/estados-contables/cuentas-anuales (Tanda 6 · Finanzas · lote 6-F).
//
// Hosted in EstadosContablesTabs (useTabHost → the container paints eyebrow
// and H1; this page adds its inner views and actions). Cocoa 22 dashboard
// archetype (COCOA-22.md §4.3 DashboardAlojado) with tables for each PGC Pymes
// document. Zero inline `style` attributes on purpose: the global inline-style ceiling of
// tests/cocoa-22-contract.test.mjs (rule 13) only goes down, so layout comes
// from the primitives and the `cocoa-stack` / `cocoa-row` / `c22-section__list`
// utility classes.
//
// Data (services/financialStatementsApi.ts on financial-statements-types.ts):
//   GET  /accounting/annual-accounts?fiscalYearId|from&to&propertyId&comparative   getAnnualAccounts
//   GET  /accounting/annual-accounts[/balance|/pyg|/ecpn|/memoria]?format=        downloadStatement
//   GET  /accounting/annual-accounts/snapshots                                    listSnapshots
//   POST /accounting/annual-accounts/snapshots                                    createSnapshot (accounting.configure)
//   GET  /accounting/annual-accounts/snapshots/:id/download?format=               downloadSnapshot
//   GET  /accounting/fiscal-years                                                 fiscal-year picker (same list as Cierre de ejercicio)
//
// Money arrives as decimal strings ("1234.56"): they are turned into numbers
// only inside lib/format (money / percent / number). Notes of the memoria
// marked `requires_input` get a local draft (this browser only): the API has
// no route to persist the wording yet, and the page says so instead of
// pretending the download carries it.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AnnualAccounts,
  EcpnRow,
  FinancialStatementKindKey,
  FinancialStatementSnapshotRow,
  MemoriaNote,
  PgcBalanceSheet,
  PgcProfitAndLoss,
  StatementAccountAmount,
  StatementLine
} from "@hotelos/shared";
import { useApiData } from "../../hooks/useApiData";
import { useNavGate } from "../../navigation/useEnabledModules";
import { getActiveOrganizationId, loadSwitchableProperties, type SwitchableProperty } from "../../services/activeProperty";
import type { NamedDownload } from "../../services/accountingApi";
import { financeErrorCode, financeErrorDetails, financeErrorStatus } from "../../services/finance-contracts";
import {
  createSnapshot,
  downloadSnapshot,
  downloadStatement,
  getAnnualAccounts,
  listSnapshots,
  statementsErrorMessage,
  type AnnualAccountsQueryInput,
  type StatementRoute
} from "../../services/financialStatementsApi";
import { toArray } from "../../utils/toArray";
import { date, dateRange, dateTime, money, number, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, UI_STATES, confirmAction } from "../../content/actions";
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
  CocoaSection,
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
// Types
// ---------------------------------------------------------------------------

type View = "resumen" | "balance" | "pyg" | "ecpn" | "memoria" | "instantaneas";

const VIEWS: Array<{ value: View; label: string }> = [
  { value: "resumen", label: "Resumen" },
  { value: "balance", label: "Balance" },
  { value: "pyg", label: "Pérdidas y ganancias" },
  { value: "ecpn", label: "Patrimonio neto" },
  { value: "memoria", label: "Memoria" },
  { value: "instantaneas", label: "Instantáneas" }
];

/** Row shape of GET /accounting/fiscal-years (server.ts listFiscalYears; the same list Cierre de ejercicio paints). */
type FiscalYear = {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: "open" | "closing" | "closed";
};

/** A line of the balance / P&L tables: statement lines plus the subtotal and total rows the models print. */
type StatementRow = {
  id: string;
  label: string;
  amount: string;
  previousAmount?: string;
  accounts: StatementAccountAmount[];
  kind: "line" | "subtotal" | "total";
};

type SnapshotFormat = "pdf" | "xlsx" | "csv";

const SNAPSHOT_KIND_LABELS: Record<FinancialStatementKindKey, string> = {
  balance: "Balance de situación",
  pyg: "Cuenta de pérdidas y ganancias",
  ecpn: "Estado de cambios en el patrimonio neto",
  memoria: "Memoria",
  usali: "Cuenta de explotación USALI"
};

const FISCAL_YEAR_STATUS: Record<FiscalYear["status"], { label: string; tone: CocoaTone }> = {
  open: { label: "Abierto", tone: "success" },
  closing: { label: "En cierre", tone: "warning" },
  closed: { label: "Cerrado", tone: "neutral" }
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DOWNLOAD_FORMATS: SnapshotFormat[] = ["pdf", "xlsx", "csv"];
const FORMAT_LABELS: Record<SnapshotFormat, string> = { pdf: "PDF", xlsx: "Hoja de cálculo", csv: "CSV" };

// ---------------------------------------------------------------------------
// Local helpers (no network besides the typed client)
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

  return { data, loading, error, refresh: () => setNonce((n) => n + 1) };
}

/** Spanish text for an API failure: 403 → the RBAC copy; 400 VALIDATION_ERROR → the field issues; else the finance dictionary / API message. */
function errorText(error: unknown, fallback: string): string {
  if (financeErrorStatus(error) === 403) return UI_STATES.forbidden.message;
  const details = financeErrorDetails(error);
  if (financeErrorCode(error) === "VALIDATION_ERROR" && Array.isArray(details?.issues)) {
    const issues = (details.issues as Array<{ message?: unknown }>).map((issue) => (typeof issue.message === "string" ? issue.message : "")).filter(Boolean);
    if (issues.length > 0) return `Revisa los datos: ${issues.join("; ")}.`;
  }
  return statementsErrorMessage(error, fallback);
}

/** Hands the browser the file the API named (Content-Disposition). */
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

/** Properties of the active organisation (GET /users/me/properties, memoised by activeProperty.ts) and its display name. */
function useOrganizationScope() {
  const organizationId = getActiveOrganizationId();
  const [properties, setProperties] = useState<SwitchableProperty[]>([]);
  useEffect(() => {
    let alive = true;
    loadSwitchableProperties()
      .then((list) => {
        if (alive) setProperties(list.filter((property) => property.organizationId === organizationId));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [organizationId]);
  const organizationName = properties.find((property) => property.organizationName)?.organizationName ?? "Organización";
  return { organizationId, organizationName, properties };
}

function validWindow(from: string, to: string): boolean {
  return ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to;
}

function toStatementRow(line: StatementLine): StatementRow {
  return { id: line.id, label: line.label, amount: line.amount, previousAmount: line.previousAmount, accounts: line.accounts, kind: "line" };
}

function aggregateRow(id: string, label: string, amount: string, kind: "subtotal" | "total"): StatementRow {
  return { id, label, amount, accounts: [], kind };
}

/** Balance rows (assets side and equity + liabilities side) with the subtotals of the Pymes model. */
function balanceRows(balance: PgcBalanceSheet): { assets: StatementRow[]; equityAndLiabilities: StatementRow[] } {
  const assets = [
    ...balance.assets.nonCurrent.map(toStatementRow),
    aggregateRow("A_total", "Total activo no corriente (A)", balance.assets.totalNonCurrent, "subtotal"),
    ...balance.assets.current.map(toStatementRow),
    aggregateRow("B_total", "Total activo corriente (B)", balance.assets.totalCurrent, "subtotal"),
    aggregateRow("assets_total", "Total activo (A + B)", balance.totalAssets, "total")
  ];
  const equityAndLiabilities = [
    ...balance.equity.lines.map(toStatementRow),
    aggregateRow("E_total", "Total patrimonio neto (A)", balance.equity.total, "subtotal"),
    ...balance.liabilities.nonCurrent.map(toStatementRow),
    aggregateRow("L_nc_total", "Total pasivo no corriente (B)", balance.liabilities.totalNonCurrent, "subtotal"),
    ...balance.liabilities.current.map(toStatementRow),
    aggregateRow("L_c_total", "Total pasivo corriente (C)", balance.liabilities.totalCurrent, "subtotal"),
    aggregateRow("el_total", "Total patrimonio neto y pasivo (A + B + C)", balance.totalEquityAndLiabilities, "total")
  ];
  return { assets, equityAndLiabilities };
}

/** P&L rows: the 18 items of the Pymes model with the A) B) C) D) results after their block. */
function pygRows(pyg: PgcProfitAndLoss): StatementRow[] {
  const rows: StatementRow[] = [];
  const ids = new Set(pyg.lines.map((line) => line.id));
  for (const line of pyg.lines) {
    rows.push(toStatementRow(line));
    if (line.id === "P12") rows.push(aggregateRow("A_result", "A) Resultado de explotación", pyg.operatingResult, "subtotal"));
    if (line.id === "P17") {
      rows.push(aggregateRow("B_result", "B) Resultado financiero", pyg.financialResult, "subtotal"));
      rows.push(aggregateRow("C_result", "C) Resultado antes de impuestos (A + B)", pyg.resultBeforeTax, "subtotal"));
    }
    if (line.id === "P18") rows.push(aggregateRow("D_result", "D) Resultado del ejercicio", pyg.netResult, "total"));
  }
  // A ledger whose lines do not carry the model ids still gets its results.
  if (!ids.has("P12")) rows.push(aggregateRow("A_result", "A) Resultado de explotación", pyg.operatingResult, "subtotal"));
  if (!ids.has("P17")) {
    rows.push(aggregateRow("B_result", "B) Resultado financiero", pyg.financialResult, "subtotal"));
    rows.push(aggregateRow("C_result", "C) Resultado antes de impuestos (A + B)", pyg.resultBeforeTax, "subtotal"));
  }
  if (!ids.has("P18")) rows.push(aggregateRow("D_result", "D) Resultado del ejercicio", pyg.netResult, "total"));
  return rows;
}

function rowLabel(row: StatementRow) {
  return row.kind === "line" ? <span>{row.label}</span> : <strong>{row.label}</strong>;
}

function rowAmount(value: string | undefined) {
  return <span className="cocoa-tabular">{money(value)}</span>;
}

/** Table columns of a statement (declared once; the comparative column is appended when requested). */
function statementColumns(comparative: boolean, previousLabel: string): CocoaTableColumn<StatementRow>[] {
  const columns: CocoaTableColumn<StatementRow>[] = [
    { key: "label", label: "Partida", render: rowLabel },
    { key: "amount", label: FIELD_LABELS.amount, align: "right", render: (row) => rowAmount(row.amount) }
  ];
  if (comparative) columns.push({ key: "previousAmount", label: previousLabel, align: "right", hideOnNarrow: true, render: (row) => (row.kind === "line" ? rowAmount(row.previousAmount) : null) });
  columns.push({ key: "accounts", label: "Cuentas", align: "right", hideOnNarrow: true, render: (row) => (row.kind === "line" ? <span className="cocoa-tabular">{number(row.accounts.length)}</span> : null) });
  return columns;
}

function memoriaDraftKey(organizationId: string, period: { from: string; to: string }): string {
  return `anfitorio-memoria-notas:${organizationId}:${period.from}:${period.to}`;
}

function readDrafts(key: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeDrafts(key: string, drafts: Record<string, string>): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

/** Figures of a memoria note (free JSON from the API) as nested lists; money-looking strings are formatted. */
function FigureValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span>—</span>;
  if (typeof value === "boolean") return <span>{value ? STATUS_LABELS.yes : STATUS_LABELS.no}</span>;
  if (typeof value === "number") return <span className="cocoa-tabular">{number(value)}</span>;
  if (typeof value === "string") return <span className="cocoa-tabular">{/^-?\d+\.\d{2}$/.test(value) ? money(value) : value}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>Sin registros</span>;
    return (
      <ul className="c22-section__list">
        {value.map((item, index) => (
          <li key={index}>
            <FigureValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span>Sin registros</span>;
  return (
    <ul className="c22-section__list">
      {entries.map(([key, entry]) => (
        <li key={key}>
          <span>{key}</span>
          <FigureValue value={entry} />
        </li>
      ))}
    </ul>
  );
}

function StatementSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={140} />
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function AnnualAccountsScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const { organizationId, organizationName, properties } = useOrganizationScope();
  // Real grants of the active property (never the demo union of the login payload):
  // unknown while the profile loads → enabled, the API answers 403 if it must.
  const configurable = canDo(useNavGate(), "accounting.configure");

  const today = new Date();
  const [view, setView] = useState<View>("resumen");
  const [fiscalYearId, setFiscalYearId] = useState("");
  const [from, setFrom] = useState(`${today.getFullYear()}-01-01`);
  const [to, setTo] = useState(`${today.getFullYear()}-12-31`);
  const [propertyId, setPropertyId] = useState("");
  const [comparative, setComparative] = useState(false);

  const fiscalYears = useApiData<FiscalYear[]>("/accounting/fiscal-years");
  const years = toArray<FiscalYear>(fiscalYears.data);

  const windowOk = fiscalYearId !== "" || validWindow(from, to);
  const input: AnnualAccountsQueryInput = useMemo(
    () => (fiscalYearId ? { fiscalYearId, propertyId: propertyId || undefined, comparative } : { from, to, propertyId: propertyId || undefined, comparative }),
    [fiscalYearId, from, to, propertyId, comparative]
  );
  const statement = useStatement<AnnualAccounts>(windowOk ? JSON.stringify(input) : null, () => getAnnualAccounts(input));
  const accounts = statement.data;

  const snapshots = useStatement<FinancialStatementSnapshotRow[]>(view === "instantaneas" ? `snapshots:${organizationId}` : null, () => listSnapshots({ limit: 200 }));

  const [downloading, setDownloading] = useState<string | null>(null);
  const [detail, setDetail] = useState<StatementRow | null>(null);

  const period = accounts?.period ?? (fiscalYearId ? years.find((year) => year.id === fiscalYearId) : null);
  const periodFrom = period ? ("from" in period ? period.from : period.startDate) : from;
  const periodTo = period ? ("to" in period ? period.to : period.endDate) : to;

  const downloadRoute: StatementRoute | null = view === "resumen" ? "annual-accounts" : view === "instantaneas" ? null : view;

  async function download(route: StatementRoute, format: SnapshotFormat) {
    const key = `${route}:${format}`;
    setDownloading(key);
    try {
      saveDownload(await downloadStatement(route, input, format));
    } catch (err) {
      showToast(errorText(err, "No se pudo descargar el documento."), { variant: "error" });
    } finally {
      setDownloading(null);
    }
  }

  // The filter section stays mounted while the statement loads (no focus loss
  // while typing a date): loading / error live below it, never as the page state.
  const statementPending = statement.loading && !accounts;
  const statementFailed = Boolean(statement.error) && !accounts;
  const loadErrorMessage = statement.error ? errorText(statement.error, "No se pudieron generar las cuentas anuales.") : undefined;
  const subtitle = accounts
    ? `Balance, pérdidas y ganancias, cambios en el patrimonio neto y memoria del modelo Pymes · ${dateRange(accounts.period.from, accounts.period.to)} · generado ${dateTime(accounts.generatedAt)}`
    : "Balance, pérdidas y ganancias, cambios en el patrimonio neto y memoria del modelo Pymes, con comprobación de coherencia.";

  const actions = (
    <>
      {statement.loading && accounts ? <CocoaBadge tone="info">actualizando</CocoaBadge> : null}
      {downloadRoute
        ? DOWNLOAD_FORMATS.map((format) => (
            <CocoaButton key={format} variant="bordered" tone="neutral" size="small" disabled={!accounts} loading={downloading === `${downloadRoute}:${format}`} onClick={() => void download(downloadRoute, format)}>
              {`${ACTIONS.download} ${FORMAT_LABELS[format]}`}
            </CocoaButton>
          ))
        : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={statement.refresh}>
        {ACTIONS.refresh}
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${organizationName}`}
      title="Cuentas anuales"
      subtitle={hosted ? undefined : subtitle}
      actions={actions}
      tabs={VIEWS}
      activeTab={view}
      onTabChange={(value) => setView(value as View)}
      commands={[
        { id: "cuentas-anuales-actualizar", label: "Actualizar cuentas anuales", run: statement.refresh },
        { id: "cuentas-anuales-pdf", label: "Descargar cuentas anuales en PDF", run: () => void download("annual-accounts", "pdf") }
      ]}
    >
      <ScopeSection
        years={years}
        yearsError={fiscalYears.error}
        fiscalYearId={fiscalYearId}
        onFiscalYear={setFiscalYearId}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
        propertyId={propertyId}
        onProperty={setPropertyId}
        properties={properties}
        comparative={comparative}
        onComparative={setComparative}
        accounts={accounts}
      />

      {view !== "instantaneas" && !windowOk ? <CocoaState kind="empty" title="Indica un periodo válido" message="La fecha de inicio no puede ser posterior a la de fin." /> : null}
      {view !== "instantaneas" && windowOk && statementPending ? <StatementSkeleton /> : null}
      {view !== "instantaneas" && windowOk && statementFailed ? <CocoaState kind="error" title={STATUS_LABELS.loadError} message={loadErrorMessage} onRetry={statement.refresh} /> : null}

      {accounts && view === "resumen" ? <SummaryView accounts={accounts} /> : null}
      {accounts && view === "balance" ? <BalanceView balance={accounts.balance} comparative={comparative} onOpen={setDetail} /> : null}
      {accounts && view === "pyg" ? <ProfitAndLossView pyg={accounts.pyg} comparative={comparative} onOpen={setDetail} /> : null}
      {accounts && view === "ecpn" ? <EquityChangesView accounts={accounts} /> : null}
      {accounts && view === "memoria" ? <MemoriaView accounts={accounts} organizationId={organizationId} /> : null}
      {view === "instantaneas" ? (
        <SnapshotsView
          rows={toArray<FinancialStatementSnapshotRow>(snapshots.data)}
          loading={snapshots.loading}
          error={snapshots.error}
          onRefresh={snapshots.refresh}
          input={input}
          periodLabel={dateRange(periodFrom, periodTo)}
          configurable={configurable}
        />
      ) : null}

      <CocoaDrawer open={detail !== null} onClose={() => setDetail(null)} title={detail?.label ?? "Partida"} subtitle={detail ? money(detail.amount) : undefined} size="sm">
        {detail && detail.accounts.length > 0 ? (
          <ul className="c22-section__list">
            {detail.accounts.map((account) => (
              <li key={account.code}>
                <span>
                  <span className="cocoa-mono">{account.code}</span> {account.name}
                </span>
                <strong>{money(account.amount)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <CocoaState kind="empty" inline title={detail?.kind === "line" ? "Sin cuentas con saldo en esta partida." : "Partida agregada: el desglose está en sus componentes."} />
        )}
      </CocoaDrawer>
    </CocoaPage>
  );
}

// ---------------------------------------------------------------------------
// Scope (fiscal year / dates / property / comparative)
// ---------------------------------------------------------------------------

interface ScopeSectionProps {
  years: FiscalYear[];
  yearsError: string | null;
  fiscalYearId: string;
  onFiscalYear: (value: string) => void;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  propertyId: string;
  onProperty: (value: string) => void;
  properties: SwitchableProperty[];
  comparative: boolean;
  onComparative: (value: boolean) => void;
  accounts: AnnualAccounts | null;
}

function ScopeSection({ years, yearsError, fiscalYearId, onFiscalYear, from, to, onFrom, onTo, propertyId, onProperty, properties, comparative, onComparative, accounts }: ScopeSectionProps) {
  const byDates = fiscalYearId === "";
  const dateError = byDates && ISO_DAY.test(from) && ISO_DAY.test(to) && from > to ? "La fecha de inicio no puede ser posterior a la de fin." : undefined;
  const fiscalYear = accounts?.fiscalYear ?? null;
  const footer = accounts ? (
    <span>
      Periodo {dateRange(accounts.period.from, accounts.period.to)} · {accounts.propertyId ? "una propiedad" : "toda la organización"} ·{" "}
      {fiscalYear ? `ejercicio ${fiscalYear.code}` : "sin ejercicio fiscal registrado: se calcula por fechas"} · generado {dateTime(accounts.generatedAt)}
    </span>
  ) : yearsError ? (
    <span>No se pudo cargar la lista de ejercicios fiscales; puedes trabajar por fechas.</span>
  ) : undefined;

  return (
    <CocoaSection title="Ejercicio y ámbito" meta={fiscalYear ? <CocoaBadge tone={FISCAL_YEAR_STATUS[fiscalYear.status as FiscalYear["status"]]?.tone ?? "neutral"}>{FISCAL_YEAR_STATUS[fiscalYear.status as FiscalYear["status"]]?.label ?? fiscalYear.status}</CocoaBadge> : undefined} footer={footer}>
      <CocoaFormRow columns={4} min={200}>
        <CocoaField label="Ejercicio fiscal" help={years.length === 0 ? "La organización no tiene ejercicios registrados: se calcula por fechas." : undefined}>
          <CocoaSelect
            value={fiscalYearId}
            onChange={onFiscalYear}
            options={[{ value: "", label: "Por fechas" }, ...years.map((year) => ({ value: year.id, label: `${year.code} · ${FISCAL_YEAR_STATUS[year.status]?.label ?? year.status}` }))]}
          />
        </CocoaField>
        <CocoaField label={FIELD_LABELS.from} error={dateError}>
          <CocoaDatePicker value={from} onChange={onFrom} disabled={!byDates} />
        </CocoaField>
        <CocoaField label={FIELD_LABELS.to}>
          <CocoaDatePicker value={to} onChange={onTo} disabled={!byDates} />
        </CocoaField>
        <CocoaField label={FIELD_LABELS.property}>
          <CocoaSelect value={propertyId} onChange={onProperty} options={[{ value: "", label: "Toda la organización" }, ...properties.map((property) => ({ value: property.id, label: property.name }))]} />
        </CocoaField>
      </CocoaFormRow>
      <CocoaField label="Comparativo" inline help="Añade el periodo anterior de la misma duración al balance y a la cuenta de pérdidas y ganancias.">
        <CocoaSwitch checked={comparative} onChange={onComparative} label="Mostrar el periodo anterior" />
      </CocoaField>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

function CoherenceCallout({ accounts }: { accounts: AnnualAccounts }) {
  const { coherence } = accounts;
  const checks: Array<{ ok: boolean; label: string }> = [
    { ok: coherence.balanceBalanced, label: "Activo = patrimonio neto + pasivo" },
    { ok: coherence.resultMatches, label: "Resultado del balance = resultado de la cuenta de pérdidas y ganancias" },
    { ok: coherence.ecpnReconciled, label: "Estado de cambios en el patrimonio neto conciliado" }
  ];
  const warnings = [...accounts.balance.warnings, ...accounts.pyg.warnings, ...accounts.ecpn.warnings, ...accounts.memoria.warnings];
  return (
    <div className="cocoa-stack" data-gap="2">
      <CocoaCallout tone={coherence.ok ? "success" : "danger"} variant="banner" title={coherence.ok ? "Las cuentas son coherentes" : "Las cuentas no cuadran: revisa el libro antes de formular"} role="status">
        <span className="cocoa-cluster">
          {checks.map((check) => (
            <CocoaBadge key={check.label} tone={check.ok ? "success" : "danger"} variant="dot">
              {check.label}
            </CocoaBadge>
          ))}
        </span>
      </CocoaCallout>
      {warnings.length > 0 ? (
        <CocoaCallout tone="warning" title={plural(warnings.length, "aviso del libro", "avisos del libro")}>
          <ul className="c22-section__list">
            {warnings.map((warning, index) => (
              <li key={index}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}
    </div>
  );
}

function SummaryView({ accounts }: { accounts: AnnualAccounts }) {
  const { balance, pyg, ecpn, memoria } = accounts;
  const netResult = Number(pyg.netResult);
  const requiresInput = memoria.notes.filter((note) => note.status === "requires_input");
  const autoNotes = memoria.notes.length - requiresInput.length;
  const resultBars: CocoaBarsDatum[] = [
    { label: "Explotación", value: Number(pyg.operatingResult), hint: "A) Resultado de explotación" },
    { label: "Financiero", value: Number(pyg.financialResult), hint: "B) Resultado financiero" },
    { label: "Impuesto", value: -Number(pyg.incomeTax), hint: "18. Impuesto sobre beneficios" },
    { label: "Ejercicio", value: netResult, hint: "D) Resultado del ejercicio" }
  ];

  return (
    <>
      <CoherenceCallout accounts={accounts} />

      <CocoaKpiStrip stagger aria-label="Cifras del ejercicio">
        <CocoaKpi label="Total activo" value={money(balance.totalAssets)} deltaLabel={`a ${date(balance.asOf, "short")}`} polarity="neutral" />
        <CocoaKpi label="Patrimonio neto" value={money(balance.equity.total)} polarity="positive-good" status={Number(balance.equity.total) < 0 ? "critical" : "ok"} />
        <CocoaKpi label="Pasivo" value={money(balance.liabilities.total)} deltaLabel={`${money(balance.liabilities.totalCurrent)} a corto plazo`} polarity="neutral" />
        <CocoaKpi label="Resultado del ejercicio" value={money(pyg.netResult)} polarity="positive-good" status={netResult < 0 ? "warning" : "ok"} />
        <CocoaKpi label="Ingresos" value={money(pyg.revenueTotal)} deltaLabel="grupo 7" polarity="neutral" />
        <CocoaKpi label="Gastos" value={money(pyg.expenseTotal)} deltaLabel="grupo 6" polarity="neutral" />
      </CocoaKpiStrip>

      <CocoaGrid aria-label="Balance y resultado resumidos" align="start">
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Balance resumido" meta={balance.balanced ? <CocoaBadge tone="success">cuadrado</CocoaBadge> : <CocoaBadge tone="danger">descuadrado</CocoaBadge>}>
            <ul className="c22-section__list">
              <li>
                <span>Activo no corriente</span>
                <strong>{money(balance.assets.totalNonCurrent)}</strong>
              </li>
              <li>
                <span>Activo corriente</span>
                <strong>{money(balance.assets.totalCurrent)}</strong>
              </li>
              <li>
                <span>Total activo</span>
                <strong>{money(balance.totalAssets)}</strong>
              </li>
              <li>
                <span>Patrimonio neto</span>
                <strong>{money(balance.equity.total)}</strong>
              </li>
              <li>
                <span>Pasivo no corriente</span>
                <strong>{money(balance.liabilities.totalNonCurrent)}</strong>
              </li>
              <li>
                <span>Pasivo corriente</span>
                <strong>{money(balance.liabilities.totalCurrent)}</strong>
              </li>
              <li>
                <span>Total patrimonio neto y pasivo</span>
                <strong>{money(balance.totalEquityAndLiabilities)}</strong>
              </li>
            </ul>
            {Number(balance.priorUnregularisedResult) !== 0 ? (
              <CocoaCallout tone="warning" title="Resultados anteriores sin regularizar">
                {money(balance.priorUnregularisedResult)} de ingresos y gastos de periodos anteriores no se han regularizado: aparecen en su propia línea del patrimonio neto.
              </CocoaCallout>
            ) : null}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Resultado" meta="modelo Pymes">
            <ul className="c22-section__list">
              <li>
                <span>A) Explotación</span>
                <strong>{money(pyg.operatingResult)}</strong>
              </li>
              <li>
                <span>B) Financiero</span>
                <strong>{money(pyg.financialResult)}</strong>
              </li>
              <li>
                <span>C) Antes de impuestos</span>
                <strong>{money(pyg.resultBeforeTax)}</strong>
              </li>
              <li>
                <span>Impuesto sobre beneficios</span>
                <strong>{money(pyg.incomeTax)}</strong>
              </li>
              <li>
                <span>D) Resultado del ejercicio</span>
                <strong>{money(pyg.netResult)}</strong>
              </li>
            </ul>
            <CocoaChart.Bars data={resultBars} height={120} valueFormat={(value) => money(value, { decimals: "auto" })} aria-label="Composición del resultado del ejercicio" />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Memoria" meta={plural(memoria.notes.length, "nota", "notas")}>
            <div className="cocoa-row" data-gap="4">
              <CocoaStat label="Automáticas" value={number(autoNotes)} hint="Redactadas desde el libro" />
              <CocoaStat label="Requieren tu aportación" value={number(requiresInput.length)} tone={requiresInput.length > 0 ? "warning" : "success"} hint="Datos que el libro no conoce" />
            </div>
            {requiresInput.length > 0 ? (
              <ul className="c22-section__list">
                {requiresInput.map((note) => (
                  <li key={note.number}>
                    <span>
                      {note.number}. {note.title}
                    </span>
                    <CocoaBadge tone="warning">pendiente</CocoaBadge>
                  </li>
                ))}
              </ul>
            ) : (
              <CocoaState kind="empty" inline title="Todas las notas se han redactado desde el libro." />
            )}
            <ul className="c22-section__list">
              <li>
                <span>Patrimonio neto conciliado</span>
                <CocoaBadge tone={ecpn.reconciled ? "success" : "danger"}>{ecpn.reconciled ? STATUS_LABELS.yes : STATUS_LABELS.no}</CocoaBadge>
              </li>
              <li>
                <span>Entidad</span>
                <strong>{memoria.entity.legalName ?? memoria.entity.name}</strong>
              </li>
            </ul>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </>
  );
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

function BalanceView({ balance, comparative, onOpen }: { balance: PgcBalanceSheet; comparative: boolean; onOpen: (row: StatementRow) => void }) {
  const rows = useMemo(() => balanceRows(balance), [balance]);
  const columns = useMemo(() => statementColumns(comparative, "Periodo anterior"), [comparative]);
  return (
    <>
      <CocoaCallout tone={balance.balanced ? "success" : "danger"} variant="banner" title={balance.balanced ? `Balance cuadrado a ${date(balance.asOf, "short")}` : `Balance descuadrado a ${date(balance.asOf, "short")}`} role="status">
        Activo {money(balance.totalAssets)} · patrimonio neto y pasivo {money(balance.totalEquityAndLiabilities)} · resultado del periodo {money(balance.periodResult)}. Los activos se presentan en saldo deudor (las amortizaciones y deterioros restan dentro de su partida); el patrimonio neto y el pasivo en saldo acreedor.
      </CocoaCallout>
      {balance.warnings.length > 0 ? (
        <CocoaCallout tone="warning" title={plural(balance.warnings.length, "aviso", "avisos")}>
          <ul className="c22-section__list">
            {balance.warnings.map((warning, index) => (
              <li key={index}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}
      <CocoaGrid aria-label="Balance de situación" align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Activo" meta={money(balance.totalAssets)} footer="Pulsa una partida para ver las cuentas que la componen.">
            <CocoaTable columns={columns} rows={rows.assets} rowKey="id" onSelect={onOpen} caption="Activo" aria-label="Activo" density="compact" />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Patrimonio neto y pasivo" meta={money(balance.totalEquityAndLiabilities)} footer="Los importes entre paréntesis del modelo (acciones propias, dividendo a cuenta) se muestran con su signo.">
            <CocoaTable columns={columns} rows={rows.equityAndLiabilities} rowKey="id" onSelect={onOpen} caption="Patrimonio neto y pasivo" aria-label="Patrimonio neto y pasivo" density="compact" />
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pérdidas y ganancias
// ---------------------------------------------------------------------------

function ProfitAndLossView({ pyg, comparative, onOpen }: { pyg: PgcProfitAndLoss; comparative: boolean; onOpen: (row: StatementRow) => void }) {
  const rows = useMemo(() => pygRows(pyg), [pyg]);
  const columns = useMemo(() => statementColumns(comparative, "Periodo anterior"), [comparative]);
  const bars: CocoaBarsDatum[] = pyg.lines
    .filter((line) => Number(line.amount) !== 0)
    .map((line) => ({ label: line.label.split(".")[0] ?? line.id, value: Number(line.amount), hint: line.label }));
  return (
    <>
      <CocoaKpiStrip aria-label="Resultados">
        <CocoaKpi label="Cifra de negocios y otros ingresos" value={money(pyg.revenueTotal)} deltaLabel="Σ grupo 7" polarity="neutral" />
        <CocoaKpi label="Gastos" value={money(pyg.expenseTotal)} deltaLabel="Σ grupo 6" polarity="neutral" />
        <CocoaKpi label="Resultado de explotación" value={money(pyg.operatingResult)} polarity="positive-good" status={Number(pyg.operatingResult) < 0 ? "warning" : "ok"} />
        <CocoaKpi label="Resultado del ejercicio" value={money(pyg.netResult)} polarity="positive-good" status={Number(pyg.netResult) < 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>
      {pyg.warnings.length > 0 ? (
        <CocoaCallout tone="warning" title={plural(pyg.warnings.length, "aviso", "avisos")}>
          <ul className="c22-section__list">
            {pyg.warnings.map((warning, index) => (
              <li key={index}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}
      <CocoaGrid aria-label="Cuenta de pérdidas y ganancias" align="start">
        <CocoaSpan cols={8} min={480}>
          <CocoaSection title="Cuenta de pérdidas y ganancias" meta="ingresos en positivo · gastos en negativo" footer="Cada subtotal es la suma de sus partidas. Pulsa una partida para ver sus cuentas.">
            <CocoaTable columns={columns} rows={rows} rowKey="id" onSelect={onOpen} caption="Cuenta de pérdidas y ganancias" aria-label="Cuenta de pérdidas y ganancias" density="compact" />
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Partidas con importe" meta={plural(bars.length, "partida", "partidas")}>
            {bars.length > 0 ? (
              <CocoaChart.Bars data={bars} height={160} valueFormat={(value) => money(value, { decimals: "auto" })} aria-label="Partidas de la cuenta de pérdidas y ganancias con importe" />
            ) : (
              <CocoaState kind="empty" inline title="Sin movimientos de ingresos ni gastos en el periodo." />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </>
  );
}

// ---------------------------------------------------------------------------
// Estado de cambios en el patrimonio neto
// ---------------------------------------------------------------------------

function EquityChangesView({ accounts }: { accounts: AnnualAccounts }) {
  const { ecpn } = accounts;
  const columns = useMemo<CocoaTableColumn<EcpnRow>[]>(
    () => [
      { key: "label", label: "Concepto", render: (row) => (row.level === 0 ? <strong>{row.label}</strong> : <span>{row.label}</span>) },
      ...ecpn.columns.map<CocoaTableColumn<EcpnRow>>((column) => ({
        key: column.key,
        label: column.label,
        align: "right",
        hideOnNarrow: column.key !== "total" && column.key !== "periodResult",
        render: (row) => (row.level === 0 ? <strong className="cocoa-tabular">{money(row.values[column.key])}</strong> : <span className="cocoa-tabular">{money(row.values[column.key])}</span>)
      }))
    ],
    [ecpn.columns]
  );
  const recognised = ecpn.recognisedIncomeAndExpense;
  return (
    <>
      <CocoaCallout tone={ecpn.reconciled ? "success" : "danger"} variant="banner" title={ecpn.reconciled ? "Estado conciliado con el libro" : "El estado no concilia con el libro"} role="status">
        Saldo final = saldo inicial + movimientos en cada columna. Los ajustes por cambios de criterio y errores no se derivan del libro: la fila aparece a cero para que la cumplimentes.
      </CocoaCallout>
      {ecpn.warnings.length > 0 ? (
        <CocoaCallout tone="warning" title={plural(ecpn.warnings.length, "aviso", "avisos")}>
          <ul className="c22-section__list">
            {ecpn.warnings.map((warning, index) => (
              <li key={index}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}
      <CocoaGrid aria-label="Estado de cambios en el patrimonio neto" align="start">
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="A) Ingresos y gastos reconocidos" meta={money(recognised.total)}>
            <ul className="c22-section__list">
              <li>
                <span>Resultado de la cuenta de pérdidas y ganancias</span>
                <strong>{money(recognised.periodResult)}</strong>
              </li>
              {recognised.directlyToEquity.map((line) => (
                <li key={line.id}>
                  <span>{line.label}</span>
                  <strong>{money(line.amount)}</strong>
                </li>
              ))}
              {recognised.transfersToPnl.map((line) => (
                <li key={line.id}>
                  <span>{line.label}</span>
                  <strong>{money(line.amount)}</strong>
                </li>
              ))}
              <li>
                <strong>Total de ingresos y gastos reconocidos</strong>
                <strong>{money(recognised.total)}</strong>
              </li>
            </ul>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={8} min={480}>
          <CocoaSection title="B) Estado total de cambios en el patrimonio neto" meta={dateRange(ecpn.period.from, ecpn.period.to)} footer="En pantallas estrechas se muestran las columnas de resultado y total; descarga la hoja de cálculo para el cuadro completo.">
            <CocoaTable columns={columns} rows={ecpn.rows} rowKey="id" caption="Estado total de cambios en el patrimonio neto" aria-label="Estado total de cambios en el patrimonio neto" density="compact" />
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </>
  );
}

// ---------------------------------------------------------------------------
// Memoria
// ---------------------------------------------------------------------------

function MemoriaView({ accounts, organizationId }: { accounts: AnnualAccounts; organizationId: string }) {
  const { memoria } = accounts;
  const draftKey = memoriaDraftKey(organizationId, accounts.period);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readDrafts(draftKey));
  const [figuresOf, setFiguresOf] = useState<MemoriaNote | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);

  useEffect(() => {
    setDrafts(readDrafts(draftKey));
  }, [draftKey]);

  function updateDraft(note: MemoriaNote, text: string) {
    const next = { ...drafts, [String(note.number)]: text };
    if (!text.trim()) delete next[String(note.number)];
    setDrafts(next);
    if (!writeDrafts(draftKey, next)) setStorageFailed(true);
  }

  const pending = memoria.notes.filter((note) => note.status === "requires_input");
  const drafted = pending.filter((note) => (drafts[String(note.number)] ?? "").trim().length > 0);

  return (
    <>
      <CocoaSection title={memoria.entity.legalName ?? memoria.entity.name} meta={memoria.entity.taxId ? `NIF ${memoria.entity.taxId}` : undefined}>
        <ul className="c22-section__list">
          {memoria.entity.properties.map((property) => (
            <li key={property.id}>
              <span>{property.name}</span>
              <span>{property.address ?? "—"}</span>
            </li>
          ))}
        </ul>
      </CocoaSection>

      <CocoaCallout tone={pending.length > 0 ? "warning" : "success"} title={pending.length > 0 ? `${plural(pending.length, "nota requiere", "notas requieren")} tu aportación` : "Todas las notas se han redactado desde el libro"}>
        {pending.length > 0
          ? `La memoria nunca inventa datos: lo que el libro no conoce (actividad, aplicación del resultado, partes vinculadas, plantilla media, periodo medio de pago, hechos posteriores) se marca y lo redactas tú. Tu redacción se guarda como borrador solo en este navegador (${drafted.length} de ${pending.length} con texto); el documento descargado lleva el texto generado desde el libro.`
          : "El documento descargado contiene las notas tal y como se han generado."}
      </CocoaCallout>
      {storageFailed ? <CocoaCallout tone="warning" title="No se pudo guardar el borrador en este navegador">El texto sigue en pantalla mientras no la recargues; cópialo a tu documento.</CocoaCallout> : null}
      {memoria.warnings.length > 0 ? (
        <CocoaCallout tone="warning" title={plural(memoria.warnings.length, "aviso", "avisos")}>
          <ul className="c22-section__list">
            {memoria.warnings.map((warning, index) => (
              <li key={index}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}

      {memoria.notes.map((note) => {
        const requiresInput = note.status === "requires_input";
        const hasFigures = typeof note.figures === "object" && note.figures !== null && Object.keys(note.figures).length > 0;
        return (
          <CocoaSection
            key={note.number}
            title={`${note.number}. ${note.title}`}
            meta={requiresInput ? <CocoaBadge tone="warning">requiere tu aportación</CocoaBadge> : <CocoaBadge tone="success">automática</CocoaBadge>}
            action={
              hasFigures ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setFiguresOf(note)}>
                  Ver cifras
                </CocoaButton>
              ) : undefined
            }
          >
            <p>{note.text}</p>
            {requiresInput ? (
              <CocoaField label="Tu redacción" help="Borrador guardado solo en este navegador; incorpóralo al documento final de la memoria.">
                <CocoaInput value={drafts[String(note.number)] ?? ""} onChange={(text) => updateDraft(note, text)} multiline rows={4} placeholder="Escribe aquí el texto de la nota…" />
              </CocoaField>
            ) : null}
          </CocoaSection>
        );
      })}

      <CocoaDrawer open={figuresOf !== null} onClose={() => setFiguresOf(null)} title={figuresOf ? `Cifras de la nota ${figuresOf.number}` : "Cifras"} subtitle={figuresOf?.title} size="md">
        {figuresOf ? <FigureValue value={figuresOf.figures} /> : null}
      </CocoaDrawer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Instantáneas
// ---------------------------------------------------------------------------

interface SnapshotsViewProps {
  rows: FinancialStatementSnapshotRow[];
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  input: AnnualAccountsQueryInput;
  periodLabel: string;
  configurable: boolean;
}

function SnapshotsView({ rows, loading, error, onRefresh, input, periodLabel, configurable }: SnapshotsViewProps) {
  const { showToast } = useToast();
  const [kind, setKind] = useState<FinancialStatementKindKey>("balance");
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const columns = useMemo<CocoaTableColumn<FinancialStatementSnapshotRow>[]>(
    () => [
      { key: "kind", label: "Estado", render: (row) => <strong>{SNAPSHOT_KIND_LABELS[row.kind] ?? row.kind}</strong> },
      { key: "period", label: "Periodo", render: (row) => <span>{dateRange(row.periodFrom, row.periodTo)}</span> },
      { key: "label", label: "Etiqueta", hideOnNarrow: true, render: (row) => <span>{row.label ?? "—"}</span> },
      { key: "generatedAt", label: "Generada", hideOnNarrow: true, render: (row) => <span>{dateTime(row.generatedAt)}</span> }
    ],
    []
  );

  async function download(row: FinancialStatementSnapshotRow, format: SnapshotFormat) {
    const key = `${row.id}:${format}`;
    setDownloading(key);
    try {
      saveDownload(await downloadSnapshot(row.id, format));
    } catch (err) {
      showToast(errorText(err, "No se pudo descargar la instantánea."), { variant: "error" });
    } finally {
      setDownloading(null);
    }
  }

  async function create() {
    setCreating(true);
    try {
      const created = await createSnapshot({
        kind,
        fiscalYearId: input.fiscalYearId,
        from: input.fiscalYearId ? undefined : input.from,
        to: input.fiscalYearId ? undefined : input.to,
        propertyId: input.propertyId,
        label: label.trim() || undefined
      });
      showToast(`Instantánea guardada: ${SNAPSHOT_KIND_LABELS[created.kind]} · ${dateRange(created.periodFrom, created.periodTo)}`, { variant: "success" });
      setLabel("");
      setConfirming(false);
      onRefresh();
    } catch (err) {
      showToast(errorText(err, "No se pudo guardar la instantánea."), { variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  const copy = confirmAction(
    `¿Guardar una instantánea de «${SNAPSHOT_KIND_LABELS[kind]}»?`,
    "Guardar instantánea",
    `Se congela el estado tal y como se genera hoy para el periodo ${periodLabel}. Las descargas posteriores de esta instantánea se renderizan desde lo guardado, nunca se recalculan.`
  );
  const errorMessage = error ? errorText(error, "No se pudieron cargar las instantáneas.") : null;

  return (
    <>
      <CocoaGrid aria-label="Instantáneas de los estados" align="start">
        <CocoaSpan cols={8} min={480}>
          <CocoaSection title="Instantáneas guardadas" meta={rows.length > 0 ? plural(rows.length, "instantánea", "instantáneas") : undefined} footer="Cada descarga se genera desde el estado congelado; los importes no cambian aunque el libro siga moviéndose.">
            {errorMessage ? (
              <CocoaState kind="error" title={STATUS_LABELS.loadError} message={errorMessage} onRetry={onRefresh} />
            ) : loading && rows.length === 0 ? (
              <CocoaTable columns={columns} rows={[]} loading aria-label="Instantáneas" />
            ) : rows.length === 0 ? (
              <CocoaState kind="empty" title="Sin instantáneas" message="Guarda un estado para conservarlo tal y como se formuló." />
            ) : (
              <CocoaTable
                columns={columns}
                rows={rows}
                rowKey="id"
                caption="Instantáneas"
                aria-label="Instantáneas"
                density="compact"
                rowActions={(row) => (
                  <span className="cocoa-cluster">
                    {DOWNLOAD_FORMATS.map((format) => (
                      <CocoaButton
                        key={format}
                        variant="plain"
                        tone="accent"
                        size="small"
                        loading={downloading === `${row.id}:${format}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void download(row, format);
                        }}
                      >
                        {FORMAT_LABELS[format]}
                      </CocoaButton>
                    ))}
                  </span>
                )}
              />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Nueva instantánea" meta={periodLabel} footer={configurable ? "Se guarda con el ejercicio, las fechas y la propiedad seleccionados arriba." : "Necesitas el permiso de configuración contable para guardar instantáneas."}>
            <CocoaField label="Estado">
              <CocoaSelect value={kind} onChange={(value) => setKind(value as FinancialStatementKindKey)} options={(Object.keys(SNAPSHOT_KIND_LABELS) as FinancialStatementKindKey[]).map((key) => ({ value: key, label: SNAPSHOT_KIND_LABELS[key] }))} />
            </CocoaField>
            <CocoaField label="Etiqueta" help="Opcional, hasta 120 caracteres («Formuladas por el consejo»).">
              <CocoaInput value={label} onChange={setLabel} maxLength={120} placeholder="Formulación, borrador, auditoría…" />
            </CocoaField>
            <div className="cocoa-row" data-justify="end">
              <CocoaButton variant="filled" tone="accent" disabled={!configurable} onClick={() => setConfirming(true)}>
                Guardar instantánea
              </CocoaButton>
            </div>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
      <CocoaDialog open={confirming} onClose={() => setConfirming(false)} title={copy.title} description={copy.message} confirmLabel={copy.confirmLabel} cancelLabel={copy.cancelLabel} onConfirm={create} busy={creating} />
    </>
  );
}

export default AnnualAccountsScreen;
