// Activo inmobiliario · rutas de vista de grupo, calendario anual y exportación
// CSV (Tanda ACT · L6, diseño §5 «Calendario anual», §7 «Vista de grupo»).
//
// Registradas desde real-estate.register.ts (`registerRealEstateRoutes`, que
// llama server.ts); permisos en group-route-permissions.partial.ts (las 4 con
// real_estate.read, riesgo medium; sin clave `export`: decisión del plan).
//
// Ámbito: las rutas /organizations/:organizationId/* comprueban la organización
// con assertEntityAccess (patrón modules/fixed-assets/fixed-assets.routes.ts) y
// el servicio filtra los centros con propertyWithinScope / hasEntityReadScope
// (lib/finance-scope.ts): owner y quien tenga accounting.entity.read ven todos
// los centros de la sociedad; un director con una asignación ve solo su fila.
// La ruta por centro cuelga de /properties/:propertyId (guardia global de
// tenencia de server.ts) y responde 404 tipado ASSET_NOT_FOUND sin ficha.
// La exportación devuelve text/csv (BOM, `;`) con content-disposition
// attachment «activo-inmobiliario-<what>-<año>.csv».

import type { FastifyInstance } from "fastify";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { contentDisposition } from "../documents/documents.routes.js";
import { getRealEstateCalendar, getRealEstateGroupCalendar } from "./calendar.service.js";
import { exportRealEstateGroup } from "./export.service.js";
import { getRealEstateGroupOverview } from "./group.service.js";

type OrganizationParams = { organizationId: string };
type PropertyParams = { propertyId: string };

export function registerRealEstateGroupRoutes(app: FastifyInstance): void {
  // ── Vista de grupo ────────────────────────────────────────────────────────
  app.get("/organizations/:organizationId/real-estate/overview", async (request) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    return getRealEstateGroupOverview(request.userContext, organizationId);
  });

  // ── Calendario anual de grupo ─────────────────────────────────────────────
  app.get("/organizations/:organizationId/real-estate/calendar", async (request) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    return getRealEstateGroupCalendar(request.userContext, organizationId, request.query ?? {});
  });

  // ── Exportación CSV (vista de grupo o calendario) ─────────────────────────
  app.get("/organizations/:organizationId/real-estate/export", async (request, reply) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    const file = await exportRealEstateGroup(request.userContext, organizationId, request.query ?? {});
    reply.header("content-type", file.contentType);
    reply.header("content-disposition", contentDisposition("attachment", file.fileName));
    reply.header("cache-control", "no-store");
    return file.content;
  });

  // ── Calendario anual del centro ───────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/calendar", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return getRealEstateCalendar(propertyId, request.query ?? {});
  });
}
