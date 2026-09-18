// Finanzas · Facturación y cobros — buscador de reservas del centro
// (Tanda L3 · lote F1, decisión §6.14).
//
// The centre used to load ONE page of 200 reservations into a select; it now
// searches `GET /properties/:id/reservations?q=…&limit=25&sort=arrival_desc`
// (free text over code, holder and primary guest, case-insensitive on the
// server) and walks `nextCursor` with «Más resultados». These helpers are the
// pure half of that flow: text normalisation, query construction, page merge
// without duplicates, result label and selection.
//
// No React, no network, no import.meta: screens/billing/__tests__ runs this
// module under `node --test`. The query shape mirrors
// `ReservationListQuery` (services/pmsCommerceApi.ts) structurally so the
// module never imports the API client.

/** Rows per search page (the API clamps at 500; 25 keeps the select short). */
export const RESERVATION_SEARCH_PAGE_SIZE = 25;
/** `ReservationListQuerySchema.q` is `.trim().min(1).max(100)` (server.ts): longer text would be a 400. */
export const RESERVATION_SEARCH_MAX_LENGTH = 100;
/** Most recent arrivals first, like the reservations list. */
export const RESERVATION_SEARCH_SORT = "arrival_desc" as const;

export type ReservationSearchQuery = {
  q?: string;
  limit: number;
  sort: typeof RESERVATION_SEARCH_SORT;
  cursor?: string;
};

/** Collapse whitespace, trim and cap at the server maximum; empty → "". */
export function normalizeReservationSearch(raw: string | null | undefined): string {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > RESERVATION_SEARCH_MAX_LENGTH ? collapsed.slice(0, RESERVATION_SEARCH_MAX_LENGTH).trim() : collapsed;
}

/**
 * Query for `fetchReservations(propertyId, query)`: `q` only when there is
 * text (the API rejects an empty `q`), fixed page size and sort, and the
 * cursor of the page being extended (never with a changed text: the caller
 * starts over).
 */
export function buildReservationSearchQuery(raw: string | null | undefined, options: { cursor?: string | null; limit?: number } = {}): ReservationSearchQuery {
  const q = normalizeReservationSearch(raw);
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : RESERVATION_SEARCH_PAGE_SIZE;
  const query: ReservationSearchQuery = { limit, sort: RESERVATION_SEARCH_SORT };
  if (q) query.q = q;
  if (options.cursor) query.cursor = options.cursor;
  return query;
}

/** Append a page keeping the existing order; a row already present (same id) is not repeated. */
export function mergeReservationPages<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  const merged = [...current];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

/** Minimal shape of a reservation row as painted by the picker (structural subset of AdminReservation). */
export type ReservationSearchRow = {
  id: string;
  code: string;
  status?: string;
  arrivalDate: string;
  bookerName?: string | null;
  companyName?: string | null;
  travelAgentName?: string | null;
};

const CLOSED_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  cancelled: "cancelada",
  no_show: "no-show",
  checked_out: "salida"
});

/** Holder shown next to the code: booker, else company, else agency, else «Huésped». */
export function reservationHolderLabel(row: Pick<ReservationSearchRow, "bookerName" | "companyName" | "travelAgentName">): string {
  return row.bookerName?.trim() || row.companyName?.trim() || row.travelAgentName?.trim() || "Huésped";
}

/**
 * «RES-00012 · García · 12 sep» (+ « · cancelada» / « · no-show» / « · salida»
 * for closed stays) — the option label of the results select. The date is
 * formatted by the caller (lib/format is not loaded here).
 */
export function reservationResultLabel(row: ReservationSearchRow, formatDate: (iso: string) => string): string {
  const parts = [row.code, reservationHolderLabel(row), formatDate(row.arrivalDate)];
  const closed = row.status ? CLOSED_STATUS_LABEL[row.status] : undefined;
  if (closed) parts.push(closed);
  return parts.join(" · ");
}

/** Keep the current selection when it survives the new page; otherwise the first row; "" without rows. */
export function pickSearchSelection(items: ReadonlyArray<{ id: string }>, currentId: string | null | undefined): string {
  if (currentId && items.some((row) => row.id === currentId)) return currentId;
  return items[0]?.id ?? "";
}

/**
 * Help line under the picker: «12 reservas para «garcía» · hay más» /
 * «Sin reservas para «x»» / «Últimas 25 llegadas de 110 · hay más».
 */
export function searchResultsSummary(input: { shown: number; total: number | null; hasMore: boolean; q: string }): string {
  const q = normalizeReservationSearch(input.q);
  const total = input.total !== null && input.total >= input.shown ? input.total : input.shown;
  if (input.shown === 0) return q ? `Sin reservas para «${q}».` : "No hay reservas en la propiedad.";
  const scope = q ? `para «${q}»` : "llegadas más recientes";
  const count = total === 1 ? "1 reserva" : `${total} reservas`;
  const shown = input.shown < total ? ` (${input.shown} cargadas)` : "";
  const more = input.hasMore ? " · hay más resultados" : "";
  return q ? `${count} ${scope}${shown}${more}.` : `${count} · ${scope}${shown}${more}.`;
}
