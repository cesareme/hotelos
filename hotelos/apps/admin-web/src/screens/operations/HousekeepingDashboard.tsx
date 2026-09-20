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
// CocoaDrawer (type + priority + «Asignar a»). Results and errors go to the
// toast; same API calls as before (services/housekeepingApi, 30 s poll).
//
// Tanda UX-3 · P1 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.1, §5):
// «Marcar limpia» / «Inspeccionar» son optimistas sobre el board
// (`useApiData.mutate`) con toast «Deshacer» 8 s y escritura DIFERIDA
// (deferred-commit.ts): deshacer = no se envía nada; una ventana por
// habitación (la segunda acción vacía la anterior) y `pagehide` vacía todas
// con `keepalive`. `busy` POR habitación (la tarjeta que no tocaste no se
// apaga). Etiquetas por operations-director-labels.ts y el mantenimiento por
// diccionario (nunca «Mantenimiento: blocked»). «Nueva tarea» con «Asignar a»
// (datalist con los asignados vistos y el usuario de sesión) y Enter envía.
// `density="operational"` y ⌘K con actualizar, nueva tarea y filtros.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { getUser } from "../../services/auth-storage";
import { useApiData } from "../../hooks/useApiData";
import {
  createHousekeepingTask,
  markRoomClean,
  markRoomInspected,
  updateHousekeepingTask,
  type HkBoardItem,
  type HkPriority,
  type HkTask,
  type HkTaskType
} from "../../services/housekeepingApi";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { useTabHost } from "../tabs/TabHost";
import { nextTaskAction } from "./housekeeping-task-actions";
import {
  HK_UNDO_MS,
  assigneeSuggestions,
  boardWithRoomHousekeeping,
  boardWithTask,
  boardWithTaskStatus,
  maintenanceStatusEntry,
  sessionUserName,
  taskCreatedToast,
  type HkDeferredWrite
} from "./housekeeping-task-actions";
import { deferredCommit, undoDeferred, type DeferredFlushReason } from "./deferred-commit";
import { hkTaskStatusLabel, hkTaskTypeLabel, priorityLabel } from "./operations-director-labels";
import { number } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { PISOS_ACTIONS, PISOS_TOASTS } from "../../content/pisos-actions";
import { roomStatus } from "../../content/status-dictionary";
import {
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaCard,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
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

const PRIORITY_TONE: Record<string, CocoaTone> = { low: "info", normal: "success", high: "warning" };

const TASK_TYPES: HkTaskType[] = ["departure_clean", "stayover", "inspection", "deep_clean"];
const TASK_TYPE_OPTIONS: CocoaSelectOption[] = TASK_TYPES.map((t) => ({ value: t, label: hkTaskTypeLabel(t) }));
const PRIORITIES: HkPriority[] = ["low", "normal", "high"];
const PRIORITY_OPTIONS: CocoaSelectOption[] = PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }));

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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "No se pudo completar la acción.");

type TaskForm = { roomId: string; pickRoom: boolean };

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
  const { data, loading, error, refresh, mutate } = useApiData<HkBoardItem[]>(
    `/properties/${PROPERTY_ID}/housekeeping/board`,
    { pollIntervalMs: 30000 }
  );
  const board = useMemo(() => toArray<HkBoardItem>(data), [data]);

  const [filter, setFilter] = useState("all");
  // Ocupado POR habitación (F1): solo la tarjeta cuya petición está en vuelo se apaga.
  const [busyRooms, setBusyRooms] = useState<ReadonlySet<string>>(() => new Set());
  const [taskForm, setTaskForm] = useState<TaskForm | null>(null);
  const [formType, setFormType] = useState<HkTaskType>("departure_clean");
  const [formPriority, setFormPriority] = useState<HkPriority>("normal");
  const [formAssignee, setFormAssignee] = useState("");
  const formItem = useMemo(() => (taskForm ? (board.find((i) => i.room.id === taskForm.roomId) ?? null) : null), [board, taskForm]);
  const assignees = useMemo(() => assigneeSuggestions(board, sessionUserName(getUser())), [board]);

  // Escrituras diferidas con deshacer (§5): una ventana por habitación; se
  // vacían al ocultar la página (`keepalive`) y al salir del tablero.
  const pendingByRoom = useRef(new Map<string, ReturnType<typeof deferredCommit>>());
  const flushPending = useCallback((reason: DeferredFlushReason = "manual") => {
    for (const pending of pendingByRoom.current.values()) pending.flush(reason);
  }, []);
  useEffect(() => {
    const onPageHide = () => flushPending("pagehide");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushPending("manual");
    };
  }, [flushPending]);

  // «Actualizar» con escrituras pendientes: primero se envían (la revalidación
  // llega sola al terminar la mutación; `refresh()` a secas pintaría el estado
  // del API por encima del optimista durante la ventana).
  const refreshBoard = useCallback(() => {
    if (pendingByRoom.current.size > 0) {
      flushPending("manual");
      return;
    }
    refresh();
  }, [flushPending, refresh]);

  const setRoomBusy = useCallback((roomId: string, on: boolean) => {
    setBusyRooms((prev) => {
      if (prev.has(roomId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(roomId);
      else next.delete(roomId);
      return next;
    });
  }, []);

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

  const roomOptions = useMemo<CocoaSelectOption[]>(
    () =>
      [...board]
        .sort((a, b) => a.room.number.localeCompare(b.room.number, "es", { numeric: true }))
        .map((i) => ({ value: i.room.id, label: `Habitación ${i.room.number}` })),
    [board]
  );

  /** Escritura optimista inmediata (tareas): el board cambia al instante, la petición viaja ya y la tarjeta queda ocupada mientras tanto. */
  async function run(roomId: string, optimistic: (prev: HkBoardItem[]) => HkBoardItem[], fn: () => Promise<unknown>, ok: string) {
    setRoomBusy(roomId, true);
    try {
      await mutate(
        (prev) => optimistic(toArray<HkBoardItem>(prev)),
        async () => {
          await fn();
        }
      );
      showToast(ok, { variant: "success" });
    } catch (e) {
      // Rollback ya hecho por `mutate`.
      showToast(errorMessage(e), { variant: "error" });
    } finally {
      setRoomBusy(roomId, false);
    }
  }

  /**
   * «Marcar limpia» / «Inspeccionar»: cambio optimista, toast con «Deshacer» y
   * POST diferido 8 s (deferred-commit.ts). Deshacer cancela la ventana (no se
   * envía nada) y devuelve la tarjeta a su estado anterior.
   */
  async function deferRoomWrite(item: HkBoardItem, write: HkDeferredWrite) {
    const roomId = item.room.id;
    const n = item.room.number;
    const previous = item.room.housekeepingStatus;
    // Una ventana por habitación: la segunda acción vacía la anterior (§5).
    pendingByRoom.current.get(roomId)?.flush();
    const pending = deferredCommit(HK_UNDO_MS);
    pendingByRoom.current.set(roomId, pending);
    const message = write === "clean" ? PISOS_TOASTS.roomClean(n) : PISOS_TOASTS.roomInspected(n);
    showToast(message, {
      variant: "success",
      duration: HK_UNDO_MS,
      // El toast y la ventana corren en paralelo: pausar el toast (ratón o foco) no pausa la escritura (UX-3-REV-01).
      pauseOnHover: false,
      action: {
        label: PISOS_ACTIONS.undo,
        onAction: () => {
          // Ventana ya agotada o vaciada: la escritura viajó; se avisa en vez de callar (UX-3-REV-01).
          if (!undoDeferred(pending, () => showToast(PISOS_TOASTS.undoExpired(n), { variant: "warning" }))) return;
          // Inversa optimista sin petición: la habitación vuelve a como estaba (las demás tarjetas, intactas).
          void mutate(
            (prev) => boardWithRoomHousekeeping(toArray<HkBoardItem>(prev), roomId, previous),
            async () => undefined
          );
          showToast(PISOS_TOASTS.undone(n), { variant: "info" });
        }
      },
      announce: message
    });
    try {
      await mutate(
        (prev) => boardWithRoomHousekeeping(toArray<HkBoardItem>(prev), roomId, write),
        async () => {
          const go = await pending.wait();
          if (!go) return; // Deshacer: no se envía nada.
          setRoomBusy(roomId, true);
          try {
            const options = { keepalive: pending.reason() === "pagehide" };
            if (write === "clean") await markRoomClean(roomId, options);
            else await markRoomInspected(roomId, options);
          } finally {
            setRoomBusy(roomId, false);
          }
        }
      );
    } catch (e) {
      // Rollback ya hecho por `mutate` (la tarjeta vuelve al estado del API).
      showToast(errorMessage(e), { variant: "error" });
    } finally {
      if (pendingByRoom.current.get(roomId) === pending) pendingByRoom.current.delete(roomId);
    }
  }

  function openTaskForm(roomId: string, pickRoom = false) {
    setFormType("departure_clean");
    setFormPriority("normal");
    setFormAssignee("");
    setTaskForm({ roomId, pickRoom });
  }

  function closeTaskForm() {
    setTaskForm(null);
  }

  async function submitTask() {
    const item = formItem;
    if (!item) return;
    const roomId = item.room.id;
    const n = item.room.number;
    const assignedTo = formAssignee.trim() || undefined;
    // Tarea optimista (id provisional): la revalidación tras el POST trae la real.
    const draft: HkTask = {
      id: `draft-${Date.now()}`,
      roomId,
      taskType: formType,
      priority: formPriority,
      status: assignedTo ? "assigned" : "pending",
      assignedTo,
      createdAt: new Date().toISOString()
    };
    closeTaskForm();
    await run(
      roomId,
      (prev) => boardWithTask(prev, draft),
      () => createHousekeepingTask({ roomId, taskType: formType, priority: formPriority, assignedTo }),
      taskCreatedToast(n, assignedTo)
    );
  }

  const commands = useMemo(
    () => [
      { id: "housekeeping-refresh", label: "Actualizar el tablero de pisos", run: refreshBoard },
      {
        id: "housekeeping-new-task",
        label: `${PISOS_ACTIONS.newTask} de pisos`,
        run: () => {
          const first = visible[0] ?? board[0];
          if (first) openTaskForm(first.room.id, true);
        }
      },
      ...FILTERS.map((f) => ({ id: `housekeeping-filter-${f.id}`, label: `Filtrar habitaciones: ${f.label}`, run: () => setFilter(f.id) }))
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshBoard, visible, board]
  );

  return (
    <CocoaPage
      eyebrow="Operaciones · Pisos"
      title="Tablero de pisos"
      subtitle={hosted ? undefined : "Estado de cada habitación en vivo. Marca limpiezas, inspecciona y crea tareas para el equipo."}
      density="operational"
      actions={
        <>
          {busyRooms.size > 0 ? <CocoaBadge tone="info">{STATUS_LABELS.saving}</CocoaBadge> : null}
          {error && board.length > 0 ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshBoard} loading={loading && board.length > 0}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && board.length === 0 ? "loading" : error && board.length === 0 ? "error" : "ready"}
      skeleton={<HousekeepingSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refreshBoard }}
      commands={commands}
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
            const maintenance = maintenanceStatusEntry(item.room.maintenanceStatus);
            const busy = busyRooms.has(item.room.id);
            return (
              <CocoaCard key={item.room.id} variant="bordered" style={roomCardStyle} role="group" aria-label={`Habitación ${item.room.number}`}>
                <div className="cocoa-row" data-justify="between" data-align="start" data-wrap="nowrap">
                  <div className="cocoa-row" data-gap="2" data-align="baseline">
                    <strong style={roomNumberStyle}>{item.room.number}</strong>
                    {item.room.floor ? <span style={captionStyle}>planta {item.room.floor}</span> : null}
                  </div>
                  <span className="cocoa-cluster">
                    <CocoaStatusBadge entry={roomStatus(s)} />
                    {isOccupied(item) || isOutOfService(item) ? <CocoaStatusBadge entry={roomStatus(item.room.status)} variant="tinted" /> : null}
                  </span>
                </div>

                {maintenance || !item.room.sellable ? (
                  <div className="cocoa-cluster">
                    {maintenance ? <CocoaStatusBadge entry={maintenance} title="Mantenimiento" /> : null}
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
                      const next = nextTaskAction(t.status);
                      return (
                        <li key={t.id}>
                          <span className="cocoa-row" data-gap="1" style={taskLabelStyle}>
                            <span>{hkTaskTypeLabel(t.taskType)}</span>
                            <CocoaBadge tone={PRIORITY_TONE[t.priority] ?? "info"} variant="dot" size="small">
                              {priorityLabel(t.priority)}
                            </CocoaBadge>
                            <span style={captionStyle}>
                              {hkTaskStatusLabel(t.status)}
                              {t.assignedTo ? ` · ${t.assignedTo}` : ""}
                            </span>
                          </span>
                          {t.status !== "done" ? (
                            <CocoaButton
                              variant="bordered"
                              tone="neutral"
                              size="small"
                              disabled={busy}
                              onClick={() => void run(item.room.id, (prev) => boardWithTaskStatus(prev, t.id, next.status), () => updateHousekeepingTask(t.id, { status: next.status }), next.done)}
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
                    <CocoaButton size="small" disabled={busy} onClick={() => void deferRoomWrite(item, "clean")}>
                      {PISOS_ACTIONS.markClean}
                    </CocoaButton>
                  ) : null}
                  {isClean ? (
                    <CocoaButton size="small" disabled={busy} onClick={() => void deferRoomWrite(item, "inspected")}>
                      {PISOS_ACTIONS.inspect}
                    </CocoaButton>
                  ) : null}
                  <CocoaButton size="small" variant="bordered" tone="neutral" disabled={busy} onClick={() => openTaskForm(item.room.id)}>
                    {PISOS_ACTIONS.newTask}
                  </CocoaButton>
                </div>
              </CocoaCard>
            );
          })}
        </CocoaKpiStrip>
      )}

      <CocoaDrawer
        open={taskForm !== null}
        onClose={closeTaskForm}
        title={PISOS_ACTIONS.newTask}
        subtitle={formItem ? `Habitación ${formItem.room.number}` : undefined}
        side="right"
        size="sm"
        submitOnEnter
        initialFocus={() => document.getElementById(taskForm?.pickRoom ? "hk-task-room" : "hk-task-type")}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeTaskForm}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton onClick={() => void submitTask()} disabled={!formItem}>
              {PISOS_ACTIONS.createTask}
            </CocoaButton>
          </>
        }
      >
        <CocoaFormRow columns={1}>
          {taskForm?.pickRoom ? (
            <CocoaField label="Habitación">
              <CocoaSelect id="hk-task-room" value={taskForm.roomId} onChange={(v) => setTaskForm({ roomId: v, pickRoom: true })} options={roomOptions} />
            </CocoaField>
          ) : null}
          <CocoaField label="Tipo de tarea">
            <CocoaSelect id="hk-task-type" value={formType} onChange={(v) => setFormType(v as HkTaskType)} options={TASK_TYPE_OPTIONS} />
          </CocoaField>
          <CocoaField label="Prioridad">
            <CocoaSelect value={formPriority} onChange={(v) => setFormPriority(v as HkPriority)} options={PRIORITY_OPTIONS} />
          </CocoaField>
          <CocoaField label={PISOS_ACTIONS.assignTo} hint="opcional" help="Nombre o correo de la camarera; Intro crea la tarea.">
            <CocoaInput id="hk-task-assignee" value={formAssignee} onChange={setFormAssignee} suggestions={assignees} placeholder="Sin asignar" autoComplete="off" />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDrawer>
    </CocoaPage>
  );
}
