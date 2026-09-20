// Documentos · rutas de organización: archivo, KPIs, ajustes y retención
// (Tanda T9 · lote T9-13; diseño §7.4, §7.5, §9).
//
//   GET   /organizations/:organizationId/documents/archive        filtros + cursor   documents.archive.read + R11 (medium)
//   GET   /organizations/:organizationId/documents/kpis           { from, to, propertyId? }  documents.review + R11 (medium)
//   GET   /organizations/:organizationId/documents/settings       —                  documents.admin (high)
//   PATCH /organizations/:organizationId/documents/settings       DocumentSettingsPatchRequest  documents.admin (high)
//   POST  /organizations/:organizationId/documents/:id/block      { reason, legalHold? }  documents.admin (critical)
//   POST  /organizations/:organizationId/documents/:id/unblock    { reason, legalHold? }  documents.admin (critical)
//   POST  /organizations/:organizationId/documents/:id/purge      { reason }         documents.admin (critical; 409 DOCUMENT_LEGAL_HOLD)
//
// Registro: `registerDocumentArchiveRoutes(app)` desde server.ts tras
// registerDocumentWorkflowRoutes(app). Permisos: archive-route-permissions.partial.ts
// (una fila por ruta). Tenencia: :organizationId pasa por assertEntityAccess
// (lib/tenancy.ts, 404 opaco fuera del ámbito) y el ámbito R11 lo aplica cada
// servicio; :id se recomprueba contra la organización en retention.service.ts.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { createId } from "../../lib/ids.js";
import { pageBody, pageHeaders } from "../../lib/pagination.js";
import { searchDocumentArchive } from "./archive.service.js";
import { getDocumentKpis } from "./kpis.service.js";
import { blockDocument, purgeDocument, unblockDocument } from "./retention.service.js";
import { getDocumentSettings, patchDocumentSettings } from "./settings.service.js";

type OrganizationParams = { organizationId: string };
type DocumentParams = OrganizationParams & { id: string };

function actorOf(request: FastifyRequest): { context: FastifyRequest["userContext"]; correlationId: string; ipAddress: string } {
  return { context: request.userContext, correlationId: createId("corr"), ipAddress: request.ip };
}

async function organizationOf(request: FastifyRequest): Promise<string> {
  const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
  return organizationId;
}

export function registerDocumentArchiveRoutes(app: FastifyInstance): void {
  // ── Archivo y búsqueda (§7.4) ───────────────────────────────────────────
  app.get("/organizations/:organizationId/documents/archive", async (request, reply) => {
    const organizationId = await organizationOf(request);
    const { page, pageQuery } = await searchDocumentArchive({ ...actorOf(request), organizationId, query: (request.query ?? {}) as Record<string, unknown> });
    reply.headers(pageHeaders(page));
    return pageBody(page, pageQuery);
  });

  // ── KPIs de la oficina (§9) ─────────────────────────────────────────────
  app.get("/organizations/:organizationId/documents/kpis", async (request) => {
    const organizationId = await organizationOf(request);
    const actor = actorOf(request);
    return getDocumentKpis({ context: actor.context, correlationId: actor.correlationId, organizationId, query: (request.query ?? {}) as Record<string, unknown> });
  });

  // ── Ajustes por organización (§6.3, §7.2, §3.2, §3.4) ────────────────────
  app.get("/organizations/:organizationId/documents/settings", async (request) => {
    const organizationId = await organizationOf(request);
    return getDocumentSettings({ ...actorOf(request), organizationId });
  });

  app.patch("/organizations/:organizationId/documents/settings", async (request) => {
    const organizationId = await organizationOf(request);
    return patchDocumentSettings({ ...actorOf(request), organizationId, body: request.body });
  });

  // ── Retención: bloqueo, desbloqueo y purga (§7.5) ───────────────────────
  app.post("/organizations/:organizationId/documents/:id/block", async (request) => {
    const organizationId = await organizationOf(request);
    const { id } = request.params as DocumentParams;
    return blockDocument({ ...actorOf(request), organizationId, id, body: request.body });
  });

  app.post("/organizations/:organizationId/documents/:id/unblock", async (request) => {
    const organizationId = await organizationOf(request);
    const { id } = request.params as DocumentParams;
    return unblockDocument({ ...actorOf(request), organizationId, id, body: request.body });
  });

  app.post("/organizations/:organizationId/documents/:id/purge", async (request) => {
    const organizationId = await organizationOf(request);
    const { id } = request.params as DocumentParams;
    return purgeDocument({ ...actorOf(request), organizationId, id, body: request.body });
  });
}
