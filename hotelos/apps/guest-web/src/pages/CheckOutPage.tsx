import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Layout, useLang } from "../components/Layout";
import { StatusPill } from "../components/StatusPill";
import { getStay, isApiError, requestStayAction, requestStayPaymentLink, saveInvoicePdf } from "../api/client";
import type { StayView } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { isApiConfigured } from "../config/guest-config";
import { t } from "../checkin/wizard";
import {
  REQUEST_KIND_KEY,
  buildStayRequest,
  canOfferPayment,
  checkOutCopy,
  checkOutOptions,
  formatDay,
  formatFolio,
  formatMoney,
  invoiceLabel,
  paymentOutcome,
  requestKindLabel,
  requestNeedsTime,
  requestStatusView,
  stageOf
} from "../stay/stay";
import type { PaymentOutcome, StayRequestKind } from "../stay/stay";

// Tanda L7 · L7-06 · «Salida y cuenta» (recon §18 D2/D3, contrato L7-02 19.4/19.5):
//   · folio REAL del API (cargos, pagos, saldo);
//   · pago honesto: «Quiero pagar ahora» pide el enlace a POST /guest-portal/stay/payment-link
//     y «Pagar ahora» SOLO aparece con un enlace real (link_sent); sin PSP el texto
//     es «se cobra en recepción»; un folio sin líneas nunca es «todo pagado»;
//   · peticiones a recepción (salida exprés, salida tardía, factura por correo,
//     consigna) → POST /guest-portal/stay/requests → nº de petición SRQ-<8>;
//   · facturas emitidas con su PDF (GET /guest-portal/invoices/:id/pdf por cabecera).

export function CheckOutPage({ onBack }: { onBack: () => void }) {
  const { session } = useGuestSession();
  const lang = useLang();
  const [stay, setStay] = useState<StayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<StayRequestKind | null>(null);
  const [note, setNote] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<{ number: string; kind: StayRequestKind } | null>(null);
  const [payment, setPayment] = useState<PaymentOutcome | null>(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const postFormRef = useRef<HTMLFormElement | null>(null);
  const apiConfigured = isApiConfigured();

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStay()
      .then((data) => {
        if (cancelled) return;
        setStay(data);
        const options = checkOutOptions(stageOf(data));
        setKind((current) => current ?? options[0] ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(isApiError(err) && err.message ? err.message : t(lang, "stayLoadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, ticket]);

  async function onSubmitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind || submitting) return;
    setRequestError(null);
    setSubmitting(true);
    try {
      const result = await requestStayAction(buildStayRequest(kind, note, preferredTime));
      setTicket({ number: result.ticketNumber, kind: result.kind });
      setNote("");
      setPreferredTime("");
    } catch (err) {
      setRequestError(isApiError(err, "STAY_CLOSED") ? t(lang, "stayClosedError") : isApiError(err) && err.message ? err.message : t(lang, "serviceSendError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onRequestPayment() {
    if (!stay || paymentBusy) return;
    setPaymentBusy(true);
    setPaymentError(null);
    try {
      const response = await requestStayPaymentLink({ returnUrl: typeof window !== "undefined" ? window.location.href.split("?")[0] : undefined });
      setPayment(paymentOutcome(response, stay.folio));
    } catch {
      setPaymentError(t(lang, "paymentLinkError"));
    } finally {
      setPaymentBusy(false);
    }
  }

  async function onOpenInvoice(invoiceId: string) {
    setInvoiceBusy(invoiceId);
    setInvoiceError(null);
    try {
      await saveInvoicePdf({ id: invoiceId });
    } catch {
      setInvoiceError(t(lang, "invoiceOpenError"));
    } finally {
      setInvoiceBusy(null);
    }
  }

  const stage = stay ? stageOf(stay) : null;
  const folio = stay ? formatFolio(stay.folio, lang, stay.reservation.currency, stay.reservation.propertyTimezone) : null;
  const options = stage ? checkOutOptions(stage) : [];
  const timeZone = stay?.reservation.propertyTimezone ?? null;
  // Corrector REV-L7-03: la cancelada tiene cabecera propia («Reserva cancelada · cargos de cancelación») y nunca CTA de pago.
  const copy = checkOutCopy(stage);
  const offerPayment = stay ? canOfferPayment(stay.folio, stage) : false;

  return (
    <Layout
      eyebrow={t(lang, copy.eyebrowKey)}
      title={t(lang, copy.titleKey)}
      subtitle={t(lang, copy.subtitleKey)}
      propertyName={stay?.reservation.propertyName}
      reservationCode={stay?.reservation.reservationCode ?? session?.reservationCode}
      back={{ label: t(lang, "backToStay"), onClick: onBack }}
    >
      <div aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="gp-card gp-skeleton" role="status">
            {t(lang, "loadingReservation")}
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="gp-card gp-error" role="alert">
          {error}
        </div>
      ) : null}
      {!apiConfigured && stay ? <p className="gp-hint">{t(lang, "demoNoApi")}</p> : null}

      {stay && stage && folio ? (
        <>
          {/* Folio real: cargos, pagos y saldo del folio principal. */}
          <section className="gp-card gp-folio" aria-label={t(lang, "folioTitle")}>
            <div className="gp-stay-row">
              <p className="gp-label">{t(lang, "folioTitle")}</p>
              <StatusPill label={t(lang, folio.messageKey, { amount: folio.balance })} tone={folio.status === "balance_due" ? "warn" : folio.charges.length ? "ok" : "info"} />
            </div>
            {folio.charges.length === 0 ? <p className="gp-meta">{t(lang, "folioNoCharges")}</p> : null}
            {folio.charges.length > 0 ? (
              <>
                <p className="gp-label">{t(lang, "folioCharges")}</p>
                <ul className="gp-lines">
                  {folio.charges.map((line, index) => (
                    <li key={`c${index}`} className="gp-line">
                      <span className="gp-line-main">
                        <span>{line.description}</span>
                        <span className="gp-meta">{[line.quantity !== 1 ? t(lang, "folioQty", { qty: line.quantity }) : "", line.date].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="gp-line-amount">{line.total}</span>
                    </li>
                  ))}
                  <li className="gp-line gp-line-total">
                    <span className="gp-line-main">{t(lang, "folioTotalCharges")}</span>
                    <span className="gp-line-amount">{folio.totalCharges}</span>
                  </li>
                </ul>
              </>
            ) : null}
            {folio.payments.length > 0 ? (
              <>
                <p className="gp-label">{t(lang, "folioPayments")}</p>
                <ul className="gp-lines">
                  {folio.payments.map((row, index) => (
                    <li key={`p${index}`} className="gp-line">
                      <span className="gp-line-main">
                        <span>{row.method}</span>
                        <span className="gp-meta">{[row.status, row.date].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="gp-line-amount">{row.amount}</span>
                    </li>
                  ))}
                  <li className="gp-line gp-line-total">
                    <span className="gp-line-main">{t(lang, "folioTotalPaid")}</span>
                    <span className="gp-line-amount">{folio.totalPaid}</span>
                  </li>
                </ul>
              </>
            ) : null}
            <div className="gp-stay-row gp-folio-balance">
              <span className="gp-label">{t(lang, "balanceDueLabel")}</span>
              <span className="gp-value">{folio.balance}</span>
            </div>
          </section>

          {/* Pago honesto: el enlace solo si el API lo da; sin PSP, en recepción. */}
          <section className="gp-card gp-payment" aria-label={t(lang, "paymentTitle")}>
            <p className="gp-label">{t(lang, "paymentTitle")}</p>
            {stage === "cancelled" ? <p className="gp-payment-message">{t(lang, "paymentCancelledAtReception")}</p> : null}
            {stage !== "cancelled" && !offerPayment ? <p className="gp-payment-message">{t(lang, folio.charges.length > 0 ? "paymentSettled" : "paymentNoChargesYet")}</p> : null}
            {offerPayment && !payment ? (
              <>
                <p className="gp-payment-message">{t(lang, "balanceDue", { amount: folio.balance })}</p>
                <button type="button" className="gp-button gp-button-primary" onClick={() => void onRequestPayment()} disabled={paymentBusy} aria-busy={paymentBusy}>
                  {paymentBusy ? t(lang, "paymentPreparing") : t(lang, "getPaymentLink")}
                </button>
              </>
            ) : null}
            {payment ? (
              <div aria-live="polite">
                <p className="gp-payment-message">{t(lang, payment.messageKey)}</p>
                {payment.kind === "link" && payment.redirect.method === "GET" ? (
                  <a className="gp-button gp-button-primary" href={payment.redirect.url} target="_blank" rel="noopener noreferrer">
                    {t(lang, "payNow")}
                  </a>
                ) : null}
                {payment.kind === "link" && payment.redirect.method === "POST" ? (
                  <form ref={postFormRef} method="post" action={payment.redirect.url} target="_blank" className="gp-stacked">
                    {Object.entries(payment.redirect.fields).map(([name, value]) => (
                      <input key={name} type="hidden" name={name} value={value} />
                    ))}
                    <button type="submit" className="gp-button gp-button-primary">
                      {t(lang, "payNow")}
                    </button>
                  </form>
                ) : null}
                {payment.kind === "link" ? <p className="gp-hint">{t(lang, "paymentOpensPsp")}</p> : null}
              </div>
            ) : null}
            <div aria-live="polite">{paymentError ? <p className="gp-error" role="alert">{paymentError}</p> : null}</div>
          </section>

          {/* Peticiones a recepción (19.4): número SRQ-<8>, estado real en la lista. */}
          <section className="gp-card gp-checkout-requests" aria-label={t(lang, "checkOutRequestsTitle")}>
            {ticket ? (
              <div className="gp-success gp-card-flat" role="status" aria-live="polite">
                <h2>{t(lang, "requestReceived")}</h2>
                <p>{t(lang, "requestSentBody")}</p>
                <p className="gp-confirmation">{ticket.number}</p>
                <p className="gp-meta">{requestKindLabel(ticket.kind, lang)}</p>
                <div className="gp-stacked">
                  <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
                    {t(lang, "backToStay")}
                  </button>
                  <button type="button" className="gp-button gp-button-ghost" onClick={() => setTicket(null)}>
                    {t(lang, "anotherRequest")}
                  </button>
                </div>
              </div>
            ) : options.length === 0 ? (
              <>
                <p className="gp-label">{t(lang, "checkOutRequestsTitle")}</p>
                <p className="gp-meta">{t(lang, stage === "cancelled" ? "stayClosedError" : "checkOutRequestsClosed")}</p>
              </>
            ) : (
              <form className="gp-form" onSubmit={onSubmitRequest} noValidate aria-busy={submitting}>
                <fieldset className="gp-fieldset">
                  <legend>{t(lang, "checkOutRequestsTitle")}</legend>
                  <p className="gp-meta">{t(lang, "checkOutRequestsIntro")}</p>
                  <div className="gp-category-grid">
                    {options.map((option) => (
                      <label key={option} className={`gp-category${kind === option ? " is-active" : ""}`}>
                        <input type="radio" name="kind" value={option} checked={kind === option} onChange={() => setKind(option)} />
                        <span className="gp-category-label">{t(lang, REQUEST_KIND_KEY[option]!.label)}</span>
                        <span className="gp-category-hint">{t(lang, REQUEST_KIND_KEY[option]!.hint ?? "kindOther")}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {kind && requestNeedsTime(kind) ? (
                  <label className="gp-field">
                    <span>{t(lang, "preferredTime")} <small>{t(lang, "optional")}</small></span>
                    <input type="time" value={preferredTime} onChange={(event) => setPreferredTime(event.target.value)} />
                  </label>
                ) : null}
                <label className="gp-field">
                  <span>{t(lang, "requestNote")} <small>{t(lang, "optional")}</small></span>
                  <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t(lang, "requestNotePlaceholder")} maxLength={500} />
                </label>
                <div aria-live="polite">{requestError ? <p className="gp-error" role="alert">{requestError}</p> : null}</div>
                <button type="submit" className="gp-button gp-button-primary" disabled={submitting || !kind}>
                  {submitting ? t(lang, "chatSending") : t(lang, "sendToReception")}
                </button>
              </form>
            )}
          </section>

          {stay.requests.length > 0 ? (
            <section className="gp-card gp-requests" aria-label={t(lang, "requestsTitle")}>
              <p className="gp-label">{t(lang, "requestsTitle")}</p>
              <ul className="gp-list">
                {stay.requests.map((request) => {
                  const status = requestStatusView(request.status, lang);
                  return (
                    <li key={request.id} className="gp-list-item">
                      <span className="gp-line-main">
                        <span className="gp-value">{requestKindLabel(request.kind, lang)}</span>
                        <span className="gp-meta">{formatDay(request.createdAt, lang, timeZone)}</span>
                      </span>
                      <StatusPill label={status.label} tone={status.tone} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {/* Facturas emitidas (PDF real del API). */}
          <section className="gp-card gp-invoices" aria-label={t(lang, "invoicesTitle")}>
            <p className="gp-label">{t(lang, "invoicesTitle")}</p>
            {stay.invoices.length === 0 ? <p className="gp-meta">{t(lang, "invoicesEmpty")}</p> : null}
            {stay.invoices.length > 0 ? (
              <ul className="gp-list">
                {stay.invoices.map((invoice) => (
                  <li key={invoice.id} className="gp-list-item">
                    <span className="gp-line-main">
                      <span className="gp-value">{invoiceLabel(invoice, lang)}</span>
                      <span className="gp-meta">{[invoice.issuedAt ? t(lang, "invoiceIssuedOn", { date: formatDay(invoice.issuedAt, lang, timeZone) }) : "", formatMoney(invoice.total, invoice.currency, lang)].filter(Boolean).join(" · ")}</span>
                    </span>
                    <button type="button" className="gp-link" onClick={() => void onOpenInvoice(invoice.id)} disabled={invoiceBusy === invoice.id} aria-busy={invoiceBusy === invoice.id}>
                      {invoiceBusy === invoice.id ? t(lang, "invoiceOpening") : t(lang, "invoiceDownload")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div aria-live="polite">{invoiceError ? <p className="gp-error" role="alert">{invoiceError}</p> : null}</div>
          </section>
        </>
      ) : null}
    </Layout>
  );
}
