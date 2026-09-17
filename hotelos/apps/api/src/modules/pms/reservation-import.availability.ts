// Importación masiva de reservas (Tanda 7 · L2) — planificador de disponibilidad, PURO.
//
// Replica la REGLA DE RANGO de `createReservation` (pms.service.ts: lock por
// (propiedad, tipo) y `reservation.aggregate` de `roomsCount` de las reservas
// `confirmed | checked_in` del tipo que solapan el rango completo de la nueva
// reserva; 409 cuando `bookedRooms + requested > totalRooms`) sumando, además,
// las filas ANTERIORES del fichero que se van a crear como confirmadas. Así la
// previsualización enseña exactamente lo que el commit va a decidir bajo lock.
//
//   · Las filas se recorren en el orden del fichero.
//   · Una fila `cancelada` se comprueba (se crea y se cancela en el commit) pero
//     NO cuenta para las siguientes; una `tentativa` se crea confirmada y cuenta.
//   · Las filas históricas (estancia cerrada) NO entran: no consumen inventario.
//   · Una fila que excede el cupo se rechaza (no cuenta para las siguientes) salvo
//     con `permitirOverbooking`, que la acepta con aviso y la deja contar.
//   · La tabla tipo × noche es INFORMATIVA: `nightsExceeded` (noches en las que la
//     suma por noche de BD + filas aceptadas supera el cupo) y `rangeRuleRows`
//     (filas que exceden por la regla de rango aunque cabrían noche a noche), para
//     que la UI explique por qué el PMS es más conservador que un cupo por noche.
//
// Ejemplo verificado (diseño §5.5): tipo con 2 habitaciones, A 1→2, B 3→4, C 1→4:
// por noche caben (máximo 2 por noche), pero para C el PMS suma A y B (ambas
// solapan 1→4) → 2 + 1 > 2 → C no cabe y figura en `rangeRuleRows`.
//
// Sin base de datos ni datos personales: solo fechas, tipos y unidades.

import type {
  IsoDate,
  ReservationImportAvailability,
  ReservationImportAvailabilityByType,
  ReservationImportEstado,
  ReservationImportRowAvailability
} from "@hotelos/shared";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Fila candidata del fichero (ya normalizada y sin errores previos). */
export type AvailabilityPlanRow = {
  rowNumber: number;
  roomTypeId: string;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  roomsCount: number;
  /** `cancelada` se comprueba pero no cuenta para las filas siguientes. */
  estado: ReservationImportEstado;
  /** Las filas históricas quedan fuera del planificador. */
  historical: boolean;
};

/** Cupo del tipo con la misma consulta que `createReservation` (vendibles y no bloqueadas). */
export type AvailabilityInventory = {
  roomTypeId: string;
  code: string;
  name: string;
  totalRooms: number;
};

/** Reserva `confirmed | checked_in` de la BD que solapa alguna fila (sin filtrar `deletedAt`, como el servicio). */
export type AvailabilityExistingReservation = {
  roomTypeId: string;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  roomsCount: number;
};

export type PlanAvailabilityInput = {
  rows: readonly AvailabilityPlanRow[];
  inventory: readonly AvailabilityInventory[];
  existing: readonly AvailabilityExistingReservation[];
  permitirOverbooking?: boolean;
};

export type PlanAvailabilityResult = ReservationImportAvailability & {
  /** Cupo, reservado en BD, reservado en el fichero y `exceeds` por nº de fila (solo filas planificadas). */
  perRow: Map<number, ReservationImportRowAvailability>;
  /** Filas que exceden el cupo SIN `permitirOverbooking` (se convertirán en error NO_AVAILABILITY). */
  rejectedRows: number[];
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

/** Solape de dos estancias [aFrom, aTo) y [bFrom, bTo): la regla del PMS (`arrival < departure` y `departure > arrival`). */
export function staysOverlap(aFrom: IsoDate, aTo: IsoDate, bFrom: IsoDate, bTo: IsoDate): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/** Noches de una estancia: fechas ISO desde la llegada hasta la víspera de la salida. */
export function nightsOf(arrivalDate: IsoDate, departureDate: IsoDate): IsoDate[] {
  const from = Date.parse(`${arrivalDate}T00:00:00Z`);
  const to = Date.parse(`${departureDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const out: IsoDate[] = [];
  for (let t = from; t < to; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

type Stay = { arrivalDate: IsoDate; departureDate: IsoDate; roomsCount: number };

function sumOverlapping(stays: readonly Stay[], arrivalDate: IsoDate, departureDate: IsoDate): number {
  let total = 0;
  for (const stay of stays) {
    if (staysOverlap(stay.arrivalDate, stay.departureDate, arrivalDate, departureDate)) total += stay.roomsCount;
  }
  return total;
}

/** Σ unidades de las estancias que incluyen la noche `night`. */
function sumOnNight(stays: readonly Stay[], night: IsoDate): number {
  let total = 0;
  for (const stay of stays) {
    if (stay.arrivalDate <= night && night < stay.departureDate) total += stay.roomsCount;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Planificador
// ---------------------------------------------------------------------------

/**
 * Aplica la regla de rango del PMS a las filas del fichero en orden, con las
 * reservas existentes de la BD y las filas anteriores aceptadas, y construye la
 * tabla informativa tipo × noche. Determinista y sin efectos.
 */
export function planAvailability(input: PlanAvailabilityInput): PlanAvailabilityResult {
  const permitirOverbooking = input.permitirOverbooking === true;
  const inventory = new Map<string, AvailabilityInventory>();
  for (const item of input.inventory) inventory.set(item.roomTypeId, item);

  const existingByType = new Map<string, Stay[]>();
  for (const reservation of input.existing) {
    const list = existingByType.get(reservation.roomTypeId) ?? [];
    list.push({ arrivalDate: reservation.arrivalDate, departureDate: reservation.departureDate, roomsCount: reservation.roomsCount });
    existingByType.set(reservation.roomTypeId, list);
  }

  /** Filas aceptadas que quedan confirmadas (cuentan para las siguientes y para la tabla por noche). */
  const acceptedByType = new Map<string, Stay[]>();
  const perRow = new Map<number, ReservationImportRowAvailability>();
  const overbookingRows: number[] = [];
  const rejectedRows: number[] = [];
  const rangeRuleByType = new Map<string, number[]>();
  const peakDbByType = new Map<string, number>();
  const peakFileByType = new Map<string, number>();
  const requestedByType = new Map<string, number>();
  const typesInFile: string[] = [];

  for (const row of input.rows) {
    if (row.historical) continue;
    if (!typesInFile.includes(row.roomTypeId)) typesInFile.push(row.roomTypeId);
    requestedByType.set(row.roomTypeId, (requestedByType.get(row.roomTypeId) ?? 0) + row.roomsCount);

    const totalRooms = inventory.get(row.roomTypeId)?.totalRooms ?? 0;
    const existing = existingByType.get(row.roomTypeId) ?? [];
    const accepted = acceptedByType.get(row.roomTypeId) ?? [];
    const bookedDb = sumOverlapping(existing, row.arrivalDate, row.departureDate);
    const bookedFile = sumOverlapping(accepted, row.arrivalDate, row.departureDate);
    const exceeds = bookedDb + bookedFile + row.roomsCount > totalRooms;
    perRow.set(row.rowNumber, { totalRooms, bookedDb, bookedFile, exceeds });
    peakDbByType.set(row.roomTypeId, Math.max(peakDbByType.get(row.roomTypeId) ?? 0, bookedDb));
    peakFileByType.set(row.roomTypeId, Math.max(peakFileByType.get(row.roomTypeId) ?? 0, bookedFile));

    if (exceeds) {
      // ¿Cabría noche a noche? Entonces es la regla de rango la que la rechaza.
      const fitsPerNight = nightsOf(row.arrivalDate, row.departureDate).every(
        (night) => sumOnNight(existing, night) + sumOnNight(accepted, night) + row.roomsCount <= totalRooms
      );
      if (fitsPerNight) {
        const list = rangeRuleByType.get(row.roomTypeId) ?? [];
        list.push(row.rowNumber);
        rangeRuleByType.set(row.roomTypeId, list);
      }
      if (!permitirOverbooking) {
        rejectedRows.push(row.rowNumber);
        continue;
      }
      overbookingRows.push(row.rowNumber);
    }
    if (row.estado !== "cancelada") {
      accepted.push({ arrivalDate: row.arrivalDate, departureDate: row.departureDate, roomsCount: row.roomsCount });
      acceptedByType.set(row.roomTypeId, accepted);
    }
  }

  const byRoomType: ReservationImportAvailabilityByType[] = typesInFile.map((roomTypeId) => {
    const item = inventory.get(roomTypeId);
    const existing = existingByType.get(roomTypeId) ?? [];
    const accepted = acceptedByType.get(roomTypeId) ?? [];
    const totalRooms = item?.totalRooms ?? 0;
    // Noches cubiertas por alguna fila planificada del tipo (rechazadas incluidas: la tabla explica el fichero entero).
    const nights = new Set<IsoDate>();
    for (const row of input.rows) {
      if (row.historical || row.roomTypeId !== roomTypeId) continue;
      for (const night of nightsOf(row.arrivalDate, row.departureDate)) nights.add(night);
    }
    const nightsExceeded = Array.from(nights)
      .sort()
      .filter((night) => sumOnNight(existing, night) + sumOnNight(accepted, night) > totalRooms);
    return {
      roomTypeId,
      code: item?.code ?? roomTypeId,
      name: item?.name ?? roomTypeId,
      totalRooms,
      rowsRequested: requestedByType.get(roomTypeId) ?? 0,
      peakBookedDb: peakDbByType.get(roomTypeId) ?? 0,
      peakBookedFile: peakFileByType.get(roomTypeId) ?? 0,
      nightsExceeded,
      rangeRuleRows: rangeRuleByType.get(roomTypeId) ?? []
    };
  });
  byRoomType.sort((a, b) => a.code.localeCompare(b.code));

  return { perRow, byRoomType, overbookingRows, rejectedRows };
}
