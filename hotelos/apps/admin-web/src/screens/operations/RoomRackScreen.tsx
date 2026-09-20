// Tablero de habitaciones — Recepción › Reservas › Tablero (/recepcion/reservas/tablero).
//
// Cocoa 22 · ola 3 · lote 3-A (dashboard archetype, template DashboardAlojado):
// CocoaPage → CocoaKpiStrip (ocupadas, listas, sucias, fuera de servicio,
// llegadas y salidas de hoy) → CocoaToolbar (búsqueda, planta) + chips de
// estado → una CocoaSection por planta con cada habitación como CocoaCard
// interactiva (número, estado con barra de tono, huésped actual o próxima
// llegada, avisos como CocoaBadge: nada enterrado, nada en emoji) →
// CocoaDrawer con el detalle y las acciones rápidas (check-in / check-out
// abren los drawers de Hoy; limpieza y bloqueo van al API) → toasts por
// useToast. Same endpoint (/dashboards/room-rack) and 30 s polling as before;
// hosted inside ReservasTabs the container paints the title.
//
// Tanda UX-1 · U10 (§7.2 «Tablero»): los tiles van en `.c22-tile-grid`
// (cocoa-22-layout.css: minmax 150 → 160 px con el dedo) y los chips de
// leyenda son CocoaButton (objetivo ≥ 24 px con ratón, 44 con el dedo) con un
// CocoaStatusBadge `dot` del diccionario dentro: punto en el tono + icono +
// etiqueta, sin cuadrado de 10 px pintado a mano.
//
// Tanda UX-3 · P1 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.5, §5; solo
// el cajón de la casilla): «Marcar limpia» / «Marcar sucia» / «Inspeccionada»
// son optimistas sobre el rack (`useApiData.mutate`) con toast con número y
// «Deshacer» (limpia e inspeccionada con escritura DIFERIDA 8 s,
// deferred-commit.ts: deshacer = no se envía; sucia con POST inverso).
// «Bloquear habitación» abre un CocoaDialog nominal («Bloquear la 305» /
// «Mantenerla en venta», destructivo); «Desbloquear habitación» es directo con
// «Habitación 305 desbloqueada.» y «Deshacer» (vuelve a bloquear). `busy` POR
// casilla. La recepción (tiles, filtros, check-in/out) no cambia.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { QuickCheckInDrawer } from "./QuickCheckInDrawer";
import { QuickCheckOutDrawer } from "./QuickCheckOutDrawer";
import { floorKey, floorTitle } from "./room-rack-labels";
import { deferredCommit, undoDeferred, type DeferredFlushReason } from "./deferred-commit";
import { HK_UNDO_MS } from "./housekeeping-task-actions";
import { useTabHost } from "../tabs/TabHost";
import { useToast } from "../../components/Toast";
import { date, money, number, plural, time } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { PISOS_ACTIONS, PISOS_TOASTS } from "../../content/pisos-actions";
import {
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaDialog,
  CocoaDrawer,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaToolbar,
  toneColor,
  type CocoaTone
} from "../../components/cocoa";
import { BAR_KIND, RESERVATION_STATUS, ROOM_STATUS, roomStatus, type StatusEntry } from "../../content/status-dictionary";

// ============================================================== types

type Badge = "vip" | "balance_due" | "special_request" | "hk_urgent" | "overbooking" | "incident" | "late_checkout" | "early_checkin" | "vacant_due_soon";

type Occupancy =
  | "vacant_clean"
  | "vacant_dirty"
  | "occupied_stay"
  | "occupied_departing_today"
  | "checked_out_today"
  | "out_of_order"
  | "blocked_maintenance";

type Reservation = {
  reservationId: string;
  guestName: string;
  guestId?: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  eta?: string;
  etd?: string;
  balanceDue: number;
  vip: boolean;
  loyaltyTier?: string;
  specialRequest?: string;
};

type Tile = {
  roomId: string;
  roomNumber: string;
  floor?: string;
  roomTypeId?: string;
  roomTypeName?: string;
  status: string;
  housekeepingStatus?: string;
  occupancy: Occupancy;
  badges: Badge[];
  currentReservation?: Reservation;
  nextArrival?: Reservation;
};

// Raw group of the API: `floor` is "" on Rías Altas, «Planta 1» on Los Tilos
// and "—" when the column is null.
type Floor = { floor: string; rooms: Tile[] };
// Normalised group painted by the board (fix:3-A qa#11): a non-empty key for
// the filter and a title that never reads «Planta » or «Planta Planta 1».
type FloorGroup = { key: string; title: string; rooms: Tile[] };

type RackData = {
  propertyId: string;
  generatedAt: string;
  floors: Floor[];
  totals: {
    rooms: number;
    occupied: number;
    vacantClean: number;
    vacantDirty: number;
    outOfOrder: number;
    arrivalsToday: number;
    departuresToday: number;
  };
};

/** Limpieza que escribe el cajón (vocabulario cerrado de /rooms/:id/housekeeping-status). */
type HkWrite = "clean" | "dirty" | "inspected";

// ============================================================== display

// Ocupación del tile → entrada del diccionario común (UX-1 · U2, D5): la
// etiqueta, el tono y el icono son los mismos que en Mi día, la lista, la
// ficha y el Live Timeline.
const OCCUPANCY_META: Record<Occupancy, StatusEntry> = {
  vacant_clean: ROOM_STATUS.clean,
  vacant_dirty: ROOM_STATUS.dirty,
  occupied_stay: ROOM_STATUS.occupied,
  occupied_departing_today: BAR_KIND.departure_today,
  checked_out_today: RESERVATION_STATUS.checked_out,
  out_of_order: ROOM_STATUS.out_of_order,
  blocked_maintenance: ROOM_STATUS.blocked
};
const OCCUPANCIES = Object.keys(OCCUPANCY_META) as Occupancy[];

const BADGE_META: Record<Badge, { short: string; title: string; tone: CocoaTone }> = {
  vip: { short: "VIP", title: "Huésped VIP", tone: "accent" },
  balance_due: { short: "Saldo", title: "Saldo pendiente", tone: "warning" },
  special_request: { short: "Petición", title: "Petición especial", tone: "info" },
  hk_urgent: { short: "Limpieza urgente", title: "Limpieza urgente (llega en menos de 2 h)", tone: "danger" },
  overbooking: { short: "Conflicto", title: "Conflicto de reserva", tone: "danger" },
  incident: { short: "Incidencia", title: "Incidencia abierta", tone: "warning" },
  late_checkout: { short: "Late check-out", title: "Late check-out", tone: "neutral" },
  early_checkin: { short: "Early check-in", title: "Early check-in", tone: "neutral" },
  vacant_due_soon: { short: "Llega hoy", title: "Llegada hoy", tone: "info" }
};

const EMPTY_TOTALS: RackData["totals"] = { rooms: 0, occupied: 0, vacantClean: 0, vacantDirty: 0, outOfOrder: 0, arrivalsToday: 0, departuresToday: 0 };

// ============================================================== styles (tokens only)

function toneBarStyle(tone: CocoaTone): CSSProperties {
  return { display: "block", height: 3, borderRadius: "var(--cocoa-radius-full)", background: toneColor(tone) };
}

const roomNumberStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-title-2)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  lineHeight: "var(--cocoa-lh-title-2)",
  fontVariantNumeric: "tabular-nums"
};

const tileLineStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0
};

const mutedStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-callout)", color: "var(--cocoa-label-secondary)" };

// ============================================================== helpers

// SECURITY (auditoría 2026-07): antes era `fetch` crudo sin Authorization → 401
// en producción. Las escrituras van por el `request` vigilado de
// `useApiData.mutate` (apiRequest: JWT + manejo de sesión + `keepalive`).
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "No se pudo completar la acción.");

// Reglas puras del rack optimista (UX-3 · P1): la casilla cambia al instante y
// los totales se recuentan a partir de los tiles; la revalidación tras la
// escritura trae la verdad del API.
function isVacant(tile: Tile): boolean {
  return tile.occupancy === "vacant_clean" || tile.occupancy === "vacant_dirty";
}

/** Casilla con otra limpieza: una libre espeja el estado (limpia/inspeccionada → «Limpia», sucia → «Sucia»); una ocupada o bloqueada conserva su ocupación. */
function tileWithHousekeeping(tile: Tile, housekeeping: HkWrite): Tile {
  const vacant = isVacant(tile);
  const occupancy: Occupancy = vacant ? (housekeeping === "dirty" ? "vacant_dirty" : "vacant_clean") : tile.occupancy;
  return { ...tile, housekeepingStatus: housekeeping, status: vacant ? housekeeping : tile.status, occupancy };
}

/** Casilla bloqueada (no vendible → fuera de servicio) o de vuelta al inventario con su limpieza. */
function tileWithSellable(tile: Tile, sellable: boolean): Tile {
  if (!sellable) return { ...tile, occupancy: "out_of_order", status: "out_of_service" };
  const housekeeping = tile.housekeepingStatus ?? "dirty";
  return { ...tile, occupancy: housekeeping === "dirty" ? "vacant_dirty" : "vacant_clean", status: housekeeping };
}

function recountTotals(totals: RackData["totals"], floors: Floor[]): RackData["totals"] {
  const tiles = floors.flatMap((f) => f.rooms);
  const count = (...kinds: Occupancy[]) => tiles.filter((t) => kinds.includes(t.occupancy)).length;
  return { ...totals, vacantClean: count("vacant_clean"), vacantDirty: count("vacant_dirty"), outOfOrder: count("out_of_order", "blocked_maintenance") };
}

/** Rack con la casilla `roomId` transformada y los totales recontados (las demás casillas, intactas). */
function rackWithTile(prev: RackData, roomId: string, update: (tile: Tile) => Tile): RackData {
  const floors = prev.floors.map((f) => ({ ...f, rooms: f.rooms.map((r) => (r.roomId === roomId ? update(r) : r)) }));
  return { ...prev, floors, totals: recountTotals(prev.totals ?? EMPTY_TOTALS, floors) };
}

function RackSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[12], [12]]} height={200} />
    </div>
  );
}

// ============================================================== component

export function RoomRackScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const propertyId = getActivePropertyId();
  const { data, loading, error, refresh, mutate } = useApiData<RackData>(`/dashboards/room-rack?propertyId=${propertyId}`, { pollIntervalMs: 30000 });

  const [filterOcc, setFilterOcc] = useState<Set<Occupancy>>(new Set());
  const [filterFloor, setFilterFloor] = useState<string | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [checkInResId, setCheckInResId] = useState<string | null>(null);
  const [checkOutResId, setCheckOutResId] = useState<string | null>(null);
  // Ocupado POR casilla (F1): solo la habitación cuya petición está en vuelo se apaga.
  const [busyRooms, setBusyRooms] = useState<ReadonlySet<string>>(() => new Set());
  // Diálogo nominal de bloqueo (F8): la casilla que se va a bloquear.
  const [blockPrompt, setBlockPrompt] = useState<Tile | null>(null);

  // Escrituras diferidas con deshacer (§5): una ventana por casilla; se vacían
  // al ocultar la página (`keepalive`) y al salir del tablero.
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
  // llega sola al terminar la mutación).
  const refreshRack = useCallback(() => {
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

  const totals = data?.totals ?? EMPTY_TOTALS;
  // Floors normalised and merged by key so every spelling of «no floor» is one
  // «Sin planta» section (qa#11).
  const floors: FloorGroup[] = useMemo(() => {
    const groups = new Map<string, FloorGroup>();
    for (const f of data?.floors ?? []) {
      const key = floorKey(f.floor);
      const group = groups.get(key);
      if (group) group.rooms = [...group.rooms, ...f.rooms];
      else groups.set(key, { key, title: floorTitle(f.floor), rooms: f.rooms });
    }
    return Array.from(groups.values());
  }, [data]);

  // Floors with their filtered tiles.
  const filteredFloors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return floors
      .filter((f) => filterFloor === "all" || f.key === filterFloor)
      .map((f) => ({
        key: f.key,
        title: f.title,
        rooms: f.rooms.filter((r) => {
          if (filterOcc.size > 0 && !filterOcc.has(r.occupancy)) return false;
          if (q) {
            const guestName = (r.currentReservation?.guestName || r.nextArrival?.guestName || "").toLowerCase();
            return r.roomNumber.toLowerCase().includes(q) || guestName.includes(q);
          }
          return true;
        })
      }))
      .filter((f) => f.rooms.length > 0);
  }, [floors, filterOcc, filterFloor, query]);

  const visibleCount = filteredFloors.reduce((sum, f) => sum + f.rooms.length, 0);
  const filtersActive = filterOcc.size > 0 || filterFloor !== "all" || query.trim() !== "";

  const selectedTile = useMemo(() => {
    if (!selectedRoomId) return null;
    for (const f of floors) {
      const t = f.rooms.find((r) => r.roomId === selectedRoomId);
      if (t) return t;
    }
    return null;
  }, [floors, selectedRoomId]);

  function toggleFilter(o: Occupancy) {
    setFilterOcc((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o);
      else next.add(o);
      return next;
    });
  }

  function clearFilters() {
    setFilterOcc(new Set());
    setFilterFloor("all");
    setQuery("");
  }

  /** «Bloquear la 305» (confirmado en el diálogo nominal): casilla fuera del inventario al instante, POST sellable:false, toast con número. */
  async function blockRoom(tile: Tile) {
    const { roomId, roomNumber } = tile;
    setBlockPrompt(null);
    setRoomBusy(roomId, true);
    try {
      await mutate(
        (prev) => rackWithTile(prev, roomId, (t) => tileWithSellable(t, false)),
        (request) => request<void>(`/rooms/${roomId}/sellable`, { method: "POST", body: { sellable: false } })
      );
      showToast(PISOS_TOASTS.roomBlocked(roomNumber), { variant: "success" });
    } catch (e) {
      // Rollback ya hecho por `mutate` (409 si la bloquea un parte, 403 sin permiso…).
      showToast(errorMessage(e), { variant: "error" });
    } finally {
      setRoomBusy(roomId, false);
    }
  }

  /** «Desbloquear habitación»: directo, toast «Habitación 305 desbloqueada.» con «Deshacer» (POST inverso sellable:false). */
  async function unblockRoom(tile: Tile) {
    const { roomId, roomNumber } = tile;
    setRoomBusy(roomId, true);
    try {
      await mutate(
        (prev) => rackWithTile(prev, roomId, (t) => tileWithSellable(t, true)),
        (request) => request<void>(`/rooms/${roomId}/sellable`, { method: "POST", body: { sellable: true } }),
        {
          undo: {
            label: PISOS_TOASTS.roomUnblocked(roomNumber),
            onUndo: async () => {
              await mutate(
                (prev) => rackWithTile(prev, roomId, (t) => tileWithSellable(t, false)),
                (request) => request<void>(`/rooms/${roomId}/sellable`, { method: "POST", body: { sellable: false } })
              );
              showToast(PISOS_TOASTS.roomBlocked(roomNumber), { variant: "info" });
            }
          }
        }
      );
    } catch (e) {
      showToast(errorMessage(e), { variant: "error" });
    } finally {
      setRoomBusy(roomId, false);
    }
  }

  /**
   * «Marcar limpia» / «Inspeccionada»: cambio optimista, toast con número y
   * «Deshacer», POST diferido 8 s (deferred-commit.ts). Deshacer cancela la
   * ventana (no se envía nada) y devuelve la casilla a su estado anterior.
   */
  async function deferHkWrite(tile: Tile, housekeeping: Exclude<HkWrite, "dirty">) {
    const { roomId, roomNumber } = tile;
    const previous: HkWrite = tile.housekeepingStatus === "inspected" ? "inspected" : tile.housekeepingStatus === "clean" ? "clean" : "dirty";
    // Una ventana por casilla: la segunda acción vacía la anterior (§5).
    pendingByRoom.current.get(roomId)?.flush();
    const pending = deferredCommit(HK_UNDO_MS);
    pendingByRoom.current.set(roomId, pending);
    const message = housekeeping === "clean" ? PISOS_TOASTS.roomClean(roomNumber) : PISOS_TOASTS.roomInspected(roomNumber);
    showToast(message, {
      variant: "success",
      duration: HK_UNDO_MS,
      // El toast y la ventana corren en paralelo: pausar el toast (ratón o foco) no pausa la escritura (UX-3-REV-01).
      pauseOnHover: false,
      action: {
        label: PISOS_ACTIONS.undo,
        onAction: () => {
          // Ventana ya agotada o vaciada: la escritura viajó; se avisa en vez de callar (UX-3-REV-01).
          if (!undoDeferred(pending, () => showToast(PISOS_TOASTS.undoExpired(roomNumber), { variant: "warning" }))) return;
          // Inversa optimista sin petición: la casilla vuelve a como estaba.
          void mutate(
            (prev) => rackWithTile(prev, roomId, (t) => tileWithHousekeeping(t, previous)),
            async () => undefined
          );
          showToast(PISOS_TOASTS.undone(roomNumber), { variant: "info" });
        }
      },
      announce: message
    });
    try {
      await mutate(
        (prev) => rackWithTile(prev, roomId, (t) => tileWithHousekeeping(t, housekeeping)),
        async (request) => {
          const go = await pending.wait();
          if (!go) return; // Deshacer: no se envía nada.
          setRoomBusy(roomId, true);
          try {
            await request<void>(`/rooms/${roomId}/housekeeping-status`, {
              method: "POST",
              body: { status: housekeeping },
              keepalive: pending.reason() === "pagehide"
            });
          } finally {
            setRoomBusy(roomId, false);
          }
        }
      );
    } catch (e) {
      showToast(errorMessage(e), { variant: "error" });
    } finally {
      if (pendingByRoom.current.get(roomId) === pending) pendingByRoom.current.delete(roomId);
    }
  }

  /** «Marcar sucia»: directo con «Deshacer» (POST inverso a la limpieza anterior: clean o inspected). */
  async function markDirty(tile: Tile) {
    const { roomId, roomNumber } = tile;
    const previous: Exclude<HkWrite, "dirty"> = tile.housekeepingStatus === "inspected" ? "inspected" : "clean";
    pendingByRoom.current.get(roomId)?.flush();
    setRoomBusy(roomId, true);
    try {
      await mutate(
        (prev) => rackWithTile(prev, roomId, (t) => tileWithHousekeeping(t, "dirty")),
        (request) => request<void>(`/rooms/${roomId}/housekeeping-status`, { method: "POST", body: { status: "dirty" } }),
        {
          undo: {
            label: PISOS_TOASTS.roomDirty(roomNumber),
            onUndo: async () => {
              await mutate(
                (prev) => rackWithTile(prev, roomId, (t) => tileWithHousekeeping(t, previous)),
                (request) => request<void>(`/rooms/${roomId}/housekeeping-status`, { method: "POST", body: { status: previous } })
              );
              showToast(previous === "inspected" ? PISOS_TOASTS.roomInspected(roomNumber) : PISOS_TOASTS.roomClean(roomNumber), { variant: "info" });
            }
          }
        }
      );
    } catch (e) {
      showToast(errorMessage(e), { variant: "error" });
    } finally {
      setRoomBusy(roomId, false);
    }
  }

  function handleHkStatus(tile: Tile, status: HkWrite) {
    if (status === "dirty") void markDirty(tile);
    else void deferHkWrite(tile, status);
  }

  // Audit 2026-06 · #10: first-load guard. Before any data arrives the derived
  // totals/floors are all zero, so the board rendered as a misleading "empty
  // hotel". The page state paints a skeleton or the error instead.
  const pageState = !data ? (error ? "error" : "loading") : "ready";
  const dataAt = data ? time(data.generatedAt) : null;

  const floorOptions = useMemo(
    () => [{ value: "all", label: "Todas las plantas" }, ...floors.map((f) => ({ value: f.key, label: `${f.title} (${f.rooms.length})` }))],
    [floors]
  );

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title="Tablero de habitaciones"
      subtitle={
        hosted
          ? undefined
          : `Vista en tiempo real de ${plural(totals.rooms, "habitación", "habitaciones")}. Abre una para ver el detalle y actuar.${dataAt ? ` Datos a ${dataAt}.` : ""}`
      }
      actions={
        <>
          {error && data ? (
            <CocoaBadge tone="warning" title={error}>
              Sin actualizar
            </CocoaBadge>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" loading={loading && data !== null} onClick={refreshRack}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<RackSkeleton />}
      error={{ title: "No se pudo cargar el tablero de habitaciones", message: error ?? undefined, onRetry: refreshRack }}
      commands={[{ id: "tablero-refresh", label: "Actualizar tablero de habitaciones", run: refreshRack }]}
    >
      <CocoaKpiStrip stagger aria-label="Estado de las habitaciones">
        <CocoaKpi label="Ocupadas" value={number(totals.occupied)} />
        <CocoaKpi label="Listas" value={number(totals.vacantClean)} status={totals.vacantClean > 0 ? "ok" : "warning"} />
        <CocoaKpi label="Sucias" value={number(totals.vacantDirty)} status={totals.vacantDirty > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Fuera de servicio" value={number(totals.outOfOrder)} status={totals.outOfOrder > 0 ? "critical" : "ok"} />
        <CocoaKpi label="Llegadas hoy" value={number(totals.arrivalsToday)} />
        <CocoaKpi label="Salidas hoy" value={number(totals.departuresToday)} />
      </CocoaKpiStrip>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros del tablero"
        leftSlot={
          <CocoaSearchInput
            id="tablero-search"
            value={query}
            onChange={setQuery}
            placeholder="Buscar por número o huésped…"
            aria-label="Buscar habitación por número o huésped"
          />
        }
        rightSlot={
          <>
            <CocoaSelect value={filterFloor} onChange={setFilterFloor} options={floorOptions} aria-label="Planta" />
            <CocoaBadge tone="neutral">{plural(visibleCount, "habitación visible", "habitaciones visibles")}</CocoaBadge>
          </>
        }
      />

      <div className="cocoa-row" data-gap="2" role="group" aria-label="Filtrar por estado">
        <span className="cocoa-caption">Estado</span>
        {OCCUPANCIES.map((o) => {
          const active = filterOcc.has(o);
          const meta = OCCUPANCY_META[o];
          return (
            <CocoaButton
              key={o}
              variant={active ? "tinted" : "bordered"}
              tone={active ? "accent" : "neutral"}
              size="small"
              aria-pressed={active}
              onClick={() => toggleFilter(o)}
            >
              <CocoaStatusBadge entry={meta} variant="dot" />
            </CocoaButton>
          );
        })}
        {filtersActive ? (
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={clearFilters}>
            {ACTIONS.clearFilters}
          </CocoaButton>
        ) : null}
      </div>

      {filteredFloors.length === 0 ? (
        <CocoaSection aria-label="Sin habitaciones">
          <CocoaState
            kind="empty"
            illustration={filtersActive ? "search" : "box"}
            title={filtersActive ? "Ninguna habitación coincide" : "Sin habitaciones"}
            message={filtersActive ? "Cambia la búsqueda o los filtros de planta y estado." : "La propiedad no tiene habitaciones configuradas todavía."}
            primaryAction={filtersActive ? { label: ACTIONS.clearFilters, onClick: clearFilters } : undefined}
          />
        </CocoaSection>
      ) : (
        filteredFloors.map((floor) => (
          <CocoaSection key={floor.key} title={floor.title} meta={plural(floor.rooms.length, "habitación", "habitaciones")}>
            <div className="c22-tile-grid">
              {floor.rooms.map((tile) => (
                <RoomTile key={tile.roomId} tile={tile} onOpen={() => setSelectedRoomId(tile.roomId)} />
              ))}
            </div>
          </CocoaSection>
        ))
      )}

      <CocoaDrawer
        open={selectedTile !== null}
        onClose={() => setSelectedRoomId(null)}
        title={selectedTile ? `Habitación ${selectedTile.roomNumber}` : "Habitación"}
        subtitle={selectedTile ? `${selectedTile.roomTypeName ? `${selectedTile.roomTypeName} · ` : ""}${floorTitle(selectedTile.floor)}` : undefined}
        side="right"
        size="md"
        footer={
          <CocoaButton variant="plain" tone="neutral" onClick={() => setSelectedRoomId(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selectedTile ? (
          <RoomDetail
            tile={selectedTile}
            busy={busyRooms.has(selectedTile.roomId)}
            onCheckIn={(resId) => {
              setSelectedRoomId(null);
              setCheckInResId(resId);
            }}
            onCheckOut={(resId) => {
              setSelectedRoomId(null);
              setCheckOutResId(resId);
            }}
            onBlock={(tile) => setBlockPrompt(tile)}
            onUnblock={(tile) => void unblockRoom(tile)}
            onHkStatus={handleHkStatus}
          />
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={blockPrompt !== null}
        onClose={() => setBlockPrompt(null)}
        tone="destructive"
        size="sm"
        title={blockPrompt ? PISOS_ACTIONS.blockRoomConfirm(blockPrompt.roomNumber) : PISOS_ACTIONS.blockRoom}
        description={blockPrompt ? `La habitación ${blockPrompt.roomNumber} sale del inventario y deja de venderse hasta que la desbloquees.` : undefined}
        confirmLabel={blockPrompt ? PISOS_ACTIONS.blockRoomConfirm(blockPrompt.roomNumber) : PISOS_ACTIONS.blockRoom}
        cancelLabel={PISOS_ACTIONS.keepRoomOnSale}
        busy={blockPrompt ? busyRooms.has(blockPrompt.roomId) : false}
        onConfirm={() => {
          if (blockPrompt) void blockRoom(blockPrompt);
        }}
      />

      {checkInResId ? (
        <QuickCheckInDrawer
          reservationId={checkInResId}
          onClose={() => setCheckInResId(null)}
          onCompleted={({ elapsedSeconds }) => {
            showToast(`Check-in completado en ${plural(elapsedSeconds, "segundo", "segundos")}`, { variant: "success" });
            refresh();
          }}
        />
      ) : null}
      {checkOutResId ? (
        <QuickCheckOutDrawer
          reservationId={checkOutResId}
          onClose={() => setCheckOutResId(null)}
          onCompleted={({ elapsedSeconds }) => {
            showToast(`Check-out completado en ${plural(elapsedSeconds, "segundo", "segundos")}`, { variant: "success" });
            refresh();
          }}
        />
      ) : null}
    </CocoaPage>
  );
}

// ============================================================== sub-components

function RoomTile({ tile, onOpen }: { tile: Tile; onOpen: () => void }) {
  const meta = OCCUPANCY_META[tile.occupancy];
  const focus = tile.currentReservation ?? tile.nextArrival;
  const line = focus ? (tile.currentReservation ? focus.guestName : `Próxima: ${focus.guestName}`) : (tile.roomTypeName ?? "—");
  const badges = tile.badges.slice(0, 4);
  return (
    <CocoaCard
      variant="bordered"
      padding="sm"
      onClick={onOpen}
      aria-label={`Habitación ${tile.roomNumber}, ${meta.label}${tile.roomTypeName ? `, ${tile.roomTypeName}` : ""}${focus ? `, ${line}` : ""}`}
      style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)", minHeight: 96 }}
    >
      <span aria-hidden="true" style={toneBarStyle(meta.tone)} />
      <span className="cocoa-row" data-gap="2" data-justify="between" data-wrap="nowrap">
        <strong style={roomNumberStyle}>{tile.roomNumber}</strong>
        <CocoaStatusBadge entry={meta} dense />
      </span>
      <span style={tileLineStyle}>{line}</span>
      {badges.length > 0 ? (
        <span className="cocoa-cluster">
          {badges.map((b) => (
            <CocoaBadge key={b} tone={BADGE_META[b].tone} size="small" title={BADGE_META[b].title}>
              {BADGE_META[b].short}
            </CocoaBadge>
          ))}
        </span>
      ) : null}
    </CocoaCard>
  );
}

function GuestBlock({ title, reservation, when }: { title: string; reservation: Reservation; when: string }) {
  return (
    <CocoaSection title={title}>
      <div className="cocoa-stack" data-gap="2">
        <strong>{reservation.guestName}</strong>
        <span style={mutedStyle}>{when}</span>
        {reservation.vip ? (
          <span className="cocoa-cluster">
            <CocoaBadge tone="accent">VIP{reservation.loyaltyTier ? ` · ${reservation.loyaltyTier}` : ""}</CocoaBadge>
          </span>
        ) : null}
        {reservation.balanceDue > 0 ? (
          <CocoaCallout tone="warning" title={`Saldo pendiente: ${money(reservation.balanceDue)}`} />
        ) : null}
        {reservation.specialRequest ? (
          <CocoaCallout tone="info" title="Petición especial">
            {reservation.specialRequest}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaSection>
  );
}

function RoomDetail({
  tile,
  busy,
  onCheckIn,
  onCheckOut,
  onBlock,
  onUnblock,
  onHkStatus
}: {
  tile: Tile;
  busy: boolean;
  onCheckIn: (reservationId: string) => void;
  onCheckOut: (reservationId: string) => void;
  /** «Bloquear habitación»: abre el diálogo nominal (no escribe). */
  onBlock: (tile: Tile) => void;
  /** «Desbloquear habitación»: directo con deshacer. */
  onUnblock: (tile: Tile) => void;
  onHkStatus: (tile: Tile, status: HkWrite) => void;
}) {
  const meta = OCCUPANCY_META[tile.occupancy];
  const current = tile.currentReservation;
  const next = tile.nextArrival;
  const isBlocked = tile.occupancy === "blocked_maintenance" || tile.occupancy === "out_of_order";

  return (
    <div className="cocoa-stack" data-gap="4">
      <span className="cocoa-cluster">
        <CocoaStatusBadge entry={meta} />
        {tile.housekeepingStatus ? <CocoaStatusBadge entry={roomStatus(tile.housekeepingStatus)} title="Estado de limpieza" /> : null}
        {tile.badges.map((b) => (
          <CocoaBadge key={b} tone={BADGE_META[b].tone} title={BADGE_META[b].title}>
            {BADGE_META[b].title}
          </CocoaBadge>
        ))}
      </span>

      {current ? (
        <GuestBlock
          title="Huésped actual"
          reservation={current}
          when={`Salida ${date(current.departureDate, "weekdayShort")}${current.etd ? ` · hora prevista ${current.etd}` : ""}`}
        />
      ) : null}

      {next ? (
        <GuestBlock
          title="Próxima llegada"
          reservation={next}
          when={`Llega ${date(next.arrivalDate, "weekdayShort")}${next.eta ? ` · hora prevista ${next.eta}` : ""}`}
        />
      ) : null}

      <CocoaSection title="Acciones rápidas">
        <div className="cocoa-stack" data-gap="2">
          {current && current.status === "checked_in" ? (
            <CocoaButton variant="filled" tone="accent" disabled={busy} onClick={() => onCheckOut(current.reservationId)}>
              Hacer check-out
            </CocoaButton>
          ) : null}
          {next && (next.status === "confirmed" || next.status === "checked_in") ? (
            <CocoaButton variant="filled" tone="accent" disabled={busy} onClick={() => onCheckIn(next.reservationId)}>
              Hacer check-in del próximo huésped
            </CocoaButton>
          ) : null}
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onHkStatus(tile, "clean")}>
              {PISOS_ACTIONS.markClean}
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onHkStatus(tile, "dirty")}>
              {PISOS_ACTIONS.markDirty}
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onHkStatus(tile, "inspected")}>
              {PISOS_ACTIONS.inspected}
            </CocoaButton>
          </div>
          {isBlocked ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onUnblock(tile)}>
              {PISOS_ACTIONS.unblockRoom}
            </CocoaButton>
          ) : (
            <CocoaButton variant="bordered" tone="destructive" size="small" disabled={busy} onClick={() => onBlock(tile)}>
              {PISOS_ACTIONS.blockRoom}
            </CocoaButton>
          )}
        </div>
      </CocoaSection>
    </div>
  );
}
