// Finanzas › Contabilidad › Importar desde Sage 200 —
// /finanzas/contabilidad/importar-sage200 (Tanda 7c · L4; design
// docs/design/FINANZAS-IMPORTACION-SAGE200.md §7.4), hosted in ContabilidadTabs,
// born without inline styles (Cocoa 22 contract). Four views on a segmented
// control:
//
//   Importar        a five-step wizard (Fichero · Cuentas · Analítica · Revisión ·
//                   Resultado; plan / terceros / libros skip Analítica, saldos
//                   skips Cuentas when nothing is unmapped):
//                   1 CocoaSelect of the lot kind + CocoaFileInput (.xlsx / .csv /
//                     .txt / .json, ≤ 20 MB; the XML «Datos contables» is not
//                     offered until the API can read it) → the bytes go to the
//                     API as base64 (never `file.text()`: latin1 and binary must
//                     survive) → automatic preview → next step. Note with what
//                     to export in Sage for that kind and the canonical template.
//                   2 one row per Sage account without a map entry: action (map ·
//                     create · collapse · block), destination account (search
//                     over the chart, or a free code for `create`), USALI
//                     department for a `create` in 6 / 7, origin badge; «solo
//                     pendientes» filter; «Guardar mapa» (PUT account-map, only
//                     accounting.configure) and «Aplicar» re-previews with the
//                     choices in `mapping.accounts`.
//                   3 dimension of the centre and of the cost centre, one row per
//                     analytics code → centre (the centres of the ONE finance
//                     scope structure) or USALI cost centre, policy for 6 / 7
//                     lines without analytics, callout with `centreRequired`.
//                   4 KPI strip (asientos · apuntes · Debe · Haber · excluidos ·
//                     ya existentes · avisos), tables per month and per centre,
//                     the native documents excluded (§5.1), warnings for
//                     duplicate / overlaps / payroll lot / VAT settings / native
//                     entries + the «Sustituir los lotes anteriores» switch, the
//                     optional Sage trial balance that reconciles after posting,
//                     «Contabilizar» only when the API says `canPost` and the
//                     session holds accounting.journal.post.
//                   5 status callout, entries created («2026/110 · RA ·
//                     03/09/2026 · Sage 2026/1501 · 302,50 €»), skipped, errors,
//                     the reconciliation result and the per-entry report CSV.
//   Reconciliación  range + the centre of the ONE «Ámbito» selector
//                   (`finance.propertyId`, undefined = consolidado) + the Sage
//                   trial balance → KPI strip, per-account table with a tone per
//                   row (semáforo) and a link to the ledger, history.
//   Lotes           the lots with «Ver» (drawer with the entries), «Contabilizar»
//                   (draft) and «Revertir» (posted; destructive dialog with a
//                   reason of 3..500 characters); «Autor» is a name, never an id.
//   Terceros        (FIX-1 · F11 / E-05) read-only directory of the imported third
//                   parties (GET …/third-parties): search box (code · NIF · Sage
//                   account · name, debounced) + role filter, compact table (Código ·
//                   NIF · Cuenta Sage · Rol · Nombre · Lote) paged by cursor with
//                   «Cargar más»; «Nombre» is «—» for personal accounts (465 / 460 /
//                   555) and names carrying the word EMPLEADO — the API never sends those.
//
// Gates over the real grants (canDo(useNavGate())): read
// accounting.reports.read or accounting.read; import accounting.journal.post;
// maps accounting.configure; reverse accounting.journal.post + ai.high_risk.confirm.
// One CocoaLiveRegion announces the step and the analysis; the step content
// takes focus on every change of step; no aria-live on badges.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChartAccountView,
  LedgerAccountMapDto,
  LedgerAccountMapResponse,
  LedgerAnalyticsDimension,
  LedgerAnalyticsMapDto,
  LedgerAnalyticsMapResponse,
  LedgerAnalyticsMappingInput,
  LedgerImportCreateResult,
  LedgerImportDetail,
  LedgerImportEntryDto,
  LedgerImportFormat,
  LedgerImportKind,
  LedgerImportMappingInput,
  LedgerImportOptions,
  LedgerImportPreview,
  LedgerImportRecord,
  LedgerReconciliationDto,
  LedgerReconciliationRow,
  LedgerThirdPartyDto,
  LedgerThirdPartyPage,
  LedgerUnassignedPolicy
} from "@hotelos/shared";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaLiveRegion,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  openTabPath,
  type CocoaSelectOption,
  type CocoaTableColumn
} from "../../components/cocoa";
import { DownloadIcon } from "../../components/cocoa-icons/ActionIcons";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { useToast } from "../../components/Toast";
import { ACTIONS } from "../../content/actions";
import { useApiData } from "../../hooks/useApiData";
import { EMPTY, date, dateRange, dateTime, money, number, plural } from "../../lib/format";
import { urlForScreen } from "../../navigation/nav-tree";
import { useNavGate } from "../../navigation/useEnabledModules";
import { listChartAccounts } from "../../services/accountingApi";
import { centreNameFor, centreSelectOptions, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import {
  LEDGER_IMPORTS_PATH,
  createLedgerImport,
  downloadLedgerImportTemplate,
  downloadReconciliationCsv,
  getAccountMap,
  getAnalyticsMap,
  getLedgerImport,
  getReconciliation,
  ledgerImportErrorMessage,
  listLedgerThirdParties,
  postLedgerImport,
  previewLedgerImport,
  putAccountMap,
  putAnalyticsMap,
  reconcileLedger,
  reverseLedgerImport
} from "../../services/ledgerImportApi";
import { useCurrentUserProfile } from "../../services/usersApi";
import { toArray } from "../../utils/toArray";
import { accountDisplay, canDo, chartSelectOptions, saveDownload, todayIso, withQuery } from "./accounting-ui";
import type { ActorSession } from "./actor-label";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  ACCOUNT_ORIGIN_LABELS,
  IMPORT_ACCEPT,
  IMPORT_MAX_ENTRIES,
  IMPORT_MAX_ROWS,
  IMPORT_VIEWS,
  LOT_STATUS_FILTER_OPTIONS,
  REVERSAL_REASON_MAX,
  REVERSAL_REASON_MIN,
  THIRD_PARTY_PAGE_LIMIT,
  THIRD_PARTY_QUERY_MAX,
  THIRD_PARTY_ROLE_FILTER_OPTIONS,
  THIRD_PARTY_SEARCH_DEBOUNCE_MS,
  accountActionOptions,
  accountOriginTone,
  accountRowIssue,
  analyticsDimensionOptions,
  analyticsRowKey,
  base64OfArrayBuffer,
  blockedAccountDto,
  buildImportReportCsv,
  buildReconciliationCsv,
  canPostImport,
  canReverseImport,
  centreRequiredLine,
  closingDetectedLine,
  costCentreDimensionOptions,
  costCentreOptions,
  detectFormatFromName,
  entryCountLabel,
  entryKindLabel,
  entryLine,
  entryNoun,
  entryStatusLabel,
  entryStatusTone,
  existingLine,
  fileSizeLabel,
  formatByMonthRows,
  formatByPropertyRows,
  formatLabel,
  importAuthorLabel,
  importFileLabel,
  importKindDescription,
  importKindHint,
  importKindLabel,
  importKindOptions,
  importStatusLabel,
  importStatusTone,
  isAccountAction,
  isAnalyticsDimension,
  isImportKind,
  isImportView,
  isReversalReasonValid,
  isThirdPartyRole,
  isUnassignedPolicy,
  isUsaliDepartment,
  isValidAccountCode,
  lotKindFilterOptions,
  nativeSkippedLine,
  needsUsaliDepartment,
  periodLabel,
  periodRangeDates,
  periodRangeLabel,
  postActionLabel,
  previewBlockers,
  previewKpis,
  reconciliationClassificationLabel,
  reconciliationFileName,
  reconciliationKpis,
  reconciliationRowTone,
  reconciliationStatusLabel,
  reconciliationStatusTone,
  reconciliationSummary,
  reportFileName,
  resultTitle,
  resultTone,
  stepAfter,
  stepStateLabel,
  stepSummary,
  stepTitle,
  stepTone,
  stepsForKind,
  suggestedAccountLabel,
  thirdPartyEmptyMessage,
  thirdPartyLotLabel,
  thirdPartyRoleLabel,
  unassignedPolicyOptions,
  unbalancedLine,
  usaliDepartmentOptions,
  usesAnalytics,
  type AccountRowOrigin,
  type ImportStepKey,
  type ImportView,
  type MonthRow,
  type PropertyRow,
  type ThirdPartyRoleFilter
} from "./sage200-import-helpers";
import { BRAND } from "../../config/brand";

type PickedFile = { name: string; format: LedgerImportFormat | null; contentBase64: string; bytes: number };

/** What step 5 paints: the lot just posted (with the commit warnings and the reconciliation, if any) or a lot opened from the list. */
type ResultView = { created: LedgerImportCreateResult; reconciliation: LedgerReconciliationDto | null; mode: "imported" | "viewed" };

/** One row of the «Cuentas» table: a Sage account of the file without a map entry (pending) or a persisted entry of the map. */
type AccountRow = { sourceAccount: string; sourceName: string | null; lineCount: number; dto: LedgerAccountMapDto; origin: AccountRowOrigin; pending: boolean; byRate: boolean };

/** One row of the «Analítica» table: a code of the chosen dimensions (from the file or from the persisted map). */
type AnalyticsRow = { key: string; dimension: LedgerAnalyticsDimension; sourceCode: string; sourceName: string | null; lineCount: number; dto: LedgerAnalyticsMapDto; pending: boolean };

const LIST_LIMIT = 50;
const RECON_LIST_LIMIT = 20;
const TABLE_MAX_HEIGHT = 480;
const READ_FALLBACK = "El fichero no se pudo leer.";
const DEFAULT_KIND: LedgerImportKind = "journal";
const DEFAULT_CENTRE_DIMENSION: LedgerAnalyticsDimension = "delegacion";
const DEFAULT_COST_CENTRE_DIMENSION: LedgerAnalyticsDimension = "departamento";
const DEFAULT_UNASSIGNED_POLICY: LedgerUnassignedPolicy = "block";
const NOTES_MAX = 500;
const LEDGER_FALLBACK = "/finanzas/contabilidad/mayor";
const KIND_OPTIONS = importKindOptions();
const DIMENSION_OPTIONS = analyticsDimensionOptions();
const COST_CENTRE_DIMENSION_OPTIONS = costCentreDimensionOptions();
const COST_CENTRE_OPTIONS = costCentreOptions();
const USALI_OPTIONS = usaliDepartmentOptions();
const LOT_KIND_OPTIONS = lotKindFilterOptions();
const VIEW_OPTIONS = IMPORT_VIEWS.map((view) => ({ value: view.value, label: view.label }));

/** First day of the month of an ISO date. */
function firstDayOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Read of a picked File as base64 (the API decides encoding and format). */
async function readPicked(picked: File): Promise<PickedFile> {
  const contentBase64 = base64OfArrayBuffer(await picked.arrayBuffer());
  return { name: picked.name, format: detectFormatFromName(picked.name), contentBase64, bytes: picked.size };
}

const MONTH_COLUMNS: CocoaTableColumn<MonthRow>[] = [
  { key: "label", label: "Mes", nowrap: true, render: (row) => row.label },
  { key: "entries", label: "Asientos", fit: true, align: "right", render: (row) => number(row.entries) },
  { key: "lines", label: "Apuntes", fit: true, align: "right", hideOnNarrow: true, render: (row) => number(row.lines) },
  { key: "debit", label: "Debe", align: "right", render: (row) => money(row.debit) },
  { key: "credit", label: "Haber", align: "right", render: (row) => money(row.credit) }
];

const ENTRY_COLUMNS: CocoaTableColumn<LedgerImportEntryDto>[] = [
  { key: "anfitorio", label: "Asiento", fit: true, render: (row) => (row.entryNumber !== null ? <span className="cocoa-mono">{`${row.fiscalYearCode ?? row.sourceFiscalYear}/${number(row.entryNumber)}`}</span> : EMPTY) },
  { key: "property", label: "Centro", fit: true, render: (row) => row.propertyCode },
  { key: "date", label: "Fecha", fit: true, render: (row) => date(row.entryDate) },
  { key: "sage", label: "Sage", fit: true, render: (row) => <span className="cocoa-mono">{`${row.sourceFiscalYear}/${row.sourceEntryNumber}`}</span> },
  { key: "kind", label: "Tipo", fit: true, showFrom: "laptop", render: (row) => entryKindLabel(row.entryKind) },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={entryStatusTone(row.status)} size="small">
        {entryStatusLabel(row.status)}
      </CocoaBadge>
    )
  },
  { key: "lines", label: "Apuntes", fit: true, align: "right", hideOnNarrow: true, render: (row) => number(row.lineCount) },
  { key: "debit", label: "Debe", align: "right", render: (row) => money(row.debit) },
  { key: "warnings", label: "Avisos", truncate: 320, showFrom: "tablet", render: (row) => (row.warnings.length > 0 ? row.warnings.join(" · ") : EMPTY) }
];

/** Columns of «Terceros» (FIX-1 · F11): identifiers in mono; «Nombre» is EMPTY when the API withholds it (personal accounts, masked employees); «Lote» = file · date of the last third_parties lot. */
const THIRD_PARTY_COLUMNS: CocoaTableColumn<LedgerThirdPartyDto>[] = [
  { key: "sourceCode", label: "Código", fit: true, render: (row) => <span className="cocoa-mono">{row.sourceCode}</span> },
  { key: "taxId", label: "NIF", fit: true, render: (row) => (row.taxId ? <span className="cocoa-mono">{row.taxId}</span> : EMPTY) },
  { key: "sourceAccount", label: "Cuenta Sage", fit: true, render: (row) => (row.sourceAccount ? <span className="cocoa-mono">{row.sourceAccount}</span> : EMPTY) },
  { key: "role", label: "Rol", fit: true, render: (row) => thirdPartyRoleLabel(row.role) },
  { key: "name", label: "Nombre", truncate: 280, render: (row) => row.name ?? EMPTY },
  { key: "lote", label: "Lote", truncate: 240, showFrom: "tablet", render: (row) => thirdPartyLotLabel(row.lote) }
];

/** Columns of «Lotes»; «Autor» names the actor (own name, «Sistema · proceso», «otro usuario»), never a raw id. */
function lotColumns(session: ActorSession): CocoaTableColumn<LedgerImportRecord>[] {
  return [
    { key: "createdAt", label: "Fecha", nowrap: true, render: (row) => dateTime(row.createdAt) },
    { key: "kind", label: "Tipo", fit: true, render: (row) => importKindLabel(row.kind) },
    { key: "fileName", label: "Fichero", truncate: 220, render: (row) => <span className="cocoa-mono">{importFileLabel(row)}</span> },
    { key: "range", label: "Rango", nowrap: true, showFrom: "tablet", render: (row) => periodRangeLabel(row.periodFrom, row.periodTo) },
    { key: "entryCount", label: "Asientos", fit: true, align: "right", render: (row) => number(row.entryCount) },
    { key: "totalDebit", label: "Debe", align: "right", showFrom: "laptop", render: (row) => money(row.totalDebit) },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={importStatusTone(row.status)} size="small">
          {importStatusLabel(row.status)}
        </CocoaBadge>
      )
    },
    { key: "createdBy", label: "Autor", truncate: 160, showFrom: "laptop", render: (row) => importAuthorLabel(row.createdBy, session) }
  ];
}

export function Sage200ImportScreen() {
  const header = treeHeaderFor("Sage200ImportScreen", { eyebrow: "Finanzas · Contabilidad", title: "Importar desde Sage 200" });
  const gate = useNavGate();
  const { showToast } = useToast();
  // Tanda 7c: the lot belongs to the sociedad; the reconciliation and the per-centre view take the centre of the ONE «Ámbito» selector (undefined = consolidado).
  const finance = useFinanceScope(financeScopePolicy("Sage200ImportScreen"));
  const canRead = canDo(gate, "accounting.reports.read") || canDo(gate, "accounting.read");
  const canImport = canDo(gate, "accounting.journal.post");
  const canMap = canDo(gate, "accounting.configure");
  const canReverse = canImport && canDo(gate, "ai.high_risk.confirm");
  // Viewer's profile (GET /users/me, cached): names the author of a lot as the own name instead of a raw id.
  const { profile } = useCurrentUserProfile();
  const session = useMemo<ActorSession>(() => (profile ? { userId: profile.userId, fullName: profile.fullName } : null), [profile]);
  const lotTable = useMemo(() => lotColumns(session), [session]);
  const centreOptions = useMemo(() => centreSelectOptions(finance.structure, finance.active, { societyLevel: true, societyLabel: "Sin centro asignado" }), [finance.structure, finance.active]);
  const centres = useMemo(() => (finance.structure?.centres ?? []).map((centre) => ({ id: centre.id, label: centreNameFor(finance.structure, centre.id) })), [finance.structure]);
  const policyOptions = useMemo(() => unassignedPolicyOptions(centres), [centres]);
  const ledgerUrl = urlForScreen("LedgerScreen") ?? LEDGER_FALLBACK;

  // Accessibility: the step content takes focus on every change of step (not on mount); one live region announces the step and the analysis.
  const stepContentRef = useRef<HTMLDivElement | null>(null);
  const stepMounted = useRef(false);

  const [view, setView] = useState<ImportView>("importar");

  // ---- wizard state ----
  const [kind, setKind] = useState<LedgerImportKind>(DEFAULT_KIND);
  const [stepKey, setStepKey] = useState<ImportStepKey>("file");
  const [file, setFile] = useState<PickedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LedgerImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Accounts the user decided in «Cuentas» (by Sage account); the rest keep the mapper proposal or the persisted map.
  const [accountChoices, setAccountChoices] = useState<Record<string, LedgerAccountMapDto>>({});
  const [accountFilter, setAccountFilter] = useState("");
  const [onlyPending, setOnlyPending] = useState(true);
  const [accountMap, setAccountMap] = useState<LedgerAccountMapResponse | null>(null);
  const [analyticsMap, setAnalyticsMap] = useState<LedgerAnalyticsMapResponse | null>(null);
  const [mapsError, setMapsError] = useState<string | null>(null);
  const [savingMap, setSavingMap] = useState<"accounts" | "analytics" | null>(null);
  const [mapSaveError, setMapSaveError] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartAccountView[]>([]);
  const [centreDimension, setCentreDimension] = useState<LedgerAnalyticsDimension>(DEFAULT_CENTRE_DIMENSION);
  const [costCentreDimension, setCostCentreDimension] = useState<LedgerAnalyticsDimension | null>(DEFAULT_COST_CENTRE_DIMENSION);
  const [unassignedPolicy, setUnassignedPolicy] = useState<LedgerUnassignedPolicy>(DEFAULT_UNASSIGNED_POLICY);
  const [analyticsChoices, setAnalyticsChoices] = useState<Record<string, LedgerAnalyticsMapDto>>({});
  const [replace, setReplace] = useState(false);
  const [notes, setNotes] = useState("");
  const [balanceFile, setBalanceFile] = useState<PickedFile | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultView | null>(null);

  // ---- reconciliation view ----
  const [reconFrom, setReconFrom] = useState(() => firstDayOfMonth(todayIso()));
  const [reconTo, setReconTo] = useState(() => todayIso());
  const [reconFile, setReconFile] = useState<PickedFile | null>(null);
  const [reconFileError, setReconFileError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconError, setReconError] = useState<string | null>(null);
  const [recon, setRecon] = useState<LedgerReconciliationDto | null>(null);
  const [reconViewing, setReconViewing] = useState<string | null>(null);
  const [reconDownloading, setReconDownloading] = useState<string | null>(null);

  // ---- lots view ----
  const [lotKind, setLotKind] = useState("");
  const [lotStatus, setLotStatus] = useState("");
  const [lotDetail, setLotDetail] = useState<LedgerImportDetail | null>(null);
  const [lotViewing, setLotViewing] = useState<string | null>(null);
  const [lotPosting, setLotPosting] = useState<string | null>(null);
  const [reverseTarget, setReverseTarget] = useState<LedgerImportRecord | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);

  // ---- third parties view (FIX-1 · F11) ----
  const [tpQuery, setTpQuery] = useState("");
  const [tpRole, setTpRole] = useState<ThirdPartyRoleFilter>("");
  const [tpPage, setTpPage] = useState<LedgerThirdPartyPage | null>(null);
  const [tpLoading, setTpLoading] = useState(false);
  const [tpLoadingMore, setTpLoadingMore] = useState(false);
  const [tpError, setTpError] = useState<string | null>(null);
  const [tpNonce, setTpNonce] = useState(0);

  const lots = useApiData<LedgerImportRecord[]>(canRead ? LEDGER_IMPORTS_PATH : null, { query: { kind: lotKind || undefined, status: lotStatus || undefined, limit: LIST_LIMIT } });
  const lotRows = useMemo(() => toArray<LedgerImportRecord>(lots.data), [lots.data]);
  const reconciliations = useApiData<LedgerReconciliationDto[]>(canRead ? `${LEDGER_IMPORTS_PATH}/reconciliation` : null, { query: { propertyId: finance.propertyId, limit: RECON_LIST_LIMIT } });
  const reconRows = useMemo(() => toArray<LedgerReconciliationDto>(reconciliations.data), [reconciliations.data]);

  // ---- persisted maps and chart (once, when the session may read) ----
  useEffect(() => {
    if (!canRead) return undefined;
    let alive = true;
    Promise.all([getAccountMap(), getAnalyticsMap()])
      .then(([accounts, analytics]) => {
        if (!alive) return;
        setAccountMap(accounts);
        setAnalyticsMap(analytics);
        setCentreDimension(analytics.centreDimension);
        setCostCentreDimension(analytics.costCentreDimension);
        setUnassignedPolicy(analytics.unassignedPolicy);
      })
      .catch((err: unknown) => {
        if (alive) setMapsError(ledgerImportErrorMessage(err, "No se pudieron cargar los mapas guardados: el asistente propone el mapeo desde cero."));
      });
    listChartAccounts({ postableOnly: true })
      .then((response) => {
        if (alive) setChart(response.accounts);
      })
      .catch(() => {
        // The destination picker degrades to a free code; the API validates it.
      });
    return () => {
      alive = false;
    };
  }, [canRead]);

  useEffect(() => {
    if (!stepMounted.current) {
      stepMounted.current = true;
      return;
    }
    stepContentRef.current?.focus();
  }, [stepKey]);

  // ---- third parties: first page whenever the view opens or a filter changes (search debounced); «Cargar más» appends by cursor ----
  useEffect(() => {
    if (view !== "terceros" || !canRead) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      setTpLoading(true);
      setTpError(null);
      listLedgerThirdParties({ q: tpQuery.trim() || undefined, role: tpRole || undefined, limit: THIRD_PARTY_PAGE_LIMIT })
        .then((page) => {
          if (!alive) return;
          setTpPage(page);
          setTpLoading(false);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setTpError(ledgerImportErrorMessage(err, "No se pudieron cargar los terceros importados."));
          setTpLoading(false);
        });
    }, THIRD_PARTY_SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [view, canRead, tpQuery, tpRole, tpNonce]);

  async function loadMoreThirdParties() {
    const cursor = tpPage?.nextCursor;
    if (!cursor || tpLoadingMore) return;
    setTpLoadingMore(true);
    setTpError(null);
    try {
      const next = await listLedgerThirdParties({ q: tpQuery.trim() || undefined, role: tpRole || undefined, limit: THIRD_PARTY_PAGE_LIMIT, cursor });
      setTpPage((current) => (current && current.nextCursor === cursor ? { rows: [...current.rows, ...next.rows], total: next.total, nextCursor: next.nextCursor } : current));
    } catch (err: unknown) {
      setTpError(ledgerImportErrorMessage(err, "No se pudieron cargar más terceros."));
    } finally {
      setTpLoadingMore(false);
    }
  }

  // ---- derived: steps of the kind, analytics mapping, bodies ----
  const steps = useMemo(() => stepsForKind(kind, preview?.unmappedAccounts.length ?? 0), [kind, preview]);
  const stepIndex = Math.max(
    0,
    steps.findIndex((step) => step.key === stepKey)
  );
  const current = steps[stepIndex] ?? steps[0];
  const summary = stepSummary(steps, stepIndex);
  const blockers = previewBlockers(preview);

  const analyticsInput = useMemo<LedgerAnalyticsMappingInput>(() => {
    const persisted = new Map<string, LedgerAnalyticsMapDto>();
    for (const entry of analyticsMap?.entries ?? []) persisted.set(analyticsRowKey(entry), entry);
    for (const [key, dto] of Object.entries(analyticsChoices)) persisted.set(key, dto);
    return { centreDimension, costCentreDimension, unassignedPolicy, entries: [...persisted.values()] };
  }, [analyticsMap, analyticsChoices, centreDimension, costCentreDimension, unassignedPolicy]);

  const mappingInput = useCallback(
    (forKind: LedgerImportKind, choices: Record<string, LedgerAccountMapDto>, analytics: LedgerAnalyticsMappingInput): LedgerImportMappingInput => {
      const accounts = Object.values(choices);
      return { accounts: accounts.length > 0 ? accounts : undefined, analytics: usesAnalytics(forKind) ? analytics : undefined };
    },
    []
  );

  // `options.reconcile` never travels by HTTP: the body cannot carry the Sage balance (only the CLI attaches it), so the
  // API would answer «no se adjuntó el balance»; the screen runs `reconcileLedger` itself after the lot is posted.
  const optionsInput = useCallback(
    (forKind: LedgerImportKind, replaceLots: boolean, policy: LedgerUnassignedPolicy): LedgerImportOptions => ({
      replace: replaceLots,
      unassignedPolicy: usesAnalytics(forKind) ? policy : undefined
    }),
    []
  );

  // Latest preview request wins: a stale answer (the user changed a choice meanwhile) is dropped.
  const requestSeq = useRef(0);

  const runPreview = useCallback(
    async (input: { file: PickedFile; kind: LedgerImportKind; choices: Record<string, LedgerAccountMapDto>; analytics: LedgerAnalyticsMappingInput; replace: boolean }): Promise<LedgerImportPreview | null> => {
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      setPreviewing(true);
      setPreviewError(null);
      setImportError(null);
      try {
        const next = await previewLedgerImport({
          kind: input.kind,
          format: input.file.format ?? undefined,
          fileName: input.file.name,
          contentBase64: input.file.contentBase64,
          mapping: mappingInput(input.kind, input.choices, input.analytics),
          options: optionsInput(input.kind, input.replace, input.analytics.unassignedPolicy)
        });
        if (seq !== requestSeq.current) return null;
        setPreview(next);
        return next;
      } catch (err) {
        if (seq !== requestSeq.current) return null;
        // A failed re-analysis keeps the previous preview on screen: the user stays in the step with the error callout and retries.
        setPreviewError(ledgerImportErrorMessage(err, "No se pudo analizar el fichero."));
        return null;
      } finally {
        if (seq === requestSeq.current) setPreviewing(false);
      }
    },
    [mappingInput, optionsInput]
  );

  /** Drops the file and its analysis (a spent preview after a commit; «Nueva importación»). */
  function discardPreview() {
    requestSeq.current += 1;
    setFile(null);
    setPreview(null);
    setPreviewing(false);
    setPreviewError(null);
    setAccountChoices({});
    setAnalyticsChoices({});
    setAccountFilter("");
    setOnlyPending(true);
    setReplace(false);
    setBalanceFile(null);
    setBalanceError(null);
    setNotes("");
  }

  function resetAll() {
    discardPreview();
    setStepKey("file");
    setFileError(null);
    setTemplateError(null);
    setImportError(null);
    setResult(null);
  }

  function changeKind(value: string) {
    if (!isImportKind(value) || value === kind) return;
    setKind(value);
    discardPreview();
    setStepKey("file");
    setResult(null);
  }

  async function pickFile(picked: File) {
    setFileError(null);
    let next: PickedFile;
    try {
      next = await readPicked(picked);
    } catch {
      setFileError(READ_FALLBACK);
      return;
    }
    setFile(next);
    setPreview(null);
    setAccountChoices({});
    setResult(null);
    setImportError(null);
    const analysed = await runPreview({ file: next, kind, choices: {}, analytics: analyticsInput, replace });
    if (analysed) {
      const path = stepsForKind(kind, analysed.unmappedAccounts.length);
      setStepKey(path[1]?.key ?? "review");
    }
  }

  function removeFile() {
    discardPreview();
    setStepKey("file");
  }

  async function pickBalance(picked: File, target: "review" | "recon") {
    const setError = target === "review" ? setBalanceError : setReconFileError;
    setError(null);
    try {
      const next = await readPicked(picked);
      if (target === "review") setBalanceFile(next);
      else setReconFile(next);
    } catch {
      setError(READ_FALLBACK);
    }
  }

  async function downloadTemplate() {
    setTemplateBusy(true);
    setTemplateError(null);
    try {
      saveDownload(await downloadLedgerImportTemplate(kind));
    } catch (err) {
      setTemplateError(ledgerImportErrorMessage(err, "No se pudo descargar la plantilla."));
    } finally {
      setTemplateBusy(false);
    }
  }

  // ---- accounts step ----
  const accountRows = useMemo<AccountRow[]>(() => {
    if (!preview) return [];
    const rows: AccountRow[] = [];
    const pendingKeys = new Set<string>();
    for (const unmapped of preview.unmappedAccounts) {
      pendingKeys.add(unmapped.sourceAccount);
      const chosen = accountChoices[unmapped.sourceAccount];
      const dto = chosen ?? unmapped.suggestion ?? blockedAccountDto(unmapped.sourceAccount, unmapped.sourceName);
      rows.push({
        sourceAccount: unmapped.sourceAccount,
        sourceName: unmapped.sourceName,
        lineCount: unmapped.lineCount,
        dto: { ...dto, sourceAccount: unmapped.sourceAccount, sourceName: dto.sourceName ?? unmapped.sourceName },
        origin: chosen ? "manual" : unmapped.suggestion ? "sugerida" : "manual",
        pending: true,
        byRate: unmapped.suggestion?.action === "map_by_rate" || dto.action === "map_by_rate"
      });
    }
    if (!onlyPending) {
      for (const entry of accountMap?.entries ?? []) {
        if (pendingKeys.has(entry.sourceAccount)) continue;
        const chosen = accountChoices[entry.sourceAccount];
        rows.push({ sourceAccount: entry.sourceAccount, sourceName: entry.sourceName ?? null, lineCount: entry.lineCount ?? 0, dto: chosen ?? entry, origin: chosen ? "manual" : "guardada", pending: false, byRate: entry.action === "map_by_rate" });
      }
    }
    const needle = accountFilter.trim().toLowerCase();
    return needle ? rows.filter((row) => `${row.sourceAccount} ${row.sourceName ?? ""} ${row.dto.accountCode ?? ""}`.toLowerCase().includes(needle)) : rows;
  }, [preview, accountChoices, accountMap, onlyPending, accountFilter]);

  const destinationOptions = useMemo(() => chartSelectOptions(chart, { postableOnly: true }), [chart]);

  /** Options of a destination picker: the postable chart plus the row's own code when the chart does not know it (or is not loaded). */
  function destinationOptionsFor(code: string | null): CocoaSelectOption[] {
    const base: CocoaSelectOption[] = [{ value: "", label: "Elegir cuenta…" }, ...destinationOptions];
    if (code && !destinationOptions.some((option) => option.value === code)) base.splice(1, 0, { value: code, label: accountDisplay(chart, code) });
    return base;
  }

  function changeAccountRow(row: AccountRow, patch: Partial<LedgerAccountMapDto>) {
    const next: LedgerAccountMapDto = { ...row.dto, ...patch, sourceAccount: row.sourceAccount, sourceName: row.dto.sourceName ?? row.sourceName, suggested: false };
    if (next.action === "block") next.accountCode = null;
    if (!needsUsaliDepartment(next)) {
      next.usaliDepartment = null;
      next.usaliLine = null;
    }
    next.carryCounterparty = next.action === "collapse" ? next.carryCounterparty !== false : false;
    setAccountChoices((prev) => ({ ...prev, [row.sourceAccount]: next }));
  }

  /** Every pending row has a valid destination (or is blocked on purpose): «Aplicar» re-previews to let the API confirm. */
  const accountIssues = accountRows.filter((row) => row.pending && accountRowIssue(row.dto) !== null && row.dto.action !== "block").length;

  async function saveAccountMap() {
    if (!canMap || !accountMap) return;
    setSavingMap("accounts");
    setMapSaveError(null);
    try {
      const merged = new Map<string, LedgerAccountMapDto>();
      for (const entry of accountMap.entries) merged.set(entry.sourceAccount, entry);
      // Rows without a valid destination (or a `create` in 6 / 7 without USALI) would end in 400 LEDGER_IMPORT_MAP_INVALID: they stay pending here.
      let skippedRows = 0;
      const isSaveable = (dto: LedgerAccountMapDto): boolean => dto.action === "block" || accountRowIssue(dto) === null;
      for (const row of accountRows) {
        if (!row.pending || row.dto.action === "block") continue;
        if (isSaveable(row.dto)) merged.set(row.sourceAccount, { ...row.dto, suggested: false });
        else skippedRows += 1;
      }
      for (const dto of Object.values(accountChoices)) {
        if (isSaveable(dto)) merged.set(dto.sourceAccount, { ...dto, suggested: false });
      }
      const saved = await putAccountMap({ system: accountMap.system, entries: [...merged.values()] });
      setAccountMap(saved);
      setAccountChoices((prev) => Object.fromEntries(Object.entries(prev).filter(([, dto]) => !isSaveable(dto))));
      showToast(`Mapa de cuentas guardado: ${plural(saved.entries.length, "cuenta de Sage", "cuentas de Sage")}${skippedRows > 0 ? `; ${plural(skippedRows, "cuenta pendiente sin destino válido queda", "cuentas pendientes sin destino válido quedan")} sin guardar` : ""}.`, { variant: skippedRows > 0 ? "warning" : "success" });
      if (file) await runPreview({ file, kind, choices: {}, analytics: analyticsInput, replace });
    } catch (err) {
      setMapSaveError(ledgerImportErrorMessage(err, "No se pudo guardar el mapa de cuentas."));
    } finally {
      setSavingMap(null);
    }
  }

  async function applyAccounts() {
    if (!file) return;
    const analysed = await runPreview({ file, kind, choices: accountChoices, analytics: analyticsInput, replace });
    // Balances whose accounts are now all mapped drop «Cuentas» from the path: continue to the next step, never back to «Fichero».
    if (analysed) setStepKey(stepAfter(stepsForKind(kind, analysed.unmappedAccounts.length), "accounts"));
  }

  // ---- analytics step ----
  const analyticsRows = useMemo<AnalyticsRow[]>(() => {
    const rows = new Map<string, AnalyticsRow>();
    const dimensions = new Set<LedgerAnalyticsDimension>([centreDimension, ...(costCentreDimension ? [costCentreDimension] : [])]);
    for (const entry of analyticsMap?.entries ?? []) {
      if (!dimensions.has(entry.dimension)) continue;
      const key = analyticsRowKey(entry);
      rows.set(key, { key, dimension: entry.dimension, sourceCode: entry.sourceCode, sourceName: entry.sourceName ?? null, lineCount: 0, dto: analyticsChoices[key] ?? entry, pending: false });
    }
    for (const unmapped of preview?.unmappedAnalytics ?? []) {
      const key = analyticsRowKey(unmapped);
      const known = rows.get(key);
      const dto = analyticsChoices[key] ?? known?.dto ?? { dimension: unmapped.dimension, sourceCode: unmapped.sourceCode, sourceName: unmapped.sourceName, propertyId: null, costCentreCode: null, suggested: false };
      rows.set(key, { key, dimension: unmapped.dimension, sourceCode: unmapped.sourceCode, sourceName: unmapped.sourceName ?? known?.sourceName ?? null, lineCount: unmapped.lineCount, dto, pending: true });
    }
    return [...rows.values()].sort((a, b) => Number(b.pending) - Number(a.pending) || a.dimension.localeCompare(b.dimension) || a.sourceCode.localeCompare(b.sourceCode, "es"));
  }, [analyticsMap, analyticsChoices, preview, centreDimension, costCentreDimension]);

  function changeAnalyticsRow(row: AnalyticsRow, patch: Partial<LedgerAnalyticsMapDto>) {
    const next: LedgerAnalyticsMapDto = { ...row.dto, ...patch, dimension: row.dimension, sourceCode: row.sourceCode, sourceName: row.dto.sourceName ?? row.sourceName, suggested: false };
    setAnalyticsChoices((prev) => ({ ...prev, [row.key]: next }));
  }

  async function saveAnalyticsMap() {
    if (!canMap) return;
    setSavingMap("analytics");
    setMapSaveError(null);
    try {
      const saved = await putAnalyticsMap({ system: analyticsMap?.system, centreDimension, costCentreDimension, unassignedPolicy, entries: analyticsInput.entries });
      setAnalyticsMap(saved);
      setAnalyticsChoices({});
      showToast(`Mapa analítico guardado: ${plural(saved.entries.length, "código", "códigos")}.`, { variant: "success" });
      if (file) await runPreview({ file, kind, choices: accountChoices, analytics: { centreDimension: saved.centreDimension, costCentreDimension: saved.costCentreDimension, unassignedPolicy: saved.unassignedPolicy, entries: saved.entries }, replace });
    } catch (err) {
      setMapSaveError(ledgerImportErrorMessage(err, "No se pudo guardar el mapa analítico."));
    } finally {
      setSavingMap(null);
    }
  }

  async function applyAnalytics() {
    if (!file) return;
    const analysed = await runPreview({ file, kind, choices: accountChoices, analytics: analyticsInput, replace });
    if (analysed) setStepKey("review");
  }

  // ---- review step ----
  function changeReplace(value: boolean) {
    setReplace(value);
    if (file) void runPreview({ file, kind, choices: accountChoices, analytics: analyticsInput, replace: value });
  }

  const postDisabled = !preview?.canPost || !canImport || importing || previewing;
  // The preview on screen predates a failed re-analysis: keep it visible, but do not post on it.
  const previewStale = preview !== null && previewError !== null;

  async function runImport() {
    if (!file || !preview || !canImport || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const created = await createLedgerImport({
        kind,
        format: file.format ?? undefined,
        fileName: file.name,
        contentBase64: file.contentBase64,
        mapping: mappingInput(kind, accountChoices, analyticsInput),
        options: optionsInput(kind, replace, analyticsInput.unassignedPolicy),
        post: true,
        notes: notes.trim() || undefined
      });
      let reconciliation = created.reconciliation;
      // The Sage trial balance attached in «Revisión» reconciles the same range of the lot just posted (its id names the missing entries).
      const range = periodRangeDates(created.import.periodFrom, created.import.periodTo);
      if (!reconciliation && balanceFile && range && created.import.status === "posted") {
        try {
          reconciliation = await reconcileLedger({ from: range.from, to: range.to, propertyId: finance.propertyId, format: balanceFile.format ?? undefined, contentBase64: balanceFile.contentBase64, importId: created.import.id });
          reconciliations.refresh();
        } catch (err) {
          showToast(ledgerImportErrorMessage(err, "El lote se contabilizó, pero la reconciliación no se pudo ejecutar."), { variant: "warning" });
        }
      }
      setResult({ created, reconciliation, mode: "imported" });
      setStepKey("result");
      // The preview is spent: a second «Contabilizar» would end in 409 LEDGER_IMPORT_DUPLICATE; only «Nueva importación» remains.
      discardPreview();
      showToast(resultTitle(created.import, created.created), { variant: created.import.status === "posted" ? "success" : "warning" });
      lots.refresh();
    } catch (err) {
      setImportError(ledgerImportErrorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  function downloadReport() {
    if (!result) return;
    const csv = buildImportReportCsv(result.created.entries);
    saveDownload({ blob: new Blob([csv], { type: "text/csv;charset=utf-8" }), filename: reportFileName(result.created.import), contentType: "text/csv" });
  }

  // ---- reconciliation view ----
  const reconDatesValid = /^\d{4}-\d{2}-\d{2}$/.test(reconFrom) && /^\d{4}-\d{2}-\d{2}$/.test(reconTo);
  const reconRangeInverted = reconDatesValid && reconFrom > reconTo;
  const reconReady = reconFile !== null && reconDatesValid && !reconRangeInverted;
  const reconBlockedReason = !canImport ? "Reconciliar exige el permiso de contabilizar asientos." : !reconDatesValid ? "Indica las fechas «Desde» y «Hasta» (AAAA-MM-DD)." : reconRangeInverted ? "«Desde» debe ser igual o anterior a «Hasta»." : reconFile === null ? "Adjunta el balance de sumas y saldos de Sage." : undefined;

  async function runReconciliation() {
    if (!reconFile || !reconReady || reconciling || !canImport) return;
    setReconciling(true);
    setReconError(null);
    try {
      const next = await reconcileLedger({ from: reconFrom, to: reconTo, propertyId: finance.propertyId, format: reconFile.format ?? undefined, contentBase64: reconFile.contentBase64 });
      setRecon(next);
      showToast(`Reconciliación ${reconciliationStatusLabel(next.status).toLowerCase()}: ${plural(next.accountsCompared, "cuenta comparada", "cuentas comparadas")}, ${plural(next.differenceCount, "diferencia", "diferencias")}.`, { variant: next.status === "ok" ? "success" : "warning" });
      reconciliations.refresh();
    } catch (err) {
      setReconError(ledgerImportErrorMessage(err, "No se pudo ejecutar la reconciliación."));
    } finally {
      setReconciling(false);
    }
  }

  async function viewReconciliation(row: LedgerReconciliationDto) {
    setReconViewing(row.id);
    try {
      setRecon(await getReconciliation(row.id));
    } catch (err) {
      showToast(ledgerImportErrorMessage(err, "No se pudo abrir la reconciliación."), { variant: "error" });
    } finally {
      setReconViewing(null);
    }
  }

  async function downloadReconciliation(row: Pick<LedgerReconciliationDto, "id">) {
    setReconDownloading(row.id);
    try {
      saveDownload(await downloadReconciliationCsv(row.id));
    } catch (err) {
      showToast(ledgerImportErrorMessage(err, "No se pudo descargar la reconciliación."), { variant: "error" });
    } finally {
      setReconDownloading(null);
    }
  }

  function downloadCurrentReconciliation() {
    if (!recon) return;
    const csv = buildReconciliationCsv(recon);
    saveDownload({ blob: new Blob([csv], { type: "text/csv;charset=utf-8" }), filename: reconciliationFileName(recon), contentType: "text/csv" });
  }

  function openLedger(row: LedgerReconciliationRow, current: LedgerReconciliationDto) {
    openTabPath(withQuery(ledgerUrl, { cuenta: row.accountCode, desde: current.periodFrom, hasta: current.periodTo, ambito: finance.value }));
  }

  // ---- lots view ----
  async function viewLot(record: LedgerImportRecord) {
    setLotViewing(record.id);
    try {
      setLotDetail(await getLedgerImport(record.id));
    } catch (err) {
      showToast(ledgerImportErrorMessage(err, "No se pudo abrir el lote."), { variant: "error" });
    } finally {
      setLotViewing(null);
    }
  }

  async function postLot(record: LedgerImportRecord) {
    if (!canImport || lotPosting) return;
    setLotPosting(record.id);
    try {
      const posted = await postLedgerImport(record.id, {});
      showToast(resultTitle(posted.import, posted.created), { variant: "success" });
      lots.refresh();
      if (lotDetail?.import.id === record.id) setLotDetail(await getLedgerImport(record.id));
    } catch (err) {
      showToast(ledgerImportErrorMessage(err, "No se pudo contabilizar el lote."), { variant: "error" });
    } finally {
      setLotPosting(null);
    }
  }

  function openReverse(record: LedgerImportRecord) {
    setReverseTarget(record);
    setReverseReason("");
    setReverseError(null);
  }

  async function confirmReverse() {
    if (!reverseTarget || reversing || !isReversalReasonValid(reverseReason)) return;
    setReversing(true);
    setReverseError(null);
    try {
      const reversed = await reverseLedgerImport(reverseTarget.id, { reason: reverseReason.trim() });
      showToast(`Lote revertido: ${plural(reversed.reversalJournalEntryIds.length, "asiento de anulación", "asientos de anulación")}.`, { variant: "success" });
      setReverseTarget(null);
      setReverseReason("");
      lots.refresh();
      if (lotDetail?.import.id === reversed.id) setLotDetail(await getLedgerImport(reversed.id));
    } catch (err) {
      setReverseError(ledgerImportErrorMessage(err, "No se pudo revertir el lote."));
    } finally {
      setReversing(false);
    }
  }

  // ---- live region ----
  const viewLabel = IMPORT_VIEWS.find((option) => option.value === view)?.label ?? "";
  const liveMessage = previewing ? "Analizando el fichero…" : importing ? "Contabilizando el lote…" : reconciling ? "Reconciliando con el balance de Sage…" : view === "importar" ? `Paso ${number(stepIndex + 1)} de ${number(steps.length)}: ${current?.label ?? ""}` : `Vista: ${viewLabel}`;

  const reachable = (key: ImportStepKey): boolean => {
    if (key === "file") return true;
    if (key === "result") return result !== null;
    return preview !== null;
  };

  // ---- columns that close over state ----
  const accountColumns: CocoaTableColumn<AccountRow>[] = [
    { key: "sourceAccount", label: "Cuenta Sage", fit: true, render: (row) => <span className="cocoa-mono">{row.sourceAccount}</span> },
    { key: "sourceName", label: "Título", truncate: 220, showFrom: "tablet", render: (row) => row.sourceName ?? EMPTY },
    { key: "lineCount", label: "Apuntes", fit: true, align: "right", hideOnNarrow: true, render: (row) => number(row.lineCount) },
    {
      key: "action",
      label: "Acción",
      fit: true,
      render: (row) => (
        <CocoaSelect size="small" inline aria-label={`Acción para la cuenta ${row.sourceAccount}`} value={row.dto.action} onChange={(value) => changeAccountRow(row, { action: isAccountAction(value) ? value : "block" })} options={accountActionOptions(row.byRate)} disabled={previewing || importing || savingMap !== null} />
      )
    },
    {
      key: "accountCode",
      label: "Cuenta destino",
      render: (row) =>
        row.dto.action === "block" ? (
          EMPTY
        ) : row.dto.action === "create" ? (
          <CocoaInput size="small" value={row.dto.accountCode ?? ""} onChange={(value) => changeAccountRow(row, { accountCode: value.trim() || null })} placeholder="623.2" aria-label={`Subcuenta nueva para la cuenta ${row.sourceAccount}`} error={!isValidAccountCode(row.dto.accountCode)} disabled={previewing || importing || savingMap !== null} />
        ) : (
          <CocoaSelect size="small" aria-label={`Cuenta destino de la cuenta ${row.sourceAccount}`} value={row.dto.accountCode ?? ""} onChange={(value) => changeAccountRow(row, { accountCode: value || null })} options={destinationOptionsFor(row.dto.accountCode)} disabled={previewing || importing || savingMap !== null} />
        )
    },
    {
      // Visible at every width: a `create` in 6 / 7 cannot leave the step without its USALI department (phones and tablets included).
      key: "usali",
      label: "USALI",
      render: (row) =>
        needsUsaliDepartment(row.dto) ? (
          <CocoaSelect size="small" inline aria-label={`Departamento USALI de la subcuenta ${row.dto.accountCode ?? row.sourceAccount}`} value={row.dto.usaliDepartment ?? ""} onChange={(value) => changeAccountRow(row, { usaliDepartment: isUsaliDepartment(value) ? value : null })} options={USALI_OPTIONS} disabled={previewing || importing || savingMap !== null} />
        ) : (
          EMPTY
        )
    },
    {
      key: "origin",
      label: "Origen",
      fit: true,
      hideOnNarrow: true,
      render: (row) => (
        <CocoaBadge tone={accountOriginTone(row.origin)} size="small" variant="tinted" uppercase={false} title={row.origin === "sugerida" ? suggestedAccountLabel(row.dto) : undefined}>
          {ACCOUNT_ORIGIN_LABELS[row.origin]}
        </CocoaBadge>
      )
    }
  ];

  const analyticsColumns: CocoaTableColumn<AnalyticsRow>[] = [
    { key: "dimension", label: "Dimensión", fit: true, render: (row) => (row.dimension === centreDimension ? "Centro" : "Centro de coste") },
    { key: "sourceCode", label: "Código Sage", fit: true, render: (row) => <span className="cocoa-mono">{row.sourceCode}</span> },
    { key: "sourceName", label: "Nombre en Sage", truncate: 220, showFrom: "tablet", render: (row) => row.sourceName ?? EMPTY },
    { key: "lineCount", label: "Apuntes", fit: true, align: "right", hideOnNarrow: true, render: (row) => (row.lineCount > 0 ? number(row.lineCount) : EMPTY) },
    {
      key: "target",
      label: `Destino en ${BRAND.name}`,
      render: (row) =>
        row.dimension === centreDimension ? (
          <CocoaSelect size="small" aria-label={`Centro de trabajo del código ${row.sourceCode}`} value={row.dto.propertyId ?? ""} onChange={(value) => changeAnalyticsRow(row, { propertyId: value || null })} options={centreOptions} disabled={previewing || importing || savingMap !== null} />
        ) : (
          <CocoaSelect size="small" aria-label={`Centro de coste USALI del código ${row.sourceCode}`} value={row.dto.costCentreCode ?? ""} onChange={(value) => changeAnalyticsRow(row, { costCentreCode: value || null })} options={COST_CENTRE_OPTIONS} disabled={previewing || importing || savingMap !== null} />
        )
    },
    {
      key: "state",
      label: "Estado",
      fit: true,
      hideOnNarrow: true,
      render: (row) => (
        <CocoaBadge tone={row.pending && !(row.dimension === centreDimension ? row.dto.propertyId : row.dto.costCentreCode) ? "warning" : "success"} size="small" variant="dot">
          {row.pending && !(row.dimension === centreDimension ? row.dto.propertyId : row.dto.costCentreCode) ? "Pendiente" : "Asignado"}
        </CocoaBadge>
      )
    }
  ];

  const propertyColumns: CocoaTableColumn<PropertyRow>[] = [
    { key: "property", label: "Centro", nowrap: true, render: (row) => (row.propertyId ? centreNameFor(finance.structure, row.propertyId, row.propertyCode) : `Sociedad (sin centro) · ${row.propertyCode}`) },
    { key: "entries", label: "Asientos", fit: true, align: "right", render: (row) => number(row.entries) },
    { key: "debit", label: "Debe", align: "right", render: (row) => money(row.debit) },
    { key: "credit", label: "Haber", align: "right", render: (row) => money(row.credit) }
  ];

  const reconColumns = (current: LedgerReconciliationDto): CocoaTableColumn<LedgerReconciliationRow>[] => [
    {
      key: "accountCode",
      label: "Cuenta",
      fit: true,
      render: (row) => (
        <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openLedger(row, current)} title="Abrir el mayor de la cuenta en el rango">
          <span className="cocoa-mono">{row.accountCode}</span>
        </CocoaButton>
      )
    },
    { key: "accountName", label: "Nombre", truncate: 200, showFrom: "tablet", render: (row) => row.accountName ?? EMPTY },
    { key: "period", label: "Periodo", nowrap: true, showFrom: "laptop", render: () => dateRange(current.periodFrom, current.periodTo) },
    { key: "sourceAccounts", label: "Cuentas Sage", truncate: 160, showFrom: "desktop", render: (row) => (row.sourceAccounts.length > 0 ? row.sourceAccounts.join(", ") : EMPTY) },
    { key: "sourceDebit", label: "Debe Sage", align: "right", hideOnNarrow: true, render: (row) => money(row.sourceDebit) },
    { key: "ledgerDebit", label: `Debe ${BRAND.name}`, align: "right", hideOnNarrow: true, render: (row) => money(row.ledgerDebit) },
    { key: "sourceCredit", label: "Haber Sage", align: "right", showFrom: "laptop", render: (row) => money(row.sourceCredit) },
    { key: "ledgerCredit", label: `Haber ${BRAND.name}`, align: "right", showFrom: "laptop", render: (row) => money(row.ledgerCredit) },
    { key: "diffBalance", label: "Diferencia", align: "right", render: (row) => money(row.diffBalance) },
    {
      key: "classification",
      label: "Resultado",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={reconciliationRowTone(row) ?? "success"} size="small" title={row.note}>
          {row.ok ? "Cuadra" : reconciliationClassificationLabel(row.classification)}
        </CocoaBadge>
      )
    }
  ];

  const reconHistoryColumns: CocoaTableColumn<LedgerReconciliationDto>[] = [
    { key: "createdAt", label: "Fecha", nowrap: true, render: (row) => dateTime(row.createdAt) },
    { key: "range", label: "Rango", nowrap: true, render: (row) => dateRange(row.periodFrom, row.periodTo) },
    { key: "property", label: "Centro", fit: true, render: (row) => (row.propertyId ? centreNameFor(finance.structure, row.propertyId, row.propertyCode) : "Consolidado") },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={reconciliationStatusTone(row.status)} size="small">
          {reconciliationStatusLabel(row.status)}
        </CocoaBadge>
      )
    },
    { key: "accountsCompared", label: "Comparadas", fit: true, align: "right", hideOnNarrow: true, render: (row) => number(row.accountsCompared) },
    { key: "differenceCount", label: "Diferencias", fit: true, align: "right", render: (row) => number(row.differenceCount) }
  ];

  // ---- steps ----
  function renderFileStep() {
    return (
      <CocoaSection title={stepTitle(steps, "file")} meta={file ? `${formatLabel(file.format)} · ${fileSizeLabel(file.bytes)}` : undefined}>
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Tipo de lote" help={importKindDescription(kind)}>
            <CocoaSelect value={kind} onChange={changeKind} options={KIND_OPTIONS} size="small" aria-label="Tipo de lote" disabled={previewing || importing} />
          </CocoaField>
          <div className="cocoa-row">
            <CocoaFileInput accept={IMPORT_ACCEPT} maxBytes={20 * 1024 * 1024} fileName={file?.name ?? null} onPick={(picked) => void pickFile(picked)} onReject={setFileError} disabled={previewing || importing || !canImport} label="Elegir fichero de Sage 200" />
            {file ? (
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={removeFile} disabled={previewing || importing}>
                Quitar fichero
              </CocoaButton>
            ) : null}
            {file ? (
              <CocoaBadge tone="neutral" size="small" uppercase={false}>
                {formatLabel(preview?.format ?? file.format)}
              </CocoaBadge>
            ) : null}
            {previewing ? (
              <CocoaBadge tone="info" size="small">
                Analizando el fichero…
              </CocoaBadge>
            ) : null}
          </div>
          <div className="cocoa-row">
            <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={templateBusy} disabled={templateBusy || !canRead} onClick={() => void downloadTemplate()}>
              Descargar plantilla canónica
            </CocoaButton>
          </div>
          <div className="cocoa-row">
            <CocoaStat label="Sociedad" value={finance.entityName || EMPTY} hint="Los lotes se contabilizan en la sociedad; el centro sale de la analítica de cada apunte" tabular={false} />
            {preview ? <CocoaStat label="Filas de datos" value={number(preview.rowCount)} hint={`${entryCountLabel(preview.kind, preview.entryCount)} · ${preview.fiscalYearCode ? `ejercicio ${preview.fiscalYearCode}` : "ejercicio por fecha"} · ${periodRangeLabel(preview.periodFrom, preview.periodTo)}`} /> : null}
          </div>
          <p className="cocoa-note">{importKindHint(kind)}</p>
          <p className="cocoa-note">
            {IMPORT_ACCEPT.split(",").join(" · ")}: Excel o CSV exportado de Sage (se lee por cabecera, no por posición), CSV de asientos de 60 columnas o el formato canónico de la plantilla; el XML «Datos contables» de Sage todavía no se admite. Máximo {fileSizeLabel(20 * 1024 * 1024)}, {number(IMPORT_MAX_ROWS)} filas y {number(IMPORT_MAX_ENTRIES)} asientos por lote; para más, troceado por meses o la herramienta de línea de comandos. El fichero no se guarda: solo el lote y el resultado por asiento.
          </p>
          {canRead && !canImport ? <p className="cocoa-note">Analizar un fichero exige el permiso de contabilizar asientos: con solo lectura puedes descargar la plantilla y consultar los lotes, los mapas y las reconciliaciones.</p> : null}
          {mapsError ? (
            <CocoaCallout tone="warning" title="Mapas guardados no disponibles" role="status">
              {mapsError}
            </CocoaCallout>
          ) : null}
          {templateError ? (
            <CocoaCallout tone="danger" title="No se pudo descargar la plantilla" role="alert">
              {templateError}
            </CocoaCallout>
          ) : null}
          {fileError ? (
            <CocoaCallout tone="danger" title="No se pudo leer el fichero" role="alert">
              {fileError}
            </CocoaCallout>
          ) : null}
          {previewError ? (
            <CocoaCallout tone="danger" title="No se pudo analizar" role="alert">
              {previewError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaSection>
    );
  }

  function renderAccountsStep() {
    if (!preview) return renderFileStep();
    const pending = preview.unmappedAccounts.length;
    return (
      <CocoaSection
        title={stepTitle(steps, "accounts")}
        meta={`${plural(pending, "cuenta pendiente", "cuentas pendientes")} · ${plural(accountMap?.entries.length ?? 0, "guardada", "guardadas")}`}
        action={
          canMap ? (
            <CocoaButton variant="plain" tone="accent" size="small" loading={savingMap === "accounts"} disabled={savingMap !== null || previewing || importing || !accountMap} onClick={() => void saveAccountMap()}>
              Guardar mapa
            </CocoaButton>
          ) : undefined
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <p className="cocoa-note">
            El sistema propone un destino por cuenta de Sage: cuenta existente del plan (4770021 → 477.21), subcuenta nueva (623.2), agrupación del tercero en 4300 / 400 / 410 con el nombre en la descripción, o bloqueo. Cambia la acción o la cuenta donde haga falta; «Aplicar y continuar» vuelve a analizar con tus decisiones y «Guardar mapa» las conserva para los lotes siguientes{canMap ? "" : " (guardar exige el permiso de configuración contable)"}.
          </p>
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Buscar cuenta">
              <CocoaSearchInput value={accountFilter} onChange={setAccountFilter} placeholder="Cuenta Sage, título o destino…" aria-label="Filtrar las cuentas por código, título o destino" />
            </CocoaField>
            <CocoaSwitch checked={onlyPending} onChange={setOnlyPending} label="Solo pendientes" size="small" />
          </div>
          {pending === 0 ? (
            <CocoaCallout tone="success" title="Todas las cuentas del fichero resuelven con el mapa guardado" role="status">
              Desactiva «Solo pendientes» para revisar el mapa completo.
            </CocoaCallout>
          ) : null}
          <CocoaTable
            columns={accountColumns}
            rows={accountRows}
            rowKey="sourceAccount"
            density="compact"
            virtualize
            maxHeight={TABLE_MAX_HEIGHT}
            rowTone={(row) => (row.pending && row.dto.action === "block" ? "warning" : row.pending && accountRowIssue(row.dto) ? "danger" : undefined)}
            rowTitle={(row) => accountRowIssue(row.dto) ?? undefined}
            emptyState={onlyPending ? "Ninguna cuenta pendiente." : "El mapa de cuentas está vacío."}
            caption="Mapa de cuentas Sage → PGC"
            aria-label="Mapa de cuentas de Sage 200 al plan de cuentas"
          />
          {accountIssues > 0 ? (
            <CocoaCallout tone="warning" title="Cuentas con destino incompleto" role="status">
              {plural(accountIssues, "cuenta pendiente necesita", "cuentas pendientes necesitan")} una cuenta destino válida (o el departamento USALI de la subcuenta nueva) antes de aplicar.
            </CocoaCallout>
          ) : null}
          {mapSaveError ? (
            <CocoaCallout tone="danger" title="No se pudo guardar el mapa" role="alert">
              {mapSaveError}
            </CocoaCallout>
          ) : null}
          {previewError ? (
            <CocoaCallout tone="danger" title="No se pudo analizar" role="alert">
              {previewError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaSection>
    );
  }

  function renderAnalyticsStep() {
    if (!preview) return renderFileStep();
    return (
      <CocoaSection
        title={stepTitle(steps, "analytics")}
        meta={`${plural(preview.unmappedAnalytics.length, "código pendiente", "códigos pendientes")} · ${plural(preview.centreRequired.length, "asiento sin centro", "asientos sin centro")}`}
        action={
          canMap ? (
            <CocoaButton variant="plain" tone="accent" size="small" loading={savingMap === "analytics"} disabled={savingMap !== null || previewing || importing} onClick={() => void saveAnalyticsMap()}>
              Guardar mapa analítico
            </CocoaButton>
          ) : undefined
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <p className="cocoa-note">Sage imputa hasta cinco dimensiones por apunte. Indica cuál identifica el hotel u oficina y cuál el departamento USALI; cada código se asigna a un centro de trabajo o a un centro de coste. Los asientos con gastos o ingresos en varios centros se parten en un asiento por centro.</p>
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Dimensión del centro de trabajo">
              <CocoaSelect size="small" inline aria-label="Dimensión de Sage que identifica el centro de trabajo" value={centreDimension} onChange={(value) => setCentreDimension(isAnalyticsDimension(value) ? value : DEFAULT_CENTRE_DIMENSION)} options={DIMENSION_OPTIONS} disabled={previewing || importing || savingMap !== null} />
            </CocoaField>
            <CocoaField label="Dimensión del centro de coste">
              <CocoaSelect size="small" inline aria-label="Dimensión de Sage que identifica el centro de coste USALI" value={costCentreDimension ?? ""} onChange={(value) => setCostCentreDimension(isAnalyticsDimension(value) ? value : null)} options={COST_CENTRE_DIMENSION_OPTIONS} disabled={previewing || importing || savingMap !== null} />
            </CocoaField>
            <CocoaField label="Apuntes de gasto o ingreso sin analítica">
              <CocoaSelect size="small" inline aria-label="Política para los apuntes de gasto o ingreso sin analítica" value={unassignedPolicy} onChange={(value) => setUnassignedPolicy(isUnassignedPolicy(value) ? value : DEFAULT_UNASSIGNED_POLICY)} options={policyOptions} disabled={previewing || importing || savingMap !== null} />
            </CocoaField>
          </div>
          <CocoaTable
            columns={analyticsColumns}
            rows={analyticsRows}
            rowKey="key"
            density="compact"
            virtualize
            maxHeight={TABLE_MAX_HEIGHT}
            rowTone={(row) => (row.pending && !(row.dimension === centreDimension ? row.dto.propertyId : row.dto.costCentreCode) ? "warning" : undefined)}
            emptyState="El fichero no trae códigos analíticos de las dimensiones elegidas."
            caption="Mapa analítico Sage → centros"
            aria-label="Mapa de códigos analíticos de Sage 200 a centros de trabajo y de coste"
          />
          {preview.centreRequired.length > 0 ? (
            <CocoaCallout tone={unassignedPolicy === "block" ? "warning" : "neutral"} title={`${plural(preview.centreRequired.length, "asiento con gastos o ingresos sin centro", "asientos con gastos o ingresos sin centro")}`} role="status">
              <div className="cocoa-stack" data-gap="2">
                <span>{unassignedPolicy === "block" ? "Con la política «bloquear» el lote no se contabiliza hasta asignarles centro; elige «oficina central» o un centro para imputarlos." : "Se imputan según la política elegida."}</span>
                <ul className="c22-section__list">
                  {preview.centreRequired.slice(0, 20).map((row) => (
                    <li key={`${row.sourcePeriod}-${row.sourceEntryNumber}`}>
                      <span>{centreRequiredLine(row)}</span>
                    </li>
                  ))}
                  {preview.centreRequired.length > 20 ? (
                    <li>
                      <span>{`y ${number(preview.centreRequired.length - 20)} más`}</span>
                    </li>
                  ) : null}
                </ul>
              </div>
            </CocoaCallout>
          ) : null}
          {mapSaveError ? (
            <CocoaCallout tone="danger" title="No se pudo guardar el mapa" role="alert">
              {mapSaveError}
            </CocoaCallout>
          ) : null}
          {previewError ? (
            <CocoaCallout tone="danger" title="No se pudo analizar" role="alert">
              {previewError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaSection>
    );
  }

  function renderReviewStep() {
    if (!preview) return renderFileStep();
    const monthRows = formatByMonthRows(preview);
    const propertyRows = formatByPropertyRows(preview);
    const vatSettingsWarning = preview.kind === "vat_books" && preview.vatSettingsMissing;
    const hasWarnings = preview.duplicateOf !== null || preview.overlaps.length > 0 || preview.payrollCostImportsPosted.length > 0 || vatSettingsWarning || preview.existingNativeEntries > 0;
    return (
      <div className="cocoa-stack" data-gap="4">
        <CocoaKpiStrip aria-label="Resumen de la revisión">
          {previewKpis(preview).map((kpi) => (
            <CocoaKpi key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} caption={kpi.caption} size="compact" />
          ))}
        </CocoaKpiStrip>

        <CocoaSection title={stepTitle(steps, "review")} meta={`${importKindLabel(preview.kind)} · ${formatLabel(preview.format)} · ${periodRangeLabel(preview.periodFrom, preview.periodTo)}${preview.sourceCompanyCode ? ` · empresa ${preview.sourceCompanyCode}` : ""}`}>
          <div className="cocoa-stack" data-gap="3">
            {previewing ? (
              <CocoaBadge tone="info" size="small">
                Analizando de nuevo…
              </CocoaBadge>
            ) : null}
            <CocoaGrid columns={12} align="start">
              <CocoaSpan cols={6} min={280}>
                <CocoaTable columns={MONTH_COLUMNS} rows={monthRows} rowKey="key" density="compact" emptyState="Sin asientos por mes." caption="Asientos por mes" aria-label="Asientos, apuntes, Debe y Haber por mes" />
              </CocoaSpan>
              <CocoaSpan cols={6} min={280}>
                <CocoaTable columns={propertyColumns} rows={propertyRows} rowKey="key" density="compact" emptyState="Sin asientos por centro." caption="Asientos por centro" aria-label="Asientos, Debe y Haber por centro de trabajo" />
              </CocoaSpan>
            </CocoaGrid>
            {preview.closingDetected.length > 0 ? (
              <CocoaCallout tone="info" title="Apertura y cierres de Sage detectados" role="status">
                <ul className="c22-section__list">
                  {preview.closingDetected.map((row) => (
                    <li key={`${row.sourcePeriod}-${row.sourceEntryNumber}`}>
                      <span>{closingDetectedLine(row)}</span>
                    </li>
                  ))}
                </ul>
              </CocoaCallout>
            ) : null}
          </div>
        </CocoaSection>

        {preview.nativeSkipped.length > 0 ? (
          <CocoaSection title="Documentos propios excluidos" meta={plural(preview.nativeSkipped.length, "asiento de Sage", "asientos de Sage")}>
            <div className="cocoa-stack" data-gap="2">
              <p className="cocoa-note">Facturas emitidas por {BRAND.name} (y sus cobros) que Sage también registró: se omiten del lote para no contabilizarlas dos veces; el asiento propio se conserva.</p>
              <ul className="c22-section__list">
                {preview.nativeSkipped.slice(0, 50).map((row) => (
                  <li key={`${row.sourcePeriod}-${row.sourceEntryNumber}`}>
                    <span>{nativeSkippedLine(row)}</span>
                  </li>
                ))}
                {preview.nativeSkipped.length > 50 ? (
                  <li>
                    <span>{`y ${number(preview.nativeSkipped.length - 50)} más`}</span>
                  </li>
                ) : null}
              </ul>
            </div>
          </CocoaSection>
        ) : null}

        {preview.existing.length > 0 ? (
          <CocoaCallout tone="neutral" title={`${plural(preview.existing.length, "asiento ya importado", "asientos ya importados")} por un lote anterior (se omiten)`} role="status">
            <ul className="c22-section__list">
              {preview.existing.slice(0, 20).map((row) => (
                <li key={`${row.sourcePeriod}-${row.sourceEntryNumber}`}>
                  <span>{existingLine(row)}</span>
                </li>
              ))}
              {preview.existing.length > 20 ? (
                <li>
                  <span>{`y ${number(preview.existing.length - 20)} más`}</span>
                </li>
              ) : null}
            </ul>
          </CocoaCallout>
        ) : null}

        {preview.unbalanced.length > 0 ? (
          <CocoaCallout tone="danger" title={plural(preview.unbalanced.length, "asiento de Sage descuadrado", "asientos de Sage descuadrados")} role="status">
            <ul className="c22-section__list">
              {preview.unbalanced.slice(0, 20).map((row) => (
                <li key={`${row.sourcePeriod}-${row.sourceEntryNumber}`}>
                  <span>{unbalancedLine(row)}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}

        {hasWarnings ? (
          <CocoaCallout tone="warning" title="Antes de contabilizar" role="status">
            <div className="cocoa-stack" data-gap="2">
              {preview.duplicateOf ? (
                <span>
                  Este fichero ya se importó: lote {preview.duplicateOf.fileName ?? preview.duplicateOf.importId} ({importStatusLabel(preview.duplicateOf.status)}, {dateTime(preview.duplicateOf.createdAt)}). Revierte el lote anterior o sustitúyelo.
                </span>
              ) : null}
              {preview.overlaps.length > 0 ? (
                <span>
                  {plural(preview.overlaps.length, "lote anterior ya cubre", "lotes anteriores ya cubren")} asientos de este fichero ({preview.overlaps.map((overlap) => `${periodRangeLabel(overlap.periodFrom, overlap.periodTo)}: ${plural(overlap.entries, "asiento", "asientos")}`).join("; ")}). Con «Sustituir» se revierten enteros y se crea el lote nuevo en la misma transacción.
                </span>
              ) : null}
              {preview.payrollCostImportsPosted.length > 0 ? (
                <span>
                  {plural(preview.payrollCostImportsPosted.length, "lote de coste de personal contabilizado", "lotes de coste de personal contabilizados")} en el rango ({preview.payrollCostImportsPosted.map((row) => periodRangeLabel(row.periodFrom, row.periodTo)).join("; ")}): si Sage trae la nómina real, revierte antes ese lote o bloquea 640 / 642 / 465 / 476 en el mapa.
                </span>
              ) : null}
              {vatSettingsWarning ? <span>La organización no tiene configuración de IVA (periodicidad y régimen): los libros importados esperan a esa decisión en Ajustes contables.</span> : null}
              {preview.existingNativeEntries > 0 ? <span>El ejercicio ya tiene {plural(preview.existingNativeEntries, "asiento propio", "asientos propios")}: la numeración de {BRAND.name} quedará intercalada; el número de Sage se conserva en la referencia de cada asiento.</span> : null}
              {preview.duplicateOf || preview.overlaps.length > 0 ? <CocoaSwitch checked={replace} onChange={changeReplace} label="Sustituir los lotes anteriores (reverso + lote nuevo)" size="small" disabled={previewing || importing} /> : null}
            </div>
          </CocoaCallout>
        ) : null}

        <CocoaSection title="Opciones del lote">
          <div className="cocoa-stack" data-gap="3">
            {kind === "journal" ? (
              <div className="cocoa-stack" data-gap="1">
                <div className="cocoa-row">
                  <CocoaFileInput accept=".xlsx,.csv,.txt,.json" maxBytes={20 * 1024 * 1024} fileName={balanceFile?.name ?? null} onPick={(picked) => void pickBalance(picked, "review")} onReject={setBalanceError} disabled={previewing || importing} label="Balance de sumas y saldos de Sage del mismo periodo" />
                  {balanceFile ? (
                    <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setBalanceFile(null)} disabled={previewing || importing}>
                      Quitar balance
                    </CocoaButton>
                  ) : null}
                </div>
                <span className="cocoa-caption">Opcional: al contabilizar se reconcilia el mismo rango (Sage nivel 0 frente al diario, por cuenta y periodo) y el resultado se muestra en «Resultado». Centro comparado: el del selector de ámbito ({finance.scope.label}).</span>
                {balanceError ? (
                  <CocoaCallout tone="danger" title="No se pudo leer el balance" role="alert">
                    {balanceError}
                  </CocoaCallout>
                ) : null}
              </div>
            ) : null}
            <CocoaField label="Notas del lote" hint="opcional">
              <CocoaInput value={notes} onChange={setNotes} multiline rows={2} maxLength={NOTES_MAX} placeholder="Diario de septiembre exportado el día 3" disabled={importing} />
            </CocoaField>
          </div>
        </CocoaSection>

        {preview.warnings.length > 0 ? (
          <CocoaCallout tone="warning" title="Avisos del fichero" role="status">
            <ul className="c22-section__list">
              {preview.warnings.map((warning, index) => (
                <li key={index}>
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}

        {blockers.length > 0 ? (
          <CocoaCallout tone="danger" title="Todavía no se puede contabilizar" role="status">
            <ul className="c22-section__list">
              {blockers.map((blocker) => (
                <li key={blocker}>
                  <span>{blocker}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}

        {previewError ? (
          <CocoaCallout tone="danger" title="No se pudo analizar" role="alert">
            {previewError}
          </CocoaCallout>
        ) : null}
        {importError ? (
          <CocoaCallout tone="danger" title="No se pudo contabilizar" role="alert">
            {importError}
          </CocoaCallout>
        ) : null}
      </div>
    );
  }

  function renderResultStep() {
    if (!result) return renderFileStep();
    const record = result.created.import;
    const created = result.created.entries.filter((entry) => entry.status === "posted");
    const skipped = result.created.entries.filter((entry) => entry.status === "skipped_native" || entry.status === "skipped_existing");
    const failed = result.created.entries.filter((entry) => entry.status === "unmapped" || entry.status === "unbalanced" || entry.status === "error");
    const reconciliation = result.reconciliation;
    return (
      <div className="cocoa-stack" data-gap="4">
        <CocoaCallout tone={resultTone(record)} title={resultTitle(record, result.created.created)} role="status">
          <div className="cocoa-stack" data-gap="2">
            <span>
              Lote {importFileLabel(record)} · {dateTime(record.createdAt)} · {periodRangeLabel(record.periodFrom, record.periodTo)} · {money(record.totalDebit)} de Debe
              {result.mode === "viewed" ? " · consulta de un lote anterior" : ""}
            </span>
            {record.reversedAt ? (
              <span>
                Revertido el {dateTime(record.reversedAt)}
                {record.reversalReason ? ` · motivo: ${record.reversalReason}` : ""}
              </span>
            ) : null}
            {result.created.warnings.length > 0 ? (
              <ul className="c22-section__list">
                {result.created.warnings.map((warning, index) => (
                  <li key={index}>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CocoaCallout>

        <CocoaSection title={stepTitle(steps, "result")} meta={`${plural(created.length, "creado", "creados")} · ${plural(skipped.length, "omitido", "omitidos")} · ${plural(failed.length, "con error", "con error")}`}>
          <div className="cocoa-stack" data-gap="3">
            {created.length > 0 ? (
              <ul className="c22-section__list" aria-label="Asientos creados">
                {created.slice(0, 12).map((entry) => (
                  <li key={entry.id}>
                    <span>{entryLine(entry)}</span>
                  </li>
                ))}
                {created.length > 12 ? (
                  <li>
                    <span>{`y ${number(created.length - 12)} más en la tabla`}</span>
                  </li>
                ) : null}
              </ul>
            ) : null}
            <CocoaTable
              columns={ENTRY_COLUMNS}
              rows={result.created.entries}
              rowKey="id"
              density="compact"
              virtualize
              maxHeight={TABLE_MAX_HEIGHT}
              rowTone={(row) => (row.status === "unmapped" || row.status === "unbalanced" || row.status === "error" ? "danger" : row.status === "skipped_native" || row.status === "skipped_existing" ? "neutral" : undefined)}
              rowTitle={(row) => (row.warnings.length > 0 ? row.warnings.join("\n") : row.sourceType && row.sourceId ? `Coincide con ${row.sourceType} ${row.sourceId}` : undefined)}
              emptyState="Este lote no tiene asientos registrados."
              caption="Resultado por asiento"
              aria-label="Resultado por asiento del lote"
            />
          </div>
        </CocoaSection>

        {reconciliation ? (
          <CocoaSection title="Reconciliación del lote" meta={reconciliationSummary(reconciliation.rows)} action={<CocoaBadge tone={reconciliationStatusTone(reconciliation.status)}>{reconciliationStatusLabel(reconciliation.status)}</CocoaBadge>}>
            <div className="cocoa-stack" data-gap="3">
              <CocoaKpiStrip aria-label="Resumen de la reconciliación del lote">
                {reconciliationKpis(reconciliation).map((kpi) => (
                  <CocoaKpi key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} caption={kpi.caption} size="compact" />
                ))}
              </CocoaKpiStrip>
              <CocoaTable columns={reconColumns(reconciliation)} rows={reconciliation.rows} rowKey="accountCode" density="compact" virtualize maxHeight={TABLE_MAX_HEIGHT} rowTone={reconciliationRowTone} emptyState="Sin cuentas comparadas." caption="Reconciliación por cuenta" aria-label="Reconciliación por cuenta del lote" />
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="small"
                onClick={() => {
                  setRecon(reconciliation);
                  setView("reconciliacion");
                }}
              >
                Ver en Reconciliación
              </CocoaButton>
            </div>
          </CocoaSection>
        ) : null}
      </div>
    );
  }

  function renderStep() {
    switch (current?.key) {
      case "accounts":
        return renderAccountsStep();
      case "analytics":
        return renderAnalyticsStep();
      case "review":
        return renderReviewStep();
      case "result":
        return renderResultStep();
      default:
        return renderFileStep();
    }
  }

  // ---- action bar per step ----
  const nextKey = steps[stepIndex + 1]?.key;
  const previousKey = steps[stepIndex - 1]?.key;
  const primary =
    current?.key === "file"
      ? { label: ACTIONS.next, disabled: preview === null || previewing, onClick: () => setStepKey(nextKey ?? "review") }
      : current?.key === "accounts"
        ? { label: "Aplicar y continuar", disabled: previewing || importing || accountIssues > 0, loading: previewing, onClick: () => void applyAccounts() }
        : current?.key === "analytics"
          ? { label: "Aplicar y continuar", disabled: previewing || importing, loading: previewing, onClick: () => void applyAnalytics() }
          : current?.key === "review"
            ? { label: importing ? (kind === "journal" || kind === "fiscal_years" || kind === "balances" ? "Contabilizando…" : "Importando…") : postActionLabel(kind, preview?.entryCount ?? 0), disabled: postDisabled || previewStale, loading: importing, onClick: () => void runImport(), title: previewStale ? "No se puede contabilizar: el último análisis falló; cambia una opción o vuelve al paso anterior para analizar de nuevo." : blockers.length > 0 ? `No se puede contabilizar: ${blockers.join("; ")}.` : !canImport ? "Contabilizar exige el permiso de contabilizar asientos." : undefined }
            : { label: "Descargar informe CSV", icon: <DownloadIcon size={14} aria-hidden="true" />, disabled: !result || result.created.entries.length === 0, onClick: downloadReport };
  const secondary =
    current?.key === "result"
      ? { label: "Nueva importación", onClick: resetAll }
      : current && current.key !== "file"
        ? { label: ACTIONS.previous, onClick: () => setStepKey(previousKey ?? "file"), disabled: previewing || importing }
        : undefined;

  // ---- views ----
  function renderImportView() {
    return (
      <>
        <CocoaGrid columns={12} align="start">
          <CocoaSpan cols={4} min={240}>
            <CocoaSection title="Pasos" meta={`${number(stepIndex + 1)} / ${number(steps.length)}`}>
              <div className="cocoa-stack" data-gap="3">
                <CocoaChart.Progress value={((stepIndex + 1) / steps.length) * 100} label={current?.label ?? ""} showValue={false} aria-label={summary} />
                <ol className="c22-section__list" aria-label="Pasos del asistente">
                  {steps.map((item, index) => (
                    <li key={item.key}>
                      <CocoaButton variant="plain" tone={index === stepIndex ? "accent" : "neutral"} size="small" wrap fullWidth align="start" aria-current={index === stepIndex ? "step" : undefined} disabled={!reachable(item.key)} onClick={() => setStepKey(item.key)}>
                        {number(index + 1)}. {item.label}
                      </CocoaButton>
                      <CocoaBadge tone={stepTone(index, stepIndex)} variant="dot" size="small">
                        {stepStateLabel(index, stepIndex)}
                      </CocoaBadge>
                    </li>
                  ))}
                </ol>
                <p className="cocoa-caption">{current?.description}</p>
              </div>
            </CocoaSection>
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            <div className="cocoa-stack" data-gap="4" ref={stepContentRef} tabIndex={-1} role="region" aria-label={`Paso ${number(stepIndex + 1)}: ${current?.label ?? ""}`}>
              {renderStep()}
            </div>
          </CocoaSpan>
        </CocoaGrid>

        <CocoaActionBar aria-label="Navegación del asistente de importación desde Sage 200" status={summary} secondary={secondary} primary={primary} />
      </>
    );
  }

  function renderReconciliationView() {
    return (
      <div className="cocoa-stack" data-gap="4">
        <CocoaSection title="Reconciliar con el balance de Sage" meta={`Centro comparado: ${finance.scope.label}`}>
          <div className="cocoa-stack" data-gap="3">
            <p className="cocoa-note">Exporta en Sage el Sumas y saldos del rango (nivel 0, Debe / Haber / Saldo; con «Hoja adicional canales/delegaciones» si comparas un centro). Cada cuenta de Sage pasa por el mapa de cuentas y se compara con el diario de {BRAND.name} por cuenta destino: Debe y Haber del rango y saldo a la fecha final en los grupos 1 a 5. El centro comparado es el del selector de ámbito de la cabecera; con «toda la sociedad» se compara el consolidado.</p>
            <div className="cocoa-row" data-gap="2" data-align="end">
              <CocoaField label="Desde">
                <CocoaInput type="date" size="small" value={reconFrom} onChange={setReconFrom} aria-label="Fecha desde de la reconciliación" disabled={reconciling} />
              </CocoaField>
              <CocoaField label="Hasta">
                <CocoaInput type="date" size="small" value={reconTo} onChange={setReconTo} aria-label="Fecha hasta de la reconciliación" disabled={reconciling} />
              </CocoaField>
              <CocoaFileInput accept=".xlsx,.csv,.txt,.json" maxBytes={20 * 1024 * 1024} fileName={reconFile?.name ?? null} onPick={(picked) => void pickBalance(picked, "recon")} onReject={setReconFileError} disabled={reconciling || !canRead} label="Balance de sumas y saldos de Sage" />
              <CocoaButton variant="filled" tone="accent" size="small" loading={reconciling} disabled={!reconReady || reconciling || !canImport} onClick={() => void runReconciliation()} title={reconBlockedReason}>
                Reconciliar
              </CocoaButton>
            </div>
            {reconRangeInverted ? (
              <CocoaCallout tone="warning" title="Rango de fechas invertido" role="status">
                «Desde» ({date(reconFrom)}) es posterior a «Hasta» ({date(reconTo)}): corrige las fechas para reconciliar.
              </CocoaCallout>
            ) : null}
            {reconFileError ? (
              <CocoaCallout tone="danger" title="No se pudo leer el balance" role="alert">
                {reconFileError}
              </CocoaCallout>
            ) : null}
            {reconError ? (
              <CocoaCallout tone="danger" title="No se pudo reconciliar" role="alert">
                {reconError}
              </CocoaCallout>
            ) : null}
          </div>
        </CocoaSection>

        {recon ? (
          <>
            <CocoaKpiStrip aria-label="Resumen de la reconciliación">
              {reconciliationKpis(recon).map((kpi) => (
                <CocoaKpi key={kpi.key} label={kpi.label} value={kpi.value} tone={kpi.tone} caption={kpi.caption} size="compact" />
              ))}
            </CocoaKpiStrip>
            <CocoaSection
              title={`Reconciliación ${dateRange(recon.periodFrom, recon.periodTo)} · ${recon.propertyId ? centreNameFor(finance.structure, recon.propertyId, recon.propertyCode) : "consolidado"}`}
              meta={reconciliationSummary(recon.rows)}
              action={
                <div className="cocoa-row" data-gap="2">
                  <CocoaBadge tone={reconciliationStatusTone(recon.status)}>{reconciliationStatusLabel(recon.status)}</CocoaBadge>
                  <CocoaButton variant="plain" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} onClick={downloadCurrentReconciliation}>
                    Descargar CSV
                  </CocoaButton>
                </div>
              }
            >
              <div className="cocoa-stack" data-gap="3">
                <p className="cocoa-caption">{recon.summary.criterion}</p>
                <CocoaTable columns={reconColumns(recon)} rows={recon.rows} rowKey="accountCode" density="compact" virtualize maxHeight={TABLE_MAX_HEIGHT} rowTone={reconciliationRowTone} rowTitle={(row) => row.note} emptyState="Sin cuentas comparadas." caption="Reconciliación por cuenta y periodo" aria-label="Reconciliación por cuenta y periodo" />
                {recon.missingEntries.length > 0 ? (
                  <CocoaCallout tone="warning" title={`${plural(recon.missingEntries.length, "asiento de Sage que no llegó al diario", "asientos de Sage que no llegaron al diario")}`} role="status">
                    <ul className="c22-section__list">
                      {recon.missingEntries.slice(0, 20).map((row) => (
                        <li key={`${row.sourcePeriod}-${row.sourceEntryNumber}`}>
                          <span>{`Asiento ${row.sourceEntryNumber} (periodo ${row.sourcePeriod}) · ${entryStatusLabel(row.status)}`}</span>
                        </li>
                      ))}
                      {recon.missingEntries.length > 20 ? (
                        <li>
                          <span>{`y ${number(recon.missingEntries.length - 20)} más`}</span>
                        </li>
                      ) : null}
                    </ul>
                  </CocoaCallout>
                ) : null}
              </div>
            </CocoaSection>
          </>
        ) : null}

        <CocoaSection
          title="Reconciliaciones anteriores"
          meta={reconRows.length > 0 ? plural(reconRows.length, "reconciliación", "reconciliaciones") : undefined}
          action={
            <CocoaButton variant="plain" tone="neutral" size="small" loading={reconciliations.loading} onClick={reconciliations.refresh}>
              {ACTIONS.refresh}
            </CocoaButton>
          }
        >
          {reconciliations.error ? (
            <CocoaCallout tone="danger" title="No se pudieron cargar las reconciliaciones" role="alert">
              {reconciliations.error}
            </CocoaCallout>
          ) : (
            <CocoaTable
              columns={reconHistoryColumns}
              rows={reconRows}
              rowKey="id"
              density="compact"
              loading={reconciliations.loading && reconRows.length === 0}
              selectedKey={recon?.id}
              emptyState="Todavía no hay reconciliaciones con este ámbito."
              rowActionsVisible="always"
              rowActions={(row) => (
                <>
                  <CocoaButton variant="plain" tone="neutral" size="small" loading={reconViewing === row.id} onClick={() => void viewReconciliation(row)}>
                    {ACTIONS.view}
                  </CocoaButton>
                  <CocoaButton variant="plain" tone="neutral" size="small" loading={reconDownloading === row.id} onClick={() => void downloadReconciliation(row)}>
                    {ACTIONS.download}
                  </CocoaButton>
                </>
              )}
              caption="Reconciliaciones anteriores"
              aria-label="Reconciliaciones anteriores"
            />
          )}
        </CocoaSection>
      </div>
    );
  }

  function renderLotsView() {
    return (
      <CocoaSection
        title="Lotes importados"
        meta={lotRows.length > 0 ? plural(lotRows.length, "lote", "lotes") : undefined}
        action={
          <div className="cocoa-row" data-gap="2">
            <CocoaSelect size="small" inline aria-label="Filtrar lotes por tipo" value={lotKind} onChange={setLotKind} options={LOT_KIND_OPTIONS} />
            <CocoaSelect size="small" inline aria-label="Filtrar lotes por estado" value={lotStatus} onChange={setLotStatus} options={[...LOT_STATUS_FILTER_OPTIONS]} />
            <CocoaButton variant="plain" tone="neutral" size="small" loading={lots.loading} onClick={lots.refresh}>
              {ACTIONS.refresh}
            </CocoaButton>
          </div>
        }
      >
        {lots.error ? (
          <CocoaCallout tone="danger" title="No se pudieron cargar los lotes" role="alert">
            {lots.error}
          </CocoaCallout>
        ) : (
          <CocoaTable
            columns={lotTable}
            rows={lotRows}
            rowKey="id"
            density="compact"
            loading={lots.loading && lotRows.length === 0}
            emptyState="Todavía no hay lotes importados desde Sage 200."
            rowActionsVisible="always"
            rowActions={(row) => (
              <>
                <CocoaButton variant="plain" tone="neutral" size="small" loading={lotViewing === row.id} onClick={() => void viewLot(row)}>
                  {ACTIONS.view}
                </CocoaButton>
                {canPostImport(row) ? (
                  <CocoaButton variant="plain" tone="accent" size="small" disabled={!canImport || lotPosting !== null} loading={lotPosting === row.id} onClick={() => void postLot(row)}>
                    Contabilizar
                  </CocoaButton>
                ) : null}
                {canReverseImport(row) ? (
                  <CocoaButton variant="plain" tone="destructive" size="small" disabled={!canReverse} onClick={() => openReverse(row)} title={!canReverse ? "Revertir exige los permisos de contabilizar asientos y de confirmar acciones de alto riesgo." : undefined}>
                    Revertir
                  </CocoaButton>
                ) : null}
              </>
            )}
            caption="Lotes importados desde Sage 200"
            aria-label="Lotes importados desde Sage 200"
          />
        )}
      </CocoaSection>
    );
  }

  function renderThirdPartiesView() {
    const rows = tpPage?.rows ?? [];
    const filtered = tpQuery.trim() !== "" || tpRole !== "";
    return (
      <div className="cocoa-stack" data-gap="4">
        <CocoaFormRow columns={2} aria-label="Filtros del directorio de terceros">
          <CocoaField label="Buscar" help="Código Sage, NIF, cuenta Sage (empieza por) o nombre.">
            <CocoaInput value={tpQuery} onChange={setTpQuery} placeholder="Código, NIF, cuenta o nombre" inputMode="search" maxLength={THIRD_PARTY_QUERY_MAX} aria-label="Buscar terceros por código, NIF, cuenta o nombre" />
          </CocoaField>
          <CocoaField label="Rol">
            <CocoaSelect value={tpRole} onChange={(value) => setTpRole(isThirdPartyRole(value) ? value : "")} options={[...THIRD_PARTY_ROLE_FILTER_OPTIONS]} aria-label="Filtrar terceros por rol" />
          </CocoaField>
        </CocoaFormRow>
        <CocoaSection
          title="Terceros importados"
          padding="none"
          meta={tpPage ? plural(tpPage.total, "tercero", "terceros") : undefined}
          action={
            <CocoaButton variant="plain" tone="neutral" size="small" loading={tpLoading} onClick={() => setTpNonce((n) => n + 1)}>
              {ACTIONS.refresh}
            </CocoaButton>
          }
          footer={
            tpPage?.nextCursor ? (
              <div className="cocoa-row" data-gap="2">
                <CocoaButton variant="bordered" tone="neutral" size="small" loading={tpLoadingMore} disabled={tpLoading} onClick={() => void loadMoreThirdParties()}>
                  Cargar más
                </CocoaButton>
                <span className="cocoa-caption">{`Se muestran ${number(rows.length)} de ${number(tpPage.total)}.`}</span>
              </div>
            ) : undefined
          }
        >
          {tpError ? (
            <CocoaState kind="error" title="No se pudieron cargar los terceros" message={tpError} onRetry={() => setTpNonce((n) => n + 1)} inline />
          ) : tpPage === null || (tpLoading && rows.length === 0) ? (
            <CocoaState kind="loading" title="Cargando los terceros importados…" inline />
          ) : rows.length === 0 ? (
            <CocoaState kind="empty" title="Sin terceros" message={thirdPartyEmptyMessage(filtered)} inline />
          ) : (
            <CocoaTable columns={THIRD_PARTY_COLUMNS} rows={rows} rowKey="id" density="compact" virtualize maxHeight={TABLE_MAX_HEIGHT} caption="Terceros importados desde Sage 200" aria-label="Terceros importados desde Sage 200" />
          )}
        </CocoaSection>
      </div>
    );
  }

  const lotRecord = lotDetail?.import ?? null;

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle={`Trae el plan, los ejercicios, el diario, los libros de IVA, los terceros y los saldos de Sage 200 a ${BRAND.name} con un mapa de cuentas y otro analítico; reconcilia con el balance de Sage y revierte lotes enteros.`}
      actions={<FinanceScopeSelector scope={finance} />}
      commands={[
        { id: "sage200-import-new", label: "Nueva importación desde Sage 200", run: resetAll },
        { id: "sage200-import-template", label: "Descargar plantilla canónica de Sage 200", run: () => void downloadTemplate() },
        { id: "sage200-import-lots", label: "Ver los lotes importados desde Sage 200", run: () => setView("lotes") }
      ]}
      id="sage200-import-screen"
    >
      <CocoaLiveRegion message={liveMessage} announceKey={`${view}-${stepKey}-${previewing ? "p" : ""}-${importing ? "i" : ""}-${reconciling ? "r" : ""}`} />
      {!canRead ? <p className="cocoa-note">Necesitas el permiso de lectura de informes contables para consultar los lotes, los mapas y las reconciliaciones.</p> : null}
      {canRead && !canImport ? (
        <p className="cocoa-note">
          Necesitas el permiso de contabilizar asientos para analizar y contabilizar un lote o lanzar una reconciliación{canMap ? " (guardar los mapas solo exige el de configuración contable, que sí tienes)" : "; guardar los mapas exige el de configuración contable"}: puedes consultar los lotes, los mapas y las reconciliaciones anteriores.
        </p>
      ) : null}
      <CocoaSegmentedControl aria-label="Vista de la importación desde Sage 200" value={view} onChange={(value) => setView(isImportView(value) ? value : "importar")} options={VIEW_OPTIONS} panelId="sage200-import-panel" />
      <div id="sage200-import-panel" role="tabpanel" aria-label={viewLabel} className="cocoa-stack" data-gap="4">
        {view === "importar" ? renderImportView() : view === "reconciliacion" ? renderReconciliationView() : view === "lotes" ? renderLotsView() : renderThirdPartiesView()}
      </div>

      <CocoaDrawer open={lotDetail !== null} onClose={() => setLotDetail(null)} title={lotRecord ? `Lote ${importFileLabel(lotRecord)}` : "Lote"} subtitle={lotRecord ? `${importKindLabel(lotRecord.kind)} · ${periodRangeLabel(lotRecord.periodFrom, lotRecord.periodTo)} · ${importStatusLabel(lotRecord.status)} · ${importAuthorLabel(lotRecord.createdBy, session)}` : undefined} side="right" size="lg">
        {lotDetail && lotRecord ? (
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-row">
              <CocoaStat label={entryNoun(lotRecord.kind).plural.replace(/^./, (first) => first.toUpperCase())} value={number(lotRecord.entryCount)} hint={`${plural(lotRecord.skippedCount, "omitido", "omitidos")} · ${plural(lotRecord.warningCount, "aviso", "avisos")}`} />
              <CocoaStat label="Debe" value={money(lotRecord.totalDebit)} />
              <CocoaStat label="Haber" value={money(lotRecord.totalCredit)} />
              <CocoaStat label="Creado" value={dateTime(lotRecord.createdAt)} hint={lotRecord.postedAt ? `contabilizado ${dateTime(lotRecord.postedAt)}` : undefined} tabular={false} />
            </div>
            {lotRecord.reversedAt ? (
              <CocoaCallout tone="neutral" title={`Revertido el ${dateTime(lotRecord.reversedAt)}`}>
                {lotRecord.reversalReason ?? EMPTY}
              </CocoaCallout>
            ) : null}
            {lotRecord.notes ? <p className="cocoa-note">{lotRecord.notes}</p> : null}
            <CocoaTable columns={ENTRY_COLUMNS} rows={lotDetail.entries} rowKey="id" density="compact" virtualize maxHeight={TABLE_MAX_HEIGHT} rowTone={(row) => (row.status === "unmapped" || row.status === "unbalanced" || row.status === "error" ? "danger" : undefined)} emptyState="Este lote no tiene asientos registrados." caption="Asientos del lote" aria-label="Asientos del lote" />
            {lotDetail.entryTotal > lotDetail.entries.length ? <p className="cocoa-caption">{`Se muestran ${number(lotDetail.entries.length)} de ${number(lotDetail.entryTotal)} asientos.`}</p> : null}
            {lotDetail.balances && lotDetail.balances.length > 0 ? <p className="cocoa-caption">{`${plural(lotDetail.balances.length, "fila de saldos", "filas de saldos")} conservadas para la reconciliación (${periodLabel(lotDetail.balances[0]?.periodCode)}${lotDetail.balances.length > 1 ? ` – ${periodLabel(lotDetail.balances[lotDetail.balances.length - 1]?.periodCode)}` : ""}).`}</p> : null}
            <div className="cocoa-row">
              <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} onClick={() => saveDownload({ blob: new Blob([buildImportReportCsv(lotDetail.entries)], { type: "text/csv;charset=utf-8" }), filename: reportFileName(lotRecord), contentType: "text/csv" })}>
                Descargar informe CSV
              </CocoaButton>
              {canPostImport(lotRecord) ? (
                <CocoaButton variant="filled" tone="accent" size="small" disabled={!canImport || lotPosting !== null} loading={lotPosting === lotRecord.id} onClick={() => void postLot(lotRecord)}>
                  Contabilizar
                </CocoaButton>
              ) : null}
              {canReverseImport(lotRecord) ? (
                <CocoaButton variant="bordered" tone="destructive" size="small" disabled={!canReverse} onClick={() => openReverse(lotRecord)}>
                  Revertir
                </CocoaButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={reverseTarget !== null}
        onClose={() => {
          if (!reversing) setReverseTarget(null);
        }}
        tone="destructive"
        title={reverseTarget ? `Revertir el lote ${importFileLabel(reverseTarget)}` : "Revertir lote"}
        description={reverseTarget ? (reverseTarget.kind === "journal" || reverseTarget.kind === "fiscal_years" || reverseTarget.kind === "balances" ? `Se crea un asiento de anulación por cada uno de los ${plural(reverseTarget.entryCount, "asiento", "asientos")} del lote (nunca se borran). Los saldos importados se conservan como histórico. La operación es de alto riesgo y queda auditada con el motivo.` : reverseTarget.kind === "vat_books" ? `Se retiran del libro de IVA las ${entryCountLabel(reverseTarget.kind, reverseTarget.entryCount)} que este lote escribió (las que otro lote posterior volvió a escribir se conservan). La operación es de alto riesgo y queda auditada con el motivo.` : `El lote de ${importKindLabel(reverseTarget.kind).toLowerCase()} queda revertido en el historial; las ${entryCountLabel(reverseTarget.kind, reverseTarget.entryCount)} y el mapa que dio de alta se conservan (nunca se borran cuentas ni terceros). La operación queda auditada con el motivo.`) : undefined}
        confirmLabel="Revertir lote"
        cancelLabel={ACTIONS.cancel}
        busy={reversing}
        confirmDisabled={!isReversalReasonValid(reverseReason)}
        onConfirm={() => void confirmReverse()}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" required help={`Entre ${number(REVERSAL_REASON_MIN)} y ${number(REVERSAL_REASON_MAX)} caracteres; queda en el lote y en cada asiento de anulación.`}>
            <CocoaInput value={reverseReason} onChange={setReverseReason} multiline rows={3} maxLength={REVERSAL_REASON_MAX} placeholder="Diario de septiembre reexportado con la analítica corregida" disabled={reversing} />
          </CocoaField>
          {reverseError ? (
            <CocoaCallout tone="danger" title="No se pudo revertir" role="alert">
              {reverseError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default Sage200ImportScreen;
