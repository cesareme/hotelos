// Documentos · rutas del flujo de la oficina, dividir / unir, tareas y valija
// (Tanda T9 · lote T9-08; diseño §9).
//
//   POST  /properties/:propertyId/documents/:id/assign      { assignedTo? }            documents.review (high)
//   POST  /properties/:propertyId/documents/:id/review      { reviewedFields, kind?, note? }  documents.review (high)
//   POST  /properties/:propertyId/documents/:id/approve     DocumentApproveRequest    documents.review + clave de la acción (high)
//   POST  /properties/:propertyId/documents/:id/reject      { reason, note?, returnToCentre?, duplicateOfId? }  documents.review (high)
//   POST  /properties/:propertyId/documents/:id/archive     { retentionUntil?, extendedRetention?, legalHold? } documents.review (high)
//   POST  /properties/:propertyId/documents/:id/split       { ranges }                capture | review (medium)
//   POST  /properties/:propertyId/documents/:id/merge       { withIds }               capture | review (medium)
//   POST  /properties/:propertyId/documents/:id/actions     DocumentActionRequest     documents.review (medium)
//   PATCH /properties/:propertyId/documents/:id/actions/:actionId { status, outcomeNote? } documents.review (medium)
//   POST  /properties/:propertyId/documents/dispatch-batches { documentIds }          documents.capture (medium)
//   POST  /properties/:propertyId/documents/dispatch-batches/:batchId/receive { receivedIds } documents.review (medium)
//   GET   /properties/:propertyId/documents/dispatch-batches/:batchId/sheet   PDF     capture | review (medium)
//
// Registro: `registerDocumentWorkflowRoutes(app)` desde server.ts justo después
// de registerDocumentPipelineRoutes(app). Permisos:
// workflow-route-permissions.partial.ts (una fila por ruta; las disyunciones
// «capture | review» van `authenticated` en el manifiesto: el handler exige
// sesión real con requireRealSession — 401 al fallback demo sin token, RV-02 —
// y el servicio aplica la disyunción con requireAnyPermission, patrón de las
// lecturas de T9-05a).
// Tenencia: el hook global resuelve :propertyId (404 opaco fuera del ámbito)
// y cada servicio recomprueba que la fila cuelga del centro.
//
// Tras dividir, cada trozo nuevo vuelve a la extracción: `onCaptured` (por
// defecto runDocumentPipeline con trigger capture) se lanza con setImmediate y
// nunca tumba la respuesta ya enviada (patrón documents.routes.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createId } from "../../lib/ids.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { DocumentFileQuerySchema } from "../../schemas/documents.schemas.js";
import { approveDocument, archiveDocument, assignDocument, createDocumentAction, patchDocumentAction, rejectDocument, reviewDocument } from "./actions.service.js";
import { closeDispatchBatch, getDispatchSheetBytes, receiveDispatchBatch } from "./dispatch.service.js";
import { contentDisposition, requireRealSession } from "./documents.routes.js";
import type { DocumentBytes } from "./documents.service.js";
import { markExtractionFailed } from "./documents.service.js";
import { runDocumentPipeline } from "./pipeline.service.js";
import { mergeDocuments, splitDocument } from "./split-merge.service.js";

export type DocumentWorkflowRouteOptions = {
  /** Pipeline en segundo plano para los trozos de un split (por defecto runDocumentPipeline, trigger capture). */
  onCaptured?: (documentId: string, correlationId: string) => Promise<unknown>;
};

type PropertyParams = { propertyId: string };
type DocumentParams = PropertyParams & { id: string };
type ActionParams = DocumentParams & { actionId: string };
type BatchParams = PropertyParams & { batchId: string };

function actorOf(request: FastifyRequest): { context: FastifyRequest["userContext"]; correlationId: string; ipAddress: string } {
  return { context: request.userContext, correlationId: createId("corr"), ipAddress: request.ip };
}

function sendBinary(reply: FastifyReply, file: DocumentBytes, inline: boolean): FastifyReply {
  reply.header("content-type", file.mimeType);
  reply.header("content-length", String(file.bytes.length));
  reply.header("content-disposition", contentDisposition(inline ? "inline" : "attachment", file.fileName));
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", "private, no-store");
  return reply.send(file.bytes);
}

export function registerDocumentWorkflowRoutes(app: FastifyInstance, options: DocumentWorkflowRouteOptions = {}): void {
  const onCaptured = options.onCaptured ?? ((documentId: string, correlationId: string) => runDocumentPipeline(documentId, { trigger: "capture", correlationId }));

  function scheduleCaptured(documentIds: string[], correlationId: string): void {
    for (const documentId of documentIds) {
      setImmediate(() => {
        onCaptured(documentId, correlationId).catch(async (error: unknown) => {
          app.log.error({ err: error, documentId, correlationId }, "documents: el pipeline tras dividir falló");
          await markExtractionFailed(documentId).catch((markError: unknown) => {
            app.log.error({ err: markError, documentId, correlationId }, "documents: no se pudo marcar extractionStatus=failed");
          });
        });
      });
    }
  }

  // ── Oficina: asignar, revisar, aprobar, rechazar, archivar ──────────────
  app.post("/properties/:propertyId/documents/:id/assign", async (request) => {
    const { propertyId, id } = request.params as DocumentParams;
    return assignDocument({ ...actorOf(request), propertyId, id, body: request.body });
  });

  app.post("/properties/:propertyId/documents/:id/review", async (request) => {
    const { propertyId, id } = request.params as DocumentParams;
    return reviewDocument({ ...actorOf(request), propertyId, id, body: request.body });
  });

  app.post("/properties/:propertyId/documents/:id/approve", async (request) => {
    const { propertyId, id } = request.params as DocumentParams;
    return approveDocument({ ...actorOf(request), propertyId, id, body: request.body });
  });

  app.post("/properties/:propertyId/documents/:id/reject", async (request) => {
    const { propertyId, id } = request.params as DocumentParams;
    return rejectDocument({ ...actorOf(request), propertyId, id, body: request.body });
  });

  app.post("/properties/:propertyId/documents/:id/archive", async (request) => {
    const { propertyId, id } = request.params as DocumentParams;
    return archiveDocument({ ...actorOf(request), propertyId, id, body: request.body });
  });

  // ── Dividir / unir (centro u oficina) ───────────────────────────────────
  app.post("/properties/:propertyId/documents/:id/split", async (request) => {
    requireRealSession(request);
    const { propertyId, id } = request.params as DocumentParams;
    const actor = actorOf(request);
    const result = await splitDocument({ ...actor, propertyId, id, body: request.body });
    scheduleCaptured(
      result.pieces.map((piece) => piece.id),
      actor.correlationId
    );
    return result;
  });

  app.post("/properties/:propertyId/documents/:id/merge", async (request) => {
    requireRealSession(request);
    const { propertyId, id } = request.params as DocumentParams;
    return mergeDocuments({ ...actorOf(request), propertyId, id, body: request.body });
  });

  // ── Tareas con plazo (§7.3) ─────────────────────────────────────────────
  app.post("/properties/:propertyId/documents/:id/actions", async (request, reply) => {
    const { propertyId, id } = request.params as DocumentParams;
    const action = await createDocumentAction({ ...actorOf(request), propertyId, id, body: request.body });
    return reply.code(201).send(action);
  });

  app.patch("/properties/:propertyId/documents/:id/actions/:actionId", async (request) => {
    const { propertyId, id, actionId } = request.params as ActionParams;
    return patchDocumentAction({ ...actorOf(request), propertyId, id, actionId, body: request.body });
  });

  // ── Valija (§6.4) ───────────────────────────────────────────────────────
  app.post("/properties/:propertyId/documents/dispatch-batches", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const batch = await closeDispatchBatch({ ...actorOf(request), propertyId, body: request.body });
    return reply.code(201).send(batch);
  });

  app.post("/properties/:propertyId/documents/dispatch-batches/:batchId/receive", async (request) => {
    const { propertyId, batchId } = request.params as BatchParams;
    return receiveDispatchBatch({ ...actorOf(request), propertyId, batchId, body: request.body });
  });

  app.get("/properties/:propertyId/documents/dispatch-batches/:batchId/sheet", async (request, reply) => {
    requireRealSession(request);
    const { propertyId, batchId } = request.params as BatchParams;
    const inline = parseOr400(DocumentFileQuerySchema, request.query ?? {}, "Filtro").inline === true;
    const file = await getDispatchSheetBytes({ ...actorOf(request), propertyId, batchId });
    return sendBinary(reply, file, inline);
  });
}
