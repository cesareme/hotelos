import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { CheckInFromScanRequest, CheckInFromScanResponse } from "@hotelos/shared";
import { buildHealthResponse, OBSERVABILITY_HEADERS, SERVICE_NAMES } from "@hotelos/config";
import { createApiClient } from "./api-client.js";
import { GUEST_AI_DISCLOSURE, parseCommandToIntent } from "./intent-parser.js";
import { AI_ONBOARDING_AGENTS } from "./onboarding-agents.js";
import { registerOnboardingEngineRoutes } from "./onboarding-engine.js";

export function buildAiGatewayServer() {
  const app = Fastify({ logger: true });
  const api = createApiClient({
    baseUrl: process.env.API_BASE_URL ?? "http://localhost:3000"
  });

  app.addHook("onRequest", async (request, reply) => {
    const incomingCorrelationId = request.headers[OBSERVABILITY_HEADERS.correlationId];
    const correlationId =
      typeof incomingCorrelationId === "string"
        ? incomingCorrelationId
        : Array.isArray(incomingCorrelationId)
          ? incomingCorrelationId[0]
          : `corr_${randomUUID()}`;
    request.headers[OBSERVABILITY_HEADERS.correlationId] = correlationId;
    reply.header(OBSERVABILITY_HEADERS.correlationId, correlationId);
    reply.header(OBSERVABILITY_HEADERS.serviceName, SERVICE_NAMES.aiGateway);
  });

  app.get("/health", async () => {
    const aiKey = (process.env.AI_PROVIDER_API_KEY ?? "").trim();
    const aiProvider = (process.env.AI_PROVIDER ?? "none").trim().toLowerCase();
    const llmConfigured =
      (aiProvider === "anthropic" || aiProvider === "openai") && aiKey.length > 0 && aiKey !== "change-me";
    const ocrKey = (process.env.OCR_PROVIDER_API_KEY ?? "").trim();
    const speechKey = (process.env.SPEECH_PROVIDER_API_KEY ?? "").trim();
    return {
      ...buildHealthResponse({
        service: SERVICE_NAMES.aiGateway,
        dependencies: {
          api: "ok",
          llmProvider: llmConfigured ? aiProvider : "unconfigured",
          speechProvider: speechKey && speechKey !== "change-me" ? "configured" : "unconfigured",
          ocrProvider: ocrKey && ocrKey !== "change-me" ? "configured" : "unconfigured"
        }
      }),
      directDatabaseAccess: false
    };
  });

  app.post("/ai/intents/parse", async (request) => {
    const body = request.body as { transcript: string; propertyId: string; userId: string };
    return parseCommandToIntent(body);
  });

  app.post("/ai/commands/text", async (request) => {
    const body = request.body as {
      transcript: string;
      propertyId: string;
      userId: string;
      businessDate?: string;
      arrivalDate?: string;
      departureDate?: string;
      adults?: number;
      children?: number;
    };
    const intent = parseCommandToIntent(body);

    if (intent.intent === "ASK_DASHBOARD_QUESTION" && /arrival/i.test(body.transcript)) {
      const reservations = await api.get<Array<{ code: string; status: string; arrivalDate: string }>>(
        `/properties/${body.propertyId}/reservations`
      );
      const businessDate = body.businessDate ?? "2026-05-14";
      const arrivals = reservations.filter(
        (reservation) => reservation.arrivalDate === businessDate && ["confirmed", "checked_in"].includes(reservation.status)
      );

      return {
        status: "completed",
        intent,
        summary: `${arrivals.length} arrivals for ${businessDate}.`,
        data: arrivals
      };
    }

    if (intent.intent === "CREATE_MAINTENANCE_WORK_ORDER") {
      const roomNumber = intent.extractedEntities.roomNumber;
      const priority = /urgent|leak|not working/i.test(body.transcript) ? "urgent" : "normal";
      const title = body.transcript.replace(/^create\s+/i, "").slice(0, 80);
      const workOrder = await api.post("/work-orders", {
        roomNumber,
        title: title || "Maintenance task",
        priority,
        blocksRoom: false
      });

      return {
        status: "completed",
        intent,
        summary: `Created ${priority} maintenance task${roomNumber ? ` for room ${roomNumber}` : ""}.`,
        data: workOrder
      };
    }

    if (intent.intent === "QUOTE_AVAILABILITY") {
      if (!body.arrivalDate || !body.departureDate) {
        return {
          status: "needs_more_information",
          intent,
          summary: "Please provide arrival and departure dates before I quote availability."
        };
      }

      const options = await api.post(`/properties/${body.propertyId}/availability/quote`, {
        arrivalDate: body.arrivalDate,
        departureDate: body.departureDate,
        adults: body.adults ?? 1,
        children: body.children ?? 0
      });

      return {
        status: "completed",
        intent,
        summary: "Availability and prices come from the PMS availability tool.",
        data: options
      };
    }

    if (intent.intent === "ASSIGN_ROOM") {
      return {
        status: "confirmation_required",
        intent,
        card: {
          title: "Confirm room assignment",
          message: "AI can validate the assignment, but a staff member must confirm before the backend assigns the room.",
          requiredTools: intent.requiredTools
        }
      };
    }

    return {
      status: intent.requiresConfirmation ? "confirmation_required" : "parsed",
      intent
    };
  });

  app.get("/guest-ai/disclosure", async () => ({
    message: GUEST_AI_DISCLOSURE
  }));

  app.get("/ai/onboarding/agents", async () => ({
    agents: AI_ONBOARDING_AGENTS,
    safety: {
      aiCanApplyMigration: false,
      humanReviewMandatory: true,
      dryRunMandatory: true,
      directDatabaseAccess: false
    }
  }));

  // Onboarding extraction / classification / mapping engine endpoints.
  // The API delegates here when AI_GATEWAY_MODE=real.
  registerOnboardingEngineRoutes(app);

  app.post("/ai/commands/check-in-from-scan", async (request) => {
    const body = request.body as CheckInFromScanRequest;
    return api.post<CheckInFromScanResponse>("/ai/commands/check-in-from-scan", body);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3100);
  const host = process.env.HOST ?? "0.0.0.0";
  await buildAiGatewayServer().listen({ port, host });
}
