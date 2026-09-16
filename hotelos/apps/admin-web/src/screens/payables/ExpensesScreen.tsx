// Gastos — /finanzas/proveedores/gastos (Tanda 6 · Finanzas · lote 6-E).
//
// Cocoa 22 «lista / tabla» (docs/design/COCOA-22.md §4, pilot GuestsListScreen)
// with a quick form in a CocoaDrawer: CocoaPage → CocoaToolbar (day window,
// payment means, cancelled switch, search) → CocoaSection padding none →
// CocoaTable with a totals footer (a row opens the expense detail: fields,
// journal lines, reversal) → «Nuevo gasto» drawer (date, supplier, NIF,
// concept, 6xx account picker, base, VAT rate, quota, paid with cash / card /
// bank, deductible switch that the «sin NIF no deduce IVA» rule disables,
// receipt ≤ 512 KiB). Registering posts the entry at once (D 6xx / D 472 /
// H 570·5721·572); the reversal asks for a reason in a CocoaDialog.
//
// Reads services/payablesApi.ts: listExpenses · getExpense · createExpense ·
// reverseExpense; the account picker reads GET /accounting/chart?postableOnly=1.

import { useMemo, useState, type CSSProperties } from "react";
import type { ExpensePaidWith, InlineAttachment } from "@hotelos/shared";
import { createExpense, getExpense, listExpenses, reverseExpense, type ExpenseDetailDto, type ExpenseDto, type ExpenseRequest } from "../../services/payablesApi";
import { getActivePropertyName } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { date, dateTime, money, percent, plural, toNumber } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
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
  EXPENSE_COUNTER_ACCOUNT_OPTIONS,
  PAID_WITH_DEFAULT_ACCOUNT,
  PAID_WITH_LABELS,
  TAX_RATE_OPTIONS,
  accountLabel,
  accountOptions,
  amountOf,
  decimalInput,
  describeFailure,
  isExpenseAccount,
  pickFile,
  quotaOf,
  readAttachment,
  to2,
  todayIso,
  useChartAccounts,
  useLoader
} from "./payables-shared";

// Secondary line under a cell value (NIF, account): caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};
// Label of a detail row.
const mutedStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

const PAID_WITH_OPTIONS = (["cash", "card", "bank"] as ExpensePaidWith[]).map((value) => ({ value, label: PAID_WITH_LABELS[value] }));

type ExpenseForm = {
  date: string;
  supplierName: string;
  supplierNif: string;
  concept: string;
  accountCode: string;
  base: string;
  taxRate: string;
  /** Printed quota typed by the user; empty = base × rate. */
  quota: string;
  paidWith: ExpensePaidWith;
  counterAccountCode: "" | "570" | "572" | "5721" | "5722";
  vatDeductible: boolean;
  attachment: InlineAttachment | null;
};

function emptyForm(): ExpenseForm {
  return { date: todayIso(), supplierName: "", supplierNif: "", concept: "", accountCode: "", base: "", taxRate: "21", quota: "", paidWith: "cash", counterAccountCode: "", vatDeductible: false, attachment: null };
}

type FieldErrors = Partial<Record<keyof ExpenseForm, string>>;

function validate(form: ExpenseForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.date) errors.date = "Indica la fecha del gasto.";
  if (!form.supplierName.trim()) errors.supplierName = "Indica quién cobró el gasto.";
  if (!form.concept.trim()) errors.concept = "El concepto es obligatorio.";
  if (!form.accountCode.trim()) errors.accountCode = "Elige la cuenta de gasto.";
  else if (!isExpenseAccount(form.accountCode.trim())) errors.accountCode = "La cuenta debe ser una subcuenta del grupo 6.";
  const base = decimalInput(form.base);
  if (base === null || Number(base) <= 0) errors.base = "Importe mayor que cero con dos decimales como máximo.";
  if (form.quota.trim() && decimalInput(form.quota) === null) errors.quota = "Cuota con dos decimales como máximo.";
  return errors;
}

function bodyOf(form: ExpenseForm): ExpenseRequest {
  const nif = form.supplierNif.trim().toUpperCase();
  const quota = form.quota.trim() ? decimalInput(form.quota) : null;
  return {
    date: form.date,
    supplierName: form.supplierName.trim(),
    supplierNif: nif || null,
    concept: form.concept.trim(),
    accountCode: form.accountCode.trim(),
    base: decimalInput(form.base) ?? "0.00",
    taxRate: form.taxRate,
    ...(quota ? { quota } : {}),
    paidWith: form.paidWith,
    ...(form.counterAccountCode ? { counterAccountCode: form.counterAccountCode } : {}),
    vatDeductible: nif ? form.vatDeductible : false,
    ...(form.attachment ? { attachment: form.attachment } : {})
  };
}

const COLUMNS: CocoaTableColumn<ExpenseDto>[] = [
  { key: "date", label: FIELD_LABELS.date, width: "11ch", render: (e) => date(e.date) },
  {
    key: "supplierName",
    label: "Proveedor",
    render: (e) => (
      <>
        <strong>{e.supplierName}</strong>
        <span style={subStyle}>{e.supplierNif ?? "Sin NIF"}</span>
      </>
    )
  },
  {
    key: "concept",
    label: "Concepto",
    hideOnNarrow: true,
    render: (e) => (
      <>
        {e.concept}
        <span style={subStyle}>Cuenta {e.accountCode}</span>
      </>
    )
  },
  { key: "paidWith", label: "Pagado con", hideOnNarrow: true, render: (e) => <CocoaBadge tone="neutral">{PAID_WITH_LABELS[e.paidWith]}</CocoaBadge> },
  { key: "base", label: "Base", align: "right", hideOnNarrow: true, render: (e) => money(e.base) },
  {
    key: "quota",
    label: "IVA",
    align: "right",
    hideOnNarrow: true,
    render: (e) => (
      <>
        {money(e.quota)}
        {!e.vatDeductible && toNumber(e.quota) ? <span style={subStyle}>no deducible</span> : null}
      </>
    )
  },
  { key: "total", label: FIELD_LABELS.total, align: "right", render: (e) => <strong>{money(e.total)}</strong> },
  {
    key: "status",
    label: FIELD_LABELS.status,
    render: (e) => (e.cancelledAt ? <CocoaBadge tone="danger">Anulado</CocoaBadge> : <CocoaBadge tone="success">Contabilizado</CocoaBadge>)
  }
];

export function ExpensesScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [paidWith, setPaidWith] = useState("");
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const list = useLoader(
    () =>
      listExpenses({
        q: search.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
        paidWith: (paidWith || undefined) as ExpensePaidWith | undefined,
        includeCancelled: includeCancelled || undefined,
        limit: 500
      }),
    `${search}|${from}|${to}|${paidWith}|${includeCancelled}`,
    "No se pudieron cargar los gastos."
  );
  const chart = useChartAccounts();
  const expenseOptions = useMemo(() => accountOptions(chart.accounts, isExpenseAccount), [chart.accounts]);

  // Detail drawer
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useLoader<ExpenseDetailDto | null>(() => (selectedId ? getExpense(selectedId) : Promise.resolve(null)), selectedId ?? "", "No se pudo cargar el gasto.");
  const [askReverse, setAskReverse] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);

  // Create drawer
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ExpenseForm>(emptyForm);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const expenses = list.data ?? [];
  const live = expenses.filter((e) => !e.cancelledAt);
  const totals = {
    base: live.reduce((sum, e) => sum + (toNumber(e.base) ?? 0), 0),
    quota: live.reduce((sum, e) => sum + (toNumber(e.quota) ?? 0), 0),
    total: live.reduce((sum, e) => sum + (toNumber(e.total) ?? 0), 0)
  };
  const newExpenseLabel = newLabel("m", "gasto");
  const errors = validate(form);
  const valid = Object.keys(errors).length === 0;
  const hasNif = form.supplierNif.trim().length > 0;
  const baseNumber = amountOf(form.base);
  const rateNumber = Number(form.taxRate);
  const quotaNumber = form.quota.trim() ? amountOf(form.quota) : quotaOf(baseNumber, rateNumber);
  const totalNumber = baseNumber + quotaNumber;

  function openNew() {
    setForm(emptyForm());
    setTouched(false);
    setSaveFailure(null);
    setAttachmentError(null);
    setCreating(true);
  }

  function set<K extends keyof ExpenseForm>(key: K, value: ExpenseForm[K]) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      // A NIF that appears turns the deduction on; one that disappears turns it off (400 without NIF).
      if (key === "supplierNif") next.vatDeductible = String(value).trim().length > 0;
      return next;
    });
  }

  async function attach() {
    setAttachmentError(null);
    const file = await pickFile();
    if (!file) return;
    try {
      const attachment = await readAttachment(file);
      setForm((current) => ({ ...current, attachment }));
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
      const created = await createExpense(bodyOf(form));
      showToast(`Gasto de ${money(created.total)} contabilizado.`, { variant: "success" });
      setCreating(false);
      list.refresh();
    } catch (error: unknown) {
      setSaveFailure(describeFailure(error, "No se pudo registrar el gasto. Revisa los datos e inténtalo de nuevo.").message);
    } finally {
      setSaving(false);
    }
  }

  async function reverse() {
    const text = reason.trim();
    if (text.length < 3) {
      setReasonError("Indica el motivo (al menos 3 caracteres).");
      return;
    }
    if (!selectedId) return;
    setBusy(true);
    setActionFailure(null);
    try {
      await reverseExpense(selectedId, { reason: text });
      showToast("Gasto anulado: el asiento se ha revertido.", { variant: "success" });
      setAskReverse(false);
      setReason("");
      detail.refresh();
      list.refresh();
    } catch (error: unknown) {
      setActionFailure(describeFailure(error, "No se pudo anular el gasto.").message);
      setAskReverse(false);
    } finally {
      setBusy(false);
    }
  }

  const ready = !list.loading && !list.error && expenses.length > 0;
  const filtered = Boolean(search || from || to || paidWith);
  const fieldError = (key: keyof ExpenseForm) => (touched ? errors[key] : undefined);
  const selected = detail.data;

  let body;
  if (list.loading && expenses.length === 0) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Gastos" />;
  } else if (list.error) {
    body = <CocoaState kind="error" title="No se pudieron cargar los gastos" message={list.error} onRetry={list.refresh} />;
  } else if (expenses.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={filtered ? "search" : "box"}
        title={filtered ? STATUS_LABELS.noResults : "Aún no hay gastos"}
        message={filtered ? "Ningún gasto coincide con los filtros." : "Registra tiques y gastos menores pagados en caja, con tarjeta o por banco: cada uno se contabiliza al momento."}
        primaryAction={{ label: newExpenseLabel, onClick: openNew }}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={expenses}
        rowKey="id"
        selectedKey={selectedId ?? undefined}
        onSelect={(e) => {
          setActionFailure(null);
          setSelectedId(e.id);
        }}
        rowTone={(e) => (e.cancelledAt ? "neutral" : undefined)}
        footer={{ base: money(totals.base), quota: money(totals.quota), total: <strong>{money(totals.total)}</strong>, date: `${plural(live.length, "gasto", "gastos")} vigentes` }}
        caption="Gastos"
        aria-label="Gastos"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${getActivePropertyName()}`}
      title="Gastos"
      subtitle={hosted ? undefined : "Gastos menores y tiques pagados en caja, tarjeta o banco, contabilizados al registrarlos; el IVA solo se deduce con NIF del proveedor."}
      actions={
        <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={openNew}>
          {newExpenseLabel}
        </CocoaButton>
      }
      commands={[
        { id: "expenses-new", label: newExpenseLabel, run: openNew },
        { id: "expenses-refresh", label: "Actualizar gastos", run: list.refresh }
      ]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Filtros de gastos"
        leftSlot={
          <div className="cocoa-row" data-gap="2">
            <CocoaSearchInput value={search} onChange={setSearch} debounceMs={250} placeholder="Proveedor o concepto…" aria-label="Buscar gastos por proveedor o concepto" />
            <CocoaDatePicker value={from} onChange={setFrom} size="small" aria-label="Desde" max={to || undefined} />
            <CocoaDatePicker value={to} onChange={setTo} size="small" aria-label="Hasta" min={from || undefined} />
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="2">
            <CocoaSelect value={paidWith} onChange={setPaidWith} size="small" aria-label="Filtrar por forma de pago" options={[{ value: "", label: "Cualquier forma de pago" }, ...PAID_WITH_OPTIONS]} />
            <CocoaSwitch checked={includeCancelled} onChange={setIncludeCancelled} size="small" label="Ver anulados" />
          </div>
        }
      />

      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Listado de gastos" footer={ready ? <span>{plural(expenses.length, "gasto", "gastos")}</span> : undefined}>
        {body}
      </CocoaSection>

      {/* Detail */}
      <CocoaDrawer
        open={selectedId !== null}
        onClose={() => (busy ? undefined : setSelectedId(null))}
        title={selected ? selected.concept : "Gasto"}
        subtitle={selected ? `${selected.supplierName} · ${date(selected.date, "medium")}` : undefined}
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedId(null)} disabled={busy}>
              {ACTIONS.close}
            </CocoaButton>
            {selected && !selected.cancelledAt ? (
              <CocoaButton
                variant="bordered"
                tone="destructive"
                disabled={busy}
                onClick={() => {
                  setReason("");
                  setReasonError(undefined);
                  setAskReverse(true);
                }}
              >
                Anular gasto
              </CocoaButton>
            ) : null}
          </>
        }
      >
        {detail.loading && !selected ? (
          <CocoaState kind="loading" title={STATUS_LABELS.loading} />
        ) : detail.error ? (
          <CocoaState kind="error" title="No se pudo cargar el gasto" message={detail.error} onRetry={detail.refresh} />
        ) : selected ? (
          <div className="cocoa-stack" data-gap="4">
            {actionFailure ? (
              <CocoaCallout tone="danger" role="alert">
                {actionFailure}
              </CocoaCallout>
            ) : null}
            {selected.cancelledAt ? (
              <CocoaCallout tone="warning" title="Gasto anulado">
                Anulado el {dateTime(selected.cancelledAt)}; el asiento original queda revertido.
              </CocoaCallout>
            ) : null}
            <CocoaFormRow columns={3} min={120}>
              <CocoaStat label="Base" value={money(selected.base)} />
              <CocoaStat label={`IVA ${percent(selected.taxRate, { maximumFractionDigits: 0 })}`} value={money(selected.quota)} hint={selected.vatDeductible ? "deducible" : "no deducible"} />
              <CocoaStat label={FIELD_LABELS.total} value={money(selected.total)} size="large" />
            </CocoaFormRow>
            <ul className="c22-section__list" aria-label="Datos del gasto">
              <li>
                <span style={mutedStyle}>Proveedor</span>
                <strong>{selected.supplierName}</strong>
              </li>
              <li>
                <span style={mutedStyle}>NIF</span>
                <strong>{selected.supplierNif ?? "—"}</strong>
              </li>
              <li>
                <span style={mutedStyle}>Cuenta de gasto</span>
                <strong>{accountLabel(chart.accounts, selected.accountCode)}</strong>
              </li>
              <li>
                <span style={mutedStyle}>Pagado con</span>
                <strong>{PAID_WITH_LABELS[selected.paidWith]}</strong>
              </li>
              <li>
                <span style={mutedStyle}>Justificante</span>
                <strong>{selected.hasReceipt ? "Adjunto" : "Sin adjunto"}</strong>
              </li>
            </ul>
            <CocoaSection title="Asiento" meta={selected.entry ? `Nº ${selected.entry.entryNumber ?? "—"} · ${date(selected.entry.entryDate)}` : undefined} headingLevel={3}>
              {selected.entry ? (
                <ul className="c22-section__list" aria-label="Líneas del asiento">
                  {selected.entry.lines.map((line) => (
                    <li key={line.id}>
                      <span>
                        {line.accountCode}
                        <span style={subStyle}>{line.description ?? ""}</span>
                      </span>
                      <strong>{toNumber(line.debit) ? `D ${money(line.debit)}` : `H ${money(line.credit)}`}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <CocoaState kind="empty" inline title="Sin asiento asociado." />
              )}
            </CocoaSection>
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={askReverse}
        onClose={() => setAskReverse(false)}
        tone="destructive"
        title="¿Anular este gasto?"
        description="Se contabiliza un asiento de anulación con la fecha de hoy; el original se conserva marcado como revertido."
        confirmLabel="Anular gasto"
        cancelLabel={ACTIONS.cancel}
        onConfirm={reverse}
        busy={busy}
      >
        <CocoaField label="Motivo" required error={reasonError}>
          <CocoaInput
            value={reason}
            onChange={(v) => {
              setReason(v);
              setReasonError(undefined);
            }}
            placeholder="Tique duplicado, importe erróneo…"
            maxLength={300}
          />
        </CocoaField>
      </CocoaDialog>

      {/* New expense */}
      <CocoaDrawer
        open={creating}
        onClose={() => (saving ? undefined : setCreating(false))}
        title={newExpenseLabel}
        subtitle="Se contabiliza al registrarlo"
        side="right"
        size="lg"
        dismissible={!saving}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setCreating(false)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={saving} disabled={saving || (touched && !valid)}>
              Registrar y contabilizar
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {saveFailure ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo registrar">
              {saveFailure}
            </CocoaCallout>
          ) : null}
          {chart.error ? <CocoaCallout tone="warning">{chart.error}</CocoaCallout> : null}

          <CocoaFormSection title="Quién y qué" description="Un tique sin NIF se contabiliza con su IVA como mayor gasto (no deducible).">
            <CocoaFormRow columns={2}>
              <CocoaField label={FIELD_LABELS.date} required error={fieldError("date")}>
                <CocoaDatePicker value={form.date} onChange={(v) => set("date", v)} max={todayIso()} disabled={saving} />
              </CocoaField>
              <CocoaField label="Proveedor" required error={fieldError("supplierName")}>
                <CocoaInput value={form.supplierName} onChange={(v) => set("supplierName", v)} placeholder="Ferretería del Puerto" disabled={saving} />
              </CocoaField>
              <CocoaField label="NIF del proveedor" hint={STATUS_LABELS.optional.toLowerCase()} help="Con NIF el IVA es deducible y entra en el libro de recibidas.">
                <CocoaInput value={form.supplierNif} onChange={(v) => set("supplierNif", v.toUpperCase())} maxLength={20} disabled={saving} />
              </CocoaField>
              <CocoaField label="Cuenta de gasto" required error={fieldError("accountCode")}>
                {chart.accounts.length > 0 ? (
                  <CocoaSelect value={form.accountCode} onChange={(v) => set("accountCode", v)} options={expenseOptions} placeholder="Elige una subcuenta del grupo 6" disabled={saving} />
                ) : (
                  <CocoaInput value={form.accountCode} onChange={(v) => set("accountCode", v)} placeholder="629" maxLength={12} disabled={saving || chart.loading} />
                )}
              </CocoaField>
              <CocoaField label="Concepto" required error={fieldError("concept")} fullWidth>
                <CocoaInput value={form.concept} onChange={(v) => set("concept", v)} placeholder="Bombillas para el pasillo de la segunda planta" maxLength={300} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="Importes">
            <CocoaFormRow columns={3} min={140}>
              <CocoaField label="Base imponible" required error={fieldError("base")}>
                <CocoaInput value={form.base} onChange={(v) => set("base", v)} inputMode="decimal" placeholder="24,50" disabled={saving} />
              </CocoaField>
              <CocoaField label="Tipo de IVA" required>
                <CocoaSelect value={form.taxRate} onChange={(v) => set("taxRate", v)} options={TAX_RATE_OPTIONS} disabled={saving} />
              </CocoaField>
              <CocoaField label="Cuota impresa" error={fieldError("quota")} help={`Calculada: ${money(quotaOf(baseNumber, rateNumber))}`}>
                <CocoaInput value={form.quota} onChange={(v) => set("quota", v)} inputMode="decimal" placeholder={to2(quotaOf(baseNumber, rateNumber)).replace(".", ",")} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaFormRow columns={3} min={140}>
              <CocoaStat label={FIELD_LABELS.total} value={money(totalNumber)} />
              <CocoaField label="IVA deducible" inline help={hasNif ? "Se anota en 472 y en el libro de recibidas." : "Sin NIF no se puede deducir."}>
                <CocoaSwitch checked={hasNif && form.vatDeductible} onChange={(v) => set("vatDeductible", v)} size="small" disabled={saving || !hasNif} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="Pago" description="La contrapartida por defecto es 570 en efectivo, 5721 con tarjeta y 572 por banco.">
            <CocoaFormRow columns={2}>
              <CocoaField label="Pagado con" required>
                <CocoaSegmentedControl
                  value={form.paidWith}
                  onChange={(v) => {
                    set("paidWith", v as ExpensePaidWith);
                    set("counterAccountCode", "");
                  }}
                  options={PAID_WITH_OPTIONS}
                  size="small"
                  fullWidth
                  aria-label="Forma de pago"
                />
              </CocoaField>
              <CocoaField label="Cuenta de tesorería" help={`Por defecto ${PAID_WITH_DEFAULT_ACCOUNT[form.paidWith]}.`}>
                <CocoaSelect
                  value={form.counterAccountCode}
                  onChange={(v) => set("counterAccountCode", v as ExpenseForm["counterAccountCode"])}
                  options={[{ value: "", label: `Por defecto (${PAID_WITH_DEFAULT_ACCOUNT[form.paidWith]})` }, ...EXPENSE_COUNTER_ACCOUNT_OPTIONS]}
                  disabled={saving}
                />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="Justificante" description="PDF, JPEG o PNG de hasta 512 KiB; se guarda con el gasto.">
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

export default ExpensesScreen;
