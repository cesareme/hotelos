// Documentos · superficie HTTP del lote T9-05a (Tanda T9, diseño §9 rutas 1-4,
// send-to-office / recapture y cola de la oficina).
//
// Registrado desde server.ts (integrador T9-05b) con
//   registerDocumentsRoutes(app, { uploadBodyLimit, onCaptured })
// tras registerPayrollCostRoutes(app). Permisos: route-permissions.partial.ts
// (documentsRoutePermissions, una fila por ruta; el contract test
// api-route-permissions-contract exige igualdad ruta ↔ fila).
//
// Tenencia: las rutas /properties/:propertyId/* las valida el hook global de
// server.ts (404 opaco fuera del ámbito) y el servicio recomprueba que la fila
// cuelga de ese centro; /organizations/:organizationId/documents/queue pasa por
// assertEntityAccess (lib/tenancy.ts) y el ámbito R11 lo aplica el servicio.
//
// Sesión real (RV-02): las rutas `authenticated` del manifiesto (bandeja,
// detalle, descarga, imagen de página; y en pipeline.routes / workflow.routes
// classify, extract, split, merge y hoja de remesa) llevan requireRealSession:
// el gate de server.ts solo rechaza el fallback demo sin token (isAuthenticated
// = false, super-usuario demo con isPlatformAdmin) en high / critical, y
// requireAnyPermission exime al platform admin, así que sin esta guarda el
// fallback servía el documento de CUALQUIER organización. 401 sin sesión.
//
// Subidas: JSON base64 con `bodyLimit` por ruta (opción nativa de Fastify,
// DOCUMENT_UPLOAD_BODY_LIMIT) y 30 subidas por minuto (patrón
// accounting/ledger-import.routes.ts). Descargas binarias con
// content-disposition attachment|inline (?inline=1), x-content-type-options
// nosniff y cache-control private, no-store (patrón financial-statements.routes.ts).
//
// Tras responder a una captura o recaptura, `onCaptured(documentId,
// correlationId)` (pipeline de clasificación/extracción, T9-06) se lanza con
// setImmediate; si falla, se registra y el documento queda extractionStatus
// failed (nunca tumba la petición ya respondida).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { UnauthorizedError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { pageBody, pageHeaders } from "../../lib/pagination.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { DocumentFileQuerySchema, DocumentPageNoSchema } from "../../schemas/documents.schemas.js";
import { getDocumentsConfig, getDocumentStorage } from "./documents.config.js";
import { createDocumentsService, type DocumentBytes, type DocumentsService } from "./documents.service.js";
import type { DocumentStorage } from "./storage/storage.js";

export type DocumentsRouteOptions = {
  /** bodyLimit de Fastify en las rutas de subida (DOCUMENT_UPLOAD_BODY_LIMIT). */
  uploadBodyLimit: number;
  /** Pipeline en segundo plano (T9-06); se llama tras responder 201/200. El resultado se ignora (Promise<void> del contrato o el DocumentPipelineResult de server.ts). */
  onCaptured?: (documentId: string, correlationId: string) => Promise<unknown>;
  /** Tests: almacén explícito (por defecto getDocumentStorage() del contrato de entorno). */
  storage?: DocumentStorage;
  /** Tests: tope por fichero (por defecto DOCUMENT_MAX_BYTES del contrato de entorno). */
  maxBytes?: number;
  /** Tests: servicio ya construido (prevalece sobre storage / maxBytes). */
  service?: DocumentsService;
};

type PropertyParams = { propertyId: string };
type DocumentParams = PropertyParams & { id: string };
type PageParams = DocumentParams & { n: string };
type OrganizationParams = { organizationId: string };

/** Nombre seguro para content-disposition: ASCII sin comillas ni CR/LF en `filename`, UTF-8 en `filename*`. */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const safe = fileName.replace(/[\r\n"\\]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function sendBinary(reply: FastifyReply, file: DocumentBytes, inline: boolean): FastifyReply {
  reply.header("content-type", file.mimeType);
  reply.header("content-length", String(file.bytes.length));
  reply.header("content-disposition", contentDisposition(inline ? "inline" : "attachment", file.fileName));
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", "private, no-store");
  return reply.send(file.bytes);
}

function actorOf(request: FastifyRequest): { context: FastifyRequest["userContext"]; correlationId: string; ipAddress: string } {
  return { context: request.userContext, correlationId: createId("corr"), ipAddress: request.ip };
}

/**
 * Rutas `authenticated` del módulo: sesión real obligatoria (RV-02). El fallback
 * demo sin token (HOTELOS_ALLOW_DEMO_AUTH) llega con isAuthenticated = false y el
 * super-usuario demo (isPlatformAdmin), al que requireAnyPermission exime: sin
 * esta guarda leería y ejecutaría el pipeline sobre documentos de cualquier
 * organización. 401 «Authentication required.» (mismo texto que el gate H1).
 */
export function requireRealSession(request: Pick<FastifyRequest, "isAuthenticated">): void {
  if (!request.isAuthenticated) throw new UnauthorizedError("Authentication required.");
}

function inlineWanted(query: unknown): boolean {
  return parseOr400(DocumentFileQuerySchema, query ?? {}, "Filtro").inline === true;
}

export function registerDocumentsRoutes(app: FastifyInstance, opts: DocumentsRouteOptions): void {
  const service: DocumentsService =
    opts.service ??
    createDocumentsService({
      storage: () => opts.storage ?? getDocumentStorage(),
      maxBytes: () => opts.maxBytes ?? getDocumentsConfig().maxBytes
    });

  /** Cuerpos de hasta uploadBodyLimit y 30 subidas por minuto en las tres rutas que reciben ficheros. */
  const UPLOAD_OPTIONS = { bodyLimit: opts.uploadBodyLimit, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  function scheduleCaptured(documentIds: string[], correlationId: string): void {
    const onCaptured = opts.onCaptured;
    if (!onCaptured) return;
    for (const documentId of documentIds) {
      setImmediate(() => {
        onCaptured(documentId, correlationId).catch(async (error: unknown) => {
          app.log.error({ err: error, documentId, correlationId }, "documents: el pipeline de captura falló");
          await service.markExtractionFailed(documentId).catch((markError: unknown) => {
            app.log.error({ err: markError, documentId, correlationId }, "documents: no se pudo marcar extractionStatus=failed");
          });
        });
      });
    }
  }

  // ── Captura (centro) ──────────────────────────────────────────────────────
  app.post("/properties/:propertyId/documents", UPLOAD_OPTIONS, async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const actor = actorOf(request);
    const records = await service.captureIncomingDocuments({ ...actor, propertyId, body: request.body });
    scheduleCaptured(
      records.map((record) => record.id),
      actor.correlationId
    );
    return reply.code(201).send(records);
  });

  app.post("/properties/:propertyId/documents/:id/files", UPLOAD_OPTIONS, async (request, reply) => {
    const { propertyId, id } = request.params as DocumentParams;
    const file = await service.addDocumentFile({ ...actorOf(request), propertyId, documentId: id, body: request.body });
    return reply.code(201).send(file);
  });

  // ── Bandeja y detalle (authenticated en el manifiesto: sesión real + capture | review en el servicio) ──
  app.get("/properties/:propertyId/documents", async (request, reply) => {
    requireRealSession(request);
    const { propertyId } = request.params as PropertyParams;
    const { page, pageQuery } = await service.listIncomingDocuments({ context: request.userContext, propertyId, query: (request.query ?? {}) as Record<string, unknown> });
    reply.headers(pageHeaders(page));
    return pageBody(page, pageQuery);
  });

  app.get("/properties/:propertyId/documents/:id", async (request) => {
    requireRealSession(request);
    const { propertyId, id } = request.params as DocumentParams;
    return service.getIncomingDocument({ context: request.userContext, propertyId, documentId: id });
  });

  // ── Descargas binarias (auditadas) ───────────────────────────────────────
  app.get("/properties/:propertyId/documents/:id/file", async (request, reply) => {
    requireRealSession(request);
    const { propertyId, id } = request.params as DocumentParams;
    const inline = inlineWanted(request.query);
    const file = await service.getDocumentFileBytes({ ...actorOf(request), propertyId, documentId: id });
    return sendBinary(reply, file, inline);
  });

  app.get("/properties/:propertyId/documents/:id/pages/:n/image", async (request, reply) => {
    requireRealSession(request);
    const { propertyId, id, n } = request.params as PageParams;
    const pageNo = parseOr400(DocumentPageNoSchema, n, "Página");
    const inline = inlineWanted(request.query);
    const file = await service.getDocumentPageImageBytes({ ...actorOf(request), propertyId, documentId: id, pageNo });
    return sendBinary(reply, file, inline);
  });

  // ── Transiciones del centro ──────────────────────────────────────────────
  app.post("/properties/:propertyId/documents/:id/send-to-office", async (request) => {
    const { propertyId, id } = request.params as DocumentParams;
    return service.sendToOffice({ ...actorOf(request), propertyId, documentId: id });
  });

  app.post("/properties/:propertyId/documents/:id/recapture", UPLOAD_OPTIONS, async (request) => {
    const { propertyId, id } = request.params as DocumentParams;
    const actor = actorOf(request);
    const record = await service.recaptureDocument({ ...actor, propertyId, documentId: id, body: request.body });
    scheduleCaptured([record.id], actor.correlationId);
    return record;
  });

  // ── Cola de la oficina (organización, ámbito R11) ────────────────────────
  app.get("/organizations/:organizationId/documents/queue", async (request, reply) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    const { page, pageQuery } = await service.listOfficeQueue({ context: request.userContext, organizationId, query: (request.query ?? {}) as Record<string, unknown> });
    reply.headers(pageHeaders(page));
    return pageBody(page, pageQuery);
  });
}
