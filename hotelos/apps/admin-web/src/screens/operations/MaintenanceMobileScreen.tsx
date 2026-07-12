// Maintenance Mobile Screen — vista táctil para el técnico de mantenimiento.
//
// Directriz Anfitorio (Nov 2026):
//   "Mantenimiento mobile-first. Vista del técnico que carga tablet/móvil.
//    Averías, habitaciones bloqueadas, SLA, prioridad, fotos, estado."

import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { LoadingBlock } from "../../components/States";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { MAINT_INSTRUCTIONS } from "../../content/screen-instructions/maintenance";


type Priority = "urgent" | "high" | "normal" | "low";

type Item = {
  workOrderId: string;
  title: string;
  description?: string;
  priority: Priority;
  rawPriority: string;
  status: string;
  blocksRoom: boolean;
  roomId?: string;
  roomNumber?: string;
  floor?: string;
  guestInHouse?: string;
  ageMinutes: number;
  dueDate?: string;
  dueOverdue: boolean;
  assignedTo?: string;
  reason: string;
  mediaCount: number;
};

type Data = {
  generatedAt: string;
  summary: { urgent: number; high: number; normal: number; low: number; total: number; blockedRooms: number };
  items: Item[];
};

const PRIORITY_STYLE: Record<Priority, { label: string; bg: string; ink: string; border: string }> = {
  urgent: { label: "URGENTE", bg: "#fee2e2", ink: "#991b1b", border: "#d23b3b" },
  high: { label: "ALTA", bg: "#fef3c7", ink: "#92400e", border: "#d29b00" },
  normal: { label: "NORMAL", bg: "#dbeafe", ink: "#1e40af", border: "#2663c4" },
  low: { label: "BAJA", bg: "#e5e7eb", ink: "#374151", border: "#6b7280" }
};

// Auditoría 2026-07: antes `fetch` crudo sin Authorization → 401 en producción.
// Ahora todas las mutaciones van por apiRequest (JWT + manejo de sesión).
async function mutate(path: string, method: "POST" | "PATCH", body?: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    await apiRequest(path, { method, body });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Error" };
  }
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m > 0 ? ` ${m}min` : ""}`;
}

export function MaintenanceMobileScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<Data>(
    `/dashboards/maintenance-mobile?propertyId=${propertyId}`,
    { pollIntervalMs: 20000 }
  );
  const [filter, setFilter] = useState<Priority | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);

  const summary = data?.summary ?? { urgent: 0, high: 0, normal: 0, low: 0, total: 0, blockedRooms: 0 };
  const items = data?.items ?? [];
  const filtered = filter === "all" ? items : items.filter((i) => i.priority === filter);

  async function setStatus(item: Item, status: string) {
    setBusy(item.workOrderId);
    setToast(null);
    // Si status === resolved, usa el endpoint dedicado; si no, PATCH genérico.
    const result = status === "resolved"
      ? await mutate(`/work-orders/${item.workOrderId}/resolve`, "POST", { releaseRoom: item.blocksRoom })
      : await mutate(`/work-orders/${item.workOrderId}`, "PATCH", { status });
    setBusy(null);
    setToast(
      result.ok
        ? { kind: "ok", text: `Avería ${item.workOrderId.slice(-6)} → ${status}` }
        : { kind: "warn", text: result.message || "Error" }
    );
    setTimeout(() => setToast(null), 3000);
    if (result.ok) {
      showToast(`Avería ${item.workOrderId.slice(-6)} → ${status}`, { variant: "success" });
      refresh();
    } else {
      showToast(result.message || "No se pudo actualizar la avería", { variant: "error" });
    }
  }

  async function addNote(item: Item) {
    const note = window.prompt("Añadir nota a la avería");
    if (!note?.trim()) return;
    setBusy(item.workOrderId);
    // Guarda como descripción anexada (concat con la existente).
    const newDescription = item.description ? `${item.description}\n\n[${new Date().toLocaleString("es-ES")}] ${note}` : note;
    const res = await mutate(`/work-orders/${item.workOrderId}`, "PATCH", { description: newDescription });
    setBusy(null);
    const ok = res.ok;
    setToast({ kind: ok ? "ok" : "warn", text: ok ? "Nota guardada" : "Error guardando nota" });
    setTimeout(() => setToast(null), 3000);
    if (ok) {
      showToast("Nota guardada", { variant: "success" });
      refresh();
    } else {
      showToast("No se pudo guardar la nota", { variant: "error" });
    }
  }

  return (
    <>
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
            <div className="bo-page-eyebrow" style={{ fontSize: 11 }}>Mantenimiento · {propertyName}</div>
            <h1 style={{ fontSize: 22, margin: "2px 0 0 0", color: "var(--ink)" }}>Mis averías</h1>
          </div>
          <button type="button" className="ghost" onClick={refresh} style={{ minHeight: 44, minWidth: 44, fontSize: 18 }} title="Actualizar">
            ↻
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <Chip label="Todo" count={summary.total} active={filter === "all"} onClick={() => setFilter("all")} tone="info" />
          <Chip label="Urgente" count={summary.urgent} active={filter === "urgent"} onClick={() => setFilter("urgent")} tone="danger" />
          <Chip label="Alta" count={summary.high} active={filter === "high"} onClick={() => setFilter("high")} tone="warn" />
          <Chip label="Normal" count={summary.normal} active={filter === "normal"} onClick={() => setFilter("normal")} tone="info" />
          <Chip label="Baja" count={summary.low} active={filter === "low"} onClick={() => setFilter("low")} tone="muted" />
          {summary.blockedRooms > 0 ? (
            <div style={{ marginLeft: "auto", padding: "10px 14px", borderRadius: 22, border: "1px solid #d23b3b", background: "#fee2e2", color: "#991b1b", fontSize: 13, fontWeight: 600 }}>
              🚫 {summary.blockedRooms} hab. bloqueadas
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ padding: "0 16px 100px 16px" }}>
        <div style={{ marginTop: 12 }}>
          <CocoaScreenInstructionsCard
            title="Mis averías"
            description={MAINT_INSTRUCTIONS.whatIsThis}
            steps={[...MAINT_INSTRUCTIONS.howToUse]}
            tip={MAINT_INSTRUCTIONS.tips[0]}
            dismissible
            persistKey="maintenance"
          />
        </div>
        {loading && items.length === 0 ? (
          <LoadingBlock />
        ) : error ? (
          <p className="bo-status error" style={{ margin: 16 }}>{error}</p>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 48 }}>
            <div style={{ fontSize: 56, marginBottom: 8 }}>🛠️</div>
            <h3 style={{ margin: 0 }}>Sin averías</h3>
            <p className="bo-muted" style={{ margin: "4px 0 0 0" }}>Todo en orden.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, marginTop: 12 }}>
            {filtered.map((item) => (
              <Card
                key={item.workOrderId}
                item={item}
                busy={busy === item.workOrderId}
                onTake={() => setStatus(item, "in_progress")}
                onComplete={() => setStatus(item, "resolved")}
                onNote={() => addNote(item)}
              />
            ))}
          </div>
        )}
      </div>

      {toast ? (
        <div style={{ position: "fixed", bottom: 20, left: 16, right: 16, zIndex: 70, display: "flex", justifyContent: "center" }}>
          <span className={`bo-status ${toast.kind === "ok" ? "ok" : toast.kind === "warn" ? "warn" : "error"}`}>{toast.text}</span>
        </div>
      ) : null}
    </>
  );
}

function Chip({ label, count, active, onClick, tone }: { label: string; count: number; active: boolean; onClick: () => void; tone: "danger" | "warn" | "info" | "muted" }) {
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
      <span style={{ background: active ? "rgba(255,255,255,0.25)" : "var(--surface)", color: fg, borderRadius: 10, padding: "1px 8px", fontSize: 12 }}>{count}</span>
    </button>
  );
}

function Card({ item, busy, onTake, onComplete, onNote }: { item: Item; busy: boolean; onTake: () => void; onComplete: () => void; onNote: () => void }) {
  const style = PRIORITY_STYLE[item.priority];
  const isInProgress = item.status === "in_progress";

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          {item.roomNumber ? <strong style={{ fontSize: 22, color: "var(--ink)", lineHeight: 1 }}>{item.roomNumber}</strong> : null}
          {item.floor ? <span className="bo-muted" style={{ fontSize: 12 }}>Pl. {item.floor}</span> : null}
        </div>
        <span style={{ padding: "4px 10px", borderRadius: 10, background: style.bg, color: style.ink, fontWeight: 700, fontSize: 11, letterSpacing: 0.5 }}>{style.label}</span>
      </div>

      <strong style={{ fontSize: 15, color: "var(--ink)" }}>{item.title}</strong>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="bo-chip">{item.status}</span>
        <span className="bo-chip">⏱ {fmtAge(item.ageMinutes)}</span>
        {item.blocksRoom ? <span className="bo-status error">🚫 bloquea hab.</span> : null}
        {item.dueOverdue ? <span className="bo-status warn">⏰ SLA vencido</span> : null}
        {item.mediaCount > 0 ? <span className="bo-chip">📷 {item.mediaCount}</span> : null}
      </div>

      <div style={{ fontSize: 13, color: "var(--ink)" }}>
        <div style={{ fontStyle: "italic", color: "var(--muted, #888)" }}>{item.reason}</div>
        {item.guestInHouse ? <div style={{ marginTop: 4 }}>👤 <strong>{item.guestInHouse}</strong> está en la habitación</div> : null}
        {item.description ? <div style={{ marginTop: 4 }}>{item.description}</div> : null}
        {item.assignedTo ? <div className="bo-muted" style={{ marginTop: 4, fontSize: 11 }}>Asignado: {item.assignedTo}</div> : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: "auto" }}>
        {!isInProgress ? (
          <button type="button" className="primary" disabled={busy} onClick={onTake} style={{ minHeight: 48, fontSize: 14, fontWeight: 600 }}>
            ▶ Tomar
          </button>
        ) : null}
        {isInProgress ? (
          <button type="button" className="primary" disabled={busy} onClick={onComplete} style={{ minHeight: 48, fontSize: 14, fontWeight: 600 }}>
            ✓ Resuelta
          </button>
        ) : null}
        <button type="button" className="ghost" disabled={busy} onClick={onNote} style={{ minHeight: 48, fontSize: 14, fontWeight: 600 }}>
          📝 Nota
        </button>
      </div>
    </div>
  );
}
