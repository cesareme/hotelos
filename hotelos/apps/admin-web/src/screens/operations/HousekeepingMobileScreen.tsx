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
//   - CocoaPage → section chips → priority filter chips (CocoaButton
//     aria-pressed with counts) → «Siguiente» card → one CocoaCard per room in
//     a CocoaKpiStrip auto-fit tier (min 320: three, two or one per row; never
//     a horizontal scroll).
//   - Room cards with the number in title-1, CocoaBadge states (no emoji,
//     §6) and up to four large CocoaButton actions: Iniciar · Limpia ·
//     Inspeccionada · Reportar (≥ 44 px tap targets on a coarse pointer).
//   - Reporting an incident opens a CocoaDrawer (bottom sheet on phones;
//     replaces the native prompt) that POSTs the same work order as before.
//   - CocoaActionBar keeps «Actualizar» and the data age under the thumb;
//     auto-refresh every 20 s reflects other housekeepers.
//
// Tanda UX-3 · P2 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.2, §5, §6;
// fricciones F1 F3 F5 F11 F12 F14; decisión D1):
//   - Chips de sección («Todas» + `sections[]` del API) antes de los de
//     prioridad; la elegida se recuerda por propiedad en localStorage (D8) y
//     al volver el grupo se titula «Mi sección».
//   - Tarjeta «Siguiente» arriba: la primera habitación de la lista filtrada
//     con su primario grande; el resto sigue en la rejilla.
//   - «Iniciar» · «Limpia» · «Inspeccionada» son optimistas (`mutate`) con
//     `busy` por habitación. «Limpia» e «Inspeccionada» abren un toast con
//     «Deshacer» 8 s y escritura DIFERIDA (`deferred-commit.ts`): deshacer =
//     nada viaja; la revalidación de 20 s queda pausada mientras la clave está
//     `mutating` (R2) y «Actualizar» vacía antes las pendientes; `pagehide`
//     las vacía con `keepalive`.
//   - «Limpia» cierra además la tarea abierta (PATCH /housekeeping/tasks/:id
//     { status: done } tras el POST de estado, D1); la tarjeta desaparece al
//     reconciliar.
//   - `density="operational"`; CocoaActionBar también en tablet (`mobileOnly`
//     solo con puntero fino); ayuda plegada bajo la lista con puntero grueso (D9).
//
// Corrector UX-3-REV (2026-09-20): el toast con «Deshacer» ya no se pausa con el
// ratón ni el foco (`pauseOnHover: false`: la ventana diferida no se pausaba) y
// un «Deshacer» tardío avisa «Habitación NNN ya enviada» (`undoDeferred`,
// REV-01); en `pagehide` el POST de estado y el PATCH que cierra la tarea viajan
// A LA VEZ con `keepalive` (tras la descarga no queda JS para el segundo,
// REV-03); con el dedo la ayuda plegada no es descartable (una tarjeta
// descartada dejaba el botón «Ayuda» muerto, REV-06); etiquetas de prioridad
// por `priorityLabel` (REV-07).
//
// Tanda UX-3 · P4 (diseño §4.2, §4.6; fricción F4): «Reportar» abre
// ReportIncidentDrawer (chips de motivo → título «Hab. 203: Fuga de agua», ≤ 3
// fotos comprimidas con la cámara trasera, detalle opcional, Enter envía) que
// crea el parte con `photos[]` (POST /work-orders, M1). Al volver, el aviso
// «Avería de la 203 enviada a mantenimiento · 1 foto» y la tarjeta suma una
// incidencia al instante (`mutate` optimista; la revalidación reconcilia).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useApiData, type MutateRequest } from "../../hooks/useApiData";
import { ApiError } from "../../services/api-client";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { HK_INSTRUCTIONS } from "../../content/screen-instructions/housekeeping";
import { useTabHost } from "../tabs/TabHost";
import { number, plural, time } from "../../lib/format";
import { useCoarsePointer } from "../../lib/useCoarsePointer";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { PISOS_ACTIONS, PISOS_TOASTS } from "../../content/pisos-actions";
import { roomStatus } from "../../content/status-dictionary";
import { ChatBubbleIcon, StarIcon } from "../../components/cocoa-icons/StatusIcons";
import { deferredCommit, undoDeferred, type DeferredFlushReason } from "./deferred-commit";
import { priorityLabel } from "./operations-director-labels";
import { ReportIncidentDrawer, type ReportIncidentResult } from "./ReportIncidentDrawer";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
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
  sectionId?: string;
  sectionName?: string;
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

type HkSection = { id: string; name: string; code?: string; total: number };

type HkData = {
  generatedAt: string;
  summary: { urgent: number; high: number; normal: number; low: number; total: number };
  rooms: HkRoom[];
  sections?: HkSection[];
};

type Filter = Priority | "all";

// Tonos de la prioridad (los textos salen de priorityLabel, P6: 0 mapas locales de etiquetas).
const PRIORITY_TONE: Record<Priority, CocoaTone> = { urgent: "danger", high: "warning", normal: "info", low: "neutral" };

// El estado de limpieza (clean | dirty | inspected) se etiqueta con el
// diccionario común (UX-1 · U2, D5); «En limpieza» es el estado de la TAREA.
const CLEANING_IN_PROGRESS_LABEL = "En limpieza";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todo" },
  { id: "urgent", label: priorityLabel("urgent") },
  { id: "high", label: priorityLabel("high") },
  { id: "normal", label: priorityLabel("normal") },
  { id: "low", label: priorityLabel("low") }
];

/** Ventana de «Deshacer» de las escrituras diferidas (§5: 8 s, la duración del toast con acción). */
const UNDO_MS = 8000;

/** Chip «Todas» de sección (valor interno del filtro). */
const ALL_SECTIONS = "all";

// Sección recordada por propiedad (D8): localStorage con try/catch (modo
// privado, cuota); sin almacenamiento, la sección se pierde al recargar y nada más.
const SECTION_STORAGE_PREFIX = "hotelos.pisos.mi-turno.section:";

function sectionStorageKey(propertyId: string): string {
  return `${SECTION_STORAGE_PREFIX}${propertyId}`;
}

function readRememberedSection(propertyId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(sectionStorageKey(propertyId));
  } catch {
    return null;
  }
}

function rememberSection(propertyId: string, sectionId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (sectionId) window.localStorage.setItem(sectionStorageKey(propertyId), sectionId);
    else window.localStorage.removeItem(sectionStorageKey(propertyId));
  } catch {
    // Sin almacenamiento: el chip funciona igual durante la sesión.
  }
}

/** Sección efectiva: la recordada solo si sigue existiendo en `sections[]` (una sección borrada vuelve a «Todas»). */
function effectiveSection(section: string, sections: readonly HkSection[]): string {
  if (section === ALL_SECTIONS) return ALL_SECTIONS;
  return sections.some((s) => s.id === section) ? section : ALL_SECTIONS;
}

/** Recuento de los chips de prioridad sobre la sección elegida. */
function countByPriority(rooms: readonly HkRoom[]): Record<Filter, number> {
  const counts: Record<Filter, number> = { all: rooms.length, urgent: 0, high: 0, normal: 0, low: 0 };
  for (const room of rooms) if (counts[room.priority] !== undefined) counts[room.priority] += 1;
  return counts;
}

/** Copia de `data` con la habitación parcheada (actualización optimista de `mutate`). */
function patchRoom(prev: HkData, roomId: string, patch: Partial<HkRoom>): HkData {
  return { ...prev, rooms: toArray<HkRoom>(prev.rooms).map((room) => (room.roomId === roomId ? { ...room, ...patch } : room)) };
}

type PendingWrite = { commit: ReturnType<typeof deferredCommit>; done: Promise<void> };

type CardAction = { key: string; label: string; onClick: () => void; primary: boolean };

// Las escrituras viajan por el `request` guardado de useApiData.mutate (JWT de
// sesión, auditadas como la camarera; Tanda 3 · CF-05). Solo el mensaje en
// español del sobre de error del API (ApiError) se enseña tal cual; un fallo de
// red o de código muestra el texto genérico, nunca «Failed to fetch».
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
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
  const coarse = useCoarsePointer();
  const { showToast } = useToast();
  const { data, loading, error, refresh, mutate } = useApiData<HkData>(
    `/dashboards/housekeeping-mobile?propertyId=${propertyId}`,
    { pollIntervalMs: 20000 }
  );
  const [section, setSection] = useState<string>(() => readRememberedSection(propertyId) ?? ALL_SECTIONS);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [helpOpen, setHelpOpen] = useState(false);
  const [reportFor, setReportFor] = useState<HkRoom | null>(null);
  // Una escritura diferida por habitación (§5): la segunda acción sobre la misma vacía la anterior.
  const pendingByRoom = useRef(new Map<string, PendingWrite>());

  const rooms = toArray<HkRoom>(data?.rooms);
  const sections = toArray<HkSection>(data?.sections);
  const activeSection = effectiveSection(section, sections);
  const inSection = activeSection === ALL_SECTIONS ? rooms : rooms.filter((r) => r.sectionId === activeSection);
  const filtered = filter === "all" ? inSection : inSection.filter((r) => r.priority === filter);
  const counts = countByPriority(inSection);
  const next = filtered[0];
  const rest = filtered.slice(1);
  const dataAt = data?.generatedAt ? time(data.generatedAt) : null;
  const refreshing = loading && rooms.length > 0;

  const setRoomBusy = useCallback((roomId: string, on: boolean) => {
    setBusy((prev) => {
      if (prev.has(roomId) === on) return prev;
      const nextSet = new Set(prev);
      if (on) nextSet.add(roomId);
      else nextSet.delete(roomId);
      return nextSet;
    });
  }, []);

  // Las escrituras diferidas viajan al salir de la pantalla (o al cerrar la
  // pestaña, sin esperar los 8 s; con `keepalive` en pagehide), como los cargos
  // con deshacer de la ficha de reserva (UX-1 · U7).
  const flushPending = useCallback((reason: DeferredFlushReason = "manual") => {
    for (const pending of pendingByRoom.current.values()) pending.commit.flush(reason);
  }, []);
  useEffect(() => {
    const onPageHide = () => flushPending("pagehide");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushPending("manual");
    };
  }, [flushPending]);

  /** «Actualizar»: vacía las escrituras diferidas y espera a que lleguen antes de pedir la lista (R2). */
  const refreshTurn = useCallback(async () => {
    const inFlight = Array.from(pendingByRoom.current.values(), (pending) => pending.done);
    flushPending("manual");
    await Promise.allSettled(inFlight);
    refresh();
  }, [flushPending, refresh]);

  function chooseSection(id: string) {
    setSection(id);
    rememberSection(propertyId, id === ALL_SECTIONS ? null : id);
  }

  /**
   * Escritura optimista con «Deshacer» 8 s (§5, D7): el cambio se pinta al
   * instante, el toast ofrece deshacer y la petición viaja solo al agotar la
   * ventana, al vaciar (Actualizar, salir de la pantalla) o en `pagehide`
   * (`keepalive`). Deshacer aplica el estado anterior sobre la caché ACTUAL
   * (no un rollback al snapshot: otra habitación puede tener su propia ventana
   * abierta) y la clave se revalida al terminar.
   */
  function deferredRoomWrite(
    room: HkRoom,
    input: { optimistic: Partial<HkRoom>; toast: string; write: (request: MutateRequest, keepalive: boolean) => Promise<void> }
  ): Promise<void> {
    pendingByRoom.current.get(room.roomId)?.commit.flush("manual");
    const pending = deferredCommit(UNDO_MS);
    const revert: Partial<HkRoom> = { housekeepingStatus: room.housekeepingStatus, taskStatus: room.taskStatus };
    showToast(input.toast, {
      variant: "success",
      // El toast y la ventana corren en paralelo: pausar el toast (ratón o foco) no pausa la escritura (UX-3-REV-01).
      pauseOnHover: false,
      action: { label: PISOS_ACTIONS.undo, onAction: () => void undoDeferred(pending, () => showToast(PISOS_TOASTS.undoExpired(room.roomNumber), { variant: "warning" })) },
      announce: input.toast
    });
    const done = mutate(
      (prev) => patchRoom(prev, room.roomId, input.optimistic),
      async (request) => {
        const go = await pending.wait();
        if (!go) {
          await mutate((prev) => patchRoom(prev, room.roomId, revert), async () => undefined);
          showToast(PISOS_TOASTS.undone(room.roomNumber), { variant: "info" });
          return;
        }
        setRoomBusy(room.roomId, true);
        try {
          await input.write(request, pending.reason() === "pagehide");
        } finally {
          setRoomBusy(room.roomId, false);
        }
      }
    )
      .catch((error: unknown) => {
        showToast(errorMessage(error, "No se pudo actualizar el estado"), { variant: "error" });
      })
      .finally(() => {
        if (pendingByRoom.current.get(room.roomId)?.commit === pending) pendingByRoom.current.delete(room.roomId);
      });
    pendingByRoom.current.set(room.roomId, { commit: pending, done });
    return done;
  }

  /** «Limpia»: optimista + deshacer; cierra además la tarea abierta (D1, INT-L5-04) y la tarjeta desaparece al reconciliar. */
  function markClean(room: HkRoom) {
    const closesTask = Boolean(room.taskId) && room.taskStatus !== "done";
    const n = room.roomNumber;
    void deferredRoomWrite(room, {
      // mark-clean no degrada una inspeccionada (room-state.service.ts); la tarea cerrada deja de listarse al reconciliar.
      optimistic: { housekeepingStatus: room.housekeepingStatus === "inspected" ? "inspected" : "clean", ...(closesTask ? { taskStatus: "done" } : {}) },
      toast: closesTask ? PISOS_TOASTS.hkCleanTaskClosed(n) : PISOS_TOASTS.hkClean(n),
      write: async (request, keepalive) => {
        const markRoom = () => request<unknown>(`/rooms/${encodeURIComponent(room.roomId)}/housekeeping-status`, { method: "POST", body: { status: "clean" }, keepalive });
        if (!closesTask || !room.taskId) {
          await markRoom();
          return;
        }
        const taskId = room.taskId;
        const closeTask = () => request<unknown>(`/housekeeping/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: { status: "done" }, keepalive });
        // D1: si el cierre falla, la habitación sigue limpia y se avisa (honestidad, P7).
        const taskStillOpen = (error: unknown) => `Hab. ${n} limpia, pero la tarea sigue abierta: ${errorMessage(error, "no se pudo cerrar")}`;
        if (keepalive) {
          // pagehide (UX-3-REV-03): tras la descarga no queda JS para una segunda petición, así que estado y tarea viajan
          // A LA VEZ con keepalive (recursos independientes: el PATCH de la tarea no toca la habitación).
          const [state, task] = await Promise.allSettled([markRoom(), closeTask()]);
          if (state.status === "rejected") throw state.reason;
          if (task.status === "rejected") showToast(taskStillOpen(task.reason), { variant: "warning" });
          return;
        }
        await markRoom();
        try {
          await closeTask();
        } catch (error) {
          showToast(taskStillOpen(error), { variant: "warning" });
        }
      }
    });
  }

  /** «Inspeccionada»: optimista + deshacer diferido (no existe «desinspeccionar» en el API, D7). */
  function markInspected(room: HkRoom) {
    void deferredRoomWrite(room, {
      optimistic: { housekeepingStatus: "inspected" },
      toast: PISOS_TOASTS.hkInspected(room.roomNumber),
      write: async (request, keepalive) => {
        await request<unknown>(`/rooms/${encodeURIComponent(room.roomId)}/housekeeping-status`, { method: "POST", body: { status: "inspected" }, keepalive });
      }
    });
  }

  // Tanda L5 (estado unificado): «en limpieza» es el estado de la TAREA, no un
  // valor de limpieza (in_progress ya no se almacena en la habitación). Iniciar
  // arranca la tarea abierta; sin tarea, deja la habitación como sucia (auditado).
  /** «Iniciar»: optimista sin deshacer (§5: se revierte pulsando «Limpia»); busy por habitación mientras viaja. */
  async function startCleaning(room: HkRoom) {
    setRoomBusy(room.roomId, true);
    showToast(PISOS_TOASTS.cleaningStarted(room.roomNumber), { variant: "success" });
    try {
      await mutate(
        (prev) => patchRoom(prev, room.roomId, room.taskId ? { taskStatus: "in_progress" } : { housekeepingStatus: "dirty" }),
        async (request) => {
          if (room.taskId) await request<unknown>(`/housekeeping/tasks/${encodeURIComponent(room.taskId)}`, { method: "PATCH", body: { status: "in_progress" } });
          else await request<unknown>(`/rooms/${encodeURIComponent(room.roomId)}/housekeeping-status`, { method: "POST", body: { status: "dirty" } });
        }
      );
    } catch (error) {
      showToast(errorMessage(error, "No se pudo iniciar la limpieza"), { variant: "error" });
    } finally {
      setRoomBusy(room.roomId, false);
    }
  }

  function openReport(room: HkRoom) {
    setReportFor(room);
  }

  /** El parte ya existe (P4): aviso con número y fotos, cierre del cajón y «+1 incidencia» optimista en la tarjeta (la revalidación reconcilia). */
  function reportSent(result: ReportIncidentResult) {
    const n = result.room.roomNumber;
    const message = PISOS_TOASTS.incidentReported(n, result.photos);
    setReportFor(null);
    showToast(message, { variant: "success", announce: message });
    void mutate(
      (prev) => patchRoom(prev, result.room.roomId, { openIncidents: (toArray<HkRoom>(prev.rooms).find((r) => r.roomId === result.room.roomId)?.openIncidents ?? 0) + 1 }),
      async () => undefined
    ).catch(() => undefined);
  }

  const countLabel = plural(filtered.length, "habitación", "habitaciones");
  const emptyMessage =
    filter !== "all" ? "No hay habitaciones en esta prioridad." : activeSection !== ALL_SECTIONS ? "No hay habitaciones pendientes en esta sección." : "Todas las habitaciones están listas.";

  // La ayuda va ANTES de la lista con ratón y plegada DEBAJO con el dedo (D9, F12):
  // CocoaScreenInstructionsCard no tiene prop «plegada», así que la pantalla la
  // pinta solo al abrirla. Con ratón sigue `dismissible` + `persistKey`; con el
  // dedo el plegado ya la esconde y NO se descarta: una tarjeta descartada (la X
  // con ratón en el mismo navegador) dejaba el botón «Ayuda» muerto (UX-3-REV-06).
  const help = (
    <CocoaScreenInstructionsCard
      title="Housekeeping"
      description={HK_INSTRUCTIONS.whatIsThis}
      steps={HK_INSTRUCTIONS.howToUse}
      tip={HK_INSTRUCTIONS.tips?.[0]}
      dismissible={!coarse}
      persistKey={coarse ? undefined : "housekeeping"}
    />
  );

  const commands = [
    { id: "housekeeping-mobile-refresh", label: "Actualizar mi turno", run: () => void refreshTurn() },
    { id: "housekeeping-mobile-section-all", label: `Sección: ${PISOS_ACTIONS.allSections}`, run: () => chooseSection(ALL_SECTIONS) },
    ...sections.map((s) => ({ id: `housekeeping-mobile-section-${s.id}`, label: `Sección: ${s.name}`, run: () => chooseSection(s.id) }))
  ];

  return (
    <CocoaPage
      eyebrow={`Pisos · ${propertyName}`}
      title="Mi turno"
      subtitle={hosted ? undefined : "Habitaciones de tu sección por prioridad: la siguiente arriba; inicia, marca limpia, inspecciona y reporta incidencias."}
      actions={
        <>
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refreshTurn()} loading={refreshing}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<HousekeepingMobileSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      density="operational"
      commands={commands}
    >
      {!coarse ? help : null}

      {sections.length > 0 ? (
        <div className="cocoa-cluster" role="group" aria-label="Filtrar por sección">
          <span className="cocoa-caption">{activeSection === ALL_SECTIONS ? "Sección" : PISOS_ACTIONS.mySection}</span>
          <CocoaButton
            size="small"
            variant={activeSection === ALL_SECTIONS ? "tinted" : "bordered"}
            tone={activeSection === ALL_SECTIONS ? "accent" : "neutral"}
            aria-pressed={activeSection === ALL_SECTIONS}
            onClick={() => chooseSection(ALL_SECTIONS)}
          >
            {PISOS_ACTIONS.allSections} · {number(rooms.length)}
          </CocoaButton>
          {sections.map((s) => {
            const active = activeSection === s.id;
            return (
              <CocoaButton
                key={s.id}
                size="small"
                variant={active ? "tinted" : "bordered"}
                tone={active ? "accent" : "neutral"}
                aria-pressed={active}
                onClick={() => chooseSection(s.id)}
              >
                {s.name} · {number(s.total)}
              </CocoaButton>
            );
          })}
        </div>
      ) : null}

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

      {!next ? (
        <CocoaSection aria-label="Sin pendientes">
          <CocoaState kind="empty" title="Sin pendientes" message={emptyMessage} illustration="success" />
        </CocoaSection>
      ) : (
        <>
          <CocoaSection variant="plain" padding="none" title={PISOS_ACTIONS.next} meta={countLabel}>
            <RoomCard
              key={next.roomId}
              room={next}
              next
              showSection={activeSection === ALL_SECTIONS}
              busy={busy.has(next.roomId)}
              onStart={() => void startCleaning(next)}
              onComplete={() => markClean(next)}
              onInspect={() => markInspected(next)}
              onReport={() => openReport(next)}
            />
          </CocoaSection>
          {rest.length > 0 ? (
            <CocoaKpiStrip min={320} aria-label="Habitaciones del turno">
              {rest.map((room) => (
                <RoomCard
                  key={room.roomId}
                  room={room}
                  showSection={activeSection === ALL_SECTIONS}
                  busy={busy.has(room.roomId)}
                  onStart={() => void startCleaning(room)}
                  onComplete={() => markClean(room)}
                  onInspect={() => markInspected(room)}
                  onReport={() => openReport(room)}
                />
              ))}
            </CocoaKpiStrip>
          ) : null}
        </>
      )}

      {coarse ? (
        <div className="cocoa-stack" data-gap="2">
          <CocoaButton
            variant="plain"
            tone="neutral"
            aria-expanded={helpOpen}
            aria-controls={helpOpen ? "housekeeping-help" : undefined}
            onClick={() => setHelpOpen((open) => !open)}
          >
            {ACTIONS.help}: Mi turno
          </CocoaButton>
          {helpOpen ? <div id="housekeeping-help">{help}</div> : null}
        </div>
      ) : null}

      <CocoaActionBar
        mobileOnly={!coarse}
        publishToastOffset
        aria-label="Acciones de mi turno"
        status={dataAt ? `${countLabel} · datos a ${dataAt}` : countLabel}
        primary={{ label: ACTIONS.refresh, onClick: () => void refreshTurn(), loading: refreshing }}
      />

      <ReportIncidentDrawer room={reportFor ? { roomId: reportFor.roomId, roomNumber: reportFor.roomNumber } : null} onClose={() => setReportFor(null)} onReported={reportSent} />
    </CocoaPage>
  );
}

function RoomCard({
  room,
  busy,
  next = false,
  showSection = true,
  onStart,
  onComplete,
  onInspect,
  onReport
}: {
  room: HkRoom;
  busy: boolean;
  /** Tarjeta «Siguiente» (§4.2): elevada y con el primario en su propia fila, grande. */
  next?: boolean;
  /** Pinta la sección junto a la planta (solo con «Todas»: con una sección activa todas las tarjetas son de ella). */
  showSection?: boolean;
  onStart: () => void;
  onComplete: () => void;
  onInspect: () => void;
  onReport: () => void;
}) {
  // Tanda L5 (estado unificado): la limpieza es `housekeepingStatus` (dirty |
  // clean | inspected, siempre presente); «en limpieza» es el estado de la tarea,
  // ya no un valor de limpieza; sin «ready» ni fallback a `status`.
  const hk = (room.housekeepingStatus ?? "").toLowerCase();
  const isInProgress = room.taskStatus === "in_progress";
  const isInspected = hk === "inspected";
  const isClean = hk === "clean" || isInspected;
  const hkStatus = hk ? roomStatus(hk) : null;

  // UN primario por tarjeta según el estado (P1): sucia → «Iniciar»; en limpieza →
  // «Limpia»; limpia → «Inspeccionada»; inspeccionada → solo «Reportar».
  const actions: CardAction[] = [];
  if (!isInProgress && !isClean) actions.push({ key: "start", label: PISOS_ACTIONS.startCleaning, onClick: onStart, primary: true });
  if (!isInspected) actions.push({ key: "clean", label: PISOS_ACTIONS.clean, onClick: onComplete, primary: isInProgress });
  if ((isClean || isInProgress) && !isInspected) actions.push({ key: "inspect", label: PISOS_ACTIONS.inspected, onClick: onInspect, primary: isClean && !isInProgress });
  const primary = next ? actions.find((a) => a.primary) : undefined;
  const gridActions = primary ? actions.filter((a) => a !== primary) : actions;
  const grid = (
    <div style={actionsStyle}>
      {gridActions.map((a) => (
        <CocoaButton key={a.key} size="large" variant={a.primary ? "filled" : "bordered"} tone={a.primary ? "accent" : "neutral"} loading={busy} onClick={a.onClick}>
          {a.label}
        </CocoaButton>
      ))}
      <CocoaButton size="large" variant="bordered" tone="neutral" disabled={busy} onClick={onReport} style={gridActions.length === 0 ? fullRowStyle : undefined}>
        {PISOS_ACTIONS.report}
      </CocoaButton>
    </div>
  );

  return (
    <CocoaCard variant={next ? "elevated" : "bordered"} style={cardStyle} role="group" aria-label={`Habitación ${room.roomNumber}`}>
      <div className="cocoa-row" data-justify="between" data-align="start" data-wrap="nowrap">
        <div className="cocoa-row" data-gap="2" data-align="baseline">
          <strong style={roomNumberStyle}>{room.roomNumber}</strong>
          <span style={captionStyle}>
            Planta {room.floor ?? "—"}
            {showSection && room.sectionName && room.sectionName !== `Planta ${room.floor ?? ""}` ? ` · ${room.sectionName}` : ""}
          </span>
        </div>
        {/* «Baja» en outline: el borde tinted-neutral en oscuro mide 1,35:1 (< 3:1, 1.4.11; hallazgo U0 del proyecto touch). */}
        <CocoaBadge tone={PRIORITY_TONE[room.priority]} variant={room.priority === "low" ? "outline" : "tinted"}>{priorityLabel(room.priority)}</CocoaBadge>
      </div>

      <div className="cocoa-cluster">
        {hkStatus ? <CocoaStatusBadge entry={hkStatus} dense /> : null}
        {room.roomTypeName ? <CocoaBadge tone="neutral" size="small" uppercase={false}>{room.roomTypeName}</CocoaBadge> : null}
        {room.openIncidents > 0 ? (
          <CocoaBadge tone="danger" variant="tinted" size="small" uppercase={false}>
            {plural(room.openIncidents, "incidencia", "incidencias")}
          </CocoaBadge>
        ) : null}
        {isInProgress ? <CocoaBadge tone="info" size="small">{CLEANING_IN_PROGRESS_LABEL}</CocoaBadge> : null}
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
        {room.currentGuest ? <span>En el hotel: {room.currentGuest}</span> : null}
        {room.specialRequest ? (
          <CocoaCallout tone="info" icon={<ChatBubbleIcon size={14} />}>
            {room.specialRequest}
          </CocoaCallout>
        ) : null}
        {room.lastEventNote ? <span style={captionStyle}>Última nota: {room.lastEventNote}</span> : null}
      </div>

      {primary ? (
        <div className="cocoa-stack" data-gap="2">
          <CocoaButton size="large" loading={busy} onClick={primary.onClick}>
            {primary.label}
          </CocoaButton>
          {grid}
        </div>
      ) : (
        grid
      )}
    </CocoaCard>
  );
}
