// Cobro sobre un folio — diálogo Cocoa 22 (Finanzas · lote 6-A).
//
// POST /folios/:id/payments with the Tanda 6 contract: `method` is the enum
// (cash · card_terminal · card_online · bank_transfer · payment_link · other),
// `clientRequestId` is ONE uuid per attempt, reused on every retry of the same
// attempt (a failed request keeps the key; a new dialog gets a new one), and
// `reference` carries the terminal / bank / PSP reference.
//
//   · 201 / 200 `kind: "payment"` → toast «Cobro registrado» (or «ya estaba
//     registrado» when the API replayed the key) and `onCaptured`.
//   · 202 `kind: "payment_intent"` → the hosted page of the PSP opens in a new
//     tab (GET link or POST form); the browser may block a window opened after
//     an await, so the dialog also offers «Abrir la pasarela» by hand. Nothing
//     is ever announced as «cobrado» here: the capture arrives with the webhook.
//   · 409 PSP_NOT_CONFIGURED → «Pasarela de pago no configurada: registra el
//     cobro por otro método o configúrala en Ajustes» + the API note.
//
// GET /properties/:id/payments/psp-status is read when the dialog opens so
// the PSP methods are disabled (with the reason) instead of failing.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CapturedPaymentResponse, PaymentLinkResponse, PaymentMethodCode, PspStatusWire } from "@hotelos/shared";
import { fetchPspStatus, postFolioPayment } from "../../services/pmsCommerceApi";
import { financeErrorDetails, financeErrorMessage, hasFinanceErrorCode, isPaymentIntent, newClientRequestId } from "../../services/finance-contracts";
import { useToast } from "../Toast";
import { money } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { CocoaButton, CocoaCallout, CocoaDialog, CocoaField, CocoaFormRow, CocoaInput, CocoaSelect, CocoaStat } from "../cocoa";
import { PSP_NOT_CONFIGURED_MESSAGE, amountToInput, isPspMethod, parseAmount, paymentIntentPlan, paymentIntentSummary, paymentMethodOptions, type PaymentIntentPlan } from "./payment-flow";

export type PaymentDialogProps = {
  open: boolean;
  onClose: () => void;
  folioId: string;
  /** Property of the folio (PSP status). */
  propertyId: string;
  currency: string;
  /** Default amount: the folio's balance due. */
  balanceDue: number;
  /** Link the capture to an issued invoice of the folio. */
  invoiceId?: string;
  /** Where the customer lands after the hosted page (payment_link / card_online). */
  returnUrl?: string;
  /** Title context («Folio principal», «Reserva RS-1024»). */
  subject?: string;
  onCaptured?: (payment: CapturedPaymentResponse) => void;
  onIntent?: (intent: PaymentLinkResponse) => void;
};

type DialogError = { title: string; detail?: string };

/** Opens the hosted page: a GET link in a new tab, or a POST form targeted at a new tab. Returns false when the browser blocked the window. */
export function openPaymentIntent(plan: PaymentIntentPlan): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (plan.mode === "get") {
    if (!plan.url) return false;
    const popup = window.open(plan.url, "_blank", "noopener,noreferrer");
    return popup !== null;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = plan.url;
  form.target = "_blank";
  form.rel = "noopener";
  for (const field of plan.fields) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = field.name;
    input.value = field.value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
  return true;
}

export function PaymentDialog({ open, onClose, folioId, propertyId, currency, balanceDue, invoiceId, returnUrl, subject, onCaptured, onIntent }: PaymentDialogProps) {
  const { showToast } = useToast();
  const [method, setMethod] = useState<PaymentMethodCode>("cash");
  const [amountText, setAmountText] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DialogError | null>(null);
  const [psp, setPsp] = useState<PspStatusWire | null>(null);
  const [intent, setIntent] = useState<PaymentLinkResponse | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  // One idempotency key per attempt; a retry after an error reuses it.
  const clientRequestId = useRef<string>(newClientRequestId());
  const amountId = useMemo(() => `payment-amount-${folioId}`, [folioId]);

  useEffect(() => {
    if (!open) return;
    clientRequestId.current = newClientRequestId();
    setMethod("cash");
    setAmountText(amountToInput(balanceDue > 0 ? balanceDue : 0));
    setReference("");
    setError(null);
    setIntent(null);
    setPopupBlocked(false);
    let cancelled = false;
    fetchPspStatus(propertyId)
      .then((status) => {
        if (!cancelled) setPsp(status);
      })
      .catch(() => {
        // Unknown PSP state: keep the methods enabled; a 409 will say it honestly.
        if (!cancelled) setPsp(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, propertyId, balanceDue]);

  const pspUnavailable = psp !== null && !psp.configured;
  const methodOptions = useMemo(
    () => paymentMethodOptions().map((option) => ({ value: option.value, label: option.label, disabled: option.psp && pspUnavailable })),
    [pspUnavailable]
  );
  const amount = parseAmount(amountText);
  const amountError = amountText.trim() !== "" && (amount === null || amount <= 0) ? "Indica un importe mayor que cero." : undefined;
  const pspMethod = isPspMethod(method);
  const canSubmit = !busy && amount !== null && amount > 0 && !(pspMethod && pspUnavailable);

  async function submit() {
    if (intent) {
      onClose();
      return;
    }
    if (amount === null || amount <= 0) {
      setError({ title: "Indica un importe mayor que cero." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await postFolioPayment(folioId, {
        amount,
        currency,
        method,
        reference: reference.trim() || undefined,
        clientRequestId: clientRequestId.current,
        invoiceId,
        returnUrl
      });
      if (isPaymentIntent(result)) {
        setIntent(result);
        onIntent?.(result);
        const opened = openPaymentIntent(paymentIntentPlan(result));
        setPopupBlocked(!opened);
        return;
      }
      showToast(result.idempotent ? `El cobro ya estaba registrado (${money(result.amount, result.currency)}).` : `Cobro registrado: ${money(result.amount, result.currency)}.`, {
        variant: "success"
      });
      onCaptured?.(result);
      onClose();
    } catch (err) {
      if (hasFinanceErrorCode(err, "PSP_NOT_CONFIGURED")) {
        const details = financeErrorDetails(err);
        const note = typeof details?.psp === "object" && details?.psp !== null ? (details.psp as { message?: unknown }).message : undefined;
        setError({ title: PSP_NOT_CONFIGURED_MESSAGE, detail: typeof note === "string" ? note : undefined });
      } else {
        setError({ title: financeErrorMessage(err, "No se pudo registrar el cobro.") });
      }
    } finally {
      setBusy(false);
    }
  }

  const plan = intent ? paymentIntentPlan(intent) : null;

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title={subject ? `Cobrar · ${subject}` : "Registrar cobro"}
      description={intent ? undefined : "Efectivo, datáfono y transferencia se registran al momento; tarjeta en línea y enlace de pago abren la pasarela y se registran cuando esta confirma."}
      size="md"
      confirmLabel={intent ? ACTIONS.close : busy ? "Cobrando…" : "Cobrar"}
      cancelLabel={ACTIONS.cancel}
      hideCancel={intent !== null}
      onConfirm={submit}
      busy={busy}
      initialFocus={() => document.getElementById(amountId)}
    >
      {intent && plan ? (
        <div className="cocoa-stack" data-gap="3">
          <CocoaCallout tone="info" title="Pendiente de la pasarela" role="status">
            {paymentIntentSummary(intent)}
          </CocoaCallout>
          <CocoaStat label="Importe del intento" value={money(intent.intent.amount, intent.intent.currency)} hint={`Referencia ${intent.intent.id}`} />
          {popupBlocked ? (
            <CocoaCallout tone="warning" title="La pestaña no se abrió">
              El navegador bloqueó la ventana. Abre la pasarela con el botón.
            </CocoaCallout>
          ) : (
            <p>Se ha abierto la pasarela en una pestaña nueva. Si no la ves, ábrela con el botón.</p>
          )}
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setPopupBlocked(!openPaymentIntent(plan))}>
              Abrir la pasarela
            </CocoaButton>
            {plan.mode === "get" && plan.url ? (
              <CocoaButton
                variant="bordered"
                tone="neutral"
                size="small"
                onClick={() => {
                  void navigator.clipboard?.writeText(plan.url).then(
                    () => showToast("Enlace de pago copiado.", { variant: "success" }),
                    () => showToast("No se pudo copiar el enlace.", { variant: "error" })
                  );
                }}
              >
                {ACTIONS.copyLink}
              </CocoaButton>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="cocoa-stack" data-gap="3">
          <CocoaFormRow columns={2} min={200}>
            <CocoaField label="Importe" required error={amountError} help={`Saldo pendiente: ${money(balanceDue, currency)}`}>
              <CocoaInput id={amountId} value={amountText} onChange={setAmountText} inputMode="decimal" placeholder={amountToInput(balanceDue)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Método" required help={pspUnavailable ? "Tarjeta en línea y enlace de pago no disponibles: pasarela no configurada." : undefined}>
              <CocoaSelect value={method} onChange={(value) => setMethod(value as PaymentMethodCode)} options={methodOptions} disabled={busy} />
            </CocoaField>
          </CocoaFormRow>
          <CocoaField label="Referencia" hint="opcional" help="Número de operación del datáfono, referencia bancaria o de la pasarela.">
            <CocoaInput value={reference} onChange={setReference} placeholder="Operación 004512" maxLength={120} disabled={busy} autoComplete="off" />
          </CocoaField>
          {pspMethod && !pspUnavailable ? (
            <CocoaCallout tone="info">
              Se abrirá la página de pago de {psp?.provider === "stripe" ? "Stripe" : psp?.provider === "redsys" ? "Redsys" : "la pasarela"}
              {psp?.mode === "test" ? " en modo de pruebas" : ""}. El cobro se registrará cuando la pasarela lo confirme.
            </CocoaCallout>
          ) : null}
          {error ? (
            <CocoaCallout tone="danger" title={error.title} role="alert">
              {error.detail ?? null}
            </CocoaCallout>
          ) : null}
          {!canSubmit && pspMethod && pspUnavailable ? <p className="cocoa-sr-only">Método no disponible.</p> : null}
        </div>
      )}
    </CocoaDialog>
  );
}

export default PaymentDialog;
