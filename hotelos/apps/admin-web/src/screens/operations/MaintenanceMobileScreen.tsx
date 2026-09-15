// Maintenance Mobile Screen — vista táctil para el técnico de mantenimiento
// («Mis averías», /operaciones/mantenimiento/mis-averias; hosted inside
// MantenimientoTabs, standalone the page paints eyebrow + H1 itself).
//
// Directriz Anfitorio (Nov 2026):
//   "Mantenimiento mobile-first. Vista del técnico que carga tablet/móvil.
//    Averías, habitaciones bloqueadas, SLA, prioridad, fotos, estado."
//
// Cocoa 22 (ola 4 · lote 4-A, archetype «otro» on PlantillaBase): CocoaPage →
// priority filter chips (CocoaButton aria-pressed with counts) → one
// CocoaCard per work order in a CocoaKpiStrip auto-fit tier (min 320: three,
// two or one per row) with CocoaBadge states and two large CocoaButton
// actions (≥ 44 px tap targets on a coarse pointer) → the note goes through a
// CocoaDrawer (bottom sheet on phones; replaces the native prompt) →
// CocoaActionBar (mobileOnly) keeps «Actualizar» and the data age under the
// thumb. Data: GET /dashboards/maintenance-mobile (20 s poll); every write
// goes through apiRequest (JWT + session handling, audited as the technician).

import { useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { MAINT_INSTRUCTIONS } from "../../content/screen-instructions/maintenance";
import { useTabHost } from "../tabs/TabHost";
import { dateTime, number, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { ClockIcon, LockIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCard,
  CocoaDrawer,
  CocoaField,
  CocoaInput,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  type CocoaTone
} from "../../components/cocoa";

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

type Filter = Priority | "all";

const PRIORITY_TONE: Record<Priority, CocoaTone> = { urgent: "danger", high: "warning", normal: "info", low: "neutral" };
const PRIORITY_LABEL: Record<Priority, string> = { urgent: "Urgente", high: "Alta", normal: "Normal", low: "Baja" };

// Work-order status → Spanish label (the API sends the raw enum).
const STATUS_LABEL: Record<string, string> = {
  open: "Abierta",
  assigned: "Asignada",
  in_progress: "En curso",
  waiting_vendor: "Esperando proveedor",
  resolved: "Resuelta",
  closed: "Cerrada"
};

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todo" },
  { id: "urgent", label: "Urgente" },
  { id: "high", label: "Alta" },
  { id: "normal", label: "Normal" },
  { id: "low", label: "Baja" }
];

const EMPTY_SUMMARY: Data["summary"] = { urgent: 0, high: 0, normal: 0, low: 0, total: 0, blockedRooms: 0 };

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

/** Age of the work order as «35 min» / «2 h 05 min» / «3 h» (es-ES digits via lib/format). */
function fmtAge(minutes: number): string {
  if (minutes < 60) return `${number(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${number(h)} h ${number(m)} min` : `${number(h)} h`;
}

// Named style objects: colours and type come from the tokens (rule 6).
const cardStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", height: "100%" };
const roomNumberStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-title-1)",
  lineHeight: "var(--cocoa-lh-title-1)",
  fontWeight: "var(--cocoa-fw-bold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)",
  fontVariantNumeric: "tabular-nums"
};
const titleStyle: CSSProperties = { fontSize: "var(--cocoa-fs-headline)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], color: "var(--cocoa-label)" };
const captionStyle: CSSProperties = { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
const descriptionStyle: CSSProperties = { whiteSpace: "pre-line" };
// Two equal columns (not `repeat(2, 1fr)`: mobile.css stacks that pattern below 600 px and the pair must stay side by side).
const actionsStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--cocoa-space-2)", marginTop: "auto" };

function MaintenanceMobileSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton.Grid rows={[[4, 4, 4]]} height={260} />
    </div>
  );
}

export function MaintenanceMobileScreen() {
  const hosted = useTabHost() !== null;
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<Data>(
    `/dashboards/maintenance-mobile?propertyId=${propertyId}`,
    { pollIntervalMs: 20000 }
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<Item | null>(null);
  const [note, setNote] = useState("");

  const summary = data?.summary ?? EMPTY_SUMMARY;
  const items = toArray<Item>(data?.items);
  const filtered = filter === "all" ? items : items.filter((i) => i.priority === filter);
  const counts: Record<Filter, number> = { all: summary.total, urgent: summary.urgent, high: summary.high, normal: summary.normal, low: summary.low };
  const dataAt = data?.generatedAt ? time(data.generatedAt) : null;
  const refreshing = loading && items.length > 0;

  async function setStatus(item: Item, status: string) {
    setBusy(item.workOrderId);
    // Si status === resolved, usa el endpoint dedicado; si no, PATCH genérico.
    const result = status === "resolved"
      ? await mutate(`/work-orders/${item.workOrderId}/resolve`, "POST", { releaseRoom: item.blocksRoom })
      : await mutate(`/work-orders/${item.workOrderId}`, "PATCH", { status });
    setBusy(null);
    if (result.ok) {
      showToast(`Avería ${item.workOrderId.slice(-6)} → ${STATUS_LABEL[status] ?? status}`, { variant: "success" });
      refresh();
    } else {
      showToast(result.message || "No se pudo actualizar la avería", { variant: "error" });
    }
  }

  function openNote(item: Item) {
    setNote("");
    setNoteFor(item);
  }

  async function saveNote() {
    const item = noteFor;
    const text = note.trim();
    if (!item || !text) return;
    setBusy(item.workOrderId);
    // Guarda como descripción anexada (concat con la existente).
    const newDescription = item.description ? `${item.description}\n\n[${dateTime(new Date())}] ${text}` : text;
    const res = await mutate(`/work-orders/${item.workOrderId}`, "PATCH", { description: newDescription });
    setBusy(null);
    if (res.ok) {
      showToast("Nota guardada", { variant: "success" });
      setNoteFor(null);
      setNote("");
      refresh();
    } else {
      showToast(res.message || "No se pudo guardar la nota", { variant: "error" });
    }
  }

  const countLabel = plural(filtered.length, "avería", "averías");

  return (
    <CocoaPage
      eyebrow={`Mantenimiento · ${propertyName}`}
      title="Mis averías"
      subtitle={hosted ? undefined : "Averías del técnico: tómalas, resuélvelas y anota lo hecho desde el móvil."}
      actions={
        <>
          {summary.blockedRooms > 0 ? (
            <CocoaBadge tone="danger" variant="tinted" icon={<LockIcon size={12} aria-hidden="true" />}>
              {plural(summary.blockedRooms, "habitación bloqueada", "habitaciones bloqueadas")}
            </CocoaBadge>
          ) : null}
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={refreshing}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<MaintenanceMobileSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "maintenance-mobile-refresh", label: "Actualizar mis averías", run: refresh }]}
    >
      <CocoaScreenInstructionsCard
        title="Mis averías"
        description={MAINT_INSTRUCTIONS.whatIsThis}
        steps={[...MAINT_INSTRUCTIONS.howToUse]}
        tip={MAINT_INSTRUCTIONS.tips[0]}
        dismissible
        persistKey="maintenance"
      />

      <div className="cocoa-cluster" role="group" aria-label="Filtrar por prioridad">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <CocoaButton
              key={f.id}
              size="small"
              variant={active ? "tinted" : "bordered"}
              tone={active ? "accent" : "neutral"}
              aria-pressed={active}
              onClick={() => setFilter(f.id)}
            >
              {f.label} · {number(counts[f.id])}
            </CocoaButton>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <CocoaSection aria-label="Sin averías">
          <CocoaState
            kind="empty"
            title="Sin averías"
            message={filter === "all" ? "Todo en orden." : "No hay averías con esta prioridad."}
            illustration="success"
          />
        </CocoaSection>
      ) : (
        <CocoaKpiStrip min={320} aria-label="Averías">
          {filtered.map((item) => (
            <WorkOrderCard
              key={item.workOrderId}
              item={item}
              busy={busy === item.workOrderId}
              onTake={() => void setStatus(item, "in_progress")}
              onComplete={() => void setStatus(item, "resolved")}
              onNote={() => openNote(item)}
            />
          ))}
        </CocoaKpiStrip>
      )}

      <CocoaActionBar
        mobileOnly
        publishToastOffset
        aria-label="Acciones de mis averías"
        status={dataAt ? `${countLabel} · datos a ${dataAt}` : countLabel}
        primary={{ label: ACTIONS.refresh, onClick: refresh, loading: refreshing }}
      />

      <CocoaDrawer
        open={noteFor !== null}
        onClose={() => setNoteFor(null)}
        title="Añadir nota"
        subtitle={noteFor ? noteFor.title : undefined}
        side="right"
        size="sm"
        initialFocus={() => document.getElementById("maintenance-note")}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setNoteFor(null)}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton onClick={() => void saveNote()} loading={noteFor !== null && busy === noteFor.workOrderId} disabled={!note.trim()}>
              Guardar nota
            </CocoaButton>
          </>
        }
      >
        <CocoaField label="Nota" help="Se añade a la descripción de la avería con la fecha y la hora.">
          <CocoaInput id="maintenance-note" value={note} onChange={setNote} multiline rows={4} placeholder="Qué has visto o qué has hecho" />
        </CocoaField>
      </CocoaDrawer>
    </CocoaPage>
  );
}

function WorkOrderCard({ item, busy, onTake, onComplete, onNote }: { item: Item; busy: boolean; onTake: () => void; onComplete: () => void; onNote: () => void }) {
  const inProgress = item.status === "in_progress";

  return (
    <CocoaCard variant="bordered" style={cardStyle} role="group" aria-label={`Avería ${item.title}`}>
      <div className="cocoa-row" data-justify="between" data-align="start" data-wrap="nowrap">
        <div className="cocoa-row" data-gap="2" data-align="baseline">
          {item.roomNumber ? <strong style={roomNumberStyle}>{item.roomNumber}</strong> : null}
          {item.floor ? <span style={captionStyle}>Planta {item.floor}</span> : null}
        </div>
        <CocoaBadge tone={PRIORITY_TONE[item.priority]} variant="tinted">{PRIORITY_LABEL[item.priority]}</CocoaBadge>
      </div>

      <strong style={titleStyle}>{item.title}</strong>

      <div className="cocoa-cluster">
        <CocoaBadge tone="neutral" size="small">{STATUS_LABEL[item.status] ?? item.status}</CocoaBadge>
        <CocoaBadge tone="neutral" size="small" uppercase={false} icon={<ClockIcon size={12} aria-hidden="true" />}>
          {fmtAge(item.ageMinutes)}
        </CocoaBadge>
        {item.blocksRoom ? <CocoaBadge tone="danger" variant="tinted" size="small">Bloquea la habitación</CocoaBadge> : null}
        {item.dueOverdue ? <CocoaBadge tone="warning" variant="tinted" size="small">SLA vencido</CocoaBadge> : null}
        {item.mediaCount > 0 ? <CocoaBadge tone="neutral" size="small" uppercase={false}>{plural(item.mediaCount, "foto", "fotos")}</CocoaBadge> : null}
      </div>

      <div className="cocoa-stack" data-gap="1">
        <span style={secondaryStyle}>{item.reason}</span>
        {item.guestInHouse ? (
          <span>
            <strong>{item.guestInHouse}</strong> está en la habitación
          </span>
        ) : null}
        {item.description ? <span style={descriptionStyle}>{item.description}</span> : null}
        {item.assignedTo ? <span style={captionStyle}>Asignada a {item.assignedTo}</span> : null}
      </div>

      <div style={actionsStyle}>
        {inProgress ? (
          <CocoaButton size="large" loading={busy} onClick={onComplete}>
            Resuelta
          </CocoaButton>
        ) : (
          <CocoaButton size="large" loading={busy} onClick={onTake}>
            Tomar
          </CocoaButton>
        )}
        <CocoaButton size="large" variant="bordered" tone="neutral" disabled={busy} onClick={onNote}>
          Nota
        </CocoaButton>
      </div>
    </CocoaCard>
  );
}
