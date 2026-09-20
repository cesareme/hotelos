// Front Desk Action Queue — la cola priorizada que sustituye la mentalidad
// "dashboard de listas" por "esto es lo que tienes que hacer ahora".
//
// Lee de /dashboards/front-desk-queue, agrupa por priority, y para cada item
// muestra:
//   - badge de prioridad y kind
//   - título + contexto (huésped, habitación, motivo)
//   - recomendación en lenguaje natural ("La 405 está limpia. ¿Asignar?")
//   - botón primario que ejecuta o navega a la siguiente acción correcta
//
// La directriz manda que toda acción frecuente esté a máximo 2 clics: aquí
// están a 1.
//
// Cocoa 22 (ola 2 · lote 2-A): sub-view of FrontDeskDashboard (no page
// header of its own) painted as a `CocoaSection` with a content toolbar
// (priority `CocoaSegmentedControl` + refresh), a `CocoaGrid` of `CocoaCard`
// items, `CocoaState` for loading / error / empty and the shared toast
// (`useToast`) instead of a local status pill. Same endpoint and actions.
//
// Tanda UX-1 · lote U3 (docs/design/UX-RECEPCION-FEEL.md §5.1 (7)-(9), §6.2):
// la cola se lee con `staleTime` y sondeo consciente de la pestaña; tras una
// acción o un check-in/out no se recarga todo (`refresh()`): se invalidan las
// claves de Mi día y la cola se revalida en segundo plano sin esqueleto;
// `assign_room` es optimista (`mutate`): la tarjeta desaparece al instante y
// vuelve con un aviso si el API rechaza la asignación.
//
// Tanda UX-1 · lote U6 (§5.1 (9), §4.2, F9, F4): `mark_no_show` ya no escribe a
// un clic con cuerpo `{}`: abre el mismo diálogo nominal que la ficha
// (components/reservations/LifecycleDialog: motivo obligatorio, penalización
// prevista, «Marcar no-show (penalización X €)» / «Mantener la reserva») y la
// tarjeta sale de la cola cuando el API confirma; la acción de cabecera
// «Walk-in» abre el cajón de Mi día (`onWalkIn`) o, sin él, el evento del
// shell (⌥W); un fallo de `assign_room` se queda en Mi día con el mensaje del
// API (409 ocupada…) en vez de saltar a la lista de reservas.
//
// Tanda CHK · W4-B (docs/design/CHECKIN-AUTOMATIZADO-IA.md §8, fila «Cola de
// acciones»; detectores de W3-D en front-desk-queue.service.ts): ocho `kind`
// nuevos con etiqueta y tono (precheckin_ready, assignment_suggested,
// self_checkin_done, identity_review, minor_without_guardian, room_not_ready,
// payment_failed, ses_rejected, signature_pending) y dos acciones: `confirm_assignment` (POST
// /assignment-suggestions/:id/confirm, optimista como `assign_room`; una
// primera asignación no tiene reversa, así que sin «Deshacer») y
// `open_precheckin` (abre ArrivalPreCheckInDrawer, solo lectura). Sin `style=`
// nuevos (presupuesto 15, hoy 4).

import { useState, type CSSProperties } from "react";
import { invalidateApi, useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { OPEN_WALK_IN_EVENT, shortcutKeys } from "../../content/shortcuts-registry";
import { LifecycleDialog } from "../../components/reservations/LifecycleDialog";
import { getActivePropertyId } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { navigateTo } from "../../lib/navigate";
import { number } from "../../lib/format";
import { ACTIONS, FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS } from "../../content/actions";
import { urlForScreen } from "../../navigation/nav-tree";
import { SparkleIcon } from "../../components/cocoa-icons/NavigationIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaGrid,
  CocoaKbd,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSpan,
  CocoaState,
  CocoaToolbar,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";
import { QuickCheckInDrawer } from "./QuickCheckInDrawer";
import { QuickCheckOutDrawer } from "./QuickCheckOutDrawer";
import { ArrivalPreCheckInDrawer } from "./ArrivalPreCheckInDrawer";
import { confirmSuggestion } from "../../services/checkinApi";

type Priority = "urgent" | "today" | "soon";

type QueueKind =
  | "overbooking"
  | "no_show_risk"
  | "late_checkout_overdue"
  | "incident_open"
  | "unassigned_arrival"
  | "checkin_blocked"
  | "housekeeping_late"
  | "open_balance"
  | "checkout_pending"
  | "checkin_ready"
  | "vip_arriving"
  | "repeat_arriving"
  // Tanda CHK · W3-D
  | "precheckin_ready"
  | "assignment_suggested"
  | "self_checkin_done"
  | "identity_review"
  | "minor_without_guardian"
  | "room_not_ready"
  | "payment_failed"
  | "ses_rejected"
  // Corrector L7-REV-05: «Firmar en recepción» pedido desde el kiosco/móvil.
  | "signature_pending";

/** Los nueve `kind` del check-in automatizado (orden del servicio). */
export const CHECKIN_QUEUE_KINDS: readonly QueueKind[] = ["precheckin_ready", "assignment_suggested", "self_checkin_done", "identity_review", "minor_without_guardian", "room_not_ready", "payment_failed", "ses_rejected", "signature_pending"];

type ActionKind =
  | "open_reservation"
  | "open_room_rack"
  | "open_housekeeping"
  | "open_work_order"
  | "assign_room"
  | "mark_no_show"
  | "open_folio"
  | "open_guest"
  | "start_checkin"
  | "start_checkout"
  // Tanda CHK · W3-D
  | "confirm_assignment"
  | "open_precheckin";

type QueueAction = {
  label: string;
  kind: ActionKind;
  payload?: Record<string, string | number | boolean | undefined>;
};

type QueueItem = {
  id: string;
  priority: Priority;
  kind: QueueKind;
  title: string;
  context: string;
  recommendation?: string;
  primaryAction?: QueueAction;
  secondaryActions?: QueueAction[];
  reservationId?: string;
  roomId?: string;
  guestId?: string;
  workOrderId?: string;
};

type QueueResponse = {
  generatedAt: string;
  items: QueueItem[];
  counts: Record<QueueKind, number>;
  summary: { urgent: number; today: number; soon: number; total: number };
};

// ------------------------------------------------------------------ display

const KIND_LABEL: Record<QueueKind, string> = {
  overbooking: "Overbooking",
  no_show_risk: "Riesgo no-show",
  late_checkout_overdue: "Late check-out",
  incident_open: "Incidencia",
  unassigned_arrival: "Sin habitación",
  checkin_blocked: "HK no lista",
  housekeeping_late: "HK urgente",
  open_balance: "Saldo abierto",
  checkout_pending: "Check-out pendiente",
  checkin_ready: "Listo para check-in",
  vip_arriving: "VIP",
  repeat_arriving: "Recurrente",
  precheckin_ready: "Pre-check-in listo",
  assignment_suggested: "Habitación sugerida",
  self_checkin_done: "Check-in autónomo",
  identity_review: "Revisar identidad",
  minor_without_guardian: "Menor sin adulto",
  room_not_ready: "Habitación no lista",
  payment_failed: "Pago rechazado",
  ses_rejected: "Parte SES rechazado",
  signature_pending: "Firma en recepción"
};

const KIND_TONE: Record<QueueKind, CocoaTone> = {
  overbooking: "danger",
  no_show_risk: "danger",
  late_checkout_overdue: "danger",
  incident_open: "danger",
  unassigned_arrival: "warning",
  checkin_blocked: "warning",
  housekeeping_late: "danger",
  open_balance: "warning",
  checkout_pending: "warning",
  checkin_ready: "success",
  vip_arriving: "accent",
  repeat_arriving: "info",
  precheckin_ready: "success",
  assignment_suggested: "info",
  self_checkin_done: "success",
  identity_review: "danger",
  minor_without_guardian: "danger",
  room_not_ready: "warning",
  payment_failed: "warning",
  ses_rejected: "danger",
  signature_pending: "warning"
};

/** Etiqueta del badge de un `kind`; un valor desconocido lee «Acción pendiente», nunca el enum (P6). */
export function queueKindLabel(kind: string): string {
  return KIND_LABEL[kind as QueueKind] ?? "Acción pendiente";
}

/** Tono del badge de un `kind`; desconocido → neutral. */
export function queueKindTone(kind: string): CocoaTone {
  return KIND_TONE[kind as QueueKind] ?? "neutral";
}

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgente",
  today: "Hoy",
  soon: "Próximo"
};

const PRIORITY_TONE: Record<Priority, CocoaTone> = {
  urgent: "danger",
  today: "warning",
  soon: "info"
};

type Filter = Priority | "all";

// ------------------------------------------------------------------ helpers

type ActionContext = {
  openCheckIn: (id: string) => void;
  openCheckOut: (id: string) => void;
  /** U6 · F9: el no-show pasa por el diálogo nominal con motivo y penalización; la tarjeta sale al confirmar el API. */
  openNoShow: (itemId: string, reservationId: string) => void;
  /** Asignación optimista (U3): quita la tarjeta al instante; rechaza si el API falla (rollback ya hecho). */
  assignRoom: (itemId: string, reservationId: string, roomId: string) => Promise<void>;
  /** Tanda CHK: confirma la sugerencia del motor (o una candidata) con el mismo optimismo que `assignRoom`. */
  confirmAssignment: (itemId: string, suggestionId: string, roomId: string) => Promise<void>;
  /** Tanda CHK: abre el cajón de solo lectura del pre-check-in de la reserva. */
  openPreCheckIn: (reservationId: string) => void;
};

/** «Asignar 102» / «Confirmar 102» → «102» (colas anteriores a `payload.roomNumber`); vacío si no hay número. */
export function roomNumberFromLabel(label: string | undefined): string {
  const match = /^(?:Asignar|Confirmar)\s+(\S+)$/i.exec((label ?? "").trim());
  return match ? match[1] : "";
}

/** Optimismo de `assign_room`: la tarjeta sale de la cola y los contadores bajan en uno. */
export function removeQueueItem(prev: QueueResponse, itemId: string): QueueResponse {
  const item = prev.items.find((entry) => entry.id === itemId);
  if (!item) return prev;
  const counts = { ...prev.counts, [item.kind]: Math.max(0, (prev.counts[item.kind] ?? 0) - 1) };
  const summary = {
    ...prev.summary,
    [item.priority]: Math.max(0, prev.summary[item.priority] - 1),
    total: Math.max(0, prev.summary.total - 1)
  };
  return { ...prev, items: prev.items.filter((entry) => entry.id !== itemId), counts, summary };
}

/** Tras una acción de la cola o un check-in/out: Mi día y la cola se revalidan en segundo plano. */
export function invalidateFrontDesk(): void {
  invalidateApi("/dashboards/front-desk-queue");
  invalidateApi("/dashboards/front-desk");
}

async function executeAction(
  action: QueueAction,
  propertyId: string,
  drawerCtx: ActionContext,
  itemId: string
): Promise<{ ok: boolean; message?: string }> {
  const { kind, payload } = action;
  void propertyId;
  try {
    switch (kind) {
      case "start_checkin": {
        const id = String(payload?.reservationId ?? "");
        if (id) {
          drawerCtx.openCheckIn(id);
          return { ok: true };
        }
        return { ok: false, message: "Falta reservationId" };
      }
      case "start_checkout": {
        const id = String(payload?.reservationId ?? "");
        if (id) {
          drawerCtx.openCheckOut(id);
          return { ok: true };
        }
        return { ok: false, message: "Falta reservationId" };
      }
      case "open_reservation":
      case "open_folio": {
        // Land on the reservation's own detail URL when the queue names it.
        const rid = String(payload?.reservationId ?? "");
        const url = rid ? urlForScreen("ReservationDetailWorkspace", { id: rid }) : null;
        if (url) openTabPath(url);
        else navigateTo("ReservationDetailWorkspace");
        return { ok: true };
      }
      case "open_room_rack":
        navigateTo("RoomRackScreen");
        return { ok: true };
      case "open_housekeeping":
        navigateTo("HousekeepingDashboard");
        return { ok: true };
      case "open_work_order":
        navigateTo("MaintenanceDashboard");
        return { ok: true };
      case "open_guest": {
        // One history entry: the concrete tab URL (/recepcion/huespedes/:id/cronologia)
        // through openTabPath, instead of pushState(?guestId) + a second push by
        // the shell (code-review#4).
        const gid = String(payload?.guestId ?? "");
        const url = gid ? urlForScreen("GuestTimelineScreen", { id: gid }) : null;
        if (url) openTabPath(url);
        else navigateTo("GuestTimelineScreen");
        return { ok: true };
      }
      case "assign_room": {
        const reservationId = payload?.reservationId;
        const roomId = payload?.roomId;
        if (!reservationId || !roomId) return { ok: false, message: "Datos incompletos" };
        try {
          await drawerCtx.assignRoom(itemId, String(reservationId), String(roomId));
        } catch (err) {
          // U6: el rollback ya devolvió la tarjeta; el recepcionista se queda en Mi
          // día con el motivo del API (409 ocupada…). A 401 has already cleared the session.
          return { ok: false, message: err instanceof Error && err.message ? err.message : "No se pudo asignar la habitación" };
        }
        // L-11 (b): el toast dice qué habitación (la cola manda `roomNumber`); sin reversa en el API para una primera asignación (no hay «Deshacer»).
        const roomNumber = String(payload?.roomNumber ?? "").trim() || roomNumberFromLabel(action.label);
        return { ok: true, message: roomNumber ? FRONT_DESK_TOASTS.roomAssigned(roomNumber) : "Habitación asignada" };
      }
      case "mark_no_show": {
        const reservationId = payload?.reservationId;
        if (!reservationId) return { ok: false, message: "Falta reservationId" };
        // F9: nunca a un clic; el diálogo nominal confirma con motivo y penalización.
        drawerCtx.openNoShow(itemId, String(reservationId));
        return { ok: true };
      }
      case "confirm_assignment": {
        // Tanda CHK: POST /assignment-suggestions/:id/confirm { roomId } (la candidata del botón); optimista como assign_room.
        const suggestionId = payload?.suggestionId;
        const roomId = payload?.roomId;
        if (!suggestionId || !roomId) return { ok: false, message: "Datos incompletos" };
        try {
          await drawerCtx.confirmAssignment(itemId, String(suggestionId), String(roomId));
        } catch (err) {
          return { ok: false, message: err instanceof Error && err.message ? err.message : "No se pudo confirmar la habitación" };
        }
        const roomNumber = String(payload?.roomNumber ?? "").trim() || roomNumberFromLabel(action.label);
        return { ok: true, message: roomNumber ? FRONT_DESK_TOASTS.roomAssigned(roomNumber) : "Habitación confirmada" };
      }
      case "open_precheckin": {
        const id = String(payload?.reservationId ?? "");
        if (id) {
          drawerCtx.openPreCheckIn(id);
          return { ok: true };
        }
        return { ok: false, message: "Falta reservationId" };
      }
      default:
        return { ok: false, message: "Acción no soportada" };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Error" };
  }
}

// Card body: flex column so the actions row sits at the bottom of equal-height cells.
const cardStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", minHeight: 140, height: "100%" };
const actionsRowStyle: CSSProperties = { marginTop: "auto" };

const titleStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)"
};

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: "var(--cocoa-lh-caption)"
};

// ------------------------------------------------------------------ component

export type FrontDeskActionQueueProps = {
  /** Abre el cajón de walk-in de Mi día; sin él, el botón despacha el evento del shell (⌥W). */
  onWalkIn?: () => void;
};

/** Reserva del diálogo de no-show: la tarjeta de la cola y el código real de la reserva (GET desde la caché). */
type NoShowTarget = { itemId: string; reservation: { id: string; code: string; currency?: string | null } };

export function FrontDeskActionQueue({ onWalkIn }: FrontDeskActionQueueProps = {}) {
  const propertyId = getActivePropertyId();
  const { showToast } = useToast();
  const { data, loading, error, refresh, mutate } = useApiData<QueueResponse>(
    `/dashboards/front-desk-queue?propertyId=${propertyId}`,
    { pollIntervalMs: 30000, staleTime: 30000 }
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [checkInReservationId, setCheckInReservationId] = useState<string | null>(null);
  const [checkOutReservationId, setCheckOutReservationId] = useState<string | null>(null);
  const [noShowTarget, setNoShowTarget] = useState<NoShowTarget | null>(null);
  const [preCheckInReservationId, setPreCheckInReservationId] = useState<string | null>(null);

  const items = data?.items ?? [];
  const summary = data?.summary ?? { urgent: 0, today: 0, soon: 0, total: 0 };
  const filtered = filter === "all" ? items : items.filter((i) => i.priority === filter);

  const drawerCtx: ActionContext = {
    openCheckIn: (id: string) => setCheckInReservationId(id),
    openCheckOut: (id: string) => setCheckOutReservationId(id),
    openNoShow: (itemId, reservationId) => {
      void apiRequest<{ id: string; code: string; currency?: string | null }>(`/reservations/${encodeURIComponent(reservationId)}`)
        .then((reservation) => setNoShowTarget({ itemId, reservation: { id: reservation.id, code: reservation.code, currency: reservation.currency } }))
        .catch(() => setNoShowTarget({ itemId, reservation: { id: reservationId, code: reservationId } }));
    },
    assignRoom: (itemId, reservationId, roomId) =>
      mutate(
        (prev) => removeQueueItem(prev, itemId),
        (request) => request<void>(`/reservations/${encodeURIComponent(reservationId)}/assign-room`, { method: "POST", body: { roomId } })
      ),
    confirmAssignment: (itemId, suggestionId, roomId) =>
      mutate(
        (prev) => removeQueueItem(prev, itemId),
        () => confirmSuggestion(suggestionId, roomId).then(() => undefined)
      ),
    openPreCheckIn: (reservationId) => setPreCheckInReservationId(reservationId)
  };

  async function handleAction(item: QueueItem, action: QueueAction) {
    setBusy(item.id);
    const result = await executeAction(action, propertyId, drawerCtx, item.id);
    setBusy(null);
    if (result.message) {
      showToast(result.message, { variant: result.ok ? "success" : "warning" });
    }
    if (result.ok && action.kind === "assign_room") {
      // `mutate` ya revalida la cola al terminar el commit; Mi día se invalida aparte.
      invalidateApi("/dashboards/front-desk");
    } else if (result.ok && action.kind === "confirm_assignment") {
      // Tanda CHK: igual que assign_room, más el catálogo de habitaciones (la confirmada deja de estar libre).
      invalidateApi("/dashboards/front-desk");
      invalidateApi(`/properties/${propertyId}/rooms`);
    } else if (result.ok && action.kind !== "start_checkin" && action.kind !== "start_checkout" && action.kind !== "mark_no_show" && action.kind !== "open_precheckin") {
      invalidateFrontDesk();
    }
  }

  function openWalkIn() {
    if (onWalkIn) {
      onWalkIn();
      return;
    }
    // Sin Mi día alrededor: el shell abre Nueva reserva si nadie reclama el evento (fallback honesto).
    window.dispatchEvent(new CustomEvent(OPEN_WALK_IN_EVENT, { cancelable: true }));
  }

  const filterOptions = [
    { value: "all", label: `Todo · ${number(summary.total)}` },
    { value: "urgent", label: `${PRIORITY_LABEL.urgent} · ${number(summary.urgent)}` },
    { value: "today", label: `${PRIORITY_LABEL.today} · ${number(summary.today)}` },
    { value: "soon", label: `${PRIORITY_LABEL.soon} · ${number(summary.soon)}` }
  ];

  return (
    <CocoaSection title="Lo siguiente que hay que hacer" aria-label="Cola de acciones de recepción">
      <CocoaToolbar
        variant="content"
        aria-label="Filtro de prioridad"
        leftSlot={<CocoaSegmentedControl size="small" aria-label="Prioridad" value={filter} onChange={(value) => setFilter(value as Filter)} options={filterOptions} />}
        rightSlot={
          <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={openWalkIn} icon={<CocoaKbd>{shortcutKeys("nav.walk-in")}</CocoaKbd>} iconPosition="right" title={`Alta de una llegada sin reserva (${shortcutKeys("nav.walk-in")})`}>
              {FRONT_DESK_ACTIONS.walkIn}
            </CocoaButton>
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={refresh} aria-label="Recargar la cola">
              {ACTIONS.refresh}
            </CocoaButton>
          </div>
        }
      />

      {loading && items.length === 0 ? (
        <CocoaState kind="loading" title="Calculando cola operativa…" />
      ) : error ? (
        <CocoaState kind="error" title="Algo no fue bien" message={error} onRetry={refresh} />
      ) : filtered.length === 0 ? (
        <CocoaState
          kind="empty"
          illustration={filter === "all" ? "box" : "search"}
          title={filter === "all" ? "No hay acciones pendientes" : `No hay acciones con prioridad «${PRIORITY_LABEL[filter as Priority]}»`}
          message={
            filter === "all"
              ? "Todo bajo control. Volveremos a recalcular la cola en segundo plano."
              : "Cambia el filtro para ver otras prioridades o espera a que se generen nuevas acciones."
          }
          secondaryAction={filter === "all" ? undefined : { label: ACTIONS.clearFilters, onClick: () => setFilter("all") }}
        />
      ) : (
        <CocoaGrid aria-label="Acciones pendientes">
          {filtered.map((item) => (
            <CocoaSpan key={item.id} cols={4} min={320}>
              <ActionCard
                item={item}
                busy={busy === item.id}
                onPrimary={() => item.primaryAction && handleAction(item, item.primaryAction)}
                onSecondary={(a) => handleAction(item, a)}
              />
            </CocoaSpan>
          ))}
        </CocoaGrid>
      )}

      {/* Drawers in-place — abren slide-over sin perder contexto. */}
      {checkInReservationId ? (
        <QuickCheckInDrawer
          reservationId={checkInReservationId}
          onClose={() => setCheckInReservationId(null)}
          onCompleted={() => {
            // El cajón ya avisa con el número de habitación y el resultado SES; aquí solo se revalida.
            invalidateFrontDesk();
          }}
        />
      ) : null}
      {checkOutReservationId ? (
        <QuickCheckOutDrawer
          reservationId={checkOutReservationId}
          onClose={() => setCheckOutReservationId(null)}
          onCompleted={() => {
            invalidateFrontDesk();
          }}
        />
      ) : null}
      {/* Tanda CHK: cajón de solo lectura del pre-check-in (open_precheckin); «Abrir check-in» salta al cajón de 90 s. */}
      {preCheckInReservationId ? (
        <ArrivalPreCheckInDrawer
          reservationId={preCheckInReservationId}
          propertyId={propertyId}
          onClose={() => setPreCheckInReservationId(null)}
          onOpenCheckIn={(reservationId) => {
            setPreCheckInReservationId(null);
            setCheckInReservationId(reservationId);
          }}
          onChanged={invalidateFrontDesk}
        />
      ) : null}
      <LifecycleDialog
        open={Boolean(noShowTarget)}
        mode="no_show"
        reservation={noShowTarget?.reservation ?? null}
        onClose={() => setNoShowTarget(null)}
        onDone={() => {
          // La tarjeta sale de la cola cuando el API confirma (no antes: es irreversible).
          const itemId = noShowTarget?.itemId;
          if (itemId) void mutate((prev) => removeQueueItem(prev, itemId), () => Promise.resolve()).catch(() => undefined);
          invalidateApi("/dashboards/front-desk");
        }}
      />
    </CocoaSection>
  );
}

function ActionCard({
  item,
  busy,
  onPrimary,
  onSecondary
}: {
  item: QueueItem;
  busy: boolean;
  onPrimary: () => void;
  onSecondary: (a: QueueAction) => void;
}) {
  const tone = KIND_TONE[item.kind];

  return (
    <CocoaCard variant="bordered" padding="md" style={cardStyle} role="group" aria-label={item.title}>
      <div className="cocoa-row" data-gap="1">
        <CocoaBadge tone={PRIORITY_TONE[item.priority]} variant="tinted" size="small">
          {PRIORITY_LABEL[item.priority]}
        </CocoaBadge>
        <CocoaBadge tone={tone} size="small">
          {KIND_LABEL[item.kind]}
        </CocoaBadge>
      </div>
      <div className="cocoa-stack" data-gap="1">
        <strong style={titleStyle}>{item.title}</strong>
        <p style={mutedStyle}>{item.context}</p>
      </div>
      {item.recommendation ? (
        <CocoaCallout tone={tone} icon={<SparkleIcon size={16} />}>
          {item.recommendation}
        </CocoaCallout>
      ) : null}
      <div className="cocoa-row" data-gap="1" style={actionsRowStyle}>
        {item.primaryAction ? (
          <CocoaButton variant="filled" tone="accent" size="small" disabled={busy} loading={busy} onClick={onPrimary}>
            {item.primaryAction.label}
          </CocoaButton>
        ) : null}
        {item.secondaryActions?.map((a, idx) => (
          <CocoaButton key={idx} variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onSecondary(a)}>
            {a.label}
          </CocoaButton>
        ))}
      </div>
    </CocoaCard>
  );
}
