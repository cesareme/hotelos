import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  TimelineDateSelector,
  TimelineFilterBar,
  TimelineGrid,
  TimelineHeader,
  TimelineOverbookingAlert,
  TimelineResourceRow,
  TimelineRightDetailPanel,
  type TimelineFilterGroup,
  type TimelineGranularity,
  type TimelineResource,
  type TimelineStatus
} from "@hotelos/ui/timeline";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  assignReservationRoom,
  cancelReservation,
  checkInReservation,
  checkOutReservation,
  fetchGuestActivity,
  fetchReservationFolio,
  fetchReservations,
  fetchRoomTypes,
  fetchRooms,
  noShowReservation,
  updateReservation,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type FolioBalance,
  type GuestActivity
} from "../../services/pmsCommerceApi";
import { EmptyState, ErrorState, LoadingBlock, Spinner } from "../../components/States";
import { NarrowViewportBanner } from "../../components/NarrowViewportBanner";

// ---------------------------------------------------------------------------
// Date helpers (date-only, UTC, no timezone drift)
// ---------------------------------------------------------------------------
const MS_DAY = 86_400_000;
function parseDateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}
function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * MS_DAY);
}
function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_DAY);
}
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
function fmtDate(value: string, opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short" }): string {
  return parseDateOnly(value).toLocaleDateString("es-ES", { ...opts, timeZone: "UTC" });
}
function money(amount: number | undefined, currency = "EUR"): string {
  if (amount === undefined || Number.isNaN(amount)) return "—";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, useGrouping: true }).format(amount);
}
function nightsOf(res: AdminReservation): number {
  return Math.max(1, diffDays(parseDateOnly(res.arrivalDate), parseDateOnly(res.departureDate)));
}
function guestLabel(res: AdminReservation): string {
  return res.bookerName?.trim() || res.companyName?.trim() || res.groupCode?.trim() || res.code;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

// ---------------------------------------------------------------------------
// Status maps (Spanish labels + tones)
// ---------------------------------------------------------------------------
const RES_STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmada",
  checked_in: "En casa",
  checked_out: "Salida",
  cancelled: "Cancelada",
  no_show: "No-show",
  tentative: "Tentativa",
  pending: "Pendiente"
};
const ROOM_STATUS_MAP: Record<string, TimelineStatus> = {
  clean: "clean",
  dirty: "dirty",
  inspected: "inspected",
  occupied: "occupied",
  vacant: "vacant",
  out_of_order: "out_of_order",
  out_of_service: "out_of_service"
};
type Tone = { bg: string; border: string; ink: string };
const STATUS_TONE: Record<string, Tone> = {
  confirmed: { bg: "#1d2a73", border: "#0b1026", ink: "#ffffff" },
  checked_in: { bg: "#0f9f6e", border: "#0a7e57", ink: "#ffffff" },
  checked_out: { bg: "#94a3b8", border: "#64748b", ink: "#0b1026" },
  cancelled: { bg: "#fde2e2", border: "#c2413a", ink: "#7f1d1d" },
  no_show: { bg: "#1f2937", border: "#0b1026", ink: "#ffffff" },
  tentative: { bg: "#fff7e6", border: "#b7791f", ink: "#7a4b08" },
  pending: { bg: "#fff7e6", border: "#b7791f", ink: "#7a4b08" }
};
function toneFor(status: string): Tone {
  return STATUS_TONE[status] ?? STATUS_TONE.confirmed;
}

const UNASSIGNED_ID = "__unassigned__";
const BLOCK_HEIGHT = 46;
const LANE_GAP = 6;

type Block = {
  res: AdminReservation;
  clippedOffset: number;
  clippedSpan: number;
  continuesLeft: boolean;
  continuesRight: boolean;
  lane: number;
};

type Pending =
  | { type: "move"; res: AdminReservation; newRoomId: string | null; newRoomLabel?: string; newArrival: string | null; newDeparture: string | null }
  | { type: "resize"; res: AdminReservation; newDepartureDate: string }
  | { type: "checkin" | "checkout" | "cancel" | "noshow" | "assign"; res: AdminReservation };

// Assign overlapping blocks to vertical lanes (interval partitioning).
function assignLanes(blocks: Omit<Block, "lane">[]): { laid: Block[]; laneCount: number } {
  const ends: number[] = [];
  const order = [...blocks.keys()].sort((a, b) => blocks[a].clippedOffset - blocks[b].clippedOffset);
  const laneOf = new Array<number>(blocks.length).fill(0);
  for (const i of order) {
    const b = blocks[i];
    let placed = false;
    for (let l = 0; l < ends.length; l++) {
      if (b.clippedOffset >= ends[l]) {
        laneOf[i] = l;
        ends[l] = b.clippedOffset + b.clippedSpan;
        placed = true;
        break;
      }
    }
    if (!placed) {
      laneOf[i] = ends.length;
      ends.push(b.clippedOffset + b.clippedSpan);
    }
  }
  return { laid: blocks.map((b, i) => ({ ...b, lane: laneOf[i] })), laneCount: Math.max(1, ends.length) };
}

export function LiveTimelineWorkspace() {
  const propertyId = useMemo(() => getActivePropertyId(), []);

  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [granularity, setGranularity] = useState<TimelineGranularity>("week");
  const [rangeStart, setRangeStart] = useState<Date>(() => todayUtc());

  const [statusSel, setStatusSel] = useState<string[] | null>(null);
  const [channelSel, setChannelSel] = useState<string[] | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [hover, setHover] = useState<{ res: AdminReservation; left: number; top: number } | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [assignRoomId, setAssignRoomId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const dayCount = granularity === "day" ? 7 : granularity === "week" ? 14 : 30;
  const cellWidth = granularity === "month" ? 64 : granularity === "day" ? 150 : 118;
  const rangeEnd = useMemo(() => addDays(rangeStart, dayCount), [rangeStart, dayCount]);

  // ---- data loading -------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rms, rts, res] = await Promise.all([
        fetchRooms(propertyId),
        fetchRoomTypes(propertyId),
        fetchReservations(propertyId)
      ]);
      setRooms(rms);
      setRoomTypes(rts);
      setReservations(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el timeline.");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    try {
      const [rms, res] = await Promise.all([fetchRooms(propertyId), fetchReservations(propertyId)]);
      setRooms(rms);
      setReservations(res);
    } catch {
      /* keep current view */
    }
  }, [propertyId]);

  // Snap the window to where the data actually is, so the demo never looks empty.
  useEffect(() => {
    if (loading || reservations.length === 0) return;
    const visible = reservations.some(
      (r) => parseDateOnly(r.arrivalDate) < rangeEnd && parseDateOnly(r.departureDate) > rangeStart
    );
    if (!visible) {
      const earliest = reservations.reduce(
        (min, r) => (parseDateOnly(r.arrivalDate) < min ? parseDateOnly(r.arrivalDate) : min),
        parseDateOnly(reservations[0].arrivalDate)
      );
      setRangeStart(addDays(earliest, -1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, reservations]);

  // ---- detail panel data --------------------------------------------------
  useEffect(() => {
    if (!selectedId) {
      setFolio(null);
      setActivity(null);
      return;
    }
    let on = true;
    setDetailLoading(true);
    Promise.all([
      fetchReservationFolio(selectedId).catch(() => null),
      fetchGuestActivity(selectedId).catch(() => null)
    ])
      .then(([f, a]) => {
        if (!on) return;
        setFolio(f);
        setActivity(a);
      })
      .finally(() => {
        if (on) setDetailLoading(false);
      });
    return () => {
      on = false;
    };
  }, [selectedId]);

  // ---- filters (data-driven) ---------------------------------------------
  const statusesPresent = useMemo(() => Array.from(new Set(reservations.map((r) => r.status))), [reservations]);
  const channelsPresent = useMemo(
    () => Array.from(new Set(reservations.map((r) => r.channel).filter(Boolean))) as string[],
    [reservations]
  );
  const effStatus = statusSel ?? statusesPresent.filter((s) => s !== "cancelled");
  const effChannel = channelSel ?? channelsPresent;

  const toggleStatus = (id: string) =>
    setStatusSel((prev) => {
      const base = prev ?? statusesPresent.filter((s) => s !== "cancelled");
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  const toggleChannel = (id: string) =>
    setChannelSel((prev) => {
      const base = prev ?? channelsPresent;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });

  const filterGroups: TimelineFilterGroup[] = [
    {
      id: "status",
      label: "Estado",
      options: statusesPresent.map((s) => ({
        id: s,
        label: RES_STATUS_LABEL[s] ?? s,
        count: reservations.filter((r) => r.status === s).length
      })),
      selectedIds: effStatus
    },
    {
      id: "channel",
      label: "Canal",
      options: channelsPresent.map((c) => ({
        id: c,
        label: c,
        count: reservations.filter((r) => r.channel === c).length
      })),
      selectedIds: effChannel
    }
  ];

  const visibleReservations = useMemo(
    () =>
      reservations.filter((r) => {
        const statusOk = statusesPresent.length === 0 || effStatus.includes(r.status);
        const channelOk = channelsPresent.length === 0 || effChannel.includes(r.channel);
        return statusOk && channelOk;
      }),
    [reservations, effStatus, effChannel, statusesPresent.length, channelsPresent.length]
  );

  // ---- rows + blocks ------------------------------------------------------
  const roomTypeById = useMemo(() => new Map(roomTypes.map((t) => [t.id, t])), [roomTypes]);
  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);
  const sortedRooms = useMemo(
    () => [...rooms].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })),
    [rooms]
  );

  function blockFor(res: AdminReservation): Omit<Block, "lane"> | null {
    const arrival = parseDateOnly(res.arrivalDate);
    const departure = parseDateOnly(res.departureDate);
    if (!(arrival < rangeEnd && departure > rangeStart)) return null;
    const offset = diffDays(rangeStart, arrival);
    const span = Math.max(1, diffDays(arrival, departure));
    const clippedOffset = Math.max(0, offset);
    const clippedEnd = Math.min(dayCount, offset + span);
    return {
      res,
      clippedOffset,
      clippedSpan: Math.max(1, clippedEnd - clippedOffset),
      continuesLeft: offset < 0,
      continuesRight: offset + span > dayCount
    };
  }

  const rows = useMemo(() => {
    const built: Array<{ resource: TimelineResource; blocks: Block[]; height: number }> = [];
    const makeRow = (resource: TimelineResource, list: AdminReservation[]) => {
      const raw = list.map(blockFor).filter(Boolean) as Omit<Block, "lane">[];
      const { laid, laneCount } = assignLanes(raw);
      built.push({ resource, blocks: laid, height: Math.max(64, laneCount * (BLOCK_HEIGHT + LANE_GAP) + LANE_GAP) });
    };

    const unassigned = visibleReservations.filter((r) => !r.assignedRoomId && r.status !== "cancelled");
    if (unassigned.length) {
      makeRow(
        { id: UNASSIGNED_ID, name: "Sin asignar", resourceType: "Reservas sin habitación", status: "vacant", capacity: `${unassigned.length}` },
        unassigned
      );
    }
    for (const room of sortedRooms) {
      const rt = roomTypeById.get(room.roomTypeId);
      makeRow(
        {
          id: room.id,
          name: `Hab. ${room.number}`,
          resourceType: rt?.name ?? "Habitación",
          status: ROOM_STATUS_MAP[room.status] ?? "vacant",
          capacity: rt?.maxOccupancy ? `${rt.maxOccupancy} pax` : undefined,
          subLabel: room.floor ? `Planta ${room.floor}` : undefined
        },
        visibleReservations.filter((r) => r.assignedRoomId === room.id)
      );
    }
    return built;
  }, [visibleReservations, sortedRooms, roomTypeById, rangeStart, rangeEnd, dayCount]);

  const overbookingCount = useMemo(() => {
    let count = 0;
    const byRoom = new Map<string, AdminReservation[]>();
    for (const r of visibleReservations) {
      if (!r.assignedRoomId || r.status === "cancelled") continue;
      const arr = byRoom.get(r.assignedRoomId) ?? [];
      arr.push(r);
      byRoom.set(r.assignedRoomId, arr);
    }
    for (const arr of byRoom.values()) {
      const sorted = arr
        .map((r) => ({ a: parseDateOnly(r.arrivalDate), d: parseDateOnly(r.departureDate) }))
        .sort((x, y) => x.a.getTime() - y.a.getTime());
      for (let i = 1; i < sorted.length; i++) if (sorted[i].a < sorted[i - 1].d) count++;
    }
    return count;
  }, [visibleReservations]);

  // ---- date header --------------------------------------------------------
  const todayKey = toDateOnly(todayUtc());
  const days = useMemo(
    () =>
      Array.from({ length: dayCount }, (_, i) => {
        const date = addDays(rangeStart, i);
        const key = toDateOnly(date);
        return {
          key,
          label: date.toLocaleDateString("es-ES", { weekday: "short", timeZone: "UTC" }),
          sublabel: date.toLocaleDateString("es-ES", { day: "2-digit", month: "short", timeZone: "UTC" }),
          isToday: key === todayKey,
          isWeekend: [0, 6].includes(date.getUTCDay())
        };
      }),
    [rangeStart, dayCount, todayKey]
  );
  const rangeLabel = `${rangeStart.toLocaleDateString("es-ES", { day: "2-digit", month: "short", timeZone: "UTC" })} – ${addDays(rangeStart, dayCount - 1).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}`;

  // ---- drag + resize ------------------------------------------------------
  const dragRef = useRef<{ res: AdminReservation; mode: "move" | "resize"; startX: number; startY: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "resize"; dx: number; dy: number } | null>(null);

  const beginDrag = (res: AdminReservation, mode: "move" | "resize", e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (res.status === "cancelled") return;
    dragRef.current = { res, mode, startX: e.clientX, startY: e.clientY, moved: false };
    setDrag({ id: res.id, mode, dx: 0, dy: 0 });
    setHover(null);
  };

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
      setDrag({ id: d.res.id, mode: d.mode, dx, dy });
    }
    function onUp(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDrag(null);
      if (!d.moved) {
        setSelectedId(d.res.id);
        return;
      }
      const dxDays = Math.round((e.clientX - d.startX) / cellWidth);
      if (d.mode === "resize") {
        if (dxDays !== 0) {
          const newDep = toDateOnly(addDays(parseDateOnly(d.res.departureDate), dxDays));
          if (parseDateOnly(newDep) > parseDateOnly(d.res.arrivalDate)) {
            setPending({ type: "resize", res: d.res, newDepartureDate: newDep });
          }
        }
        return;
      }
      // move: detect target room row + day shift
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const rowEl = (el as HTMLElement | null)?.closest("[data-room-id]") as HTMLElement | null;
      const targetRoomId = rowEl?.getAttribute("data-room-id") ?? null;
      const roomChanged = !!targetRoomId && targetRoomId !== UNASSIGNED_ID && targetRoomId !== d.res.assignedRoomId;
      const newArrival = dxDays !== 0 ? toDateOnly(addDays(parseDateOnly(d.res.arrivalDate), dxDays)) : null;
      const newDeparture = newArrival ? toDateOnly(addDays(parseDateOnly(newArrival), nightsOf(d.res))) : null;
      if (roomChanged || newArrival) {
        const targetRoom = targetRoomId ? roomById.get(targetRoomId) : undefined;
        setPending({
          type: "move",
          res: d.res,
          newRoomId: roomChanged ? targetRoomId : null,
          newRoomLabel: targetRoom ? `Hab. ${targetRoom.number}` : undefined,
          newArrival,
          newDeparture
        });
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [cellWidth, roomById]);

  // ---- actions ------------------------------------------------------------
  const selected = useMemo(() => reservations.find((r) => r.id === selectedId) ?? null, [reservations, selectedId]);
  const selectedRoom = selected?.assignedRoomId ? roomById.get(selected.assignedRoomId) : undefined;

  async function applyPending() {
    if (!pending) return;
    setBusy(true);
    setActionMsg(null);
    try {
      if (pending.type === "resize") {
        await updateReservation(pending.res.id, { departureDate: pending.newDepartureDate });
      } else if (pending.type === "move") {
        if (pending.newArrival && pending.newDeparture) {
          await updateReservation(pending.res.id, { arrivalDate: pending.newArrival, departureDate: pending.newDeparture });
        }
        if (pending.newRoomId) {
          await assignReservationRoom(pending.res.id, { roomId: pending.newRoomId });
        }
      } else if (pending.type === "checkin") {
        if (!pending.res.assignedRoomId) throw new Error("Asigna una habitación antes del check-in.");
        await checkInReservation(pending.res.id, { roomId: pending.res.assignedRoomId });
      } else if (pending.type === "checkout") {
        await checkOutReservation(pending.res.id);
      } else if (pending.type === "cancel") {
        await cancelReservation(pending.res.id, reason || undefined);
      } else if (pending.type === "noshow") {
        await noShowReservation(pending.res.id, reason || undefined);
      } else if (pending.type === "assign") {
        if (!assignRoomId) throw new Error("Selecciona una habitación.");
        await assignReservationRoom(pending.res.id, { roomId: assignRoomId });
      }
      await refresh();
      setActionMsg("Hecho.");
      setPending(null);
      setReason("");
      setAssignRoomId("");
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  function openReservation(id: string) {
    window.history.pushState(null, "", `/backoffice/reservations/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  function nav(screen: string) {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }

  // ---- render -------------------------------------------------------------
  return (
    <>
    <NarrowViewportBanner />
    <section className="bo-card" style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <p className="bo-page-eyebrow">Timeline</p>
          <h1 className="bo-page-title" style={{ marginTop: 2 }}>Live Timeline</h1>
          <p style={{ marginTop: 8, color: "var(--ink-muted)", maxWidth: "72ch" }}>
            Reservas y habitaciones reales. Pasa el ratón por un bloque para ver su ficha rápida, haz clic para abrir el
            detalle con folio y actividad, y arrastra para mover o redimensionar la estancia. Las acciones críticas piden
            confirmación antes de ejecutarse.
          </p>
        </div>
        {overbookingCount > 0 ? (
          <TimelineOverbookingAlert
            count={overbookingCount}
            detail="Solape de reservas en la misma habitación"
            onClick={() => undefined}
          />
        ) : null}
      </header>

      <TimelineDateSelector
        rangeLabel={rangeLabel}
        granularity={granularity}
        onGranularityChange={setGranularity}
        onPrev={() => setRangeStart(addDays(rangeStart, -dayCount))}
        onNext={() => setRangeStart(addDays(rangeStart, dayCount))}
        onToday={() => setRangeStart(todayUtc())}
        onPickRange={() => undefined}
      />

      {!loading && !error && reservations.length > 0 ? (
        <TimelineFilterBar
          groups={filterGroups}
          onToggle={(groupId, optionId) => (groupId === "status" ? toggleStatus(optionId) : toggleChannel(optionId))}
          onClear={() => {
            setStatusSel([]);
            setChannelSel([]);
          }}
        />
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span className="bo-chip">{rooms.length} habitaciones</span>
        <span className="bo-chip">{visibleReservations.length} reservas visibles</span>
        {selected ? (
          <span className="bo-status ok" style={{ textTransform: "none" }}>
            Selección: {selected.code} · {guestLabel(selected)}
          </span>
        ) : (
          <span className="bo-muted" style={{ textTransform: "none" }}>Sin selección</span>
        )}
        <button type="button" onClick={() => void refresh()}>↻ Actualizar</button>
      </div>

      {loading ? (
        <LoadingBlock label="Cargando habitaciones y reservas…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar el timeline" message={error} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Sin datos para mostrar"
          message="No hay habitaciones ni reservas que mostrar en este rango. Prueba a cambiar el periodo o los filtros."
        />
      ) : (
        <TimelineGrid>
          <TimelineHeader leadingLabel="Recurso" days={days} cellWidth={cellWidth} />
          {rows.map((row) => (
            <div data-room-id={row.resource.id} key={row.resource.id}>
              <TimelineResourceRow resource={row.resource} days={dayCount} cellWidth={cellWidth} height={row.height}>
                {row.blocks.map((b) => (
                  <ReservationBlockView
                    key={b.res.id}
                    block={b}
                    cellWidth={cellWidth}
                    selected={selectedId === b.res.id}
                    drag={drag?.id === b.res.id ? drag : null}
                    onPointerDownMove={(e) => beginDrag(b.res, "move", e)}
                    onPointerDownResize={(e) => beginDrag(b.res, "resize", e)}
                    onHover={(left, top) => setHover({ res: b.res, left, top })}
                    onHoverEnd={() => setHover((h) => (h?.res.id === b.res.id ? null : h))}
                    onKeyboardSelect={() => setSelectedId(b.res.id)}
                  />
                ))}
              </TimelineResourceRow>
            </div>
          ))}
        </TimelineGrid>
      )}

      {/* Hover thumbnail */}
      {hover && !drag ? <HoverCard res={hover.res} room={hover.res.assignedRoomId ? roomById.get(hover.res.assignedRoomId) : undefined} left={hover.left} top={hover.top} /> : null}

      {/* Detail panel */}
      <TimelineRightDetailPanel
        open={!!selected}
        title={selected ? selected.code : "Reserva"}
        subtitle={selected ? `${guestLabel(selected)} · ${selectedRoom ? `Hab. ${selectedRoom.number}` : "Sin habitación"}` : undefined}
        onClose={() => setSelectedId(null)}
      >
        {selected ? (
          <DetailPanel
            res={selected}
            room={selectedRoom}
            folio={folio}
            activity={activity}
            loading={detailLoading}
            onOpenReservation={() => openReservation(selected.id)}
            onNav={nav}
            onAction={(type) => {
              setActionMsg(null);
              setAssignRoomId("");
              setReason("");
              setPending({ type, res: selected });
            }}
          />
        ) : null}
      </TimelineRightDetailPanel>

      {/* Confirm / action modal */}
      {pending ? (
        <ActionModal
          pending={pending}
          rooms={sortedRooms}
          roomTypeById={roomTypeById}
          assignRoomId={assignRoomId}
          onAssignRoomChange={setAssignRoomId}
          reason={reason}
          onReasonChange={setReason}
          busy={busy}
          message={actionMsg}
          onCancel={() => {
            setPending(null);
            setActionMsg(null);
          }}
          onConfirm={() => void applyPending()}
        />
      ) : null}
    </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reservation block (custom: hover + drag + resize)
// ---------------------------------------------------------------------------
function ReservationBlockView(props: {
  block: Block;
  cellWidth: number;
  selected: boolean;
  drag: { mode: "move" | "resize"; dx: number; dy: number } | null;
  onPointerDownMove: (e: ReactPointerEvent) => void;
  onPointerDownResize: (e: ReactPointerEvent) => void;
  onHover: (left: number, top: number) => void;
  onHoverEnd: () => void;
  onKeyboardSelect: () => void;
}) {
  const { block, cellWidth, selected, drag } = props;
  const res = block.res;
  const tone = toneFor(res.status);
  const left = block.clippedOffset * cellWidth + 4;
  const baseWidth = block.clippedSpan * cellWidth - 8;
  const top = block.lane * (BLOCK_HEIGHT + LANE_GAP) + LANE_GAP;

  const moveDx = drag?.mode === "move" ? drag.dx : 0;
  const moveDy = drag?.mode === "move" ? drag.dy : 0;
  const resizeDx = drag?.mode === "resize" ? drag.dx : 0;
  const width = Math.max(40, baseWidth + resizeDx);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Reserva ${res.code} de ${guestLabel(res)}, ${RES_STATUS_LABEL[res.status] ?? res.status}`}
      onPointerDown={props.onPointerDownMove}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        props.onHover(r.left, r.top);
      }}
      onMouseLeave={props.onHoverEnd}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onKeyboardSelect();
        }
      }}
      style={{
        position: "absolute",
        left,
        width,
        top,
        height: BLOCK_HEIGHT,
        transform: drag ? `translate(${moveDx}px, ${moveDy}px)` : undefined,
        background: tone.bg,
        border: `${selected ? 2 : 1}px solid ${selected ? "#facc15" : tone.border}`,
        color: tone.ink,
        borderRadius: 10,
        padding: "5px 10px",
        textAlign: "left",
        cursor: drag?.mode === "move" ? "grabbing" : "grab",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        minWidth: 0,
        overflow: "hidden",
        boxShadow: drag ? "0 14px 30px rgba(15,23,42,0.35)" : "0 6px 14px rgba(15,23,42,0.18)",
        opacity: res.status === "cancelled" ? 0.7 : 1,
        zIndex: drag ? 40 : 1,
        touchAction: "none",
        userSelect: "none"
      }}
    >
      <strong style={{ fontSize: 13, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {block.continuesLeft ? "‹ " : ""}
        {guestLabel(res)}
        {block.continuesRight ? " ›" : ""}
      </strong>
      <small style={{ fontSize: 11, fontWeight: 800, opacity: 0.92, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {RES_STATUS_LABEL[res.status] ?? res.status} · {nightsOf(res)} noche{nightsOf(res) === 1 ? "" : "s"} · {money(res.totalAmount, res.currency)}
      </small>
      {/* resize handle (right) */}
      <span
        onPointerDown={props.onPointerDownResize}
        aria-hidden
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 10,
          cursor: "ew-resize",
          borderTopRightRadius: 10,
          borderBottomRightRadius: 10,
          background: "rgba(255,255,255,0.18)"
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hover thumbnail
// ---------------------------------------------------------------------------
function HoverCard(props: { res: AdminReservation; room?: AdminRoom; left: number; top: number }) {
  const { res, room } = props;
  const tone = toneFor(res.status);
  const width = 300;
  const left = Math.max(12, Math.min(props.left, window.innerWidth - width - 12));
  const top = Math.max(12, props.top - 8);
  const style: CSSProperties = {
    position: "fixed",
    left,
    top,
    transform: "translateY(-100%)",
    width,
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: 14,
    boxShadow: "0 18px 44px rgba(15,23,42,0.22)",
    padding: 14,
    zIndex: 90,
    pointerEvents: "none",
    display: "grid",
    gap: 10
  };
  return (
    <div style={style}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: "50%",
            background: tone.bg,
            color: tone.ink,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 900,
            fontSize: 14,
            flex: "0 0 auto"
          }}
        >
          {initials(guestLabel(res))}
        </span>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: "block", fontSize: 14, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {guestLabel(res)}
          </strong>
          <small style={{ color: "var(--ink-muted)" }}>{res.code}</small>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <span className="bo-status ok" style={{ textTransform: "none" }}>{RES_STATUS_LABEL[res.status] ?? res.status}</span>
        {res.channel ? <span className="bo-chip">{res.channel}</span> : null}
        {room ? <span className="bo-chip">Hab. {room.number}</span> : <span className="bo-chip">Sin habitación</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
        <HoverFact label="Entrada" value={fmtDate(res.arrivalDate, { weekday: "short", day: "2-digit", month: "short" })} />
        <HoverFact label="Salida" value={fmtDate(res.departureDate, { weekday: "short", day: "2-digit", month: "short" })} />
        <HoverFact label="Noches" value={`${nightsOf(res)}`} />
        <HoverFact label="Ocupación" value={`${res.adults}A${res.children ? ` · ${res.children}N` : ""}`} />
        <HoverFact label="Importe" value={money(res.totalAmount, res.currency)} />
        <HoverFact label="Segmento" value={res.marketSegment || res.sourceCode || "—"} />
      </div>
      <small style={{ color: "var(--ink-faint)" }}>Haz clic para ver el detalle completo</small>
    </div>
  );
}

function HoverFact(props: { label: string; value: string }) {
  return (
    <div>
      <small style={{ display: "block", fontSize: 10, fontWeight: 900, textTransform: "uppercase", color: "var(--ink-faint)" }}>{props.label}</small>
      <span style={{ fontWeight: 800, color: "var(--ink)" }}>{props.value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel (real folio + activity + deep links + actions)
// ---------------------------------------------------------------------------
function DetailPanel(props: {
  res: AdminReservation;
  room?: AdminRoom;
  folio: FolioBalance | null;
  activity: GuestActivity | null;
  loading: boolean;
  onOpenReservation: () => void;
  onNav: (screen: string) => void;
  onAction: (type: "checkin" | "checkout" | "cancel" | "noshow" | "assign") => void;
}) {
  const { res, room, folio, activity } = props;
  const facts: Array<[string, string]> = [
    ["Estado", RES_STATUS_LABEL[res.status] ?? res.status],
    ["Huésped", guestLabel(res)],
    ["Entrada", fmtDate(res.arrivalDate, { weekday: "long", day: "2-digit", month: "short" })],
    ["Salida", fmtDate(res.departureDate, { weekday: "long", day: "2-digit", month: "short" })],
    ["Noches", `${nightsOf(res)}`],
    ["Ocupación", `${res.adults} adultos${res.children ? ` · ${res.children} niños` : ""}`],
    ["Habitación", room ? `Hab. ${room.number}` : "Sin asignar"],
    ["Canal", res.channel || "—"],
    ["Importe total", money(res.totalAmount, res.currency)],
    ["Saldo pendiente", folio ? money(folio.balanceDue, folio.folio.currency) : props.loading ? "…" : "—"],
    ["Pagos", folio ? `${money(folio.paymentsTotal, folio.folio.currency)} · ${folio.payments.length}` : props.loading ? "…" : "—"],
    ["Actividad abierta", activity ? `${activity.counts.openTotal} abiertas · ${activity.counts.messages} mensajes` : props.loading ? "…" : "—"]
  ];

  const links: Array<{ label: string; onClick: () => void }> = [
    { label: "Abrir reserva", onClick: props.onOpenReservation },
    { label: "Guest journey", onClick: () => props.onNav("GuestJourneyWorkspace") },
    { label: "Folio / facturación", onClick: () => props.onNav("BillingCenter") },
    { label: "Limpieza", onClick: () => props.onNav("HousekeepingDashboard") },
    { label: "Mantenimiento", onClick: () => props.onNav("MaintenanceDashboard") },
    { label: "Mensajes", onClick: () => props.onNav("ConciergeInboxDashboard") }
  ];

  const isIn = res.status === "checked_in";
  const isOut = res.status === "checked_out";
  const isClosed = res.status === "cancelled" || res.status === "no_show";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <span className="bo-status ok" style={{ textTransform: "none" }}>{RES_STATUS_LABEL[res.status] ?? res.status}</span>
        {res.channel ? <span className="bo-chip">{res.channel}</span> : null}
        <span className="bo-chip">{room ? `Hab. ${room.number}` : "Sin habitación"}</span>
        <span className="bo-chip">{nightsOf(res)} noche{nightsOf(res) === 1 ? "" : "s"}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(150px, 1fr))", gap: 8 }}>
        {facts.map(([label, value]) => (
          <div key={label} style={{ border: "1px solid var(--line)", background: "var(--surface-soft)", borderRadius: 12, padding: "8px 10px" }}>
            <small style={{ fontSize: 11, fontWeight: 900, textTransform: "uppercase", color: "var(--ink-muted)" }}>{label}</small>
            <div style={{ marginTop: 2, fontWeight: 800, color: "var(--ink)" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Recent activity */}
      {activity && activity.items.length > 0 ? (
        <div style={{ display: "grid", gap: 6 }}>
          <strong style={{ fontSize: 13 }}>Actividad reciente</strong>
          {activity.items.slice(0, 4).map((item) => (
            <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, borderBottom: "1px solid var(--line-soft)", paddingBottom: 4 }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
              <span className={`bo-status ${item.open ? "warn" : "ok"}`} style={{ textTransform: "none", flex: "0 0 auto" }}>
                {item.open ? "abierta" : "cerrada"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Deep links to menus */}
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 13 }}>Ir a</strong>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {links.map((link) => (
            <button key={link.label} type="button" className="bo-button-link" onClick={link.onClick}>
              {link.label} →
            </button>
          ))}
        </div>
      </div>

      {/* Real quick actions */}
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 13 }}>Acciones</strong>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" className="bo-button-link" disabled={isIn || isOut || isClosed} onClick={() => props.onAction("checkin")}>Check-in</button>
          <button type="button" className="bo-button-link" disabled={!isIn} onClick={() => props.onAction("checkout")}>Check-out</button>
          <button type="button" className="bo-button-link" onClick={() => props.onAction("assign")}>Asignar habitación</button>
          <button type="button" className="bo-button-link" disabled={isClosed} style={{ borderColor: "#c2413a", color: "#c2413a" }} onClick={() => props.onAction("cancel")}>Cancelar</button>
          <button type="button" className="bo-button-link" disabled={isClosed || isIn || isOut} style={{ borderColor: "#c2413a", color: "#c2413a" }} onClick={() => props.onAction("noshow")}>No-show</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action / confirm modal
// ---------------------------------------------------------------------------
function ActionModal(props: {
  pending: Pending;
  rooms: AdminRoom[];
  roomTypeById: Map<string, AdminRoomType>;
  assignRoomId: string;
  onAssignRoomChange: (value: string) => void;
  reason: string;
  onReasonChange: (value: string) => void;
  busy: boolean;
  message: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { pending } = props;
  const res = pending.res;

  let title = "Confirmar";
  let body: string;
  let verb = "Confirmar";
  let danger = false;

  switch (pending.type) {
    case "move":
      title = "Mover reserva";
      body = `Mover ${res.code} (${guestLabel(res)})${pending.newRoomLabel ? ` a ${pending.newRoomLabel}` : ""}${pending.newArrival ? `, nuevas fechas ${fmtDate(pending.newArrival)} → ${fmtDate(pending.newDeparture!)}` : ""}.`;
      verb = "Mover";
      break;
    case "resize":
      title = "Cambiar fechas";
      body = `Ajustar la salida de ${res.code} (${guestLabel(res)}) a ${fmtDate(pending.newDepartureDate)} (${Math.max(1, diffDays(parseDateOnly(res.arrivalDate), parseDateOnly(pending.newDepartureDate)))} noches).`;
      verb = "Guardar";
      break;
    case "checkin":
      title = "Hacer check-in";
      body = `Registrar la entrada de ${res.code} (${guestLabel(res)}).`;
      verb = "Check-in";
      break;
    case "checkout":
      title = "Hacer check-out";
      body = `Registrar la salida de ${res.code} (${guestLabel(res)}).`;
      verb = "Check-out";
      break;
    case "cancel":
      title = "Cancelar reserva";
      body = `Cancelar ${res.code} (${guestLabel(res)}). Se aplicará la política de cancelación.`;
      verb = "Cancelar reserva";
      danger = true;
      break;
    case "noshow":
      title = "Marcar como no-show";
      body = `Marcar ${res.code} (${guestLabel(res)}) como no-show.`;
      verb = "Marcar no-show";
      danger = true;
      break;
    case "assign":
      title = "Asignar habitación";
      body = `Asignar una habitación a ${res.code} (${guestLabel(res)}).`;
      verb = "Asignar";
      break;
    default:
      body = "";
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={props.onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(11,16,38,0.42)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--surface)", borderRadius: 18, padding: 22, maxWidth: 460, width: "100%", boxShadow: "0 22px 55px rgba(15,23,42,0.32)", display: "grid", gap: 12 }}
      >
        <strong style={{ fontSize: 20, color: "var(--ink)" }}>{title}</strong>
        <p style={{ margin: 0, color: "var(--ink-soft)" }}>{body}</p>

        {pending.type === "assign" ? (
          <label style={{ display: "grid", gap: 4 }}>
            <span className="bo-muted" style={{ textTransform: "none" }}>Habitación</span>
            <select value={props.assignRoomId} onChange={(e) => props.onAssignRoomChange(e.target.value)}>
              <option value="">Seleccionar…</option>
              {props.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  Hab. {room.number}
                  {props.roomTypeById.get(room.roomTypeId)?.name ? ` · ${props.roomTypeById.get(room.roomTypeId)!.name}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {pending.type === "cancel" || pending.type === "noshow" ? (
          <label style={{ display: "grid", gap: 4 }}>
            <span className="bo-muted" style={{ textTransform: "none" }}>Motivo (opcional)</span>
            <input value={props.reason} onChange={(e) => props.onReasonChange(e.target.value)} placeholder="Motivo…" />
          </label>
        ) : null}

        {props.message ? <p style={{ margin: 0, color: props.message === "Hecho." ? "#0a7e57" : "#c2413a", fontWeight: 700 }}>{props.message}</p> : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="bo-button-link" onClick={props.onCancel} disabled={props.busy}>Cancelar</button>
          <button
            type="button"
            className="bo-button-link"
            onClick={props.onConfirm}
            disabled={props.busy}
            style={{ background: danger ? "#c2413a" : "#1d2a73", borderColor: danger ? "#c2413a" : "#1d2a73", color: "#ffffff", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {props.busy ? <Spinner size="sm" /> : null}
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}
