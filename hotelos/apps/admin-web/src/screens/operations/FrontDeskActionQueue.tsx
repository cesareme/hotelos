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

import { useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { navigateTo } from "../../lib/navigate";
import { number } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { urlForScreen } from "../../navigation/nav-tree";
import { SparkleIcon } from "../../components/cocoa-icons/NavigationIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaGrid,
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
  | "repeat_arriving";

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
  | "start_checkout";

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
  repeat_arriving: "Recurrente"
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
  repeat_arriving: "info"
};

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

function elapsedText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function executeAction(
  action: QueueAction,
  propertyId: string,
  drawerCtx: { openCheckIn: (id: string) => void; openCheckOut: (id: string) => void }
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
          await apiRequest<unknown>(`/reservations/${encodeURIComponent(String(reservationId))}/assign-room`, {
            method: "POST",
            body: { roomId }
          });
        } catch {
          // Fallback: navigate to detail screen so the user can do it manually.
          // A 401 has already cleared the session inside apiRequest.
          navigateTo("ReservationDetailWorkspace");
          return { ok: false, message: "Asigna desde la reserva" };
        }
        return { ok: true, message: "Habitación asignada" };
      }
      case "mark_no_show": {
        const reservationId = payload?.reservationId;
        if (!reservationId) return { ok: false, message: "Falta reservationId" };
        try {
          await apiRequest<unknown>(`/reservations/${encodeURIComponent(String(reservationId))}/no-show`, {
            method: "POST",
            body: {}
          });
        } catch {
          navigateTo("ReservationDetailWorkspace");
          return { ok: false, message: "Marca desde la reserva" };
        }
        return { ok: true, message: "Marcada como no-show" };
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

export function FrontDeskActionQueue() {
  const propertyId = getActivePropertyId();
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<QueueResponse>(
    `/dashboards/front-desk-queue?propertyId=${propertyId}`,
    { pollIntervalMs: 30000 }
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [checkInReservationId, setCheckInReservationId] = useState<string | null>(null);
  const [checkOutReservationId, setCheckOutReservationId] = useState<string | null>(null);

  const items = data?.items ?? [];
  const summary = data?.summary ?? { urgent: 0, today: 0, soon: 0, total: 0 };
  const filtered = filter === "all" ? items : items.filter((i) => i.priority === filter);

  const drawerCtx = {
    openCheckIn: (id: string) => setCheckInReservationId(id),
    openCheckOut: (id: string) => setCheckOutReservationId(id)
  };

  async function handleAction(item: QueueItem, action: QueueAction) {
    setBusy(item.id);
    const result = await executeAction(action, propertyId, drawerCtx);
    setBusy(null);
    if (result.message) {
      showToast(result.message, { variant: result.ok ? "success" : "warning" });
    }
    if (result.ok && action.kind !== "start_checkin" && action.kind !== "start_checkout") {
      refresh();
    }
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
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={refresh} aria-label="Recargar la cola">
            {ACTIONS.refresh}
          </CocoaButton>
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
          onCompleted={({ elapsedSeconds }) => {
            showToast(`Check-in completado en ${elapsedText(elapsedSeconds)}`, { variant: "success", duration: 5000 });
            refresh();
          }}
        />
      ) : null}
      {checkOutReservationId ? (
        <QuickCheckOutDrawer
          reservationId={checkOutReservationId}
          onClose={() => setCheckOutReservationId(null)}
          onCompleted={({ elapsedSeconds }) => {
            showToast(`Check-out completado en ${elapsedText(elapsedSeconds)}`, { variant: "success", duration: 5000 });
            refresh();
          }}
        />
      ) : null}
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
