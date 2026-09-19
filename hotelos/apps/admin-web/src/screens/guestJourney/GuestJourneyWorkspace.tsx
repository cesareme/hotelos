// Recorrido del huésped — Recepción › Reservas › Recorrido (/recepcion/reservas/:id/recorrido).
//
// Cocoa 22 (ola 3 · lote 3-C, plantilla Workspace): CocoaGrid 4/8 with the
// reservation list (CocoaSection scroll="y", rows as CocoaButton + CocoaBadge,
// footer with the count and «Cargar más») and the journey detail (steps in an
// ol.c22-section__list with CocoaBadge dots, next step as a CocoaCallout, the
// department activity as a second CocoaSection); below 900 px the list is the
// page and the detail opens in a CocoaDrawer. Hosted inside ReservasTabs the
// container paints the head. Same data as before: fetchReservations (cursor
// pages of 100), fetchRoomTypes, fetchReservation, fetchReservationFolio,
// fetchGuest and fetchGuestActivity, plus fetchRooms so the «Habitación
// asignada» step names the room number instead of its id (qa#9); deep links
// through openTabPath and the shell channel (navigateTo).

import { useEffect, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  fetchReservations,
  fetchReservation,
  fetchReservationFolio,
  fetchRoomTypes,
  fetchRooms,
  fetchGuestActivity,
  pickInitialReservation,
  todayIsoLocal,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type FolioBalance,
  type GuestActivity,
  type ActivityItem
} from "../../services/pmsCommerceApi";
import { fetchGuest, type GuestProfile } from "../../services/guestsApi";
import { useTabHost } from "../tabs/TabHost";
import { urlForScreen } from "../../navigation/nav-tree";
import { navigateTo } from "../../lib/navigate";
import { channelLabel, date, dateRange, money, plural, relativeTime } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { reservationStatus, type StatusEntry } from "../../content/status-dictionary";
import {
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaGrid,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  openTabPath,
  useViewportTier,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Rows per page (API default order: most recent arrival first); "Cargar más"
// walks the cursor.
const PAGE_SIZE = 100;
// Height of the list column on desktop (the detail keeps its own height).
const LIST_MAX_HEIGHT = 640;
// On a laptop (900–1199) the 4/8 pair cannot share a row beside the sidebar
// (320 + 480 px of minimums exceed the grid), so CocoaGrid stacks the list
// over the detail without a hole (§3.4 row packing): a shorter list keeps the
// detail's title within a 768 px viewport (qa#10).
const LIST_MAX_HEIGHT_STACKED = 360;

type PanelErrors = { folio?: string; guest?: string; activity?: string };

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

const STEP_TONE: Record<StepState, CocoaTone> = { done: "success", active: "accent", pending: "neutral", blocked: "danger", skipped: "neutral" };
const STEP_LABEL: Record<StepState, string> = { done: "Hecho", active: "En curso", pending: STATUS_LABELS.pending, blocked: "Bloqueado", skipped: "Omitido" };

/**
 * Derive the journey purely from real reservation + folio + guest data.
 * `assignedRoomNumber` is the room's visible number (resolved from fetchRooms);
 * null when the room list is unavailable or does not contain the room.
 */
function computeJourney(res: AdminReservation, folio: FolioBalance | null, guest: GuestProfile | null, assignedRoomNumber: string | null) {
  const today = todayISO();
  const cancelled = res.status === "cancelled" || res.status === "no_show";
  const checkedIn = res.status === "checked_in" || res.status === "checked_out";
  const checkedOut = res.status === "checked_out";
  const steps: JourneyStep[] = [];

  steps.push({
    key: "booked",
    label: "Reserva confirmada",
    state: cancelled ? "skipped" : res.status === "draft" ? "pending" : "done",
    detail: res.status === "draft" ? "La reserva sigue en borrador." : `${channelLabel(res.channel)} · ${dateRange(res.arrivalDate, res.departureDate)}`
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
    if (folio.chargesTotal > 0 && bal <= 0.005) {
      payState = "done";
      payDetail = `Saldo liquidado (${money(folio.paymentsTotal, cur)}).`;
    } else if (folio.paymentsTotal > 0) {
      payState = checkedOut && bal > 0.005 ? "blocked" : "active";
      payDetail = `Pago parcial · saldo ${money(bal, cur)}.`;
    } else {
      payState = checkedOut ? "blocked" : "pending";
      payDetail = `Sin pagos · saldo ${money(bal, cur)}.`;
    }
  }
  steps.push({ key: "payment", label: "Pago", state: cancelled ? "skipped" : payState, detail: payDetail });

  const assigned = Boolean(res.assignedRoomId);
  steps.push({
    key: "room",
    label: "Habitación asignada",
    state: cancelled ? "skipped" : assigned ? "done" : checkedIn ? "blocked" : "pending",
    // The reservation only carries the room id: paint the number, never the id (qa#9).
    detail: assigned ? (assignedRoomNumber ? `Habitación ${assignedRoomNumber}.` : "Habitación asignada.") : "Todavía sin habitación asignada."
  });

  const arrivalPast = res.arrivalDate < today;
  steps.push({
    key: "checkin",
    label: "Check-in",
    state: cancelled ? "skipped" : checkedIn ? "done" : arrivalPast && res.status === "confirmed" ? "blocked" : "pending",
    detail: checkedIn ? "Huésped registrado." : arrivalPast ? "La fecha de llegada ya pasó sin check-in." : `Prevista el ${date(res.arrivalDate, "medium")}.`
  });

  steps.push({
    key: "stay",
    label: "Estancia",
    state: cancelled ? "skipped" : res.status === "checked_in" ? "active" : checkedOut ? "done" : "pending",
    detail: res.status === "checked_in" ? "El huésped está en casa." : checkedOut ? "Estancia completada." : "No ha empezado."
  });

  steps.push({
    key: "checkout",
    label: "Check-out y factura",
    state: cancelled ? "skipped" : checkedOut ? "done" : "pending",
    detail: checkedOut ? "Salida hecha." : `Prevista el ${date(res.departureDate, "medium")}.`
  });

  const total = steps.filter((s) => s.state !== "skipped").length;
  const done = steps.filter((s) => s.state === "done").length;
  const next = steps.find((s) => s.state === "blocked") ?? steps.find((s) => s.state === "pending" && s.key !== "stay");
  return { steps, done, total, next, cancelled };
}

/** Lightweight stage from the reservation alone (for the list, no extra fetch); the badge reads the common status dictionary (UX-1 · U2, D5). */
function listStage(res: AdminReservation): { done: number; total: number; status: StatusEntry } {
  const status = reservationStatus(res.status);
  if (res.status === "cancelled" || res.status === "no_show") return { done: 0, total: 4, status };
  const flags = [res.status !== "draft", Boolean(res.assignedRoomId), res.status === "checked_in" || res.status === "checked_out", res.status === "checked_out"];
  return { done: flags.filter(Boolean).length, total: 4, status };
}

const KIND_TONE: Record<ActivityItem["kind"], CocoaTone> = {
  message: "info",
  housekeeping: "success",
  maintenance: "warning",
  service_request: "ai"
};

const ITEM_STATUS_LABEL: Record<string, string> = {
  open: "Abierta",
  in_progress: STATUS_LABELS.inProgress,
  pending: STATUS_LABELS.pending,
  closed: "Cerrada",
  resolved: "Resuelta",
  done: STATUS_LABELS.completed,
  completed: STATUS_LABELS.completed,
  cancelled: STATUS_LABELS.cancelled
};

const PRIORITY_LABEL: Record<string, string> = { low: "Baja", high: "Alta", urgent: "Urgente", critical: "Crítica" };

/** Reservation named by the tab URL `/recepcion/reservas/:id/recorrido` (null on the standalone route). */
function reservationIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments[segments.length - 1] !== "recorrido") return null;
  const id = decodeURIComponent(segments[segments.length - 2]);
  return id && id !== "nueva" ? id : null;
}

// Rows of the list live inside a padding="none" section: inset them to the card padding.
const listInsetStyle: CSSProperties = { padding: "0 var(--cocoa-space-4)" };
const searchInsetStyle: CSSProperties = { padding: "var(--cocoa-space-3) var(--cocoa-space-4) 0" };
// A selectable row is a plain button that grows, wraps and aligns left (workspace pilot).
const rowButtonStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0, height: "auto", justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal" };
const rowTextStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const rowEndStyle: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 };
const stepTextStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" };

function JourneySkeleton() {
  return (
    <div aria-hidden="true">
      <CocoaSkeleton.Grid rows={[[4, 8]]} height={420} />
    </div>
  );
}

export function GuestJourneyWorkspace() {
  const hosted = useTabHost() !== null;
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  // Rooms of the property, only to name the assigned room by its number.
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
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
  // On phones and tablets the detail opens in a drawer over the list.
  const [detailOpen, setDetailOpen] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchReservations(PROPERTY_ID, { limit: PAGE_SIZE }),
      fetchRoomTypes(PROPERTY_ID),
      // The room list only enriches one step: without it the step still reads «Habitación asignada.», never the id.
      fetchRooms(PROPERTY_ID).catch((): AdminRoom[] => [])
    ])
      .then(([page, rt, roomList]) => {
        setReservations(page.items);
        setNextCursor(page.nextCursor);
        setTotal(page.total);
        setRoomTypes(rt);
        setRooms(roomList);
        // Inside Reservas › Recorrido the URL names the reservation; standalone, the first relevant one.
        const fromPath = reservationIdFromPath();
        const initial = fromPath ? { id: fromPath } : pickInitialReservation(page.items, todayIsoLocal());
        if (initial) void openReservation(initial.id, Boolean(fromPath));
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

  async function openReservation(id: string, reveal = true) {
    setDetailLoading(true);
    setDetailError(null);
    setPanelErrors({});
    setFolio(null);
    setGuest(null);
    setActivity(null);
    if (reveal) setDetailOpen(true);
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
  const filtered = reservations.filter((r) => !q || [r.code, r.bookerName, r.arrivalDate, r.departureDate, r.status].join(" ").toLowerCase().includes(q));

  // Same resolution as ReservationWorkspaceScreen: the room id → its number, or nothing.
  const assignedRoomNumber = selected?.assignedRoomId ? (rooms.find((r) => r.id === selected.assignedRoomId)?.number ?? null) : null;
  const journey = selected ? computeJourney(selected, folio, guest, assignedRoomNumber) : null;
  const listReady = !loading && !error && filtered.length > 0;

  const listFooter = !loading && !error && reservations.length > 0 ? (
    <>
      <span>
        {filtered.length}
        {total !== null ? ` de ${total}` : ` de ${reservations.length}`} reservas
      </span>
      {nextCursor ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMore} onClick={() => void loadMore()}>
          Cargar más
        </CocoaButton>
      ) : null}
    </>
  ) : undefined;

  const list = (
    <CocoaSection
      title="Reservas"
      meta={total !== null ? plural(total, "reserva", "reservas") : plural(reservations.length, "reserva", "reservas")}
      scroll={compact ? undefined : "y"}
      maxHeight={compact ? undefined : tier === "laptop" ? LIST_MAX_HEIGHT_STACKED : LIST_MAX_HEIGHT}
      padding={listReady ? "none" : "md"}
      footer={listFooter}
      aria-label="Reservas con su recorrido"
    >
      <div style={listReady ? searchInsetStyle : undefined}>
        <CocoaSearchInput value={query} onChange={setQuery} placeholder="Código, huésped, fechas, estado…" aria-label="Buscar reservas por código, huésped, fechas o estado" />
      </div>
      {loading ? (
        <CocoaState kind="loading" inline title="Cargando recorridos…" />
      ) : error ? (
        <CocoaState kind="error" title="No se pudo cargar el recorrido del huésped" message={error} onRetry={load} />
      ) : filtered.length === 0 ? (
        <CocoaState
          kind="empty"
          illustration={reservations.length ? "search" : "box"}
          title={reservations.length ? "Sin resultados" : "Todavía no hay reservas"}
          message={reservations.length ? "Ninguna reserva coincide con la búsqueda." : "Crea una reserva para ver su recorrido."}
          primaryAction={{ label: "Agente de reservas con IA", onClick: () => navigateTo("ReservationAgent") }}
        />
      ) : (
        <ul className="c22-section__list" style={listInsetStyle} aria-label="Reservas">
          {filtered.map((r) => {
            const st = listStage(r);
            const isSelected = selected?.id === r.id;
            return (
              <li key={r.id}>
                <CocoaButton
                  variant="plain"
                  tone={isSelected ? "accent" : "neutral"}
                  size="small"
                  wrap
                  onClick={() => void openReservation(r.id)}
                  aria-current={isSelected ? true : undefined}
                  style={rowButtonStyle}
                >
                  <span style={rowTextStyle}>
                    <strong>{r.code}</strong>
                    <span className="cocoa-caption">
                      {r.bookerName ?? "Huésped pendiente"} · {dateRange(r.arrivalDate, r.departureDate)}
                    </span>
                  </span>
                </CocoaButton>
                <span style={rowEndStyle}>
                  <CocoaStatusBadge entry={st.status} dense />
                  <span className="cocoa-caption">
                    {st.done} de {st.total} pasos
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CocoaSection>
  );

  const detailBody = detailLoading ? (
    <CocoaState kind="loading" inline title="Cargando el recorrido…" />
  ) : detailError ? (
    <CocoaState kind="error" title="No se pudo cargar la reserva" message={detailError.message} onRetry={() => void openReservation(detailError.id)} />
  ) : !selected || !journey ? (
    <CocoaState kind="empty" illustration="box" title="Elige una reserva" message="Su recorrido —reserva, identidad, pago, habitación, check-in, estancia y check-out— aparece aquí." />
  ) : (
    <div className="cocoa-stack" data-gap="4">
      <div className="cocoa-row" data-justify="between">
        <strong>{journey.cancelled ? STATUS_LABELS.cancelled : `${journey.done} de ${journey.total} pasos completados`}</strong>
        <span className="cocoa-caption">
          {selected.bookerName ?? guest?.fullName ?? "Huésped pendiente"} · {roomTypeName(selected.roomTypeId)}
        </span>
      </div>

      {panelErrorSummary.length > 0 ? (
        <CocoaCallout
          tone="warning"
          title="Datos no disponibles"
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void openReservation(selected.id)}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {panelErrorSummary.join(" · ")}. Los pasos de identidad y pago pueden mostrarse incompletos.
        </CocoaCallout>
      ) : null}

      {journey.next && !journey.cancelled ? (
        <CocoaCallout
          tone="accent"
          variant="banner"
          title={`Siguiente paso: ${NEXT_ACTION_LABEL[journey.next.key] ?? "Continuar el recorrido"}`}
          actions={
            journey.next.key === "identity" && selected.primaryGuestId ? (
              <CocoaButton variant="filled" tone="accent" size="small" onClick={() => go(guestPath(selected.primaryGuestId!))}>
                Abrir perfil de huésped
              </CocoaButton>
            ) : (
              <CocoaButton variant="filled" tone="accent" size="small" onClick={() => go(reservationPath(selected.id))}>
                Abrir la reserva
              </CocoaButton>
            )
          }
        >
          <CocoaBadge tone={journey.next.state === "blocked" ? "danger" : "warning"} size="small">
            {STEP_LABEL[journey.next.state]}
          </CocoaBadge>{" "}
          {journey.next.detail}
        </CocoaCallout>
      ) : null}

      <ol className="c22-section__list" aria-label="Pasos del recorrido">
        {journey.steps.map((s) => {
          const isNext = journey.next?.key === s.key;
          return (
            <li key={s.key} aria-current={isNext ? "step" : undefined}>
              <span style={stepTextStyle}>
                <strong>{s.label}</strong>
                <span className="cocoa-caption">{s.detail}</span>
              </span>
              <CocoaBadge tone={STEP_TONE[s.state]} variant="dot" size="small">
                {isNext ? "Siguiente" : STEP_LABEL[s.state]}
              </CocoaBadge>
            </li>
          );
        })}
      </ol>

      {/* Requests & messages — direct line to chat, housekeeping, maintenance */}
      <CocoaSection
        title="Peticiones y mensajes"
        meta={
          activity ? (
            <CocoaBadge tone={activity.counts.openTotal ? "warning" : "success"}>{plural(activity.counts.openTotal, "abierta", "abiertas")}</CocoaBadge>
          ) : (
            "De todos los departamentos"
          )
        }
        footer={
          activity ? (
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("ConciergeInboxDashboard")}>
                Abrir bandeja de mensajes
              </CocoaButton>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("HousekeepingDashboard")}>
                Tablero de pisos
              </CocoaButton>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("MaintenanceDashboard")}>
                Tablero de mantenimiento
              </CocoaButton>
            </div>
          ) : undefined
        }
      >
        {!activity ? (
          panelErrors.activity ? (
            <CocoaState kind="degraded" inline title="Actividad no disponible" message={panelErrors.activity} />
          ) : (
            <CocoaState kind="loading" inline title="Cargando la actividad…" />
          )
        ) : (
          <>
            <span className="cocoa-cluster">
              <CocoaBadge tone="info">
                {plural(activity.counts.messages, "mensaje", "mensajes")}
                {activity.counts.unreadGuest ? ` · ${plural(activity.counts.unreadGuest, "espera respuesta", "esperan respuesta")}` : ""}
              </CocoaBadge>
              <CocoaBadge tone="success">{plural(activity.counts.housekeeping, "aviso de pisos", "avisos de pisos")}</CocoaBadge>
              <CocoaBadge tone="warning">{plural(activity.counts.maintenance, "aviso de mantenimiento", "avisos de mantenimiento")}</CocoaBadge>
              <CocoaBadge tone="ai">{plural(activity.counts.serviceRequests, "petición", "peticiones")}</CocoaBadge>
            </span>
            {activity.items.length === 0 ? (
              <CocoaState kind="empty" inline title="Este huésped no tiene mensajes, quejas ni peticiones a departamentos." />
            ) : (
              <ul className="c22-section__list" aria-label="Actividad reciente">
                {activity.items.slice(0, 12).map((it) => (
                  <li key={`${it.kind}-${it.id}`}>
                    <span style={stepTextStyle}>
                      <span className="cocoa-cluster">
                        <CocoaBadge tone={KIND_TONE[it.kind]} size="small">
                          {it.department}
                        </CocoaBadge>
                        <strong>{it.title}</strong>
                        {it.priority && it.priority !== "normal" ? (
                          <CocoaBadge tone="neutral" size="small">
                            {PRIORITY_LABEL[it.priority] ?? it.priority}
                          </CocoaBadge>
                        ) : null}
                      </span>
                      {it.detail ? <span className="cocoa-caption">{it.detail}</span> : null}
                    </span>
                    <span style={rowEndStyle}>
                      {it.status ? (
                        <CocoaBadge tone={it.open ? "warning" : "neutral"} size="small">
                          {ITEM_STATUS_LABEL[it.status] ?? it.status.replace(/_/g, " ")}
                        </CocoaBadge>
                      ) : null}
                      <span className="cocoa-caption">{relativeTime(it.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CocoaSection>

      <div className="cocoa-row" data-gap="2">
        <CocoaButton variant="filled" tone="accent" onClick={() => go(reservationPath(selected.id))}>
          Ver detalle completo
        </CocoaButton>
        {selected.primaryGuestId ? (
          <CocoaButton variant="bordered" tone="neutral" onClick={() => go(guestPath(selected.primaryGuestId!))}>
            Perfil del huésped
          </CocoaButton>
        ) : null}
        <CocoaButton variant="bordered" tone="neutral" onClick={() => navigateTo("BillingCenter")}>
          Facturación
        </CocoaButton>
      </div>
    </div>
  );

  const detail = (
    <CocoaSection title="Detalle del recorrido" meta={selected?.code ?? "Elige una reserva"} aria-label="Detalle del recorrido">
      {detailBody}
    </CocoaSection>
  );

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title="Recorrido del huésped"
      subtitle={
        hosted
          ? undefined
          : "El avance real de cada reserva —reserva, identidad (SES), pago, habitación, check-in, estancia y check-out— con el paso bloqueado y la siguiente mejor acción. Elige una reserva para ver su recorrido completo y actuar."
      }
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={load} disabled={loading}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      state={loading && reservations.length === 0 ? "loading" : "ready"}
      skeleton={<JourneySkeleton />}
      commands={[
        { id: "guest-journey-refresh", label: "Actualizar recorridos", run: load },
        { id: "guest-journey-agent", label: "Agente de reservas con IA", run: () => navigateTo("ReservationAgent") }
      ]}
    >
      {compact ? (
        <>
          {list}
          <CocoaDrawer
            open={detailOpen && (selected !== null || detailLoading || detailError !== null)}
            onClose={() => setDetailOpen(false)}
            title={selected ? `Recorrido de ${selected.code}` : "Recorrido"}
            subtitle={selected ? `${selected.bookerName ?? guest?.fullName ?? "Huésped pendiente"} · ${roomTypeName(selected.roomTypeId)}` : undefined}
            side="right"
            size="lg"
            footer={
              <CocoaButton variant="bordered" tone="neutral" onClick={() => setDetailOpen(false)}>
                {ACTIONS.close}
              </CocoaButton>
            }
          >
            {detailBody}
          </CocoaDrawer>
        </>
      ) : (
        <CocoaGrid align="start" aria-label="Reservas y recorrido">
          <CocoaSpan cols={4} min={320}>
            {list}
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            {detail}
          </CocoaSpan>
        </CocoaGrid>
      )}
    </CocoaPage>
  );
}
