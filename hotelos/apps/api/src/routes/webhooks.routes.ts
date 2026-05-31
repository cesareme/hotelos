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
import {
  listSubscriptions,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  listDeliveries,
  testSubscription,
  WEBHOOK_EVENT_TYPES
} from "../modules/webhooks/webhooks.service.js";

export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  app.get("/webhooks/event-types", async () => ({ items: [...WEBHOOK_EVENT_TYPES] }));

  app.get("/webhooks/subscriptions", async (request) => {
    const q = (request.query ?? {}) as { propertyId?: string };
    return { items: await listSubscriptions({ context: request.userContext, propertyId: q.propertyId }) };
  });

  app.post("/webhooks/subscriptions", async (request) => {
    return createSubscription({ context: request.userContext, payload: request.body as never });
  });

  app.patch("/webhooks/subscriptions/:id", async (request) => {
    return updateSubscription({
      context: request.userContext,
      id: (request.params as { id: string }).id,
      payload: request.body as never
    });
  });

  app.delete("/webhooks/subscriptions/:id", async (request) => {
    return deleteSubscription({
      context: request.userContext,
      id: (request.params as { id: string }).id
    });
  });

  app.get("/webhooks/subscriptions/:id/deliveries", async (request) => {
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
    return testSubscription({
      context: request.userContext,
      id: (request.params as { id: string }).id
    });
  });
};
