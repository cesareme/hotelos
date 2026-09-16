// Devolución de un cobro — diálogo Cocoa 22 (Finanzas · lote 6-A).
//
// POST /payments/:id/refund with `clientRequestId` (one uuid per attempt,
// reused on retries), an optional partial `amount` (default: what is still
// refundable on the capture), the `refundMethod` (default: the original one)
// and the `reason`. The answer carries the `reversal` row (`kind: "refund"`
// in the folio) and `idempotent` when the key replayed an earlier refund.
// Refund rows and non-captured payments are never offered.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PaymentMethodCode, RefundResponse } from "@hotelos/shared";
import { refundFolioPayment } from "../../services/pmsCommerceApi";
import { financeErrorMessage, newClientRequestId } from "../../services/finance-contracts";
import { useToast } from "../Toast";
import { dateTime, money } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { CocoaCallout, CocoaDialog, CocoaField, CocoaFormRow, CocoaInput, CocoaSelect } from "../cocoa";
import { amountToInput, parseAmount, paymentMethodLabel, paymentMethodOptions, refundableAmount, refundablePayments, resolveMethodCode, type PaymentRowLike } from "./payment-flow";

export type RefundDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Payments of the folio (captures and refunds); only the refundable captures are offered. */
  payments: readonly PaymentRowLike[];
  /** Preselected payment (a row action «Devolver»). */
  initialPaymentId?: string;
  currency: string;
  onRefunded?: (result: RefundResponse) => void;
};

export function RefundDialog({ open, onClose, payments, initialPaymentId, currency, onRefunded }: RefundDialogProps) {
  const { showToast } = useToast();
  const refundable = useMemo(() => refundablePayments(payments), [payments]);
  const [paymentId, setPaymentId] = useState("");
  const [amountText, setAmountText] = useState("");
  const [refundMethod, setRefundMethod] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRequestId = useRef<string>(newClientRequestId());
  const amountId = "refund-amount";

  const selected = refundable.find((row) => row.id === paymentId) ?? null;
  const maxAmount = selected ? refundableAmount(selected) : 0;

  useEffect(() => {
    if (!open) return;
    clientRequestId.current = newClientRequestId();
    const first = refundable.find((row) => row.id === initialPaymentId) ?? refundable[0] ?? null;
    setPaymentId(first?.id ?? "");
    setAmountText(first ? amountToInput(refundableAmount(first)) : "");
    setRefundMethod("");
    setReason("");
    setError(null);
    // Only the opening matters: the operator edits the fields afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPaymentId]);

  function pickPayment(id: string) {
    setPaymentId(id);
    const row = refundable.find((candidate) => candidate.id === id);
    setAmountText(row ? amountToInput(refundableAmount(row)) : "");
    setRefundMethod("");
    setError(null);
  }

  const amount = parseAmount(amountText);
  const amountError =
    amountText.trim() === "" ? undefined : amount === null || amount <= 0 ? "Indica un importe mayor que cero." : amount > maxAmount ? `Como máximo ${money(maxAmount, currency)}.` : undefined;

  const paymentOptions = refundable.map((row) => ({
    value: row.id,
    label: `${money(row.amount, row.currency ?? currency)} · ${paymentMethodLabel(row.method, row.methodCode)}${row.createdAt || row.capturedAt ? ` · ${dateTime(row.createdAt ?? row.capturedAt)}` : ""}${row.pspReference ? ` · ${row.pspReference}` : ""}`
  }));
  const originalCode = selected ? resolveMethodCode(selected.method, selected.methodCode) : null;
  const methodOptions = [
    { value: "", label: originalCode ? `El mismo (${paymentMethodLabel(originalCode)})` : "El mismo método" },
    ...paymentMethodOptions({ includePsp: false }).map((option) => ({ value: option.value, label: option.label }))
  ];

  async function submit() {
    if (!selected) {
      setError("No hay ningún cobro que devolver.");
      return;
    }
    if (amount === null || amount <= 0 || amount > maxAmount) {
      setError(amount !== null && amount > maxAmount ? `La devolución no puede superar ${money(maxAmount, currency)}.` : "Indica un importe mayor que cero.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await refundFolioPayment(selected.id, {
        amount,
        reason: reason.trim() || undefined,
        clientRequestId: clientRequestId.current,
        refundMethod: refundMethod ? (refundMethod as PaymentMethodCode) : undefined
      });
      showToast(
        result.idempotent ? `La devolución ya estaba registrada (${money(result.reversal.amount, result.reversal.currency)}).` : `Devolución registrada: ${money(result.reversal.amount, result.reversal.currency)}.`,
        { variant: "success" }
      );
      onRefunded?.(result);
      onClose();
    } catch (err) {
      setError(financeErrorMessage(err, "No se pudo registrar la devolución."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title="Devolver un cobro"
      description="La devolución queda como un movimiento propio del folio (nunca se borra el cobro original) y se contabiliza al momento."
      tone="destructive"
      size="md"
      confirmLabel={busy ? "Devolviendo…" : "Devolver"}
      cancelLabel={ACTIONS.cancel}
      onConfirm={submit}
      busy={busy}
      initialFocus={() => document.getElementById(amountId)}
    >
      {refundable.length === 0 ? (
        <CocoaCallout tone="neutral" title="Sin cobros que devolver">
          Este folio no tiene cobros capturados con saldo por devolver.
        </CocoaCallout>
      ) : (
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Cobro" required>
            <CocoaSelect value={paymentId} onChange={pickPayment} options={paymentOptions} disabled={busy || refundable.length === 1} />
          </CocoaField>
          <CocoaFormRow columns={2} min={200}>
            <CocoaField label="Importe" required error={amountError} help={selected ? `Por devolver: ${money(maxAmount, currency)}` : undefined}>
              <CocoaInput id={amountId} value={amountText} onChange={setAmountText} inputMode="decimal" disabled={busy || !selected} />
            </CocoaField>
            <CocoaField label="Método de devolución" help="Un cobro en línea puede devolverse en efectivo o por transferencia.">
              <CocoaSelect value={refundMethod} onChange={setRefundMethod} options={methodOptions} disabled={busy || !selected} />
            </CocoaField>
          </CocoaFormRow>
          <CocoaField label="Motivo" hint="opcional">
            <CocoaInput value={reason} onChange={setReason} placeholder="Cancelación dentro de plazo" maxLength={500} disabled={busy} autoComplete="off" />
          </CocoaField>
          {error ? (
            <CocoaCallout tone="danger" title={error} role="alert">
              {null}
            </CocoaCallout>
          ) : null}
        </div>
      )}
    </CocoaDialog>
  );
}

export default RefundDialog;
