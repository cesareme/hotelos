// Estado honesto de las integraciones (Tanda L8 · L8-05) · superficie HTTP.
//
// `GET /integrations/status?propertyId=` (defecto: la propiedad activa del
// contexto) → IntegrationsStatusResponse { generatedAt, propertyId,
// integrations: IntegrationStatusDto[18], degraded: string[] } de
// collectIntegrationsStatus (integrations-status.service.ts; contrato en
// packages/shared/src/integrations-status-types.ts). Registrada desde server.ts
// con `registerIntegrationsStatusRoutes(app, deps)` junto a registerPmsShadowRoutes;
// permisos en route-permissions.partial.ts de este módulo (`integrations.read`,
// riskLevel low; el contrato api-route-permissions lee ambos ficheros).
//
// Tenencia: la propiedad llega por query, no por el path, así que el preHandler
// global no la resuelve. grantPropertyAccess (lib/tenancy.ts) exige que sea de
// la organización del contexto Y esté cubierta por una asignación viva — 404
// opaco «Propiedad no encontrada.» para desconocida, ajena o no asignada;
// platform admin re-apuntado a la organización de la propiedad — el mismo
// cierre que pms-shadow.routes.ts obtiene con assertPropertyInOrg más el guard
// global de `:propertyId`. Un `propertyId` presente pero vacío o no textual es
// 400 (nunca se cae en silencio a la propiedad del contexto); NO se recorta: un
// id con espacios es otro id y recibe el 404 opaco del guard de ámbito /
// grantPropertyAccess (corrector L8 · REV-07: el guard global lo ve antes que
// esta ruta, así que un trim aquí nunca surtía efecto).
//
// Sentry y Redis no tienen lector propio (recon «Restricciones»): server.ts los
// deriva con la misma regla que checks.sentry / checks.redis de /health y los
// pasa en `deps.platform()`; redisConsumerCount es 0 mientras ningún componente
// del API abra un cliente Redis (el servicio lo declara `none`).

import type { FastifyInstance } from "fastify";
import type { IntegrationsStatusResponse } from "@hotelos/shared";
import { BadRequestError } from "../../lib/http-error.js";
import { grantPropertyAccess } from "../../lib/tenancy.js";
import { collectIntegrationsStatus } from "./integrations-status.service.js";

export type IntegrationsStatusRouteDeps = {
  /** Sentry / Redis «con valor» (nunca «alcanzable» ni «en uso»), derivados en server.ts. */
  platform: () => { sentryConfigured: boolean; redisConfigured: boolean };
};

/** Propiedad pedida por query (string no vacío, tal cual, sin recortar) o la activa del contexto; 400 si viene mal formada. */
export function resolveRequestedPropertyId(query: unknown, contextPropertyId: string): string {
  const requested = (query as { propertyId?: unknown } | null | undefined)?.propertyId;
  if (requested === undefined) {
    if (!contextPropertyId) throw new BadRequestError("propertyId es obligatorio.");
    return contextPropertyId;
  }
  if (typeof requested !== "string" || requested.length === 0) {
    throw new BadRequestError("propertyId debe ser un identificador de propiedad no vacío.");
  }
  return requested;
}

export function registerIntegrationsStatusRoutes(app: FastifyInstance, deps: IntegrationsStatusRouteDeps): void {
  app.get("/integrations/status", async (request): Promise<IntegrationsStatusResponse> => {
    const propertyId = resolveRequestedPropertyId(request.query, request.userContext.propertyId);
    const organizationId = await grantPropertyAccess(request, propertyId);
    const { sentryConfigured, redisConfigured } = deps.platform();
    return collectIntegrationsStatus({ organizationId, propertyId, sentryConfigured, redisConfigured, redisConsumerCount: 0 });
  });
}
