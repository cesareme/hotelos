// Assistant bounded context — segundo plugin Fastify (P1-16).
// Sigue el patrón establecido en webhooks.routes.ts.

import type { FastifyPluginAsync } from "fastify";
import { answerQuestion, getAvailableTools } from "../modules/assistant/assistant.service.js";

export const assistantRoutes: FastifyPluginAsync = async (app) => {
  app.get("/assistant/tools", async () => ({ items: getAvailableTools() }));

  app.post("/assistant/chat", async (request) => {
    const body = (request.body ?? {}) as { question?: string };
    if (!body.question || body.question.trim().length === 0) {
      return {
        question: "",
        answer: "Empieza con una pregunta — por ejemplo: «¿cuántas llegadas tengo hoy?» o «¿cuál es la ocupación?».",
        toolCalls: [],
        mode: "deterministic" as const,
        generatedAt: new Date().toISOString(),
        correlationId: "corr_idle"
      };
    }
    return answerQuestion({ context: request.userContext, question: body.question });
  });
};
