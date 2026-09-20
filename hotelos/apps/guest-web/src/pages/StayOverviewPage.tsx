import { useCallback, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { StatusPill } from "../components/StatusPill";
import { getStay, isApiError, saveInvoicePdf } from "../api/client";
import type { ArriveResponse, StayView } from "../api/client";
import { ChatWidget } from "../components/ChatWidget";
import { useGuestSession } from "../auth/GuestSessionContext";
import { isApiConfigured } from "../config/guest-config";
import { GUEST_ARRIVAL_STORAGE_KEY } from "../kiosk/kiosk-mode";
import { sessionStatusLabel, t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";
import {
  STAGE_LABEL_KEY,
  STAGE_TONE,
  balanceSummary,
  folioActionKey,
  formatDay,
  formatDayLong,
  formatFolio,
  formatMoney,
  invoiceLabel,
  preCheckInRelevant,
  requestKindLabel,
  requestStatusView,
  reservationStatusLabel,
  stageHintKey,
  stageOf,
  stayActions,
  stayHappened
} from "../stay/stay";
import type { StayAction, StayDestination } from "../stay/stay";

// Tanda L7 · L7-06: la estancia se pinta desde `GET /guest-portal/stay` (L7-02):
// etapa por la fecha local del hotel → acción principal y secundaria
// (stay/stay.ts), folio REAL (saldo, cargos, pagos), facturas emitidas (PDF del
// API), peticiones con estado, datos del hotel solo si el API los da y encuesta
// post-estancia. Sin API los datos son de demostración y la página lo dice.
// El bot del huésped (POST /guest-portal/chat) responde con el token del portal
// sin sesión de check-in (checkin.routes.ts W4-D), así que el chat se monta en
// cuanto hay estancia; solo exige el módulo guest_self_service del hotel.

// Tanda CHK · W4-C: tono del bloque «Pre-check-in» por estado de la sesión.
const CHECKIN_TONE: Record<string, "ok" | "warn" | "info" | "error"> = {
  invited: "warn",
  in_progress: "warn",
  ready_for_arrival: "ok",
  arrived: "info",
  checked_in: "ok",
  handed_off: "info",
  expired: "error",
  cancelled: "error"
};

const LOCALE: Record<Lang, string> = { es: "es-ES", en: "en-GB" };

function formatRange(arrival: string, departure: string, lang: Lang): string {
  if (!arrival || !departure) return t(lang, "datesPending");
  const start = new Date(`${arrival.slice(0, 10)}T12:00:00Z`);
  const end = new Date(`${departure.slice(0, 10)}T12:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  const startTxt = start.toLocaleDateString(LOCALE[lang], opts);
  const endTxt = end.toLocaleDateString(LOCALE[lang], { ...opts, year: "numeric" });
  return `${startTxt} – ${endTxt}`;
}

/** Última llegada registrada en esta pestaña (sessionStorage; nunca en modo kiosco). */
export function readStoredArrival(): ArriveResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(GUEST_ARRIVAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ArriveResponse) : null;
  } catch {
    return null;
  }
}

export type Destination = StayDestination | "arrival";

const ACTION_ICON: Record<StayDestination, string> = {
  precheckin: "✏",
  checkin: "✏",
  service: "★",
  checkout: "↪",
  info: "ℹ",
  survey: "☆"
};

function ActionCard({ action, lang, onNavigate, primary }: { action: StayAction; lang: Lang; onNavigate: (page: Destination) => void; primary?: boolean }) {
  return (
    <button type="button" className={`gp-action${primary ? " gp-action-primary" : ""}`} onClick={() => onNavigate(action.destination)}>
      <span className="gp-action-icon" aria-hidden>{ACTION_ICON[action.destination]}</span>
      <span className="gp-action-label">{t(lang, action.labelKey)}</span>
      {action.hintKey ? <span className="gp-action-hint">{t(lang, action.hintKey)}</span> : null}
    </button>
  );
}

export function StayOverviewPage({ onNavigate, lang = "es", surveyEnabled = false }: { onNavigate: (page: Destination) => void; lang?: Lang; /** true cuando el portal tiene la página de encuesta (lote L7-04). */ surveyEnabled?: boolean }) {
  const { session } = useGuestSession();
  const [stay, setStay] = useState<StayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const arrival = readStoredArrival();
  const apiConfigured = isApiConfigured();

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStay()
      .then((data) => {
        if (!cancelled) setStay(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStay(null);
        setError(isApiError(err) && err.message ? err.message : t(lang, "stayLoadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `lang` solo afecta al texto del error; no hace falta recargar al cambiar de idioma.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, reloadTick]);

  const openInvoicePdf = useCallback(
    async (invoiceId: string) => {
      setInvoiceBusy(invoiceId);
      setInvoiceError(null);
      try {
        await saveInvoicePdf({ id: invoiceId });
      } catch {
        setInvoiceError(t(lang, "invoiceOpenError"));
      } finally {
        setInvoiceBusy(null);
      }
    },
    [lang]
  );

  const stage = stay ? stageOf(stay) : null;
  // Corrector REV-L7-02: una confirmada con la salida pasada nunca se alojó → sin encuesta ni «gracias por tu estancia».
  const stayed = stay ? stayHappened(stay.reservation.status) : true;
  const actions = stay && stage ? stayActions(stage, stay.checkIn, stay.survey, { surveyEnabled, stayed }) : { primary: null, secondary: null };
  const folioAction = stage ? folioActionKey(stage) : null;
  const reservation = stay?.reservation ?? null;
  const checkIn = stay?.checkIn ?? null;
  const checkInDone = checkIn?.status === "checked_in" || reservation?.status === "checked_in";
  const roomNumber = arrival?.room.number ?? reservation?.assignedRoomNumber ?? null;
  const folio = stay ? formatFolio(stay.folio, lang, stay.reservation.currency, stay.reservation.propertyTimezone) : null;
  const keyIssued = Boolean(arrival?.key) || Boolean(checkIn?.keyIssued);
  const firstName = reservation?.primaryGuest?.firstName?.trim() ?? "";

  return (
    <Layout
      eyebrow={reservation ? t(lang, "stayEyebrow") : undefined}
      title={reservation ? (firstName ? t(lang, "hello", { name: firstName }) : t(lang, "stayEyebrow")) : t(lang, "loadingStay")}
      subtitle={stage && reservation ? t(lang, stageHintKey(stage, reservation.status), { date: formatDayLong(reservation.arrivalDate, lang) }) : reservation ? t(lang, "staySubtitle") : undefined}
      propertyName={reservation?.propertyName}
      reservationCode={reservation?.reservationCode ?? session?.reservationCode}
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
          <p className="gp-error-text">{error}</p>
          <button type="button" className="gp-button gp-button-ghost" onClick={() => setReloadTick((tick) => tick + 1)}>
            {t(lang, "retry")}
          </button>
        </div>
      ) : null}
      {!apiConfigured && stay ? <p className="gp-hint">{t(lang, "demoNoApi")}</p> : null}

      {stay && reservation && stage && folio ? (
        <>
          <section className="gp-card gp-stay">
            <div className="gp-stay-row">
              <div>
                <p className="gp-label">{t(lang, "dates")}</p>
                <p className="gp-value">{formatRange(reservation.arrivalDate, reservation.departureDate, lang)}</p>
              </div>
              <StatusPill label={t(lang, STAGE_LABEL_KEY[stage])} tone={STAGE_TONE[stage]} />
            </div>
            <div className="gp-stay-grid">
              <div>
                <p className="gp-label">{t(lang, "room")}</p>
                <p className="gp-value">{reservation.roomType ?? t(lang, "room")}</p>
                <p className="gp-meta">{roomNumber ? `${t(lang, "roomAssigned")} · ${roomNumber}` : t(lang, "roomPending")}</p>
              </div>
              <div>
                <p className="gp-label">{t(lang, "guestsLabel")}</p>
                <p className="gp-value">{reservation.guestCount}</p>
                <p className="gp-meta">{reservationStatusLabel(reservation.status, lang)}</p>
              </div>
              <div>
                <p className="gp-label">{t(lang, "balanceDueLabel")}</p>
                <p className="gp-value">{balanceSummary(stay.folio, lang, reservation.currency)}</p>
                {folio.status === "settled" && folio.charges.length > 0 ? <p className="gp-meta">{t(lang, "folioSettled")}</p> : null}
              </div>
            </div>
          </section>

          {actions.primary || actions.secondary ? (
            <section className="gp-actions" aria-label={t(lang, "stayEyebrow")}>
              {actions.primary ? <ActionCard action={actions.primary} lang={lang} onNavigate={onNavigate} primary /> : null}
              {actions.secondary ? <ActionCard action={actions.secondary} lang={lang} onNavigate={onNavigate} /> : null}
            </section>
          ) : null}

          {/* Bloque de check-in: antes de llegar/el día de llegada (estado de la sesión CHK) y, ya alojado, «Check-in hecho» + llave. Nunca tras la salida. */}
          {stage !== "post_stay" && stage !== "cancelled" && (checkIn || preCheckInRelevant(stage) || checkInDone) ? (
            <section className="gp-card gp-precheckin">
              <div className="gp-stay-row">
                <div>
                  <p className="gp-label">{t(lang, "preCheckInBlock")}</p>
                  <p className="gp-value">{checkInDone ? t(lang, "statusCheckedIn") : checkIn ? sessionStatusLabel(checkIn.status, lang) : t(lang, "statusInvited")}</p>
                </div>
                {!checkInDone && checkIn ? <StatusPill label={sessionStatusLabel(checkIn.status, lang)} tone={CHECKIN_TONE[checkIn.status] ?? "info"} /> : null}
              </div>
              {checkInDone && arrival ? (
                <button type="button" className="gp-button gp-button-primary" onClick={() => onNavigate("arrival")}>
                  {t(lang, "viewArrival")}
                </button>
              ) : null}
              {/* Solo la llave móvil real (GuestPortalAction mobile_key / llegada de esta pestaña); sin ella no se afirma nada sobre la llave. */}
              {keyIssued ? (
                <div className="gp-stay-row">
                  <StatusPill label={t(lang, "keyIssued")} tone="ok" />
                  {arrival?.key ? <code className="gp-qr-serial">{arrival.key.serialNumber}</code> : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Folio REAL del API: saldo, cargos y pagos del folio principal; sin líneas es «sin cargos todavía». */}
          <section className="gp-card gp-folio" aria-label={t(lang, "folioTitle")}>
            <div className="gp-stay-row">
              <p className="gp-label">{t(lang, "folioTitle")}</p>
              <StatusPill label={t(lang, folio.messageKey, { amount: folio.balance })} tone={folio.status === "balance_due" ? "warn" : folio.charges.length ? "ok" : "info"} />
            </div>
            {folio.charges.length > 0 ? (
              <details className="gp-fold">
                <summary>{t(lang, "folioShowLines", { n: folio.charges.length + folio.payments.length })}</summary>
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
                  {folio.payments.map((payment, index) => (
                    <li key={`p${index}`} className="gp-line">
                      <span className="gp-line-main">
                        <span>{payment.method}</span>
                        <span className="gp-meta">{[payment.status, payment.date].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="gp-line-amount">{payment.amount}</span>
                    </li>
                  ))}
                  <li className="gp-line gp-line-total">
                    <span className="gp-line-main">{t(lang, "folioTotalPaid")}</span>
                    <span className="gp-line-amount">{folio.totalPaid}</span>
                  </li>
                </ul>
              </details>
            ) : null}
            {/* Corrector REV-L7-03: sin botón con la reserva cancelada; tras la salida, «Cuenta y facturas». */}
            {folioAction ? (
              <button type="button" className="gp-button gp-button-ghost" onClick={() => onNavigate("checkout")}>
                {t(lang, folioAction)}
              </button>
            ) : null}
          </section>

          {/* Facturas emitidas: solo las del API (PDF real); sin ninguna, el texto lo dice. */}
          <section className="gp-card gp-invoices" aria-label={t(lang, "invoicesTitle")}>
            <p className="gp-label">{t(lang, "invoicesTitle")}</p>
            {stay.invoices.length === 0 ? <p className="gp-meta">{t(lang, "invoicesEmpty")}</p> : null}
            {stay.invoices.length > 0 ? (
              <ul className="gp-list">
                {stay.invoices.map((invoice) => (
                  <li key={invoice.id} className="gp-list-item">
                    <span className="gp-line-main">
                      <span className="gp-value">{invoiceLabel(invoice, lang)}</span>
                      <span className="gp-meta">{[invoice.issuedAt ? t(lang, "invoiceIssuedOn", { date: formatDay(invoice.issuedAt, lang, reservation.propertyTimezone) }) : "", formatMoney(invoice.total, invoice.currency, lang)].filter(Boolean).join(" · ")}</span>
                    </span>
                    <button type="button" className="gp-link" onClick={() => void openInvoicePdf(invoice.id)} disabled={invoiceBusy === invoice.id} aria-busy={invoiceBusy === invoice.id}>
                      {invoiceBusy === invoice.id ? t(lang, "invoiceOpening") : t(lang, "invoiceDownload")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div aria-live="polite">{invoiceError ? <p className="gp-error" role="alert">{invoiceError}</p> : null}</div>
          </section>

          {/* Peticiones de la reserva (salida y servicio) con su estado real. */}
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
                        <span className="gp-meta">{formatDay(request.createdAt, lang, reservation.propertyTimezone)}</span>
                      </span>
                      <StatusPill label={status.label} tone={status.tone} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {stage === "post_stay" && stayed ? (
            <section className="gp-card gp-survey" aria-label={t(lang, "surveyTitle")}>
              <p className="gp-label">{t(lang, "surveyTitle")}</p>
              <p className="gp-meta">{stay.survey.answered ? t(lang, "surveyAnswered") : stay.survey.invited ? t(lang, "surveyInvited") : t(lang, "surveyNotInvited")}</p>
            </section>
          ) : null}

          <section className="gp-actions" aria-label={t(lang, "infoLabel")}>
            {preCheckInRelevant(stage) && actions.primary?.destination !== "precheckin" && actions.primary?.destination !== "checkin" && !checkIn && !checkInDone ? (
              <button type="button" className="gp-action" onClick={() => onNavigate("precheckin")}>
                <span className="gp-action-icon" aria-hidden>&#9999;</span>
                <span className="gp-action-label">{t(lang, "preCheckInBlock")}</span>
                <span className="gp-action-hint">{t(lang, "preCheckInHint")}</span>
              </button>
            ) : null}
            {/* Corrector REV-L7-05: tras la salida no se piden servicios (solo la factura por correo desde «Cuenta y facturas»). */}
            {actions.primary?.destination !== "service" && actions.secondary?.destination !== "service" && stage !== "cancelled" && stage !== "post_stay" ? (
              <button type="button" className="gp-action" onClick={() => onNavigate("service")}>
                <span className="gp-action-icon" aria-hidden>&#9733;</span>
                <span className="gp-action-label">{t(lang, "requestService")}</span>
                <span className="gp-action-hint">{t(lang, "requestServiceHint")}</span>
              </button>
            ) : null}
            <button type="button" className="gp-action" onClick={() => onNavigate("info")}>
              <span className="gp-action-icon" aria-hidden>&#8505;</span>
              <span className="gp-action-label">{t(lang, "infoLabel")}</span>
              <span className="gp-action-hint">{t(lang, "infoHint")}</span>
            </button>
            {/* Sin teléfono inventado: el número solo si el hotel lo publica (info.receptionPhone); si no, «Pregunta en recepción». */}
            <div className="gp-action gp-action-static">
              <span className="gp-action-icon" aria-hidden>&#9742;</span>
              <span className="gp-action-label">{t(lang, "contactLabel")}</span>
              <span className="gp-action-hint">{stay.info.receptionPhone ?? t(lang, "contactAtReception")}</span>
            </div>
          </section>

          {/* Tanda CHK · corrector REV3-10 / L7-06: canal web del recepcionista IA (POST /guest-portal/chat) con el token del portal, con o sin sesión de check-in. */}
          {stage !== "cancelled" ? <ChatWidget lang={lang} propertyName={reservation.propertyName} /> : null}
        </>
      ) : null}
    </Layout>
  );
}

