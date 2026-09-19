// Front-desk labels shared by the check-in / check-out drawers (Cocoa 22 ·
// ola 2 · fix:2-A). The API sends raw enums («checked_out», «dirty») and a
// floor that is "" (Rías Altas, 120/120 rooms) or already «Planta 1» (Los
// Tilos); the operator must never read them as-is. Pure and unit-tested
// (__tests__/frontdesk-labels.test.mts).
//
// Tanda UX-1 · lote U2: the labels come from content/status-dictionary.ts
// (one vocabulary for every screen, D5); this module only re-exports them
// and keeps the helpers the drawers already import.

import { RESERVATION_STATUS, ROOM_STATUS, reservationStatus, roomStatus, statusLabels } from "../../content/status-dictionary";

export { RESERVATION_STATUS, ROOM_STATUS, reservationStatus, roomStatus } from "../../content/status-dictionary";

/** Reservation status → Spanish label (D5 vocabulary, derived from the dictionary). */
export const RESERVATION_STATUS_LABELS: Record<string, string> = statusLabels(RESERVATION_STATUS);

/** Label of a reservation status; an unknown or absent status reads «Desconocido», never the raw enum (qa#8, P6). */
export function reservationStatusLabel(status: string | null | undefined): string {
  return reservationStatus(status).label;
}

/** Housekeeping status of a room → lowercase label for inline use («Hab. 119 · sucia»). */
export const HOUSEKEEPING_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(statusLabels(ROOM_STATUS)).map(([key, label]) => [key, label.toLowerCase()])
);

/** Lowercase label of a housekeeping status; unknown or absent → «desconocido», never the raw enum. */
export function housekeepingStatusLabel(status: string | null | undefined): string {
  return roomStatus(status).label.toLowerCase();
}

/**
 * «Hab. 119 · planta 2 · limpia»: the floor segment only when the API sends
 * one, and never «planta Planta 1» when the value already names it (qa#7).
 */
export function roomOptionLabel(room: { number: string; floor?: string | null }, state: string): string {
  const floor = (room.floor ?? "").trim();
  const floorLabel = !floor ? null : /^planta\b/i.test(floor) ? floor : `planta ${floor}`;
  return [`Hab. ${room.number}`, floorLabel, state].filter(Boolean).join(" · ");
}
