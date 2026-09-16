// Nóminas — Finanzas › Nóminas (/finanzas/nominas, standalone).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «DashboardStandalone»): KPI strip and
// three inner views (Contratos · Periodos · Recibos) selected with the page
// tabs. Contracts and periods are created from drawers; every action that
// writes in the ledger asks first: «Calcular» posts the accrual entries (a
// recalculation reverses the earlier ones before posting again), «Exportar»
// is the audited POST that marks the period as exported (the file is built
// client-side from the answer and flagged «validar con la gestoría» when the
// layout is only compatible), «Pagar» posts D 465 / H 572 (or the bank
// sub-account given). The API answers 400 in Spanish naming the rejected key
// (strict bodies; contractType has six modalities) and 409 with details.code
// (PAYROLL_PERIOD_NOT_CALCULATED · PAYROLL_PERIOD_PAID · PAYROLL_NOTHING_TO_PAY),
// mapped by payrollErrorMessage.
// Data: GET /payroll/contracts · /payroll/periods · /payroll/periods/:id/slips
// (payroll.read); writes through services/payrollApi.ts (payroll.manage).
//
// Tanda 6c (design docs/design/FINANZAS-COSTE-PERSONAL.md §8): a fourth view
// «Coste de personal» (`view "cost"`) reads GET /payroll/cost-report for the
// month range and group chosen (the centre comes from the «Ámbito», no centre
// = the whole sociedad) and paints the KPI strip, the centres × months matrix
// (Empleados · Coste · Coste por empleado · % s/ ventas; a centre expands into
// its USALI departments with a Set in state — CocoaTable has no expandable
// rows), two CocoaChart.Bars (coste vs ventas) and the list of imported lots
// with «Contabilizar» (draft) and «Revertir» (posted, CocoaDialog destructive
// with a mandatory reason). The import drawer lives in
// PayrollCostImportDrawer.tsx; every figure arrives derived from the API and
// payroll-cost-helpers.ts only formats it. Importar / Contabilizar / Revertir
// are gated on `payroll.manage` through canDo(useNavGate(), …).
// Corrector 6c: the reversal dialog offers «Fecha de la anulación» like
// JournalScreen (FU-06; the API still requires the ORIGINAL month to be open,
// contable-6C-02), the draft «Contabilizar» dialog offers «Sustituir» (FU-12),
// the matrix repeats the centre on every phone card and hides the middle
// months there (FU-05), the range pickers show a loading badge while a new
// range arrives (FU-07), and the KPI captions say what they measure (FU-03,
// FU-11).

import { useId, useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import type { PayrollCostGroup } from "@hotelos/shared";
import { getActiveOrganizationId } from "../../services/activeProperty";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { payrollCostImportListQuery, payrollCostReportQuery } from "../../services/finance-contracts";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canDo } from "../accounting/accounting-ui";
import {
  PAYROLL_CONTRACT_TYPES,
  PAYROLL_CONTRACT_TYPE_LABELS_ES,
  calculatePayrollPeriod,
  createPayrollContract,
  createPayrollPeriod,
  deactivatePayrollContract,
  exportPayrollPeriod,
  payPayrollPeriod,
  payrollErrorMessage,
  postPayrollCostImport,
  reversePayrollCostImport,
  type PayrollContractRecord,
  type PayrollContractType,
  type PayrollCostImportCreateResult,
  type PayrollCostImportRecord,
  type PayrollCostReport,
  type PayrollExportFormat,
  type PayrollExportResult,
  type PayrollPayFrequency,
  type PayrollPeriodRecord,
  type PayrollSlipRecord
} from "../../services/payrollApi";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import { date, dateRange, dateTime, isoDate, money, number, percent, plural, toNumber } from "../../lib/format";
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
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  toneInk,
  useViewportTier,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { PayrollCostImportDrawer } from "./PayrollCostImportDrawer";
import {
  ALL_GROUPS_VALUE,
  PAYROLL_COST_PICKER_MONTHS,
  PAYROLL_COST_SOURCE_LABELS,
  clampCostRange,
  costBars,
  costGroupOptions,
  costMatrixRows,
  defaultCostRange,
  formatHeadcount,
  formatLaborPct,
  importFileLabel,
  importResultTitle,
  importStatusBadge,
  laborPctOf,
  monthLabel,
  monthPickerOptions,
  monthRangeLabel,
  payrollCostErrorMessage,
  reverseReasonError,
  salesBars,
  toggleExpanded,
  type CostMatrixRow
} from "./payroll-cost-helpers";

type View = "contracts" | "periods" | "slips" | "cost";

const PERIOD_STATUS_LABEL: Record<PayrollPeriodRecord["status"], string> = { open: "Abierto", calculated: "Calculado", exported: "Exportado", closed: "Cerrado" };
const PERIOD_STATUS_TONE: Record<PayrollPeriodRecord["status"], CocoaTone> = { open: "warning", calculated: "info", exported: "success", closed: "neutral" };
const SLIP_STATUS_LABEL: Record<PayrollSlipRecord["status"], string> = { draft: STATUS_LABELS.draft, issued: "Emitido", paid: "Pagado" };
const SLIP_STATUS_TONE: Record<PayrollSlipRecord["status"], CocoaTone> = { draft: "neutral", issued: "info", paid: "success" };

const PAY_FREQUENCIES: Array<{ value: PayrollPayFrequency; label: string }> = [
  { value: "monthly", label: "Mensual" },
  { value: "biweekly", label: "Quincenal" },
  { value: "weekly", label: "Semanal" }
];

const EXPORT_FORMATS: Array<{ value: PayrollExportFormat; label: string }> = [
  { value: "a3", label: "A3 Nóminas (compatible)" },
  { value: "sage", label: "Sage (compatible)" },
  { value: "csv", label: "CSV universal" }
];

const DEFAULT_BANK_ACCOUNT = "572";
const PERIOD_CODE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Organisation of the active property (never a fixed demo id, browser-roles#10).
const ORG_ID = getActiveOrganizationId();

function currentMonthCode(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Client-side download of the export text the API returns (kept JSON so apiRequest stays the only transport). */
function downloadText(filename: string, contentType: string, text: string) {
  const blob = new Blob([text], { type: contentType || "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Defer the revoke so Safari has a chance to consume the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Text styles (tokens only).
const captionStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
const deductionStyle: CSSProperties = { color: toneInk("danger") };

function periodBadge(period: PayrollPeriodRecord) {
  return (
    <span className="cocoa-cluster">
      <CocoaBadge tone={PERIOD_STATUS_TONE[period.status] ?? "neutral"} size="small">
        {PERIOD_STATUS_LABEL[period.status] ?? period.status}
      </CocoaBadge>
      {period.paidAt ? (
        <CocoaBadge tone="success" size="small" title={`Pagado el ${date(period.paidAt, "short")}`}>
          Pagado
        </CocoaBadge>
      ) : null}
    </span>
  );
}

const CONTRACT_COLUMNS: CocoaTableColumn<PayrollContractRecord>[] = [
  {
    key: "staffProfileId",
    label: "Empleado",
    render: (c) => (
      <>
        <strong>{c.staffProfileId}</strong>
        {c.socialSecurityCategory ? <span style={captionStyle}>{c.socialSecurityCategory}</span> : null}
      </>
    )
  },
  { key: "contractType", label: "Modalidad", render: (c) => PAYROLL_CONTRACT_TYPE_LABELS_ES[c.contractType as PayrollContractType] ?? c.contractType },
  { key: "grossSalary", label: "Bruto mensual", align: "right", render: (c) => money(c.grossSalary) },
  { key: "payCount", label: "Pagas", align: "right", hideOnNarrow: true, render: (c) => number(c.payCount) },
  { key: "irpfRatePct", label: "IRPF", align: "right", hideOnNarrow: true, render: (c) => (c.irpfRatePct === undefined ? <span style={secondaryStyle}>automático</span> : percent(c.irpfRatePct)) },
  {
    key: "dates",
    label: "Vigencia",
    hideOnNarrow: true,
    render: (c) => (c.endDate ? dateRange(c.startDate, c.endDate, { style: "short" }) : `desde ${date(c.startDate, "short")}`)
  },
  {
    key: "active",
    label: "Estado",
    render: (c) => (
      <CocoaBadge tone={c.active ? "success" : "neutral"} size="small">
        {c.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}
      </CocoaBadge>
    )
  }
];

const PERIOD_COLUMNS: CocoaTableColumn<PayrollPeriodRecord>[] = [
  {
    key: "periodCode",
    label: "Periodo",
    render: (p) => (
      <>
        <strong>{p.periodCode}</strong>
        <span style={captionStyle}>{dateRange(p.startDate, p.endDate)}</span>
      </>
    )
  },
  { key: "status", label: "Estado", render: periodBadge },
  { key: "totalGross", label: "Bruto", align: "right", render: (p) => money(p.totalGross) },
  { key: "totalIrpf", label: "IRPF", align: "right", hideOnNarrow: true, render: (p) => money(p.totalIrpf) },
  { key: "totalSs", label: "Seguridad Social", align: "right", hideOnNarrow: true, render: (p) => money(p.totalSs) },
  { key: "totalNet", label: "Neto", align: "right", render: (p) => <strong>{money(p.totalNet)}</strong> }
];

const SLIP_COLUMNS: CocoaTableColumn<PayrollSlipRecord>[] = [
  { key: "staffProfileId", label: "Empleado", render: (s) => <strong>{s.staffProfileId}</strong> },
  { key: "daysWorked", label: "Días", align: "right", hideOnNarrow: true, render: (s) => number(s.daysWorked) },
  { key: "grossSalary", label: "Bruto", align: "right", render: (s) => money(s.grossSalary) },
  { key: "irpfRetention", label: "IRPF", align: "right", hideOnNarrow: true, render: (s) => <span style={deductionStyle}>{money(-s.irpfRetention)}</span> },
  { key: "ssEmployee", label: "SS trabajador", align: "right", hideOnNarrow: true, render: (s) => <span style={deductionStyle}>{money(-s.ssEmployee)}</span> },
  { key: "ssEmployer", label: "SS empresa", align: "right", hideOnNarrow: true, render: (s) => <span style={secondaryStyle}>{money(s.ssEmployer)}</span> },
  { key: "netSalary", label: "Neto", align: "right", render: (s) => <strong>{money(s.netSalary)}</strong> },
  {
    key: "status",
    label: "Estado",
    render: (s) => (
      <CocoaBadge tone={SLIP_STATUS_TONE[s.status] ?? "neutral"} size="small">
        {SLIP_STATUS_LABEL[s.status] ?? s.status}
      </CocoaBadge>
    )
  }
];

// ---- Coste de personal (Tanda 6c) ----

const GROUP_OPTIONS = costGroupOptions();
const MANAGE_HINT = "Necesitas el permiso de gestión de nóminas";

const IMPORT_COLUMNS: CocoaTableColumn<PayrollCostImportRecord>[] = [
  { key: "createdAt", label: "Fecha", fit: true, render: (record) => date(record.createdAt, "short") },
  {
    key: "fileName",
    label: "Fichero",
    render: (record) => (
      <span className="cocoa-stack" data-gap="1">
        <strong>{importFileLabel(record)}</strong>
        {/* Pasted text has no file name: the label already names the source, so the caption would repeat it (FU-09). */}
        {record.fileName ? <span className="cocoa-caption">{PAYROLL_COST_SOURCE_LABELS[record.source] ?? record.source}</span> : null}
      </span>
    )
  },
  { key: "period", label: "Periodo", fit: true, render: (record) => monthRangeLabel(record.periodFrom, record.periodTo) },
  { key: "rowCount", label: "Filas", align: "right", hideOnNarrow: true, render: (record) => number(record.rowCount) },
  { key: "totalCost", label: "Coste", align: "right", render: (record) => <strong>{money(record.totalCost)}</strong> },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (record) => {
      const badge = importStatusBadge(record.status);
      return (
        <CocoaBadge tone={badge.tone} size="small" title={record.status === "reversed" && record.reversalReason ? `Motivo: ${record.reversalReason}` : undefined}>
          {badge.label}
        </CocoaBadge>
      );
    }
  },
  {
    key: "entries",
    label: "Asientos",
    align: "right",
    hideOnNarrow: true,
    render: (record) => (record.reversalJournalEntryIds.length > 0 ? `${number(record.journalEntryIds.length)} · ${plural(record.reversalJournalEntryIds.length, "reverso", "reversos")}` : number(record.journalEntryIds.length))
  }
];

// Mirror skeleton: KPI strip and one table card.
function PayrollSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export function PayrollScreen() {
  // Tanda 6b · L7: the sociedad is the employer (one NIF): the «Ámbito» lists the contracts of every centre by
  // default and filters one centre (the oficina central included) on demand.
  const finance = useFinanceScope(financeScopePolicy("PayrollScreen"));
  const propertyId = finance.propertyId;
  const { showToast } = useToast();

  const [view, setView] = useState<View>("contracts");
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);

  const contractsState = useApiData<PayrollContractRecord[]>("/payroll/contracts", { query: { organizationId: ORG_ID, propertyId } });
  const periodsState = useApiData<PayrollPeriodRecord[]>("/payroll/periods", { query: { organizationId: ORG_ID } });
  const slipsState = useApiData<PayrollSlipRecord[]>(selectedPeriodId ? `/payroll/periods/${encodeURIComponent(selectedPeriodId)}/slips` : null);

  const contracts = useMemo(() => toArray<PayrollContractRecord>(contractsState.data), [contractsState.data]);
  const periods = useMemo(() => toArray<PayrollPeriodRecord>(periodsState.data), [periodsState.data]);
  const slips = toArray<PayrollSlipRecord>(slipsState.data);
  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId) ?? null;

  const openPeriods = periods.filter((p) => p.status === "open").length;
  const lastCalculated = useMemo(
    () => [...periods].filter((p) => p.status !== "open").sort((a, b) => (a.periodCode < b.periodCode ? 1 : -1))[0],
    [periods]
  );
  const monthCode = currentMonthCode();
  const grossMonth = periods.filter((p) => p.periodCode === monthCode).reduce((sum, p) => sum + (p.totalGross ?? 0), 0);
  const activeContracts = contracts.filter((c) => c.active).length;

  // ---- coste de personal importado (Tanda 6c) ----
  // The gate reads the real grants of the active property (never the demo union of the login payload).
  const manage = canDo(useNavGate(), "payroll.manage");
  const matrixId = useId();
  const [costRange, setCostRange] = useState(() => defaultCostRange());
  const [costGroup, setCostGroup] = useState<PayrollCostGroup | "">(ALL_GROUPS_VALUE);
  const [expandedCentres, setExpandedCentres] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [importOpen, setImportOpen] = useState(false);
  const [postTarget, setPostTarget] = useState<PayrollCostImportRecord | null>(null);
  const [postReplace, setPostReplace] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<PayrollCostImportRecord | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  // Empty = each reversal keeps the date of its entry; the API refuses a reversal whose ORIGINAL month is closed whatever the date.
  const [reverseDate, setReverseDate] = useState("");
  const costActive = view === "cost";
  // Below 600 px CocoaTable paints one card per row: every card must carry its centre and only the last month (FU-05).
  const phone = useViewportTier() === "phone";
  // Both readers are lazy: they only fire while the tab is open (`null` path otherwise).
  const reportState = useApiData<PayrollCostReport>(costActive ? "/payroll/cost-report" : null, {
    query: payrollCostReportQuery({ from: costRange.from, to: costRange.to, propertyId, group: costGroup === "" ? undefined : costGroup })
  });
  const importsState = useApiData<PayrollCostImportRecord[]>(costActive ? "/payroll/cost-imports" : null, { query: payrollCostImportListQuery({ organizationId: ORG_ID, limit: 100 }) });
  const report = reportState.data;
  const costImports = useMemo(() => toArray<PayrollCostImportRecord>(importsState.data), [importsState.data]);
  const matrixRows = useMemo(() => (report ? costMatrixRows(report, expandedCentres) : []), [report, expandedCentres]);
  const monthOptions = useMemo(() => monthPickerOptions(new Date(), PAYROLL_COST_PICKER_MONTHS, [costRange.from, costRange.to]), [costRange.from, costRange.to]);
  const costBarsData = useMemo(() => (report ? costBars(report) : []), [report]);
  const salesBarsData = useMemo(() => (report ? salesBars(report) : []), [report]);
  const laborPct = report ? laborPctOf(report.totals) : null;
  const matrixColumns = useMemo<CocoaTableColumn<CostMatrixRow>[]>(() => {
    const months = report?.months ?? [];
    // Label of each block (centre or sociedad) for the phone cards, where the 2nd-4th rows of a block have no centre of their own.
    const blockLabels = new Map<string, string>();
    for (const row of matrixRows) if (row.centreLabel) blockLabels.set(row.propertyId ?? "society", row.centreLabel);
    return [
      {
        key: "centre",
        label: "Centro",
        render: (row) => {
          const label = row.centreLabel ?? (phone ? (blockLabels.get(row.propertyId ?? "society") ?? null) : null);
          if (!label) return null;
          const centreId = row.propertyId;
          const open = centreId !== null && expandedCentres.has(centreId);
          return (
            <span className="cocoa-cluster">
              <strong>{label}</strong>
              {row.centreLabel && centreId !== null && row.departments.length > 0 ? (
                <CocoaButton variant="plain" tone="neutral" size="small" aria-expanded={open} aria-controls={matrixId} title="Desglose por departamento USALI" onClick={() => setExpandedCentres((current) => toggleExpanded(current, centreId))}>
                  {open ? "Ocultar departamentos" : "Departamentos"}
                </CocoaButton>
              ) : null}
            </span>
          );
        }
      },
      { key: "metric", label: "Indicador", render: (row) => (row.indent ? <span className="cocoa-caption">{row.label}</span> : <span>{row.label}</span>) },
      ...months.map<CocoaTableColumn<CostMatrixRow>>((month, index) => ({
        key: month,
        label: monthLabel(month),
        align: "right",
        // On phones only the last month of the range and the total stay (up to 24 month lines per card were unreadable).
        showFrom: index === months.length - 1 ? undefined : "tablet",
        render: (row) => (row.emphasis ? <strong className="cocoa-tabular">{row.values[month] ?? "—"}</strong> : <span className="cocoa-tabular">{row.values[month] ?? "—"}</span>)
      })),
      { key: "total", label: "Total", align: "right", render: (row) => <strong className="cocoa-tabular">{row.total}</strong> }
    ];
  }, [report?.months, matrixRows, expandedCentres, matrixId, phone]);

  function changeRange(part: "from" | "to", value: string) {
    setCostRange((current) => clampCostRange(part === "from" ? value : current.from, part === "to" ? value : current.to, part));
  }

  const refreshCost = () => {
    reportState.refresh();
    importsState.refresh();
  };

  function onImported(result: PayrollCostImportCreateResult) {
    showToast(importResultTitle(result), { variant: "success" });
    refreshCost();
  }

  const refreshAll = () => {
    contractsState.refresh();
    periodsState.refresh();
    if (selectedPeriodId) slipsState.refresh();
    if (costActive) refreshCost();
  };

  // ---- new contract (drawer) ----
  const [contractOpen, setContractOpen] = useState(false);
  const [staffProfileId, setStaffProfileId] = useState("");
  const [contractType, setContractType] = useState<string>("indefinido");
  const [startDate, setStartDate] = useState(() => isoDate(new Date()) ?? "");
  const [endDate, setEndDate] = useState("");
  const [grossSalary, setGrossSalary] = useState("");
  const [payFrequency, setPayFrequency] = useState<string>("monthly");
  const [payCount, setPayCount] = useState("");
  const [irpfRatePct, setIrpfRatePct] = useState("");
  const [socialSecurityCategory, setSocialSecurityCategory] = useState("");
  const [contractError, setContractError] = useState<string | null>(null);
  const [contractSaving, setContractSaving] = useState(false);

  const grossValue = toNumber(grossSalary);
  const irpfValue = irpfRatePct.trim() === "" ? null : toNumber(irpfRatePct);
  const payCountValue = payCount.trim() === "" ? null : toNumber(payCount);
  const contractErrors = {
    staffProfileId: staffProfileId.trim() === "" ? "El identificador de la ficha de personal es obligatorio." : undefined,
    grossSalary: grossSalary.trim() === "" ? "Indica el bruto mensual." : grossValue === null || grossValue < 0 ? "El bruto debe ser un importe mayor o igual que 0." : undefined,
    endDate: endDate !== "" && startDate !== "" && endDate < startDate ? "La fecha de fin no puede ser anterior a la de inicio." : undefined,
    irpfRatePct: irpfRatePct.trim() !== "" && (irpfValue === null || irpfValue < 0 || irpfValue > 100) ? "El IRPF debe estar entre 0 y 100." : undefined,
    payCount: payCount.trim() !== "" && (payCountValue === null || !Number.isInteger(payCountValue) || payCountValue < 12 || payCountValue > 16) ? "Entre 12 y 16 pagas anuales." : undefined
  };
  const contractValid = Object.values(contractErrors).every((error) => error === undefined) && startDate !== "";

  function resetContractForm() {
    setStaffProfileId("");
    setContractType("indefinido");
    setStartDate(isoDate(new Date()) ?? "");
    setEndDate("");
    setGrossSalary("");
    setPayFrequency("monthly");
    setPayCount("");
    setIrpfRatePct("");
    setSocialSecurityCategory("");
    setContractError(null);
  }

  async function saveContract() {
    if (!contractValid || contractSaving) return;
    setContractSaving(true);
    setContractError(null);
    try {
      await createPayrollContract({
        staffProfileId: staffProfileId.trim(),
        contractType: contractType as PayrollContractType,
        startDate,
        endDate: endDate || undefined,
        grossSalary: grossSalary.trim().replace(",", "."),
        payFrequency: payFrequency as PayrollPayFrequency,
        payCount: payCountValue ?? undefined,
        irpfRatePct: irpfRatePct.trim() === "" ? undefined : irpfRatePct.trim().replace(",", "."),
        socialSecurityCategory: socialSecurityCategory.trim() || undefined
      });
      showToast("Contrato guardado", { variant: "success" });
      setContractOpen(false);
      resetContractForm();
      contractsState.refresh();
    } catch (err) {
      setContractError(payrollErrorMessage(err, "No se pudo guardar el contrato."));
    } finally {
      setContractSaving(false);
    }
  }

  // ---- deactivate contract (destructive dialog) ----
  const [pendingDeactivate, setPendingDeactivate] = useState<PayrollContractRecord | null>(null);
  const [busy, setBusy] = useState(false);

  async function deactivate() {
    if (!pendingDeactivate) return;
    setBusy(true);
    try {
      await deactivatePayrollContract(pendingDeactivate.id);
      showToast("Contrato desactivado", { variant: "success" });
      setPendingDeactivate(null);
      contractsState.refresh();
    } catch (err) {
      showToast(payrollErrorMessage(err, "No se pudo desactivar el contrato."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  // ---- new period (drawer) ----
  const [periodOpen, setPeriodOpen] = useState(false);
  const [periodCode, setPeriodCode] = useState(currentMonthCode);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [periodSaving, setPeriodSaving] = useState(false);
  const periodCodeError = PERIOD_CODE.test(periodCode.trim()) ? undefined : "El periodo debe tener el formato AAAA-MM.";

  async function savePeriod() {
    if (periodCodeError || periodSaving) return;
    setPeriodSaving(true);
    setPeriodError(null);
    try {
      await createPayrollPeriod({ periodCode: periodCode.trim() });
      showToast(`Periodo ${periodCode.trim()} abierto`, { variant: "success" });
      setPeriodOpen(false);
      periodsState.refresh();
      setView("periods");
    } catch (err) {
      setPeriodError(payrollErrorMessage(err, "No se pudo abrir el periodo."));
    } finally {
      setPeriodSaving(false);
    }
  }

  // ---- calculate · export · pay (dialogs) ----
  const [calcTarget, setCalcTarget] = useState<PayrollPeriodRecord | null>(null);
  const [exportTarget, setExportTarget] = useState<PayrollPeriodRecord | null>(null);
  const [exportFormat, setExportFormat] = useState<string>("a3");
  const [lastExport, setLastExport] = useState<PayrollExportResult | null>(null);
  const [payTarget, setPayTarget] = useState<PayrollPeriodRecord | null>(null);
  const [paidAt, setPaidAt] = useState("");
  const [bankLedgerCode, setBankLedgerCode] = useState(DEFAULT_BANK_ACCOUNT);
  const [payReference, setPayReference] = useState("");

  async function calculate() {
    if (!calcTarget) return;
    setBusy(true);
    try {
      await calculatePayrollPeriod(calcTarget.id);
      showToast(`Periodo ${calcTarget.periodCode} calculado y contabilizado`, { variant: "success" });
      setCalcTarget(null);
      periodsState.refresh();
      if (selectedPeriodId === calcTarget.id) slipsState.refresh();
    } catch (err) {
      showToast(payrollErrorMessage(err, "No se pudo calcular el periodo."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function exportPeriod() {
    if (!exportTarget) return;
    setBusy(true);
    try {
      const result = await exportPayrollPeriod(exportTarget.id, exportFormat as PayrollExportFormat);
      downloadText(result.filename, result.contentType, result.text);
      setLastExport(result);
      showToast(`Exportación de ${result.periodCode} descargada`, { variant: "success" });
      setExportTarget(null);
      periodsState.refresh();
    } catch (err) {
      showToast(payrollErrorMessage(err, "No se pudo exportar el periodo."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function openPay(period: PayrollPeriodRecord) {
    setPaidAt(isoDate(new Date()) ?? "");
    setBankLedgerCode(DEFAULT_BANK_ACCOUNT);
    setPayReference("");
    setPayTarget(period);
  }

  async function pay() {
    if (!payTarget) return;
    setBusy(true);
    try {
      await payPayrollPeriod(payTarget.id, {
        paidAt: paidAt || undefined,
        bankLedgerCode: bankLedgerCode.trim() || undefined,
        reference: payReference.trim() || undefined
      });
      showToast(`Nóminas de ${payTarget.periodCode} pagadas y contabilizadas`, { variant: "success" });
      setPayTarget(null);
      periodsState.refresh();
    } catch (err) {
      showToast(payrollErrorMessage(err, "No se pudo registrar el pago."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function openSlips(period: PayrollPeriodRecord) {
    setSelectedPeriodId(period.id);
    setView("slips");
  }

  // ---- contabilizar borrador · revertir lote (coste de personal) ----
  async function postDraftImport() {
    if (!postTarget || busy) return;
    setBusy(true);
    try {
      const result = await postPayrollCostImport(postTarget.id, { replace: postReplace });
      showToast(importResultTitle(result), { variant: "success" });
      setPostTarget(null);
      refreshCost();
    } catch (err) {
      showToast(payrollCostErrorMessage(err, "No se pudo contabilizar la importación."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function reverseImport() {
    if (!reverseTarget || busy || reverseReasonError(reverseReason)) return;
    setBusy(true);
    try {
      const record = await reversePayrollCostImport(reverseTarget.id, { reason: reverseReason.trim(), entryDate: reverseDate || undefined });
      showToast(record.alreadyReversed ? "La importación ya estaba revertida: nada que hacer" : `Importación revertida: ${plural(reverseTarget.journalEntryIds.length, "asiento anulado", "asientos anulados")}`, { variant: "success" });
      setReverseTarget(null);
      setReverseReason("");
      setReverseDate("");
      refreshCost();
    } catch (err) {
      showToast(payrollCostErrorMessage(err, "No se pudo revertir la importación."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const anyLoading = contractsState.loading || periodsState.loading;
  const nothingLoaded = !contractsState.data && !periodsState.data;
  const state = nothingLoaded ? (anyLoading ? "loading" : "error") : "ready";
  const newContractLabel = newLabel("m", "contrato");
  const exportWarnings = toArray<string>(lastExport?.warnings);
  // Tanda 6b: the export carries the employer block (sociedad NIF · razón social · CCC) — additive on the wire.
  const employer = (lastExport as (PayrollExportResult & { employer?: { legalName: string; taxId: string | null; taxIdValid: boolean; ccc: string | null; cccSource: string | null } }) | null)?.employer ?? null;

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title="Nóminas"
      subtitle="Contratos, periodos mensuales y exportación a la gestoría. El cálculo bruto → IRPF → Seguridad Social → neto usa los porcentajes del régimen general y se contabiliza (640/642 contra 465/4751/476); el pago asienta 465 contra tesorería."
      actions={
        <>
          {anyLoading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <FinanceScopeSelector scope={finance} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPeriodOpen(true)}>
            Abrir periodo
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setContractOpen(true)}>
            {newContractLabel}
          </CocoaButton>
        </>
      }
      tabs={[
        { value: "contracts", label: `Contratos (${number(contracts.length)})` },
        { value: "periods", label: `Periodos (${number(periods.length)})` },
        { value: "slips", label: selectedPeriod ? `Recibos · ${selectedPeriod.periodCode}` : "Recibos" },
        { value: "cost", label: "Coste de personal" }
      ]}
      activeTab={view}
      onTabChange={(value) => setView(value as View)}
      state={state}
      skeleton={<PayrollSkeleton />}
      error={{ title: "No se pudieron cargar las nóminas", message: contractsState.error ?? periodsState.error ?? undefined, onRetry: refreshAll }}
      commands={[
        { id: "payroll-refresh", label: "Actualizar nóminas", run: refreshAll },
        { id: "payroll-new-contract", label: newContractLabel, run: () => setContractOpen(true) },
        { id: "payroll-new-period", label: "Abrir periodo de nómina", run: () => setPeriodOpen(true) },
        { id: "payroll-cost-tab", label: "Ver el coste de personal", run: () => setView("cost") },
        ...(manage ? [{ id: "payroll-cost-import", label: "Importar informe de coste de personal", run: () => setImportOpen(true) }] : [])
      ]}
    >
      {costActive ? (
        <CocoaKpiStrip stagger aria-label="Indicadores de coste de personal">
          <CocoaKpi label="Coste de personal" value={money(report?.totals.totalCost)} polarity="neutral" deltaLabel={monthRangeLabel(costRange.from, costRange.to)} caption={report ? `bruto ${money(report.totals.gross)} · Seguridad Social ${money(report.totals.employerSs)}` : undefined} degraded={!report} />
          <CocoaKpi label="Coste por empleado" value={money(report?.totals.costPerEmployeeAverage)} polarity="neutral" deltaLabel="acumulado del rango por empleado medio" caption={report?.totals.headcountAverage ? `${money(report.totals.totalCost)} entre ${formatHeadcount(report.totals.headcountAverage)} empleados medios` : undefined} degraded={!report} />
          <CocoaKpi label="Personal s/ ventas" value={laborPct ? formatLaborPct(laborPct.value) : "—"} polarity="neutral" deltaLabel={laborPct?.source === "reference" ? "s/ ventas de referencia del informe" : "s/ ventas del libro"} degraded={!report} />
          <CocoaKpi label="Empleados medios" value={formatHeadcount(report?.totals.headcountAverage)} polarity="neutral" deltaLabel={report?.totals.headcountSource === "lines" ? "suma de las filas importadas" : report?.totals.headcountSource === "reference" ? "según el informe de RRHH" : "sin dato de empleados"} degraded={!report} />
        </CocoaKpiStrip>
      ) : (
        <CocoaKpiStrip stagger aria-label="Indicadores de nóminas">
          <CocoaKpi label="Periodos abiertos" value={number(openPeriods)} polarity="neutral" status={openPeriods > 0 ? "warning" : "ok"} deltaLabel="pendientes de calcular" degraded={!periodsState.data} />
          <CocoaKpi label="Último calculado" value={lastCalculated?.periodCode ?? "—"} polarity="neutral" deltaLabel={lastCalculated ? `bruto ${money(lastCalculated.totalGross)}` : "sin periodos calculados"} degraded={!periodsState.data} />
          <CocoaKpi label="Bruto del mes" value={money(grossMonth)} polarity="neutral" deltaLabel={`periodo ${monthCode}`} degraded={!periodsState.data} />
          <CocoaKpi label="Contratos activos" value={number(activeContracts)} polarity="neutral" deltaLabel={plural(contracts.length, "contrato en total", "contratos en total")} degraded={!contractsState.data} />
        </CocoaKpiStrip>
      )}

      {lastExport ? (
        <CocoaCallout
          tone={lastExport.validateWithAdvisor ? "warning" : "success"}
          title={`Exportación ${lastExport.format.toUpperCase()} de ${lastExport.periodCode} descargada`}
          role="status"
          actions={
            <span className="cocoa-cluster">
              {lastExport.validateWithAdvisor ? <CocoaBadge tone="warning" size="small">Validar con la gestoría</CocoaBadge> : null}
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => downloadText(lastExport.filename, lastExport.contentType, lastExport.text)}>
                {ACTIONS.download}
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setLastExport(null)} aria-label="Ocultar el aviso de exportación">
                Ocultar
              </CocoaButton>
            </span>
          }
        >
          {lastExport.filename} · {plural(lastExport.slipCount, "recibo", "recibos")}
          {employer ? ` · empleador ${employer.legalName} · NIF ${employer.taxId ?? "pendiente"}${employer.ccc ? ` · CCC ${employer.ccc}` : " · sin CCC"}` : ""}
          {exportWarnings.length > 0 ? (
            <ul className="c22-section__list">
              {exportWarnings.map((warning, index) => (
                <li key={index}>
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </CocoaCallout>
      ) : null}

      {view === "contracts" ? (
        <CocoaSection title="Contratos" meta={plural(contracts.length, "contrato", "contratos")} headingLevel={2} padding={contracts.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
          {contractsState.error && !contractsState.data ? (
            <CocoaState kind="error" title="No se pudieron cargar los contratos" message={contractsState.error} onRetry={contractsState.refresh} />
          ) : contractsState.loading && !contractsState.data ? (
            <CocoaTable columns={CONTRACT_COLUMNS} rows={[]} loading aria-label="Contratos" />
          ) : contracts.length === 0 ? (
            <CocoaState kind="empty" title="Aún no hay contratos" message="Da de alta el contrato de cada empleado para incluirlo en los periodos de nómina." primaryAction={{ label: newContractLabel, onClick: () => setContractOpen(true) }} />
          ) : (
            <CocoaTable
              columns={CONTRACT_COLUMNS}
              rows={contracts}
              rowKey="id"
              rowTone={(c) => (c.active ? undefined : "neutral")}
              rowActions={(c) =>
                c.active ? (
                  <CocoaButton
                    variant="plain"
                    tone="destructive"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingDeactivate(c);
                    }}
                  >
                    {ACTIONS.deactivate}
                  </CocoaButton>
                ) : null
              }
              caption="Contratos"
              aria-label="Contratos"
            />
          )}
        </CocoaSection>
      ) : null}

      {view === "periods" ? (
        <CocoaSection title="Periodos de nómina" meta={plural(periods.length, "periodo", "periodos")} headingLevel={2} padding={periods.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
          {periodsState.error && !periodsState.data ? (
            <CocoaState kind="error" title="No se pudieron cargar los periodos" message={periodsState.error} onRetry={periodsState.refresh} />
          ) : periodsState.loading && !periodsState.data ? (
            <CocoaTable columns={PERIOD_COLUMNS} rows={[]} loading aria-label="Periodos de nómina" />
          ) : periods.length === 0 ? (
            <CocoaState kind="empty" title="Aún no hay periodos" message="Abre el periodo del mes en curso para calcular los recibos de los contratos activos." primaryAction={{ label: "Abrir periodo", onClick: () => setPeriodOpen(true) }} />
          ) : (
            <CocoaTable
              columns={PERIOD_COLUMNS}
              rows={periods}
              rowKey="id"
              selectedKey={selectedPeriodId ?? undefined}
              onSelect={openSlips}
              rowTitle={() => "Ver los recibos del periodo"}
              rowActions={(p) => (
                <span className="cocoa-cluster">
                  <CocoaButton
                    variant="plain"
                    tone="accent"
                    size="small"
                    disabled={p.status === "closed" || Boolean(p.paidAt)}
                    title={p.paidAt ? "El periodo ya está pagado: no se recalcula" : p.status === "open" ? "Calcula y contabiliza los recibos" : "Recalcula: anula los asientos anteriores y vuelve a contabilizar"}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCalcTarget(p);
                    }}
                  >
                    {p.status === "open" ? "Calcular" : "Recalcular"}
                  </CocoaButton>
                  <CocoaButton
                    variant="plain"
                    tone="neutral"
                    size="small"
                    disabled={p.status === "open"}
                    title={p.status === "open" ? "Calcula el periodo antes de exportarlo" : "Exportación auditada a la gestoría"}
                    onClick={(event) => {
                      event.stopPropagation();
                      setExportFormat("a3");
                      setExportTarget(p);
                    }}
                  >
                    {ACTIONS.export}
                  </CocoaButton>
                  <CocoaButton
                    variant="plain"
                    tone="neutral"
                    size="small"
                    disabled={p.status === "open" || Boolean(p.paidAt)}
                    title={p.paidAt ? `Pagado el ${date(p.paidAt, "short")}` : p.status === "open" ? "Calcula el periodo antes de pagarlo" : "Registra el pago del neto (asiento 465 contra tesorería)"}
                    onClick={(event) => {
                      event.stopPropagation();
                      openPay(p);
                    }}
                  >
                    Pagar
                  </CocoaButton>
                  <CocoaButton
                    variant="plain"
                    tone="neutral"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      openSlips(p);
                    }}
                  >
                    Recibos
                  </CocoaButton>
                </span>
              )}
              caption="Periodos de nómina"
              aria-label="Periodos de nómina"
            />
          )}
        </CocoaSection>
      ) : null}

      {view === "slips" ? (
        <CocoaSection
          title={selectedPeriod ? `Recibos · ${selectedPeriod.periodCode}` : "Recibos"}
          meta={selectedPeriod ? periodBadge(selectedPeriod) : undefined}
          headingLevel={2}
          action={
            selectedPeriod ? (
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setView("periods")}>
                Cambiar de periodo
              </CocoaButton>
            ) : undefined
          }
          padding={selectedPeriod && slips.length > 0 ? "none" : "md"}
          style={{ overflow: "clip" }}
        >
          {!selectedPeriod ? (
            <CocoaState kind="empty" title="Elige un periodo" message="Abre un periodo desde la pestaña «Periodos» para ver sus recibos." primaryAction={{ label: "Ver periodos", onClick: () => setView("periods") }} />
          ) : slipsState.error && !slipsState.data ? (
            <CocoaState kind="error" title="No se pudieron cargar los recibos" message={slipsState.error} onRetry={slipsState.refresh} />
          ) : slipsState.loading && !slipsState.data ? (
            <CocoaTable columns={SLIP_COLUMNS} rows={[]} loading aria-label="Recibos" />
          ) : slips.length === 0 ? (
            <CocoaState
              kind="empty"
              title="Aún no hay recibos"
              message="Calcula el periodo para generar un recibo por cada contrato activo."
              primaryAction={selectedPeriod.status !== "closed" && !selectedPeriod.paidAt ? { label: "Calcular", onClick: () => setCalcTarget(selectedPeriod) } : undefined}
            />
          ) : (
            <CocoaTable columns={SLIP_COLUMNS} rows={slips} rowKey="id" footer={{ staffProfileId: <strong>{plural(slips.length, "recibo", "recibos")}</strong>, grossSalary: <strong>{money(selectedPeriod.totalGross)}</strong>, irpfRetention: money(-selectedPeriod.totalIrpf), netSalary: <strong>{money(selectedPeriod.totalNet)}</strong> }} caption="Recibos del periodo" aria-label="Recibos del periodo" />
          )}
        </CocoaSection>
      ) : null}

      {costActive ? (
        <>
          <div className="cocoa-row" role="group" aria-label="Rango y grupo del coste de personal">
            <CocoaSelect size="small" inline aria-label="Desde" value={costRange.from} onChange={(value) => changeRange("from", value)} options={monthOptions} />
            <CocoaSelect size="small" inline aria-label="Hasta" value={costRange.to} onChange={(value) => changeRange("to", value)} options={monthOptions} />
            <CocoaSelect size="small" inline aria-label="Grupo" value={costGroup} onChange={(value) => setCostGroup(value as PayrollCostGroup | "")} options={GROUP_OPTIONS} />
            {reportState.loading && report ? (
              <CocoaBadge tone="info" size="small" aria-live="polite">
                {STATUS_LABELS.loading}
              </CocoaBadge>
            ) : null}
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshCost}>
              {ACTIONS.refresh}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setImportOpen(true)} disabled={!manage} title={manage ? "Importa el informe agregado de RRHH y contabiliza el coste por centro y mes" : MANAGE_HINT}>
              Importar informe
            </CocoaButton>
          </div>
          {!manage ? <p className="cocoa-note">Necesitas el permiso de gestión de nóminas para importar, contabilizar o revertir un informe de coste de personal. El informe se puede consultar.</p> : null}
          {report && report.warnings.length > 0 ? (
            <CocoaCallout tone="warning" title="Avisos del informe">
              <ul className="c22-section__list">
                {report.warnings.map((warning, index) => (
                  <li key={index}>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            </CocoaCallout>
          ) : null}

          <CocoaSection
            id={matrixId}
            title="Coste de personal por centro y mes"
            meta={report ? `${plural(report.centres.length, "centro", "centros")} · ${plural(report.imports.length, "lote contabilizado", "lotes contabilizados")} · generado ${dateTime(report.generatedAt)}` : undefined}
            headingLevel={2}
            padding={matrixRows.length > 0 ? "none" : "md"}
            aria-busy={reportState.loading && Boolean(report)}
            footer="Empleados: referencia del informe cuando existe; si no, la suma de las filas importadas (sobrecuenta a quien figura en dos grupos). Coste por empleado en «Total»: acumulado del rango entre los empleados medios. % s/ ventas: ventas netas del libro (grupo 70) cuando cubren el mes; «(ref.)» = ventas sin IVA declaradas en el informe."
          >
            {reportState.error && !report ? (
              <CocoaState kind="error" title="No se pudo cargar el coste de personal" message={reportState.error} onRetry={reportState.refresh} />
            ) : reportState.loading && !report ? (
              <CocoaTable columns={matrixColumns} rows={[]} loading aria-label="Coste de personal por centro y mes" />
            ) : !report || report.centres.length === 0 ? (
              <CocoaState kind="empty" title="Sin coste de personal en el rango" message="Importa el informe agregado de RRHH (centro × mes × grupo × departamento) para contabilizar el coste de personal y verlo aquí." primaryAction={manage ? { label: "Importar informe", onClick: () => setImportOpen(true) } : undefined} />
            ) : (
              <CocoaTable columns={matrixColumns} rows={matrixRows} rowKey="key" density="compact" stickyFirstColumn rowTone={(row) => (row.society ? "neutral" : undefined)} caption="Coste de personal por centro y mes" aria-label="Coste de personal por centro y mes" />
            )}
          </CocoaSection>

          {report && report.centres.length > 0 ? (
            <CocoaGrid columns={12} aria-label="Gráficos del coste de personal" align="start">
              <CocoaSpan cols={6} min={320}>
                <CocoaSection title="Coste de personal por mes" headingLevel={3}>
                  <CocoaChart.Bars data={costBarsData} height={160} valueFormat={(value) => money(value, { decimals: "auto" })} aria-label="Coste de personal por mes" />
                </CocoaSection>
              </CocoaSpan>
              <CocoaSpan cols={6} min={320}>
                <CocoaSection title="Ventas netas por mes (libro o referencia)" headingLevel={3} footer="Libro mayor (grupo 70 del centro y mes) cuando tiene ventas; si no, las ventas sin IVA del informe de RRHH.">
                  <CocoaChart.Bars data={salesBarsData} height={160} valueFormat={(value) => money(value, { decimals: "auto" })} aria-label="Ventas netas por mes, del libro o de referencia" />
                </CocoaSection>
              </CocoaSpan>
            </CocoaGrid>
          ) : null}

          <CocoaSection title="Importaciones" meta={plural(costImports.length, "lote", "lotes")} headingLevel={2} padding={costImports.length > 0 ? "none" : "md"} footer="Un lote = un fichero (mismo contenido, mismo lote: no se importa dos veces). Revertir anula los asientos del lote y solo esos; el resto del diario no se toca.">
            {importsState.error && !importsState.data ? (
              <CocoaState kind="error" title="No se pudieron cargar las importaciones" message={importsState.error} onRetry={importsState.refresh} />
            ) : importsState.loading && !importsState.data ? (
              <CocoaTable columns={IMPORT_COLUMNS} rows={[]} loading aria-label="Importaciones de coste de personal" />
            ) : costImports.length === 0 ? (
              <CocoaState kind="empty" inline title="Aún no hay importaciones" message="El primer informe agregado de RRHH aparecerá aquí con su estado y sus asientos." />
            ) : (
              <CocoaTable
                columns={IMPORT_COLUMNS}
                rows={costImports}
                rowKey="id"
                rowTone={(record) => (record.status === "reversed" ? "neutral" : undefined)}
                rowActions={(record) => (
                  <span className="cocoa-cluster">
                    {record.status === "draft" ? (
                      <CocoaButton
                        variant="plain"
                        tone="accent"
                        size="small"
                        disabled={!manage}
                        title={manage ? "Contabiliza el lote: un asiento por centro y mes" : MANAGE_HINT}
                        onClick={(event) => {
                          event.stopPropagation();
                          setPostReplace(false);
                          setPostTarget(record);
                        }}
                      >
                        Contabilizar
                      </CocoaButton>
                    ) : null}
                    {record.status === "posted" ? (
                      <CocoaButton
                        variant="plain"
                        tone="destructive"
                        size="small"
                        disabled={!manage}
                        title={manage ? "Anula los asientos del lote con asientos de reverso" : MANAGE_HINT}
                        onClick={(event) => {
                          event.stopPropagation();
                          setReverseReason("");
                          setReverseDate("");
                          setReverseTarget(record);
                        }}
                      >
                        {ACTIONS.revert}
                      </CocoaButton>
                    ) : null}
                    {record.status === "reversed" && record.reversedAt ? <span className="cocoa-caption">revertido el {date(record.reversedAt, "short")}</span> : null}
                  </span>
                )}
                caption="Importaciones de coste de personal"
                aria-label="Importaciones de coste de personal"
              />
            )}
          </CocoaSection>
        </>
      ) : null}

      {/* Nuevo contrato */}
      <CocoaDrawer
        open={contractOpen}
        onClose={() => setContractOpen(false)}
        title={newContractLabel}
        subtitle="El empleado debe existir como ficha de personal de la propiedad; el contrato entra en el siguiente periodo que se calcule."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setContractOpen(false)} disabled={contractSaving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveContract()} loading={contractSaving} disabled={!contractValid || contractSaving}>
              {contractSaving ? STATUS_LABELS.saving : "Guardar contrato"}
            </CocoaButton>
          </>
        }
      >
        <CocoaFormSection title="Empleado y modalidad">
          <CocoaFormRow columns={2}>
            <CocoaField label="Identificador de la ficha de personal" required error={staffProfileId === "" ? undefined : contractErrors.staffProfileId}>
              <CocoaInput value={staffProfileId} onChange={setStaffProfileId} placeholder="Identificador de la ficha" maxLength={64} autoFocus />
            </CocoaField>
            <CocoaField label="Modalidad de contrato" required>
              <CocoaSelect value={contractType} onChange={setContractType} options={PAYROLL_CONTRACT_TYPES.map((type) => ({ value: type, label: PAYROLL_CONTRACT_TYPE_LABELS_ES[type] }))} />
            </CocoaField>
            <CocoaField label="Inicio" required>
              <CocoaInput value={startDate} onChange={setStartDate} type="date" />
            </CocoaField>
            <CocoaField label="Fin" hint="opcional" error={contractErrors.endDate}>
              <CocoaInput value={endDate} onChange={setEndDate} type="date" min={startDate || undefined} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
        <CocoaFormSection title="Retribución">
          <CocoaFormRow columns={2}>
            <CocoaField label="Bruto mensual (€)" required error={grossSalary === "" ? undefined : contractErrors.grossSalary}>
              <CocoaInput value={grossSalary} onChange={setGrossSalary} type="number" inputMode="decimal" min={0} step="0.01" placeholder="1800,00" />
            </CocoaField>
            <CocoaField label="Periodicidad">
              <CocoaSelect value={payFrequency} onChange={setPayFrequency} options={PAY_FREQUENCIES} />
            </CocoaField>
            <CocoaField label="Pagas anuales" hint="opcional" error={contractErrors.payCount} help="Entre 12 y 16; por defecto 12.">
              <CocoaInput value={payCount} onChange={setPayCount} type="number" inputMode="numeric" min={12} max={16} step={1} />
            </CocoaField>
            <CocoaField label="IRPF (%)" hint="opcional" error={contractErrors.irpfRatePct} help="Vacío: se calcula automáticamente.">
              <CocoaInput value={irpfRatePct} onChange={setIrpfRatePct} type="number" inputMode="decimal" min={0} max={100} step="0.01" />
            </CocoaField>
            <CocoaField label="Grupo de cotización" hint="opcional" fullWidth>
              <CocoaInput value={socialSecurityCategory} onChange={setSocialSecurityCategory} placeholder="Grupo 5 · Oficiales administrativos" maxLength={80} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
        {contractError ? (
          <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
            {contractError}
          </CocoaCallout>
        ) : null}
      </CocoaDrawer>

      {/* Abrir periodo */}
      <CocoaDrawer
        open={periodOpen}
        onClose={() => setPeriodOpen(false)}
        title="Abrir periodo de nómina"
        subtitle="Un periodo por mes natural; se calcula con los contratos activos en ese mes."
        side="right"
        size="sm"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setPeriodOpen(false)} disabled={periodSaving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void savePeriod()} loading={periodSaving} disabled={Boolean(periodCodeError) || periodSaving}>
              Abrir periodo
            </CocoaButton>
          </>
        }
      >
        <CocoaFormSection title="Periodo">
          <CocoaField label="Mes (AAAA-MM)" required error={periodCodeError}>
            <CocoaInput value={periodCode} onChange={setPeriodCode} placeholder={monthCode} maxLength={7} autoFocus />
          </CocoaField>
        </CocoaFormSection>
        {periodError ? (
          <CocoaCallout tone="danger" title="No se pudo abrir el periodo" role="alert">
            {periodError}
          </CocoaCallout>
        ) : null}
      </CocoaDrawer>

      {/* Desactivar contrato */}
      <CocoaDialog
        open={pendingDeactivate !== null}
        onClose={() => setPendingDeactivate(null)}
        tone="destructive"
        title={pendingDeactivate ? `¿Desactivar el contrato de ${pendingDeactivate.staffProfileId}?` : "Desactivar contrato"}
        description="El contrato dejará de entrar en los próximos periodos de nómina. Los recibos ya calculados no cambian."
        confirmLabel={ACTIONS.deactivate}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={deactivate}
      />

      {/* Calcular / recalcular */}
      <CocoaDialog
        open={calcTarget !== null}
        onClose={() => setCalcTarget(null)}
        title={calcTarget ? `${calcTarget.status === "open" ? "Calcular" : "Recalcular"} el periodo ${calcTarget.periodCode}` : "Calcular periodo"}
        description={
          calcTarget?.status === "open"
            ? "Genera un recibo por cada contrato activo y contabiliza el devengo (640/642 contra 465, 4751 y 476)."
            : "Anula los asientos anteriores del periodo con asientos de anulación, regenera los recibos y vuelve a contabilizar. Nada se borra."
        }
        confirmLabel={calcTarget?.status === "open" ? "Calcular y contabilizar" : "Recalcular"}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={calculate}
      />

      {/* Exportar */}
      <CocoaDialog
        open={exportTarget !== null}
        onClose={() => setExportTarget(null)}
        title={exportTarget ? `Exportar ${exportTarget.periodCode} a la gestoría` : "Exportar periodo"}
        description="La exportación queda auditada y marca el periodo como exportado. Los formatos A3 y Sage son compatibles, no el diseño de registro oficial: valídalos con la gestoría."
        confirmLabel="Exportar y descargar"
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={exportPeriod}
      >
        <CocoaField label="Formato" required>
          <CocoaSelect value={exportFormat} onChange={setExportFormat} options={EXPORT_FORMATS} />
        </CocoaField>
      </CocoaDialog>

      {/* Pagar */}
      <CocoaDialog
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        title={payTarget ? `Pagar las nóminas de ${payTarget.periodCode}` : "Pagar nóminas"}
        description={payTarget ? `Asiento D 465 Remuneraciones pendientes de pago / H ${bankLedgerCode.trim() || DEFAULT_BANK_ACCOUNT} por el neto del periodo, ${money(payTarget.totalNet)}. Solo se deshace con un asiento de anulación.` : undefined}
        confirmLabel="Registrar el pago"
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        size="md"
        onConfirm={pay}
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Fecha de pago">
            <CocoaInput value={paidAt} onChange={setPaidAt} type="date" />
          </CocoaField>
          <CocoaField label="Cuenta de tesorería" help="572 Bancos por defecto; una subcuenta 572x o 570 Caja.">
            <CocoaInput value={bankLedgerCode} onChange={setBankLedgerCode} maxLength={12} />
          </CocoaField>
          <CocoaField label="Referencia" hint="opcional" fullWidth>
            <CocoaInput value={payReference} onChange={setPayReference} placeholder="Remesa o transferencia" maxLength={120} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDialog>

      {/* Importar informe de coste de personal (Tanda 6c) */}
      <PayrollCostImportDrawer open={importOpen} onClose={() => setImportOpen(false)} finance={finance} canManage={manage} onPosted={onImported} />

      {/* Contabilizar un lote en borrador */}
      <CocoaDialog
        open={postTarget !== null}
        onClose={() => setPostTarget(null)}
        title={postTarget ? `Contabilizar la importación ${importFileLabel(postTarget)}` : "Contabilizar la importación"}
        description={postTarget ? `${plural(postTarget.centreMonths, "asiento", "asientos")} (uno por centro y mes, ${monthRangeLabel(postTarget.periodFrom, postTarget.periodTo)}): D 640 y D 642 por departamento USALI contra H 465 y H 476, ${money(postTarget.totalCost)} en total. Un centro y mes ya contabilizado por otro lote detiene la operación salvo que actives «Sustituir».` : undefined}
        confirmLabel={postReplace ? "Sustituir y contabilizar" : "Contabilizar"}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        size="md"
        onConfirm={postDraftImport}
      >
        <CocoaField label="Lotes anteriores" help="Con «Sustituir», los lotes ya contabilizados con el mismo contenido o con algún centro y mes de este lote se revierten ENTEROS en la misma operación (solo los que tengan todos sus centros en tu ámbito). Reimporta siempre el rango completo.">
          <CocoaSwitch checked={postReplace} onChange={setPostReplace} label="Sustituir los lotes anteriores (reverso + este lote)" size="small" disabled={busy} />
        </CocoaField>
      </CocoaDialog>

      {/* Revertir un lote contabilizado */}
      <CocoaDialog
        open={reverseTarget !== null}
        onClose={() => {
          if (busy) return;
          setReverseTarget(null);
        }}
        tone="destructive"
        title={reverseTarget ? `Revertir la importación ${importFileLabel(reverseTarget)}` : "Revertir la importación"}
        description={reverseTarget ? `Se contabiliza un asiento de reverso por cada uno de los ${plural(reverseTarget.journalEntryIds.length, "asiento del lote", "asientos del lote")} (${monthRangeLabel(reverseTarget.periodFrom, reverseTarget.periodTo)}, ${money(reverseTarget.totalCost)}). Los originales se conservan marcados como anulados; ningún otro asiento del diario cambia.` : undefined}
        confirmLabel="Revertir la importación"
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        confirmDisabled={Boolean(reverseReasonError(reverseReason))}
        size="md"
        onConfirm={reverseImport}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" required error={reverseReason.trim() === "" ? undefined : reverseReasonError(reverseReason)} help="Obligatorio: va a la descripción de cada asiento de reverso.">
            <CocoaInput value={reverseReason} onChange={setReverseReason} multiline rows={3} placeholder="Informe corregido por RRHH, importe erróneo, meses duplicados…" maxLength={500} />
          </CocoaField>
          <CocoaField label="Fecha de la anulación" hint="opcional" help="Vacía: cada reverso lleva la fecha de su asiento (mismo mes). Con la de hoy, todos caen en el periodo actual. Si un mes del lote está cerrado, reábrelo en Contabilidad › Periodos antes de revertir: el reverso no puede fecharse fuera del mes cerrado.">
            <CocoaDatePicker value={reverseDate} onChange={setReverseDate} aria-label="Fecha de la anulación" />
          </CocoaField>
        </div>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default PayrollScreen;
