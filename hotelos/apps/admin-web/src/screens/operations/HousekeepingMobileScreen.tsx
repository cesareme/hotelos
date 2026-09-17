// Housekeeping Mobile Screen — vista táctil para personal de pisos («Mi
// turno», /operaciones/pisos/mi-turno; hosted inside PisosTabs, standalone the
// page paints eyebrow + H1 itself).
//
// Directriz ehotelOS (Nov 2026):
//   "Housekeeping debe ser tiempo real, no módulo secundario. ehotelOS debe
//    eliminar WhatsApp, llamadas y Excel como herramientas de coordinación.
//    Mobile-first para operación."
//
// Cocoa 22 (ola 4 · lote 4-A, archetype «otro» on PlantillaBase):
//   - CocoaPage → priority filter chips (CocoaButton aria-pressed with
//     counts) → one CocoaCard per room in a CocoaKpiStrip auto-fit tier
//     (min 320: three, two or one per row; never a horizontal scroll).
//   - Room cards with the number in title-1, CocoaBadge states (no emoji,
//     §6) and up to four large CocoaButton actions: Iniciar · Limpia ·
//     Inspeccionada · Reportar (≥ 44 px tap targets on a coarse pointer).
//   - Reporting an incident opens a CocoaDrawer (bottom sheet on phones;
//     replaces the native prompt) that POSTs the same work order as before.
//   - CocoaActionBar (mobileOnly) keeps «Actualizar» and the data age under
//     the thumb; auto-refresh every 20 s reflects other housekeepers.

import { useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { HK_INSTRUCTIONS } from "../../content/screen-instructions/housekeeping";
import { useTabHost } from "../tabs/TabHost";
import { number, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { ChatBubbleIcon, StarIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
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

type Filter = Priority | "all";

const PRIORITY_TONE: Record<Priority, CocoaTone> = { urgent: "danger", high: "warning", normal: "info", low: "neutral" };
const PRIORITY_LABEL: Record<Priority, string> = { urgent: "Urgente", high: "Alta", normal: "Normal", low: "Baja" };

const HK_STATUS_LABEL: Record<string, string> = {
  clean: "Limpia",
  dirty: "Sucia",
  inspected: "Inspeccionada",
  stayover: "Stayover",
  in_progress: "En limpieza",
  ready: "Lista"
};

const HK_STATUS_TONE: Record<string, CocoaTone> = {
  clean: "success",
  dirty: "warning",
  inspected: "success",
  stayover: "info",
  in_progress: "info",
  ready: "success"
};

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todo" },
  { id: "urgent", label: "Urgente" },
  { id: "high", label: "Alta" },
  { id: "normal", label: "Normal" },
  { id: "low", label: "Baja" }
];

const EMPTY_SUMMARY: HkData["summary"] = { urgent: 0, high: 0, normal: 0, low: 0, total: 0 };

// Writes go through apiRequest so they carry the session JWT and are audited
// as the logged-in housekeeper (Tanda 3 · CF-05). ApiError.message is the
// Spanish message from the API error envelope.
async function postAction(path: string, body?: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    await apiRequest<unknown>(path, { method: "POST", body });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Error" };
  }
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
const reasonStyle: CSSProperties = { fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"], color: "var(--cocoa-label)" };
const captionStyle: CSSProperties = { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
// Two equal columns (not `repeat(2, 1fr)`: mobile.css stacks that pattern below 600 px and the pairs must stay side by side).
const actionsStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--cocoa-space-2)", marginTop: "auto" };
const fullRowStyle: CSSProperties = { gridColumn: "1 / -1" };

function HousekeepingMobileSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton.Grid rows={[[4, 4, 4]]} height={260} />
    </div>
  );
}

export function HousekeepingMobileScreen() {
  const hosted = useTabHost() !== null;
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<HkData>(
    `/dashboards/housekeeping-mobile?propertyId=${propertyId}`,
    { pollIntervalMs: 20000 }
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [reportFor, setReportFor] = useState<HkRoom | null>(null);
  const [report, setReport] = useState("");

  const summary = data?.summary ?? EMPTY_SUMMARY;
  const rooms = toArray<HkRoom>(data?.rooms);
  const filtered = filter === "all" ? rooms : rooms.filter((r) => r.priority === filter);
  const counts: Record<Filter, number> = { all: summary.total, urgent: summary.urgent, high: summary.high, normal: summary.normal, low: summary.low };
  const dataAt = data?.generatedAt ? time(data.generatedAt) : null;
  const refreshing = loading && rooms.length > 0;

  async function setHkStatus(room: HkRoom, status: string) {
    setBusy(room.roomId);
    const result = await postAction(`/rooms/${encodeURIComponent(room.roomId)}/housekeeping-status`, { status });
    setBusy(null);
    if (result.ok) {
      showToast(`Hab. ${room.roomNumber} → ${HK_STATUS_LABEL[status] ?? status}`, { variant: "success" });
      refresh();
    } else {
      showToast(result.message || "No se pudo actualizar el estado", { variant: "error" });
    }
  }

  function openReport(room: HkRoom) {
    setReport("");
    setReportFor(room);
  }

  async function sendReport() {
    const room = reportFor;
    const description = report.trim();
    if (!room || !description) return;
    setBusy(room.roomId);
    const result = await postAction("/work-orders", {
      roomNumber: room.roomNumber,
      title: `Hab. ${room.roomNumber}: ${description.slice(0, 80)}`,
      description,
      priority: "normal",
      propertyId
    });
    setBusy(null);
    if (result.ok) {
      showToast("Incidencia reportada a mantenimiento", { variant: "success" });
      setReportFor(null);
      setReport("");
      refresh();
    } else {
      showToast(result.message || "No se pudo reportar la incidencia", { variant: "error" });
    }
  }

  const countLabel = plural(filtered.length, "habitación", "habitaciones");

  return (
    <CocoaPage
      eyebrow={`Pisos · ${propertyName}`}
      title="Mi turno"
      subtitle={hosted ? undefined : "Habitaciones del turno por prioridad: inicia, marca limpia, inspecciona y reporta incidencias."}
      actions={
        <>
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={refreshing}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<HousekeepingMobileSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "housekeeping-mobile-refresh", label: "Actualizar mi turno", run: refresh }]}
    >
      <CocoaScreenInstructionsCard
        title="Housekeeping"
        description={HK_INSTRUCTIONS.whatIsThis}
        steps={HK_INSTRUCTIONS.howToUse}
        tip={HK_INSTRUCTIONS.tips?.[0]}
        dismissible
        persistKey="housekeeping"
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
        <CocoaSection aria-label="Sin pendientes">
          <CocoaState
            kind="empty"
            title="Sin pendientes"
            message={filter === "all" ? "Todas las habitaciones están listas." : "No hay habitaciones en esta prioridad."}
            illustration="success"
          />
        </CocoaSection>
      ) : (
        <CocoaKpiStrip min={320} aria-label="Habitaciones del turno">
          {filtered.map((room) => (
            <RoomCard
              key={room.roomId}
              room={room}
              busy={busy === room.roomId}
              onStart={() => void setHkStatus(room, "in_progress")}
              onComplete={() => void setHkStatus(room, "clean")}
              onInspect={() => void setHkStatus(room, "inspected")}
              onReport={() => openReport(room)}
            />
          ))}
        </CocoaKpiStrip>
      )}

      <CocoaActionBar
        mobileOnly
        publishToastOffset
        aria-label="Acciones de mi turno"
        status={dataAt ? `${countLabel} · datos a ${dataAt}` : countLabel}
        primary={{ label: ACTIONS.refresh, onClick: refresh, loading: refreshing }}
      />

      <CocoaDrawer
        open={reportFor !== null}
        onClose={() => setReportFor(null)}
        title="Reportar incidencia"
        subtitle={reportFor ? `Habitación ${reportFor.roomNumber}` : undefined}
        side="right"
        size="sm"
        initialFocus={() => document.getElementById("housekeeping-report")}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setReportFor(null)}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton onClick={() => void sendReport()} loading={reportFor !== null && busy === reportFor.roomId} disabled={!report.trim()}>
              Enviar a mantenimiento
            </CocoaButton>
          </>
        }
      >
        <CocoaField label="Incidencia" help="Avería, falta de amenities, desperfectos… Se crea una orden de trabajo para mantenimiento.">
          <CocoaInput id="housekeeping-report" value={report} onChange={setReport} multiline rows={4} placeholder="Describe la incidencia" />
        </CocoaField>
      </CocoaDrawer>
    </CocoaPage>
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
  const hk = (room.housekeepingStatus ?? "").toLowerCase();
  const isInProgress = hk === "in_progress" || room.taskStatus === "in_progress";
  const isClean = hk === "clean" || hk === "ready" || (!hk && room.status === "clean");
  const isInspected = hk === "inspected";
  const hkLabel = hk ? (HK_STATUS_LABEL[hk] ?? room.housekeepingStatus) : null;

  return (
    <CocoaCard variant="bordered" style={cardStyle} role="group" aria-label={`Habitación ${room.roomNumber}`}>
      <div className="cocoa-row" data-justify="between" data-align="start" data-wrap="nowrap">
        <div className="cocoa-row" data-gap="2" data-align="baseline">
          <strong style={roomNumberStyle}>{room.roomNumber}</strong>
          <span style={captionStyle}>Planta {room.floor ?? "—"}</span>
        </div>
        <CocoaBadge tone={PRIORITY_TONE[room.priority]} variant="tinted">{PRIORITY_LABEL[room.priority]}</CocoaBadge>
      </div>

      <div className="cocoa-cluster">
        {hkLabel ? <CocoaBadge tone={HK_STATUS_TONE[hk] ?? "neutral"} size="small">{hkLabel}</CocoaBadge> : null}
        {room.roomTypeName ? <CocoaBadge tone="neutral" size="small" uppercase={false}>{room.roomTypeName}</CocoaBadge> : null}
        {room.openIncidents > 0 ? (
          <CocoaBadge tone="danger" variant="tinted" size="small" uppercase={false}>
            {plural(room.openIncidents, "incidencia", "incidencias")}
          </CocoaBadge>
        ) : null}
        {isInProgress && hk !== "in_progress" ? <CocoaBadge tone="info" size="small">En limpieza</CocoaBadge> : null}
      </div>

      <div className="cocoa-stack" data-gap="1">
        <span style={reasonStyle}>{room.reason}</span>
        {room.nextArrivalGuest ? (
          <span className="cocoa-row" data-gap="2">
            <span>Llega {room.nextArrivalGuest}</span>
            {room.isVipNext ? (
              <CocoaBadge tone="accent" size="small" icon={<StarIcon size={10} />}>
                VIP
              </CocoaBadge>
            ) : null}
            {room.nextArrivalEta ? <span style={captionStyle}>· ETA {room.nextArrivalEta}</span> : null}
          </span>
        ) : null}
        {room.currentGuest ? <span>Alojado: {room.currentGuest}</span> : null}
        {room.specialRequest ? (
          <CocoaCallout tone="info" icon={<ChatBubbleIcon size={14} />}>
            {room.specialRequest}
          </CocoaCallout>
        ) : null}
        {room.lastEventNote ? <span style={captionStyle}>Última nota: {room.lastEventNote}</span> : null}
      </div>

      <div style={actionsStyle}>
        {!isInProgress && !isClean && !isInspected ? (
          <CocoaButton size="large" loading={busy} onClick={onStart}>
            Iniciar
          </CocoaButton>
        ) : null}
        {!isInspected ? (
          <CocoaButton size="large" variant={isInProgress ? "filled" : "bordered"} tone={isInProgress ? "accent" : "neutral"} loading={busy} onClick={onComplete}>
            Limpia
          </CocoaButton>
        ) : null}
        {(isClean || isInProgress) && !isInspected ? (
          <CocoaButton size="large" variant="bordered" tone="neutral" loading={busy} onClick={onInspect}>
            Inspeccionada
          </CocoaButton>
        ) : null}
        <CocoaButton size="large" variant="bordered" tone="neutral" disabled={busy} onClick={onReport} style={isInspected ? fullRowStyle : undefined}>
          Reportar
        </CocoaButton>
      </div>
    </CocoaCard>
  );
}
