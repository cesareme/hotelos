import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
// Tanda L5 (lote A): la lectura del estado de habitación pasa por el helper único.
import { roomStateOf, type HousekeepingStatus } from "../housekeeping/room-state.service.js";

/** Prisma client or interactive-transaction client (re-validation under a row lock). */
export type InventoryDb = Prisma.TransactionClient | typeof prisma;

export type RoomAssignmentInput = {
  propertyId: string;
  reservationId: string;
  roomId?: string;
  roomNumber?: string;
  arrivalDate: string;
  departureDate: string;
  /**
   * Optional transaction client. When the caller holds a lock on the room row
   * (pms.service `lockRoomRow`) the queries below run inside that transaction,
   * so a concurrent assignment that committed meanwhile is visible here.
   */
  db?: InventoryDb;
};

export type RoomAssignmentValidation = {
  allowed: boolean;
  /** Blocking reasons — `allowed` is false whenever this is non-empty. */
  warnings: string[];
  /**
   * Informative, NON-blocking remarks (e.g. a room flagged `occupied` with no
   * in-house reservation behind it). Never influences `allowed`.
   */
  notes?: string[];
  roomStatus: "clean_inspected" | "clean" | "dirty" | "occupied" | "blocked";
  /**
   * Tanda L5 (aditivo): limpieza por `housekeepingStatus` (dirty | clean |
   * inspected) en cualquier ocupación; null cuando la habitación no existe.
   * Informativo: `allowed` NO depende de ella (una sucia no bloquea).
   */
  cleanliness: HousekeepingStatus | null;
  maintenanceBlock: boolean;
  roomId?: string;
};

export async function canAssignRoom(input: RoomAssignmentInput): Promise<RoomAssignmentValidation> {
  const db = input.db ?? prisma;
  const room = await db.room.findFirst({
    where: {
      propertyId: input.propertyId,
      OR: [
        input.roomId ? { id: input.roomId } : null,
        input.roomNumber ? { number: input.roomNumber } : null
      ].filter((clause): clause is { id: string } | { number: string } => Boolean(clause))
    }
  });

  if (!room) {
    return {
      allowed: false,
      warnings: ["La habitación no existe en esta propiedad."],
      notes: [],
      roomStatus: "blocked",
      cleanliness: null,
      maintenanceBlock: true
    };
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  const state = roomStateOf(room);
  const maintenanceBlock = state.isBlocked;

  if (maintenanceBlock) {
    warnings.push("La habitación está bloqueada por mantenimiento o no es vendible.");
  } else if (state.occupancy === "out_of_order" || state.occupancy === "out_of_service") {
    // Corrector L5 (OP-02): una fuera de servicio / fuera de orden sin bloqueo de
    // mantenimiento (importación de onboarding, «Bloquear habitación» del Room Rack)
    // tampoco se asigna: `status` es la ocupación / disponibilidad.
    warnings.push(state.occupancy === "out_of_service" ? "La habitación está fuera de servicio." : "La habitación está fuera de orden.");
  }
  if (room.status === "occupied") {
    // REC-03: `occupied` is only a conflict when an in-house reservation OTHER
    // than the one being validated actually holds the room. The reservation
    // re-validating its own room (PATCH with the current assignedRoomId, a
    // move that lands on the same room) is not a conflict.
    //
    // NUEVO-ORPHAN-OCCUPIED: a room flagged `occupied` with NO checked_in
    // reservation behind it is an inconsistent state (a lost race, a manual
    // status edit, a failed check-out). It used to block every assignment
    // until housekeeping marked the room clean; now it is reported as a
    // non-blocking note so reception can reuse the room, and logged so the
    // inconsistency does not go unnoticed.
    const inHouse = await db.reservation.findMany({
      where: { assignedRoomId: room.id, status: "checked_in" },
      select: { id: true, code: true },
      take: 10
    });
    const otherOccupant = inHouse.find((r) => r.id !== input.reservationId);
    const occupiedBySelf = inHouse.some((r) => r.id === input.reservationId);
    if (otherOccupant) {
      warnings.push("La habitación está ocupada actualmente.");
    } else if (!occupiedBySelf) {
      notes.push(
        "La habitación figura como ocupada pero no tiene ninguna reserva alojada; se permite la asignación, revisa su estado en housekeeping."
      );
      console.warn("[inventory.canAssignRoom] room flagged occupied without an in-house reservation (orphan status)", {
        roomId: room.id,
        roomNumber: room.number,
        propertyId: room.propertyId,
        reservationId: input.reservationId
      });
    }
  }

  const arrival = new Date(`${input.arrivalDate}T00:00:00.000Z`);
  const departure = new Date(`${input.departureDate}T00:00:00.000Z`);

  const conflictingReservation = await db.reservation.findFirst({
    where: {
      propertyId: input.propertyId,
      id: { not: input.reservationId },
      assignedRoomId: room.id,
      status: { in: ["confirmed", "checked_in"] },
      arrivalDate: { lt: departure },
      departureDate: { gt: arrival }
    },
    select: { code: true }
  });

  if (conflictingReservation) {
    warnings.push(`La habitación ya está asignada a la reserva ${conflictingReservation.code}.`);
  }

  // Tanda L5: derivado de roomStateOf (ocupación por `status`, limpieza por hk).
  const roomStatus: RoomAssignmentValidation["roomStatus"] =
    state.occupancy === "occupied"
      ? "occupied"
      : maintenanceBlock
        ? "blocked"
        : state.cleanliness === "inspected"
          ? "clean_inspected"
          : state.cleanliness === "clean"
            ? "clean"
            : "dirty";

  return {
    allowed: warnings.length === 0,
    warnings,
    notes,
    roomStatus,
    cleanliness: state.cleanliness,
    maintenanceBlock,
    roomId: room.id
  };
}
