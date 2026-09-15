import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useState } from "react";
import {
  fetchReservations,
  fetchReservation,
  fetchReservationFolio,
  fetchRoomTypes,
  fetchGuestActivity,
  pickInitialReservation,
  todayIsoLocal,
  type AdminReservation,
  type AdminRoomType,
  type FolioBalance,
  type GuestActivity,
  type ActivityItem
} from "../../services/pmsCommerceApi";
import { fetchGuest, type GuestProfile } from "../../services/guestsApi";
import { LoadingBlock, EmptyState, ErrorState, Spinner } from "../../components/States";
import { useTabHost } from "../tabs/TabHost";
import { urlForScreen } from "../../navigation/nav-tree";
import { openTabPath } from "../../components/cocoa/CocoaRouteTabs";
import { money } from "../../lib/format";

const PROPERTY_ID = getActivePropertyId();
// Rows per page (API default order: most recent arrival first); "Cargar más"
// walks the cursor.
const PAGE_SIZE = 100;

type PanelErrors = { folio?: string; guest?: string; activity?: string };

function nav(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}
// Deep links open through the shared openTabPath (CocoaRouteTabs): one channel, no local pushState copy (code-review#12).
const go = (path: string) => openTabPath(path);
// Deep links of Tanda 5: Ficha del huésped (/recepcion/huespedes/:id) and Detalle
// de la reserva (/recepcion/reservas/:id), tabs of their containers.
function guestPath(id: string): string {
  return urlForScreen("GuestDetail", { id }) ?? `/recepcion/huespedes/${encodeURIComponent(id)}`;
}
function reservationPath(id: string): string {
  return urlForScreen("ReservationDetailWorkspace", { id }) ?? `/recepcion/reservas/${encodeURIComponent(id)}`;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

type StepState = "done" | "active" | "pending" | "blocked" | "skipped";
type JourneyStep = { key: string; label: string; state: StepState; detail: string };

const NEXT_ACTION_LABEL: Record<string, string> = {
  booked: "Confirmar la reserva",
  identity: "Registrar la identidad del huésped",
  payment: "Cobrar el pago o el depósito",
  room: "Asignar habitación",
  checkin: "Hacer el check-in",
  checkout: "Hacer el check-out"
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
    label: "Reserva confirmada",
    state: cancelled ? "skipped" : res.status === "draft" ? "pending" : "done",
    detail: res.status === "draft" ? "La reserva sigue en borrador." : `${res.channel} · ${res.arrivalDate} → ${res.departureDate}`
  });

  const hasDoc = Boolean(guest?.documentNumber);
  steps.push({
    key: "identity",
    label: "Identidad y parte de viajeros (SES)",
    state: cancelled ? "skipped" : hasDoc ? "done" : checkedIn ? "blocked" : "pending",
    detail: hasDoc
      ? `Documento registrado${guest?.documentType ? ` (${guest.documentType})` : ""}.`
      : "Sin documento de identidad: es obligatorio para el parte de viajeros."
  });

  let payState: StepState;
  let payDetail: string;
  if (!folio) {
    payState = "pending";
    payDetail = "Folio todavía no cargado.";
  } else {
    const bal = folio.balanceDue;
    const cur = folio.folio.currency;
    if (folio.chargesTotal > 0 && bal <= 0.005) { payState = "done"; payDetail = `Saldo liquidado (${money(folio.paymentsTotal, cur)}).`; }
    else if (folio.paymentsTotal > 0) { payState = checkedOut && bal > 0.005 ? "blocked" : "active"; payDetail = `Pago parcial · saldo ${money(bal, cur)}.`; }
    else { payState = checkedOut ? "blocked" : "pending"; payDetail = `Sin pagos · saldo ${money(bal, cur)}.`; }
  }
  steps.push({ key: "payment", label: "Pago", state: cancelled ? "skipped" : payState, detail: payDetail });

  const assigned = Boolean(res.assignedRoomId);
  steps.push({
    key: "room",
    label: "Habitación asignada",
    state: cancelled ? "skipped" : assigned ? "done" : checkedIn ? "blocked" : "pending",
    detail: assigned ? `Habitación ${res.assignedRoomId}.` : "Todavía sin habitación asignada."
  });

  const arrivalPast = res.arrivalDate < today;
  steps.push({
    key: "checkin",
    label: "Check-in",
    state: cancelled ? "skipped" : checkedIn ? "done" : arrivalPast && res.status === "confirmed" ? "blocked" : "pending",
    detail: checkedIn ? "Huésped registrado." : arrivalPast ? "La fecha de llegada ya pasó sin check-in." : `Prevista el ${res.arrivalDate}.`
  });

  steps.push({
    key: "stay",
    label: "Estancia",
    state: cancelled ? "skipped" : res.status === "checked_in" ? "active" : checkedOut ? "done" : "pending",
    detail: res.status === "checked_in" ? "El huésped está en casa." : checkedOut ? "Estancia completada." : "No ha empezado."
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
  const label = res.status === "checked_out" ? "Completada" : res.status === "checked_in" ? "En casa" : res.status === "confirmed" ? "Próxima" : res.status;
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

/** Reservation named by the tab URL `/recepcion/reservas/:id/recorrido` (null on the standalone route). */
function reservationIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments[segments.length - 1] !== "recorrido") return null;
  const id = decodeURIComponent(segments[segments.length - 2]);
  return id && id !== "nueva" ? id : null;
}

export function GuestJourneyWorkspace() {
  const hosted = useTabHost() !== null;
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selected, setSelected] = useState<AdminReservation | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [guest, setGuest] = useState<GuestProfile | null>(null);
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // QC-06: a failed detail load is an explicit error (with the id, so retry
  // targets the right reservation) — never blank panels or a stale selection.
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);
  // Per-panel failures: "no disponible" is different from "sin datos".
  const [panelErrors, setPanelErrors] = useState<PanelErrors>({});

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([fetchReservations(PROPERTY_ID, { limit: PAGE_SIZE }), fetchRoomTypes(PROPERTY_ID)])
      .then(([page, rt]) => {
        setReservations(page.items);
        setNextCursor(page.nextCursor);
        setTotal(page.total);
        setRoomTypes(rt);
        // Inside Reservas › Recorrido the URL names the reservation; standalone, the first relevant one.
        const fromPath = reservationIdFromPath();
        const initial = fromPath ? { id: fromPath } : pickInitialReservation(page.items, todayIsoLocal());
        if (initial) void openReservation(initial.id);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el recorrido del huésped."))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchReservations(PROPERTY_ID, { limit: PAGE_SIZE, cursor: nextCursor });
      setReservations((current) => {
        const seen = new Set(current.map((r) => r.id));
        return [...current, ...page.items.filter((r) => !seen.has(r.id))];
      });
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar más reservas.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function openReservation(id: string) {
    setDetailLoading(true);
    setDetailError(null);
    setPanelErrors({});
    setFolio(null);
    setGuest(null);
    setActivity(null);
    const describe = (e: unknown) => (e instanceof Error ? e.message : "no disponible");
    try {
      const res = await fetchReservation(id);
      setSelected(res);
      const errors: PanelErrors = {};
      const [f, g, a] = await Promise.all([
        fetchReservationFolio(id).catch((e: unknown) => {
          errors.folio = describe(e);
          return null;
        }),
        res.primaryGuestId
          ? fetchGuest(res.primaryGuestId)
              .then((d) => d.guest)
              .catch((e: unknown) => {
                errors.guest = describe(e);
                return null;
              })
          : Promise.resolve(null),
        fetchGuestActivity(id).catch((e: unknown) => {
          errors.activity = describe(e);
          return null;
        })
      ]);
      setFolio(f);
      setGuest(g);
      setActivity(a);
      setPanelErrors(errors);
    } catch (err) {
      setDetailError({ id, message: err instanceof Error ? err.message : "No se pudo cargar la reserva." });
    } finally {
      setDetailLoading(false);
    }
  }

  const panelErrorSummary = [
    panelErrors.folio ? `folio (${panelErrors.folio})` : null,
    panelErrors.guest ? `huésped (${panelErrors.guest})` : null,
    panelErrors.activity ? `actividad (${panelErrors.activity})` : null
  ].filter(Boolean);

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
      {hosted ? null : (
        <>
          <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
            <div>
              <p className="bo-page-eyebrow">Recepción · Reservas</p>
              <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>Recorrido del huésped</h2>
            </div>
            <span className="bo-chip">{total ?? reservations.length} reservas</span>
          </div>
          <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
            El avance real de cada reserva — reserva, identidad (SES), pago, habitación, check-in, estancia y check-out — con
            el paso bloqueado y la siguiente mejor acción. Elige una reserva para ver su recorrido completo y actuar.
          </p>
        </>
      )}

      <div className="bo-grid two" style={{ marginTop: "var(--space-4)" }}>
        {/* List */}
        <section className="bo-card">
          <div className="bo-card-head"><h3>Reservas</h3><span className="bo-chip">{filtered.length} de {reservations.length}</span></div>
          <div className="rev-toolbar" style={{ marginBottom: "var(--space-3)" }}>
            <div className="rev-toolbar-group" style={{ flex: 1 }}>
              <label htmlFor="gj-search">Buscar</label>
              <input id="gj-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Código, huésped, fechas, estado…" />
            </div>
          </div>
          {loading ? (
            <LoadingBlock label="Cargando recorridos…" />
          ) : error ? (
            <ErrorState message={error} onRetry={load} />
          ) : filtered.length === 0 ? (
            <EmptyState title={reservations.length ? "Sin resultados" : "Todavía no hay reservas"} message={reservations.length ? "Ninguna reserva coincide con la búsqueda." : "Crea una reserva para ver su recorrido."} actions={<button className="primary" type="button" onClick={() => nav("ReservationAgent")}>Agente de reservas con IA</button>} />
          ) : (
            filtered.map((r) => {
              const st = listStage(r);
              const pct = Math.round((st.done / st.total) * 100);
              return (
                <button key={r.id} type="button" className={`bo-row bo-row-button${selected?.id === r.id ? " is-active" : ""}`} onClick={() => void openReservation(r.id)} style={{ alignItems: "stretch" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{r.code}</strong>
                    <small>{r.bookerName ?? "Huésped pendiente"} · {r.arrivalDate} → {r.departureDate}</small>
                    <span className={`bo-progress-bar${pct >= 100 ? " ok" : ""}`} style={{ marginTop: 6, maxWidth: 220 }}><span style={{ width: `${pct}%` }} /></span>
                  </span>
                  <span className={`bo-status ${st.cls}`}>{st.label}</span>
                </button>
              );
            })
          )}
          {!loading && !error && nextCursor ? (
            <div className="bo-actions" style={{ marginTop: "var(--space-3)" }}>
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? <><Spinner size="sm" /> Cargando…</> : "Cargar más"}
              </button>
            </div>
          ) : null}
        </section>

        {/* Detail journey */}
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Detalle del recorrido</h3>
            <span className="bo-chip">{selected?.code ?? "Elige una reserva"}</span>
          </div>

          {detailLoading ? (
            <LoadingBlock label="Cargando el recorrido…" />
          ) : detailError ? (
            <ErrorState
              title="No se pudo cargar la reserva"
              message={detailError.message}
              onRetry={() => void openReservation(detailError.id)}
            />
          ) : !selected ? (
            <p className="bo-muted">Elige una reserva para ver su recorrido.</p>
          ) : journey ? (
            <>
              <div className="bo-row" style={{ justifyContent: "space-between", marginBottom: "var(--space-2)" }}>
                <strong>{journey.cancelled ? "Cancelada" : `${journey.done} de ${journey.total} pasos completados`}</strong>
                <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                  {selected.bookerName ?? guest?.fullName ?? "Huésped pendiente"} · {roomTypeName(selected.roomTypeId)}
                </span>
              </div>
              {panelErrorSummary.length > 0 ? (
                <div className="bo-status warn" style={{ textTransform: "none", marginBottom: "var(--space-2)" }}>
                  Datos no disponibles: {panelErrorSummary.join(" · ")}. Los pasos de identidad y pago pueden mostrarse incompletos.{" "}
                  <button type="button" className="bo-link" onClick={() => void openReservation(selected.id)}>Reintentar</button>
                </div>
              ) : null}

              {journey.next && !journey.cancelled ? (
                <div className="bo-card" style={{ background: "var(--accent-soft)", borderColor: "var(--accent-line, var(--line))", marginBottom: "var(--space-3)" }}>
                  <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
                    <div>
                      <p className="bo-muted" style={{ color: "var(--accent-strong)" }}>Siguiente paso</p>
                      <h3 style={{ margin: 0 }}>{NEXT_ACTION_LABEL[journey.next.key] ?? "Continuar el recorrido"}</h3>
                    </div>
                    <span className={`bo-status ${journey.next.state === "blocked" ? "error" : "warn"}`}>{journey.next.state === "blocked" ? "blocked" : "pending"}</span>
                  </div>
                  <p style={{ marginBottom: "var(--space-2)" }}>{journey.next.detail}</p>
                  <div className="bo-actions">
                    {journey.next.key === "identity" && selected.primaryGuestId ? (
                      <button type="button" className="primary" onClick={() => go(guestPath(selected.primaryGuestId!))}>Abrir perfil de huésped</button>
                    ) : (
                      <button type="button" className="primary" onClick={() => go(reservationPath(selected.id))}>Abrir la reserva</button>
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
                    <p className="bo-muted">Peticiones y mensajes</p>
                    <h3 style={{ margin: 0 }}>De todos los departamentos</h3>
                  </div>
                  {activity ? <span className={`bo-status ${activity.counts.openTotal ? "warn" : "ok"}`}>{activity.counts.openTotal} open</span> : null}
                </div>
                {!activity ? (
                  <p className="bo-muted">
                    {panelErrors.activity ? `Actividad no disponible: ${panelErrors.activity}` : "Cargando la actividad…"}
                  </p>
                ) : (
                  <>
                    <div className="bo-pill-row" style={{ marginBottom: "var(--space-3)" }}>
                      <span className="bo-pill">{activity.counts.messages} messages{activity.counts.unreadGuest ? ` · ${activity.counts.unreadGuest} awaiting reply` : ""}</span>
                      <span className="bo-pill">{activity.counts.housekeeping} housekeeping</span>
                      <span className="bo-pill">{activity.counts.maintenance} maintenance</span>
                      <span className="bo-pill">{activity.counts.serviceRequests} requests</span>
                    </div>
                    {activity.items.length === 0 ? (
                      <p className="bo-muted">Este huésped no tiene mensajes, quejas ni peticiones a departamentos.</p>
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
                      <button type="button" onClick={() => nav("HousekeepingDashboard")}>Tablero de pisos</button>
                      <button type="button" onClick={() => nav("MaintenanceDashboard")}>Tablero de mantenimiento</button>
                    </div>
                  </>
                )}
              </section>

              <div className="bo-actions" style={{ marginTop: "var(--space-3)" }}>
                <button type="button" className="primary" onClick={() => go(reservationPath(selected.id))}>Ver detalle completo</button>
                {selected.primaryGuestId ? <button type="button" onClick={() => go(guestPath(selected.primaryGuestId!))}>Perfil del huésped</button> : null}
                <button type="button" onClick={() => nav("BillingCenter")}>Facturación</button>
              </div>
              {detailLoading ? <p className="bo-muted" style={{ display: "inline-flex", marginTop: 8 }}><Spinner size="sm" /> Actualizando…</p> : null}
            </>
          ) : null}
        </section>
      </div>
    </section>
  );
}
