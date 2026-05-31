import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useState } from "react";
import {
  fetchReservations,
  fetchReservation,
  fetchReservationFolio,
  fetchRoomTypes,
  fetchGuestActivity,
  type AdminReservation,
  type AdminRoomType,
  type FolioBalance,
  type GuestActivity,
  type ActivityItem
} from "../../services/pmsCommerceApi";
import { fetchGuest, type GuestProfile } from "../../services/guestsApi";
import { LoadingBlock, EmptyState, ErrorState, Spinner } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

function nav(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}
function go(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

type StepState = "done" | "active" | "pending" | "blocked" | "skipped";
type JourneyStep = { key: string; label: string; state: StepState; detail: string };

const NEXT_ACTION_LABEL: Record<string, string> = {
  booked: "Confirm the reservation",
  identity: "Capture guest identity",
  payment: "Take payment / deposit",
  room: "Assign a room",
  checkin: "Check the guest in",
  checkout: "Check the guest out"
};

/** Derive the journey purely from real reservation + folio + guest data. */
function computeJourney(res: AdminReservation, folio: FolioBalance | null, guest: GuestProfile | null) {
  const today = todayISO();
  const cancelled = res.status === "cancelled" || res.status === "no_show";
  const checkedIn = res.status === "checked_in" || res.status === "checked_out";
  const checkedOut = res.status === "checked_out";
  const steps: JourneyStep[] = [];

  steps.push({
    key: "booked",
    label: "Booking confirmed",
    state: cancelled ? "skipped" : res.status === "draft" ? "pending" : "done",
    detail: res.status === "draft" ? "Reservation is still a draft." : `${res.channel} · ${res.arrivalDate} → ${res.departureDate}`
  });

  const hasDoc = Boolean(guest?.documentNumber);
  steps.push({
    key: "identity",
    label: "Identity & traveller record (SES)",
    state: cancelled ? "skipped" : hasDoc ? "done" : checkedIn ? "blocked" : "pending",
    detail: hasDoc
      ? `Document on file${guest?.documentType ? ` (${guest.documentType})` : ""}.`
      : "No identity document captured — required for the parte de viajeros."
  });

  let payState: StepState;
  let payDetail: string;
  if (!folio) {
    payState = "pending";
    payDetail = "Folio not loaded yet.";
  } else {
    const bal = folio.balanceDue;
    const cur = folio.folio.currency;
    if (folio.chargesTotal > 0 && bal <= 0.005) { payState = "done"; payDetail = `Balance settled (${folio.paymentsTotal} ${cur}).`; }
    else if (folio.paymentsTotal > 0) { payState = checkedOut && bal > 0.005 ? "blocked" : "active"; payDetail = `Partially paid · balance ${bal.toFixed(2)} ${cur}.`; }
    else { payState = checkedOut ? "blocked" : "pending"; payDetail = `No payment yet · balance ${bal.toFixed(2)} ${cur}.`; }
  }
  steps.push({ key: "payment", label: "Payment", state: cancelled ? "skipped" : payState, detail: payDetail });

  const assigned = Boolean(res.assignedRoomId);
  steps.push({
    key: "room",
    label: "Room assigned",
    state: cancelled ? "skipped" : assigned ? "done" : checkedIn ? "blocked" : "pending",
    detail: assigned ? `Room ${res.assignedRoomId}.` : "No room assigned yet."
  });

  const arrivalPast = res.arrivalDate < today;
  steps.push({
    key: "checkin",
    label: "Check-in",
    state: cancelled ? "skipped" : checkedIn ? "done" : arrivalPast && res.status === "confirmed" ? "blocked" : "pending",
    detail: checkedIn ? "Guest checked in." : arrivalPast ? "Arrival date passed — not checked in." : `Scheduled ${res.arrivalDate}.`
  });

  steps.push({
    key: "stay",
    label: "In-house stay",
    state: cancelled ? "skipped" : res.status === "checked_in" ? "active" : checkedOut ? "done" : "pending",
    detail: res.status === "checked_in" ? "Guest is in-house." : checkedOut ? "Stay completed." : "Not started."
  });

  steps.push({
    key: "checkout",
    label: "Check-out & invoice",
    state: cancelled ? "skipped" : checkedOut ? "done" : "pending",
    detail: checkedOut ? "Checked out." : `Scheduled ${res.departureDate}.`
  });

  const total = steps.filter((s) => s.state !== "skipped").length;
  const done = steps.filter((s) => s.state === "done").length;
  const next = steps.find((s) => s.state === "blocked") ?? steps.find((s) => s.state === "pending" && s.key !== "stay");
  return { steps, done, total, next, cancelled };
}

/** Lightweight stage from the reservation alone (for the list, no extra fetch). */
function listStage(res: AdminReservation): { done: number; total: number; label: string; cls: string } {
  if (res.status === "cancelled" || res.status === "no_show") return { done: 0, total: 4, label: res.status.replace("_", " "), cls: "error" };
  const flags = [
    res.status !== "draft",
    Boolean(res.assignedRoomId),
    res.status === "checked_in" || res.status === "checked_out",
    res.status === "checked_out"
  ];
  const done = flags.filter(Boolean).length;
  const label = res.status === "checked_out" ? "Completed" : res.status === "checked_in" ? "In-house" : res.status === "confirmed" ? "Upcoming" : res.status;
  return { done, total: 4, label, cls: res.status === "checked_out" ? "ok" : res.status === "checked_in" ? "info" : "warn" };
}

const DOT: Record<StepState, string> = { done: "✓", active: "•", pending: "", blocked: "!", skipped: "–" };

const KIND_CLS: Record<ActivityItem["kind"], string> = {
  message: "info",
  housekeeping: "ok",
  maintenance: "warn",
  service_request: "ai"
};
function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = Math.floor(ms / 86_400_000);
  if (d > 0) return `${d}d ago`;
  const h = Math.floor(ms / 3_600_000);
  if (h > 0) return `${h}h ago`;
  const m = Math.floor(ms / 60_000);
  return m > 0 ? `${m}m ago` : "just now";
}

export function GuestJourneyWorkspace() {
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [selected, setSelected] = useState<AdminReservation | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [guest, setGuest] = useState<GuestProfile | null>(null);
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([fetchReservations(PROPERTY_ID), fetchRoomTypes(PROPERTY_ID)])
      .then(([res, rt]) => {
        setReservations(res);
        setRoomTypes(rt);
        if (res[0]) void openReservation(res[0].id);
      })
      .catch(() => setError("Could not load the guest journey right now."))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function openReservation(id: string) {
    setDetailLoading(true);
    setFolio(null);
    setGuest(null);
    setActivity(null);
    try {
      const res = await fetchReservation(id);
      setSelected(res);
      const [f, g, a] = await Promise.all([
        fetchReservationFolio(id).catch(() => null),
        res.primaryGuestId ? fetchGuest(res.primaryGuestId).then((d) => d.guest).catch(() => null) : Promise.resolve(null),
        fetchGuestActivity(id).catch(() => null)
      ]);
      setFolio(f);
      setGuest(g);
      setActivity(a);
    } finally {
      setDetailLoading(false);
    }
  }

  function roomTypeName(id: string) {
    return roomTypes.find((rt) => rt.id === id)?.name ?? id;
  }

  const q = query.trim().toLowerCase();
  const filtered = reservations.filter((r) =>
    !q || [r.code, r.bookerName, r.arrivalDate, r.departureDate, r.status].join(" ").toLowerCase().includes(q)
  );

  const journey = selected ? computeJourney(selected, folio, guest) : null;

  return (
    <section className="bo-card">
      <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
        <div>
          <p className="bo-page-eyebrow">Guest Journey</p>
          <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>Guest Journey Workspace</h2>
        </div>
        <span className="bo-chip">{reservations.length} reservations</span>
      </div>
      <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
        Every reservation's real progress — booking, identity (SES), payment, room, check-in, stay and check-out — with the
        blocked step and the next best action. Pick a reservation to see its full journey and act on it.
      </p>

      <div className="bo-grid two" style={{ marginTop: "var(--space-4)" }}>
        {/* List */}
        <section className="bo-card">
          <div className="bo-card-head"><h3>Reservations</h3><span className="bo-chip">{filtered.length} of {reservations.length}</span></div>
          <div className="rev-toolbar" style={{ marginBottom: "var(--space-3)" }}>
            <div className="rev-toolbar-group" style={{ flex: 1 }}>
              <label htmlFor="gj-search">Buscar</label>
              <input id="gj-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Code, guest, dates, status…" />
            </div>
          </div>
          {loading ? (
            <LoadingBlock label="Loading guest journeys…" />
          ) : error ? (
            <ErrorState message={error} onRetry={load} />
          ) : filtered.length === 0 ? (
            <EmptyState title={reservations.length ? "No matches" : "No reservations yet"} message={reservations.length ? "Nothing matches your search." : "Create a reservation to see its journey."} actions={<button className="primary" type="button" onClick={() => nav("ReservationAgent")}>✨ AI booking agent</button>} />
          ) : (
            filtered.map((r) => {
              const st = listStage(r);
              const pct = Math.round((st.done / st.total) * 100);
              return (
                <button key={r.id} type="button" className={`bo-row bo-row-button${selected?.id === r.id ? " is-active" : ""}`} onClick={() => void openReservation(r.id)} style={{ alignItems: "stretch" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{r.code}</strong>
                    <small>{r.bookerName ?? "Guest pending"} · {r.arrivalDate} → {r.departureDate}</small>
                    <span className={`bo-progress-bar${pct >= 100 ? " ok" : ""}`} style={{ marginTop: 6, maxWidth: 220 }}><span style={{ width: `${pct}%` }} /></span>
                  </span>
                  <span className={`bo-status ${st.cls}`}>{st.label}</span>
                </button>
              );
            })
          )}
        </section>

        {/* Detail journey */}
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Journey detail</h3>
            <span className="bo-chip">{selected?.code ?? "Select a reservation"}</span>
          </div>

          {!selected ? (
            <p className="bo-muted">Select a reservation to see its journey.</p>
          ) : detailLoading ? (
            <LoadingBlock label="Loading journey…" />
          ) : journey ? (
            <>
              <div className="bo-row" style={{ justifyContent: "space-between", marginBottom: "var(--space-2)" }}>
                <strong>{journey.cancelled ? "Cancelled" : `${journey.done} of ${journey.total} steps complete`}</strong>
                <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                  {selected.bookerName ?? guest?.fullName ?? "Guest pending"} · {roomTypeName(selected.roomTypeId)}
                </span>
              </div>

              {journey.next && !journey.cancelled ? (
                <div className="bo-card" style={{ background: "var(--accent-soft)", borderColor: "var(--accent-line, var(--line))", marginBottom: "var(--space-3)" }}>
                  <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
                    <div>
                      <p className="bo-muted" style={{ color: "var(--accent-strong)" }}>Next best action</p>
                      <h3 style={{ margin: 0 }}>{NEXT_ACTION_LABEL[journey.next.key] ?? "Continue the journey"}</h3>
                    </div>
                    <span className={`bo-status ${journey.next.state === "blocked" ? "error" : "warn"}`}>{journey.next.state === "blocked" ? "blocked" : "pending"}</span>
                  </div>
                  <p style={{ marginBottom: "var(--space-2)" }}>{journey.next.detail}</p>
                  <div className="bo-actions">
                    {journey.next.key === "identity" && selected.primaryGuestId ? (
                      <button type="button" className="primary" onClick={() => go(`/backoffice/guests/${selected.primaryGuestId}`)}>Abrir perfil de huésped</button>
                    ) : (
                      <button type="button" className="primary" onClick={() => go(`/backoffice/reservations/${selected.id}`)}>Open reservation to act</button>
                    )}
                  </div>
                </div>
              ) : null}

              <div className="bo-journey">
                {journey.steps.map((s) => (
                  <div key={s.key} className={`bo-journey-step${journey.next?.key === s.key ? " is-next" : ""}`}>
                    <span className={`bo-journey-dot ${s.state}`}>{DOT[s.state]}</span>
                    <div>
                      <div className="bo-journey-label">{s.label}</div>
                      <div className="bo-journey-detail">{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Requests & messages — direct line to chat, housekeeping, maintenance */}
              <section className="bo-card" style={{ marginTop: "var(--space-4)" }}>
                <div className="bo-card-head">
                  <div>
                    <p className="bo-muted">Requests &amp; messages</p>
                    <h3 style={{ margin: 0 }}>Across all departments</h3>
                  </div>
                  {activity ? <span className={`bo-status ${activity.counts.openTotal ? "warn" : "ok"}`}>{activity.counts.openTotal} open</span> : null}
                </div>
                {!activity ? (
                  <p className="bo-muted">Loading activity…</p>
                ) : (
                  <>
                    <div className="bo-pill-row" style={{ marginBottom: "var(--space-3)" }}>
                      <span className="bo-pill">{activity.counts.messages} messages{activity.counts.unreadGuest ? ` · ${activity.counts.unreadGuest} awaiting reply` : ""}</span>
                      <span className="bo-pill">{activity.counts.housekeeping} housekeeping</span>
                      <span className="bo-pill">{activity.counts.maintenance} maintenance</span>
                      <span className="bo-pill">{activity.counts.serviceRequests} requests</span>
                    </div>
                    {activity.items.length === 0 ? (
                      <p className="bo-muted">No messages, complaints or department requests for this guest yet.</p>
                    ) : (
                      <ul className="bo-list">
                        {activity.items.slice(0, 12).map((it) => (
                          <li key={`${it.kind}-${it.id}`} style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", alignItems: "flex-start", width: "100%" }}>
                            <span style={{ minWidth: 0 }}>
                              <span className={`bo-status ${KIND_CLS[it.kind]}`} style={{ marginRight: 6 }}>{it.department}</span>
                              <strong>{it.title}</strong>
                              {it.priority && it.priority !== "normal" ? <span className="bo-chip" style={{ marginLeft: 6 }}>{it.priority}</span> : null}
                              {it.detail ? <small style={{ display: "block", color: "var(--ink-muted)", marginTop: 2 }}>{it.detail}</small> : null}
                            </span>
                            <span style={{ textAlign: "right", whiteSpace: "nowrap", flexShrink: 0 }}>
                              {it.status ? <span className={`bo-chip${it.open ? "" : ""}`}>{it.status.replace(/_/g, " ")}</span> : null}
                              <small style={{ display: "block", color: "var(--ink-faint)", marginTop: 2 }}>{timeAgo(it.at)}</small>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="bo-actions" style={{ marginTop: "var(--space-3)" }}>
                      <button type="button" onClick={() => nav("ConciergeInboxDashboard")}>Abrir bandeja de chat</button>
                      <button type="button" onClick={() => nav("HousekeepingDashboard")}>Housekeeping board</button>
                      <button type="button" onClick={() => nav("MaintenanceDashboard")}>Maintenance board</button>
                    </div>
                  </>
                )}
              </section>

              <div className="bo-actions" style={{ marginTop: "var(--space-3)" }}>
                <button type="button" className="primary" onClick={() => go(`/backoffice/reservations/${selected.id}`)}>Open full detail</button>
                {selected.primaryGuestId ? <button type="button" onClick={() => go(`/backoffice/guests/${selected.primaryGuestId}`)}>Guest profile</button> : null}
                <button type="button" onClick={() => nav("BillingCenter")}>Billing</button>
              </div>
              {detailLoading ? <p className="bo-muted" style={{ display: "inline-flex", marginTop: 8 }}><Spinner size="sm" /> Refreshing…</p> : null}
            </>
          ) : null}
        </section>
      </div>
    </section>
  );
}
