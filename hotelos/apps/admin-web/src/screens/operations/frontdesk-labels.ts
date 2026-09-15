// Front-desk labels shared by the check-in / check-out drawers (Cocoa 22 ·
// ola 2 · fix:2-A). The API sends raw enums («checked_out», «dirty») and a
// floor that is "" (Rías Altas, 120/120 rooms) or already «Planta 1» (Los
// Tilos); the operator must never read them as-is. Pure and unit-tested
// (__tests__/frontdesk-labels.test.mts).

/** Reservation status → Spanish label (wording of FrontDeskDashboard / PropertyDetailScreen). */
export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  checked_in: "En casa",
  checked_out: "Salida realizada",
  cancelled: "Cancelada",
  no_show: "No-show"
};

/** Label of a reservation status; an unknown status falls back to the raw value, never to "" (qa#8). */
export function reservationStatusLabel(status: string | null | undefined): string {
  const key = (status ?? "").trim().toLowerCase();
  return RESERVATION_STATUS_LABELS[key] ?? (key || "desconocido");
}

/** Housekeeping status of a room → lowercase label for inline use («Hab. 119 · sucia»). */
export const HOUSEKEEPING_STATUS_LABELS: Record<string, string> = {
  clean: "limpia",
  inspected: "inspeccionada",
  ready: "lista",
  dirty: "sucia",
  occupied: "ocupada",
  ooo: "fuera de servicio",
  out_of_order: "fuera de servicio",
  out_of_service: "fuera de servicio"
};

/** Label of a housekeeping status; unknown → the raw value, absent → «desconocido». */
export function housekeepingStatusLabel(status: string | null | undefined): string {
  const key = (status ?? "").trim().toLowerCase();
  return HOUSEKEEPING_STATUS_LABELS[key] ?? (key || "desconocido");
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
