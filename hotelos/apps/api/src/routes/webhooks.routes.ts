// Webhooks bounded context — primer plugin Fastify (P1-9).
//
// Demuestra el patrón: en lugar de declarar 8 handlers en `server.ts`, el
// bounded context se autoencapsula como un plugin que `server.ts` registra
// con una sola línea: `app.register(webhooksRoutes)`.
//
// Beneficios:
//   - 1 fichero por contexto = code review por área en lugar de un único
//     monolito.
//   - Tests por plugin: instanciar Fastify + register + assert sin tocar el
//     resto del API.
//   - Cuando crezca el equipo, cada ingeniero puede ser dueño de su plugin
//     sin pisarse en merges.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assertEntityAccess } from "../lib/tenancy.js";
import { parseOr400 } from "../modules/rate-manager/rate-grid.schemas.js";
import {
  listSubscriptions,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  listDeliveries,
  testSubscription,
  WEBHOOK_EVENT_TYPES
} from "../modules/webhooks/webhooks.service.js";

/**
 * Corrector CIERRE-1 (REV-07 / FUN-04): body of POST /webhooks/subscriptions, zod `.strict()`
 * before the service — `propertyId: ""` (which slipped past `pickPropertyId` and the
 * organisation check and was persisted as ""), non-string fields and unknown keys are
 * 400 `VALIDATION_ERROR`; `null` keeps the FIX-1 meaning «organisation-wide row».
 */
const createSubscriptionBodySchema = z
  .object({
    targetUrl: z.string().url().max(2048),
    eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
    propertyId: z.string().min(1).max(200).nullable().optional(),
    developerAppId: z.string().min(1).max(200).optional()
  })
  .strict();

export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  app.get("/webhooks/event-types", async () => ({ items: [...WEBHOOK_EVENT_TYPES] }));

  app.get("/webhooks/subscriptions", async (request) => {
    const q = (request.query ?? {}) as { propertyId?: string };
    return { items: await listSubscriptions({ context: request.userContext, propertyId: q.propertyId }) };
  });

  app.post("/webhooks/subscriptions", async (request) => {
    const payload = parseOr400(createSubscriptionBodySchema, request.body ?? {}, "body");
    return createSubscription({ context: request.userContext, payload });
  });

  app.patch("/webhooks/subscriptions/:id", async (request) => {
    await assertEntityAccess(request, { entity: "webhookSubscription", id: (request.params as { id: string }).id });
    return updateSubscription({
      context: request.userContext,
      id: (request.params as { id: string }).id,
      payload: request.body as never
    });
  });

  app.delete("/webhooks/subscriptions/:id", async (request) => {
    await assertEntityAccess(request, { entity: "webhookSubscription", id: (request.params as { id: string }).id });
    return deleteSubscription({
      context: request.userContext,
      id: (request.params as { id: string }).id
    });
  });

  app.get("/webhooks/subscriptions/:id/deliveries", async (request) => {
    await assertEntityAccess(request, { entity: "webhookSubscription", id: (request.params as { id: string }).id });
    const limit = Number((request.query as { limit?: string })?.limit ?? 50);
    return {
      items: await listDeliveries({
        context: request.userContext,
        subscriptionId: (request.params as { id: string }).id,
        limit
      })
    };
  });

  app.post("/webhooks/subscriptions/:id/test", async (request) => {
    await assertEntityAccess(request, { entity: "webhookSubscription", id: (request.params as { id: string }).id });
    return testSubscription({
      context: request.userContext,
      id: (request.params as { id: string }).id
    });
  });
};
