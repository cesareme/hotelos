// Live Timeline — Hoy (Tanda TL · lote TL-5 + corrección 1).
//
// Visor de reservas en casa y proyectadas por habitación: composición de la
// pantalla sobre el motor puro (./timeline-engine, TL-1) y los componentes de
// presentación (../../components/timeline, TL-2/3/4). Aquí viven la carga por
// rango visible (paginando el sobre del API hasta agotar `nextCursor`), el
// «hoy» de referencia (fecha de negocio de la propiedad o el día local si el
// cierre nocturno va por detrás, como el check-in del API), los filtros, la
// resolución de nombres de huésped (con degradación honesta del 403), las
// acciones (todas pasan por el diálogo de confirmación: `applyPending` es el
// único sitio que escribe, además de `onUndo`), deshacer, el teclado global y
// la única live region de la página.
//
// Selección ≠ detalle: las flechas y el clic seleccionan (`selectedId`,
// aria-pressed + badge); el clic, Intro y Espacio además abren el inspector
// (`inspectorOpen`), que es un panel acoplado NO modal a la derecha de la
// parrilla (hoja inferior en teléfonos). Escape cierra en orden: diálogo →
// selección de celdas → detalle (devolviendo el foco a la barra) → selección.
// Una sola voz por resultado: el cambio deshacible lo anuncia la barra de
// deshacer (role=status); el resto, el toast (role=status); la live region
// solo anuncia la selección. Sin estilos en línea: la geometría dinámica vive
// en TimelineGrid y las clases `tl-*` en styles/cocoa-22-timeline.css. Alojada
// en un contenedor de pestañas, el contenedor pinta el título (useTabHost).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../styles/cocoa-22-timeline.css"; // Tanda TL: gancho temporal; el orquestador la mueve a src/styles.css (nueva línea 26, tras cocoa-22-guide.css y antes de mobile.css)
import { getActivePropertyId } from "../../services/activeProperty";
import {
  assignReservationRoom,
  balanceDueConflict,
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
import { fetchNightAuditBusinessDate } from "../../services/posApi";
import { fetchGuest } from "../../services/guestsApi";
import { guestFullName, pendingGuestIds } from "../reservations/reservation-guest-label";
import { useTabHost } from "../tabs/TabHost";
import { useToast } from "../../components/Toast";
import { urlForScreen } from "../../navigation/nav-tree";
import { navigateTo } from "../../lib/navigate";
import { channelLabel, date, dateRange, plural, time } from "../../lib/format";
import { ACTIONS, TIME_LABELS } from "../../content/actions";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { LIVE_TIMELINE_INSTRUCTIONS } from "../../content/screen-instructions/timeline";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaLiveRegion,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  openTabPath,
  useIsNarrow
} from "../../components/cocoa";
import {
  CHECKIN_NEEDS_ROOM,
  TimelineActionDialog,
  TimelineCreateDialog,
  TimelineDateSelector,
  TimelineFilterBar,
  TimelineGapAlert,
  TimelineGrid,
  TimelineInspector,
  TimelineLegend,
  TimelineUndoBar,
  dialogCopy,
  type TimelineConfirmInput,
  type TimelineConflict,
  type TimelineCreateSelection,
  type TimelineFilterGroup,
  type TimelineFilterOption,
  type TimelineGridHandle,
  type TimelineInspectorAction,
  type TimelineOpenVia
} from "../../components/timeline";
import {
  DEFAULT_FILTERS,
  HIDDEN_GUEST_LABEL,
  IN_HOUSE_UNDO_DONE_MESSAGE,
  RES_STATUS_LABEL,
  UNKNOWN_CONFLICT_MESSAGE,
  addDays,
  anchorForToday,
  availabilityByType,
  barKind,
  buildRows,
  columnsFor,
  conflictCode,
  conflictMessage,
  effectiveFilters,
  filtersTouched,
  guestLabel,
  isForbidden,
  isNotFound,
  matchesFilters,
  newReservationSearch,
  overbookingDays,
  parseDateOnly,
  patchFor,
  rangeFor,
  referenceToday,
  roomOverlapCount,
  selectionDates,
  sellableByType,
  toDateOnly,
  todayLocalIso,
  undoEntryFor,
  type CellSelection,
  type Granularity,
  type PendingChange,
  type TimelineFilters,
  type TimelineRange,
  type UndoEntry
} from "./timeline-engine";

// ---------------------------------------------------------------------------
// Copy y constantes de la pantalla
// ---------------------------------------------------------------------------

export const LIVE_TIMELINE_TITLE = "Live Timeline";
export const LIVE_TIMELINE_SUBTITLE =
  "Pasa el ratón por un bloque para ver su ficha rápida, haz clic para abrir el detalle con folio y actividad, y arrastra para mover o redimensionar la estancia. Las acciones críticas piden confirmación antes de ejecutarse.";
export const FORBIDDEN_TITLE = "Tu perfil no puede leer reservas";
export const FORBIDDEN_MESSAGE = "Pide acceso a dirección para ver el Live Timeline.";
export const GUESTS_HIDDEN_TITLE = "Nombres de huésped no visibles";
export const GUESTS_HIDDEN_MESSAGE = "Tu perfil no puede leer las fichas de huésped: los bloques muestran «Huésped no visible». Pide acceso a dirección.";
export const LOAD_ERROR_TITLE = "No se pudo cargar el Live Timeline";
export const LOAD_ERROR_MESSAGE = "No se pudo cargar el Live Timeline.";
export const REFRESH_ERROR_MESSAGE = "No se pudo actualizar el Live Timeline.";
export const UNDO_DONE_MESSAGE = "Cambio deshecho.";
export const UNDO_ERROR_MESSAGE = "No se pudo deshacer el cambio.";
export const UNDO_NO_ROOM_MESSAGE = "No se puede deshacer: la reserva no tenía habitación asignada.";
export const ASSIGN_NEEDS_ROOM = "Selecciona una habitación.";
export const NO_ROOM_LABEL = "Sin habitación";
export const NO_MATCH_TITLE = "Sin reservas que coincidan";
export const NO_MATCH_MESSAGE = "Ninguna reserva del periodo pasa los filtros o la búsqueda; las habitaciones se muestran vacías.";
export const NO_RESERVATIONS_TITLE = "Sin reservas en este periodo";
export const NO_RESERVATIONS_MESSAGE = "No hay reservas que toquen estas fechas. Cambia el periodo o crea una reserva seleccionando celdas.";
export const NEW_RESERVATION_FALLBACK_URL = "/recepcion/reservas/nueva";

/** Páginas del sobre del API que se encadenan como máximo por rango (500 ítems cada una). */
export const MAX_RANGE_PAGES = 10;
export const RANGE_PAGE_LIMIT = 500;
/** Nombres de huésped resueltos por lotes para no abrir cientos de peticiones a la vez. */
export const GUEST_BATCH_SIZE = 20;
const GRID_HEIGHT_NARROW = 480;
const GRID_HEIGHT = 640;

type StaleInfo = { at: string; message: string };

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Reservas que tocan el rango (una noche de margen a cada lado), paginando el sobre hasta agotar `nextCursor`. */
async function fetchRangeReservations(propertyId: string, range: Pick<TimelineRange, "start" | "end">): Promise<AdminReservation[]> {
  const from = toDateOnly(addDays(range.start, -1));
  const to = toDateOnly(addDays(range.end, 1));
  const items: AdminReservation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_RANGE_PAGES; page++) {
    const result = await fetchReservations(propertyId, { from, to, limit: RANGE_PAGE_LIMIT, cursor });
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

/** Opciones de un grupo de filtros con recuento, en orden de aparición. */
function countOptions(reservations: ReadonlyArray<AdminReservation>, pick: (res: AdminReservation) => string | undefined, label: (id: string) => string): TimelineFilterOption[] {
  const counts = new Map<string, number>();
  for (const res of reservations) {
    const id = pick(res);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Array.from(counts, ([id, count]) => ({ id, label: label(id), count }));
}

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

export function LiveTimeline() {
  const hosted = useTabHost() !== null;
  const narrow = useIsNarrow();
  const { showToast } = useToast();
  const propertyId = useMemo(() => getActivePropertyId(), []);

  // ---- datos base ---------------------------------------------------------
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [todayKey, setTodayKey] = useState<string>(() => todayLocalIso());
  /** Fecha de negocio que expone el API (null si no responde); se avisa cuando va por detrás de hoy. */
  const [businessDateKey, setBusinessDateKey] = useState<string | null>(null);
  const [baseLoaded, setBaseLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [staleSince, setStaleSince] = useState<StaleInfo | null>(null);

  // ---- vista --------------------------------------------------------------
  const [granularity, setGranularity] = useState<Granularity>("week");
  const [anchor, setAnchor] = useState<Date>(() => anchorForToday(todayLocalIso()));
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /** Sube cada vez que el detalle se abre con teclado: el panel toma el foco. */
  const [focusToken, setFocusToken] = useState(0);
  const [liveMessage, setLiveMessage] = useState("");
  const gridHandle = useRef<TimelineGridHandle | null>(null);

  // ---- acciones -----------------------------------------------------------
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<TimelineConflict | null>(null);
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const [cellSel, setCellSel] = useState<TimelineCreateSelection | null>(null);

  // ---- detalle de la reserva abierta ---------------------------------------
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [folioMissing, setFolioMissing] = useState(false);
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // ---- nombres de huésped -------------------------------------------------
  const [guestNames, setGuestNames] = useState<Record<string, string>>({});
  /** Algún GET /guests/:id respolvió 403: el perfil no tiene guests.read (callout). */
  const [guestsForbidden, setGuestsForbidden] = useState(false);
  const requestedGuestIds = useRef(new Set<string>());

  // Secuencia de peticiones de rango (descarta respuestas tardías), primera
  // carga y anclaje único en la próxima llegada cuando el rango sale vacío.
  const requestSeq = useRef(0);
  const initializedRef = useRef(false);
  const anchoredRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ---- rango y columnas ---------------------------------------------------
  const range = useMemo(() => rangeFor(anchor, granularity, { narrow }), [anchor, granularity, narrow]);
  const columns = useMemo(() => columnsFor(range, todayKey), [range, todayKey]);
  const rangeLabel = dateRange(range.start, addDays(range.start, range.dayCount - 1));

  // ---- carga base: habitaciones, tipos y fecha de negocio ------------------
  const loadBase = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    setBaseLoaded(false);
    initializedRef.current = false;
    try {
      const [rms, rts, businessDate] = await Promise.all([
        fetchRooms(propertyId),
        fetchRoomTypes(propertyId),
        // fallback a la fecha local si el API de fecha de negocio no responde (403/red)
        fetchNightAuditBusinessDate(propertyId).catch(() => null)
      ]);
      if (!mounted.current) return;
      // Si el 403 es solo de la fecha de negocio se usa el fallback sin avisar en pantalla.
      // «Hoy» = max(fecha de negocio, día local): la misma referencia que el check-in del API.
      const key = referenceToday(businessDate?.currentDate, todayLocalIso());
      setRooms(rms);
      setRoomTypes(rts);
      setTodayKey(key);
      setBusinessDateKey(businessDate?.currentDate ?? null);
      setAnchor(anchorForToday(key));
      setBaseLoaded(true);
    } catch (err) {
      if (!mounted.current) return;
      if (isForbidden(err)) setForbidden(true);
      else setError(describeError(err, LOAD_ERROR_MESSAGE));
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  // ---- carga por rango visible --------------------------------------------
  const loadRange = useCallback(async () => {
    const seq = ++requestSeq.current;
    const first = !initializedRef.current;
    if (!first) setRangeLoading(true);
    try {
      const items = await fetchRangeReservations(propertyId, range);
      if (!mounted.current || seq !== requestSeq.current) return;
      setReservations(items);
      setStaleSince(null);
      if (first) {
        initializedRef.current = true;
        if (items.length === 0 && !anchoredRef.current) {
          // Una sola vez: si el rango inicial sale vacío, anclar en la próxima
          // llegada desde hoy o, si no hay, en la más reciente.
          anchoredRef.current = true;
          const upcoming = await fetchReservations(propertyId, { arrivalFrom: todayKey, sort: "arrival_asc", limit: 1 });
          const target = upcoming.items[0] ?? (await fetchReservations(propertyId, { sort: "arrival_desc", limit: 1 })).items[0];
          if (!mounted.current || seq !== requestSeq.current) return;
          if (target) setAnchor(addDays(parseDateOnly(target.arrivalDate), -1));
        }
      }
    } catch (err) {
      if (!mounted.current || seq !== requestSeq.current) return;
      if (isForbidden(err)) setForbidden(true);
      else if (first) setError(describeError(err, LOAD_ERROR_MESSAGE));
      else setStaleSince({ at: time(new Date()), message: describeError(err, REFRESH_ERROR_MESSAGE) });
    } finally {
      if (mounted.current && seq === requestSeq.current) {
        if (first) setLoading(false);
        else setRangeLoading(false);
      }
    }
  }, [propertyId, range, todayKey]);

  useEffect(() => {
    if (!baseLoaded) return;
    void loadRange();
  }, [baseLoaded, loadRange]);

  // Tras cada escritura: reservas del rango + habitaciones; si falla, la vista
  // se conserva y se marca como desactualizada.
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setRangeLoading(true);
    try {
      const [rms, items] = await Promise.all([fetchRooms(propertyId), fetchRangeReservations(propertyId, range)]);
      if (!mounted.current || seq !== requestSeq.current) return;
      setRooms(rms);
      setReservations(items);
      setStaleSince(null);
    } catch (err) {
      if (!mounted.current || seq !== requestSeq.current) return;
      setStaleSince({ at: time(new Date()), message: describeError(err, REFRESH_ERROR_MESSAGE) });
    } finally {
      if (mounted.current && seq === requestSeq.current) setRangeLoading(false);
    }
  }, [propertyId, range]);

  // ---- índices y filtros --------------------------------------------------
  const roomById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const roomTypeById = useMemo(() => new Map(roomTypes.map((type) => [type.id, type])), [roomTypes]);

  const statusesPresent = useMemo(
    () => countOptions(reservations, (res) => res.status, (id) => RES_STATUS_LABEL[id] ?? id),
    [reservations]
  );
  const channelsPresent = useMemo(() => countOptions(reservations, (res) => res.channel, (id) => channelLabel(id)), [reservations]);
  const roomTypesPresent = useMemo(
    () => countOptions(reservations, (res) => res.roomTypeId, (id) => roomTypeById.get(id)?.name ?? id),
    [reservations, roomTypeById]
  );

  const filtersEff = useMemo(
    () =>
      effectiveFilters(filters, {
        statuses: statusesPresent.map((option) => option.id),
        channels: channelsPresent.map((option) => option.id),
        roomTypes: roomTypesPresent.map((option) => option.id)
      }),
    [filters, statusesPresent, channelsPresent, roomTypesPresent]
  );
  const filterCtx = useMemo(() => ({ roomById, guestNames }), [roomById, guestNames]);

  // Reservas que pasan estado, canal y tipo (sin la búsqueda): son las que
  // necesitan nombre de huésped, para que la búsqueda por nombre encuentre
  // también las que aún no se pintan.
  const scoped = useMemo(
    () => reservations.filter((res) => matchesFilters(res, { ...filtersEff, query: "" }, filterCtx)),
    [reservations, filtersEff, filterCtx]
  );
  const visible = useMemo(
    () => (filtersEff.query.trim() ? scoped.filter((res) => matchesFilters(res, filtersEff, filterCtx)) : scoped),
    [scoped, filtersEff, filterCtx]
  );
  const touched = filtersTouched(filters);

  // ---- nombres de huésped (lotes de 20, cada id una vez por montaje) --------
  // Un 403 (perfil sin guests.read) se guarda como «Huésped no visible» en vez
  // de dejar el bloque en «pendiente» para siempre, y enciende el callout.
  useEffect(() => {
    const ids = pendingGuestIds(scoped, requestedGuestIds.current);
    if (ids.length === 0) return;
    ids.forEach((id) => requestedGuestIds.current.add(id));
    void (async () => {
      for (let start = 0; start < ids.length; start += GUEST_BATCH_SIZE) {
        const batch = ids.slice(start, start + GUEST_BATCH_SIZE);
        const results = await Promise.allSettled(batch.map((id) => fetchGuest(id)));
        if (!mounted.current) return;
        const resolved: Record<string, string> = {};
        let hidden = false;
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            const name = guestFullName(result.value.guest);
            if (name) resolved[batch[index]] = name;
          } else if (isForbidden(result.reason)) {
            resolved[batch[index]] = HIDDEN_GUEST_LABEL;
            hidden = true;
          }
        });
        if (hidden) setGuestsForbidden(true);
        if (Object.keys(resolved).length > 0) setGuestNames((current) => ({ ...current, ...resolved }));
      }
    })();
  }, [scoped]);

  // ---- filas, disponibilidad y alertas ------------------------------------
  const availability = useMemo(() => availabilityByType(rooms, reservations, columns), [rooms, reservations, columns]);
  const totalAvailability = useMemo(() => {
    const totals = new Array<number>(columns.length).fill(0);
    for (const free of availability.values()) for (let i = 0; i < totals.length; i++) totals[i] += free[i] ?? 0;
    return totals;
  }, [availability, columns.length]);
  const totalSellable = useMemo(() => Array.from(sellableByType(rooms).values()).reduce((sum, n) => sum + n, 0), [rooms]);
  const rows = useMemo(
    () => buildRows({ rooms, roomTypes, reservations: visible, range, todayKey, collapsed, availability }),
    [rooms, roomTypes, visible, range, todayKey, collapsed, availability]
  );
  const overbooking = useMemo(() => overbookingDays(rooms, roomTypes, reservations, columns), [rooms, roomTypes, reservations, columns]);
  const roomOverlaps = useMemo(() => roomOverlapCount(visible), [visible]);

  const inHouseCount = useMemo(() => reservations.filter((res) => res.status === "checked_in").length, [reservations]);
  const arrivalsToday = useMemo(
    () => reservations.filter((res) => res.arrivalDate.slice(0, 10) === todayKey && (res.status === "confirmed" || res.status === "checked_in")).length,
    [reservations, todayKey]
  );
  const departuresToday = useMemo(
    () => reservations.filter((res) => res.departureDate.slice(0, 10) === todayKey && (res.status === "checked_in" || res.status === "checked_out")).length,
    [reservations, todayKey]
  );
  /** Cierre nocturno pendiente: la fecha de negocio va por detrás del «hoy» de referencia. */
  const businessDateBehind = businessDateKey !== null && businessDateKey < todayKey;
  /** Hay habitaciones pero ninguna reserva pasa (filtros/búsqueda) o no hay ninguna en el periodo. */
  const noVisible = rooms.length > 0 && visible.length === 0;

  // ---- selección y detalle ------------------------------------------------
  const selected = useMemo(() => reservations.find((res) => res.id === selectedId) ?? null, [reservations, selectedId]);
  const selectedRoom = selected?.assignedRoomId ? roomById.get(selected.assignedRoomId) : undefined;
  const selectedGuestName = selected?.primaryGuestId ? guestNames[selected.primaryGuestId] ?? null : null;
  const selectedLabel = selected ? guestLabel(selected, selectedGuestName) : "";
  /** Reserva abierta en el inspector (null con el detalle cerrado o si la reserva ya no está en el rango). */
  const inspected = inspectorOpen ? selected : null;
  const detailId = inspected?.id ?? null;

  useEffect(() => {
    if (!detailId) {
      setFolio(null);
      setFolioMissing(false);
      setActivity(null);
      setDetailError(null);
      setDetailLoading(false);
      return undefined;
    }
    let on = true;
    setDetailLoading(true);
    setDetailError(null);
    setFolio(null);
    setFolioMissing(false);
    setActivity(null);
    const failures: string[] = [];
    const describe = (e: unknown) => describeError(e, "no disponible");
    Promise.all([
      fetchReservationFolio(detailId)
        .then((result) => ({ folio: result, missing: false }))
        .catch((e: unknown) => {
          // 404: la reserva aún no tiene folio (no es un error).
          if (isNotFound(e)) return { folio: null, missing: true };
          failures.push(`folio: ${describe(e)}`);
          return { folio: null, missing: false };
        }),
      fetchGuestActivity(detailId).catch((e: unknown) => {
        failures.push(`actividad: ${describe(e)}`);
        return null;
      })
    ])
      .then(([folioResult, activityResult]) => {
        if (!on) return;
        setFolio(folioResult.folio);
        setFolioMissing(folioResult.missing);
        setActivity(activityResult);
        setDetailError(failures.length ? `Datos no disponibles — ${failures.join(" · ")}` : null);
      })
      .finally(() => {
        if (on) setDetailLoading(false);
      });
    return () => {
      on = false;
    };
  }, [detailId]);

  // ---- manejadores estables (las filas de la parrilla están memoizadas) ----
  const reservationsRef = useRef(reservations);
  reservationsRef.current = reservations;

  /** Selección (flechas, clic, Intro): nunca abre el detalle por sí sola. */
  const onSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (!id) return;
    const res = reservationsRef.current.find((item) => item.id === id);
    if (res) setLiveMessage(`Seleccionada la reserva ${res.code}`);
  }, []);

  /** Abrir el detalle (clic, Intro, Espacio); con teclado el panel toma el foco. */
  const onOpen = useCallback((id: string, via: TimelineOpenVia) => {
    setSelectedId(id);
    setInspectorOpen(true);
    if (via === "keyboard") setFocusToken((n) => n + 1);
  }, []);

  /** Cerrar el detalle: la selección se conserva y el foco vuelve a la barra. */
  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    if (selectedId) gridHandle.current?.focusBar(selectedId);
  }, [selectedId]);

  const onDrop = useCallback((change: PendingChange) => {
    setActionError(null);
    setConflict(null);
    setPending(change);
  }, []);

  const onDropRejected = useCallback(
    (reason: string) => {
      showToast(reason, { variant: "warning" });
    },
    [showToast]
  );

  const onToggleGroup = useCallback((roomTypeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(roomTypeId)) next.delete(roomTypeId);
      else next.add(roomTypeId);
      return next;
    });
  }, []);

  const onCreateFromCells = useCallback(
    (sel: CellSelection) => {
      const room = roomById.get(sel.roomId);
      if (!room) return;
      const dates = selectionDates(sel, range);
      setCellSel({ room, roomType: roomTypeById.get(room.roomTypeId), ...dates });
    },
    [roomById, roomTypeById, range]
  );

  const onToggleFilter = useCallback(
    (group: TimelineFilterGroup, id: string) => {
      const base = filtersEff[group];
      const next = base.includes(id) ? base.filter((item) => item !== id) : [...base, id];
      setFilters((prev) => ({ ...prev, [group]: next }));
    },
    [filtersEff]
  );
  const onQuery = useCallback((query: string) => setFilters((prev) => ({ ...prev, query })), []);
  const onClearFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  const goToday = useCallback(() => setAnchor(anchorForToday(todayKey)), [todayKey]);
  const goPrev = useCallback(() => setAnchor((prev) => addDays(prev, -range.dayCount)), [range.dayCount]);
  const goNext = useCallback(() => setAnchor((prev) => addDays(prev, range.dayCount)), [range.dayCount]);
  const onPickDate = useCallback((iso: string) => {
    if (iso) setAnchor(parseDateOnly(iso));
  }, []);
  const goToDay = useCallback((dayKey: string) => setAnchor(addDays(parseDateOnly(dayKey), -1)), []);

  // ---- navegación ---------------------------------------------------------
  const openReservation = useCallback(() => {
    if (!selected) return;
    const url = urlForScreen("ReservationDetailWorkspace", { id: selected.id });
    if (url) openTabPath(url);
  }, [selected]);
  const openJourney = useCallback(() => {
    if (!selected) return;
    const url = urlForScreen("GuestJourneyWorkspace", { id: selected.id });
    if (url) openTabPath(url);
  }, [selected]);
  /** El folio de ESTA reserva (FolioDetail), no la pantalla genérica de facturación. */
  const openFolio = useCallback(() => {
    if (!folio) return;
    const url = urlForScreen("FolioDetail", { id: folio.folio.id });
    if (url) openTabPath(url);
  }, [folio]);
  const openNewReservation = useCallback(() => {
    openTabPath(urlForScreen("ReservationCreate") ?? NEW_RESERVATION_FALLBACK_URL);
  }, []);
  const confirmCreate = useCallback(() => {
    if (!cellSel) return;
    const base = urlForScreen("ReservationCreate") ?? NEW_RESERVATION_FALLBACK_URL;
    const search = newReservationSearch({
      arrivalDate: cellSel.arrivalDate,
      departureDate: cellSel.departureDate,
      roomTypeId: cellSel.room.roomTypeId,
      assignedRoomId: cellSel.room.id
    });
    setCellSel(null);
    openTabPath(`${base}?${search}`);
  }, [cellSel]);
  const cancelCreate = useCallback(() => setCellSel(null), []);

  // ---- acciones: todas pasan por el diálogo -------------------------------
  const roomLabel = useCallback(
    (id: string | null): string => {
      const room = id ? roomById.get(id) : undefined;
      return room ? `Hab. ${room.number}` : NO_ROOM_LABEL;
    },
    [roomById]
  );

  const startAction = useCallback(
    (type: TimelineInspectorAction) => {
      if (!selected) return;
      setActionError(null);
      setConflict(null);
      setPending({ type, res: selected });
    },
    [selected]
  );

  const cancelPending = useCallback(() => {
    setPending(null);
    setActionError(null);
    setConflict(null);
  }, []);

  const copy = useMemo(() => {
    if (!pending) return null;
    const guest = guestLabel(pending.res, pending.res.primaryGuestId ? guestNames[pending.res.primaryGuestId] : null);
    return dialogCopy(pending, { roomLabel, guest });
  }, [pending, guestNames, roomLabel]);

  const applyPending = useCallback(
    async (input: TimelineConfirmInput) => {
      if (!pending || !copy) return;
      const { res } = pending;
      setBusy(true);
      setActionError(null);
      setConflict(null);
      try {
        if (pending.type === "move") {
          const patch = patchFor(pending);
          if (patch) await updateReservation(res.id, patch);
          else if (pending.newRoomId) await assignReservationRoom(res.id, { roomId: pending.newRoomId });
        } else if (pending.type === "resize") {
          const patch = patchFor(pending);
          if (patch) await updateReservation(res.id, patch);
        } else if (pending.type === "checkin") {
          if (!res.assignedRoomId) throw new Error(CHECKIN_NEEDS_ROOM);
          await checkInReservation(res.id, { roomId: res.assignedRoomId });
        } else if (pending.type === "checkout") {
          await checkOutReservation(res.id, { acknowledgeBalance: input.acknowledgeBalance });
        } else if (pending.type === "cancel") {
          await cancelReservation(res.id, input.reason);
        } else if (pending.type === "noshow") {
          await noShowReservation(res.id, input.reason);
        } else {
          if (!input.roomId) throw new Error(ASSIGN_NEEDS_ROOM);
          await assignReservationRoom(res.id, { roomId: input.roomId });
        }
        await refresh();
        if (!mounted.current) return;
        // Una sola voz: el cambio deshacible lo anuncia la barra de deshacer
        // (role=status); el resto, el toast. La live region no lo repite.
        const entry = undoEntryFor(pending);
        if (entry) setUndo(entry);
        else showToast(copy.done, { variant: "success" });
        setPending(null);
      } catch (err) {
        if (!mounted.current) return;
        const balance = pending.type === "checkout" ? balanceDueConflict(err) : null;
        if (balance) {
          // El diálogo sigue abierto para reconocer el saldo y repetir.
          setConflict({ code: "BALANCE_DUE", message: balance.message, balanceDue: balance.balanceDue });
        } else {
          const code = conflictCode(err);
          if (code) setConflict({ code, message: conflictMessage(code) });
          else setActionError(describeError(err, UNKNOWN_CONFLICT_MESSAGE));
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [pending, copy, refresh, showToast]
  );

  const onUndo = useCallback(async () => {
    const entry = undo;
    if (!entry) return;
    setUndo(null);
    try {
      if (entry.roomOnly) {
        const roomId = entry.patch.assignedRoomId;
        if (!roomId) throw new Error(UNDO_NO_ROOM_MESSAGE);
        await assignReservationRoom(entry.reservationId, { roomId });
      } else {
        await updateReservation(entry.reservationId, entry.patch);
      }
      await refresh();
      if (!mounted.current) return;
      // Un traslado en casa deshecho es otro traslado: la limpieza de la habitación intermedia no se revierte.
      showToast(entry.roomOnly ? IN_HOUSE_UNDO_DONE_MESSAGE : UNDO_DONE_MESSAGE, { variant: entry.roomOnly ? "warning" : "success" });
    } catch (err) {
      if (!mounted.current) return;
      const code = conflictCode(err);
      const message = code ? conflictMessage(code) : describeError(err, UNDO_ERROR_MESSAGE);
      showToast(message, { variant: "error" });
    }
  }, [undo, refresh, showToast]);

  const dismissUndo = useCallback(() => setUndo(null), []);

  // ---- Escape: diálogo → selección de celdas → detalle → selección ----------
  // Los overlays Cocoa ya cierran con Esc y detienen la propagación, así que
  // esto solo llega sin ninguno abierto: desde la parrilla (onEscape de la
  // barra enfocada, que no propaga) o desde cualquier otro sitio (window).
  const handleEscape = useCallback(() => {
    if (pending) {
      cancelPending();
      return;
    }
    if (cellSel) {
      setCellSel(null);
      return;
    }
    if (inspectorOpen) {
      closeInspector();
      return;
    }
    if (selectedId) setSelectedId(null);
  }, [pending, cellSel, inspectorOpen, selectedId, cancelPending, closeInspector]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      handleEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleEscape]);

  // El detalle se cierra solo si la reserva abierta desaparece del rango (refresh, filtro, periodo).
  useEffect(() => {
    if (inspectorOpen && !selected) setInspectorOpen(false);
  }, [inspectorOpen, selected]);

  // ---- render -------------------------------------------------------------
  const pageState = loading ? "loading" : error ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow="Hoy"
      title={LIVE_TIMELINE_TITLE}
      subtitle={hosted ? undefined : LIVE_TIMELINE_SUBTITLE}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={rangeLoading} disabled={forbidden} onClick={() => void refresh()}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      fullBleed
      density="compact"
      state={pageState}
      skeleton={<CocoaSkeleton variant="chart" height={420} />}
      error={{ title: LOAD_ERROR_TITLE, message: error ?? undefined, onRetry: () => void loadBase() }}
      commands={
        forbidden
          ? []
          : [
              { id: "live-timeline-refresh", label: "Actualizar Live Timeline", run: () => void refresh() },
              { id: "live-timeline-today", label: "Live Timeline: ir a hoy", run: goToday },
              { id: "live-timeline-new", label: "Nueva reserva desde el timeline", run: openNewReservation }
            ]
      }
    >
      {forbidden ? (
        <CocoaCallout tone="warning" role="alert" title={FORBIDDEN_TITLE}>
          {FORBIDDEN_MESSAGE}
        </CocoaCallout>
      ) : (
        <>
          <CocoaScreenInstructionsCard
            title={LIVE_TIMELINE_TITLE}
            description={LIVE_TIMELINE_INSTRUCTIONS.whatIsThis}
            steps={[...LIVE_TIMELINE_INSTRUCTIONS.howToUse]}
            tip={LIVE_TIMELINE_INSTRUCTIONS.tips[0]}
            dismissible
            persistKey="live-timeline"
          />

          <TimelineDateSelector
            rangeLabel={rangeLabel}
            granularity={granularity}
            onGranularityChange={setGranularity}
            onPrev={goPrev}
            onNext={goNext}
            onToday={goToday}
            anchorIso={toDateOnly(anchor)}
            onPickDate={onPickDate}
            loading={rangeLoading}
          />

          <TimelineFilterBar
            statuses={statusesPresent}
            channels={channelsPresent}
            roomTypes={roomTypesPresent}
            filters={filters}
            effective={filtersEff}
            onToggle={onToggleFilter}
            onQuery={onQuery}
            onClear={onClearFilters}
            touched={touched}
          />

          <div className="cocoa-row" data-gap="2" data-justify="between" data-wrap="true">
            <span className="cocoa-cluster">
              <CocoaBadge tone="neutral">{plural(rooms.length, "habitación", "habitaciones")}</CocoaBadge>
              <CocoaBadge tone="neutral">{plural(visible.length, "reserva visible", "reservas visibles")}</CocoaBadge>
              <CocoaBadge tone="success">En casa: {inHouseCount}</CocoaBadge>
              <CocoaBadge tone="info">Llegadas hoy: {arrivalsToday}</CocoaBadge>
              <CocoaBadge tone="warning">Salidas hoy: {departuresToday}</CocoaBadge>
              {businessDateBehind && businessDateKey ? (
                <CocoaBadge tone="warning" variant="outline" title="El cierre nocturno no se ha ejecutado: «hoy» es el día local, como en el check-in">
                  Cierre nocturno pendiente · fecha de negocio {date(businessDateKey, "dayMonth")}
                </CocoaBadge>
              ) : null}
            </span>
            {selected ? (
              <CocoaBadge tone="accent" variant="dot">
                Selección: {selected.code} · {selectedLabel}
              </CocoaBadge>
            ) : (
              <CocoaBadge tone="neutral" variant="dot">
                Sin selección
              </CocoaBadge>
            )}
          </div>

          {guestsForbidden ? (
            <CocoaCallout tone="info" role="note" title={GUESTS_HIDDEN_TITLE}>
              {GUESTS_HIDDEN_MESSAGE}
            </CocoaCallout>
          ) : null}

          <TimelineGapAlert days={overbooking} roomOverlaps={roomOverlaps} onGoToDay={goToDay} />

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

          <TimelineUndoBar entry={undo} onUndo={onUndo} onDismiss={dismissUndo} />

          {noVisible ? (
            <CocoaCallout
              tone="neutral"
              role="status"
              title={reservations.length === 0 ? NO_RESERVATIONS_TITLE : NO_MATCH_TITLE}
              actions={
                touched ? (
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={onClearFilters}>
                    {ACTIONS.clearFilters}
                  </CocoaButton>
                ) : (
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={goToday}>
                    {`Ir a ${TIME_LABELS.today.toLowerCase()}`}
                  </CocoaButton>
                )
              }
            >
              {reservations.length === 0 ? NO_RESERVATIONS_MESSAGE : NO_MATCH_MESSAGE}
            </CocoaCallout>
          ) : null}

          <div className="tl-workspace" data-panel={inspected ? "open" : "closed"}>
            <div className="tl-workspace__main">
              {rows.length === 0 ? (
                <CocoaSection aria-label="Sin datos en el periodo">
                  <CocoaState
                    kind="empty"
                    illustration="search"
                    title="Sin datos para mostrar"
                    message="No hay habitaciones ni reservas en este periodo. Cambia el periodo o los filtros."
                    primaryAction={{ label: `Ir a ${TIME_LABELS.today.toLowerCase()}`, onClick: goToday }}
                    secondaryAction={touched ? { label: ACTIONS.clearFilters, onClick: onClearFilters } : undefined}
                  />
                </CocoaSection>
              ) : (
                <TimelineGrid
                  rows={rows}
                  range={range}
                  columns={columns}
                  totalAvailability={totalAvailability}
                  totalSellable={totalSellable}
                  selectedId={selectedId}
                  guestNames={guestNames}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onEscape={handleEscape}
                  onDrop={onDrop}
                  onDropRejected={onDropRejected}
                  onToggleGroup={onToggleGroup}
                  onCreateFromCells={onCreateFromCells}
                  roomById={roomById}
                  roomTypeById={roomTypeById}
                  reservations={reservations}
                  maxHeight={narrow ? GRID_HEIGHT_NARROW : GRID_HEIGHT}
                  handleRef={gridHandle}
                />
              )}

              <TimelineLegend />
            </div>

            <TimelineInspector
              res={inspected}
              label={selectedLabel}
              room={selectedRoom}
              roomType={inspected ? roomTypeById.get(inspected.roomTypeId) : undefined}
              kind={inspected ? barKind(inspected, todayKey) : null}
              folio={folio}
              folioMissing={folioMissing}
              activity={activity}
              guestName={selectedGuestName}
              loading={detailLoading}
              error={detailError}
              focusToken={focusToken}
              onClose={closeInspector}
              onOpenReservation={openReservation}
              onOpenJourney={openJourney}
              onOpenFolio={openFolio}
              onNavigate={navigateTo}
              onAction={startAction}
            />
          </div>
        </>
      )}

      <CocoaLiveRegion message={liveMessage} />

      <TimelineActionDialog
        pending={pending}
        copy={copy}
        rooms={rooms}
        roomTypeById={roomTypeById}
        roomLabel={roomLabel}
        busy={busy}
        error={actionError}
        conflict={conflict}
        onConfirm={applyPending}
        onCancel={cancelPending}
      />

      <TimelineCreateDialog selection={cellSel} onConfirm={confirmCreate} onCancel={cancelCreate} />
    </CocoaPage>
  );
}

export default LiveTimeline;
