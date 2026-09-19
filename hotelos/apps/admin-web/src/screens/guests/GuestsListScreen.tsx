// Guests list — Recepción › Huéspedes › Listado (/recepcion/huespedes).
//
// Cocoa 22 pilot of the «lista / tabla» archetype (docs/design/COCOA-22.md
// §4): CocoaPage → CocoaToolbar (content: search) → CocoaSection (padding
// none) → CocoaTable (a row opens the inspector; «Abrir ficha» opens the
// record) → footer with the count and «Cargar más» (cursor pagination; the API
// caps a page at 200). Below 600 px the table paints stacked label/value cards
// by itself.
//
// Hosted inside HuespedesTabs the container already paints the title, the
// subtitle and the «Nuevo huésped» action; standalone the page paints them.
//
// Tanda UX-1 · lote U8 (docs/design/UX-RECEPCION-FEEL.md §5.8, F11, F26):
//   · la página vive en `useApiData` (clave = término; SWR 30 s) y la tabla
//     lleva `keepDataWhileLoading`: teclear no vacía el directorio;
//   · búsqueda por habitación de la estancia actual: un término que parece un
//     número de habitación («204») busca la estancia EN EL HOTEL en esa
//     habitación (reservas `checked_in` de la propiedad activa + catálogo de
//     habitaciones, ambas de la caché compartida) y pinta a su titular;
//   · inspector lateral con las estancias (Intro / clic; ↑↓ cambian de
//     huésped sin cerrarlo): primaria «Abrir la estancia de hoy» si está en
//     el hotel, si no «Nueva reserva para este huésped» (prefill del modo
//     rápido por `?guestId=` de /recepcion/reservas/nueva, que lee U9a);
//   · ⌥F enfoca el buscador (evento del registro de atajos de U5).

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fetchGuest, fetchGuests, type GuestDetail, type GuestProfile, type GuestStay } from "../../services/guestsApi";
import type { AdminReservation, AdminRoom, Page } from "../../services/pmsCommerceApi";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { useTabHost } from "../tabs/TabHost";
import { urlForScreen } from "../../navigation/nav-tree";
import { FRONT_DESK_ACTIONS, newLabel } from "../../content/actions";
import { FOCUS_SEARCH_EVENT } from "../../content/shortcuts-registry";
import { reservationStatus } from "../../content/status-dictionary";
import { EMPTY, date, money, plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaInspector,
  CocoaInspectorLayout,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  CocoaStatusBadge,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
const SEARCH_INPUT_ID = "guest-search";
// Rows per page (API caps at 200); "Cargar más" walks the cursor. With a
// search term the API answers a single merged page (nextCursor: null).
export const PAGE_SIZE = 50;
const LIST_STALE_MS = 30_000;
const CATALOG_STALE_MS = 5 * 60_000;
/** Estancias en el hotel de la propiedad activa (una página basta: el API acota a 500). */
const IN_HOUSE_QUERY = { status: "checked_in", limit: 500, sort: "arrival_desc", envelope: "1" } as const;

/** Nueva reserva (modo rápido) con el huésped prefijado: `?guestId=` lo lee ReservationCreateScreen (U9a). */
const NEW_RESERVATION_URL = urlForScreen("ReservationCreate") ?? "/recepcion/reservas/nueva";

export const NEW_RESERVATION_FOR_GUEST = "Nueva reserva para este huésped";
export const OPEN_TODAY_STAY = "Abrir la estancia de hoy";

// Ficha del huésped: /recepcion/huespedes/:id (tab of the Huéspedes container, Tanda 5).
function openGuest(id: string) {
  const url = urlForScreen("GuestDetail", { id });
  if (url) openTabPath(url);
}

function openReservation(id: string) {
  openTabPath(urlForScreen("ReservationDetailWorkspace", { id }) ?? "/recepcion/reservas");
}

// ---------------------------------------------------------------- funciones puras (reservations-list.test.mts)

/** Un término que parece un número de habitación («204», «101B»): busca la estancia actual, no el directorio. */
export const ROOM_QUERY = /^\d{1,4}[a-z]?$/i;

export function isRoomQuery(term: string): boolean {
  return ROOM_QUERY.test(term.trim());
}

/** URL de Nueva reserva con el huésped prefijado (pure). */
export function newReservationUrlForGuest(guestId: string, base: string = NEW_RESERVATION_URL): string {
  return `${base}?guestId=${encodeURIComponent(guestId)}`;
}

/**
 * Titulares de las estancias EN EL HOTEL en la habitación buscada (número igual
 * o que empieza por el término), en el orden de las reservas; sin duplicados.
 */
export function guestIdsInRoom(reservations: ReadonlyArray<Pick<AdminReservation, "status" | "assignedRoomId" | "primaryGuestId">>, rooms: ReadonlyArray<Pick<AdminRoom, "id" | "number">>, term: string): string[] {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const numbers = new Map(rooms.map((room) => [room.id, room.number.toLowerCase()]));
  const out: string[] = [];
  for (const reservation of reservations) {
    if (reservation.status !== "checked_in" || !reservation.assignedRoomId || !reservation.primaryGuestId) continue;
    const room = numbers.get(reservation.assignedRoomId);
    if (!room || !(room === t || room.startsWith(t))) continue;
    if (!out.includes(reservation.primaryGuestId)) out.push(reservation.primaryGuestId);
  }
  return out;
}

/** La estancia de hoy de un huésped: la que está en el hotel; null si no hay. */
export function currentStayOf(stays: ReadonlyArray<Pick<GuestStay, "id" | "status">>): { id: string } | null {
  return stays.find((stay) => stay.status === "checked_in") ?? null;
}

function mergeById(current: GuestProfile[], incoming: GuestProfile[]): GuestProfile[] {
  const seen = new Set(current.map((g) => g.id));
  return [...current, ...incoming.filter((g) => !seen.has(g.id))];
}

/** Titulares resueltos por habitación (una petición por id y sesión). */
const GUEST_CACHE: Record<string, GuestProfile> = {};

const COLUMNS: CocoaTableColumn<GuestProfile>[] = [
  {
    key: "name",
    label: "Nombre",
    render: (g) => (
      <>
        <strong>
          {g.title ? `${g.title} ` : ""}
          {g.fullName || g.firstName}
        </strong>
        {g.nationality ? <span className="cocoa-note">{g.nationality}</span> : null}
      </>
    )
  },
  {
    key: "document",
    label: "Documento",
    render: (g) => (g.documentType ? `${g.documentType} ${g.documentNumber ?? ""}` : (g.documentNumber ?? "—"))
  },
  {
    key: "contact",
    label: "Contacto",
    render: (g) => (
      <>
        {g.email ?? "—"}
        {g.phone || g.mobilePhone ? <span className="cocoa-note">{g.mobilePhone ?? g.phone}</span> : null}
      </>
    )
  },
  { key: "company", label: "Empresa", render: (g) => g.company ?? "—" },
  {
    key: "vip",
    label: "VIP / Fidelización",
    render: (g) =>
      g.vipCode || g.loyaltyTier ? (
        <span className="cocoa-cluster">
          {g.vipCode ? <CocoaBadge tone="info">{g.vipCode}</CocoaBadge> : null}
          {g.loyaltyTier ? <CocoaBadge tone="neutral">{g.loyaltyTier}</CocoaBadge> : null}
        </span>
      ) : (
        "—"
      )
  }
];

// ---------------------------------------------------------------- inspector (§5.8, F26)

function GuestInspector({ guest, onClose, returnFocusTo }: { guest: GuestProfile; onClose: () => void; returnFocusTo: () => HTMLElement | null }) {
  const detailState = useApiData<GuestDetail>(`/guests/${guest.id}`, { staleTime: LIST_STALE_MS });
  const detail = detailState.data;
  const stays = detail?.stayHistory ?? [];
  const current = currentStayOf(stays);
  const name = detail?.guest.fullName || guest.fullName || guest.firstName;
  return (
    <CocoaInspector
      open
      title={name}
      aria-label={`Detalle de ${name}`}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      width="md"
      commands={
        <>
          {current ? (
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => openReservation(current.id)}>
              {OPEN_TODAY_STAY}
            </CocoaButton>
          ) : (
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => openTabPath(newReservationUrlForGuest(guest.id))}>
              {NEW_RESERVATION_FOR_GUEST}
            </CocoaButton>
          )}
          {current ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openTabPath(newReservationUrlForGuest(guest.id))}>
              {NEW_RESERVATION_FOR_GUEST}
            </CocoaButton>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openGuest(guest.id)}>
            {FRONT_DESK_ACTIONS.openFullReservation}
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-stack" data-gap="1">
          <span className="cocoa-note">{[guest.documentType && guest.documentNumber ? `${guest.documentType} ${guest.documentNumber}` : null, guest.email, guest.mobilePhone ?? guest.phone, guest.company].filter(Boolean).join(" · ") || EMPTY}</span>
          {guest.vipCode || guest.loyaltyTier ? (
            <span className="cocoa-cluster">
              {guest.vipCode ? <CocoaBadge tone="info">{guest.vipCode}</CocoaBadge> : null}
              {guest.loyaltyTier ? <CocoaBadge tone="neutral">{guest.loyaltyTier}</CocoaBadge> : null}
            </span>
          ) : null}
        </div>
        <CocoaSection title="Estancias" meta={detail ? plural(detail.stats.stays, "estancia", "estancias") : undefined}>
          {detailState.error && !detail ? (
            <CocoaState kind="error" inline title="No se pudieron cargar las estancias" message={detailState.error} onRetry={detailState.refresh} />
          ) : detail ? (
            stays.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin estancias registradas todavía." />
            ) : (
              <ul className="c22-section__list" aria-label="Estancias del huésped">
                {stays.slice(0, 6).map((stay) => (
                  <li key={stay.id}>
                    <span className="cocoa-cluster">
                      <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openReservation(stay.id)}>
                        {stay.code}
                      </CocoaButton>
                      <CocoaStatusBadge entry={reservationStatus(stay.status)} />
                    </span>
                    <strong>
                      {stay.arrivalDate ? date(stay.arrivalDate, "dayMonth") : EMPTY} → {stay.departureDate ? date(stay.departureDate, "dayMonth") : EMPTY} · {money(stay.totalAmount, stay.currency)}
                    </strong>
                  </li>
                ))}
                {stays.length > 6 ? (
                  <li>
                    <span className="cocoa-note">{plural(stays.length - 6, "estancia más en la ficha", "estancias más en la ficha")}</span>
                    <span />
                  </li>
                ) : null}
              </ul>
            )
          ) : (
            <CocoaSkeleton variant="row" lines={3} />
          )}
        </CocoaSection>
      </div>
    </CocoaInspector>
  );
}

// ---------------------------------------------------------------- pantalla

export function GuestsListScreen() {
  const hosted = useTabHost() !== null;
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [roomGuests, setRoomGuests] = useState<Record<string, GuestProfile>>(() => ({ ...GUEST_CACHE }));
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const term = debounced;
  const roomQuery = isRoomQuery(term);

  // Directorio (clave = término; con habitación se mantiene la página sin término bajo el velo).
  const listQuery = useMemo(() => ({ search: roomQuery || !term ? undefined : term, limit: PAGE_SIZE, envelope: "1" }), [term, roomQuery]);
  const listKey = JSON.stringify(listQuery);
  const page = useApiData<Page<GuestProfile>>("/guests", { query: listQuery, staleTime: LIST_STALE_MS });
  // Estancia actual por habitación: reservas en el hotel + catálogo, solo cuando hace falta.
  const inHouse = useApiData<Page<AdminReservation>>(`/properties/${PROPERTY_ID}/reservations`, { query: IN_HOUSE_QUERY, staleTime: LIST_STALE_MS, enabled: roomQuery });
  const roomsState = useApiData<AdminRoom[]>(`/properties/${PROPERTY_ID}/rooms`, { staleTime: CATALOG_STALE_MS, enabled: roomQuery });

  const [more, setMore] = useState<{ key: string; items: GuestProfile[]; nextCursor: string | null; total: number } | null>(null);
  const extra = more && more.key === listKey ? more : null;
  const directory = useMemo(() => (extra ? mergeById(page.data?.items ?? [], extra.items) : page.data?.items ?? []), [page.data, extra]);
  const nextCursor = extra ? extra.nextCursor : page.data?.nextCursor ?? null;
  const total = extra ? extra.total : page.data?.total ?? null;

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await fetchGuests({ search: listQuery.search, limit: PAGE_SIZE, cursor: nextCursor });
      if (!mounted.current) return;
      setMore((current) => ({ key: listKey, items: mergeById(current && current.key === listKey ? current.items : [], next.items), nextCursor: next.nextCursor, total: next.total }));
    } catch (err: unknown) {
      if (mounted.current) setMoreError(err instanceof Error ? err.message : "No se pudieron cargar más huéspedes");
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  // Titulares de la habitación buscada: primero los del directorio cargado, el resto por /guests/:id (una vez por sesión).
  const roomGuestIds = useMemo(() => (roomQuery ? guestIdsInRoom(inHouse.data?.items ?? [], roomsState.data ?? [], term) : []), [roomQuery, inHouse.data, roomsState.data, term]);
  const roomLookupPending = roomQuery && (inHouse.loading || roomsState.loading);
  useEffect(() => {
    const known = new Map(directory.map((g) => [g.id, g]));
    const missing = roomGuestIds.filter((id) => !known.has(id) && !roomGuests[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(missing.map((id) => fetchGuest(id))).then((results) => {
      const resolved: Record<string, GuestProfile> = {};
      results.forEach((result, index) => {
        if (result.status === "fulfilled") resolved[missing[index]] = result.value.guest;
      });
      Object.assign(GUEST_CACHE, resolved);
      if (cancelled || !mounted.current || Object.keys(resolved).length === 0) return;
      setRoomGuests((current) => ({ ...current, ...resolved }));
    });
    return () => {
      cancelled = true;
    };
  }, [roomGuestIds, directory, roomGuests]);

  const rows: GuestProfile[] = useMemo(() => {
    if (!roomQuery) return directory;
    const known = new Map(directory.map((g) => [g.id, g]));
    return roomGuestIds.map((id) => known.get(id) ?? roomGuests[id]).filter((g): g is GuestProfile => Boolean(g));
  }, [roomQuery, directory, roomGuestIds, roomGuests]);
  const rowById = useMemo(() => new Map(rows.map((g) => [g.id, g])), [rows]);
  const inspectorGuest = inspectorId ? rowById.get(inspectorId) ?? null : null;
  // Con la página siguiente en vuelo la fila sigue; solo se cierra cuando la fila desaparece de verdad.
  const stale = page.loading && page.data !== null;
  useEffect(() => {
    if (inspectorId && !stale && !rowById.has(inspectorId)) setInspectorId(null);
  }, [inspectorId, rowById, stale]);

  const rowElementFor = useCallback(
    (guestId: string): HTMLElement | null => {
      const index = rows.findIndex((g) => g.id === guestId);
      if (index < 0) return null;
      const elements = tableWrapRef.current?.querySelectorAll<HTMLElement>("tbody tr[data-interactive]");
      return elements?.[index] ?? null;
    },
    [rows]
  );

  // ↑↓ mueven el inspector sin cerrarlo (fuera de campos de texto).
  const onTableKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!inspectorId || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const index = rows.findIndex((g) => g.id === inspectorId);
      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setInspectorId(next.id);
      rowElementFor(next.id)?.focus({ preventScroll: false });
    },
    [inspectorId, rows, rowElementFor]
  );

  // ⌥F (registro de U5): enfoca el buscador de esta pantalla.
  useEffect(() => {
    const onFocusSearch = (event: Event) => {
      const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
  }, []);

  const newGuestLabel = newLabel("m", "huésped");
  const loading = roomQuery ? roomLookupPending : page.loading;
  const listError = roomQuery ? (inHouse.error && !inHouse.data ? inHouse.error : roomsState.error && !roomsState.data ? roomsState.error : null) : page.error && !page.data ? page.error : null;
  const hasRows = rows.length > 0;
  const ready = !listError && (hasRows || stale);
  const shownTotal = roomQuery ? rows.length : total;

  const footer = ready ? (
    <>
      <span>
        {rows.length}
        {shownTotal !== null ? ` de ${shownTotal}` : ""} huéspedes
      </span>
      {moreError ? <CocoaBadge tone="danger">{moreError}</CocoaBadge> : null}
      {nextCursor && !roomQuery ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMore} onClick={() => void loadMore()}>
          Cargar más
        </CocoaButton>
      ) : null}
    </>
  ) : undefined;

  let body;
  if (listError) {
    body = <CocoaState kind="error" title="No se pudieron cargar los huéspedes" message={listError} onRetry={roomQuery ? inHouse.refresh : page.refresh} />;
  } else if (!loading && !hasRows) {
    body = (
      <CocoaState
        kind="empty"
        illustration={term ? "search" : "box"}
        title={roomQuery ? `Nadie alojado en la ${term}` : term ? "Sin resultados" : "Aún no hay huéspedes"}
        message={roomQuery ? "Se buscan las estancias en el hotel por número de habitación; prueba con el nombre para el resto." : term ? "Ningún huésped coincide con la búsqueda. Prueba con otro término o con el número de habitación." : "Los perfiles se crean automáticamente al registrar reservas, o créalos manualmente."}
        primaryAction={{ label: newGuestLabel, onClick: () => openGuest("new") }}
      />
    );
  } else {
    body = (
      <CocoaInspectorLayout open={Boolean(inspectorGuest)}>
        <div ref={tableWrapRef} onKeyDown={onTableKeyDown}>
          <CocoaTable
            columns={COLUMNS}
            rows={rows}
            rowKey="id"
            loading={loading}
            keepDataWhileLoading
            selectedKey={inspectorGuest?.id}
            onSelect={(g) => setInspectorId((current) => (current === g.id ? null : g.id))}
            rowActions={(g) => (
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openGuest(g.id)}>
                {FRONT_DESK_ACTIONS.openReservation}
              </CocoaButton>
            )}
            rowTitle={(g) => `${g.fullName || g.firstName}: Intro abre el detalle al lado`}
            caption="Huéspedes"
            aria-label="Huéspedes"
          />
        </div>
        {inspectorGuest ? <GuestInspector guest={inspectorGuest} onClose={() => setInspectorId(null)} returnFocusTo={() => rowElementFor(inspectorGuest.id)} /> : null}
      </CocoaInspectorLayout>
    );
  }

  return (
    <CocoaPage
      eyebrow="Recepción · Huéspedes"
      title="Huéspedes"
      density="operational"
      subtitle={hosted ? undefined : "Directorio de perfiles de huésped de la organización. Busca por nombre, empresa, email, documento o habitación."}
      actions={
        hosted ? undefined : (
          <CocoaButton variant="filled" tone="accent" onClick={() => openGuest("new")}>
            {newGuestLabel}
          </CocoaButton>
        )
      }
      commands={[
        { id: "guests-new", label: newGuestLabel, run: () => openGuest("new") },
        { id: "guests-search", label: "Buscar huéspedes", run: () => window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT, { cancelable: true })) }
      ]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Búsqueda de huéspedes"
        leftSlot={
          <CocoaSearchInput
            id={SEARCH_INPUT_ID}
            value={search}
            onChange={setSearch}
            placeholder="Nombre, empresa, email, documento o habitación…"
            aria-label="Buscar huéspedes por nombre, empresa, email, documento o habitación"
          />
        }
        rightSlot={roomQuery && hasRows ? <CocoaBadge tone="info">{`Alojado en la ${term}`}</CocoaBadge> : undefined}
      />
      <CocoaSection padding={ready ? "none" : "md"} footer={footer} style={{ overflow: "clip" }} aria-label="Listado de huéspedes">
        {body}
      </CocoaSection>
    </CocoaPage>
  );
}
