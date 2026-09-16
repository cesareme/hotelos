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

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveOrganizationId, getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
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
  type PayrollContractRecord,
  type PayrollContractType,
  type PayrollExportFormat,
  type PayrollExportResult,
  type PayrollPayFrequency,
  type PayrollPeriodRecord,
  type PayrollSlipRecord
} from "../../services/payrollApi";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import { date, dateRange, isoDate, money, number, percent, plural, toNumber } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type View = "contracts" | "periods" | "slips";

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
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
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

  const refreshAll = () => {
    contractsState.refresh();
    periodsState.refresh();
    if (selectedPeriodId) slipsState.refresh();
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

  const anyLoading = contractsState.loading || periodsState.loading;
  const nothingLoaded = !contractsState.data && !periodsState.data;
  const state = nothingLoaded ? (anyLoading ? "loading" : "error") : "ready";
  const newContractLabel = newLabel("m", "contrato");
  const exportWarnings = toArray<string>(lastExport?.warnings);

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${propertyName}`}
      title="Nóminas"
      subtitle="Contratos, periodos mensuales y exportación a la gestoría. El cálculo bruto → IRPF → Seguridad Social → neto usa los porcentajes del régimen general y se contabiliza (640/642 contra 465/4751/476); el pago asienta 465 contra tesorería."
      actions={
        <>
          {anyLoading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
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
        { value: "slips", label: selectedPeriod ? `Recibos · ${selectedPeriod.periodCode}` : "Recibos" }
      ]}
      activeTab={view}
      onTabChange={(value) => setView(value as View)}
      state={state}
      skeleton={<PayrollSkeleton />}
      error={{ title: "No se pudieron cargar las nóminas", message: contractsState.error ?? periodsState.error ?? undefined, onRetry: refreshAll }}
      commands={[
        { id: "payroll-refresh", label: "Actualizar nóminas", run: refreshAll },
        { id: "payroll-new-contract", label: newContractLabel, run: () => setContractOpen(true) },
        { id: "payroll-new-period", label: "Abrir periodo de nómina", run: () => setPeriodOpen(true) }
      ]}
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de nóminas">
        <CocoaKpi label="Periodos abiertos" value={number(openPeriods)} polarity="neutral" status={openPeriods > 0 ? "warning" : "ok"} deltaLabel="pendientes de calcular" degraded={!periodsState.data} />
        <CocoaKpi label="Último calculado" value={lastCalculated?.periodCode ?? "—"} polarity="neutral" deltaLabel={lastCalculated ? `bruto ${money(lastCalculated.totalGross)}` : "sin periodos calculados"} degraded={!periodsState.data} />
        <CocoaKpi label="Bruto del mes" value={money(grossMonth)} polarity="neutral" deltaLabel={`periodo ${monthCode}`} degraded={!periodsState.data} />
        <CocoaKpi label="Contratos activos" value={number(activeContracts)} polarity="neutral" deltaLabel={plural(contracts.length, "contrato en total", "contratos en total")} degraded={!contractsState.data} />
      </CocoaKpiStrip>

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
    </CocoaPage>
  );
}

export default PayrollScreen;
