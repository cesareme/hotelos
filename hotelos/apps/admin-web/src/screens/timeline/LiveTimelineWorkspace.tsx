// Cronograma — Recepción › Reservas › Cronograma (/recepcion/reservas/cronograma).
//
// Cocoa 22 · ola 3 · lote 3-A (calendar archetype, template `Calendario`):
// CocoaPage (full bleed, compact density) → CocoaToolbar with the period and
// the scale → filter chips (status, channel) → CocoaScrollArea with a
// grid table (`data-cocoa-grid-table`): sticky date header WITHOUT blur, sticky
// resource column and its own horizontal + vertical scroll with momentum (the
// page never scrolls sideways). Reservation blocks sit inside each room row:
// hover shows a CocoaPopover, click / Enter opens a CocoaDrawer with the
// detail (folio, activity, deep links, quick actions), drag moves the stay and
// dragging the right edge resizes it. Every write (move, resize, check-in,
// check-out, cancel, no-show, assign) passes through a CocoaDialog. Same API
// calls as before; hosted inside ReservasTabs the container paints the title.
// Tanda L3 · lote F1: the cancel / no-show dialogs read the penalty preview
// (GET /reservations/:id/cancellation-charge?mode=) when they open and show
// it before confirming; confirm sends `applyPolicy: true` (L3-B) and the toast
// names the penalty posted and the folio outcome.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { previewCancellationCharge, type ChargeBreakdown } from "../../services/cancellationApi";
import { financeErrorMessage } from "../../services/finance-contracts";
import { lifecycleOutcomeSummary, penaltyPreviewSummary, type LifecycleOutcomeLike } from "../../components/billing/charge-types";
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
import { useTabHost } from "../tabs/TabHost";
import { useToast } from "../../components/Toast";
import { urlForScreen } from "../../navigation/nav-tree";
import { navigateTo } from "../../lib/navigate";
import { channelLabel, date, dateRange, marketSegmentLabel, money, plural, time, type DateStyle } from "../../lib/format";
import { ACTIONS, TIME_LABELS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaInput,
  CocoaPage,
  CocoaPopover,
  CocoaScrollArea,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaStat,
  CocoaState,
  CocoaToolbar,
  openTabPath,
  toneBg,
  toneBorder,
  toneInk,
  type CocoaTone
} from "../../components/cocoa";

// ---------------------------------------------------------------------------
// Date helpers (date-only, UTC, no timezone drift)
// ---------------------------------------------------------------------------
const MS_DAY = 86_400_000;
function parseDateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
function addDays(value: Date, n: number): Date {
  return new Date(value.getTime() + n * MS_DAY);
}
function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_DAY);
}
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
function fmtDate(value: string, style: DateStyle = "dayMonth"): string {
  return date(value, style);
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
const RES_STATUS_TONE: Record<string, CocoaTone> = {
  confirmed: "info",
  checked_in: "success",
  checked_out: "neutral",
  cancelled: "danger",
  no_show: "neutral",
  tentative: "warning",
  pending: "warning"
};
function toneFor(status: string): CocoaTone {
  return RES_STATUS_TONE[status] ?? "info";
}
function statusLabel(status: string): string {
  return RES_STATUS_LABEL[status] ?? status;
}
const ROOM_STATUS_TONE: Record<string, CocoaTone> = {
  clean: "success",
  inspected: "success",
  dirty: "warning",
  occupied: "info",
  vacant: "neutral",
  out_of_order: "danger",
  out_of_service: "danger"
};
const ROOM_STATUS_LABEL: Record<string, string> = {
  clean: "Limpia",
  inspected: "Inspeccionada",
  dirty: "Sucia",
  occupied: "Ocupada",
  vacant: "Libre",
  out_of_order: "Fuera de servicio",
  out_of_service: "Fuera de servicio"
};

type Granularity = "day" | "week" | "month";
const SCALE_OPTIONS = [
  { value: "day", label: "7 días" },
  { value: "week", label: "14 días" },
  { value: "month", label: "30 días" }
];

const UNASSIGNED_ID = "__unassigned__";
const BLOCK_HEIGHT = 46;
const LANE_GAP = 6;
const LEAD_WIDTH = 200;
const GRID_MAX_HEIGHT = 640;

type Resource = { id: string; name: string; resourceType: string; status: string; capacity?: string; subLabel?: string };

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

type QuickAction = "checkin" | "checkout" | "cancel" | "noshow" | "assign";

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

// ---------------------------------------------------------------------------
// Styles (tokens only; layout literals stay inline)
// ---------------------------------------------------------------------------
const tableStyle: CSSProperties = { borderSpacing: 0, minWidth: "max-content" };

const leadHeadStyle: CSSProperties = {
  width: LEAD_WIDTH,
  minWidth: LEAD_WIDTH,
  maxWidth: LEAD_WIDTH,
  boxSizing: "border-box",
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  textAlign: "left",
  verticalAlign: "bottom",
  borderBottom: "1px solid var(--cocoa-separator)",
  borderRight: "1px solid var(--cocoa-separator)"
};

function dayHeadStyle(width: number, isToday: boolean, isWeekend: boolean): CSSProperties {
  return {
    width,
    minWidth: width,
    maxWidth: width,
    boxSizing: "border-box",
    padding: "var(--cocoa-space-2)",
    textAlign: "left",
    verticalAlign: "bottom",
    borderBottom: "1px solid var(--cocoa-separator)",
    borderRight: "1px solid var(--cocoa-separator)",
    background: isToday ? "var(--cocoa-accent-bg)" : isWeekend ? "var(--cocoa-background-grouped)" : "var(--cocoa-background-sidebar)",
    color: isToday ? "var(--cocoa-tone-accent-text)" : "var(--cocoa-label)",
    fontSize: "var(--cocoa-fs-callout)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    lineHeight: "var(--cocoa-lh-callout)"
  };
}

const leadCellStyle: CSSProperties = {
  width: LEAD_WIDTH,
  minWidth: LEAD_WIDTH,
  maxWidth: LEAD_WIDTH,
  boxSizing: "border-box",
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  textAlign: "left",
  verticalAlign: "middle",
  borderBottom: "1px solid var(--cocoa-separator)",
  borderRight: "1px solid var(--cocoa-separator)",
  background: "var(--cocoa-background-content)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"]
};

function laneTdStyle(height: number, minWidth: number): CSSProperties {
  return { padding: 0, position: "relative", height, minWidth, verticalAlign: "top", borderBottom: "1px solid var(--cocoa-separator)" };
}

function laneCellStyle(width: number, isToday: boolean, isWeekend: boolean): CSSProperties {
  return {
    display: "block",
    flex: "0 0 auto",
    width,
    height: "100%",
    boxSizing: "border-box",
    borderRight: "1px solid var(--cocoa-separator)",
    background: isToday ? "var(--cocoa-accent-bg)" : isWeekend ? "var(--cocoa-background-grouped)" : "transparent"
  };
}

function blockStyle(input: { tone: CocoaTone; left: number; top: number; width: number; selected: boolean; dragging: boolean; cancelled: boolean }): CSSProperties {
  return {
    position: "absolute",
    left: input.left,
    top: input.top,
    width: input.width,
    height: BLOCK_HEIGHT,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 2,
    minWidth: 0,
    overflow: "hidden",
    padding: "var(--cocoa-space-1) var(--cocoa-space-2)",
    background: toneBg(input.tone),
    border: `1px ${input.cancelled ? "dashed" : "solid"} ${toneBorder(input.tone)}`,
    color: toneInk(input.tone),
    borderRadius: "var(--cocoa-radius-md)",
    boxShadow: input.dragging ? "var(--cocoa-shadow-floating)" : input.selected ? "0 0 0 2px var(--cocoa-accent)" : "var(--cocoa-shadow-control)",
    cursor: input.dragging ? "grabbing" : "grab",
    userSelect: "none",
    touchAction: "none",
    pointerEvents: input.dragging ? "none" : undefined,
    zIndex: (input.dragging ? "var(--cocoa-z-sticky)" : "var(--cocoa-z-base)") as CSSProperties["zIndex"],
    textAlign: "left"
  };
}

const blockTitleStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  lineHeight: "var(--cocoa-lh-callout)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const blockMetaStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  lineHeight: "var(--cocoa-lh-caption)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const handleStyle: CSSProperties = { position: "absolute", right: 0, top: 0, bottom: 0, width: 10, cursor: "ew-resize" };

const mutedStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-callout)", color: "var(--cocoa-label-secondary)", minWidth: 0 };

const ellipsisStyle: CSSProperties = { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 };

function avatarStyle(tone: CocoaTone): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    flex: "0 0 auto",
    borderRadius: "var(--cocoa-radius-full)",
    background: toneBg(tone),
    color: toneInk(tone),
    fontSize: "var(--cocoa-fs-body)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"]
  };
}

const rangeLabelStyle: CSSProperties = { fontSize: "var(--cocoa-fs-body)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], whiteSpace: "nowrap" };

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export function LiveTimelineWorkspace() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const propertyId = useMemo(() => getActivePropertyId(), []);

  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [granularity, setGranularity] = useState<Granularity>("week");
  const [rangeStart, setRangeStart] = useState<Date>(() => todayUtc());

  const [statusSel, setStatusSel] = useState<string[] | null>(null);
  const [channelSel, setChannelSel] = useState<string[] | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [hover, setHover] = useState<{ res: AdminReservation; anchor: HTMLElement } | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [assignRoomId, setAssignRoomId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // Penalty preview of the cancel / no-show dialog (read only; the API applies the policy on confirm).
  const [penaltyPreview, setPenaltyPreview] = useState<{ loading: boolean; data: ChargeBreakdown | null; error: string | null }>({ loading: false, data: null, error: null });
  const pendingLifecycle = pending && (pending.type === "cancel" || pending.type === "noshow") ? { id: pending.res.id, mode: pending.type === "noshow" ? ("no_show" as const) : ("cancellation" as const) } : null;
  useEffect(() => {
    if (!pendingLifecycle) {
      setPenaltyPreview({ loading: false, data: null, error: null });
      return;
    }
    setPenaltyPreview({ loading: true, data: null, error: null });
    let stale = false;
    previewCancellationCharge(pendingLifecycle.id, pendingLifecycle.mode)
      .then((data) => {
        if (!stale) setPenaltyPreview({ loading: false, data, error: null });
      })
      .catch((err: unknown) => {
        if (!stale) setPenaltyPreview({ loading: false, data: null, error: financeErrorMessage(err, "No se pudo calcular la penalización.") });
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLifecycle?.id, pendingLifecycle?.mode]);

  const dayCount = granularity === "day" ? 7 : granularity === "week" ? 14 : 30;
  const cellWidth = granularity === "month" ? 64 : granularity === "day" ? 150 : 118;
  const rangeEnd = useMemo(() => addDays(rangeStart, dayCount), [rangeStart, dayCount]);

  // ---- data loading -------------------------------------------------------
  // Reservations are fetched for the visible window only (REC-05: overlap
  // filter with one day of margin on each side, up to the API cap); rooms and
  // room types once. If the first window is empty we anchor it on the next
  // upcoming arrival (else the most recent one) so the board never opens
  // blank — done a single time, never in a loop.
  const initializedRef = useRef(false);
  const anchoredRef = useRef(false);
  const [rangeLoading, setRangeLoading] = useState(false);
  // QC-06: a failed refresh keeps the current view but says so.
  const [staleSince, setStaleSince] = useState<{ at: string; message: string } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const rangeQuery = useCallback(
    () => ({ from: toDateOnly(addDays(rangeStart, -1)), to: toDateOnly(addDays(rangeEnd, 1)), limit: 500 }),
    [rangeStart, rangeEnd]
  );

  const load = useCallback(async () => {
    const first = !initializedRef.current;
    if (first) setLoading(true);
    else setRangeLoading(true);
    setError(null);
    try {
      const [res, rms, rts] = await Promise.all([
        fetchReservations(propertyId, rangeQuery()),
        first ? fetchRooms(propertyId) : Promise.resolve(null),
        first ? fetchRoomTypes(propertyId) : Promise.resolve(null)
      ]);
      if (rms) setRooms(rms);
      if (rts) setRoomTypes(rts);
      setReservations(res.items);
      setStaleSince(null);
      initializedRef.current = true;
      if (res.items.length === 0 && !anchoredRef.current) {
        anchoredRef.current = true;
        const upcoming = await fetchReservations(propertyId, { arrivalFrom: toDateOnly(todayUtc()), sort: "arrival_asc", limit: 1 });
        const anchor = upcoming.items[0] ?? (await fetchReservations(propertyId, { sort: "arrival_desc", limit: 1 })).items[0];
        if (anchor) setRangeStart(addDays(parseDateOnly(anchor.arrivalDate), -1));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el cronograma.");
    } finally {
      if (first) setLoading(false);
      else setRangeLoading(false);
    }
  }, [propertyId, rangeQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    try {
      const [rms, res] = await Promise.all([fetchRooms(propertyId), fetchReservations(propertyId, rangeQuery())]);
      setRooms(rms);
      setReservations(res.items);
      setStaleSince(null);
    } catch (err) {
      // Keep the current view, but flag it as stale instead of failing silently.
      setStaleSince({
        at: time(new Date()),
        message: err instanceof Error ? err.message : "No se pudo actualizar el cronograma."
      });
    }
  }, [propertyId, rangeQuery]);

  // ---- detail panel data --------------------------------------------------
  useEffect(() => {
    if (!selectedId) {
      setFolio(null);
      setActivity(null);
      setDetailError(null);
      return;
    }
    let on = true;
    setDetailLoading(true);
    setDetailError(null);
    const describe = (e: unknown) => (e instanceof Error ? e.message : "no disponible");
    const failures: string[] = [];
    Promise.all([
      fetchReservationFolio(selectedId).catch((e: unknown) => {
        failures.push(`folio: ${describe(e)}`);
        return null;
      }),
      fetchGuestActivity(selectedId).catch((e: unknown) => {
        failures.push(`actividad: ${describe(e)}`);
        return null;
      })
    ])
      .then(([f, a]) => {
        if (!on) return;
        setFolio(f);
        setActivity(a);
        setDetailError(failures.length ? `Datos no disponibles — ${failures.join(" · ")}` : null);
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
  const filtersTouched = statusSel !== null || channelSel !== null;
  const resetFilters = () => {
    setStatusSel(null);
    setChannelSel(null);
  };

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
    const built: Array<{ resource: Resource; blocks: Block[]; height: number }> = [];
    const makeRow = (resource: Resource, list: AdminReservation[]) => {
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
          status: room.status,
          capacity: rt?.maxOccupancy ? `${rt.maxOccupancy} pax` : undefined,
          subLabel: room.floor ? `Planta ${room.floor}` : undefined
        },
        visibleReservations.filter((r) => r.assignedRoomId === room.id)
      );
    }
    return built;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const day = addDays(rangeStart, i);
        const key = toDateOnly(day);
        return {
          key,
          label: date(day, "weekdayOnly"),
          sublabel: date(day, "dayMonth"),
          isToday: key === todayKey,
          isWeekend: [0, 6].includes(day.getUTCDay())
        };
      }),
    [rangeStart, dayCount, todayKey]
  );
  const rangeLabel = dateRange(rangeStart, addDays(rangeStart, dayCount - 1));
  const goToday = () => setRangeStart(todayUtc());

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
      // move: detect target room row + day shift (the dragged block ignores
      // pointer events, so the row under the pointer is the drop target).
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
      let done = dialogCopy(pending).done;
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
      } else if (pending.type === "cancel" || pending.type === "noshow") {
        // Tanda L3 (lote B): `applyPolicy` posts the penalty line and closes the
        // folio at balance 0; the answer carries `cancellation` (not declared
        // by the shared client type, narrowed here).
        const request = pending.type === "cancel" ? cancelReservation(pending.res.id, reason.trim(), { applyPolicy: true }) : noShowReservation(pending.res.id, reason.trim(), { applyPolicy: true });
        const result = (await request) as AdminReservation & { cancellation?: LifecycleOutcomeLike };
        done = lifecycleOutcomeSummary(pending.type === "noshow" ? "no_show" : "cancellation", result.cancellation ?? null, (amount) => money(amount, pending.res.currency));
      } else if (pending.type === "assign") {
        if (!assignRoomId) throw new Error("Selecciona una habitación.");
        await assignReservationRoom(pending.res.id, { roomId: assignRoomId });
      }
      await refresh();
      showToast(done, { variant: "success" });
      setPending(null);
      setReason("");
      setAssignRoomId("");
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  function cancelPending() {
    setPending(null);
    setActionMsg(null);
  }

  function startAction(type: QuickAction, res: AdminReservation) {
    setActionMsg(null);
    setAssignRoomId("");
    setReason("");
    setPending({ type, res });
  }

  // Detalle de la reserva: /recepcion/reservas/:id (tab of the Reservas container, Tanda 5).
  function openReservation(id: string) {
    const url = urlForScreen("ReservationDetailWorkspace", { id });
    if (url) openTabPath(url);
  }
  function openJourney(id: string) {
    const url = urlForScreen("GuestJourneyWorkspace", { id });
    if (url) openTabPath(url);
  }

  const pageState = loading ? "loading" : error ? "error" : "ready";
  const hoverTone = hover ? toneFor(hover.res.status) : "info";
  const hoverRoom = hover?.res.assignedRoomId ? roomById.get(hover.res.assignedRoomId) : undefined;
  const dialog = pending ? dialogCopy(pending) : null;

  // ---- render -------------------------------------------------------------
  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title="Cronograma"
      subtitle={
        hosted
          ? undefined
          : "Reservas y habitaciones reales: pasa el ratón por un bloque para ver su ficha rápida, haz clic para abrir el detalle y arrastra para mover o alargar la estancia."
      }
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={rangeLoading} onClick={() => void refresh()}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      fullBleed
      density="compact"
      state={pageState}
      skeleton={<CocoaSkeleton variant="chart" height={420} />}
      error={{ title: "No se pudo cargar el cronograma", message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "cronograma-refresh", label: "Actualizar cronograma", run: () => void refresh() },
        { id: "cronograma-today", label: "Cronograma: ir a hoy", run: goToday }
      ]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Periodo y escala del cronograma"
        leftSlot={
          <>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setRangeStart(addDays(rangeStart, -dayCount))}>
              {ACTIONS.previous}
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={goToday}>
              {TIME_LABELS.today}
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setRangeStart(addDays(rangeStart, dayCount))}>
              {ACTIONS.next}
            </CocoaButton>
            <strong style={rangeLabelStyle}>{rangeLabel}</strong>
          </>
        }
        rightSlot={
          <CocoaSegmentedControl
            value={granularity}
            onChange={(value) => setGranularity(value as Granularity)}
            options={SCALE_OPTIONS}
            size="small"
            aria-label="Escala del cronograma"
          />
        }
      />

      {reservations.length > 0 ? (
        <div className="cocoa-row" data-gap="2" role="group" aria-label="Filtros del cronograma">
          <span className="cocoa-caption">Estado</span>
          {statusesPresent.map((status) => {
            const active = effStatus.includes(status);
            return (
              <CocoaButton
                key={status}
                variant={active ? "tinted" : "bordered"}
                tone={active ? "accent" : "neutral"}
                size="small"
                aria-pressed={active}
                onClick={() => toggleStatus(status)}
              >
                {statusLabel(status)} · {reservations.filter((r) => r.status === status).length}
              </CocoaButton>
            );
          })}
          {channelsPresent.length > 0 ? <span className="cocoa-caption">Canal</span> : null}
          {channelsPresent.map((channel) => {
            const active = effChannel.includes(channel);
            return (
              <CocoaButton
                key={channel}
                variant={active ? "tinted" : "bordered"}
                tone={active ? "accent" : "neutral"}
                size="small"
                aria-pressed={active}
                title={channel}
                onClick={() => toggleChannel(channel)}
              >
                {channelLabel(channel)} · {reservations.filter((r) => r.channel === channel).length}
              </CocoaButton>
            );
          })}
          {filtersTouched ? (
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={resetFilters}>
              {ACTIONS.clearFilters}
            </CocoaButton>
          ) : null}
        </div>
      ) : null}

      <div className="cocoa-row" data-gap="2" data-justify="between">
        <span className="cocoa-cluster">
          <CocoaBadge tone="neutral">{plural(rooms.length, "habitación", "habitaciones")}</CocoaBadge>
          <CocoaBadge tone="neutral">{plural(visibleReservations.length, "reserva visible", "reservas visibles")}</CocoaBadge>
          {overbookingCount > 0 ? <CocoaBadge tone="danger">{plural(overbookingCount, "solape", "solapes")} en la misma habitación</CocoaBadge> : null}
          {rangeLoading ? (
            <CocoaBadge tone="info" variant="dot">
              Cargando periodo…
            </CocoaBadge>
          ) : null}
        </span>
        {selected ? (
          <CocoaBadge tone="accent" variant="dot">
            Selección: {selected.code} · {guestLabel(selected)}
          </CocoaBadge>
        ) : (
          <CocoaBadge tone="neutral" variant="dot">
            Sin selección
          </CocoaBadge>
        )}
      </div>

      {staleSince ? (
        <CocoaCallout
          tone="warning"
          role="status"
          title={`Datos desactualizados desde ${staleSince.at}`}
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refresh()}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {staleSince.message}
        </CocoaCallout>
      ) : null}

      {rows.length === 0 ? (
        <CocoaSection aria-label="Sin datos en el periodo">
          <CocoaState
            kind="empty"
            illustration="search"
            title="Sin datos para mostrar"
            message="No hay habitaciones ni reservas en este periodo. Cambia el periodo o los filtros."
            primaryAction={{ label: `Ir a ${TIME_LABELS.today.toLowerCase()}`, onClick: goToday }}
            secondaryAction={filtersTouched ? { label: ACTIONS.clearFilters, onClick: resetFilters } : undefined}
          />
        </CocoaSection>
      ) : (
        <CocoaScrollArea axis="both" stickyFirstColumn maxHeight={GRID_MAX_HEIGHT} aria-label="Cronograma de reservas por habitación">
          <table data-cocoa-grid-table className="cocoa-tabular" style={tableStyle}>
            <thead>
              <tr>
                <th scope="col" style={leadHeadStyle}>
                  <span className="cocoa-caption">Recurso</span>
                </th>
                {days.map((day) => (
                  <th key={day.key} scope="col" style={dayHeadStyle(cellWidth, day.isToday, day.isWeekend)} aria-current={day.isToday ? "date" : undefined}>
                    <span className="cocoa-caption" style={{ display: "block" }}>
                      {day.label}
                    </span>
                    {day.sublabel}
                    {day.isToday ? ` · ${TIME_LABELS.today.toLowerCase()}` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const roomTone = ROOM_STATUS_TONE[row.resource.status] ?? "neutral";
                const roomStatus = ROOM_STATUS_LABEL[row.resource.status] ?? row.resource.status;
                return (
                  <tr key={row.resource.id} data-room-id={row.resource.id}>
                    <th scope="row" style={leadCellStyle}>
                      <CocoaBadge tone={roomTone} variant="dot" title={roomStatus} aria-label={`${row.resource.name}, ${roomStatus}`}>
                        {row.resource.name}
                      </CocoaBadge>
                      <span style={mutedStyle}>
                        {row.resource.resourceType}
                        {row.resource.capacity ? ` · ${row.resource.capacity}` : ""}
                      </span>
                      {row.resource.subLabel ? <span style={mutedStyle}>{row.resource.subLabel}</span> : null}
                    </th>
                    <td colSpan={dayCount} style={laneTdStyle(row.height, dayCount * cellWidth)}>
                      <div aria-hidden="true" style={{ display: "flex", height: "100%" }}>
                        {days.map((day) => (
                          <span key={day.key} style={laneCellStyle(cellWidth, day.isToday, day.isWeekend)} />
                        ))}
                      </div>
                      {row.blocks.map((b) => (
                        <ReservationBlockView
                          key={b.res.id}
                          block={b}
                          cellWidth={cellWidth}
                          selected={selectedId === b.res.id}
                          drag={drag?.id === b.res.id ? drag : null}
                          onPointerDownMove={(e) => beginDrag(b.res, "move", e)}
                          onPointerDownResize={(e) => beginDrag(b.res, "resize", e)}
                          onHover={(anchor) => setHover({ res: b.res, anchor })}
                          onHoverEnd={() => setHover((h) => (h?.res.id === b.res.id ? null : h))}
                          onKeyboardSelect={() => setSelectedId(b.res.id)}
                        />
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CocoaScrollArea>
      )}

      {/* Hover card (fixed layer, escapes the scroll area) */}
      <CocoaPopover open={hover !== null && drag === null} anchorEl={hover?.anchor ?? null} placement="top" onClose={() => setHover(null)} role="tooltip" aria-label="Ficha rápida de la reserva">
        {hover ? (
          <div className="cocoa-stack" data-gap="2" style={{ width: 280, maxWidth: "80vw" }}>
            <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
              <span aria-hidden="true" style={avatarStyle(hoverTone)}>
                {initials(guestLabel(hover.res))}
              </span>
              <span style={{ minWidth: 0 }}>
                <strong style={ellipsisStyle}>{guestLabel(hover.res)}</strong>
                <span style={mutedStyle}>{hover.res.code}</span>
              </span>
            </div>
            <span className="cocoa-cluster">
              <CocoaBadge tone={hoverTone}>{statusLabel(hover.res.status)}</CocoaBadge>
              {hover.res.channel ? (
                <CocoaBadge tone="neutral" title={hover.res.channel}>
                  {channelLabel(hover.res.channel)}
                </CocoaBadge>
              ) : null}
              <CocoaBadge tone="neutral">{hoverRoom ? `Hab. ${hoverRoom.number}` : "Sin habitación"}</CocoaBadge>
            </span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--cocoa-space-2)" }}>
              <CocoaStat label="Entrada" value={fmtDate(hover.res.arrivalDate, "weekdayShort")} tabular={false} />
              <CocoaStat label="Salida" value={fmtDate(hover.res.departureDate, "weekdayShort")} tabular={false} />
              <CocoaStat label="Noches" value={`${nightsOf(hover.res)}`} />
              <CocoaStat label="Ocupación" value={`${hover.res.adults}A${hover.res.children ? ` · ${hover.res.children}N` : ""}`} />
              <CocoaStat label="Importe" value={money(hover.res.totalAmount, hover.res.currency)} />
              <CocoaStat
                label="Segmento"
                value={hover.res.marketSegment ? marketSegmentLabel(hover.res.marketSegment) : channelLabel(hover.res.sourceCode)}
                tabular={false}
              />
            </div>
            <span style={mutedStyle}>Haz clic para ver el detalle completo</span>
          </div>
        ) : null}
      </CocoaPopover>

      {/* Detail drawer (bottom sheet on phones) */}
      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected ? selected.code : "Reserva"}
        subtitle={selected ? `${guestLabel(selected)} · ${selectedRoom ? `Hab. ${selectedRoom.number}` : "Sin habitación"}` : undefined}
        side="right"
        size="lg"
        footer={
          selected ? (
            <>
              <CocoaButton variant="plain" tone="neutral" onClick={() => setSelectedId(null)}>
                {ACTIONS.close}
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" onClick={() => openReservation(selected.id)}>
                Abrir reserva
              </CocoaButton>
            </>
          ) : undefined
        }
      >
        {selected ? (
          <DetailPanel
            res={selected}
            room={selectedRoom}
            folio={folio}
            activity={activity}
            loading={detailLoading}
            error={detailError}
            onOpenJourney={() => openJourney(selected.id)}
            onAction={(type) => startAction(type, selected)}
          />
        ) : null}
      </CocoaDrawer>

      {/* Confirmation of every write */}
      {pending && dialog ? (
        <CocoaDialog
          open
          onClose={cancelPending}
          title={dialog.title}
          description={dialog.body}
          tone={dialog.danger ? "destructive" : "primary"}
          confirmLabel={dialog.verb}
          cancelLabel={ACTIONS.cancel}
          busy={busy}
          confirmDisabled={(pending.type === "assign" && !assignRoomId) || ((pending.type === "cancel" || pending.type === "noshow") && !reason.trim())}
          initialFocus={
            pending.type === "assign" || pending.type === "cancel" || pending.type === "noshow"
              ? () => document.getElementById(pending.type === "assign" ? "cronograma-assign-room" : "cronograma-reason")
              : undefined
          }
          onConfirm={applyPending}
        >
          {pending.type === "assign" ? (
            <CocoaField label="Habitación" required>
              <CocoaSelect
                id="cronograma-assign-room"
                value={assignRoomId}
                onChange={setAssignRoomId}
                placeholder="Seleccionar…"
                options={sortedRooms.map((room) => ({
                  value: room.id,
                  label: `Hab. ${room.number}${roomTypeById.get(room.roomTypeId)?.name ? ` · ${roomTypeById.get(room.roomTypeId)!.name}` : ""}`
                }))}
              />
            </CocoaField>
          ) : null}
          {pending.type === "cancel" || pending.type === "noshow" ? (
            <>
              {penaltyPreview.loading ? (
                <CocoaState kind="loading" inline title="Calculando la penalización prevista…" />
              ) : (
                <CocoaCallout
                  tone={penaltyPreview.error ? "warning" : penaltyPreview.data && penaltyPreview.data.amount > 0 && !penaltyPreview.data.withinFreeWindow ? "warning" : "info"}
                  title={penaltyPreview.data ? (penaltyPreview.data.policyName ? `Política «${penaltyPreview.data.policyName}»` : "Sin política de cancelación") : "Penalización no calculada"}
                  role="status"
                >
                  {penaltyPreview.error ?? penaltyPreviewSummary(pending.type === "noshow" ? "no_show" : "cancellation", penaltyPreview.data, (amount) => money(amount, pending.res.currency))}
                  {penaltyPreview.data?.label ? ` ${penaltyPreview.data.label}` : ""}
                </CocoaCallout>
              )}
              <CocoaField label="Motivo" required help="Queda en la auditoría de la reserva (la misma regla que la ficha de la reserva).">
                <CocoaInput id="cronograma-reason" value={reason} onChange={setReason} placeholder={pending.type === "cancel" ? "El huésped anula el viaje" : "No se ha presentado ni ha avisado"} maxLength={1000} />
              </CocoaField>
            </>
          ) : null}
          {actionMsg ? (
            <CocoaCallout tone="danger" role="alert">
              {actionMsg}
            </CocoaCallout>
          ) : null}
        </CocoaDialog>
      ) : null}
    </CocoaPage>
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
  onHover: (anchor: HTMLElement) => void;
  onHoverEnd: () => void;
  onKeyboardSelect: () => void;
}) {
  const { block, cellWidth, selected, drag } = props;
  const res = block.res;
  const tone = toneFor(res.status);
  const moveDx = drag?.mode === "move" ? drag.dx : 0;
  const moveDy = drag?.mode === "move" ? drag.dy : 0;
  const resizeDx = drag?.mode === "resize" ? drag.dx : 0;
  const left = block.clippedOffset * cellWidth + 4 + moveDx;
  const top = block.lane * (BLOCK_HEIGHT + LANE_GAP) + LANE_GAP + moveDy;
  const width = Math.max(40, block.clippedSpan * cellWidth - 8 + resizeDx);
  const nights = nightsOf(res);

  return (
    <div
      role="button"
      tabIndex={0}
      className="cocoa-focus-ring"
      aria-label={`Reserva ${res.code} de ${guestLabel(res)}, ${statusLabel(res.status)}`}
      aria-pressed={selected}
      onPointerDown={props.onPointerDownMove}
      onMouseEnter={(e) => props.onHover(e.currentTarget)}
      onMouseLeave={props.onHoverEnd}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onKeyboardSelect();
        }
      }}
      style={blockStyle({ tone, left, top, width, selected, dragging: drag !== null, cancelled: res.status === "cancelled" })}
    >
      <strong style={blockTitleStyle}>
        {block.continuesLeft ? "‹ " : ""}
        {guestLabel(res)}
        {block.continuesRight ? " ›" : ""}
      </strong>
      <small style={blockMetaStyle}>
        {statusLabel(res.status)} · {plural(nights, "noche", "noches")} · {money(res.totalAmount, res.currency)}
      </small>
      {/* resize handle (right edge) */}
      <span onPointerDown={props.onPointerDownResize} aria-hidden="true" style={handleStyle} />
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
  /** Folio / activity fetch failures (QC-06): shown inline, never as blank facts. */
  error?: string | null;
  onOpenJourney: () => void;
  onAction: (type: QuickAction) => void;
}) {
  const { res, room, folio, activity } = props;
  const pendingValue = props.loading ? "…" : "—";
  const facts: Array<[string, string]> = [
    ["Estado", statusLabel(res.status)],
    ["Huésped", guestLabel(res)],
    ["Entrada", fmtDate(res.arrivalDate, "weekdayShort")],
    ["Salida", fmtDate(res.departureDate, "weekdayShort")],
    ["Noches", `${nightsOf(res)}`],
    ["Ocupación", `${plural(res.adults, "adulto", "adultos")}${res.children ? ` · ${plural(res.children, "niño", "niños")}` : ""}`],
    ["Habitación", room ? `Hab. ${room.number}` : "Sin asignar"],
    ["Canal", channelLabel(res.channel)],
    ["Importe total", money(res.totalAmount, res.currency)],
    ["Saldo pendiente", folio ? money(folio.balanceDue, folio.folio.currency) : pendingValue],
    ["Cobros", folio ? `${money(folio.paymentsTotal, folio.folio.currency)} · ${folio.payments.length}` : pendingValue],
    ["Actividad abierta", activity ? `${activity.counts.openTotal} abiertas · ${plural(activity.counts.messages, "mensaje", "mensajes")}` : pendingValue]
  ];

  const links: Array<{ label: string; onClick: () => void }> = [
    { label: "Recorrido del huésped", onClick: props.onOpenJourney },
    { label: "Folio y facturación", onClick: () => navigateTo("BillingCenter") },
    { label: "Limpieza", onClick: () => navigateTo("HousekeepingDashboard") },
    { label: "Mantenimiento", onClick: () => navigateTo("MaintenanceDashboard") },
    { label: "Mensajes", onClick: () => navigateTo("ConciergeInboxDashboard") }
  ];

  const isIn = res.status === "checked_in";
  const isOut = res.status === "checked_out";
  const isClosed = res.status === "cancelled" || res.status === "no_show";
  const tone = toneFor(res.status);

  return (
    <div className="cocoa-stack" data-gap="4">
      {props.error ? (
        <CocoaCallout tone="warning" role="status">
          {props.error}
        </CocoaCallout>
      ) : null}
      <span className="cocoa-cluster">
        <CocoaBadge tone={tone}>{statusLabel(res.status)}</CocoaBadge>
        {res.channel ? (
          <CocoaBadge tone="neutral" title={res.channel}>
            {channelLabel(res.channel)}
          </CocoaBadge>
        ) : null}
        <CocoaBadge tone="neutral">{room ? `Hab. ${room.number}` : "Sin habitación"}</CocoaBadge>
        <CocoaBadge tone="neutral">{plural(nightsOf(res), "noche", "noches")}</CocoaBadge>
      </span>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--cocoa-space-3)" }}>
        {facts.map(([label, value]) => (
          <CocoaStat key={label} label={label} value={value} tabular={false} />
        ))}
      </div>

      {activity && activity.items.length > 0 ? (
        <CocoaSection title="Actividad reciente" meta={plural(activity.items.length, "evento", "eventos")}>
          <ul className="c22-section__list">
            {activity.items.slice(0, 4).map((item) => (
              <li key={item.id}>
                <span style={ellipsisStyle}>{item.title}</span>
                <CocoaBadge tone={item.open ? "warning" : "success"} size="small">
                  {item.open ? "abierta" : "cerrada"}
                </CocoaBadge>
              </li>
            ))}
          </ul>
        </CocoaSection>
      ) : null}

      <CocoaSection title="Ir a">
        <div className="cocoa-row" data-gap="2">
          {links.map((link) => (
            <CocoaButton key={link.label} variant="plain" tone="accent" size="small" onClick={link.onClick}>
              {link.label}
            </CocoaButton>
          ))}
        </div>
      </CocoaSection>

      <CocoaSection title="Acciones">
        <div className="cocoa-row" data-gap="2">
          <CocoaButton variant="tinted" tone="accent" size="small" disabled={isIn || isOut || isClosed} onClick={() => props.onAction("checkin")}>
            Check-in
          </CocoaButton>
          <CocoaButton variant="tinted" tone="accent" size="small" disabled={!isIn} onClick={() => props.onAction("checkout")}>
            Check-out
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" disabled={isClosed} onClick={() => props.onAction("assign")}>
            Asignar habitación
          </CocoaButton>
          <CocoaButton variant="bordered" tone="destructive" size="small" disabled={isClosed} onClick={() => props.onAction("cancel")}>
            Cancelar reserva
          </CocoaButton>
          <CocoaButton variant="bordered" tone="destructive" size="small" disabled={isClosed || isIn || isOut} onClick={() => props.onAction("noshow")}>
            Marcar no-show
          </CocoaButton>
        </div>
      </CocoaSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy of the confirmation dialog per pending action
// ---------------------------------------------------------------------------
function dialogCopy(pending: Pending): { title: string; body: string; verb: string; done: string; danger: boolean } {
  const res = pending.res;
  const who = `${res.code} (${guestLabel(res)})`;
  switch (pending.type) {
    case "move":
      return {
        title: "Mover reserva",
        body: `Mover ${who}${pending.newRoomLabel ? ` a ${pending.newRoomLabel}` : ""}${pending.newArrival && pending.newDeparture ? `, nuevas fechas ${dateRange(pending.newArrival, pending.newDeparture, { style: "dayMonth" })}` : ""}.`,
        verb: "Mover",
        done: "Reserva movida.",
        danger: false
      };
    case "resize": {
      const nights = Math.max(1, diffDays(parseDateOnly(res.arrivalDate), parseDateOnly(pending.newDepartureDate)));
      return {
        title: "Cambiar fechas",
        body: `Ajustar la salida de ${who} a ${fmtDate(pending.newDepartureDate)} (${plural(nights, "noche", "noches")}).`,
        verb: ACTIONS.save,
        done: "Fechas actualizadas.",
        danger: false
      };
    }
    case "checkin":
      return { title: "Hacer check-in", body: `Registrar la entrada de ${who}.`, verb: "Check-in", done: "Check-in registrado.", danger: false };
    case "checkout":
      return { title: "Hacer check-out", body: `Registrar la salida de ${who}.`, verb: "Check-out", done: "Check-out registrado.", danger: false };
    case "cancel":
      return {
        title: "Cancelar reserva",
        body: `Cancelar ${who}. Se aplicará la política de cancelación.`,
        verb: "Cancelar reserva",
        done: "Reserva cancelada.",
        danger: true
      };
    case "noshow":
      return { title: "Marcar como no-show", body: `Marcar ${who} como no-show.`, verb: "Marcar no-show", done: "No-show registrado.", danger: true };
    case "assign":
    default:
      return { title: "Asignar habitación", body: `Asignar una habitación a ${who}.`, verb: ACTIONS.assign, done: "Habitación asignada.", danger: false };
  }
}
