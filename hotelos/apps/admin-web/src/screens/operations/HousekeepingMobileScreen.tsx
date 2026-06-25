// Housekeeping Mobile Screen — vista táctil para personal de pisos.
//
// Directriz Anfitorio (Nov 2026):
//   "Housekeeping debe ser tiempo real, no módulo secundario. Anfitorio debe
//    eliminar WhatsApp, llamadas y Excel como herramientas de coordinación.
//    Mobile-first para operación."
//
// Diseño:
//   - Tap targets ≥ 44px (Apple HIG) — toda acción se ejecuta con un dedo.
//   - Una sola columna en móvil, dos en tablet. Sin scroll horizontal.
//   - Cards de habitación grandes con contraste alto y emojis para identificación rápida.
//   - 3 botones por card: ▶ Iniciar · ✓ Limpia · ✕ Reportar incidencia.
//   - Filtros por prioridad (chips grandes).
//   - Auto-refresh cada 20s para reflejar cambios de otros camareros / recepción.

import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { LoadingBlock, EmptyState, ErrorState } from "../../components/States";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { HK_INSTRUCTIONS } from "../../content/screen-instructions/housekeeping";

type Priority = "urgent" | "high" | "normal" | "low";

type HkRoom = {
  roomId: string;
  roomNumber: string;
  floor?: string;
  roomTypeName?: string;
  status: string;
  housekeepingStatus?: string;
  priority: Priority;
  reason: string;
  nextArrivalEta?: string;
  nextArrivalGuest?: string;
  isVipNext?: boolean;
  currentGuest?: string;
  specialRequest?: string;
  taskId?: string;
  taskStatus?: string;
  taskType?: string;
  assignedTo?: string;
  openIncidents: number;
  lastEventAt?: string;
  lastEventNote?: string;
};

type HkData = {
  generatedAt: string;
  summary: { urgent: number; high: number; normal: number; low: number; total: number };
  rooms: HkRoom[];
};

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const PRIORITY_STYLE: Record<Priority, { label: string; bg: string; ink: string; border: string }> = {
  urgent: { label: "URGENTE", bg: "#fee2e2", ink: "#991b1b", border: "#d23b3b" },
  high: { label: "ALTA", bg: "#fef3c7", ink: "#92400e", border: "#d29b00" },
  normal: { label: "NORMAL", bg: "#dbeafe", ink: "#1e40af", border: "#2663c4" },
  low: { label: "BAJA", bg: "#e5e7eb", ink: "#374151", border: "#6b7280" }
};

const HK_STATUS_LABEL: Record<string, string> = {
  clean: "Limpia",
  dirty: "Sucia",
  inspected: "Inspeccionada",
  stayover: "Stayover",
  in_progress: "En limpieza",
  ready: "Lista"
};

function HkChip({ status }: { status?: string }) {
  if (!status) return null;
  const label = HK_STATUS_LABEL[status.toLowerCase()] ?? status;
  return <span className="bo-chip">{label}</span>;
}

async function postAction(url: string, body?: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) return { ok: false, message: `${res.status} ${await res.text().catch(() => "")}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Error" };
  }
}

export function HousekeepingMobileScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<HkData>(
    `/dashboards/housekeeping-mobile?propertyId=${propertyId}`,
    { pollIntervalMs: 20000 }
  );
  const [filter, setFilter] = useState<Priority | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);

  const summary = data?.summary ?? { urgent: 0, high: 0, normal: 0, low: 0, total: 0 };
  const rooms = data?.rooms ?? [];
  const filtered = filter === "all" ? rooms : rooms.filter((r) => r.priority === filter);

  async function setHkStatus(room: HkRoom, status: string) {
    setBusy(room.roomId);
    setToast(null);
    const result = await postAction(`${API_BASE}/rooms/${room.roomId}/housekeeping-status`, { status });
    setBusy(null);
    setToast(
      result.ok
        ? { kind: "ok", text: `Hab. ${room.roomNumber} → ${HK_STATUS_LABEL[status] ?? status}` }
        : { kind: "warn", text: result.message || "Error" }
    );
    setTimeout(() => setToast(null), 3000);
    if (result.ok) {
      showToast(`Hab. ${room.roomNumber} → ${HK_STATUS_LABEL[status] ?? status}`, { variant: "success" });
      refresh();
    } else {
      showToast(result.message || "No se pudo actualizar el estado", { variant: "error" });
    }
  }

  async function reportIssue(room: HkRoom) {
    const description = window.prompt(`Hab. ${room.roomNumber} · Describe la incidencia (avería, falta amenity, etc.)`);
    if (!description?.trim()) return;
    setBusy(room.roomId);
    const result = await postAction(`${API_BASE}/work-orders`, {
      roomNumber: room.roomNumber,
      title: `Hab. ${room.roomNumber}: ${description.slice(0, 80)}`,
      description,
      priority: "normal",
      propertyId
    });
    setBusy(null);
    setToast(
      result.ok
        ? { kind: "ok", text: "Incidencia reportada a mantenimiento" }
        : { kind: "warn", text: result.message || "Error" }
    );
    setTimeout(() => setToast(null), 3000);
    if (result.ok) {
      showToast("Incidencia reportada a mantenimiento", { variant: "success" });
      refresh();
    } else {
      showToast(result.message || "No se pudo reportar la incidencia", { variant: "error" });
    }
  }

  return (
    <>
      {/* Page head sticky simplificado */}
      <div
        style={{
          position: "sticky",
          top: 0,
          background: "var(--surface)",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          zIndex: 10
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div>
            <div className="bo-page-eyebrow" style={{ fontSize: 11 }}>Housekeeping · {propertyName}</div>
            <h1 style={{ fontSize: 22, margin: "2px 0 0 0", color: "var(--ink)" }}>Mi turno</h1>
          </div>
          <button type="button" className="ghost" onClick={refresh} style={{ minHeight: 44, minWidth: 44, fontSize: 18 }} title="Actualizar">
            ↻
          </button>
        </div>
        {/* Big summary chips */}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <SummaryChip label="Todo" count={summary.total} active={filter === "all"} onClick={() => setFilter("all")} tone="info" />
          <SummaryChip label="Urgente" count={summary.urgent} active={filter === "urgent"} onClick={() => setFilter("urgent")} tone="danger" />
          <SummaryChip label="Alta" count={summary.high} active={filter === "high"} onClick={() => setFilter("high")} tone="warn" />
          <SummaryChip label="Normal" count={summary.normal} active={filter === "normal"} onClick={() => setFilter("normal")} tone="info" />
          <SummaryChip label="Baja" count={summary.low} active={filter === "low"} onClick={() => setFilter("low")} tone="muted" />
        </div>
      </div>

      <div style={{ padding: "0 16px 100px 16px" }}>
        <div style={{ marginTop: 12 }}>
          <CocoaScreenInstructionsCard
            title="Housekeeping"
            description={HK_INSTRUCTIONS.whatIsThis}
            steps={HK_INSTRUCTIONS.howToUse}
            tip={HK_INSTRUCTIONS.tips?.[0]}
            dismissible
            persistKey="housekeeping"
          />
        </div>
        {loading && rooms.length === 0 ? (
          <LoadingBlock label="Cargando habitaciones…" />
        ) : error ? (
          <ErrorState title="Algo no fue bien" message={error} onRetry={refresh} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Sin pendientes"
            message={filter === "all" ? "Todas las habitaciones están listas." : "No hay habitaciones en esta prioridad."}
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, marginTop: 12 }}>
            {filtered.map((room) => (
              <RoomCard
                key={room.roomId}
                room={room}
                busy={busy === room.roomId}
                onStart={() => setHkStatus(room, "in_progress")}
                onComplete={() => setHkStatus(room, "clean")}
                onInspect={() => setHkStatus(room, "inspected")}
                onReport={() => reportIssue(room)}
              />
            ))}
          </div>
        )}
      </div>

      {toast ? (
        <div style={{ position: "fixed", bottom: 20, left: 16, right: 16, zIndex: 70, display: "flex", justifyContent: "center" }}>
          <span
            className={`bo-status ${toast.kind === "ok" ? "ok" : toast.kind === "warn" ? "warn" : "error"}`}
            style={{ padding: "10px 16px", fontSize: 14, fontWeight: 500 }}
          >
            {toast.text}
          </span>
        </div>
      ) : null}
    </>
  );
}

function SummaryChip({
  label,
  count,
  active,
  onClick,
  tone
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone: "danger" | "warn" | "info" | "muted";
}) {
  const bg = active
    ? tone === "danger" ? "#d23b3b" : tone === "warn" ? "#d29b00" : tone === "info" ? "#2663c4" : "#6b7280"
    : "var(--surface-elevated, rgba(0,0,0,0.05))";
  const fg = active ? "white" : "var(--ink)";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "10px 14px",
        minHeight: 44,
        borderRadius: 22,
        border: `1px solid ${active ? bg : "var(--border)"}`,
        background: bg,
        color: fg,
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6
      }}
    >
      <span>{label}</span>
      <span
        style={{
          background: active ? "rgba(255,255,255,0.25)" : "var(--surface)",
          color: fg,
          borderRadius: 10,
          padding: "1px 8px",
          fontSize: 12
        }}
      >
        {count}
      </span>
    </button>
  );
}

function RoomCard({
  room,
  busy,
  onStart,
  onComplete,
  onInspect,
  onReport
}: {
  room: HkRoom;
  busy: boolean;
  onStart: () => void;
  onComplete: () => void;
  onInspect: () => void;
  onReport: () => void;
}) {
  const style = PRIORITY_STYLE[room.priority];
  const hk = (room.housekeepingStatus ?? "").toLowerCase();
  const isInProgress = hk === "in_progress" || room.taskStatus === "in_progress";
  const isClean = hk === "clean" || hk === "ready" || (!hk && room.status === "clean");
  const isInspected = hk === "inspected";

  return (
    <div
      style={{
        border: `2px solid ${style.border}`,
        borderRadius: 12,
        padding: 14,
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        gap: 8
      }}
    >
      {/* Header: number + priority + floor */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <strong style={{ fontSize: 28, color: "var(--ink)", lineHeight: 1 }}>{room.roomNumber}</strong>
          <span className="bo-muted" style={{ fontSize: 12 }}>Pl. {room.floor ?? "—"}</span>
        </div>
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 10,
            background: style.bg,
            color: style.ink,
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 0.5
          }}
        >
          {style.label}
        </span>
      </div>

      {/* Status + HK chip */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <HkChip status={room.housekeepingStatus} />
        {room.roomTypeName ? <span className="bo-chip">{room.roomTypeName}</span> : null}
        {room.openIncidents > 0 ? <span className="bo-status error">🛎 {room.openIncidents} incidencia(s)</span> : null}
        {isInProgress ? <span className="bo-status info">⏳ En limpieza</span> : null}
      </div>

      {/* Reason / context */}
      <div style={{ fontSize: 13, color: "var(--ink)" }}>
        <div style={{ fontWeight: 500, marginBottom: 2 }}>{room.reason}</div>
        {room.nextArrivalGuest ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11 }}>→</span>
            <span>{room.nextArrivalGuest}{room.isVipNext ? " ⭐" : ""}</span>
            {room.nextArrivalEta ? <span className="bo-muted" style={{ fontSize: 12 }}>· ETA {room.nextArrivalEta}</span> : null}
          </div>
        ) : null}
        {room.currentGuest ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11 }}>•</span>
            <span>{room.currentGuest}</span>
          </div>
        ) : null}
        {room.specialRequest ? (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              padding: "6px 8px",
              background: "var(--surface-elevated, rgba(0,0,0,0.04))",
              borderRadius: 6,
              borderLeft: `3px solid ${style.border}`
            }}
          >
            💬 {room.specialRequest}
          </div>
        ) : null}
        {room.lastEventNote ? (
          <div className="bo-muted" style={{ marginTop: 4, fontSize: 11 }}>
            Última nota: {room.lastEventNote}
          </div>
        ) : null}
      </div>

      {/* Big action buttons */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: "auto" }}>
        {!isInProgress && !isClean && !isInspected ? (
          <button type="button" className="primary" disabled={busy} onClick={onStart} style={{ minHeight: 48, fontSize: 14, fontWeight: 600 }}>
            ▶ Iniciar
          </button>
        ) : null}
        {(isInProgress || !isInspected) && !isInspected ? (
          <button
            type="button"
            className={isInProgress ? "primary" : "ghost"}
            disabled={busy}
            onClick={onComplete}
            style={{ minHeight: 48, fontSize: 14, fontWeight: 600 }}
          >
            ✓ Limpia
          </button>
        ) : null}
        {(isClean || isInProgress) && !isInspected ? (
          <button type="button" className="ghost" disabled={busy} onClick={onInspect} style={{ minHeight: 48, fontSize: 14, fontWeight: 600 }}>
            🔍 Inspeccionada
          </button>
        ) : null}
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={onReport}
          style={{ minHeight: 48, fontSize: 14, fontWeight: 600, gridColumn: isInspected ? "span 2" : undefined }}
        >
          ⚠ Reportar
        </button>
      </div>
    </div>
  );
}
