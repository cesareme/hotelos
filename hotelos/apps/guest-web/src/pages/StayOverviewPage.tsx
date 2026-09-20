import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { StatusPill } from "../components/StatusPill";
import type { StatusTone } from "../components/StatusPill";
import { downloadInvoice, getCheckIn, getReservation, isApiError } from "../api/client";
import type { ArriveResponse, CheckInSession, ReservationSummary } from "../api/client";
import { ChatWidget } from "../components/ChatWidget";
import { useGuestSession } from "../auth/GuestSessionContext";
import { GUEST_ARRIVAL_STORAGE_KEY } from "../kiosk/kiosk-mode";
import { initialStep, sessionStatusLabel, t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";

const STATUS_LABEL: Record<ReservationSummary["status"], string> = {
  confirmed: "Confirmed",
  checked_in: "Checked in",
  checked_out: "Checked out",
  cancelled: "Cancelled"
};

const STATUS_TONE: Record<ReservationSummary["status"], StatusTone> = {
  confirmed: "ok",
  checked_in: "info",
  checked_out: "info",
  cancelled: "error"
};

// Tanda CHK · W4-C: tono del bloque «Pre-check-in» por estado de la sesión.
const CHECKIN_TONE: Record<string, StatusTone> = {
  invited: "warn",
  in_progress: "warn",
  ready_for_arrival: "ok",
  arrived: "info",
  checked_in: "ok",
  handed_off: "info",
  expired: "error",
  cancelled: "error"
};

function formatRange(arrival: string, departure: string): string {
  if (!arrival || !departure) return "Dates pending";
  const start = new Date(arrival);
  const end = new Date(departure);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const startTxt = start.toLocaleDateString(undefined, opts);
  const endTxt = end.toLocaleDateString(undefined, { ...opts, year: "numeric" });
  return `${startTxt} – ${endTxt}`;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
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

type Destination = "precheckin" | "service" | "concierge" | "checkin" | "arrival";

export function StayOverviewPage({ onNavigate, lang = "es" }: { onNavigate: (page: Destination) => void; lang?: Lang }) {
  const { session } = useGuestSession();
  const [reservation, setReservation] = useState<ReservationSummary | null>(null);
  const [checkIn, setCheckIn] = useState<CheckInSession | null>(null);
  const [checkInAvailable, setCheckInAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const arrival = readStoredArrival();

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getReservation(session.reservationId)
      .then((data) => {
        if (!cancelled) setReservation(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "We couldn't load your reservation.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Pre-check-in (Tanda CHK): 401/403/404 → sin invitación; se ofrece el formulario clásico.
    getCheckIn()
      .then((data) => {
        if (cancelled) return;
        setCheckIn(data);
        setCheckInAvailable(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCheckIn(null);
        // 401/403/404 → sin invitación o módulo apagado; cualquier otro fallo también deja el formulario clásico.
        setCheckInAvailable(false);
        if (!isApiError(err)) setError((current) => current ?? (err instanceof Error ? err.message : null));
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  async function onInvoice() {
    if (!session) return;
    setDownloading(true);
    try {
      await downloadInvoice(session.reservationId);
    } finally {
      setDownloading(false);
    }
  }

  const checkInDone = checkIn?.status === "checked_in" || reservation?.status === "checked_in";
  const roomNumber = arrival?.room.number ?? reservation?.roomNumber;

  return (
    <Layout
      eyebrow={reservation ? "Your stay" : undefined}
      title={reservation ? `Hello, ${reservation.guestName.split(" ")[0]}` : "Loading your stay"}
      subtitle={reservation ? "Everything you need before, during and after your stay." : undefined}
      propertyName={reservation?.propertyName}
      reservationCode={reservation?.reservationCode ?? session?.reservationCode}
    >
      {loading ? <div className="gp-card gp-skeleton">Loading reservation…</div> : null}
      {error ? <div className="gp-card gp-error">{error}</div> : null}

      {reservation ? (
        <>
          <section className="gp-card gp-stay">
            <div className="gp-stay-row">
              <div>
                <p className="gp-label">Dates</p>
                <p className="gp-value">{formatRange(reservation.arrival, reservation.departure)}</p>
              </div>
              <StatusPill label={STATUS_LABEL[reservation.status]} tone={STATUS_TONE[reservation.status]} />
            </div>
            <div className="gp-stay-grid">
              <div>
                <p className="gp-label">Room</p>
                <p className="gp-value">{reservation.roomType}</p>
                <p className="gp-meta">{roomNumber ? `${t(lang, "roomAssigned")} · ${roomNumber}` : t(lang, "roomPending")}</p>
              </div>
              <div>
                <p className="gp-label">Guests</p>
                <p className="gp-value">{reservation.guests}</p>
              </div>
              <div>
                <p className="gp-label">Balance due</p>
                <p className="gp-value">{formatMoney(reservation.balanceDue, reservation.currency)}</p>
              </div>
            </div>
          </section>

          <section className="gp-card gp-precheckin">
            <div className="gp-stay-row">
              <div>
                <p className="gp-label">{t(lang, "preCheckInBlock")}</p>
                <p className="gp-value">{checkIn ? sessionStatusLabel(checkIn.status, lang) : checkInDone ? t(lang, "statusCheckedIn") : t(lang, "statusInvited")}</p>
              </div>
              {checkIn ? <StatusPill label={sessionStatusLabel(checkIn.status, lang)} tone={CHECKIN_TONE[checkIn.status] ?? "info"} /> : null}
            </div>
            {checkIn && !checkInDone ? (
              <button type="button" className="gp-button gp-button-primary" onClick={() => onNavigate("checkin")}>
                {initialStep(checkIn) === "travellers" && checkIn.status === "invited" ? t(lang, "startPreCheckIn") : t(lang, "continuePreCheckIn")}
              </button>
            ) : null}
            {checkInDone && arrival ? (
              <button type="button" className="gp-button gp-button-primary" onClick={() => onNavigate("arrival")}>
                {t(lang, "viewArrival")}
              </button>
            ) : null}
            {arrival?.key ? (
              <div className="gp-stay-row">
                <StatusPill label={t(lang, "keyIssued")} tone="ok" />
                <code className="gp-qr-serial">{arrival.key.serialNumber}</code>
              </div>
            ) : checkInDone ? (
              <StatusPill label={t(lang, "keyPending")} tone="warn" />
            ) : null}
            {!checkIn && !checkInAvailable && !checkInDone ? (
              <button type="button" className="gp-button gp-button-ghost" onClick={() => onNavigate("precheckin")}>
                Pre-check-in
              </button>
            ) : null}
          </section>

          <section className="gp-actions">
            <button type="button" className="gp-action" onClick={() => onNavigate(checkIn ? "checkin" : "precheckin")}>
              <span className="gp-action-icon" aria-hidden>&#9999;</span>
              <span className="gp-action-label">Pre-check-in</span>
              <span className="gp-action-hint">Save time at arrival</span>
            </button>
            <button type="button" className="gp-action" onClick={() => onNavigate("service")}>
              <span className="gp-action-icon" aria-hidden>&#9733;</span>
              <span className="gp-action-label">Request a service</span>
              <span className="gp-action-hint">Towels, late check-out, more</span>
            </button>
            <button type="button" className="gp-action" onClick={onInvoice} disabled={downloading}>
              <span className="gp-action-icon" aria-hidden>&#8595;</span>
              <span className="gp-action-label">{downloading ? "Preparing…" : "View invoice"}</span>
              <span className="gp-action-hint">Download a copy</span>
            </button>
            <a className="gp-action" href="tel:+34000000000">
              <span className="gp-action-icon" aria-hidden>&#9742;</span>
              <span className="gp-action-label">Contact concierge</span>
              <span className="gp-action-hint">Call the front desk</span>
            </a>
          </section>

          {/* Tanda CHK · corrector REV3-10: canal web del recepcionista IA (POST /guest-portal/chat). */}
          {checkInAvailable ? <ChatWidget lang={lang} propertyName={reservation.propertyName} /> : null}
        </>
      ) : null}
    </Layout>
  );
}
