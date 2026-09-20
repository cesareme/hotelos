// Facturas recibidas — /finanzas/proveedores (Tanda 6 · Finanzas · lote 6-E).
//
// Cocoa 22 «lista / tabla» (docs/design/COCOA-22.md §4, pilot GuestsListScreen),
// base tab of «Proveedores y gastos»: CocoaPage → CocoaKpiStrip with the aging
// buckets (GET …/payables/aging) → CocoaToolbar (search + status) →
// CocoaSection padding none → CocoaTable (a row opens the bill in a
// CocoaDrawer: totals, lines, VAT rows, accrual and payment entries, attachment)
// → «Nueva factura» drawer with the line-based form — since Tanda T9 (lote
// T9-04) the component SupplierBillForm of ./SupplierBillForm.tsx, shared with
// the review pane of Documentos y digitalización: supplier from the directory
// or free name + NIF, 6xx / 20x-21x postable account picker without headers,
// VAT per rate, quota, 15/7 % retention with its 111/115 row, printed total
// check, inline attachment ≤ 512 KiB; this screen owns the BillForm state and
// calls validateBillForm / billFormToRequest. Flow: borrador → Aprobar →
// Contabilizar (CocoaDialog) → Pagar (date, 572/570 account, reference) or
// Anular with a reason; every details.code lands in Spanish through
// payablesErrorMessage.
//
// Tanda T9 · lote T9-11 (design §7.1 and §10 «Facturas recibidas»): column
// «Origen» (Manual · Digitalizada · e-factura by `source`), «Cotejo» badge by
// `matchStatus`, «Ver documento» (the digitised IncomingDocument at
// /finanzas/proveedores/documentos?id=…), «Cotejar con albarán» (POST …/match,
// procurement.manage) and the attachment opened by the binary route of the
// document (`downloadPath`) instead of the JSON base64 when the bill comes from
// the store. Approving above the caller's tier answers 403 RBAC_LEVEL_EXCEEDED:
// the drawer offers «Autorizar con supervisor» (components/SupervisorPinDialog,
// key payables.approve) and resends the approval with `supervisorAuthorizationId`;
// 409 RBAC_SOD_CONFLICT and 409 SUPPLIER_BILL_MATCH_REQUIRED read in Spanish
// with what the API knows (billApprovalBlock of payables-helpers.ts).
//
// Reads services/payablesApi.ts (listSupplierBills · getSupplierBill ·
// createSupplierBill · approveSupplierBill · postSupplierBill · paySupplierBill
// · cancelSupplierBill · getSupplierBillAttachment ·
// downloadSupplierBillAttachment · getPayablesAging · listSuppliers),
// services/goodsReceiptsApi.ts (matchSupplierBill) and GET
// /accounting/chart?postableOnly=1 for the pickers.

import { useMemo, useState, type CSSProperties } from "react";
import type { LedgerEntryDto, SupervisorAuthorizationDto, SupplierBillStatus } from "@hotelos/shared";
import {
  approveSupplierBill,
  cancelSupplierBill,
  createSupplierBill,
  downloadSupplierBillAttachment,
  getPayablesAging,
  getSupplierBill,
  getSupplierBillAttachment,
  listSupplierBills,
  listSuppliers,
  paySupplierBill,
  postSupplierBill,
  type SupplierBillDetailDto,
  type SupplierBillDto
} from "../../services/payablesApi";
import { goodsReceiptsApi } from "../../services/goodsReceiptsApi";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { SupervisorPinDialog } from "../../components/SupervisorPinDialog";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canDo } from "../accounting/accounting-ui";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
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
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import {
  BILL_STATUS_LABELS,
  BILL_STATUS_TONES,
  accountLabel,
  accountOptions,
  billApprovalBlock,
  billMatchLabel,
  billMatchTone,
  billSourceLabel,
  billSourceTone,
  describeFailure,
  isTreasuryAccount,
  openBillAttachment,
  todayIso,
  useChartAccounts,
  useLoader,
  type BillApprovalBlock
} from "./payables-shared";
// `bodyOf` stays the screen's name for the request builder: finance-scope-usage.test.mts pins
// `createSupplierBill(bodyOf(form), propertyId)` as the call that carries the scope's centre.
import { SupplierBillForm, billFormToRequest as bodyOf, emptyBillForm, validateBillForm, type BillForm } from "./SupplierBillForm";

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

// Bandeja de documentos de la oficina (Tanda T9 · T9-12, design §10 «Montaje»): a digitised bill links to its IncomingDocument there.
const DOCUMENTS_URL = "/finanzas/proveedores/documentos";
const POPUP_BLOCKED = "El navegador bloqueó la ventana del adjunto: permite las ventanas emergentes para esta página.";

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
  { key: "source", label: "Origen", hideOnNarrow: true, render: (b) => <CocoaBadge tone={billSourceTone(b.source)}>{billSourceLabel(b.source)}</CocoaBadge> },
  { key: "matchStatus", label: "Cotejo", hideOnNarrow: true, render: (b) => <CocoaBadge tone={billMatchTone(b.matchStatus)}>{billMatchLabel(b.matchStatus)}</CocoaBadge> },
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
  const treasuryOptions = useMemo(() => accountOptions(chart.accounts, isTreasuryAccount), [chart.accounts]);
  // Tanda T9: «Cotejar con albarán» (POST …/match) needs procurement.manage; unknown grants do not hide it (the API answers 403 in Spanish).
  const canMatch = canDo(useNavGate(propertyId), "procurement.manage");

  // Detail drawer + actions
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useLoader<SupplierBillDetailDto | null>(() => (selectedId ? getSupplierBill(selectedId, propertyId) : Promise.resolve(null)), `${propertyId}|${selectedId ?? ""}`, "No se pudo cargar la factura.");
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  // Approval gate of the last «Aprobar» (403 RBAC_LEVEL_EXCEEDED · 409 RBAC_SOD_CONFLICT · 409 SUPPLIER_BILL_MATCH_REQUIRED) and the supervisor PIN dialog.
  const [approvalBlock, setApprovalBlock] = useState<BillApprovalBlock | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
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
  const [form, setForm] = useState<BillForm>(emptyBillForm);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  const rows = bills.data ?? [];
  const supplierRows = suppliers.data ?? [];
  const selected = detail.data;
  const newBillLabel = newLabel("f", "factura recibida");
  const errors = validateBillForm(form);
  const valid = Object.keys(errors).length === 0;

  function refreshAll() {
    bills.refresh();
    aging.refresh();
    if (selectedId) detail.refresh();
  }

  function select(id: string | null) {
    setActionFailure(null);
    setApprovalBlock(null);
    setPinOpen(false);
    setSelectedId(id);
  }

  function openNew() {
    setForm(emptyBillForm());
    setTouched(false);
    setSaveFailure(null);
    setCreating(true);
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

  /**
   * Draft → approved. The plain call carries no body; after a 403
   * RBAC_LEVEL_EXCEEDED the supervisor's authorisation (SupervisorPinDialog,
   * key payables.approve, bound to this bill) is resent as
   * `supervisorAuthorizationId`. The gates the drawer can act on land in
   * `approvalBlock`; anything else reads through describeFailure.
   */
  async function approve(authorization?: SupervisorAuthorizationDto) {
    if (!selected || busy) return;
    setBusy(true);
    setActionFailure(null);
    setApprovalBlock(null);
    try {
      if (authorization) await approveSupplierBill(selected.id, { supervisorAuthorizationId: authorization.id }, propertyId);
      else await approveSupplierBill(selected.id, propertyId);
      showToast(authorization ? "Factura aprobada con autorización de supervisor." : "Factura aprobada.", { variant: "success" });
      refreshAll();
    } catch (error: unknown) {
      const block = billApprovalBlock(error);
      if (block) setApprovalBlock(block);
      else setActionFailure(describeFailure(error, "No se pudo aprobar la factura.").message);
    } finally {
      setBusy(false);
    }
  }

  /** POST …/match with `auto: true`: the receipts of the same supplier and centre; the badge follows `matchStatus`. */
  async function matchWithReceipts() {
    if (!selected || busy) return;
    setBusy(true);
    setActionFailure(null);
    try {
      const result = await goodsReceiptsApi.matchSupplierBill(selected.id, { auto: true }, propertyId);
      const lines = result.matches.length;
      showToast(`Cotejo: ${billMatchLabel(result.matchStatus).toLowerCase()} · ${plural(lines, "línea casada", "líneas casadas")}.`, { variant: result.matchStatus === "variance" ? "warning" : "success" });
      setApprovalBlock(null);
      refreshAll();
    } catch (error: unknown) {
      setActionFailure(describeFailure(error, "No se pudo cotejar la factura con los albaranes.").message);
    } finally {
      setBusy(false);
    }
  }

  function openDocument() {
    if (!selected?.incomingDocumentId) return;
    openTabPath(`${DOCUMENTS_URL}?id=${encodeURIComponent(selected.incomingDocumentId)}`);
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

  /** Inline attachment (base64 in the JSON) as before; a digitised one by the binary route of its document (`downloadPath`, `?inline=1`). */
  async function viewAttachment() {
    if (!selectedId) return;
    setActionFailure(null);
    try {
      const attachment = await getSupplierBillAttachment(selectedId, propertyId);
      const result = await openBillAttachment(attachment, { fetchBlob: downloadSupplierBillAttachment });
      if (result.source === "none") showToast(attachment.documentObjectKey ? "El adjunto vive en el almacén de documentos y aún no tiene documento enlazado." : "La factura no tiene adjunto.", { variant: "info" });
      else if (!result.opened) showToast(POPUP_BLOCKED, { variant: "warning" });
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
        onSelect={(b) => select(b.id)}
        rowTone={(b) => (b.cancelledAt ? "neutral" : b.status === "posted" && b.dueDate && b.dueDate < todayIso() ? "warning" : undefined)}
        caption="Facturas recibidas"
        aria-label="Facturas recibidas"
      />
    );
  }

  const primaryAction =
    selected && !busy
      ? selected.status === "draft"
        ? { label: ACTIONS.approve, onClick: () => void approve() }
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
        onClose={() => (busy ? undefined : select(null))}
        title={selected ? `Factura ${selected.invoiceNumber ?? ""}`.trim() : "Factura recibida"}
        subtitle={selected ? `${selected.supplierName ?? "—"} · ${BILL_STATUS_LABELS[selected.status]}` : undefined}
        side="right"
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => select(null)} disabled={busy}>
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
            {approvalBlock ? (
              <CocoaCallout
                tone="warning"
                role="alert"
                title={approvalBlock.code === "RBAC_SOD_CONFLICT" ? "Separación de funciones" : approvalBlock.code === "RBAC_LEVEL_EXCEEDED" ? "Esta factura supera tu tramo de aprobación" : "Cotejo con albaranes pendiente"}
                actions={
                  approvalBlock.action === "supervisor" ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPinOpen(true)} disabled={busy}>
                      Autorizar con supervisor
                    </CocoaButton>
                  ) : approvalBlock.action === "match" && canMatch ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void matchWithReceipts()} disabled={busy}>
                      Cotejar con albarán
                    </CocoaButton>
                  ) : undefined
                }
              >
                {approvalBlock.message}
                {approvalBlock.action === "supervisor" ? " Un supervisor presente con la clave de aprobación de facturas puede autorizar solo esta factura con su PIN." : ""}
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
                <CocoaBadge tone={billSourceTone(selected.source)}>{billSourceLabel(selected.source)}</CocoaBadge>
                <CocoaBadge tone={billMatchTone(selected.matchStatus)}>{`Cotejo: ${billMatchLabel(selected.matchStatus).toLowerCase()}`}</CocoaBadge>
                {selected.hasAttachment ? <CocoaBadge tone="neutral">Con adjunto</CocoaBadge> : null}
                {selected.lines.some((l) => l.investmentGood) ? <CocoaBadge tone="info">Bien de inversión</CocoaBadge> : null}
              </span>
              <span className="cocoa-cluster">
                {selected.incomingDocumentId ? (
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={openDocument} disabled={busy}>
                    Ver documento
                  </CocoaButton>
                ) : null}
                {selected.hasAttachment ? (
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={() => void viewAttachment()} disabled={busy}>
                    Ver adjunto
                  </CocoaButton>
                ) : null}
                {canMatch && selected.status !== "cancelled" ? (
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void matchWithReceipts()} disabled={busy}>
                    Cotejar con albarán
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
                {/* Tanda T9: `receptionDate` (capture of the document; the VAT book uses it) joins the dates row — no extra inline style. */}
                <span style={mutedStyle}>{selected.receptionDate ? "Emisión · vencimiento · recepción" : "Emisión · vencimiento"}</span>
                <strong>
                  {date(selected.issueDate)} · {date(selected.dueDate)}
                  {selected.receptionDate ? ` · ${date(selected.receptionDate)}` : ""}
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

      {/* Supervisor PIN for an approval above the caller's tier (payables.approve, bound to this bill, 60 s) */}
      {selected ? (
        <SupervisorPinDialog
          open={pinOpen}
          onClose={() => setPinOpen(false)}
          permissionKey="payables.approve"
          entityType="supplier_bill"
          entityId={selected.id}
          propertyId={propertyId}
          amount={Math.abs(toNumber(selected.total) ?? 0).toFixed(2)}
          actionLabel={`Aprobar la factura ${selected.invoiceNumber ?? selected.id} de ${money(selected.total)}`}
          onAuthorized={(granted) => {
            setPinOpen(false);
            void approve(granted);
          }}
        />
      ) : null}

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
          <SupplierBillForm value={form} onChange={setForm} errors={touched ? errors : undefined} accounts={chart} suppliers={{ rows: supplierRows, loading: suppliers.loading, error: suppliers.error }} mode="create" disabled={saving} />
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default SupplierBillsScreen;
