import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { StatusPill } from "../components/StatusPill";
import type { StatusTone } from "../components/StatusPill";
import { downloadInvoice, getReservation } from "../api/client";
import type { ReservationSummary } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";

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

type Destination = "precheckin" | "service" | "concierge";

export function StayOverviewPage({ onNavigate }: { onNavigate: (page: Destination) => void }) {
  const { session } = useGuestSession();
  const [reservation, setReservation] = useState<ReservationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

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
                {reservation.roomNumber ? <p className="gp-meta">Room {reservation.roomNumber}</p> : null}
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

          <section className="gp-actions">
            <button type="button" className="gp-action" onClick={() => onNavigate("precheckin")}>
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
        </>
      ) : null}
    </Layout>
  );
}
