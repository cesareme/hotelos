// Herramientas PMS (Tanda L6a, lote 3): cuatro lecturas sobre pms.service /
// inventory.engine y una escritura (assignRoom) que el runner deja SIEMPRE en
// awaiting_confirmation. Toda lectura se acota a la propiedad del contexto.
//
// Tanda CHK (W4-D): suggestRoomAssignment (lectura sobre room-assignment.service
// W2-C: top-3 con motivo, persiste AssignmentSuggestion, nunca asigna) y
// createServiceRequest (escritura del conserje: el bot del huésped la deja en
// awaiting_confirmation y recepción la confirma en /ai/tool-calls/:id/confirm;
// vive aquí porque messaging.tools.ts no pertenece al lote). Ninguna toca dinero.

import { z } from "zod";
import type { ServiceRequestRecord } from "../../../lib/demo-store.js";
import { NotFoundError } from "../../../lib/http-error.js";
import { createServiceRequest } from "../../messaging/messaging.service.js";
import { canAssignRoom } from "../../pms/inventory.engine.js";
import { assignRoom, getReservation, listReservations, matchGuestToReservation, quoteAvailability } from "../../pms/pms.service.js";
import { suggestForReservation, type AssignmentSuggestionDetailDto } from "../../pms/room-assignment.service.js";
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

// ---------------------------------------------------------------------------
// Tanda CHK · W4-D
// ---------------------------------------------------------------------------

/** Resumen sin datos personales de una sugerencia (los `detail` de los motivos pueden citar specialRequests: fuera del record). */
function suggestionSummary(suggestion: AssignmentSuggestionDetailDto): { suggestionId: string | null; reservationId: string; sessionId: string | null; candidates: number; rejected: number; top: Array<{ roomId: string; number: string; score: number; reasons: number; warnings: number }>; confidence: number; automationLevel: string; status: string; persisted: boolean; housekeepingAlerts: number } {
  return {
    suggestionId: suggestion.persisted ? suggestion.id : null,
    reservationId: suggestion.reservationId,
    sessionId: suggestion.sessionId,
    candidates: suggestion.candidates.length,
    rejected: suggestion.rejectedCount,
    top: suggestion.candidates.slice(0, 3).map((candidate) => ({ roomId: candidate.roomId, number: candidate.number, score: candidate.score, reasons: candidate.reasons.length, warnings: candidate.warnings.length })),
    confidence: suggestion.confidence,
    automationLevel: suggestion.automationLevel,
    status: suggestion.status,
    persisted: suggestion.persisted,
    housekeepingAlerts: suggestion.housekeepingAlerts.length
  };
}

export const suggestRoomAssignmentTool = defineAiTool({
  name: "suggestRoomAssignment",
  effect: "read",
  description: "Propone las tres mejores habitaciones para una reserva con el motivo de cada una (motor de asignación explicable); nunca asigna: assignRoom sigue exigiendo confirmación.",
  inputSchema: z.object({ reservationId: z.string().trim().min(1), sessionId: z.string().trim().min(1).optional(), persist: z.boolean().optional() }).strict(),
  outputSchema: z.custom<AssignmentSuggestionDetailDto>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["reservationId"], properties: { reservationId: { type: "string" }, sessionId: { type: "string", description: "Sesión de check-in en línea (preferencias y ETA declaradas)." }, persist: { type: "boolean", description: "false = solo en memoria (sin fila assignment_suggestions)." } } },
  async execute(input, ctx) {
    // Tenencia y permiso (pms.reservation.read) los aplica el propio servicio con ctx.user; la reserva de otra organización es un 404 opaco.
    const suggestion = await suggestForReservation({ context: ctx.user, reservationId: input.reservationId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), persist: input.persist ?? true });
    return { output: suggestion, record: suggestionSummary(suggestion) };
  }
});

/** Tipos de petición del ServiceRequestRecord (lib/demo-store.ts) y departamento por defecto de cada uno. */
export const SERVICE_REQUEST_TYPES = ["towels", "cleaning", "maintenance", "parking", "breakfast", "late_checkout"] as const satisfies readonly ServiceRequestRecord["requestType"][];
export const SERVICE_REQUEST_DEPARTMENTS = ["housekeeping", "maintenance", "reception", "concierge"] as const satisfies readonly NonNullable<ServiceRequestRecord["assignedDepartment"]>[];
const DEFAULT_DEPARTMENT: Record<(typeof SERVICE_REQUEST_TYPES)[number], (typeof SERVICE_REQUEST_DEPARTMENTS)[number]> = {
  towels: "housekeeping",
  cleaning: "housekeeping",
  maintenance: "maintenance",
  parking: "reception",
  breakfast: "concierge",
  late_checkout: "reception"
};

export const createServiceRequestTool = defineAiTool({
  name: "createServiceRequest",
  effect: "write",
  description: "Crea una petición de servicio del huésped (toallas, limpieza, mantenimiento, parking, desayuno o late check-out) para su reserva (escritura: siempre con confirmación de una persona; el cargo, si lo hay, lo aplica recepción).",
  inputSchema: z
    .object({
      reservationId: z.string().trim().min(1),
      guestId: z.string().trim().min(1).optional(),
      requestType: z.enum(SERVICE_REQUEST_TYPES),
      assignedDepartment: z.enum(SERVICE_REQUEST_DEPARTMENTS).optional(),
      /** Texto breve para la persona que confirma (p. ej. «hasta las 14:00»); nunca datos personales. */
      note: z.string().trim().min(1).max(500).optional()
    })
    .strict(),
  outputSchema: z.custom<ServiceRequestRecord>(),
  modelInputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["reservationId", "requestType"],
    properties: { reservationId: { type: "string" }, guestId: { type: "string" }, requestType: { type: "string", enum: [...SERVICE_REQUEST_TYPES] }, assignedDepartment: { type: "string", enum: [...SERVICE_REQUEST_DEPARTMENTS] }, note: { type: "string" } }
  },
  preview(input) {
    return { action: "createServiceRequest", reservationId: input.reservationId, requestType: input.requestType, assignedDepartment: input.assignedDepartment ?? DEFAULT_DEPARTMENT[input.requestType], note: input.note ?? null };
  },
  async execute(input, ctx) {
    const reservation = await getReservation(input.reservationId);
    // Tenencia: una reserva de otra propiedad es un 404 opaco (nunca se filtra su existencia).
    if (reservation.propertyId !== ctx.propertyId) throw new NotFoundError("Reserva no encontrada.");
    const request = await createServiceRequest({
      context: ctx.user,
      propertyId: ctx.propertyId,
      reservationId: reservation.id,
      ...(input.guestId ? { guestId: input.guestId } : reservation.primaryGuestId ? { guestId: reservation.primaryGuestId } : {}),
      requestType: input.requestType,
      assignedDepartment: input.assignedDepartment ?? DEFAULT_DEPARTMENT[input.requestType],
      correlationId: ctx.correlationId
    });
    return { output: request, record: { serviceRequestId: request.id, reservationId: request.reservationId ?? null, requestType: request.requestType, assignedDepartment: request.assignedDepartment ?? null, status: request.status } };
  }
});
