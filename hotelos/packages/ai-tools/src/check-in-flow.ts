import type { CheckInFromScanRequest, ConfirmationCard } from "@hotelos/shared";
import { detectMissingGuestRegisterFields, enforceSpanishIdScanPolicy } from "@hotelos/compliance";

export type ReservationMatch = {
  id: string;
  code: string;
  arrival: string;
  departure: string;
  balanceDue: number;
};

export type RoomValidation = {
  allowed: boolean;
  warnings: string[];
  roomStatus: "clean_inspected" | "clean" | "dirty" | "occupied" | "blocked";
  maintenanceBlock: boolean;
};

export function buildCheckInConfirmationCard(input: {
  request: CheckInFromScanRequest;
  reservation: ReservationMatch;
  room: RoomValidation;
}): ConfirmationCard {
  const policy = enforceSpanishIdScanPolicy(input.request);
  if (!policy.allowed) {
    throw new Error(policy.errors.join(" "));
  }

  const missingFields = detectMissingGuestRegisterFields(input.request.documentExtractedFields);
  const fullName = [
    input.request.documentExtractedFields.firstName,
    input.request.documentExtractedFields.surname1,
    input.request.documentExtractedFields.surname2
  ]
    .filter(Boolean)
    .join(" ");

  const warnings = [...input.room.warnings];
  if (missingFields.includes("phone")) {
    warnings.push("Phone number is missing. Ask guest before confirming.");
  }

  return {
    title: "Confirm check-in",
    summary: `Ready to check in ${fullName || "guest"} to room ${input.request.roomNumber}.`,
    reservation: {
      code: input.reservation.code,
      arrival: input.reservation.arrival,
      departure: input.reservation.departure,
      balanceDue: input.reservation.balanceDue
    },
    room: {
      number: input.request.roomNumber,
      status: input.room.roomStatus,
      maintenanceBlock: input.room.maintenanceBlock
    },
    guestRegister: {
      missingFields,
      signatureRequired: true
    },
    warnings,
    actions: [
      "Save required guest data",
      "Request signature",
      "Check in reservation",
      "Mark room occupied",
      "Queue authority submission",
      "Send welcome message"
    ]
  };
}

