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

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import { QuickCheckInDrawer } from "./QuickCheckInDrawer";
import { QuickCheckOutDrawer } from "./QuickCheckOutDrawer";
import { floorKey, floorTitle } from "./room-rack-labels";
import { useTabHost } from "../tabs/TabHost";
import { useToast } from "../../components/Toast";
import { date, money, number, plural, time } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
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
// en producción. Ahora va por apiRequest (JWT + manejo de sesión).
async function postAction(path: string, body?: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    await apiRequest(path, { method: "POST", body });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "No se pudo completar la acción." };
  }
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
  const { data, loading, error, refresh } = useApiData<RackData>(`/dashboards/room-rack?propertyId=${propertyId}`, { pollIntervalMs: 30000 });

  const [filterOcc, setFilterOcc] = useState<Set<Occupancy>>(new Set());
  const [filterFloor, setFilterFloor] = useState<string | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [checkInResId, setCheckInResId] = useState<string | null>(null);
  const [checkOutResId, setCheckOutResId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function handleBlockRoom(roomId: string, sellable: boolean) {
    setBusy(true);
    const result = await postAction(`/rooms/${roomId}/sellable`, { sellable });
    setBusy(false);
    showToast(result.ok ? (sellable ? "Habitación desbloqueada" : "Habitación bloqueada") : (result.message ?? "No se pudo completar la acción."), { variant: result.ok ? "success" : "warning" });
    if (result.ok) refresh();
  }

  async function handleHkStatus(roomId: string, status: string) {
    setBusy(true);
    const result = await postAction(`/rooms/${roomId}/housekeeping-status`, { status });
    setBusy(false);
    showToast(result.ok ? `Habitación marcada como ${roomStatus(status).label.toLowerCase()}` : (result.message ?? "No se pudo completar la acción."), { variant: result.ok ? "success" : "warning" });
    if (result.ok) refresh();
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
          <CocoaButton variant="bordered" tone="neutral" size="small" loading={loading && data !== null} onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<RackSkeleton />}
      error={{ title: "No se pudo cargar el tablero de habitaciones", message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "tablero-refresh", label: "Actualizar tablero de habitaciones", run: refresh }]}
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
            busy={busy}
            onCheckIn={(resId) => {
              setSelectedRoomId(null);
              setCheckInResId(resId);
            }}
            onCheckOut={(resId) => {
              setSelectedRoomId(null);
              setCheckOutResId(resId);
            }}
            onBlock={(roomId, sellable) => void handleBlockRoom(roomId, sellable)}
            onHkStatus={(roomId, status) => void handleHkStatus(roomId, status)}
          />
        ) : null}
      </CocoaDrawer>

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
  onHkStatus
}: {
  tile: Tile;
  busy: boolean;
  onCheckIn: (reservationId: string) => void;
  onCheckOut: (reservationId: string) => void;
  onBlock: (roomId: string, sellable: boolean) => void;
  onHkStatus: (roomId: string, status: string) => void;
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
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onHkStatus(tile.roomId, "clean")}>
              Marcar limpia
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onHkStatus(tile.roomId, "dirty")}>
              Marcar sucia
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => onHkStatus(tile.roomId, "inspected")}>
              Inspeccionada
            </CocoaButton>
          </div>
          <CocoaButton variant="bordered" tone={isBlocked ? "neutral" : "destructive"} size="small" disabled={busy} onClick={() => onBlock(tile.roomId, isBlocked)}>
            {isBlocked ? "Desbloquear habitación" : "Bloquear habitación"}
          </CocoaButton>
        </div>
      </CocoaSection>
    </div>
  );
}
