// Formulario de factura recibida (Tanda T9 · lote T9-04, extracted from
// SupplierBillsScreen.tsx · Tanda 6 lote 6-E): the line-based form that
// SupplierBillsScreen paints inside its «Nueva factura» CocoaDrawer (its
// <CocoaPage> host) and that the document review pane of Documentos y
// digitalización mounts to correct the bill the IA proposed
// (docs/design/DOCUMENTOS-DIGITALIZACION.md §10 «Bandeja y revisión»), so it
// has no header of its own. Supplier from the directory or free name + NIF,
// 6xx / 20x-21x postable account picker without headers (chart from
// `useChartAccounts` of payables-shared.ts, passed in by the screen), VAT per
// rate, printed quota, 15/7 % retention with its 111/115 row, printed total
// check, inline attachment ≤ 512 KiB (create mode only).
//
// Controlled: the screen owns the `BillForm` state (`value` / `onChange`) and
// decides when the errors of `validateBillForm` are painted (after the first
// save attempt). The pure helpers travel with the component:
//   · emptyBillForm()              — the blank form (today as issue date)
//   · validateBillForm(form)       — Spanish field errors, per line too
//   · billFormTotals(form)         — base · quota · retention · total as the API computes them
//   · billFormToRequest(form)      — the SupplierBillRequest body
//   · billFormFromRequest(request) — the form pre-filled from a proposal (IA extraction)

import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { InlineAttachment, RetentionRowCode, SupplierBillRequest } from "@hotelos/shared";
import type { SupplierDto } from "../../services/payablesApi";
import { money, toNumber } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { CocoaButton, CocoaCallout, CocoaCard, CocoaDatePicker, CocoaField, CocoaFormRow, CocoaFormSection, CocoaInput, CocoaSelect, CocoaStat, CocoaSwitch } from "../../components/cocoa";
import type { ChartState } from "./payables-shared";
import {
  PAYABLE_ACCOUNT_OPTIONS,
  RETENTION_ROW_OPTIONS,
  TAX_RATE_OPTIONS,
  accountOptions,
  addDays,
  amountOf,
  decimalInput,
  isExpenseAccount,
  isInvestmentAccount,
  pickFile,
  quotaOf,
  readAttachment,
  to2,
  todayIso
} from "./payables-helpers";

// Label of a detail row («Sin archivo»): label secondary.
const mutedStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

// ---------------------------------------------------------------------------
// State shape and pure helpers
// ---------------------------------------------------------------------------

export type LineDraft = { key: string; description: string; expenseAccountCode: string; base: string; taxRate: string; quota: string; investmentGood: boolean };

export type PayableAccountChoice = "" | "400" | "410" | "4100" | "4109";

export type BillForm = {
  supplierId: string;
  supplierName: string;
  supplierTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  retentionRate: string;
  retentionRowCode: string;
  payableAccountCode: PayableAccountChoice;
  expectedTotal: string;
  attachment: InlineAttachment | null;
  lines: LineDraft[];
};

let lineSeq = 0;
/** A blank line with a fresh key (the supplier's usual account when given). */
export function newLine(accountCode = ""): LineDraft {
  lineSeq += 1;
  return { key: `l${lineSeq}`, description: "", expenseAccountCode: accountCode, base: "", taxRate: "21", quota: "", investmentGood: false };
}

export function emptyBillForm(): BillForm {
  return { supplierId: "", supplierName: "", supplierTaxId: "", invoiceNumber: "", issueDate: todayIso(), dueDate: "", retentionRate: "", retentionRowCode: "", payableAccountCode: "", expectedTotal: "", attachment: null, lines: [newLine()] };
}

export type LineTotals = { base: number; quota: number; retention: number };

/** What the API will compute per line (cent-rounded base × rate, printed quota when given, base × retention). */
export function lineTotals(line: LineDraft, retentionRate: number): LineTotals {
  const base = amountOf(line.base);
  const quota = line.quota.trim() ? amountOf(line.quota) : quotaOf(base, Number(line.taxRate));
  return { base, quota, retention: Math.round(base * retentionRate) / 100 };
}

export function billFormTotals(form: BillForm): LineTotals & { total: number } {
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

export type BillFormErrors = Partial<Record<Exclude<keyof BillForm, "lines">, string>> & { lines?: Record<string, Partial<Record<keyof LineDraft, string>>> };

export function validateBillForm(form: BillForm): BillFormErrors {
  const errors: BillFormErrors = {};
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
  const lines: NonNullable<BillFormErrors["lines"]> = {};
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

export function billFormToRequest(form: BillForm): SupplierBillRequest {
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

const PAYABLE_ACCOUNT_CHOICES = new Set<string>(PAYABLE_ACCOUNT_OPTIONS.map((o) => o.value));

/** Wire decimal («100.00») as the user would type it («100,00»); empty when absent. */
function decimalDisplay(value: number | string | null | undefined): string {
  const parsed = toNumber(value);
  return parsed === null ? "" : to2(parsed).replace(".", ",");
}

/** Wire rate («15.00» · «7.5») without trailing zeros («15» · «7,5»); empty when absent. */
function rateDisplay(value: number | string | null | undefined): string {
  const parsed = toNumber(value);
  return parsed === null ? "" : String(parsed).replace(".", ",");
}

/** The form pre-filled from a request body — the proposal of a digitised document — with fresh line keys; unknown codes fall back to empty. */
export function billFormFromRequest(request: SupplierBillRequest): BillForm {
  const lines = (request.lines ?? []).map((line) => ({
    ...newLine(),
    description: line.description ?? "",
    expenseAccountCode: line.expenseAccountCode ?? "",
    base: decimalDisplay(line.base),
    taxRate: rateDisplay(line.taxRate) || "21",
    quota: decimalDisplay(line.quota),
    investmentGood: Boolean(line.investmentGood)
  }));
  const payableAccountCode = request.payableAccountCode && PAYABLE_ACCOUNT_CHOICES.has(request.payableAccountCode) ? (request.payableAccountCode as PayableAccountChoice) : "";
  return {
    supplierId: request.supplierId ?? "",
    supplierName: request.supplierName ?? "",
    supplierTaxId: request.supplierTaxId ?? "",
    invoiceNumber: request.invoiceNumber ?? "",
    issueDate: request.issueDate ?? "",
    dueDate: request.dueDate ?? "",
    retentionRate: rateDisplay(request.retentionRate),
    retentionRowCode: request.retentionRowCode ?? "",
    payableAccountCode,
    expectedTotal: decimalDisplay(request.expectedTotal),
    attachment: request.attachment ?? null,
    lines: lines.length > 0 ? lines : [newLine()]
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SupplierBillFormProps {
  value: BillForm;
  onChange: (next: BillForm) => void;
  /** Errors to paint (`validateBillForm`); the screen passes them only after the first save attempt. */
  errors?: BillFormErrors;
  /** Chart of accounts for the 6xx / 20x-21x picker (`useChartAccounts` of payables-shared.ts); a free code input when empty. */
  accounts: ChartState;
  /** Supplier directory for the first picker; `error` is painted as the section description. */
  suppliers: { rows: SupplierDto[]; loading?: boolean; error?: string | null };
  /** `create` (default): manual entry with an inline attachment · `review`: correcting the proposal of a digitised document (the file is the document itself: no attachment section). */
  mode?: "create" | "review";
  /** Supplier, number and dates painted but not editable (they come from the document). */
  readOnlyHeader?: boolean;
  /** Every control disabled (saving). */
  disabled?: boolean;
}

export function SupplierBillForm({ value, onChange, errors = {}, accounts, suppliers, mode = "create", readOnlyHeader = false, disabled = false }: SupplierBillFormProps) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const supplierRows = suppliers.rows;
  const expenseOptions = useMemo(() => accountOptions(accounts.accounts, (code) => isExpenseAccount(code) || isInvestmentAccount(code)), [accounts.accounts]);
  const chosenSupplier = supplierRows.find((s) => s.id === value.supplierId) ?? null;
  const totals = billFormTotals(value);
  const expectedTotal = value.expectedTotal.trim() ? amountOf(value.expectedTotal) : null;
  const totalMismatch = expectedTotal !== null && Math.abs(expectedTotal - totals.total) >= 0.005;
  const headerDisabled = disabled || readOnlyHeader;
  const fieldError = (key: Exclude<keyof BillForm, "lines">) => errors[key];
  const lineError = (key: string, field: keyof LineDraft) => errors.lines?.[key]?.[field];

  function set<K extends keyof BillForm>(key: K, next: BillForm[K]) {
    onChange({ ...value, [key]: next });
  }

  /** Picking a supplier proposes its retention, its payment term and its usual account on empty lines. */
  function chooseSupplier(id: string) {
    const supplier: SupplierDto | undefined = supplierRows.find((s) => s.id === id);
    onChange({
      ...value,
      supplierId: id,
      retentionRate: supplier?.retentionRate ? String(toNumber(supplier.retentionRate) ?? "") : id ? "" : value.retentionRate,
      retentionRowCode: supplier?.retentionRowCode ?? (id ? "" : value.retentionRowCode),
      dueDate: supplier?.paymentTermDays !== null && supplier?.paymentTermDays !== undefined && value.issueDate ? addDays(value.issueDate, supplier.paymentTermDays) : value.dueDate,
      lines: value.lines.map((line) => (line.expenseAccountCode || !supplier?.defaultExpenseAccountCode ? line : { ...line, expenseAccountCode: supplier.defaultExpenseAccountCode }))
    });
  }

  function setLine(key: string, patch: Partial<LineDraft>) {
    onChange({ ...value, lines: value.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) });
  }

  function addLine() {
    onChange({ ...value, lines: [...value.lines, newLine(chosenSupplier?.defaultExpenseAccountCode ?? "")] });
  }

  function removeLine(key: string) {
    if (value.lines.length <= 1) return;
    onChange({ ...value, lines: value.lines.filter((line) => line.key !== key) });
  }

  async function attach() {
    setAttachmentError(null);
    const file = await pickFile();
    if (!file) return;
    try {
      const attachment = await readAttachment(file);
      onChange({ ...valueRef.current, attachment });
    } catch (error: unknown) {
      setAttachmentError(error instanceof Error ? error.message : "No se pudo leer el archivo.");
    }
  }

  return (
    <div className="cocoa-stack" data-gap="4">
      {accounts.error ? <CocoaCallout tone="warning">{accounts.error}</CocoaCallout> : null}

      <CocoaFormSection title="Proveedor y documento" description={suppliers.error ?? (mode === "review" ? "Datos leídos del documento: elige la ficha del proveedor o corrige el nombre y el NIF; sin NIF la factura no podrá contabilizarse." : "Elige un proveedor del directorio o escribe su nombre y NIF; sin NIF la factura no podrá contabilizarse.")}>
        <CocoaFormRow columns={2}>
          <CocoaField label="Proveedor del directorio" error={fieldError("supplierName")} fullWidth={Boolean(value.supplierId)}>
            <CocoaSelect
              value={value.supplierId}
              onChange={chooseSupplier}
              options={[{ value: "", label: suppliers.error ? "Sin directorio: indica nombre y NIF" : "Sin ficha: indicar nombre y NIF" }, ...supplierRows.map((s) => ({ value: s.id, label: s.taxId ? `${s.name} · ${s.taxId}` : s.name }))]}
              disabled={headerDisabled || Boolean(suppliers.loading)}
            />
          </CocoaField>
          {!value.supplierId ? (
            <>
              <CocoaField label="Nombre del proveedor" required error={fieldError("supplierName")}>
                <CocoaInput value={value.supplierName} onChange={(v) => set("supplierName", v)} disabled={headerDisabled} />
              </CocoaField>
              <CocoaField label="NIF del proveedor" help="Necesario para contabilizar y deducir el IVA.">
                <CocoaInput value={value.supplierTaxId} onChange={(v) => set("supplierTaxId", v.toUpperCase())} maxLength={20} disabled={headerDisabled} />
              </CocoaField>
            </>
          ) : null}
          <CocoaField label="Nº de factura" required error={fieldError("invoiceNumber")}>
            <CocoaInput value={value.invoiceNumber} onChange={(v) => set("invoiceNumber", v)} placeholder="A-2026-0187" maxLength={60} disabled={headerDisabled} />
          </CocoaField>
          <CocoaField label="Fecha de emisión" required error={fieldError("issueDate")}>
            <CocoaDatePicker value={value.issueDate} onChange={(v) => set("issueDate", v)} max={todayIso()} disabled={headerDisabled} />
          </CocoaField>
          <CocoaField label="Vencimiento" error={fieldError("dueDate")} hint={STATUS_LABELS.optional.toLowerCase()}>
            <CocoaDatePicker value={value.dueDate} onChange={(v) => set("dueDate", v)} min={value.issueDate || undefined} disabled={headerDisabled} />
          </CocoaField>
          <CocoaField label="Cuenta de proveedor" help="400 para compras (60x), 410 para servicios.">
            <CocoaSelect value={value.payableAccountCode} onChange={(v) => set("payableAccountCode", v as BillForm["payableAccountCode"])} options={PAYABLE_ACCOUNT_OPTIONS} disabled={disabled} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Líneas" description="Una línea por concepto: cuenta del grupo 6 (o 20x/21x si es un bien de inversión), base y tipo de IVA. La cuota se calcula; escribe la impresa si difiere en céntimos.">
        <div className="cocoa-stack" data-gap="3">
          {value.lines.map((line, index) => {
            const t = lineTotals(line, amountOf(value.retentionRate));
            return (
              <CocoaCard key={line.key} variant="bordered" padding="sm" role="group" aria-label={`Línea ${index + 1}`}>
                <div className="cocoa-stack" data-gap="2">
                  <div className="cocoa-row" data-gap="2" data-justify="between">
                    <strong>Línea {index + 1}</strong>
                    <span className="cocoa-cluster">
                      <span className="cocoa-caption">{`Base ${money(t.base)} · IVA ${money(t.quota)}`}</span>
                      <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => removeLine(line.key)} disabled={disabled || value.lines.length <= 1}>
                        {ACTIONS.remove}
                      </CocoaButton>
                    </span>
                  </div>
                  <CocoaFormRow columns={2} min={180}>
                    <CocoaField label={FIELD_LABELS.description} required error={lineError(line.key, "description")} fullWidth>
                      <CocoaInput value={line.description} onChange={(v) => setLine(line.key, { description: v })} placeholder="Lavandería de ropa de cama, agosto" maxLength={300} disabled={disabled} />
                    </CocoaField>
                    <CocoaField label="Cuenta" required error={lineError(line.key, "expenseAccountCode")}>
                      {accounts.accounts.length > 0 ? (
                        <CocoaSelect value={line.expenseAccountCode} onChange={(v) => setLine(line.key, { expenseAccountCode: v })} options={expenseOptions} placeholder="Elige la cuenta" disabled={disabled} />
                      ) : (
                        <CocoaInput value={line.expenseAccountCode} onChange={(v) => setLine(line.key, { expenseAccountCode: v })} placeholder="629" maxLength={12} disabled={disabled || accounts.loading} />
                      )}
                    </CocoaField>
                    <CocoaField label="Bien de inversión" inline help="Da de alta un elemento de inmovilizado al contabilizar.">
                      <CocoaSwitch checked={line.investmentGood} onChange={(v) => setLine(line.key, { investmentGood: v })} size="small" disabled={disabled} />
                    </CocoaField>
                  </CocoaFormRow>
                  <CocoaFormRow columns={3} min={120}>
                    <CocoaField label="Base imponible" required error={lineError(line.key, "base")}>
                      <CocoaInput value={line.base} onChange={(v) => setLine(line.key, { base: v })} inputMode="decimal" placeholder="100,00" disabled={disabled} />
                    </CocoaField>
                    <CocoaField label="Tipo de IVA" required>
                      <CocoaSelect value={line.taxRate} onChange={(v) => setLine(line.key, { taxRate: v })} options={TAX_RATE_OPTIONS} disabled={disabled} />
                    </CocoaField>
                    <CocoaField label="Cuota impresa" error={lineError(line.key, "quota")} hint={STATUS_LABELS.optional.toLowerCase()}>
                      <CocoaInput value={line.quota} onChange={(v) => setLine(line.key, { quota: v })} inputMode="decimal" placeholder={to2(quotaOf(amountOf(line.base), Number(line.taxRate))).replace(".", ",")} disabled={disabled} />
                    </CocoaField>
                  </CocoaFormRow>
                </div>
              </CocoaCard>
            );
          })}
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="tinted" tone="accent" size="small" onClick={addLine} disabled={disabled}>
              Añadir línea
            </CocoaButton>
          </div>
        </div>
      </CocoaFormSection>

      <CocoaFormSection title="Retención y totales" description="La retención se aplica a la base de cada línea y se declara en el modelo indicado.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Retención IRPF (%)" error={fieldError("retentionRate")} hint={STATUS_LABELS.optional.toLowerCase()}>
            <CocoaInput value={value.retentionRate} onChange={(v) => set("retentionRate", v)} inputMode="decimal" placeholder="15" disabled={disabled} />
          </CocoaField>
          <CocoaField label="Modelo de la retención" error={fieldError("retentionRowCode")}>
            <CocoaSelect value={value.retentionRowCode} onChange={(v) => set("retentionRowCode", v)} options={[{ value: "", label: "Sin retención" }, ...RETENTION_ROW_OPTIONS]} disabled={disabled || !value.retentionRate.trim()} />
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
            <CocoaInput value={value.expectedTotal} onChange={(v) => set("expectedTotal", v)} inputMode="decimal" placeholder={to2(totals.total).replace(".", ",")} disabled={disabled} />
          </CocoaField>
        </CocoaFormRow>
        {totalMismatch ? (
          <CocoaCallout tone="warning" role="status">
            El total impreso ({money(expectedTotal)}) no coincide con la suma de las líneas ({money(totals.total)}): revisa las cuotas o el total.
          </CocoaCallout>
        ) : null}
      </CocoaFormSection>

      {mode === "create" ? (
        <CocoaFormSection title="Adjunto" description="PDF, JPEG o PNG de hasta 512 KiB; se guarda con la factura.">
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void attach()} disabled={disabled}>
              {value.attachment ? "Cambiar archivo" : "Adjuntar archivo"}
            </CocoaButton>
            {value.attachment ? (
              <>
                <span>{value.attachment.fileName}</span>
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => set("attachment", null)} disabled={disabled}>
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
      ) : null}
    </div>
  );
}

export default SupplierBillForm;
