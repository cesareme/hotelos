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

import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { EmptyState, ErrorState } from "../../components/States";
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

const KIND_TONE: Record<QueueKind, "danger" | "warning" | "accent" | "ok" | "info"> = {
  overbooking: "danger",
  no_show_risk: "danger",
  late_checkout_overdue: "danger",
  incident_open: "danger",
  unassigned_arrival: "warning",
  checkin_blocked: "warning",
  housekeeping_late: "danger",
  open_balance: "warning",
  checkout_pending: "warning",
  checkin_ready: "ok",
  vip_arriving: "accent",
  repeat_arriving: "info"
};

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgente",
  today: "Hoy",
  soon: "Próximo"
};

const PRIORITY_TONE: Record<Priority, "danger" | "warning" | "info"> = {
  urgent: "danger",
  today: "warning",
  soon: "info"
};

// ------------------------------------------------------------------ helpers

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

async function executeAction(
  action: QueueAction,
  propertyId: string,
  drawerCtx: { openCheckIn: (id: string) => void; openCheckOut: (id: string) => void }
): Promise<{ ok: boolean; message?: string }> {
  const { kind, payload } = action;
  const base = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
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
      case "open_folio":
        navigateTo("ReservationDetailWorkspace");
        return { ok: true };
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
        const gid = String(payload?.guestId ?? "");
        if (gid && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.set("guestId", gid);
          window.history.pushState({}, "", url);
        }
        navigateTo("GuestTimelineScreen");
        return { ok: true };
      }
      case "assign_room": {
        const reservationId = payload?.reservationId;
        const roomId = payload?.roomId;
        if (!reservationId || !roomId) return { ok: false, message: "Datos incompletos" };
        const res = await fetch(`${base}/reservations/${reservationId}/assign-room`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId })
        });
        if (!res.ok) {
          // Fallback: navigate to detail screen so the user can do it manually.
          navigateTo("ReservationDetailWorkspace");
          return { ok: false, message: "Asigna desde la reserva" };
        }
        return { ok: true, message: "Habitación asignada" };
      }
      case "mark_no_show": {
        const reservationId = payload?.reservationId;
        if (!reservationId) return { ok: false, message: "Falta reservationId" };
        const res = await fetch(`${base}/reservations/${reservationId}/no-show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        if (!res.ok) {
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

// ------------------------------------------------------------------ component

export function FrontDeskActionQueue() {
  const propertyId = getActivePropertyId();
  const { data, loading, error, refresh } = useApiData<QueueResponse>(
    `/dashboards/front-desk-queue?propertyId=${propertyId}`,
    { pollIntervalMs: 30000 }
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState<Priority | "all">("all");
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
    setToast(null);
    const result = await executeAction(action, propertyId, drawerCtx);
    setBusy(null);
    if (result.message) {
      setToast({ kind: result.ok ? "ok" : "warn", text: result.message });
      setTimeout(() => setToast(null), 4000);
    }
    if (result.ok && action.kind !== "start_checkin" && action.kind !== "start_checkout") {
      refresh();
    }
  }

  return (
    <article className="bo-card" style={{ background: "var(--surface)" }}>
      <div className="bo-card-head">
        <h3 style={{ color: "var(--ink)" }}>Lo siguiente que hay que hacer</h3>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className={filter === "all" ? "primary" : "ghost"}
            onClick={() => setFilter("all")}
          >
            Todo · {summary.total}
          </button>
          <button
            type="button"
            className={filter === "urgent" ? "primary" : "ghost"}
            onClick={() => setFilter("urgent")}
          >
            <span className="bo-status error">{summary.urgent}</span> Urgente
          </button>
          <button
            type="button"
            className={filter === "today" ? "primary" : "ghost"}
            onClick={() => setFilter("today")}
          >
            <span className="bo-status warn">{summary.today}</span> Hoy
          </button>
          <button
            type="button"
            className={filter === "soon" ? "primary" : "ghost"}
            onClick={() => setFilter("soon")}
          >
            <span className="bo-status info">{summary.soon}</span> Próximo
          </button>
          <button type="button" className="ghost" onClick={refresh} title="Recargar">↻</button>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <p className="bo-muted">Calculando cola operativa…</p>
      ) : error ? (
        <ErrorState
          title="Algo no fue bien"
          message={error}
          onRetry={refresh}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={filter === "all" ? "No hay acciones pendientes" : `No hay items con prioridad "${PRIORITY_LABEL[filter as Priority]}"`}
          message={filter === "all" ? "Todo bajo control. Volveremos a recalcular la cola en segundo plano." : "Cambia el filtro para ver otras prioridades o espera a que se generen nuevas acciones."}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          {filtered.map((item) => (
            <ActionCard
              key={item.id}
              item={item}
              busy={busy === item.id}
              onPrimary={() => item.primaryAction && handleAction(item, item.primaryAction)}
              onSecondary={(a) => handleAction(item, a)}
            />
          ))}
        </div>
      )}

      {toast ? (
        <div style={{ marginTop: 12 }}>
          <span className={`bo-status ${toast.kind === "ok" ? "ok" : toast.kind === "warn" ? "warn" : "error"}`}>{toast.text}</span>
        </div>
      ) : null}

      {/* Drawers in-place — abren slide-over sin perder contexto. */}
      {checkInReservationId ? (
        <QuickCheckInDrawer
          reservationId={checkInReservationId}
          onClose={() => setCheckInReservationId(null)}
          onCompleted={({ elapsedSeconds }) => {
            setToast({ kind: "ok", text: `Check-in completado en ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}` });
            setTimeout(() => setToast(null), 5000);
            refresh();
          }}
        />
      ) : null}
      {checkOutReservationId ? (
        <QuickCheckOutDrawer
          reservationId={checkOutReservationId}
          onClose={() => setCheckOutReservationId(null)}
          onCompleted={({ elapsedSeconds }) => {
            setToast({ kind: "ok", text: `Check-out completado en ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}` });
            setTimeout(() => setToast(null), 5000);
            refresh();
          }}
        />
      ) : null}
    </article>
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
  const borderColor =
    tone === "danger" ? "var(--danger, #d23b3b)" :
    tone === "warning" ? "var(--warn, #d29b00)" :
    tone === "accent" ? "var(--accent, #6f3ad2)" :
    tone === "ok" ? "var(--ok, #1f8a4c)" :
    "var(--border, #e0e0e0)";

  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        borderLeftWidth: 4,
        borderRadius: 8,
        padding: 12,
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 140
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span className={`bo-status ${PRIORITY_TONE[item.priority] === "danger" ? "error" : PRIORITY_TONE[item.priority] === "warning" ? "warn" : "info"}`}>
          {PRIORITY_LABEL[item.priority]}
        </span>
        <span className="bo-chip">{KIND_LABEL[item.kind]}</span>
      </div>
      <div>
        <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 4 }}>{item.title}</div>
        <div className="bo-muted" style={{ fontSize: 13, lineHeight: 1.4 }}>{item.context}</div>
      </div>
      {item.recommendation ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--ink)",
            background: "var(--surface-elevated, rgba(0,0,0,0.03))",
            padding: "6px 8px",
            borderRadius: 6,
            borderLeft: `3px solid ${borderColor}`,
            lineHeight: 1.4
          }}
        >
          <strong style={{ marginRight: 4 }}>💡</strong>
          {item.recommendation}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, marginTop: "auto", flexWrap: "wrap" }}>
        {item.primaryAction ? (
          <button type="button" className="primary" disabled={busy} onClick={onPrimary}>
            {busy ? "…" : item.primaryAction.label}
          </button>
        ) : null}
        {item.secondaryActions?.map((a, idx) => (
          <button key={idx} type="button" className="ghost" disabled={busy} onClick={() => onSecondary(a)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
