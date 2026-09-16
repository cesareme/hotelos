// Facturas recibidas — /finanzas/proveedores (Tanda 6 · Finanzas · lote 6-E).
//
// Cocoa 22 «lista / tabla» (docs/design/COCOA-22.md §4, pilot GuestsListScreen),
// base tab of «Proveedores y gastos»: CocoaPage → CocoaKpiStrip with the aging
// buckets (GET …/payables/aging) → CocoaToolbar (search + status) →
// CocoaSection padding none → CocoaTable (a row opens the bill in a
// CocoaDrawer: totals, lines, VAT rows, accrual and payment entries, attachment)
// → «Nueva factura» drawer with the line-based form (supplier from the
// directory or free name + NIF, 6xx / 20x-21x postable account picker without
// headers, VAT per rate, quota, 15/7 % retention with its 111/115 row, printed
// total check, inline attachment ≤ 512 KiB). Flow: borrador → Aprobar →
// Contabilizar (CocoaDialog) → Pagar (date, 572/570 account, reference) or
// Anular with a reason; every details.code lands in Spanish through
// payablesErrorMessage.
//
// Reads services/payablesApi.ts (listSupplierBills · getSupplierBill ·
// createSupplierBill · approveSupplierBill · postSupplierBill · paySupplierBill
// · cancelSupplierBill · getSupplierBillAttachment · getPayablesAging ·
// listSuppliers) and GET /accounting/chart?postableOnly=1 for the pickers.

import { useMemo, useState, type CSSProperties } from "react";
import type { InlineAttachment, LedgerEntryDto, RetentionRowCode, SupplierBillStatus } from "@hotelos/shared";
import {
  approveSupplierBill,
  cancelSupplierBill,
  createSupplierBill,
  getPayablesAging,
  getSupplierBill,
  getSupplierBillAttachment,
  listSupplierBills,
  listSuppliers,
  paySupplierBill,
  postSupplierBill,
  type SupplierBillDetailDto,
  type SupplierBillDto,
  type SupplierBillRequest,
  type SupplierDto
} from "../../services/payablesApi";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { date, dateTime, money, percent, plural, toNumber } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";
import {
  BILL_STATUS_LABELS,
  BILL_STATUS_TONES,
  PAYABLE_ACCOUNT_OPTIONS,
  RETENTION_ROW_OPTIONS,
  TAX_RATE_OPTIONS,
  accountLabel,
  accountOptions,
  addDays,
  amountOf,
  decimalInput,
  describeFailure,
  isExpenseAccount,
  isInvestmentAccount,
  isTreasuryAccount,
  openInlineAttachment,
  pickFile,
  quotaOf,
  readAttachment,
  to2,
  todayIso,
  useChartAccounts,
  useLoader
} from "./payables-shared";

// Secondary line under a cell value (NIF, account, description): caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};
// Label of a detail row.
const mutedStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

const STATUS_OPTIONS = (["draft", "approved", "posted", "paid", "cancelled"] as SupplierBillStatus[]).map((value) => ({ value, label: BILL_STATUS_LABELS[value] }));

type LineDraft = { key: string; description: string; expenseAccountCode: string; base: string; taxRate: string; quota: string; investmentGood: boolean };

type BillForm = {
  supplierId: string;
  supplierName: string;
  supplierTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  retentionRate: string;
  retentionRowCode: string;
  payableAccountCode: "" | "400" | "410" | "4100" | "4109";
  expectedTotal: string;
  attachment: InlineAttachment | null;
  lines: LineDraft[];
};

let lineSeq = 0;
function newLine(accountCode = ""): LineDraft {
  lineSeq += 1;
  return { key: `l${lineSeq}`, description: "", expenseAccountCode: accountCode, base: "", taxRate: "21", quota: "", investmentGood: false };
}

function emptyForm(): BillForm {
  return { supplierId: "", supplierName: "", supplierTaxId: "", invoiceNumber: "", issueDate: todayIso(), dueDate: "", retentionRate: "", retentionRowCode: "", payableAccountCode: "", expectedTotal: "", attachment: null, lines: [newLine()] };
}

type LineTotals = { base: number; quota: number; retention: number };

/** What the API will compute per line (cent-rounded base × rate, printed quota when given, base × retention). */
function lineTotals(line: LineDraft, retentionRate: number): LineTotals {
  const base = amountOf(line.base);
  const quota = line.quota.trim() ? amountOf(line.quota) : quotaOf(base, Number(line.taxRate));
  return { base, quota, retention: Math.round(base * retentionRate) / 100 };
}

function formTotals(form: BillForm): LineTotals & { total: number } {
  const retentionRate = amountOf(form.retentionRate);
  const sum = form.lines.reduce<LineTotals>(
    (acc, line) => {
      const t = lineTotals(line, retentionRate);
      return { base: acc.base + t.base, quota: acc.quota + t.quota, retention: acc.retention + t.retention };
    },
    { base: 0, quota: 0, retention: 0 }
  );
  return { ...sum, total: Math.round((sum.base + sum.quota - sum.retention) * 100) / 100 };
}

type FieldErrors = Partial<Record<Exclude<keyof BillForm, "lines">, string>> & { lines?: Record<string, Partial<Record<keyof LineDraft, string>>> };

function validate(form: BillForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.supplierId && !form.supplierName.trim()) errors.supplierName = "Elige un proveedor del directorio o escribe su nombre.";
  if (!form.invoiceNumber.trim()) errors.invoiceNumber = "El número de factura del proveedor es obligatorio.";
  if (!form.issueDate) errors.issueDate = "Indica la fecha de emisión.";
  if (form.dueDate && form.issueDate && form.dueDate < form.issueDate) errors.dueDate = "El vencimiento no puede ser anterior a la emisión.";
  if (form.retentionRate.trim()) {
    const rate = decimalInput(form.retentionRate);
    if (rate === null || Number(rate) < 0 || Number(rate) > 100) errors.retentionRate = "Porcentaje entre 0 y 100.";
    else if (!form.retentionRowCode) errors.retentionRowCode = "Indica en qué modelo se declara la retención.";
  }
  if (form.expectedTotal.trim() && decimalInput(form.expectedTotal) === null) errors.expectedTotal = "Importe con dos decimales como máximo.";
  const lines: NonNullable<FieldErrors["lines"]> = {};
  for (const line of form.lines) {
    const e: Partial<Record<keyof LineDraft, string>> = {};
    if (!line.description.trim()) e.description = "Obligatoria.";
    const code = line.expenseAccountCode.trim();
    if (!code) e.expenseAccountCode = "Elige la cuenta.";
    else if (line.investmentGood ? !isInvestmentAccount(code) && !isExpenseAccount(code) : !isExpenseAccount(code)) e.expenseAccountCode = line.investmentGood ? "Cuenta 20x/21x (o del grupo 6)." : "Subcuenta del grupo 6.";
    const base = decimalInput(line.base);
    if (base === null || Number(base) <= 0) e.base = "Mayor que cero.";
    if (line.quota.trim() && decimalInput(line.quota) === null) e.quota = "Dos decimales como máximo.";
    if (Object.keys(e).length > 0) lines[line.key] = e;
  }
  if (Object.keys(lines).length > 0) errors.lines = lines;
  return errors;
}

function bodyOf(form: BillForm): SupplierBillRequest {
  const retentionRate = form.retentionRate.trim() ? decimalInput(form.retentionRate) : null;
  const expectedTotal = form.expectedTotal.trim() ? decimalInput(form.expectedTotal) : null;
  return {
    supplierId: form.supplierId || null,
    ...(form.supplierId ? {} : { supplierName: form.supplierName.trim(), supplierTaxId: form.supplierTaxId.trim().toUpperCase() || null }),
    invoiceNumber: form.invoiceNumber.trim(),
    issueDate: form.issueDate,
    dueDate: form.dueDate || null,
    retentionRate,
    retentionRowCode: retentionRate && form.retentionRowCode ? (form.retentionRowCode as RetentionRowCode) : null,
    ...(form.payableAccountCode ? { payableAccountCode: form.payableAccountCode } : {}),
    ...(expectedTotal ? { expectedTotal } : {}),
    ...(form.attachment ? { attachment: form.attachment } : {}),
    lines: form.lines.map((line) => {
      const quota = line.quota.trim() ? decimalInput(line.quota) : null;
      return {
        description: line.description.trim(),
        expenseAccountCode: line.expenseAccountCode.trim(),
        base: decimalInput(line.base) ?? "0.00",
        taxRate: line.taxRate,
        ...(quota ? { quota } : {}),
        ...(line.investmentGood ? { investmentGood: true } : {})
      };
    })
  };
}

const COLUMNS: CocoaTableColumn<SupplierBillDto>[] = [
  {
    key: "supplierName",
    label: "Proveedor",
    render: (b) => (
      <>
        <strong>{b.supplierName ?? "—"}</strong>
        <span style={subStyle}>{b.supplierTaxId ?? "Sin NIF"}</span>
      </>
    )
  },
  { key: "invoiceNumber", label: "Nº factura", render: (b) => b.invoiceNumber ?? "—" },
  { key: "issueDate", label: "Emisión", hideOnNarrow: true, render: (b) => date(b.issueDate) },
  { key: "dueDate", label: "Vencimiento", hideOnNarrow: true, render: (b) => date(b.dueDate) },
  { key: "baseTotal", label: "Base", align: "right", hideOnNarrow: true, render: (b) => money(b.baseTotal) },
  { key: "taxTotal", label: "IVA", align: "right", hideOnNarrow: true, render: (b) => money(b.taxTotal) },
  { key: "total", label: FIELD_LABELS.total, align: "right", render: (b) => <strong>{money(b.total)}</strong> },
  { key: "status", label: FIELD_LABELS.status, render: (b) => <CocoaBadge tone={BILL_STATUS_TONES[b.status]}>{BILL_STATUS_LABELS[b.status]}</CocoaBadge> }
];

/** Journal lines of an accrual / payment entry as a list («629 · D 100,00»). */
function EntryLines({ entry, label }: { entry: LedgerEntryDto; label: string }) {
  return (
    <ul className="c22-section__list" aria-label={label}>
      {entry.lines.map((line) => (
        <li key={line.id}>
          <span>
            {line.accountCode}
            <span style={subStyle}>{line.description ?? ""}</span>
          </span>
          <strong>{toNumber(line.debit) ? `D ${money(line.debit)}` : `H ${money(line.credit)}`}</strong>
        </li>
      ))}
    </ul>
  );
}

export function SupplierBillsScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  // Tanda 6b · L7: supplier bills hang from a centre (/properties/:propertyId/payables/…): the «Ámbito» offers every
  // centre, the oficina central included (its bills live there), and defaults to the active hotel.
  const finance = useFinanceScope(financeScopePolicy("SupplierBillsScreen"));
  const propertyId = finance.propertyId ?? finance.active.propertyId;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const bills = useLoader(() => listSupplierBills({ q: search.trim() || undefined, status: (status || undefined) as SupplierBillStatus | undefined, limit: 500 }, propertyId), `${propertyId}|${search}|${status}`, "No se pudieron cargar las facturas recibidas.");
  const aging = useLoader(() => getPayablesAging(undefined, propertyId), `aging|${propertyId}`, "No se pudo calcular la antigüedad de la deuda.");
  const suppliers = useLoader(() => listSuppliers({ active: true, limit: 500 }), "suppliers", "No se pudo cargar el directorio de proveedores.");
  const chart = useChartAccounts();
  const expenseOptions = useMemo(() => accountOptions(chart.accounts, (code) => isExpenseAccount(code) || isInvestmentAccount(code)), [chart.accounts]);
  const treasuryOptions = useMemo(() => accountOptions(chart.accounts, isTreasuryAccount), [chart.accounts]);

  // Detail drawer + actions
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useLoader<SupplierBillDetailDto | null>(() => (selectedId ? getSupplierBill(selectedId, propertyId) : Promise.resolve(null)), `${propertyId}|${selectedId ?? ""}`, "No se pudo cargar la factura.");
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [askPost, setAskPost] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [askPay, setAskPay] = useState(false);
  const [payDate, setPayDate] = useState(todayIso());
  const [payWith, setPayWith] = useState<"bank" | "cash">("bank");
  const [payAccount, setPayAccount] = useState("");
  const [payReference, setPayReference] = useState("");
  const [payError, setPayError] = useState<string | undefined>(undefined);

  // Create drawer
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<BillForm>(emptyForm);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const rows = bills.data ?? [];
  const supplierRows = suppliers.data ?? [];
  const selected = detail.data;
  const newBillLabel = newLabel("f", "factura recibida");
  const errors = validate(form);
  const valid = Object.keys(errors).length === 0;
  const totals = formTotals(form);
  const expectedTotal = form.expectedTotal.trim() ? amountOf(form.expectedTotal) : null;
  const totalMismatch = expectedTotal !== null && Math.abs(expectedTotal - totals.total) >= 0.005;
  const chosenSupplier = supplierRows.find((s) => s.id === form.supplierId) ?? null;

  function refreshAll() {
    bills.refresh();
    aging.refresh();
    if (selectedId) detail.refresh();
  }

  function openNew() {
    setForm(emptyForm());
    setTouched(false);
    setSaveFailure(null);
    setAttachmentError(null);
    setCreating(true);
  }

  function set<K extends keyof BillForm>(key: K, value: BillForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  /** Picking a supplier proposes its retention, its payment term and its usual account on empty lines. */
  function chooseSupplier(id: string) {
    const supplier: SupplierDto | undefined = supplierRows.find((s) => s.id === id);
    setForm((current) => ({
      ...current,
      supplierId: id,
      retentionRate: supplier?.retentionRate ? String(toNumber(supplier.retentionRate) ?? "") : id ? "" : current.retentionRate,
      retentionRowCode: supplier?.retentionRowCode ?? (id ? "" : current.retentionRowCode),
      dueDate: supplier?.paymentTermDays !== null && supplier?.paymentTermDays !== undefined && current.issueDate ? addDays(current.issueDate, supplier.paymentTermDays) : current.dueDate,
      lines: current.lines.map((line) => (line.expenseAccountCode || !supplier?.defaultExpenseAccountCode ? line : { ...line, expenseAccountCode: supplier.defaultExpenseAccountCode }))
    }));
  }

  function setLine(key: string, patch: Partial<LineDraft>) {
    setForm((current) => ({ ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) }));
  }

  function addLine() {
    setForm((current) => ({ ...current, lines: [...current.lines, newLine(chosenSupplier?.defaultExpenseAccountCode ?? "")] }));
  }

  function removeLine(key: string) {
    setForm((current) => (current.lines.length <= 1 ? current : { ...current, lines: current.lines.filter((line) => line.key !== key) }));
  }

  async function attach() {
    setAttachmentError(null);
    const file = await pickFile();
    if (!file) return;
    try {
      const attachment = await readAttachment(file);
      set("attachment", attachment);
    } catch (error: unknown) {
      setAttachmentError(error instanceof Error ? error.message : "No se pudo leer el archivo.");
    }
  }

  async function save() {
    if (saving) return;
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    setSaveFailure(null);
    try {
      const created = await createSupplierBill(bodyOf(form), propertyId);
      showToast(`Factura ${created.invoiceNumber ?? ""} guardada como borrador.`, { variant: "success" });
      setCreating(false);
      bills.refresh();
      setSelectedId(created.id);
    } catch (error: unknown) {
      setSaveFailure(describeFailure(error, "No se pudo guardar la factura. Revisa los datos e inténtalo de nuevo.").message);
    } finally {
      setSaving(false);
    }
  }

  async function run(action: () => Promise<unknown>, success: string, fallback: string) {
    if (!selectedId || busy) return;
    setBusy(true);
    setActionFailure(null);
    try {
      await action();
      showToast(success, { variant: "success" });
      refreshAll();
      return true;
    } catch (error: unknown) {
      setActionFailure(describeFailure(error, fallback).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmPost() {
    if (!selectedId) return;
    const ok = await run(() => postSupplierBill(selectedId, propertyId), "Factura contabilizada: asiento y libro de IVA recibidas anotados.", "No se pudo contabilizar la factura.");
    setAskPost(false);
    if (!ok) return;
  }

  async function confirmPay() {
    if (!selectedId) return;
    if (!payDate) {
      setPayError("Indica la fecha del pago.");
      return;
    }
    const ok = await run(
      () => paySupplierBill(selectedId, { paymentDate: payDate, paidWith: payWith, ...(payAccount ? { counterAccountCode: payAccount } : {}), ...(payReference.trim() ? { reference: payReference.trim() } : {}) }, propertyId),
      "Pago registrado: asiento D proveedor / H tesorería contabilizado.",
      "No se pudo registrar el pago."
    );
    setAskPay(false);
    if (!ok) return;
  }

  async function confirmCancel() {
    const text = reason.trim();
    if (text.length < 3) {
      setReasonError("Indica el motivo (al menos 3 caracteres).");
      return;
    }
    if (!selectedId) return;
    await run(() => cancelSupplierBill(selectedId, { reason: text }, propertyId), "Factura anulada.", "No se pudo anular la factura.");
    setAskCancel(false);
    setReason("");
  }

  async function viewAttachment() {
    if (!selectedId) return;
    setActionFailure(null);
    try {
      const attachment = await getSupplierBillAttachment(selectedId, propertyId);
      if (attachment.inline && attachment.base64 && attachment.mimeType) {
        if (!openInlineAttachment(attachment.base64, attachment.mimeType)) showToast("El navegador bloqueó la ventana del adjunto: permite las ventanas emergentes.", { variant: "warning" });
      } else {
        showToast(attachment.documentObjectKey ? `El adjunto vive en el almacén de documentos (${attachment.documentObjectKey}).` : "La factura no tiene adjunto.", { variant: "info" });
      }
    } catch (error: unknown) {
      setActionFailure(describeFailure(error, "No se pudo abrir el adjunto.").message);
    }
  }

  function openPayDialog() {
    setPayDate(todayIso());
    setPayWith("bank");
    setPayAccount("");
    setPayReference("");
    setPayError(undefined);
    setAskPay(true);
  }

  const ready = !bills.loading && !bills.error && rows.length > 0;
  const filtered = Boolean(search || status);
  const fieldError = (key: Exclude<keyof BillForm, "lines">) => (touched ? errors[key] : undefined);
  const lineError = (key: string, field: keyof LineDraft) => (touched ? errors.lines?.[key]?.[field] : undefined);
  const agingTotals = aging.data?.totals;
  const agingStatus = (value: string | undefined, tone: "warning" | "critical") => ((toNumber(value) ?? 0) > 0 ? tone : "ok");

  let body;
  if (bills.loading && rows.length === 0) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Facturas recibidas" />;
  } else if (bills.error) {
    body = <CocoaState kind="error" title="No se pudieron cargar las facturas recibidas" message={bills.error} onRetry={bills.refresh} />;
  } else if (rows.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={filtered ? "search" : "box"}
        title={filtered ? STATUS_LABELS.noResults : "Aún no hay facturas recibidas"}
        message={filtered ? "Ninguna factura coincide con los filtros." : "Registra las facturas de tus proveedores por líneas: se aprueban, se contabilizan con su IVA y se pagan desde aquí."}
        primaryAction={{ label: newBillLabel, onClick: openNew }}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={rows}
        rowKey="id"
        selectedKey={selectedId ?? undefined}
        onSelect={(b) => {
          setActionFailure(null);
          setSelectedId(b.id);
        }}
        rowTone={(b) => (b.cancelledAt ? "neutral" : b.status === "posted" && b.dueDate && b.dueDate < todayIso() ? "warning" : undefined)}
        caption="Facturas recibidas"
        aria-label="Facturas recibidas"
      />
    );
  }

  const primaryAction =
    selected && !busy
      ? selected.status === "draft"
        ? { label: ACTIONS.approve, onClick: () => void run(() => approveSupplierBill(selected.id, propertyId), "Factura aprobada.", "No se pudo aprobar la factura.") }
        : selected.status === "approved"
          ? { label: "Contabilizar", onClick: () => setAskPost(true) }
          : selected.status === "posted"
            ? { label: "Registrar pago", onClick: openPayDialog }
            : null
      : null;

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title="Facturas recibidas"
      subtitle={hosted ? undefined : "Facturas de proveedores por líneas: borrador, aprobada, contabilizada y pagada, con la antigüedad de la deuda pendiente. Cada factura lleva su centro de trabajo (hotel u oficina central)."}
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={openNew}>
            {newBillLabel}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "supplier-bills-new", label: newBillLabel, run: openNew },
        { id: "supplier-bills-refresh", label: "Actualizar facturas recibidas", run: refreshAll }
      ]}
    >
      <CocoaSection title="Deuda pendiente con proveedores" meta={aging.data ? `a ${date(aging.data.asOf)}` : undefined} aria-label="Antigüedad de la deuda">
        {aging.error ? (
          <CocoaState kind="degraded" inline title={aging.error} />
        ) : (
          <CocoaKpiStrip min={180} aria-label="Deuda por antigüedad">
            <CocoaKpi label="Pendiente" value={agingTotals ? money(agingTotals.outstanding) : "—"} unit={agingTotals ? plural(agingTotals.count, "factura", "facturas") : undefined} degraded={!agingTotals && !aging.loading} />
            <CocoaKpi label="No vencido" value={agingTotals ? money(agingTotals.notDue) : "—"} degraded={!agingTotals && !aging.loading} />
            <CocoaKpi label="1–30 días" value={agingTotals ? money(agingTotals.d1_30) : "—"} status={agingTotals ? agingStatus(agingTotals.d1_30, "warning") : undefined} degraded={!agingTotals && !aging.loading} />
            <CocoaKpi label="31–60 días" value={agingTotals ? money(agingTotals.d31_60) : "—"} status={agingTotals ? agingStatus(agingTotals.d31_60, "warning") : undefined} degraded={!agingTotals && !aging.loading} />
            <CocoaKpi label="61–90 días" value={agingTotals ? money(agingTotals.d61_90) : "—"} status={agingTotals ? agingStatus(agingTotals.d61_90, "critical") : undefined} degraded={!agingTotals && !aging.loading} />
            <CocoaKpi label="Más de 90 días" value={agingTotals ? money(agingTotals.d90plus) : "—"} status={agingTotals ? agingStatus(agingTotals.d90plus, "critical") : undefined} degraded={!agingTotals && !aging.loading} />
          </CocoaKpiStrip>
        )}
      </CocoaSection>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros de facturas recibidas"
        leftSlot={<CocoaSearchInput value={search} onChange={setSearch} debounceMs={250} placeholder="Proveedor, NIF o número…" aria-label="Buscar facturas por proveedor, NIF o número" />}
        rightSlot={<CocoaSelect value={status} onChange={setStatus} size="small" aria-label="Filtrar por estado" options={[{ value: "", label: "Todos los estados" }, ...STATUS_OPTIONS]} />}
      />

      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Listado de facturas recibidas" footer={ready ? <span>{plural(rows.length, "factura", "facturas")}</span> : undefined}>
        {body}
      </CocoaSection>

      {/* Detail drawer */}
      <CocoaDrawer
        open={selectedId !== null}
        onClose={() => (busy ? undefined : setSelectedId(null))}
        title={selected ? `Factura ${selected.invoiceNumber ?? ""}`.trim() : "Factura recibida"}
        subtitle={selected ? `${selected.supplierName ?? "—"} · ${BILL_STATUS_LABELS[selected.status]}` : undefined}
        side="right"
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedId(null)} disabled={busy}>
              {ACTIONS.close}
            </CocoaButton>
            {primaryAction ? (
              <CocoaButton variant="filled" tone="accent" onClick={primaryAction.onClick} loading={busy} disabled={busy}>
                {primaryAction.label}
              </CocoaButton>
            ) : null}
          </>
        }
      >
        {detail.loading && !selected ? (
          <CocoaState kind="loading" title={STATUS_LABELS.loading} />
        ) : detail.error ? (
          <CocoaState kind="error" title="No se pudo cargar la factura" message={detail.error} onRetry={detail.refresh} />
        ) : selected ? (
          <div className="cocoa-stack" data-gap="4">
            {actionFailure ? (
              <CocoaCallout tone="danger" role="alert">
                {actionFailure}
              </CocoaCallout>
            ) : null}
            {selected.status === "cancelled" ? (
              <CocoaCallout tone="warning" title="Factura anulada">
                Anulada el {dateTime(selected.cancelledAt)}. {selected.journalEntryId ? "El asiento de devengo quedó revertido." : "Nunca llegó a contabilizarse."}
              </CocoaCallout>
            ) : null}
            {selected.status === "approved" && !selected.supplierTaxId ? (
              <CocoaCallout tone="warning" title="Sin NIF del proveedor">
                Una factura completa necesita el NIF para el libro de IVA recibidas; para un tique sin NIF usa un gasto menor.
              </CocoaCallout>
            ) : null}

            <div className="cocoa-row" data-gap="2" data-justify="between">
              <span className="cocoa-cluster">
                <CocoaBadge tone={BILL_STATUS_TONES[selected.status]}>{BILL_STATUS_LABELS[selected.status]}</CocoaBadge>
                {selected.hasAttachment ? <CocoaBadge tone="neutral">Con adjunto</CocoaBadge> : null}
                {selected.lines.some((l) => l.investmentGood) ? <CocoaBadge tone="info">Bien de inversión</CocoaBadge> : null}
              </span>
              <span className="cocoa-cluster">
                {selected.hasAttachment ? (
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={() => void viewAttachment()} disabled={busy}>
                    Ver adjunto
                  </CocoaButton>
                ) : null}
                {selected.status === "draft" || selected.status === "approved" || selected.status === "posted" ? (
                  <CocoaButton
                    variant="bordered"
                    tone="destructive"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      setReason("");
                      setReasonError(undefined);
                      setAskCancel(true);
                    }}
                  >
                    Anular
                  </CocoaButton>
                ) : null}
              </span>
            </div>

            <CocoaFormRow columns={4} min={110}>
              <CocoaStat label="Base" value={money(selected.baseTotal)} />
              <CocoaStat label="IVA" value={money(selected.taxTotal)} />
              <CocoaStat label={selected.retentionRate ? `Retención ${percent(selected.retentionRate)}` : "Retención"} value={money(selected.retentionAmount)} />
              <CocoaStat label={FIELD_LABELS.total} value={money(selected.total)} size="large" />
            </CocoaFormRow>

            <ul className="c22-section__list" aria-label="Datos de la factura">
              <li>
                <span style={mutedStyle}>Proveedor</span>
                <strong>{[selected.supplierName, selected.supplierTaxId].filter(Boolean).join(" · ") || "—"}</strong>
              </li>
              <li>
                <span style={mutedStyle}>Emisión · vencimiento</span>
                <strong>
                  {date(selected.issueDate)} · {date(selected.dueDate)}
                </strong>
              </li>
              <li>
                <span style={mutedStyle}>Cuenta de proveedor</span>
                <strong>{accountLabel(chart.accounts, selected.payableAccountCode)}</strong>
              </li>
              {selected.paymentDate ? (
                <li>
                  <span style={mutedStyle}>Pagada el</span>
                  <strong>{date(selected.paymentDate)}</strong>
                </li>
              ) : null}
              {selected.approvedAt ? (
                <li>
                  <span style={mutedStyle}>Aprobada</span>
                  <strong>{dateTime(selected.approvedAt)}</strong>
                </li>
              ) : null}
            </ul>

            <CocoaSection title="Líneas" meta={plural(selected.lines.length, "línea", "líneas")} headingLevel={3}>
              <ul className="c22-section__list" aria-label="Líneas de la factura">
                {selected.lines.map((line) => (
                  <li key={line.id}>
                    <span>
                      {line.description}
                      <span style={subStyle}>
                        {accountLabel(chart.accounts, line.expenseAccountCode)} · IVA {percent(line.taxRate, { maximumFractionDigits: 0 })}
                        {line.investmentGood ? " · bien de inversión" : ""}
                        {toNumber(line.retention) ? ` · retención ${money(line.retention)}` : ""}
                      </span>
                    </span>
                    <strong>{money(line.base)}</strong>
                  </li>
                ))}
              </ul>
            </CocoaSection>

            {selected.accrualEntry ? (
              <CocoaSection title="Asiento de devengo" meta={`Nº ${selected.accrualEntry.entryNumber ?? "—"} · ${date(selected.accrualEntry.entryDate)}`} headingLevel={3}>
                <EntryLines entry={selected.accrualEntry} label="Líneas del asiento de devengo" />
                {selected.vatRows.length > 0 ? <p className="cocoa-caption">{plural(selected.vatRows.length, "fila", "filas")} en el libro de IVA recibidas.</p> : null}
              </CocoaSection>
            ) : null}
            {selected.paymentEntry ? (
              <CocoaSection title="Asiento de pago" meta={`Nº ${selected.paymentEntry.entryNumber ?? "—"} · ${date(selected.paymentEntry.entryDate)}`} headingLevel={3}>
                <EntryLines entry={selected.paymentEntry} label="Líneas del asiento de pago" />
              </CocoaSection>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={askPost}
        onClose={() => setAskPost(false)}
        title={`¿Contabilizar la factura ${selected?.invoiceNumber ?? ""}?`}
        description="Se asienta el devengo (gasto o inmovilizado, IVA soportado y proveedor) con la fecha de emisión y se anota en el libro de IVA recibidas. Las líneas marcadas como bien de inversión dan de alta elementos de inmovilizado."
        confirmLabel="Contabilizar"
        cancelLabel={ACTIONS.cancel}
        onConfirm={confirmPost}
        busy={busy}
      />

      <CocoaDialog
        open={askPay}
        onClose={() => setAskPay(false)}
        title={`Registrar el pago de ${selected ? money(selected.total) : ""}`}
        description="Se asienta D proveedor / H tesorería con la fecha indicada."
        confirmLabel="Registrar pago"
        cancelLabel={ACTIONS.cancel}
        onConfirm={confirmPay}
        busy={busy}
        size="md"
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaFormRow columns={2} min={160}>
            <CocoaField label="Fecha del pago" required error={payError}>
              <CocoaDatePicker
                value={payDate}
                onChange={(v) => {
                  setPayDate(v);
                  setPayError(undefined);
                }}
                min={selected?.issueDate ?? undefined}
                max={todayIso()}
              />
            </CocoaField>
            <CocoaField label="Pagado por">
              <CocoaSegmentedControl
                value={payWith}
                onChange={(v) => {
                  setPayWith(v as "bank" | "cash");
                  setPayAccount("");
                }}
                options={[
                  { value: "bank", label: "Banco" },
                  { value: "cash", label: "Caja" }
                ]}
                size="small"
                fullWidth
                aria-label="Medio de pago"
              />
            </CocoaField>
            <CocoaField label="Cuenta de tesorería" help={`Por defecto ${payWith === "cash" ? "570" : "572"}.`}>
              {treasuryOptions.length > 0 ? (
                <CocoaSelect value={payAccount} onChange={setPayAccount} options={[{ value: "", label: `Por defecto (${payWith === "cash" ? "570" : "572"})` }, ...treasuryOptions]} />
              ) : (
                <CocoaInput value={payAccount} onChange={setPayAccount} placeholder={payWith === "cash" ? "570" : "572"} maxLength={12} />
              )}
            </CocoaField>
            <CocoaField label="Referencia" hint={STATUS_LABELS.optional.toLowerCase()}>
              <CocoaInput value={payReference} onChange={setPayReference} placeholder="Transferencia, remesa…" maxLength={120} />
            </CocoaField>
          </CocoaFormRow>
        </div>
      </CocoaDialog>

      <CocoaDialog
        open={askCancel}
        onClose={() => setAskCancel(false)}
        tone="destructive"
        title={`¿Anular la factura ${selected?.invoiceNumber ?? ""}?`}
        description={selected?.status === "posted" ? "Se contabiliza un asiento de anulación con la fecha de hoy y se retiran sus filas del libro de IVA recibidas." : "La factura queda anulada; no se ha contabilizado nada."}
        confirmLabel="Anular factura"
        cancelLabel={ACTIONS.cancel}
        onConfirm={confirmCancel}
        busy={busy}
      >
        <CocoaField label="Motivo" required error={reasonError}>
          <CocoaInput
            value={reason}
            onChange={(v) => {
              setReason(v);
              setReasonError(undefined);
            }}
            placeholder="Factura duplicada, importe erróneo…"
            maxLength={300}
          />
        </CocoaField>
      </CocoaDialog>

      {/* New bill drawer */}
      <CocoaDrawer
        open={creating}
        onClose={() => (saving ? undefined : setCreating(false))}
        title={newBillLabel}
        subtitle="Se guarda como borrador; después se aprueba y se contabiliza"
        side="right"
        size="lg"
        dismissible={!saving}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setCreating(false)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={saving} disabled={saving || (touched && !valid)}>
              Guardar borrador
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {saveFailure ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo guardar">
              {saveFailure}
            </CocoaCallout>
          ) : null}
          {chart.error ? <CocoaCallout tone="warning">{chart.error}</CocoaCallout> : null}

          <CocoaFormSection title="Proveedor y documento" description={suppliers.error ?? "Elige un proveedor del directorio o escribe su nombre y NIF; sin NIF la factura no podrá contabilizarse."}>
            <CocoaFormRow columns={2}>
              <CocoaField label="Proveedor del directorio" error={fieldError("supplierName")} fullWidth={Boolean(form.supplierId)}>
                <CocoaSelect
                  value={form.supplierId}
                  onChange={chooseSupplier}
                  options={[{ value: "", label: suppliers.error ? "Sin directorio: indica nombre y NIF" : "Sin ficha: indicar nombre y NIF" }, ...supplierRows.map((s) => ({ value: s.id, label: s.taxId ? `${s.name} · ${s.taxId}` : s.name }))]}
                  disabled={saving || suppliers.loading}
                />
              </CocoaField>
              {!form.supplierId ? (
                <>
                  <CocoaField label="Nombre del proveedor" required error={fieldError("supplierName")}>
                    <CocoaInput value={form.supplierName} onChange={(v) => set("supplierName", v)} disabled={saving} />
                  </CocoaField>
                  <CocoaField label="NIF del proveedor" help="Necesario para contabilizar y deducir el IVA.">
                    <CocoaInput value={form.supplierTaxId} onChange={(v) => set("supplierTaxId", v.toUpperCase())} maxLength={20} disabled={saving} />
                  </CocoaField>
                </>
              ) : null}
              <CocoaField label="Nº de factura" required error={fieldError("invoiceNumber")}>
                <CocoaInput value={form.invoiceNumber} onChange={(v) => set("invoiceNumber", v)} placeholder="A-2026-0187" maxLength={60} disabled={saving} />
              </CocoaField>
              <CocoaField label="Fecha de emisión" required error={fieldError("issueDate")}>
                <CocoaDatePicker value={form.issueDate} onChange={(v) => set("issueDate", v)} max={todayIso()} disabled={saving} />
              </CocoaField>
              <CocoaField label="Vencimiento" error={fieldError("dueDate")} hint={STATUS_LABELS.optional.toLowerCase()}>
                <CocoaDatePicker value={form.dueDate} onChange={(v) => set("dueDate", v)} min={form.issueDate || undefined} disabled={saving} />
              </CocoaField>
              <CocoaField label="Cuenta de proveedor" help="400 para compras (60x), 410 para servicios.">
                <CocoaSelect value={form.payableAccountCode} onChange={(v) => set("payableAccountCode", v as BillForm["payableAccountCode"])} options={PAYABLE_ACCOUNT_OPTIONS} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="Líneas" description="Una línea por concepto: cuenta del grupo 6 (o 20x/21x si es un bien de inversión), base y tipo de IVA. La cuota se calcula; escribe la impresa si difiere en céntimos.">
            <div className="cocoa-stack" data-gap="3">
              {form.lines.map((line, index) => {
                const t = lineTotals(line, amountOf(form.retentionRate));
                return (
                  <CocoaCard key={line.key} variant="bordered" padding="sm" role="group" aria-label={`Línea ${index + 1}`}>
                    <div className="cocoa-stack" data-gap="2">
                      <div className="cocoa-row" data-gap="2" data-justify="between">
                        <strong>Línea {index + 1}</strong>
                        <span className="cocoa-cluster">
                          <span className="cocoa-caption">{`Base ${money(t.base)} · IVA ${money(t.quota)}`}</span>
                          <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => removeLine(line.key)} disabled={saving || form.lines.length <= 1}>
                            {ACTIONS.remove}
                          </CocoaButton>
                        </span>
                      </div>
                      <CocoaFormRow columns={2} min={180}>
                        <CocoaField label={FIELD_LABELS.description} required error={lineError(line.key, "description")} fullWidth>
                          <CocoaInput value={line.description} onChange={(v) => setLine(line.key, { description: v })} placeholder="Lavandería de ropa de cama, agosto" maxLength={300} disabled={saving} />
                        </CocoaField>
                        <CocoaField label="Cuenta" required error={lineError(line.key, "expenseAccountCode")}>
                          {chart.accounts.length > 0 ? (
                            <CocoaSelect value={line.expenseAccountCode} onChange={(v) => setLine(line.key, { expenseAccountCode: v })} options={expenseOptions} placeholder="Elige la cuenta" disabled={saving} />
                          ) : (
                            <CocoaInput value={line.expenseAccountCode} onChange={(v) => setLine(line.key, { expenseAccountCode: v })} placeholder="629" maxLength={12} disabled={saving || chart.loading} />
                          )}
                        </CocoaField>
                        <CocoaField label="Bien de inversión" inline help="Da de alta un elemento de inmovilizado al contabilizar.">
                          <CocoaSwitch checked={line.investmentGood} onChange={(v) => setLine(line.key, { investmentGood: v })} size="small" disabled={saving} />
                        </CocoaField>
                      </CocoaFormRow>
                      <CocoaFormRow columns={3} min={120}>
                        <CocoaField label="Base imponible" required error={lineError(line.key, "base")}>
                          <CocoaInput value={line.base} onChange={(v) => setLine(line.key, { base: v })} inputMode="decimal" placeholder="100,00" disabled={saving} />
                        </CocoaField>
                        <CocoaField label="Tipo de IVA" required>
                          <CocoaSelect value={line.taxRate} onChange={(v) => setLine(line.key, { taxRate: v })} options={TAX_RATE_OPTIONS} disabled={saving} />
                        </CocoaField>
                        <CocoaField label="Cuota impresa" error={lineError(line.key, "quota")} hint={STATUS_LABELS.optional.toLowerCase()}>
                          <CocoaInput value={line.quota} onChange={(v) => setLine(line.key, { quota: v })} inputMode="decimal" placeholder={to2(quotaOf(amountOf(line.base), Number(line.taxRate))).replace(".", ",")} disabled={saving} />
                        </CocoaField>
                      </CocoaFormRow>
                    </div>
                  </CocoaCard>
                );
              })}
              <div className="cocoa-row" data-gap="2">
                <CocoaButton variant="tinted" tone="accent" size="small" onClick={addLine} disabled={saving}>
                  Añadir línea
                </CocoaButton>
              </div>
            </div>
          </CocoaFormSection>

          <CocoaFormSection title="Retención y totales" description="La retención se aplica a la base de cada línea y se declara en el modelo indicado.">
            <CocoaFormRow columns={2}>
              <CocoaField label="Retención IRPF (%)" error={fieldError("retentionRate")} hint={STATUS_LABELS.optional.toLowerCase()}>
                <CocoaInput value={form.retentionRate} onChange={(v) => set("retentionRate", v)} inputMode="decimal" placeholder="15" disabled={saving} />
              </CocoaField>
              <CocoaField label="Modelo de la retención" error={fieldError("retentionRowCode")}>
                <CocoaSelect value={form.retentionRowCode} onChange={(v) => set("retentionRowCode", v)} options={[{ value: "", label: "Sin retención" }, ...RETENTION_ROW_OPTIONS]} disabled={saving || !form.retentionRate.trim()} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaFormRow columns={4} min={110}>
              <CocoaStat label="Base" value={money(totals.base)} />
              <CocoaStat label="IVA" value={money(totals.quota)} />
              <CocoaStat label="Retención" value={money(totals.retention)} />
              <CocoaStat label={FIELD_LABELS.total} value={money(totals.total)} size="large" />
            </CocoaFormRow>
            <CocoaFormRow columns={2}>
              <CocoaField label="Total impreso en la factura" error={fieldError("expectedTotal")} hint={STATUS_LABELS.optional.toLowerCase()} help="Si no coincide con las líneas, la factura no se guarda.">
                <CocoaInput value={form.expectedTotal} onChange={(v) => set("expectedTotal", v)} inputMode="decimal" placeholder={to2(totals.total).replace(".", ",")} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
            {totalMismatch ? (
              <CocoaCallout tone="warning" role="status">
                El total impreso ({money(expectedTotal)}) no coincide con la suma de las líneas ({money(totals.total)}): revisa las cuotas o el total.
              </CocoaCallout>
            ) : null}
          </CocoaFormSection>

          <CocoaFormSection title="Adjunto" description="PDF, JPEG o PNG de hasta 512 KiB; se guarda con la factura.">
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void attach()} disabled={saving}>
                {form.attachment ? "Cambiar archivo" : "Adjuntar archivo"}
              </CocoaButton>
              {form.attachment ? (
                <>
                  <span>{form.attachment.fileName}</span>
                  <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => set("attachment", null)} disabled={saving}>
                    {ACTIONS.remove}
                  </CocoaButton>
                </>
              ) : (
                <span style={mutedStyle}>Sin archivo</span>
              )}
            </div>
            {attachmentError ? (
              <CocoaCallout tone="danger" role="alert">
                {attachmentError}
              </CocoaCallout>
            ) : null}
          </CocoaFormSection>
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default SupplierBillsScreen;
