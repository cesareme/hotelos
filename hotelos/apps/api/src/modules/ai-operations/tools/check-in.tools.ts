// checkInReservation (Tanda L6a, lote 3): escritura de riesgo alto que el
// runner deja SIEMPRE en awaiting_confirmation. La ejecución delega en
// executeConfirmation (modules/ai/check-in.command.ts:143, L2), que exige la
// confirmación pendiente y la firma; la tarjeta de confirmación es la de
// buildCheckInConfirmationCard (ai-tools/check-in-flow.ts:19), determinista.

import { z } from "zod";
import type { JsonValue } from "@hotelos/ai-core/runner";
import { buildCheckInConfirmationCard } from "@hotelos/ai-tools";
import type { CheckInFromScanRequest, ConfirmationCard } from "@hotelos/shared";
import { executeConfirmation } from "../../ai/check-in.command.js";
import { defineAiTool } from "./context.js";
import { GuestIdentityFieldsSchema } from "./guest-register.tools.js";

const ROOM_STATUSES = ["clean_inspected", "clean", "dirty", "occupied", "blocked"] as const;

/** Copia JSON plana (sin undefined) para la tarjeta de la fila awaiting_confirmation. */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Datos para pintar la tarjeta sin volver a consultar (los aporta el flujo de escaneo). */
const CardInputSchema = z
  .object({
    request: z
      .object({
        propertyId: z.string().trim().min(1),
        transcript: z.string().max(4000).default(""),
        roomNumber: z.string().trim().min(1),
        documentExtractedFields: GuestIdentityFieldsSchema,
        documentImageStored: z.literal(false),
        idImageDiscarded: z.literal(true)
      })
      .strict(),
    reservation: z.object({ id: z.string(), code: z.string(), arrival: z.string(), departure: z.string(), balanceDue: z.number() }).strict(),
    room: z.object({ allowed: z.boolean(), warnings: z.array(z.string()), roomStatus: z.enum(ROOM_STATUSES), maintenanceBlock: z.boolean() }).strict()
  })
  .strict();

export const checkInReservationTool = defineAiTool({
  name: "checkInReservation",
  effect: "write",
  description: "Ejecuta el check-in de una confirmación pendiente (firma del huésped incluida): registro firmado, entrada, SES y bienvenida.",
  inputSchema: z.object({ confirmationId: z.string().trim().min(1), signatureObjectKey: z.string().trim().default(""), card: CardInputSchema.optional() }).strict(),
  outputSchema: z.custom<Awaited<ReturnType<typeof executeConfirmation>>>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["confirmationId"], properties: { confirmationId: { type: "string" }, signatureObjectKey: { type: "string" } } },
  preview(input): JsonValue {
    if (input.card) {
      try {
        const card: ConfirmationCard = buildCheckInConfirmationCard({ request: input.card.request as CheckInFromScanRequest, reservation: input.card.reservation, room: input.card.room });
        return asJson({ ...card, confirmationId: input.confirmationId });
      } catch (error) {
        // La política id-scan rechaza la tarjeta (imagen retenida): tarjeta mínima con el motivo.
        return asJson({ title: "Confirmar check-in", summary: "No se pudo generar la tarjeta completa.", confirmationId: input.confirmationId, warnings: [error instanceof Error ? error.message : String(error)] });
      }
    }
    return asJson({ title: "Confirmar check-in", summary: "Check-in pendiente de confirmación y firma del huésped.", confirmationId: input.confirmationId, signatureRequired: !input.signatureObjectKey });
  },
  async execute(input, ctx) {
    const result = await executeConfirmation({ context: ctx.user, confirmationId: input.confirmationId, signatureObjectKey: input.signatureObjectKey, correlationId: ctx.correlationId });
    return { output: result, record: { status: result.status, reservationId: result.reservationId, roomId: result.roomId, queuedSubmissionId: result.queuedSubmissionId, warnings: result.warnings ?? [] } };
  }
});
