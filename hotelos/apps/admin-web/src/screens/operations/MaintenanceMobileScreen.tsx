// Maintenance Mobile Screen — vista táctil para el técnico de mantenimiento
// («Mis averías», /operaciones/mantenimiento/mis-averias; hosted inside
// MantenimientoTabs, standalone the page paints eyebrow + H1 itself).
//
// Directriz ehotelOS (Nov 2026):
//   "Mantenimiento mobile-first. Vista del técnico que carga tablet/móvil.
//    Averías, habitaciones bloqueadas, SLA, prioridad, fotos, estado."
//
// Cocoa 22 (ola 4 · lote 4-A, archetype «otro» on PlantillaBase): CocoaPage →
// scope chips «Mías · Todas» + priority filter chips (CocoaButton aria-pressed
// with counts) → one CocoaCard per work order in a CocoaKpiStrip auto-fit tier
// (min 320: three, two or one per row) with CocoaBadge states and two large
// CocoaButton actions (≥ 44 px tap targets on a coarse pointer) → the note goes
// through a CocoaDrawer (bottom sheet on phones; replaces the native prompt) →
// CocoaActionBar keeps «Actualizar» and the data age under the thumb (phone,
// and any width with a coarse pointer: the corridor tablet). Data: GET
// /dashboards/maintenance-mobile (20 s poll); every write goes through the
// guarded `request` of useApiData.mutate (JWT + session handling, audited as
// the technician).
//
// Tanda UX-3 · P3 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.4, §5, §6;
// fricciones F1 F3 F6 F7 F11 F12):
//   · «Mías» = partes cuyo `assignedTo` es el nombre completo o el correo de la
//     sesión (`isAssignedToUser`); es el chip inicial si hay alguno.
//   · «Tomar» es optimista (`mutate`) y el aviso ofrece «Deshacer» → PATCH
//     inverso `{ status: "open", assignedTo: null }` (D7).
//   · «Resuelta» es optimista + escritura DIFERIDA 8 s (`deferredCommit`,
//     ACTION_DURATION del toast): `resolved` es terminal en el API
//     (maintenance.service.ts resolveWorkOrder/updateWorkOrder), así que el
//     POST /resolve solo viaja al agotar la ventana, al salir de la pantalla o
//     en `pagehide` (con `keepalive`); «Deshacer» cancela y no viaja nada.
//     Mientras hay una escritura pendiente la clave está `mutating` y el sondeo
//     no pisa la tarjeta (R2); «Actualizar» (`refreshQueue`) vacía antes las
//     pendientes, espera a que lleguen y solo entonces revalida (corrector
//     UX-3-REV-02: `refresh()` a secas pintaba el parte otra vez «En curso» y un
//     segundo «Resuelta» acababa en 409).
//   · `busy` por parte; etiquetas por operations-director-labels.ts (P6);
//     copia por content/pisos-actions.ts; `density="operational"` (P5).
//   · Corrector UX-3-REV-01: el toast de «Resuelta» no se pausa con el ratón ni
//     el foco (`pauseOnHover: false`; la ventana no se pausaba) y un «Deshacer»
//     tardío avisa «Parte X ya enviado» (`undoDeferred`).
//
// Tanda UX-3 · P4 (diseño §4.4, §4.6; fotos del parte de M1): «N fotos» de la
// tarjeta es un botón que abre `WorkOrderPhotosSheet` (CocoaSheet) con las
// miniaturas: GET /work-orders/:id/media (metadatos) y, por cada foto en línea,
// GET /work-orders/media/:mediaId con la sesión (`fetchWorkOrderMediaBlob`,
// Authorization como documentsApi.downloadFile) → object URL revocada al cerrar.
// Las fotos las adjunta pisos al reportar (≤ 3); aquí solo se ven.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { getUser } from "../../services/auth-storage";
import { fetchWorkOrderMediaBlob, listWorkOrderMedia, type WorkOrderMediaMeta } from "../../services/maintenanceApi";
import { toArray } from "../../utils/toArray";
import { ACTION_DURATION, useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { MAINT_INSTRUCTIONS } from "../../content/screen-instructions/maintenance";
import { useTabHost } from "../tabs/TabHost";
import { useCoarsePointer } from "../../lib/useCoarsePointer";
import { dateTime, number, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { MANT_ACTIONS, MANT_TOASTS, workOrderRef } from "../../content/pisos-actions";
import { priorityLabel, woStatusLabel } from "./operations-director-labels";
import { deferredCommit, undoDeferred, type DeferredFlushReason } from "./deferred-commit";
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
  CocoaSheet,
  CocoaSkeleton,
  CocoaState,
  formatFileSize,
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

type Summary = { urgent: number; high: number; normal: number; low: number; total: number; blockedRooms: number };

type Data = {
  generatedAt: string;
  summary: Summary;
  items: Item[];
};

type Filter = Priority | "all";
type Scope = "mine" | "all";

// Tonos de la prioridad derivada (los textos salen de priorityLabel). «Baja» =
// preventivo → `success`, como «preventive» en el tablero: el tinted neutral
// pintaba un borde a 1,35:1 en oscuro (hallazgo de U0, 1.4.11).
const PRIORITY_TONE: Record<Priority, CocoaTone> = { urgent: "danger", high: "warning", normal: "info", low: "success" };

const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: "mine", label: MANT_ACTIONS.mine },
  { id: "all", label: MANT_ACTIONS.all }
];

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todo" },
  { id: "urgent", label: priorityLabel("urgent") },
  { id: "high", label: priorityLabel("high") },
  { id: "normal", label: priorityLabel("normal") },
  { id: "low", label: priorityLabel("low") }
];

const EMPTY_SUMMARY: Summary = { urgent: 0, high: 0, normal: 0, low: 0, total: 0, blockedRooms: 0 };

/** Ventana de arrepentimiento de «Resuelta»: la misma que dura el toast con «Deshacer» (8 s). */
export const RESOLVE_UNDO_MS = ACTION_DURATION;

/** «Mías» (§4.4): el parte está asignado al usuario de la sesión (nombre completo o correo, sin distinguir mayúsculas). */
export function isAssignedToUser(assignedTo: string | null | undefined, user: { fullName?: string; email?: string } | null | undefined): boolean {
  const who = (assignedTo ?? "").trim().toLowerCase();
  if (!who || !user) return false;
  return [user.fullName, user.email].some((candidate) => (candidate ?? "").trim().toLowerCase() === who);
}

/** Recuento por prioridad de los partes visibles (chips de prioridad). */
export function countByPriority(items: readonly Item[]): Record<Filter, number> {
  const counts: Record<Filter, number> = { all: items.length, urgent: 0, high: 0, normal: 0, low: 0 };
  for (const item of items) counts[item.priority] += 1;
  return counts;
}

/** Escritura diferida de un parte: la ventana y la promesa de la mutación (para que «Actualizar» la espere, REV-02). */
type PendingWrite = { commit: ReturnType<typeof deferredCommit>; done: Promise<void> };

/** Optimismo: el parte `id` con `patch` aplicado (resto intacto). */
function withItem(prev: Data, id: string, patch: Partial<Item>): Data {
  return { ...prev, items: toArray<Item>(prev.items).map((item) => (item.workOrderId === id ? { ...item, ...patch } : item)) };
}

/** Optimismo de «Resuelta»: el parte sale de la cola (el API solo lista open/in_progress) y el resumen descuenta. */
function withoutItem(prev: Data, item: Item): Data {
  const summary = prev.summary ?? EMPTY_SUMMARY;
  return {
    ...prev,
    items: toArray<Item>(prev.items).filter((candidate) => candidate.workOrderId !== item.workOrderId),
    summary: {
      ...summary,
      total: Math.max(0, summary.total - 1),
      [item.priority]: Math.max(0, summary[item.priority] - 1),
      blockedRooms: item.blocksRoom ? Math.max(0, summary.blockedRooms - 1) : summary.blockedRooms
    }
  };
}

/** «Deshacer» dentro de la ventana: no viaja nada y `mutate` restaura la tarjeta. */
class UndoneError extends Error {
  constructor() {
    super("undone");
    this.name = "UndoneError";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
  const coarse = useCoarsePointer();
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data, loading, error, refresh, mutate } = useApiData<Data>(
    `/dashboards/maintenance-mobile?propertyId=${propertyId}`,
    { pollIntervalMs: 20000 }
  );
  const user = getUser();
  const [scope, setScope] = useState<Scope | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [noteFor, setNoteFor] = useState<Item | null>(null);
  const [note, setNote] = useState("");
  // Galería de fotos del parte (P4): abierta desde el botón «N fotos» de la tarjeta.
  const [galleryFor, setGalleryFor] = useState<Item | null>(null);
  // Escrituras diferidas («Resuelta») por parte: una segunda acción sobre el mismo parte vacía la anterior (§5).
  const pending = useRef(new Map<string, PendingWrite>());

  const summary = data?.summary ?? EMPTY_SUMMARY;
  const items = toArray<Item>(data?.items);
  const mine = items.filter((item) => isAssignedToUser(item.assignedTo, user));
  // «Mías» por defecto si hay alguna; el chip elegido a mano manda.
  const effectiveScope: Scope = scope ?? (mine.length > 0 ? "mine" : "all");
  const scoped = effectiveScope === "mine" ? mine : items;
  const filtered = filter === "all" ? scoped : scoped.filter((item) => item.priority === filter);
  const counts = countByPriority(scoped);
  const scopeCounts: Record<Scope, number> = { mine: mine.length, all: items.length };
  const dataAt = data?.generatedAt ? time(data.generatedAt) : null;
  const refreshing = loading && items.length > 0;

  const markBusy = useCallback((id: string, on: boolean) => {
    setBusy((prev) => {
      const next = { ...prev };
      if (on) next[id] = true;
      else delete next[id];
      return next;
    });
  }, []);

  // Las escrituras diferidas se envían al salir de la pantalla (o al cerrar la pestaña, sin esperar los 8 s; con
  // `keepalive` en pagehide): «Resuelta» nunca se pierde por navegar.
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

  /** «Actualizar»: vacía las escrituras diferidas y espera a que lleguen antes de pedir la cola (R2, UX-3-REV-02). */
  const refreshQueue = useCallback(async () => {
    const inFlight = Array.from(pending.current.values(), (write) => write.done);
    flushPending("manual");
    await Promise.allSettled(inFlight);
    refresh();
  }, [flushPending, refresh]);

  /** «Tomar»: en curso + asignado a quien lo toma (FIX-1 · F9), optimista; el aviso ofrece «Deshacer». */
  async function take(item: Item) {
    const id = item.workOrderId;
    const ref = workOrderRef(id);
    const assignedTo = user?.fullName || user?.email || undefined;
    markBusy(id, true);
    try {
      await mutate(
        (prev) => withItem(prev, id, { status: "in_progress", assignedTo }),
        async (request) => {
          await request<unknown>(`/work-orders/${id}`, { method: "PATCH", body: assignedTo ? { status: "in_progress", assignedTo } : { status: "in_progress" } });
        }
      );
      const message = assignedTo ? MANT_TOASTS.taken(ref) : MANT_TOASTS.statusChanged(ref, woStatusLabel("in_progress"));
      showToast(message, { variant: "success", action: { label: MANT_ACTIONS.undo, onAction: () => untake(item) }, announce: message });
    } catch (error) {
      showToast(errorMessage(error, "No se pudo tomar el parte."), { variant: "error" });
    } finally {
      markBusy(id, false);
    }
  }

  /** Deshacer «Tomar»: PATCH inverso (abierta y sin asignar), también optimista (D7). */
  async function untake(item: Item) {
    const id = item.workOrderId;
    const ref = workOrderRef(id);
    markBusy(id, true);
    try {
      await mutate(
        (prev) => withItem(prev, id, { status: "open", assignedTo: undefined }),
        async (request) => {
          await request<unknown>(`/work-orders/${id}`, { method: "PATCH", body: { status: "open", assignedTo: null } });
        }
      );
      showToast(MANT_TOASTS.undone(ref), { variant: "info" });
    } catch (error) {
      showToast(errorMessage(error, "No se pudo deshacer."), { variant: "error" });
    } finally {
      markBusy(id, false);
    }
  }

  /** «Resuelta»: la tarjeta sale al instante; el POST /resolve viaja al agotar la ventana (o al salir / pagehide); «Deshacer» = nada viaja. */
  function resolve(item: Item): Promise<void> {
    const id = item.workOrderId;
    const ref = workOrderRef(id);
    pending.current.get(id)?.commit.flush();
    const commit = deferredCommit(RESOLVE_UNDO_MS);
    const message = item.blocksRoom && item.roomNumber ? MANT_TOASTS.resolvedRoomReleased(ref, item.roomNumber) : MANT_TOASTS.resolved(ref);
    showToast(message, {
      variant: "success",
      duration: RESOLVE_UNDO_MS,
      // El toast y la ventana corren en paralelo: pausar el toast (ratón o foco) no pausa la escritura (UX-3-REV-01).
      pauseOnHover: false,
      action: { label: MANT_ACTIONS.undo, onAction: () => void undoDeferred(commit, () => showToast(MANT_TOASTS.undoExpired(ref), { variant: "warning" })) },
      announce: message
    });
    const done = mutate(
      (prev) => withoutItem(prev, item),
      async (request) => {
        const go = await commit.wait();
        if (!go) throw new UndoneError();
        await request<unknown>(`/work-orders/${id}/resolve`, {
          method: "POST",
          body: { releaseRoom: item.blocksRoom },
          keepalive: commit.reason() === "pagehide"
        });
      }
    )
      .catch((error: unknown) => {
        if (error instanceof UndoneError) {
          showToast(MANT_TOASTS.undone(ref), { variant: "info" });
        } else {
          // R3: 409 «La orden ya está resuelta.» (otro dispositivo) → rollback de mutate + aviso, sin diálogo.
          showToast(errorMessage(error, "No se pudo resolver el parte."), { variant: "error" });
        }
      })
      .finally(() => {
        if (pending.current.get(id)?.commit === commit) pending.current.delete(id);
      });
    // «Actualizar» (refreshQueue) espera `done` antes de revalidar (UX-3-REV-02).
    pending.current.set(id, { commit, done });
    return done;
  }

  function openNote(item: Item) {
    setNote("");
    setNoteFor(item);
  }

  async function saveNote() {
    const item = noteFor;
    const text = note.trim();
    if (!item || !text) return;
    const id = item.workOrderId;
    const ref = workOrderRef(id);
    // Guarda como descripción anexada (concat con la existente).
    const description = item.description ? `${item.description}\n\n[${dateTime(new Date())}] ${text}` : text;
    markBusy(id, true);
    try {
      await mutate(
        (prev) => withItem(prev, id, { description }),
        async (request) => {
          await request<unknown>(`/work-orders/${id}`, { method: "PATCH", body: { description } });
        }
      );
      showToast(MANT_TOASTS.noteAdded(ref), { variant: "success" });
      setNoteFor(null);
      setNote("");
    } catch (error) {
      showToast(errorMessage(error, "No se pudo guardar la nota."), { variant: "error" });
    } finally {
      markBusy(id, false);
    }
  }

  const countLabel = plural(filtered.length, "avería", "averías");
  const emptyMessage =
    effectiveScope === "mine" && filter === "all"
      ? `No tienes partes asignados. Pulsa «${MANT_ACTIONS.all}» para ver la cola.`
      : filter === "all"
        ? "Todo en orden."
        : "No hay averías con esta prioridad.";

  // D9: con el dedo la lista va antes que la ayuda (la tarjeta baja al final).
  const help = (
    <CocoaScreenInstructionsCard
      title="Mis averías"
      description={MAINT_INSTRUCTIONS.whatIsThis}
      steps={[...MAINT_INSTRUCTIONS.howToUse]}
      tip={MAINT_INSTRUCTIONS.tips[0]}
      dismissible
      persistKey="maintenance"
    />
  );

  return (
    <CocoaPage
      eyebrow={`Mantenimiento · ${propertyName}`}
      title="Mis averías"
      subtitle={hosted ? undefined : "Averías del técnico: tómalas, resuélvelas y anota lo hecho desde el móvil."}
      density="operational"
      actions={
        <>
          {summary.blockedRooms > 0 ? (
            <CocoaBadge tone="danger" variant="tinted" icon={<LockIcon size={12} aria-hidden="true" />}>
              {plural(summary.blockedRooms, "habitación bloqueada", "habitaciones bloqueadas")}
            </CocoaBadge>
          ) : null}
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refreshQueue()} loading={refreshing}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<MaintenanceMobileSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: () => void refreshQueue() }}
      commands={[
        { id: "maintenance-mobile-refresh", label: "Actualizar mis averías", run: () => void refreshQueue() },
        { id: "maintenance-mobile-scope-mine", label: `Ver solo mis partes («${MANT_ACTIONS.mine}»)`, run: () => setScope("mine") },
        { id: "maintenance-mobile-scope-all", label: `Ver todos los partes («${MANT_ACTIONS.all}»)`, run: () => setScope("all") }
      ]}
    >
      {coarse ? null : help}

      <div className="cocoa-cluster">
        <span className="cocoa-cluster" role="group" aria-label="Mías o todas">
          {SCOPES.map((s) => {
            const active = effectiveScope === s.id;
            return (
              <CocoaButton
                key={s.id}
                size="small"
                variant={active ? "tinted" : "bordered"}
                tone={active ? "accent" : "neutral"}
                aria-pressed={active}
                onClick={() => setScope(s.id)}
              >
                {s.label} · {number(scopeCounts[s.id])}
              </CocoaButton>
            );
          })}
        </span>
        <span className="cocoa-cluster" role="group" aria-label="Filtrar por prioridad">
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
        </span>
      </div>

      {filtered.length === 0 ? (
        <CocoaSection aria-label="Sin averías">
          <CocoaState kind="empty" title="Sin averías" message={emptyMessage} illustration="success" />
        </CocoaSection>
      ) : (
        <CocoaKpiStrip min={320} aria-label="Averías">
          {filtered.map((item) => (
            <WorkOrderCard
              key={item.workOrderId}
              item={item}
              busy={busy[item.workOrderId] === true}
              onTake={() => void take(item)}
              onComplete={() => void resolve(item)}
              onNote={() => openNote(item)}
              onPhotos={() => setGalleryFor(item)}
            />
          ))}
        </CocoaKpiStrip>
      )}

      {coarse ? help : null}

      <CocoaActionBar
        mobileOnly={!coarse}
        publishToastOffset
        aria-label="Acciones de mis averías"
        status={dataAt ? `${countLabel} · datos a ${dataAt}` : countLabel}
        primary={{ label: ACTIONS.refresh, onClick: () => void refreshQueue(), loading: refreshing }}
      />

      <WorkOrderPhotosSheet item={galleryFor} onClose={() => setGalleryFor(null)} />

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
            <CocoaButton onClick={() => void saveNote()} loading={noteFor !== null && busy[noteFor.workOrderId] === true} disabled={!note.trim()}>
              Guardar nota
            </CocoaButton>
          </>
        }
      >
        <CocoaField label={MANT_ACTIONS.note} help="Se añade a la descripción de la avería con la fecha y la hora.">
          <CocoaInput id="maintenance-note" value={note} onChange={setNote} multiline rows={4} placeholder="Qué has visto o qué has hecho" />
        </CocoaField>
      </CocoaDrawer>
    </CocoaPage>
  );
}

function WorkOrderCard({ item, busy, onTake, onComplete, onNote, onPhotos }: { item: Item; busy: boolean; onTake: () => void; onComplete: () => void; onNote: () => void; onPhotos: () => void }) {
  const inProgress = item.status === "in_progress";

  return (
    <CocoaCard variant="bordered" style={cardStyle} role="group" aria-label={`Avería ${item.title}`}>
      <div className="cocoa-row" data-justify="between" data-align="start" data-wrap="nowrap">
        <div className="cocoa-row" data-gap="2" data-align="baseline">
          {item.roomNumber ? <strong style={roomNumberStyle}>{item.roomNumber}</strong> : null}
          {item.floor ? <span style={captionStyle}>Planta {item.floor}</span> : null}
        </div>
        <CocoaBadge tone={PRIORITY_TONE[item.priority]} variant="tinted">{priorityLabel(item.priority)}</CocoaBadge>
      </div>

      <strong style={titleStyle}>{item.title}</strong>

      <div className="cocoa-cluster">
        <CocoaBadge tone="neutral" size="small">{woStatusLabel(item.status)}</CocoaBadge>
        <CocoaBadge tone="neutral" size="small" uppercase={false} icon={<ClockIcon size={12} aria-hidden="true" />}>
          {fmtAge(item.ageMinutes)}
        </CocoaBadge>
        {item.blocksRoom ? <CocoaBadge tone="danger" variant="tinted" size="small">Bloquea la habitación</CocoaBadge> : null}
        {item.dueOverdue ? <CocoaBadge tone="warning" variant="tinted" size="small">SLA vencido</CocoaBadge> : null}
        {item.mediaCount > 0 ? (
          <CocoaButton size="small" variant="bordered" tone="neutral" aria-label={`Ver ${MANT_ACTIONS.photos(item.mediaCount)} del parte ${workOrderRef(item.workOrderId)}`} onClick={onPhotos}>
            {MANT_ACTIONS.photos(item.mediaCount)}
          </CocoaButton>
        ) : null}
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
            {MANT_ACTIONS.resolved}
          </CocoaButton>
        ) : (
          <CocoaButton size="large" loading={busy} onClick={onTake}>
            {MANT_ACTIONS.take}
          </CocoaButton>
        )}
        <CocoaButton size="large" variant="bordered" tone="neutral" disabled={busy} onClick={onNote}>
          {MANT_ACTIONS.note}
        </CocoaButton>
      </div>
    </CocoaCard>
  );
}

type GalleryPhoto = { meta: WorkOrderMediaMeta; url: string | null; error: string | null };
type GalleryState = { loading: boolean; error: string | null; photos: GalleryPhoto[] };

const GALLERY_IDLE: GalleryState = { loading: false, error: null, photos: [] };

/**
 * Galería de fotos del parte (P4, §4.4): CocoaSheet con las miniaturas. Los
 * metadatos llegan de GET /work-orders/:id/media y los bytes de cada foto en
 * línea de GET /work-orders/media/:mediaId con la sesión (`fetchWorkOrderMediaBlob`);
 * las object URLs viven hasta la siguiente carga o el desmontaje, así el cierre
 * animado no deja imágenes rotas. Una fila legacy sin bytes (`inline: false`)
 * se explica en vez de fallar.
 */
function WorkOrderPhotosSheet({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const workOrderId = item?.workOrderId ?? null;
  const [state, setState] = useState<GalleryState>(GALLERY_IDLE);
  const [title, setTitle] = useState("Fotos del parte");
  const urlsRef = useRef<string[]>([]);

  const releaseUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  useEffect(() => releaseUrls, [releaseUrls]);

  useEffect(() => {
    if (!workOrderId) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    releaseUrls();
    setTitle(`Fotos del parte ${workOrderRef(workOrderId)}`);
    setState({ loading: true, error: null, photos: [] });
    void (async () => {
      try {
        const metas = await listWorkOrderMedia(workOrderId);
        const photos = await Promise.all(
          metas.map(async (meta): Promise<GalleryPhoto> => {
            if (!meta.inline) return { meta, url: null, error: "Foto guardada fuera de línea: no se puede mostrar aquí." };
            try {
              const { blob } = await fetchWorkOrderMediaBlob(meta.id, { signal: controller.signal });
              const url = URL.createObjectURL(blob);
              urlsRef.current.push(url);
              return { meta, url, error: null };
            } catch (error) {
              return { meta, url: null, error: errorMessage(error, "No se pudo descargar la foto.") };
            }
          })
        );
        if (!cancelled) setState({ loading: false, error: null, photos });
      } catch (error) {
        if (!cancelled) setState({ loading: false, error: errorMessage(error, "No se pudieron cargar las fotos."), photos: [] });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workOrderId, releaseUrls]);

  const total = state.photos.length;

  return (
    <CocoaSheet
      open={item !== null}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <CocoaButton variant="bordered" tone="neutral" size="large" onClick={onClose}>
          {ACTIONS.close}
        </CocoaButton>
      }
    >
      {state.loading ? (
        <CocoaState kind="loading" title="Cargando las fotos…" />
      ) : state.error ? (
        <CocoaState kind="error" title="No se pudieron cargar las fotos" message={state.error} />
      ) : total === 0 ? (
        <CocoaState kind="empty" title="Sin fotos" message="Este parte no tiene fotos." />
      ) : (
        <div className="cocoa-stack" data-gap="4" role="list" aria-label="Fotos del parte">
          {state.photos.map((photo, index) => (
            <div key={photo.meta.id} role="listitem" className="cocoa-stack" data-gap="1">
              {photo.url ? (
                <img src={photo.url} alt={`Foto ${index + 1} de ${total}`} width="100%" />
              ) : (
                <CocoaBadge tone="warning" variant="tinted" size="small" uppercase={false}>
                  {photo.error}
                </CocoaBadge>
              )}
              <span className="cocoa-caption">
                Foto {number(index + 1)} de {number(total)} · {dateTime(photo.meta.createdAt)}
                {photo.meta.sizeBytes ? ` · ${formatFileSize(photo.meta.sizeBytes)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </CocoaSheet>
  );
}
