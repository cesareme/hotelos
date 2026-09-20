// Maintenance Dashboard — «Tablero de mantenimiento» (/operaciones/mantenimiento;
// base tab of MantenimientoTabs, standalone the page paints eyebrow + H1).
//
// Cocoa 22 (ola 4 · lote 4-A, archetype «workspace»): CocoaPage → CocoaKpiStrip
// (emergencias · abiertas · en curso · esperando proveedor · bloquean
// habitación) → filter chips (CocoaButton aria-pressed with counts) →
// CocoaGrid 4/8: the work-order list (CocoaSection scroll="y", a row is a
// CocoaButton plus CocoaBadge states) and the selected order's record (state,
// room, dates, description, CocoaSelect for the status, «Asignar a» +
// «Asignarme», «Bloquear habitación» / «Resolver»). Below 900 px the list is
// the page and the record opens in a CocoaDrawer (bottom sheet on phones).
// «Nueva orden» opens a CocoaDrawer form (CocoaField + CocoaInput /
// CocoaSelect / CocoaSwitch). Results and errors go to the toast; same API
// calls as before (services/maintenanceApi, 30 s poll).
//
// Tanda UX-3 · P3 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.3, §5, §6;
// fricciones F1 F2 F3 F8 F10 F11 F15):
//   · «Asignada a» editable: «Asignar a» (CocoaInput + datalist con los
//     responsables vistos y el usuario de la sesión) y «Asignarme»; PATCH
//     optimista (`mutate`) con aviso «Parte … → asignado a …».
//   · «Bloquear habitación» abre un CocoaDialog nominal («Bloquear la 305» /
//     «Mantenerla en venta», tone destructive) y avisa con número; solo se
//     pinta con permiso (manage + ai.high_risk.confirm, D4).
//   · «Resolver» es optimista + escritura DIFERIDA 8 s (deferredCommit;
//     `resolved` es terminal en el API): el POST /resolve viaja al agotar la
//     ventana, al salir o en `pagehide` (keepalive); «Deshacer» = nada viaja.
//   · `busy` por parte; etiquetas por operations-director-labels.ts (P6);
//     copia por content/pisos-actions.ts; `density="operational"`; ⌘K con
//     nueva orden, asignarme y resolver.
//
// Corrector UX-3-REV (2026-09-20): el toast de «Resolver» no se pausa con el
// ratón ni el foco (`pauseOnHover: false`) y un «Deshacer» tardío avisa «Parte
// X ya enviado» (`undoDeferred`, REV-01); «Actualizar» (`refreshBoard`: cabecera,
// ⌘K, reintento y tras crear una orden) vacía las escrituras diferidas, espera
// a que lleguen y solo entonces revalida (REV-02); «Asignarme» no dispara el
// blur de «Asignar a» (que asignaba el texto a medias) y una intención llegada
// mientras otra viaja se encola en vez de perderse (REV-04).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { getUser } from "../../services/auth-storage";
import { useApiData } from "../../hooks/useApiData";
import { useTabHost } from "../tabs/TabHost";
import { fetchRooms } from "../../services/pmsCommerceApi";
import {
  blockRoomForWorkOrder,
  createWorkOrder,
  resolveWorkOrder,
  updateWorkOrder,
  type WorkOrder,
  type WoPriority,
  type WoStatus
} from "../../services/maintenanceApi";
import { ACTION_DURATION, useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { date, number, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { MANT_ACTIONS, MANT_TOASTS, workOrderRef } from "../../content/pisos-actions";
import { priorityLabel, woStatusLabel } from "./operations-director-labels";
import { deferredCommit, undoDeferred, type DeferredFlushReason } from "./deferred-commit";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  useViewportTier,
  type CocoaPageCommand,
  type CocoaSelectOption,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

// Tonos (los textos salen de priorityLabel / woStatusLabel, P6).
const PRIORITY_TONE: Record<string, CocoaTone> = { emergency: "danger", urgent: "warning", normal: "info", preventive: "success" };
const STATUS_TONE: Record<string, CocoaTone> = { open: "warning", assigned: "info", in_progress: "info", waiting_vendor: "warning", resolved: "success", closed: "success" };

const STATUS_OPTIONS: WoStatus[] = ["open", "assigned", "in_progress", "waiting_vendor"];
const PRIORITIES: WoPriority[] = ["emergency", "urgent", "normal", "preventive"];
const STATUS_SELECT_OPTIONS: CocoaSelectOption[] = STATUS_OPTIONS.map((s) => ({ value: s, label: woStatusLabel(s) }));
const PRIORITY_SELECT_OPTIONS: CocoaSelectOption[] = PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }));

const FILTERS: { id: string; label: string; match: (w: WorkOrder) => boolean }[] = [
  { id: "active", label: "Activas", match: (w) => w.status !== "resolved" && w.status !== "closed" },
  { id: "all", label: "Todas", match: () => true },
  { id: "open", label: "Abiertas", match: (w) => w.status === "open" },
  { id: "in_progress", label: "En curso", match: (w) => w.status === "in_progress" || w.status === "assigned" },
  { id: "waiting_vendor", label: "Esperando proveedor", match: (w) => w.status === "waiting_vendor" },
  { id: "blocking", label: "Bloquean habitación", match: (w) => w.blocksRoom },
  { id: "resolved", label: "Resueltas", match: (w) => w.status === "resolved" || w.status === "closed" }
];

const PRIORITY_ORDER: Record<string, number> = { emergency: 0, urgent: 1, normal: 2, preventive: 3 };

const LIST_MAX_HEIGHT = 560;

/** Ventana de arrepentimiento de «Resolver»: la misma que dura el toast con «Deshacer» (8 s). */
export const RESOLVE_UNDO_MS = ACTION_DURATION;

function isClosed(w: WorkOrder): boolean {
  return w.status === "resolved" || w.status === "closed";
}

/** Optimismo: la orden `id` con `patch` aplicado (resto intacto). */
export function patchOrder(list: readonly WorkOrder[], id: string, patch: Partial<WorkOrder>): WorkOrder[] {
  return list.map((order) => (order.id === id ? { ...order, ...patch } : order));
}

/** Sugerencias de «Asignar a»: responsables ya vistos en las órdenes + el usuario de la sesión, sin duplicados. */
export function assigneeSuggestions(orders: readonly WorkOrder[], me: string): string[] {
  const seen = new Set<string>();
  for (const order of orders) {
    const who = (order.assignedTo ?? "").trim();
    if (who) seen.add(who);
  }
  if (me.trim()) seen.add(me.trim());
  return [...seen].sort((a, b) => a.localeCompare(b, "es"));
}

/** D4: «Bloquear habitación» solo con manage + ai.high_risk.confirm (sesión sin lista de permisos → se pinta, como el resto del shell). */
export function canBlockRooms(permissions: readonly string[] | undefined): boolean {
  if (!permissions) return true;
  return permissions.includes("maintenance.workorder.manage") && permissions.includes("ai.high_risk.confirm");
}

/** Escritura diferida de un parte: la ventana y la promesa de la mutación (para que «Actualizar» la espere, REV-02). */
type PendingWrite = { commit: ReturnType<typeof deferredCommit>; done: Promise<void> };

/** «Deshacer» dentro de la ventana: no viaja nada y `mutate` restaura la orden. */
class UndoneError extends Error {
  constructor() {
    super("undone");
    this.name = "UndoneError";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// Named style objects (rule 6): layout and text flow only.
const listInsetStyle: CSSProperties = { padding: "0 var(--cocoa-space-4)" };
const rowButtonStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0, height: "auto", justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal" };
const captionStyle: CSSProperties = { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const descriptionStyle: CSSProperties = { margin: 0, whiteSpace: "pre-line" };

function MaintenanceSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} min={200} />
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton.Grid rows={[[4, 8]]} height={420} />
    </div>
  );
}

export function MaintenanceDashboard() {
  const hosted = useTabHost() !== null;
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";
  const { showToast } = useToast();
  const { data, loading, error, refresh, mutate } = useApiData<WorkOrder[]>(
    `/properties/${PROPERTY_ID}/work-orders`,
    { pollIntervalMs: 30000 }
  );
  const orders = useMemo(() => toArray<WorkOrder>(data), [data]);
  const user = getUser();
  const me = user?.fullName || user?.email || "";
  const mayBlock = canBlockRooms(user?.permissions);

  const [rooms, setRooms] = useState<Record<string, string>>({});
  useEffect(() => {
    void fetchRooms(PROPERTY_ID).then((list) => {
      const map: Record<string, string> = {};
      for (const r of list) map[r.id] = r.number;
      setRooms(map);
    }).catch(() => setRooms({}));
  }, []);

  const [filter, setFilter] = useState("active");
  // `busy` por parte (F1): la ficha que no tocaste no se apaga.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => orders.find((o) => o.id === selectedId) ?? null, [orders, selectedId]);
  const [assignDraft, setAssignDraft] = useState("");
  const [blockFor, setBlockFor] = useState<WorkOrder | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [fTitle, setFTitle] = useState("");
  const [fRoom, setFRoom] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fPriority, setFPriority] = useState<WoPriority>("normal");
  const [fBlocks, setFBlocks] = useState(false);
  // Escrituras diferidas («Resolver») por parte: una segunda acción sobre el mismo parte vacía la anterior (§5).
  const pending = useRef(new Map<string, PendingWrite>());
  // Última intención de «Asignar a» / «Asignarme» llegada mientras otra viajaba: se aplica al terminar, no se descarta (REV-04).
  const queuedAssign = useRef<{ id: string; who: string } | null>(null);

  // El borrador de «Asignar a» sigue a la orden elegida (y a lo que traiga el sondeo).
  const selectedAssignedTo = selected?.assignedTo ?? "";
  useEffect(() => {
    setAssignDraft(selectedAssignedTo);
  }, [selectedId, selectedAssignedTo]);

  // Las escrituras diferidas se envían al salir de la pantalla (o al cerrar la pestaña; con `keepalive` en pagehide).
  const flushPending = useCallback((reason: DeferredFlushReason = "manual") => {
    for (const write of pending.current.values()) write.commit.flush(reason);
  }, []);
  useEffect(() => {
    const onPageHide = () => flushPending("pagehide");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushPending("manual");
    };
  }, [flushPending]);

  /** «Actualizar»: vacía las escrituras diferidas y espera a que lleguen antes de pedir la lista (R2, UX-3-REV-02). */
  const refreshBoard = useCallback(async () => {
    const inFlight = Array.from(pending.current.values(), (write) => write.done);
    flushPending("manual");
    await Promise.allSettled(inFlight);
    refresh();
  }, [flushPending, refresh]);

  const kpis = useMemo(() => {
    const k = { open: 0, inProgress: 0, waiting: 0, blocking: 0, emergency: 0 };
    for (const w of orders) {
      if (w.status === "open") k.open += 1;
      if (w.status === "in_progress" || w.status === "assigned") k.inProgress += 1;
      if (w.status === "waiting_vendor") k.waiting += 1;
      if (w.blocksRoom && !isClosed(w)) k.blocking += 1;
      if (w.priority === "emergency" && !isClosed(w)) k.emergency += 1;
    }
    return k;
  }, [orders]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    return orders.filter(f.match).sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || b.createdAt.localeCompare(a.createdAt));
  }, [orders, filter]);

  const assignees = useMemo(() => assigneeSuggestions(orders, me), [orders, me]);

  function roomNumberOf(w: WorkOrder): string | null {
    return w.roomId ? rooms[w.roomId] ?? null : null;
  }

  function roomLabel(w: WorkOrder): string {
    if (!w.roomId) return "—";
    const n = roomNumberOf(w);
    return n ? `Hab. ${n}` : "Hab.";
  }

  function openForm() {
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
  }

  async function submitForm() {
    setFormBusy(true);
    try {
      const created = await createWorkOrder({ title: fTitle, roomNumber: fRoom || undefined, description: fDesc || undefined, priority: fPriority, blocksRoom: fBlocks });
      setFTitle("");
      setFRoom("");
      setFDesc("");
      setFPriority("normal");
      setFBlocks(false);
      setShowForm(false);
      showToast(MANT_TOASTS.created(workOrderRef(created.id)), { variant: "success" });
      void refreshBoard();
    } catch (e) {
      showToast(errorMessage(e, "No se pudo crear la orden."), { variant: "error" });
    } finally {
      setFormBusy(false);
    }
  }

  /** Cambio de estado desde el selector: optimista, aviso con la etiqueta del diccionario. */
  async function changeStatus(w: WorkOrder, status: WoStatus) {
    const ref = workOrderRef(w.id);
    setBusyId(w.id);
    try {
      await mutate(
        (prev) => patchOrder(toArray<WorkOrder>(prev), w.id, { status }),
        async () => {
          await updateWorkOrder(w.id, { status });
        }
      );
      showToast(MANT_TOASTS.statusChanged(ref, woStatusLabel(status)), { variant: "success" });
    } catch (e) {
      showToast(errorMessage(e, "No se pudo cambiar el estado."), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  /** «Asignar a» / «Asignarme» (F15): PATCH optimista; vacío o sin cambio = nada viaja; con otra en vuelo, la última intención se encola (REV-04). */
  async function assign(w: WorkOrder, who: string) {
    const value = who.trim();
    if (busyId === w.id) {
      queuedAssign.current = { id: w.id, who: value };
      return;
    }
    if (!value || value === (w.assignedTo ?? "")) {
      setAssignDraft(w.assignedTo ?? "");
      return;
    }
    const ref = workOrderRef(w.id);
    setBusyId(w.id);
    let assignedTo = w.assignedTo;
    try {
      await mutate(
        (prev) => patchOrder(toArray<WorkOrder>(prev), w.id, { assignedTo: value }),
        async () => {
          await updateWorkOrder(w.id, { assignedTo: value });
        }
      );
      assignedTo = value;
      showToast(MANT_TOASTS.assigned(ref, value), { variant: "success" });
    } catch (e) {
      setAssignDraft(w.assignedTo ?? "");
      showToast(errorMessage(e, "No se pudo asignar el parte."), { variant: "error" });
    } finally {
      setBusyId(null);
      const queued = queuedAssign.current;
      if (queued && queued.id === w.id) {
        queuedAssign.current = null;
        void assign({ ...w, assignedTo }, queued.who);
      }
    }
  }

  /** Confirmación del diálogo nominal: POST /block-room, optimista sobre `blocksRoom`, aviso con número (F8). */
  async function blockRoom(w: WorkOrder) {
    const n = roomNumberOf(w) ?? "—";
    setBlockBusy(true);
    try {
      await mutate(
        (prev) => patchOrder(toArray<WorkOrder>(prev), w.id, { blocksRoom: true }),
        async () => {
          await blockRoomForWorkOrder(w.id);
        }
      );
      setBlockFor(null);
      showToast(MANT_TOASTS.roomBlocked(n), { variant: "success", announce: MANT_TOASTS.roomBlocked(n) });
    } catch (e) {
      showToast(errorMessage(e, "No se pudo bloquear la habitación."), { variant: "error" });
    } finally {
      setBlockBusy(false);
    }
  }

  /** «Resolver»: la orden pasa a resuelta al instante; el POST /resolve viaja al agotar la ventana (o al salir / pagehide); «Deshacer» = nada viaja. */
  function resolveOrder(w: WorkOrder): Promise<void> {
    const id = w.id;
    const ref = workOrderRef(id);
    const n = roomNumberOf(w);
    pending.current.get(id)?.commit.flush();
    const commit = deferredCommit(RESOLVE_UNDO_MS);
    const message = w.blocksRoom && n ? MANT_TOASTS.resolvedRoomReleased(ref, n) : MANT_TOASTS.resolved(ref);
    showToast(message, {
      variant: "success",
      duration: RESOLVE_UNDO_MS,
      // El toast y la ventana corren en paralelo: pausar el toast (ratón o foco) no pausa la escritura (UX-3-REV-01).
      pauseOnHover: false,
      action: { label: MANT_ACTIONS.undo, onAction: () => void undoDeferred(commit, () => showToast(MANT_TOASTS.undoExpired(ref), { variant: "warning" })) },
      announce: message
    });
    if (compact) setSelectedId(null);
    const done = mutate(
      (prev) => patchOrder(toArray<WorkOrder>(prev), id, { status: "resolved", resolvedAt: new Date().toISOString() }),
      async () => {
        const go = await commit.wait();
        if (!go) throw new UndoneError();
        await resolveWorkOrder(id, { releaseRoom: w.blocksRoom }, { keepalive: commit.reason() === "pagehide" });
      }
    )
      .catch((e: unknown) => {
        if (e instanceof UndoneError) {
          showToast(MANT_TOASTS.undone(ref), { variant: "info" });
        } else {
          // R3: 409 «La orden ya está resuelta.» (otro dispositivo) → rollback de mutate + aviso, sin diálogo.
          showToast(errorMessage(e, "No se pudo resolver la orden."), { variant: "error" });
        }
      })
      .finally(() => {
        if (pending.current.get(id)?.commit === commit) pending.current.delete(id);
      });
    // «Actualizar» (refreshBoard) espera `done` antes de revalidar (UX-3-REV-02).
    pending.current.set(id, { commit, done });
    return done;
  }

  function detailMeta(w: WorkOrder): string {
    return `${roomLabel(w)} · ${priorityLabel(w.priority)}`;
  }

  // Record body shared by the desktop pane and the phone/tablet drawer.
  function renderDetail(w: WorkOrder) {
    const busy = busyId === w.id;
    return (
      <div className="cocoa-stack" data-gap="4">
        <ul className="c22-section__list" aria-label="Datos de la orden">
          <li>
            <span>{FIELD_LABELS.status}</span>
            <CocoaBadge tone={STATUS_TONE[w.status] ?? "info"}>{woStatusLabel(w.status)}</CocoaBadge>
          </li>
          <li>
            <span>Prioridad</span>
            <CocoaBadge tone={PRIORITY_TONE[w.priority] ?? "info"}>{priorityLabel(w.priority)}</CocoaBadge>
          </li>
          <li>
            <span>{FIELD_LABELS.room}</span>
            <strong>{roomLabel(w)}</strong>
          </li>
          <li>
            <span>Bloquea habitación</span>
            <strong>{w.blocksRoom ? "Sí (fuera de servicio)" : STATUS_LABELS.no}</strong>
          </li>
          <li>
            <span>Asignada a</span>
            <strong>{w.assignedTo ?? "Sin asignar"}</strong>
          </li>
          <li>
            <span>Creada</span>
            <strong>{date(w.createdAt, "dayMonth")}</strong>
          </li>
          {w.resolvedAt ? (
            <li>
              <span>Resuelta</span>
              <strong>{date(w.resolvedAt, "dayMonth")}</strong>
            </li>
          ) : null}
        </ul>
        <div className="cocoa-stack" data-gap="1">
          <span style={captionStyle}>{FIELD_LABELS.description}</span>
          <p style={descriptionStyle}>{w.description || "Sin descripción."}</p>
        </div>
        {!isClosed(w) ? (
          <CocoaFormRow columns={2}>
            <CocoaField label={FIELD_LABELS.status} help="El cambio se guarda al elegirlo.">
              <CocoaSelect
                value={w.status}
                onChange={(v) => void changeStatus(w, v as WoStatus)}
                options={STATUS_SELECT_OPTIONS}
                disabled={busy}
              />
            </CocoaField>
            <CocoaField label={MANT_ACTIONS.assignTo} help="Escribe un nombre y pulsa Enter, o pulsa «Asignarme».">
              <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
                <CocoaInput
                  id="wo-assign-to"
                  value={assignDraft}
                  onChange={setAssignDraft}
                  suggestions={assignees}
                  placeholder="Sin asignar"
                  disabled={busy}
                  onBlur={() => void assign(w, assignDraft)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void assign(w, assignDraft);
                    }
                  }}
                />
                {/* onMouseDown preventDefault: el clic no dispara el blur de «Asignar a» (que asignaba el texto a medias antes que «Asignarme», REV-04). */}
                <span onMouseDown={(event) => event.preventDefault()}>
                  <CocoaButton variant="bordered" tone="neutral" disabled={busy || !me || (w.assignedTo ?? "") === me} onClick={() => void assign(w, me)}>
                    {MANT_ACTIONS.assignMe}
                  </CocoaButton>
                </span>
              </div>
            </CocoaField>
          </CocoaFormRow>
        ) : null}
      </div>
    );
  }

  // «Bloquear habitación» / «Resolver» (two buttons at most: section footer or drawer footer).
  function renderDetailActions(w: WorkOrder) {
    if (isClosed(w)) return null;
    const busy = busyId === w.id;
    return (
      <>
        {mayBlock && !w.blocksRoom && w.roomId ? (
          <CocoaButton variant="bordered" tone="neutral" disabled={busy} onClick={() => setBlockFor(w)}>
            {MANT_ACTIONS.blockRoom}
          </CocoaButton>
        ) : null}
        <CocoaButton loading={busy} onClick={() => void resolveOrder(w)}>
          {MANT_ACTIONS.resolve}
        </CocoaButton>
      </>
    );
  }

  const list = (
    <CocoaSection
      title="Órdenes"
      meta={plural(visible.length, "orden", "órdenes")}
      scroll={compact ? undefined : "y"}
      maxHeight={compact ? undefined : LIST_MAX_HEIGHT}
      padding="none"
    >
      {visible.length === 0 ? (
        <CocoaState kind="empty" inline title="No hay órdenes de trabajo que coincidan con este filtro." style={listInsetStyle} />
      ) : (
        <ul className="c22-section__list" style={listInsetStyle} aria-label="Órdenes de trabajo">
          {visible.map((w) => {
            const isSelected = w.id === selectedId;
            return (
              <li key={w.id}>
                <CocoaButton
                  variant="plain"
                  tone={isSelected ? "accent" : "neutral"}
                  size="small"
                  onClick={() => setSelectedId(w.id)}
                  aria-current={isSelected ? true : undefined}
                  style={rowButtonStyle}
                >
                  {w.title}
                </CocoaButton>
                <span className="cocoa-cluster">
                  <CocoaBadge tone={PRIORITY_TONE[w.priority] ?? "info"} variant="dot" size="small">
                    {priorityLabel(w.priority)}
                  </CocoaBadge>
                  <CocoaBadge tone={STATUS_TONE[w.status] ?? "info"} size="small">
                    {woStatusLabel(w.status)}
                  </CocoaBadge>
                  {w.blocksRoom && !isClosed(w) ? (
                    <CocoaBadge tone="danger" variant="tinted" size="small">
                      bloquea
                    </CocoaBadge>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CocoaSection>
  );

  const detailActions = selected ? renderDetailActions(selected) : null;

  const detail = selected ? (
    <CocoaSection
      title={selected.title}
      meta={detailMeta(selected)}
      footer={
        detailActions ? (
          <div className="cocoa-row" data-gap="2" data-justify="end">
            {detailActions}
          </div>
        ) : undefined
      }
    >
      {renderDetail(selected)}
    </CocoaSection>
  ) : (
    <CocoaSection aria-label="Sin selección">
      <CocoaState kind="empty" title="Elige una orden" message="La ficha aparece aquí: estado, habitación, descripción y acciones." illustration="box" />
    </CocoaSection>
  );

  const blockRoomNumber = blockFor ? roomNumberOf(blockFor) ?? "habitación" : "";
  const saving = busyId !== null || formBusy || blockBusy;

  const commands: CocoaPageCommand[] = [
    { id: "maintenance-refresh", label: "Actualizar el tablero de mantenimiento", run: () => void refreshBoard() },
    { id: "maintenance-new-order", label: MANT_ACTIONS.newWorkOrder, run: openForm },
    ...(selected && !isClosed(selected)
      ? [
          { id: "maintenance-assign-me", label: `${MANT_ACTIONS.assignMe} el parte ${workOrderRef(selected.id)}`, run: () => void assign(selected, me) },
          { id: "maintenance-resolve", label: `${MANT_ACTIONS.resolve} el parte ${workOrderRef(selected.id)}`, run: () => void resolveOrder(selected) }
        ]
      : [])
  ];

  return (
    <CocoaPage
      eyebrow="Operaciones · Mantenimiento"
      title="Tablero de mantenimiento"
      subtitle={hosted ? undefined : "Órdenes de trabajo en vivo. Crea averías, cambia su estado, asígnalas, bloquea habitaciones y resuélvelas."}
      density="operational"
      actions={
        <>
          {saving ? <CocoaBadge tone="info">{STATUS_LABELS.saving}</CocoaBadge> : null}
          {error && orders.length > 0 ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refreshBoard()} loading={loading && orders.length > 0}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton size="small" icon={<PlusIcon size={12} aria-hidden="true" />} onClick={openForm}>
            {MANT_ACTIONS.newWorkOrder}
          </CocoaButton>
        </>
      }
      state={loading && orders.length === 0 ? "loading" : error && orders.length === 0 ? "error" : "ready"}
      skeleton={<MaintenanceSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: () => void refreshBoard() }}
      commands={commands}
    >
      <CocoaKpiStrip min={200} stagger aria-label="Órdenes de trabajo por estado">
        <CocoaKpi label="Emergencias" value={number(kpis.emergency)} polarity="negative-good" status={kpis.emergency > 0 ? "critical" : "ok"} />
        <CocoaKpi label="Abiertas" value={number(kpis.open)} polarity="negative-good" status={kpis.open > 0 ? "warning" : "ok"} />
        <CocoaKpi label="En curso" value={number(kpis.inProgress)} polarity="neutral" status="ok" />
        <CocoaKpi label="Esperando proveedor" value={number(kpis.waiting)} polarity="negative-good" status={kpis.waiting > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Bloquean habitación" value={number(kpis.blocking)} polarity="negative-good" status={kpis.blocking > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      <div className="cocoa-cluster" role="group" aria-label="Filtrar órdenes">
        {FILTERS.map((f) => {
          const count = orders.filter(f.match).length;
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

      {compact ? (
        <>
          {list}
          <CocoaDrawer
            open={selected !== null}
            onClose={() => setSelectedId(null)}
            title={selected?.title ?? "Orden de trabajo"}
            subtitle={selected ? detailMeta(selected) : undefined}
            side="right"
            size="md"
            footer={detailActions ?? undefined}
          >
            {selected ? renderDetail(selected) : null}
          </CocoaDrawer>
        </>
      ) : (
        <CocoaGrid align="start" aria-label="Órdenes y ficha">
          <CocoaSpan cols={4} min={320}>
            {list}
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            {detail}
          </CocoaSpan>
        </CocoaGrid>
      )}

      <CocoaDialog
        open={blockFor !== null}
        onClose={() => setBlockFor(null)}
        tone="destructive"
        size="sm"
        title={MANT_ACTIONS.blockRoomConfirm(blockRoomNumber)}
        description="La habitación sale del inventario vendible hasta que el parte se resuelva (fuera de servicio si está libre; si está ocupada, deja de venderse al salir el huésped). Se audita como cambio de estado."
        confirmLabel={MANT_ACTIONS.blockRoomConfirm(blockRoomNumber)}
        cancelLabel={MANT_ACTIONS.keepRoomOnSale}
        busy={blockBusy}
        submitOnEnter
        onConfirm={() => (blockFor ? blockRoom(blockFor) : undefined)}
      />

      <CocoaDrawer
        open={showForm}
        onClose={closeForm}
        title={MANT_ACTIONS.newWorkOrder}
        subtitle="Se crea abierta; asígnala o bloquea la habitación desde su ficha."
        side="right"
        size="md"
        initialFocus={() => document.getElementById("wo-title")}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeForm} disabled={formBusy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton loading={formBusy} disabled={!fTitle.trim()} onClick={() => void submitForm()}>
              Crear orden
            </CocoaButton>
          </>
        }
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Título" required fullWidth>
            <CocoaInput id="wo-title" value={fTitle} onChange={setFTitle} placeholder="Ej.: Fuga en el baño" disabled={formBusy} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.room} hint={STATUS_LABELS.optional} help="Número de habitación">
            <CocoaInput value={fRoom} onChange={setFRoom} placeholder="Ej.: 108" disabled={formBusy} />
          </CocoaField>
          <CocoaField label="Prioridad">
            <CocoaSelect value={fPriority} onChange={(v) => setFPriority(v as WoPriority)} options={PRIORITY_SELECT_OPTIONS} disabled={formBusy} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.description} fullWidth>
            <CocoaInput value={fDesc} onChange={setFDesc} multiline rows={3} disabled={formBusy} />
          </CocoaField>
          <CocoaField label="Bloquea la habitación (fuera de servicio)" inline fullWidth>
            <CocoaSwitch checked={fBlocks} onChange={setFBlocks} disabled={formBusy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDrawer>
    </CocoaPage>
  );
}
