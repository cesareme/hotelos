// Activo inmobiliario · rutas de documentación con fichero (Tanda ACT · L3,
// diseño §5): listado con vigencia derivada, subida, versión nueva, metadatos,
// retirada y descarga auditada bajo /properties/:propertyId/real-estate/documents*.
//
// Registradas desde real-estate.register.ts (`registerRealEstateRoutes`, que a
// su vez llama server.ts); permisos en documents-route-permissions.partial.ts
// (real_estate.read para leer y descargar, real_estate.documents.manage para
// subir / versionar / editar metadatos, real_estate.manage para retirar y, en
// el servicio, para `legalHold`). El servicio aplica además la visibilidad por
// documento (`isDocumentVisibleTo`: wip solo para quien lo subió o
// real_estate.manage; solo_propiedad solo para real_estate.manage o plantilla
// owner) en el listado y con 404 opaco por id. La guardia global de tenencia de server.ts
// (pickPropertyId → grantPropertyAccess) cubre el :propertyId; el servicio busca
// cada fila por (id, propertyId) y responde 404 opaco.
//
// Subidas (patrón documents.routes.ts de T9): JSON base64 con `bodyLimit` por
// ruta (DOCUMENT_UPLOAD_BODY_LIMIT, opción nativa de Fastify) y 30 subidas por
// minuto. Descarga binaria con content-type / content-length / content-disposition
// attachment|inline (?inline=1) / x-content-type-options nosniff / cache-control
// private, no-store y sesión real obligatoria (requireRealSession: el fallback
// demo sin token no descarga documentos de ninguna organización).

import type { FastifyInstance, FastifyReply } from "fastify";
import { createId } from "../../lib/ids.js";
import { DocumentFileQuerySchema } from "../../schemas/documents.schemas.js";
import { getDocumentsUploadBodyLimit } from "../documents/documents.config.js";
import { contentDisposition, requireRealSession } from "../documents/documents.routes.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  createRealEstateDocument,
  createRealEstateDocumentVersion,
  getRealEstateDocumentFile,
  listRealEstateDocuments,
  retireRealEstateDocument,
  updateRealEstateDocument,
  type RealEstateDocumentBytes
} from "./documents.service.js";

export type RealEstateDocumentsRouteOptions = {
  /** bodyLimit de Fastify en las rutas de subida (por defecto DOCUMENT_UPLOAD_BODY_LIMIT del contrato de T9). */
  uploadBodyLimit?: number;
};

type PropertyParams = { propertyId: string };
type DocumentParams = PropertyParams & { documentId: string };

function sendBinary(reply: FastifyReply, file: RealEstateDocumentBytes, inline: boolean): FastifyReply {
  reply.header("content-type", file.mimeType);
  reply.header("content-length", String(file.bytes.length));
  reply.header("content-disposition", contentDisposition(inline ? "inline" : "attachment", file.fileName));
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", "private, no-store");
  return reply.send(file.bytes);
}

function inlineWanted(query: unknown): boolean {
  return parseOr400(DocumentFileQuerySchema, query ?? {}, "Filtro").inline === true;
}

export function registerRealEstateDocumentRoutes(app: FastifyInstance, opts: RealEstateDocumentsRouteOptions = {}): void {
  /** Cuerpos de hasta uploadBodyLimit y 30 subidas por minuto en las dos rutas que reciben ficheros. */
  const UPLOAD_OPTIONS = { bodyLimit: opts.uploadBodyLimit ?? getDocumentsUploadBodyLimit(), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  // ── Listado con vigencia derivada ─────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/documents", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listRealEstateDocuments(propertyId, request.query, request.userContext);
  });

  // ── Subida (metadatos + file opcional) ────────────────────────────────────
  app.post("/properties/:propertyId/real-estate/documents", UPLOAD_OPTIONS, async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const record = await createRealEstateDocument({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(record);
  });

  // ── Versión nueva (la anterior queda «sustituido») ─────────────────────────
  app.post("/properties/:propertyId/real-estate/documents/:documentId/versions", UPLOAD_OPTIONS, async (request, reply) => {
    const params = request.params as DocumentParams;
    const record = await createRealEstateDocumentVersion({ context: request.userContext, propertyId: params.propertyId, documentId: params.documentId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(record);
  });

  // ── Metadatos (fechas, título, enlace; legalHold solo con real_estate.manage) ──
  app.patch("/properties/:propertyId/real-estate/documents/:documentId", async (request) => {
    const params = request.params as DocumentParams;
    return updateRealEstateDocument({ context: request.userContext, propertyId: params.propertyId, documentId: params.documentId, body: request.body, correlationId: createId("corr") });
  });

  // ── Retirar (borrado lógico; 409 LEGAL_HOLD) ──────────────────────────────
  app.delete("/properties/:propertyId/real-estate/documents/:documentId", async (request) => {
    const params = request.params as DocumentParams;
    return retireRealEstateDocument({ context: request.userContext, propertyId: params.propertyId, documentId: params.documentId, correlationId: createId("corr") });
  });

  // ── Descarga binaria auditada ─────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/documents/:documentId/file", async (request, reply) => {
    requireRealSession(request);
    const params = request.params as DocumentParams;
    const inline = inlineWanted(request.query);
    const file = await getRealEstateDocumentFile({ context: request.userContext, propertyId: params.propertyId, documentId: params.documentId, correlationId: createId("corr"), ipAddress: request.ip });
    return sendBinary(reply, file, inline);
  });
}
