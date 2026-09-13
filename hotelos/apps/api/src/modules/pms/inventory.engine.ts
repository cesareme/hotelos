import { prisma } from "@hotelos/database";

export type RoomAssignmentInput = {
  propertyId: string;
  reservationId: string;
  roomId?: string;
  roomNumber?: string;
  arrivalDate: string;
  departureDate: string;
};

export type RoomAssignmentValidation = {
  allowed: boolean;
  warnings: string[];
  roomStatus: "clean_inspected" | "clean" | "dirty" | "occupied" | "blocked";
  maintenanceBlock: boolean;
  roomId?: string;
};

export async function canAssignRoom(input: RoomAssignmentInput): Promise<RoomAssignmentValidation> {
  const room = await prisma.room.findFirst({
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
      roomStatus: "blocked",
      maintenanceBlock: true
    };
  }

  const warnings: string[] = [];
  const maintenanceBlock = room.maintenanceStatus === "blocked" || !room.sellable;

  if (maintenanceBlock) {
    warnings.push("La habitación está bloqueada por mantenimiento o no es vendible.");
  }
  if (room.status === "occupied") {
    warnings.push("La habitación está ocupada actualmente.");
  }

  const arrival = new Date(`${input.arrivalDate}T00:00:00.000Z`);
  const departure = new Date(`${input.departureDate}T00:00:00.000Z`);

  const conflictingReservation = await prisma.reservation.findFirst({
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

  const roomStatus: RoomAssignmentValidation["roomStatus"] =
    room.status === "occupied"
      ? "occupied"
      : maintenanceBlock
        ? "blocked"
        : room.housekeepingStatus === "inspected"
          ? "clean_inspected"
          : room.housekeepingStatus === "clean"
            ? "clean"
            : "dirty";

  return {
    allowed: warnings.length === 0,
    warnings,
    roomStatus,
    maintenanceBlock,
    roomId: room.id
  };
}
