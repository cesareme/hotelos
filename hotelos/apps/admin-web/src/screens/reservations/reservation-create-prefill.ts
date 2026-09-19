// Nueva reserva · valores prefijados por la URL (Tanda TL · corrección 1).
//
// El Live Timeline navega a /recepcion/reservas/nueva?arrivalDate=…&
// departureDate=…&roomTypeId=…&assignedRoomId=… al crear una reserva
// seleccionando celdas (newReservationSearch del motor). Este módulo puro (sin
// DOM ni React; unit-tested) valida esos parámetros: fechas ISO reales y
// salida posterior a la llegada (si una de las dos falla, ninguna se aplica:
// el formulario nunca queda con salida ≤ llegada), e ids con caracteres de
// identificador. Todo lo demás se ignora en silencio: nunca se inventa nada.

export type ReservationPrefill = {
  arrivalDate?: string;
  departureDate?: string;
  roomTypeId?: string;
  assignedRoomId?: string;
};

export const PREFILL_NOTE = "Fechas, tipo y habitación prefijados desde el Live Timeline: revísalos antes de continuar.";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Parámetros válidos de la query (con o sin «?»). */
export function parseReservationPrefill(search: string): ReservationPrefill {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: ReservationPrefill = {};
  const arrival = params.get("arrivalDate") ?? "";
  const departure = params.get("departureDate") ?? "";
  if (isRealDate(arrival) && isRealDate(departure) && departure > arrival) {
    out.arrivalDate = arrival;
    out.departureDate = departure;
  }
  const roomTypeId = params.get("roomTypeId") ?? "";
  if (ID.test(roomTypeId)) out.roomTypeId = roomTypeId;
  const assignedRoomId = params.get("assignedRoomId") ?? "";
  if (ID.test(assignedRoomId)) out.assignedRoomId = assignedRoomId;
  return out;
}

export function hasReservationPrefill(prefill: ReservationPrefill): boolean {
  return Object.keys(prefill).length > 0;
}
