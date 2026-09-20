// Documentos · Tanda T9 · lote T9-06a — rutas del pipeline de clasificación y
// extracción (apps/api/src/modules/documents/pipeline.routes.ts; diseño §9).
//
//   POST /properties/:propertyId/documents/:id/classify { force? }
//   POST /properties/:propertyId/documents/:id/extract  { force? }
//     → 200 { configured, extraction, classification, checks, proposal, autonomy }
//
// Registro: `registerDocumentPipelineRoutes(app)` desde server.ts tras
// registerDocumentsRoutes(app, …) (integrador T9-05b). Permisos:
// pipeline-route-permissions.partial.ts (`authenticated` en el manifiesto: el
// handler exige sesión real con requireRealSession — 401 al fallback demo sin
// token, RV-02 — y la disyunción documents.capture | documents.review con
// requireAnyPermission, patrón de las lecturas de T9-05a).
//
// Reglas:
//   · tenencia: el hook global resuelve :propertyId (404 opaco fuera del
//     ámbito); aquí se recomprueba que el documento pertenece a ese centro y a
//     la organización de la sesión → 404 DOCUMENT_NOT_FOUND;
//   · cuerpo con esquema zod `.strict()` (parseOr400 → 400 VALIDATION_ERROR);
//   · sin proveedor: 200 con configured:false y extraction.source text_rules |
//     e_invoice (o null tras un classify sin extracción previa); con `force`
//     y sin proveedor (o proveedor que falla): 503 AI_PROVIDER_UNAVAILABLE
//     (lo lanza el pipeline);
//   · classify solo reclasifica (no crea DocumentExtraction); extract ejecuta
//     el pipeline completo (runNo incremental, cola de la oficina una vez).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "@hotelos/database";
import type { PermissionKey } from "@hotelos/shared";
import { HttpError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { requireRealSession } from "./documents.routes.js";
import { requireAnyPermission } from "./documents.service.js";
import { AI_PROVIDER_UNAVAILABLE, runDocumentPipeline, type DocumentPipelineResult, type PipelineStage } from "./pipeline.service.js";

export const DocumentExtractRequestSchema = z.object({ force: z.boolean().optional() }).strict();
export type DocumentExtractRequestInput = z.output<typeof DocumentExtractRequestSchema>;

export const PIPELINE_ROUTE_PERMISSIONS: readonly PermissionKey[] = Object.freeze(["documents.capture", "documents.review"]);

export type DocumentPipelineRouteOptions = {
  /** Tests: ejecución del pipeline (por defecto runDocumentPipeline). */
  run?: typeof runDocumentPipeline;
  /** Tests: cliente Prisma. */
  db?: Pick<typeof prisma, "incomingDocument">;
};

type DocumentParams = { propertyId: string; id: string };

export type DocumentPipelineResponse = Pick<DocumentPipelineResult, "configured" | "extraction" | "classification" | "checks" | "proposal" | "autonomy">;

function toResponse(result: DocumentPipelineResult): DocumentPipelineResponse {
  return { configured: result.configured, extraction: result.extraction, classification: result.classification, checks: result.checks, proposal: result.proposal, autonomy: result.autonomy };
}

export function registerDocumentPipelineRoutes(app: FastifyInstance, options: DocumentPipelineRouteOptions = {}): void {
  const run = options.run ?? runDocumentPipeline;
  const db = options.db ?? prisma;

  async function handle(request: FastifyRequest, stage: PipelineStage): Promise<DocumentPipelineResponse> {
    requireRealSession(request);
    const { propertyId, id } = request.params as DocumentParams;
    const context = request.userContext;
    requireAnyPermission(context, PIPELINE_ROUTE_PERMISSIONS);
    const body = parseOr400(DocumentExtractRequestSchema, request.body ?? {}, "Cuerpo");
    const row = await db.incomingDocument.findFirst({ where: { id, propertyId, organizationId: context.organizationId }, select: { id: true } });
    if (!row) throw new HttpError(404, "Documento no encontrado.", true, { code: "DOCUMENT_NOT_FOUND" });
    const result = await run(row.id, { trigger: "manual", stage, correlationId: createId("corr"), userId: context.userId, ...(body.force !== undefined ? { force: body.force } : {}) });
    return toResponse(result);
  }

  /**
   * El manejador global de errores (server.ts) nunca reenvía `details` en un 5xx; el 503
   * AI_PROVIDER_UNAVAILABLE del contrato (documents-types.ts DOCUMENT_ERROR_CODES) sí lleva su
   * código, así que se responde aquí con el mismo cuerpo { statusCode, error, message, details }.
   */
  async function respond(request: FastifyRequest, reply: FastifyReply, stage: PipelineStage): Promise<DocumentPipelineResponse | FastifyReply> {
    try {
      return await handle(request, stage);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 503 && (error.details as { code?: string } | undefined)?.code === AI_PROVIDER_UNAVAILABLE) {
        request.log.warn({ err: error, correlationId: (error.details as { correlationId?: string }).correlationId }, "[documents.pipeline] proveedor de IA no disponible con force");
        return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", message: error.message, details: error.details });
      }
      throw error;
    }
  }

  app.post("/properties/:propertyId/documents/:id/classify", async (request, reply) => respond(request, reply, "classify"));
  app.post("/properties/:propertyId/documents/:id/extract", async (request, reply) => respond(request, reply, "full"));
}
