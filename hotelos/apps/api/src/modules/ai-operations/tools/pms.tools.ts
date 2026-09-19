// Herramientas PMS (Tanda L6a, lote 3): cuatro lecturas sobre pms.service /
// inventory.engine y una escritura (assignRoom) que el runner deja SIEMPRE en
// awaiting_confirmation. Toda lectura se acota a la propiedad del contexto.

import { z } from "zod";
import { NotFoundError } from "../../../lib/http-error.js";
import { canAssignRoom } from "../../pms/inventory.engine.js";
import { assignRoom, getReservation, listReservations, matchGuestToReservation, quoteAvailability } from "../../pms/pms.service.js";
import { defineAiTool } from "./context.js";
import { GuestIdentityFieldsSchema } from "./guest-register.tools.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha YYYY-MM-DD.");

type ReservationRecord = Awaited<ReturnType<typeof getReservation>>;

/** Resumen sin datos personales para la telemetría (outputJson). */
function reservationSummary(reservation: ReservationRecord): { id: string; code: string; status: string; arrivalDate: string; departureDate: string } {
  return { id: reservation.id, code: reservation.code, status: String(reservation.status), arrivalDate: reservation.arrivalDate, departureDate: reservation.departureDate };
}

export const findReservationTool = defineAiTool({
  name: "findReservation",
  effect: "read",
  description: "Localiza una reserva de la propiedad por id o por código (búsqueda exacta; si no, candidatas por texto).",
  inputSchema: z
    .object({ reservationId: z.string().trim().min(1).optional(), code: z.string().trim().min(1).max(64).optional() })
    .strict()
    .refine((value) => Boolean(value.reservationId || value.code), { message: "Indique reservationId o code." }),
  outputSchema: z.object({ reservation: z.custom<ReservationRecord | null>(), candidates: z.array(z.custom<ReservationRecord>()) }),
  modelInputSchema: { type: "object", additionalProperties: false, properties: { reservationId: { type: "string" }, code: { type: "string", description: "Código de reserva (p. ej. RES-18392)." } } },
  async execute(input, ctx) {
    if (input.reservationId) {
      const reservation = await getReservation(input.reservationId);
      // Tenencia: una reserva de otra propiedad es un 404 opaco (nunca se filtra su existencia).
      if (reservation.propertyId !== ctx.propertyId) throw new NotFoundError("Reserva no encontrada.");
      return { output: { reservation, candidates: [] }, record: { reservation: reservationSummary(reservation), candidates: 0 } };
    }
    const code = input.code!;
    const page = await listReservations(ctx.propertyId, { q: code, limit: 10 });
    const exact = page.items.find((item) => item.code.toLowerCase() === code.toLowerCase()) ?? null;
    const candidates = exact ? [] : page.items;
    return { output: { reservation: exact, candidates }, record: { reservation: exact ? reservationSummary(exact) : null, candidates: candidates.length } };
  }
});

export const matchGuestToReservationTool = defineAiTool({
  name: "matchGuestToReservation",
  effect: "read",
  description: "Busca el huésped y la reserva más probables para los campos de identidad extraídos de un documento.",
  inputSchema: z.object({ documentFields: GuestIdentityFieldsSchema }).strict(),
  outputSchema: z.custom<Awaited<ReturnType<typeof matchGuestToReservation>>>(),
  async execute(input, ctx) {
    const match = await matchGuestToReservation({ propertyId: ctx.propertyId, documentFields: input.documentFields });
    // outputJson sin datos personales: solo identificadores.
    return { output: match, record: { guestId: match.guest.id, reservation: reservationSummary(match.reservation) } };
  }
});

export const validateRoomAssignmentTool = defineAiTool({
  name: "validateRoomAssignment",
  effect: "read",
  description: "Comprueba si una habitación puede asignarse a una reserva en su rango de fechas (estado, bloqueos, solapes).",
  inputSchema: z
    .object({ reservationId: z.string().trim().min(1), roomId: z.string().trim().min(1).optional(), roomNumber: z.string().trim().min(1).optional(), arrivalDate: isoDate, departureDate: isoDate })
    .strict()
    .refine((value) => Boolean(value.roomId || value.roomNumber), { message: "Indique roomId o roomNumber." }),
  outputSchema: z.custom<Awaited<ReturnType<typeof canAssignRoom>>>(),
  modelInputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["reservationId", "arrivalDate", "departureDate"],
    properties: { reservationId: { type: "string" }, roomId: { type: "string" }, roomNumber: { type: "string" }, arrivalDate: { type: "string" }, departureDate: { type: "string" } }
  },
  async execute(input, ctx) {
    return canAssignRoom({ propertyId: ctx.propertyId, reservationId: input.reservationId, roomId: input.roomId, roomNumber: input.roomNumber, arrivalDate: input.arrivalDate, departureDate: input.departureDate });
  }
});

export const quoteAvailabilityTool = defineAiTool({
  name: "quoteAvailability",
  effect: "read",
  description: "Cotiza disponibilidad y precio por tipo de habitación para unas fechas y ocupación (única fuente de precios para la IA de reservas).",
  inputSchema: z
    .object({ arrivalDate: isoDate, departureDate: isoDate, adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(20).optional(), roomTypeId: z.string().trim().min(1).optional(), ratePlanId: z.string().trim().min(1).optional() })
    .strict(),
  outputSchema: z.array(z.custom<Awaited<ReturnType<typeof quoteAvailability>>[number]>()),
  modelInputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["arrivalDate", "departureDate", "adults"],
    properties: { arrivalDate: { type: "string" }, departureDate: { type: "string" }, adults: { type: "integer" }, children: { type: "integer" }, roomTypeId: { type: "string" }, ratePlanId: { type: "string" } }
  },
  async execute(input, ctx) {
    return quoteAvailability({ propertyId: ctx.propertyId, ...input });
  }
});

export const assignRoomTool = defineAiTool({
  name: "assignRoom",
  effect: "write",
  description: "Asigna una habitación a una reserva (escritura: siempre con confirmación de una persona).",
  inputSchema: z.object({ reservationId: z.string().trim().min(1), roomId: z.string().trim().min(1) }).strict(),
  outputSchema: z.custom<ReservationRecord>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["reservationId", "roomId"], properties: { reservationId: { type: "string" }, roomId: { type: "string" } } },
  preview(input) {
    return { action: "assignRoom", reservationId: input.reservationId, roomId: input.roomId };
  },
  async execute(input, ctx) {
    const reservation = await assignRoom({ context: ctx.user, reservationId: input.reservationId, roomId: input.roomId, correlationId: ctx.correlationId });
    return { output: reservation, record: { reservation: reservationSummary(reservation), assignedRoomId: reservation.assignedRoomId ?? null } };
  }
});
