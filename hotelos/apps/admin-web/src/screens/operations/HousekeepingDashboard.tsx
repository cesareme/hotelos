// Housekeeping Dashboard — «Tablero de pisos» (/operaciones/pisos; base tab of
// PisosTabs, standalone the page paints eyebrow + H1).
//
// Cocoa 22 (ola 4 · lote 4-A, archetype «dashboard»): CocoaPage → CocoaKpiStrip
// (sucias · limpias · inspeccionadas · fuera de servicio · tareas abiertas) →
// filter chips (CocoaButton aria-pressed with counts) → one CocoaCard per
// room in a CocoaKpiStrip auto-fit tier (min 240): number in title-1,
// CocoaBadge states (housekeeping, maintenance, sellable — what the legacy
// hover card revealed, now always visible and reachable on touch), open tasks
// as a section list with «Empezar» / «Completar», and the actions «Marcar
// limpia» / «Inspeccionar» / «Nueva tarea». Creating a task opens a
// CocoaDrawer (type + priority). Results and errors go to the toast; same API
// calls as before (services/housekeepingApi, 30 s poll).

import { useMemo, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import {
  createHousekeepingTask,
  markRoomClean,
  markRoomInspected,
  updateHousekeepingTask,
  type HkBoardItem,
  type HkPriority,
  type HkTaskType
} from "../../services/housekeepingApi";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { useTabHost } from "../tabs/TabHost";
import { number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCard,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  type CocoaSelectOption,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const HK_STATUS_LABEL: Record<string, string> = {
  dirty: "Sucia",
  clean: "Limpia",
  inspected: "Inspeccionada",
  occupied: "Ocupada",
  out_of_order: "Fuera de servicio",
  out_of_service: "Fuera de servicio"
};
const HK_STATUS_TONE: Record<string, CocoaTone> = {
  dirty: "warning",
  clean: "success",
  inspected: "success",
  occupied: "info",
  out_of_order: "danger",
  out_of_service: "danger"
};

const TASK_TYPE_LABEL: Record<string, string> = {
  departure_clean: "Salida (limpieza)",
  stayover: "Cliente alojado",
  inspection: "Inspección",
  deep_clean: "Limpieza a fondo"
};
const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "pendiente",
  assigned: "asignada",
  in_progress: "en curso",
  done: "hecha",
  rejected: "rechazada"
};
const PRIORITY_LABEL: Record<string, string> = { low: "baja", normal: "normal", high: "alta" };
const PRIORITY_TONE: Record<string, CocoaTone> = { low: "info", normal: "success", high: "warning" };

const TASK_TYPES: HkTaskType[] = ["departure_clean", "stayover", "inspection", "deep_clean"];
const TASK_TYPE_OPTIONS: CocoaSelectOption[] = TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABEL[t] }));
const PRIORITY_OPTIONS: CocoaSelectOption[] = [
  { value: "low", label: "Baja" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "Alta" }
];

// Tanda L5 (estado unificado): la limpieza es `housekeepingStatus` (siempre
// presente, dirty | clean | inspected) en cualquier ocupación; la ocupación y el
// fuera de servicio se leen de `status`.
function hkStatusOf(item: HkBoardItem): string {
  return item.room.housekeepingStatus;
}

function isOccupied(item: HkBoardItem): boolean {
  return item.room.status === "occupied";
}

function isOutOfService(item: HkBoardItem): boolean {
  return item.room.status === "out_of_order" || item.room.status === "out_of_service";
}

const FILTERS: { id: string; label: string; match: (i: HkBoardItem) => boolean }[] = [
  { id: "all", label: "Todas", match: () => true },
  { id: "dirty", label: "Sucias", match: (i) => hkStatusOf(i) === "dirty" },
  { id: "clean", label: "Limpias", match: (i) => hkStatusOf(i) === "clean" },
  { id: "inspected", label: "Inspeccionadas", match: (i) => hkStatusOf(i) === "inspected" },
  { id: "occupied", label: "Ocupadas", match: (i) => isOccupied(i) },
  { id: "ooo", label: "Fuera de servicio", match: (i) => isOutOfService(i) },
  { id: "tasks", label: "Con tareas", match: (i) => i.tasks.length > 0 }
];

// Named style objects (rule 6): colours and type from the tokens.
const roomCardStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", height: "100%" };
const roomNumberStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-title-2)",
  lineHeight: "var(--cocoa-lh-title-2)",
  fontWeight: "var(--cocoa-fw-bold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)",
  fontVariantNumeric: "tabular-nums"
};
const captionStyle: CSSProperties = { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const taskLabelStyle: CSSProperties = { minWidth: 0 };
const roomActionsStyle: CSSProperties = { marginTop: "auto" };

function HousekeepingSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} min={200} />
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton.Grid rows={[[3, 3, 3, 3], [3, 3, 3, 3]]} height={180} />
    </div>
  );
}

export function HousekeepingDashboard() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<HkBoardItem[]>(
    `/properties/${PROPERTY_ID}/housekeeping/board`,
    { pollIntervalMs: 30000 }
  );
  const board = useMemo(() => toArray<HkBoardItem>(data), [data]);

  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [formRoom, setFormRoom] = useState<string | null>(null);
  const [formType, setFormType] = useState<HkTaskType>("departure_clean");
  const [formPriority, setFormPriority] = useState<HkPriority>("normal");
  const formItem = useMemo(() => board.find((i) => i.room.id === formRoom) ?? null, [board, formRoom]);

  const kpis = useMemo(() => {
    const k = { dirty: 0, clean: 0, inspected: 0, occupied: 0, ooo: 0, tasks: 0 };
    for (const item of board) {
      // Limpieza por hk en todas las ocupaciones; ocupadas y fuera de servicio por status.
      const s = hkStatusOf(item);
      if (s === "dirty") k.dirty += 1;
      else if (s === "clean") k.clean += 1;
      else if (s === "inspected") k.inspected += 1;
      if (isOccupied(item)) k.occupied += 1;
      else if (isOutOfService(item)) k.ooo += 1;
      k.tasks += item.tasks.length;
    }
    return k;
  }, [board]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    return board.filter(f.match).sort((a, b) => a.room.number.localeCompare(b.room.number, "es", { numeric: true }));
  }, [board, filter]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      showToast(ok, { variant: "success" });
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "No se pudo completar la acción.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function openTaskForm(roomId: string) {
    setFormType("departure_clean");
    setFormPriority("normal");
    setFormRoom(roomId);
  }

  function closeTaskForm() {
    setFormRoom(null);
  }

  function submitTask() {
    const roomId = formRoom;
    if (!roomId) return;
    void run(async () => {
      await createHousekeepingTask({ roomId, taskType: formType, priority: formPriority });
      setFormRoom(null);
    }, "Tarea creada.");
  }

  return (
    <CocoaPage
      eyebrow="Operaciones · Pisos"
      title="Tablero de pisos"
      subtitle={hosted ? undefined : "Estado de cada habitación en vivo. Marca limpiezas, inspecciona y crea tareas para el equipo."}
      actions={
        <>
          {busy ? <CocoaBadge tone="info">{STATUS_LABELS.saving}</CocoaBadge> : null}
          {error && board.length > 0 ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={loading && board.length > 0}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && board.length === 0 ? "loading" : error && board.length === 0 ? "error" : "ready"}
      skeleton={<HousekeepingSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "housekeeping-refresh", label: "Actualizar el tablero de pisos", run: refresh }]}
    >
      <CocoaKpiStrip min={200} stagger aria-label="Habitaciones por estado">
        <CocoaKpi label="Sucias" value={number(kpis.dirty)} polarity="negative-good" status={kpis.dirty > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Limpias" value={number(kpis.clean)} polarity="positive-good" status="ok" />
        <CocoaKpi label="Inspeccionadas" value={number(kpis.inspected)} unit="vendibles" polarity="positive-good" status="ok" />
        <CocoaKpi label="Fuera de servicio" value={number(kpis.ooo)} polarity="negative-good" status={kpis.ooo > 0 ? "critical" : "ok"} />
        <CocoaKpi label="Tareas abiertas" value={number(kpis.tasks)} polarity="negative-good" status={kpis.tasks > 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>

      <div className="cocoa-cluster" role="group" aria-label="Filtrar habitaciones">
        {FILTERS.map((f) => {
          const count = f.id === "all" ? board.length : board.filter(f.match).length;
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
              {f.label} · {number(count)}
            </CocoaButton>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <CocoaSection aria-label="Sin habitaciones">
          <CocoaState kind="empty" title="Sin habitaciones" message="No hay habitaciones que coincidan con este filtro." illustration="search" />
        </CocoaSection>
      ) : (
        <CocoaKpiStrip min={240} aria-label="Habitaciones">
          {visible.map((item) => {
            const s = hkStatusOf(item);
            const isClean = s === "clean";
            const isInspected = s === "inspected";
            const maint = item.room.maintenanceStatus ?? "ok";
            return (
              <CocoaCard key={item.room.id} variant="bordered" style={roomCardStyle} role="group" aria-label={`Habitación ${item.room.number}`}>
                <div className="cocoa-row" data-justify="between" data-align="start" data-wrap="nowrap">
                  <div className="cocoa-row" data-gap="2" data-align="baseline">
                    <strong style={roomNumberStyle}>{item.room.number}</strong>
                    {item.room.floor ? <span style={captionStyle}>planta {item.room.floor}</span> : null}
                  </div>
                  <span className="cocoa-cluster">
                    <CocoaBadge tone={HK_STATUS_TONE[s] ?? "info"}>{HK_STATUS_LABEL[s] ?? s}</CocoaBadge>
                    {isOccupied(item) || isOutOfService(item) ? (
                      <CocoaBadge tone={HK_STATUS_TONE[item.room.status] ?? "info"} variant="tinted">{HK_STATUS_LABEL[item.room.status] ?? item.room.status}</CocoaBadge>
                    ) : null}
                  </span>
                </div>

                {maint !== "ok" || !item.room.sellable ? (
                  <div className="cocoa-cluster">
                    {maint !== "ok" ? (
                      <CocoaBadge tone="warning" size="small" uppercase={false}>
                        Mantenimiento: {maint}
                      </CocoaBadge>
                    ) : null}
                    {!item.room.sellable ? (
                      <CocoaBadge tone="danger" variant="tinted" size="small">
                        No vendible
                      </CocoaBadge>
                    ) : null}
                  </div>
                ) : null}

                {item.tasks.length > 0 ? (
                  <ul className="c22-section__list" aria-label={`Tareas de la habitación ${item.room.number}`}>
                    {item.tasks.map((t) => {
                      const next = t.status === "in_progress" ? { status: "done", label: ACTIONS.complete } : { status: "in_progress", label: "Empezar" };
                      return (
                        <li key={t.id}>
                          <span className="cocoa-row" data-gap="1" style={taskLabelStyle}>
                            <span>{TASK_TYPE_LABEL[t.taskType] ?? t.taskType}</span>
                            <CocoaBadge tone={PRIORITY_TONE[t.priority] ?? "info"} variant="dot" size="small">
                              {PRIORITY_LABEL[t.priority] ?? t.priority}
                            </CocoaBadge>
                            <span style={captionStyle}>{TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                          </span>
                          {t.status !== "done" ? (
                            <CocoaButton
                              variant="bordered"
                              tone="neutral"
                              size="small"
                              disabled={busy}
                              onClick={() => void run(() => updateHousekeepingTask(t.id, { status: next.status }), `Tarea ${next.label.toLowerCase()}.`)}
                            >
                              {next.label}
                            </CocoaButton>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <CocoaState kind="empty" inline title="Sin tareas abiertas." />
                )}

                <div className="cocoa-cluster" style={roomActionsStyle}>
                  {!isClean && !isInspected ? (
                    <CocoaButton size="small" disabled={busy} onClick={() => void run(() => markRoomClean(item.room.id), `Habitación ${item.room.number} marcada limpia.`)}>
                      Marcar limpia
                    </CocoaButton>
                  ) : null}
                  {isClean ? (
                    <CocoaButton size="small" disabled={busy} onClick={() => void run(() => markRoomInspected(item.room.id), `Habitación ${item.room.number} inspeccionada.`)}>
                      Inspeccionar
                    </CocoaButton>
                  ) : null}
                  <CocoaButton size="small" variant="bordered" tone="neutral" disabled={busy} onClick={() => openTaskForm(item.room.id)}>
                    {newLabel("f", "tarea")}
                  </CocoaButton>
                </div>
              </CocoaCard>
            );
          })}
        </CocoaKpiStrip>
      )}

      <CocoaDrawer
        open={formRoom !== null}
        onClose={closeTaskForm}
        title={newLabel("f", "tarea")}
        subtitle={formItem ? `Habitación ${formItem.room.number}` : undefined}
        side="right"
        size="sm"
        initialFocus={() => document.getElementById("hk-task-type")}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeTaskForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton loading={busy} onClick={submitTask}>
              Crear tarea
            </CocoaButton>
          </>
        }
      >
        <CocoaFormRow columns={1}>
          <CocoaField label="Tipo de tarea">
            <CocoaSelect id="hk-task-type" value={formType} onChange={(v) => setFormType(v as HkTaskType)} options={TASK_TYPE_OPTIONS} disabled={busy} />
          </CocoaField>
          <CocoaField label="Prioridad">
            <CocoaSelect value={formPriority} onChange={(v) => setFormPriority(v as HkPriority)} options={PRIORITY_OPTIONS} disabled={busy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDrawer>
    </CocoaPage>
  );
}
