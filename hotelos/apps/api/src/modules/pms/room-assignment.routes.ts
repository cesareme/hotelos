// Tanda CHK (lote W3-B) · Superficie HTTP de la asignación explicable — diseño
// §7.2 (docs/design/CHECKIN-AUTOMATIZADO-IA.md) sobre el servicio del lote W2-C
// (room-assignment.service.ts). Registro: `registerRoomAssignmentRoutes(app)`
// desde server.ts justo después de registerCheckinRoutes(app). Permisos:
// room-assignment-route-permissions.partial.ts (10 entradas, segundo partial del
// módulo pms; spread en security/route-permissions.ts tras el de checkin).
//
//   POST /reservations/:id/assignment-suggestions   pms.reservation.read · low
//        body { sessionId? } → suggestForReservation (persiste; 201 con el DTO +
//        rejected / dataNotes / housekeepingAlerts en memoria).
//   GET  /reservations/:id/assignment-suggestions   pms.reservation.read · low
//        { current: última `suggested` | null, history: todas, la más reciente primero }.
//   POST /assignment-suggestions/:id/confirm        pms.reservation.modify · high
//        body { roomId? } → confirmSuggestion (assignRoom con la candidata o la elegida).
//   POST /properties/:propertyId/check-in/assignments/run  pms.reservation.modify · high
//        body { date? } → runBatchForDate (sin date: mañana según la fecha de negocio).
//   GET/POST /properties/:propertyId/room-blocks · DELETE /room-blocks/:id
//        listar pms.reservation.read · low; crear/borrar pms.reservation.modify · medium.
//   GET/POST /properties/:propertyId/room-connections · DELETE /room-connections/:id
//        mismo reparto que los bloqueos.
//
// Tenencia: el preHandler global de server.ts resuelve `:propertyId` (404 opaco y
// permisos re-ámbito a esa propiedad); las rutas por `:id` cruzan la fila con
// assertEntityAccess({ entity: reservation | assignmentSuggestion | roomBlock |
// roomConnection }) (lib/tenancy.ts, resolvers del lote W2-A) → 404 opaco si
// cuelga de otra organización o de una propiedad no asignada al usuario. El
// servicio repite la comprobación de organización (assertPropertyOfOrg) y exige
// el permiso (requirePermissions) aunque el manifiesto ya lo aplicara.
//
// Todo cuerpo y consulta pasa por un esquema zod `.strict()` con parseOr400
// (rate-grid.schemas.ts) → 400 VALIDATION_ERROR; los errores del motor llegan
// del servicio ya en español (404 / 409 ROOM_BLOCK_OVERLAP /
// ROOM_CONNECTION_EXISTS / ASSIGNMENT_SUGGESTION_DECIDED); correlationId
// createId("corr") en cada escritura.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ROOM_BLOCK_REASONS, ROOM_CONNECTION_KINDS } from "@hotelos/shared";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  confirmSuggestion,
  createRoomBlock,
  createRoomConnection,
  deleteRoomBlock,
  deleteRoomConnection,
  listRoomBlocks,
  listRoomConnections,
  listSuggestionsForReservation,
  runBatchForDate,
  suggestForReservation
} from "./room-assignment.service.js";

type IdParams = { id: string };
type PropertyParams = { propertyId: string };

// ---------------------------------------------------------------------------
// Esquemas (vocabularios de packages/shared/src/checkin-types.ts)
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = z.string().trim().regex(ISO_DAY, "fecha YYYY-MM-DD");
const identifier = z.string().trim().min(1).max(80);

/** POST /reservations/:id/assignment-suggestions */
export const SuggestSchema = z.object({ sessionId: identifier.nullable().optional() }).strict();

/** POST /assignment-suggestions/:id/confirm — sin roomId, la primera candidata. */
export const ConfirmSuggestionSchema = z.object({ roomId: identifier.nullable().optional() }).strict();

/** POST /properties/:propertyId/check-in/assignments/run — sin date, mañana. */
export const BatchRunSchema = z.object({ date: isoDay.nullable().optional() }).strict();

export const RoomBlocksQuerySchema = z.object({ roomId: identifier.optional(), from: isoDay.optional(), to: isoDay.optional() }).strict();

export const RoomBlockCreateSchema = z
  .object({
    roomId: identifier,
    fromDate: isoDay,
    toDate: isoDay,
    reason: z.enum(ROOM_BLOCK_REASONS),
    note: z.string().trim().max(500).nullable().optional(),
    workOrderId: identifier.nullable().optional()
  })
  .strict();

export const RoomConnectionsQuerySchema = z.object({ roomId: identifier.optional() }).strict();

export const RoomConnectionCreateSchema = z.object({ roomAId: identifier, roomBId: identifier, kind: z.enum(ROOM_CONNECTION_KINDS) }).strict();

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

export function registerRoomAssignmentRoutes(app: FastifyInstance): void {
  // ── Sugerencias por reserva ────────────────────────────────────────────────
  app.post("/reservations/:id/assignment-suggestions", async (request, reply) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id });
    const body = parseOr400(SuggestSchema, request.body ?? {}, "Petición de sugerencia");
    const suggestion = await suggestForReservation({ context: request.userContext, reservationId: id, sessionId: body.sessionId ?? null });
    reply.code(201);
    return suggestion;
  });

  app.get("/reservations/:id/assignment-suggestions", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id });
    const history = await listSuggestionsForReservation({ context: request.userContext, reservationId: id });
    return { current: history.find((suggestion) => suggestion.status === "suggested") ?? null, history };
  });

  app.post("/assignment-suggestions/:id/confirm", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "assignmentSuggestion", id });
    const body = parseOr400(ConfirmSuggestionSchema, request.body ?? {}, "Confirmación de la sugerencia");
    return confirmSuggestion({ context: request.userContext, suggestionId: id, roomId: body.roomId ?? null, correlationId: createId("corr") });
  });

  // ── Lote manual de la tarde anterior (mismo motor que el job) ──────────────
  app.post("/properties/:propertyId/check-in/assignments/run", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(BatchRunSchema, request.body ?? {}, "Lote de asignación");
    return runBatchForDate({ context: request.userContext, propertyId, date: body.date ?? null });
  });

  // ── Bloqueos de habitación ─────────────────────────────────────────────────
  app.get("/properties/:propertyId/room-blocks", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(RoomBlocksQuerySchema, request.query ?? {}, "Consulta de bloqueos");
    return { items: await listRoomBlocks({ context: request.userContext, propertyId, ...query }) };
  });

  app.post("/properties/:propertyId/room-blocks", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(RoomBlockCreateSchema, request.body ?? {}, "Bloqueo de habitación");
    const block = await createRoomBlock({ context: request.userContext, propertyId, ...body, correlationId: createId("corr") });
    reply.code(201);
    return block;
  });

  app.delete("/room-blocks/:id", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "roomBlock", id });
    return deleteRoomBlock({ context: request.userContext, blockId: id, correlationId: createId("corr") });
  });

  // ── Habitaciones comunicadas ───────────────────────────────────────────────
  app.get("/properties/:propertyId/room-connections", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(RoomConnectionsQuerySchema, request.query ?? {}, "Consulta de comunicadas");
    return { items: await listRoomConnections({ context: request.userContext, propertyId, ...query }) };
  });

  app.post("/properties/:propertyId/room-connections", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(RoomConnectionCreateSchema, request.body ?? {}, "Habitaciones comunicadas");
    const connection = await createRoomConnection({ context: request.userContext, propertyId, ...body, correlationId: createId("corr") });
    reply.code(201);
    return connection;
  });

  app.delete("/room-connections/:id", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "roomConnection", id });
    return deleteRoomConnection({ context: request.userContext, connectionId: id, correlationId: createId("corr") });
  });
}
