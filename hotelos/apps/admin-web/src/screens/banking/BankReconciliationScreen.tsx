// Conciliación bancaria — Finanzas › Conciliación bancaria (/finanzas/conciliacion,
// base tab of ConciliacionTabs).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «Workspace»): the bank accounts are
// the list (CocoaSection scroll="y" in a 4-column span; a CocoaSelect below
// 900 px) and the selected account is the detail: KPI strip (diferencia
// extracto − libro · saldo del libro · saldo del extracto · conciliado),
// «Importar extracto» (CSV or Cuaderno 43, persisted, duplicates reported) and
// the statement lines in a CocoaTable. A line opens a CocoaDrawer with the
// API's suggestions (cobros, liquidaciones de datáfono, facturas recibidas,
// nóminas, comisiones) and a manual form; matches with accounting effect
// (bank_fee · bank_interest · card_settlement) say so; «Deshacer» goes through
// a dialog because it reverses the entry the match posted.
// «Nueva cuenta bancaria» lives in the page actions row at every tier
// (qa#11): the list's head keeps only title + meta. The 4-column span measures
// 362 px at 1024 (promoted to 6/12) and 296 px at 1200 (264 px inside), and
// `.c22-section__title` is nowrap/ellipsis next to a shrink-0 action above
// 600 px, so title (133 px) + «N cuentas» + the button (192 px) painted
// «Cuentas banca…». The empty state keeps its own primary action.
// Data: legacy GET /banking/accounts · /banking/accounts/:id/statements ·
// /banking/accounts/:id/reconciliation-status · /banking/statements/:id
// (banking.read) plus the Tanda 6 treasury routes for every write
// (services/treasuryApi.ts, banking.reconcile). Hosted: the container paints
// eyebrow and title.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { BankLineSuggestion, MatchConfidence, ReconcileTargetType } from "@hotelos/shared";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import {
  autoReconcileStatement,
  getBankLineSuggestions,
  importBankStatement,
  reconcileBankLine,
  treasuryErrorMessage,
  unreconcileBankLine,
  type AutoReconcileResult,
  type BankLineSuggestions,
  type Csb43ImportResult
} from "../../services/treasuryApi";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import { date, dateRange, dateTime, money, number, percent, plural, toNumber, type CurrencyInput } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  toneInk,
  useViewportTier,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// ---- Types matching the legacy banking routes ----

type BankAccountRow = {
  id: string;
  propertyId: string;
  organizationId: string;
  name: string;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  currencyCode: string;
  ledgerAccountCode: string | null;
  effectiveLedgerAccountCode?: string;
  openingBalance: number;
  active: boolean;
  statementClosing: number | null;
  ledgerBalance: number;
  drift: number;
  latestStatementId: string | null;
  latestStatementPeriodEnd: string | null;
};

type StatementMatch = {
  id: string;
  matchType: string;
  matchedEntityId: string;
  amount: number;
  matchedAt: string;
  confidence: string | null;
  notes: string | null;
  journalEntryId?: string | null;
};

type StatementLine = {
  id: string;
  statementId: string;
  bankAccountId: string;
  txDate: string;
  valueDate: string | null;
  amount: number;
  currencyCode: string;
  description: string | null;
  reference: string | null;
  counterparty: string | null;
  matchedTo: string | null;
  match: StatementMatch | null;
};

type StatementSummary = {
  id: string;
  bankAccountId: string;
  propertyId: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  source: string | null;
  status: string;
  importedAt: string;
  lineCount?: number;
  matchedCount?: number;
};

type Statement = StatementSummary & { lines: StatementLine[] };

type ReconciliationStatus = { bankAccountId: string; totalLines: number; matched: number; unmatched: number; percentage: number; unmatchedAmount?: number };

type ImportFormat = "csv" | "csb43";

const MATCH_TYPE_LABEL: Record<ReconcileTargetType, string> = {
  payment: "Cobro del hotel",
  card_settlement: "Liquidación de datáfono",
  supplier_bill: "Factura recibida",
  payroll_period: "Nómina",
  commission_accrual: "Comisión de canal",
  bank_fee: "Comisión bancaria",
  bank_interest: "Intereses bancarios",
  manual: "Manual"
};

const MATCH_TYPES: ReconcileTargetType[] = ["payment", "card_settlement", "supplier_bill", "payroll_period", "commission_accrual", "bank_fee", "bank_interest", "manual"];
/** Types that create their own journal entry when matched (626 / 769 against the bank, the acquirer fee). */
const POSTING_TYPES = new Set<ReconcileTargetType>(["bank_fee", "bank_interest", "card_settlement"]);
/** Types that need the id of the document they settle. */
const ENTITY_TYPES = new Set<ReconcileTargetType>(["payment", "card_settlement", "supplier_bill", "payroll_period", "commission_accrual"]);

const CONFIDENCE_LABEL: Record<MatchConfidence, string> = { high: "alta", medium: "media", low: "baja" };
const CONFIDENCE_TONE: Record<MatchConfidence, CocoaTone> = { high: "success", medium: "warning", low: "neutral" };

const STATEMENT_STATUS_LABEL: Record<string, string> = { imported: "Importado", reconciled: "Conciliado", partial: "Parcial", open: "Abierto" };

/** Header the CSV importer expects (kept out of the JSX text on purpose). */
const CSV_HEADER = "date,amount,description,reference,counterparty";
const DEFAULT_LEDGER_CODE = "572";

function matchTypeLabel(type: string): string {
  return MATCH_TYPE_LABEL[type as ReconcileTargetType] ?? type;
}

function confidenceLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return CONFIDENCE_LABEL[value as MatchConfidence] ?? value;
}

function driftTone(drift: number): CocoaTone {
  const abs = Math.abs(drift);
  if (abs < 0.01) return "success";
  if (abs < 10) return "warning";
  return "danger";
}

function isCsb43Result(result: unknown): result is Csb43ImportResult {
  return typeof result === "object" && result !== null && Array.isArray((result as Csb43ImportResult).accounts);
}

// Text styles (tokens only; layout from the utility classes).
const captionStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };
const leftAlignedStyle: CSSProperties = { justifyContent: "flex-start", width: "100%" };

/** Small toned amount (≤ 13 px): AA ink of its sign. */
function amountStyle(value: number): CSSProperties {
  const tone: CocoaTone = Math.abs(value) < 0.005 ? "neutral" : value < 0 ? "danger" : "success";
  return { color: tone === "neutral" ? "var(--cocoa-label)" : toneInk(tone) };
}

function Amount({ value, currency }: { value: number; currency?: CurrencyInput }) {
  return <strong style={amountStyle(value)}>{money(value, currency)}</strong>;
}

const LINE_COLUMNS: CocoaTableColumn<StatementLine>[] = [
  { key: "txDate", label: "Fecha", render: (l) => date(l.txDate, "short"), width: "11ch" },
  {
    key: "description",
    label: "Concepto",
    render: (l) => (
      <>
        <span>{l.description ?? "—"}</span>
        {l.counterparty || l.reference ? (
          <span style={captionStyle}>
            {l.counterparty ?? ""}
            {l.counterparty && l.reference ? " · " : ""}
            {l.reference ? `ref. ${l.reference}` : ""}
          </span>
        ) : null}
      </>
    )
  },
  { key: "amount", label: "Importe", align: "right", render: (l) => <Amount value={l.amount} currency={l.currencyCode} /> },
  {
    key: "match",
    label: "Conciliación",
    render: (l) =>
      l.match ? (
        <span className="cocoa-cluster">
          <CocoaBadge tone="success" size="small" title={`Conciliado el ${dateTime(l.match.matchedAt)}`}>
            {matchTypeLabel(l.match.matchType)}
          </CocoaBadge>
          {confidenceLabel(l.match.confidence) ? (
            <CocoaBadge tone={CONFIDENCE_TONE[l.match.confidence as MatchConfidence] ?? "neutral"} size="small" variant="tinted">
              confianza {confidenceLabel(l.match.confidence)}
            </CocoaBadge>
          ) : null}
          {l.match.journalEntryId ? <CocoaBadge tone="info" size="small" title="El emparejamiento contabilizó un asiento">con asiento</CocoaBadge> : null}
        </span>
      ) : (
        <CocoaBadge tone="warning" size="small">
          Sin conciliar
        </CocoaBadge>
      )
  }
];

// Mirror skeleton: the 4/8 workspace.
function ReconciliationSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Grid rows={[[4, 8]]} height={420} />
    </div>
  );
}

export function BankReconciliationScreen() {
  const hosted = useTabHost() !== null;
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";

  // ---- accounts ----
  const accountsState = useApiData<BankAccountRow[]>("/banking/accounts", { query: { propertyId } });
  const accounts = useMemo(() => toArray<BankAccountRow>(accountsState.data), [accountsState.data]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) setSelectedAccountId(accounts[0].id);
  }, [accounts, selectedAccountId]);
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;

  // ---- statements of the selected account ----
  const statementsState = useApiData<StatementSummary[]>(selectedAccountId ? `/banking/accounts/${encodeURIComponent(selectedAccountId)}/statements` : null);
  const statements = useMemo(() => toArray<StatementSummary>(statementsState.data), [statementsState.data]);
  const statusState = useApiData<ReconciliationStatus>(selectedAccountId ? `/banking/accounts/${encodeURIComponent(selectedAccountId)}/reconciliation-status` : null);
  const [selectedStatementId, setSelectedStatementId] = useState<string | null>(null);
  useEffect(() => {
    // Statements arrive newest first: default to the latest of the selected account.
    if (statements.length === 0) {
      setSelectedStatementId(null);
      return;
    }
    if (!selectedStatementId || !statements.some((s) => s.id === selectedStatementId)) setSelectedStatementId(statements[0].id);
  }, [statements, selectedStatementId]);
  const statementState = useApiData<Statement>(selectedStatementId ? `/banking/statements/${encodeURIComponent(selectedStatementId)}` : null);
  const statement = statementState.data;
  const lines = toArray<StatementLine>(statement?.lines);

  const refreshAccount = () => {
    accountsState.refresh();
    statementsState.refresh();
    statusState.refresh();
    statementState.refresh();
  };

  // ---- new account (drawer, legacy POST /banking/accounts) ----
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [bankName, setBankName] = useState("");
  const [iban, setIban] = useState("");
  const [ledgerCode, setLedgerCode] = useState(DEFAULT_LEDGER_CODE);
  const [openingBalance, setOpeningBalance] = useState("0");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const openingValue = toNumber(openingBalance);
  const accountValid = accountName.trim() !== "" && openingValue !== null;

  async function saveAccount() {
    if (!accountValid || accountSaving) return;
    setAccountSaving(true);
    setAccountError(null);
    try {
      const created = await apiRequest<BankAccountRow>("/banking/accounts", {
        method: "POST",
        body: {
          propertyId,
          name: accountName.trim(),
          bankName: bankName.trim() || undefined,
          iban: iban.replace(/\s+/g, "").toUpperCase() || undefined,
          ledgerAccountCode: ledgerCode.trim() || undefined,
          openingBalance: openingValue ?? 0
        }
      });
      showToast("Cuenta bancaria creada", { variant: "success" });
      setAccountOpen(false);
      setAccountName("");
      setBankName("");
      setIban("");
      setLedgerCode(DEFAULT_LEDGER_CODE);
      setOpeningBalance("0");
      accountsState.refresh();
      if (created?.id) setSelectedAccountId(created.id);
    } catch (err) {
      setAccountError(treasuryErrorMessage(err, "No se pudo crear la cuenta bancaria."));
    } finally {
      setAccountSaving(false);
    }
  }

  // ---- import (POST /treasury/bank-accounts/:id/statements/import) ----
  const [importFormat, setImportFormat] = useState<ImportFormat>("csv");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [autoMatch, setAutoMatch] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<{ tone: CocoaTone; title: string; details: string[] } | null>(null);

  async function handleFile(file: File) {
    setContent(await file.text());
    setFileName(file.name);
  }

  async function runImport() {
    if (!selectedAccountId || content.trim() === "" || importing) return;
    setImporting(true);
    setImportError(null);
    setImportSummary(null);
    try {
      const result = await importBankStatement(selectedAccountId, { format: importFormat, content, ...(importFormat === "csb43" ? { autoMatch } : {}) });
      const details: string[] = [];
      let tone: CocoaTone = "success";
      let title = "Extracto importado";
      if (isCsb43Result(result)) {
        for (const account of result.accounts) {
          details.push(
            `Cuenta …${account.accountNumber.slice(-4)} (${dateRange(account.fromDate, account.toDate)}): ${plural(account.newLines, "movimiento nuevo", "movimientos nuevos")}, ${plural(account.duplicateLines, "duplicado omitido", "duplicados omitidos")}, ${plural(account.matches.length, "coincidencia sugerida", "coincidencias sugeridas")}${account.persisted ? "" : " · no se guardó"}.`
          );
          for (const warning of account.warnings) details.push(warning);
          if (!account.persisted) tone = "warning";
        }
        for (const warning of result.warnings) details.push(warning);
        if (result.accounts.every((a) => a.newLines === 0)) {
          tone = "warning";
          title = "Nada nuevo que importar";
        }
        const persisted = result.accounts.find((a) => a.persisted && a.statementId);
        if (persisted?.statementId) setSelectedStatementId(persisted.statementId);
      } else {
        const counters = result.import;
        details.push(`${plural(counters.newLines, "movimiento nuevo", "movimientos nuevos")}, ${plural(counters.duplicateLines, "duplicado omitido", "duplicados omitidos")}.`);
        for (const warning of counters.warnings) details.push(warning);
        if (!counters.persisted || counters.newLines === 0) {
          tone = "warning";
          title = counters.persisted ? "Nada nuevo que importar" : "El extracto no se guardó";
        }
        if (typeof result.id === "string") setSelectedStatementId(result.id);
      }
      setImportSummary({ tone, title, details });
      setContent("");
      setFileName(null);
      showToast(title, { variant: tone === "success" ? "success" : "warning" });
      refreshAccount();
    } catch (err) {
      setImportError(treasuryErrorMessage(err, "No se pudo importar el extracto."));
    } finally {
      setImporting(false);
    }
  }

  // ---- automatic reconciliation (preview = dryRun) ----
  const [autoResult, setAutoResult] = useState<AutoReconcileResult | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoDialog, setAutoDialog] = useState(false);

  async function runAuto(dryRun: boolean) {
    if (!selectedStatementId) return;
    setAutoBusy(true);
    try {
      const result = await autoReconcileStatement(selectedStatementId, { dryRun });
      setAutoResult(result);
      if (!dryRun) {
        showToast(`${plural(result.matched, "movimiento conciliado", "movimientos conciliados")}`, { variant: "success" });
        refreshAccount();
      }
      setAutoDialog(false);
    } catch (err) {
      showToast(treasuryErrorMessage(err, "No se pudo conciliar automáticamente."), { variant: "error" });
    } finally {
      setAutoBusy(false);
    }
  }

  // ---- match one line (drawer with suggestions + manual form) ----
  const [matchLine, setMatchLine] = useState<StatementLine | null>(null);
  const [suggestions, setSuggestions] = useState<BankLineSuggestions | null>(null);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [manualType, setManualType] = useState<ReconcileTargetType>("payment");
  const [manualEntityId, setManualEntityId] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  function openMatch(line: StatementLine) {
    setMatchLine(line);
    setSuggestions(null);
    setSuggestionsError(null);
    setMatchError(null);
    setManualType(line.amount >= 0 ? "payment" : "supplier_bill");
    setManualEntityId("");
    setManualNotes("");
    setSuggestionsLoading(true);
    getBankLineSuggestions(line.id)
      .then((result) => setSuggestions(result))
      .catch((err: unknown) => setSuggestionsError(treasuryErrorMessage(err, "No se pudieron cargar las sugerencias.")))
      .finally(() => setSuggestionsLoading(false));
  }

  async function reconcileWith(matchType: ReconcileTargetType, matchedEntityId?: string, notes?: string) {
    if (!matchLine || matching) return;
    setMatching(true);
    setMatchError(null);
    try {
      const result = await reconcileBankLine(matchLine.id, { matchType, matchedEntityId, notes });
      showToast(result.journalEntryId ? "Movimiento conciliado y asiento contabilizado" : "Movimiento conciliado", { variant: "success" });
      setMatchLine(null);
      refreshAccount();
    } catch (err) {
      setMatchError(treasuryErrorMessage(err, "No se pudo conciliar el movimiento."));
    } finally {
      setMatching(false);
    }
  }

  const manualNeedsEntity = ENTITY_TYPES.has(manualType);
  const manualNeedsNotes = manualType === "manual";
  const manualValid = (!manualNeedsEntity || manualEntityId.trim() !== "") && (!manualNeedsNotes || manualNotes.trim() !== "");

  // ---- unmatch (dialog: it may reverse the entry the match posted) ----
  const [unmatchTarget, setUnmatchTarget] = useState<StatementLine | null>(null);
  const [unmatching, setUnmatching] = useState(false);

  async function unmatch() {
    if (!unmatchTarget) return;
    setUnmatching(true);
    try {
      const result = await unreconcileBankLine(unmatchTarget.id);
      showToast(result.reversalJournalEntryId ? "Conciliación deshecha; el asiento se anuló" : "Conciliación deshecha", { variant: "success" });
      setUnmatchTarget(null);
      refreshAccount();
    } catch (err) {
      showToast(treasuryErrorMessage(err, "No se pudo deshacer la conciliación."), { variant: "error" });
    } finally {
      setUnmatching(false);
    }
  }

  // ---- derived ----
  const status = statusState.data;
  const newAccountLabel = newLabel("f", "cuenta bancaria");
  const state = !accountsState.data ? (accountsState.loading ? "loading" : "error") : "ready";
  const accountOptions = accounts.map((a) => ({ value: a.id, label: `${a.name}${a.bankName ? ` · ${a.bankName}` : ""}` }));
  const statementOptions = statements.map((s) => ({
    value: s.id,
    label: `${dateRange(s.periodStart, s.periodEnd)} · ${plural(s.lineCount ?? 0, "movimiento", "movimientos")}${s.matchedCount !== undefined && s.lineCount ? ` · ${number(s.matchedCount)} conciliados` : ""}`
  }));
  const unmatchedDetails = toArray<AutoReconcileResult["details"][number]>(autoResult?.details).filter((d) => !d.matched).slice(0, 5);

  const accountList = (
    <CocoaSection
      title="Cuentas bancarias"
      meta={plural(accounts.length, "cuenta", "cuentas")}
      headingLevel={2}
      scroll="y"
      maxHeight={560}
      padding={accounts.length > 0 ? "sm" : "md"}
    >
      {accountsState.error && !accountsState.data ? (
        <CocoaState kind="error" inline title="No se pudieron cargar las cuentas." message={accountsState.error} onRetry={accountsState.refresh} />
      ) : accounts.length === 0 ? (
        <CocoaState kind="empty" dashed title="Sin cuentas bancarias" message="Crea la cuenta del hotel para importar sus extractos y conciliarlos con el libro." primaryAction={{ label: newAccountLabel, onClick: () => setAccountOpen(true) }} />
      ) : (
        <ul className="c22-section__list" aria-label="Cuentas bancarias">
          {accounts.map((account) => {
            const selected = account.id === selectedAccountId;
            return (
              <li key={account.id}>
                <div className="cocoa-stack" data-gap="1" style={growStyle}>
                  <CocoaButton variant={selected ? "tinted" : "plain"} tone={selected ? "accent" : "neutral"} size="small" wrap onClick={() => setSelectedAccountId(account.id)} aria-current={selected ? true : undefined} style={leftAlignedStyle}>
                    {account.name}
                  </CocoaButton>
                  <span style={captionStyle}>
                    {account.bankName ?? "Banco sin indicar"} · {account.iban ?? "sin IBAN"} · cuenta {account.effectiveLedgerAccountCode ?? account.ledgerAccountCode ?? DEFAULT_LEDGER_CODE}
                  </span>
                </div>
                {account.statementClosing === null ? (
                  <CocoaBadge tone="neutral" size="small">sin extractos</CocoaBadge>
                ) : (
                  <CocoaBadge tone={driftTone(account.drift)} size="small" title="Saldo del extracto menos saldo del libro">
                    dif. {money(account.drift, account.currencyCode)}
                  </CocoaBadge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </CocoaSection>
  );

  const detail = !selectedAccount ? (
    <CocoaSection aria-label="Sin cuenta seleccionada">
      <CocoaState kind="empty" title="Elige una cuenta bancaria" message="El último extracto, la diferencia con el libro y la conciliación por movimiento aparecen aquí." illustration="box" />
    </CocoaSection>
  ) : (
    <div className="cocoa-stack" data-gap="4">
      <CocoaKpiStrip min={200} stagger aria-label={`Indicadores de ${selectedAccount.name}`}>
        <CocoaKpi
          label="Diferencia extracto − libro"
          value={money(selectedAccount.drift, selectedAccount.currencyCode)}
          polarity="neutral"
          status={selectedAccount.statementClosing === null ? "ok" : driftTone(selectedAccount.drift) === "success" ? "ok" : driftTone(selectedAccount.drift) === "warning" ? "warning" : "critical"}
          degraded={selectedAccount.statementClosing === null}
        />
        <CocoaKpi label={`Saldo en el libro (${selectedAccount.effectiveLedgerAccountCode ?? selectedAccount.ledgerAccountCode ?? DEFAULT_LEDGER_CODE})`} value={money(selectedAccount.ledgerBalance, selectedAccount.currencyCode)} polarity="neutral" />
        <CocoaKpi
          label="Saldo del extracto"
          value={money(selectedAccount.statementClosing, selectedAccount.currencyCode)}
          polarity="neutral"
          deltaLabel={selectedAccount.latestStatementPeriodEnd ? `a ${date(selectedAccount.latestStatementPeriodEnd, "short")}` : "sin extractos"}
          degraded={selectedAccount.statementClosing === null}
        />
        <CocoaKpi
          label="Conciliado"
          value={percent(status?.percentage, { maximumFractionDigits: 1 })}
          polarity="positive-good"
          status={!status || status.totalLines === 0 ? "ok" : status.percentage >= 95 ? "ok" : status.percentage >= 60 ? "warning" : "critical"}
          deltaLabel={status ? `${number(status.matched)} de ${plural(status.totalLines, "movimiento", "movimientos")}` : undefined}
          degraded={!status}
        />
      </CocoaKpiStrip>

      <CocoaSection title="Importar extracto" meta="CSV o Cuaderno 43 · los duplicados se detectan y no se repiten" headingLevel={2}>
        <CocoaFormRow columns={2}>
          <CocoaField label="Formato" help={importFormat === "csv" ? "Cabecera y fechas en formato ISO o DD/MM/AAAA; coma o punto decimal." : "Fichero AEB Cuaderno 43 (texto fijo de 80 columnas) tal como lo emite el banco."}>
            <CocoaSegmentedControl
              value={importFormat}
              onChange={(value) => setImportFormat(value as ImportFormat)}
              options={[
                { value: "csv", label: "CSV" },
                { value: "csb43", label: "Cuaderno 43" }
              ]}
              aria-label="Formato del extracto"
            />
          </CocoaField>
          {importFormat === "csb43" ? (
            <CocoaField label="Buscar coincidencias al importar" inline help="Sugiere cobros y liquidaciones de datáfono para cada movimiento nuevo.">
              <CocoaSwitch checked={autoMatch} onChange={setAutoMatch} size="small" />
            </CocoaField>
          ) : (
            <CocoaField label="Cabecera esperada" help="Columnas separadas por coma, en este orden.">
              <CocoaInput value={CSV_HEADER} onChange={() => undefined} readOnly aria-label="Cabecera esperada del CSV" />
            </CocoaField>
          )}
          <CocoaField label="Contenido del extracto" fullWidth help="Elige un fichero o pega el texto.">
            <CocoaInput value={content} onChange={setContent} multiline rows={6} placeholder={importFormat === "csv" ? `${CSV_HEADER}\n2026-09-01,1250.00,Transferencia recibida,REF-1001,Viajes Norte SL` : "11…\n22…\n23…"} />
          </CocoaField>
        </CocoaFormRow>
        <div className="cocoa-row" data-gap="2">
          <CocoaFileInput accept=".txt,.csv,.csb,.n43,.dat,text/plain,text/csv" fileName={fileName} onPick={(file) => void handleFile(file)} onReject={(message) => showToast(message, { variant: "error" })} />
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void runImport()} loading={importing} disabled={content.trim() === "" || importing}>
            {ACTIONS.import}
          </CocoaButton>
          {content ? <span style={secondaryStyle}>{plural(content.split(/\r?\n/).filter((line) => line.trim() !== "").length, "línea", "líneas")}</span> : null}
        </div>
        {importError ? (
          <CocoaCallout tone="danger" title="No se pudo importar" role="alert">
            {importError}
          </CocoaCallout>
        ) : null}
        {importSummary ? (
          <CocoaCallout tone={importSummary.tone} title={importSummary.title} role="status">
            <ul className="c22-section__list">
              {importSummary.details.map((line, index) => (
                <li key={index}>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}
      </CocoaSection>

      <CocoaSection
        title="Extracto"
        meta={statement ? `apertura ${money(statement.openingBalance, selectedAccount.currencyCode)} · cierre ${money(statement.closingBalance, selectedAccount.currencyCode)} · ${STATEMENT_STATUS_LABEL[statement.status] ?? statement.status}` : undefined}
        headingLevel={2}
        action={
          statement ? (
            <span className="cocoa-cluster">
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => void runAuto(true)} loading={autoBusy} disabled={autoBusy} title="Muestra qué conciliaría sin guardar nada">
                Vista previa
              </CocoaButton>
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setAutoDialog(true)} disabled={autoBusy}>
                Conciliar automáticamente
              </CocoaButton>
            </span>
          ) : undefined
        }
        padding={statement && lines.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {statements.length > 1 ? (
          <div className="cocoa-row" data-gap="2" style={{ padding: statement && lines.length > 0 ? "var(--cocoa-space-3) var(--cocoa-space-4) 0" : undefined }}>
            <CocoaSelect value={selectedStatementId ?? ""} onChange={setSelectedStatementId} options={statementOptions} size="small" aria-label="Extracto" />
          </div>
        ) : null}
        {autoResult ? (
          <div style={{ padding: statement && lines.length > 0 ? "var(--cocoa-space-3) var(--cocoa-space-4) 0" : undefined }}>
            <CocoaCallout
              tone={autoResult.dryRun ? "info" : autoResult.unmatched === 0 ? "success" : "warning"}
              title={autoResult.dryRun ? "Vista previa: nada se ha guardado" : "Conciliación automática aplicada"}
              role="status"
              actions={
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setAutoResult(null)} aria-label="Ocultar el resultado de la conciliación automática">
                  Ocultar
                </CocoaButton>
              }
            >
              Revisados {number(autoResult.scanned)} · {autoResult.dryRun ? "conciliaría" : "conciliados"} {number(autoResult.matched)} · ya conciliados {number(autoResult.alreadyMatched)} · sin coincidencia segura {number(autoResult.unmatched)}.
              {unmatchedDetails.length > 0 ? (
                <ul className="c22-section__list">
                  {unmatchedDetails.map((detail) => (
                    <li key={detail.bankLineId}>
                      <span>
                        {lines.find((l) => l.id === detail.bankLineId)?.description ?? detail.bankLineId}: {detail.error ?? detail.reason ?? "sin coincidencia con confianza alta"}
                        {detail.suggestions && detail.suggestions.length > 0 ? ` (${plural(detail.suggestions.length, "sugerencia", "sugerencias")})` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CocoaCallout>
          </div>
        ) : null}
        {statementsState.error && !statementsState.data ? (
          <CocoaState kind="error" inline title="No se pudieron cargar los extractos." message={statementsState.error} onRetry={statementsState.refresh} />
        ) : statementsState.loading && !statementsState.data ? (
          <CocoaTable columns={LINE_COLUMNS} rows={[]} loading aria-label="Movimientos del extracto" />
        ) : statements.length === 0 ? (
          <CocoaState kind="empty" title="Aún no hay extractos" message="Importa el primer extracto de esta cuenta con el formulario de arriba." />
        ) : statementState.error && !statement ? (
          <CocoaState kind="error" inline title="No se pudo cargar el extracto." message={statementState.error} onRetry={statementState.refresh} />
        ) : !statement ? (
          <CocoaTable columns={LINE_COLUMNS} rows={[]} loading aria-label="Movimientos del extracto" />
        ) : lines.length === 0 ? (
          <CocoaState kind="empty" inline title="El extracto no tiene movimientos." />
        ) : (
          <CocoaTable
            columns={LINE_COLUMNS}
            rows={lines}
            rowKey="id"
            rowTone={(l) => (l.match ? undefined : "warning")}
            onSelect={(l) => (l.match ? setUnmatchTarget(l) : openMatch(l))}
            rowTitle={(l) => (l.match ? "Deshacer la conciliación" : "Conciliar este movimiento")}
            rowActions={(l) =>
              l.match ? (
                <CocoaButton
                  variant="plain"
                  tone="destructive"
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    setUnmatchTarget(l);
                  }}
                >
                  Deshacer
                </CocoaButton>
              ) : (
                <CocoaButton
                  variant="plain"
                  tone="accent"
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    openMatch(l);
                  }}
                >
                  Conciliar
                </CocoaButton>
              )
            }
            footer={{ description: <strong>{plural(lines.length, "movimiento", "movimientos")}</strong>, amount: <strong>{money(lines.reduce((sum, l) => sum + l.amount, 0), selectedAccount.currencyCode)}</strong>, match: `${number(lines.filter((l) => l.match).length)} conciliados` }}
            caption="Movimientos del extracto"
            aria-label="Movimientos del extracto"
          />
        )}
      </CocoaSection>
    </div>
  );

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${propertyName}`}
      title="Conciliación bancaria"
      subtitle={hosted ? undefined : "Importa los extractos del banco, casa cada movimiento con los cobros, liquidaciones de datáfono, facturas recibidas, nóminas y comisiones, y compara el saldo del banco con la cuenta 572 del libro."}
      actions={
        <>
          {accountsState.loading || statementState.loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAccount}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setAccountOpen(true)}>
            {newAccountLabel}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<ReconciliationSkeleton />}
      error={{ title: "No se pudieron cargar las cuentas bancarias", message: accountsState.error ?? undefined, onRetry: accountsState.refresh }}
      commands={[
        { id: "bank-reconciliation-refresh", label: "Actualizar la conciliación bancaria", run: refreshAccount },
        { id: "bank-reconciliation-new-account", label: newAccountLabel, run: () => setAccountOpen(true) }
      ]}
    >
      {compact ? (
        <>
          {accounts.length > 0 ? (
            <CocoaToolbar variant="content" aria-label="Cuenta bancaria" leftSlot={<CocoaSelect value={selectedAccountId ?? ""} onChange={setSelectedAccountId} options={accountOptions} aria-label="Cuenta bancaria" />} />
          ) : (
            accountList
          )}
          {accounts.length > 0 ? detail : null}
        </>
      ) : (
        <CocoaGrid align="start" aria-label="Cuentas y extracto">
          <CocoaSpan cols={4} min={320}>
            {accountList}
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            {detail}
          </CocoaSpan>
        </CocoaGrid>
      )}

      {/* Nueva cuenta */}
      <CocoaDrawer
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        title={newAccountLabel}
        subtitle="La cuenta del PGC (572 por defecto) es la que se compara con el saldo del extracto."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setAccountOpen(false)} disabled={accountSaving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveAccount()} loading={accountSaving} disabled={!accountValid || accountSaving}>
              {accountSaving ? STATUS_LABELS.saving : "Crear cuenta"}
            </CocoaButton>
          </>
        }
      >
        <CocoaFormSection title="Cuenta bancaria">
          <CocoaFormRow columns={2}>
            <CocoaField label="Nombre" required>
              <CocoaInput value={accountName} onChange={setAccountName} placeholder="Cuenta principal" maxLength={80} autoFocus />
            </CocoaField>
            <CocoaField label="Banco" hint="opcional">
              <CocoaInput value={bankName} onChange={setBankName} placeholder="Nombre de la entidad" maxLength={80} />
            </CocoaField>
            <CocoaField label="IBAN" hint="opcional" help="Sirve para reconocer la cuenta en los ficheros Cuaderno 43 y en las remesas SEPA.">
              <CocoaInput value={iban} onChange={setIban} placeholder="ES00 0000 0000 0000 0000 0000" maxLength={34} />
            </CocoaField>
            <CocoaField label="Cuenta del PGC" help="572 Bancos o una subcuenta 572x.">
              <CocoaInput value={ledgerCode} onChange={setLedgerCode} maxLength={12} />
            </CocoaField>
            <CocoaField label="Saldo inicial (€)" error={openingValue === null ? "Indica un importe válido (0 si la cuenta empieza a cero)." : undefined}>
              <CocoaInput value={openingBalance} onChange={setOpeningBalance} type="number" inputMode="decimal" step="0.01" />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
        {accountError ? (
          <CocoaCallout tone="danger" title="No se pudo crear la cuenta" role="alert">
            {accountError}
          </CocoaCallout>
        ) : null}
      </CocoaDrawer>

      {/* Conciliar un movimiento */}
      <CocoaDrawer
        open={matchLine !== null}
        onClose={() => setMatchLine(null)}
        title="Conciliar movimiento"
        subtitle={matchLine ? `${date(matchLine.txDate, "short")} · ${money(matchLine.amount, matchLine.currencyCode)} · ${matchLine.description ?? "sin concepto"}` : undefined}
        side="right"
        size="md"
        focusKey={suggestions ? suggestions.suggestions.length : -1}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setMatchLine(null)} disabled={matching}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={() => void reconcileWith(manualType, manualNeedsEntity ? manualEntityId.trim() : manualEntityId.trim() || undefined, manualNotes.trim() || undefined)}
              loading={matching}
              disabled={!manualValid || matching}
            >
              Conciliar
            </CocoaButton>
          </>
        }
      >
        <CocoaSection title="Sugerencias" meta={suggestions ? plural(suggestions.suggestions.length, "candidato", "candidatos") : undefined} variant="plain" padding="none">
          {suggestionsLoading ? (
            <div className="cocoa-stack" data-gap="2" aria-hidden="true">
              <CocoaSkeleton variant="row" />
              <CocoaSkeleton variant="row" />
            </div>
          ) : suggestionsError ? (
            <CocoaState kind="error" inline title="No se pudieron cargar las sugerencias." message={suggestionsError} onRetry={() => matchLine && openMatch(matchLine)} />
          ) : !suggestions || suggestions.suggestions.length === 0 ? (
            <CocoaState kind="empty" inline title="Ningún documento coincide por importe y fecha. Concilia a mano más abajo." />
          ) : (
            <ul className="c22-section__list" aria-label="Documentos candidatos">
              {toArray<BankLineSuggestion>(suggestions.suggestions).map((suggestion) => (
                <li key={`${suggestion.kind}-${suggestion.id}`}>
                  <div className="cocoa-stack" data-gap="1" style={growStyle}>
                    <span className="cocoa-cluster">
                      <strong>{suggestion.label}</strong>
                      <CocoaBadge tone={CONFIDENCE_TONE[suggestion.confidence] ?? "neutral"} size="small" variant="tinted">
                        confianza {CONFIDENCE_LABEL[suggestion.confidence] ?? suggestion.confidence}
                      </CocoaBadge>
                    </span>
                    <span style={captionStyle}>
                      {matchTypeLabel(suggestion.kind)} · {date(suggestion.date, "short")} · {suggestion.reason}
                      {suggestion.fee > 0 ? ` · comisión del datáfono ${money(suggestion.fee)}` : ""}
                      {suggestion.paymentIds && suggestion.paymentIds.length > 1 ? ` · ${plural(suggestion.paymentIds.length, "cobro agrupado", "cobros agrupados")}` : ""}
                    </span>
                  </div>
                  <div className="cocoa-stack" data-gap="1">
                    <strong>{money(suggestion.amount)}</strong>
                    <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => void reconcileWith(suggestion.kind, suggestion.id)} disabled={matching}>
                      Usar
                    </CocoaButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CocoaSection>

        <CocoaFormSection title="Conciliación manual" description="Indica con qué documento casa el movimiento. Las comisiones e intereses bancarios contabilizan su propio asiento (626 / 769 contra la cuenta del banco).">
          <CocoaFormRow columns={2}>
            <CocoaField label="Tipo de documento" required>
              <CocoaSelect value={manualType} onChange={(value) => setManualType(value as ReconcileTargetType)} options={MATCH_TYPES.map((type) => ({ value: type, label: MATCH_TYPE_LABEL[type] }))} />
            </CocoaField>
            {manualNeedsEntity ? (
              <CocoaField label="Identificador del documento" required help="Cobro, liquidación, factura recibida, periodo de nómina o devengo de comisión.">
                <CocoaInput value={manualEntityId} onChange={setManualEntityId} placeholder="cm…" maxLength={400} />
              </CocoaField>
            ) : (
              <CocoaField label="Referencia" hint="opcional">
                <CocoaInput value={manualEntityId} onChange={setManualEntityId} placeholder="Referencia libre" maxLength={400} />
              </CocoaField>
            )}
            <CocoaField label="Notas" required={manualNeedsNotes} hint={manualNeedsNotes ? undefined : "opcional"} fullWidth help={manualNeedsNotes ? "Obligatorias en una conciliación manual: explican el emparejamiento." : undefined}>
              <CocoaInput value={manualNotes} onChange={setManualNotes} multiline rows={2} maxLength={500} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
        {POSTING_TYPES.has(manualType) ? (
          <CocoaCallout tone="info" title="Este emparejamiento contabiliza">
            {manualType === "card_settlement" ? "La liquidación del datáfono se asienta por el neto y la comisión del banco (626)." : "El importe del movimiento se asienta en 626 Servicios bancarios o 769 Otros ingresos financieros contra la cuenta del banco."}
          </CocoaCallout>
        ) : null}
        {matchError ? (
          <CocoaCallout tone="danger" title="No se pudo conciliar" role="alert">
            {matchError}
          </CocoaCallout>
        ) : null}
      </CocoaDrawer>

      {/* Conciliar automáticamente (confirmación) */}
      <CocoaDialog
        open={autoDialog}
        onClose={() => setAutoDialog(false)}
        title="Conciliar automáticamente"
        description="Solo se emparejan los movimientos con una coincidencia de confianza alta; las liquidaciones de datáfono contabilizan su comisión. Puedes deshacer cada emparejamiento después."
        confirmLabel="Conciliar"
        cancelLabel={ACTIONS.cancel}
        busy={autoBusy}
        onConfirm={() => runAuto(false)}
      />

      {/* Deshacer conciliación */}
      <CocoaDialog
        open={unmatchTarget !== null}
        onClose={() => setUnmatchTarget(null)}
        tone="destructive"
        title="¿Deshacer la conciliación?"
        description={
          unmatchTarget
            ? `${date(unmatchTarget.txDate, "short")} · ${money(unmatchTarget.amount, unmatchTarget.currencyCode)} · ${matchTypeLabel(unmatchTarget.match?.matchType ?? "")}.${unmatchTarget.match?.journalEntryId ? " El asiento que generó el emparejamiento se anula con un asiento de anulación." : ""}`
            : undefined
        }
        confirmLabel="Deshacer"
        cancelLabel={ACTIONS.cancel}
        busy={unmatching}
        onConfirm={unmatch}
      />

    </CocoaPage>
  );
}

export default BankReconciliationScreen;
