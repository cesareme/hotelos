// AI Assistant conversacional — versión "Ask Signals" style.
//
// Recibe una pregunta del usuario, identifica qué herramientas del catálogo
// (assistant.tools.ts) puede invocar, ejecuta esas herramientas (siempre
// servicios reales, no mocks) y compone una respuesta en lenguaje natural.
//
// Diseño honesto:
//   - Si NO hay LLM configurado → router determinista por keywords + plantilla
//     de respuesta. Funciona sin red, sin coste, y la respuesta cita la fuente.
//   - El modo `llm` solo se declara cuando un modelo ha respondido de verdad
//     (`deriveAssistantMode`): en la Tanda L6a el asistente sigue siendo
//     determinista aunque exista clave; la llamada con tool-calling llega en L6b.
//
// El usuario siempre ve qué tools se usaron y cuándo (transparencia HITL); cada
// turno se registra en ai_tool_calls (answerAnalyticsQuestion) con su latencia.

import { ASSISTANT_TOOLS, findToolsByKeyword, type ToolResult, type ToolDefinition } from "./assistant.tools.js";
import type { UserContext } from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
import { recordToolCall } from "../ai-operations/pipeline.service.js";

export type AssistantTurn = {
  question: string;
  answer: string;
  toolCalls: Array<{
    name: string;
    ok: boolean;
    source: string;
    summary: string;
  }>;
  mode: "deterministic" | "llm";
  generatedAt: string;
  correlationId: string;
};

/** Resultado de herramienta tal como lo ve el modo: `modelAnswered` lo pondrá el modelo (L6b). */
export type AssistantToolOutcome = { ok: boolean; modelAnswered?: boolean };

/**
 * Modo honesto del turno: `llm` SOLO si algún resultado lo produjo un modelo
 * (`modelAnswered: true`); si no, `deterministic`, haya o no clave configurada.
 */
export function deriveAssistantMode(results: ReadonlyArray<{ result: AssistantToolOutcome }>): AssistantTurn["mode"] {
  return results.some(({ result }) => result.modelAnswered === true) ? "llm" : "deterministic";
}

function fmtMoney(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

function fmtPct(n: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(n) + " %";
}

function renderToolSummary(toolName: string, r: ToolResult): string {
  if (!r.ok) return `(${toolName}: no hay datos disponibles)`;
  const d = r.data as Record<string, unknown>;
  switch (toolName) {
    case "get_arrivals_today":
      return `${d.count} reservas con llegada hoy.`;
    case "get_departures_today":
      return `${d.count} reservas con salida hoy.`;
    case "get_in_house_guests":
      return `${d.count} huéspedes en hotel ahora.`;
    case "get_occupancy_today":
      return `Ocupación hoy: ${fmtPct(Number(d.occupancyPct))} (${d.occupiedRooms}/${d.totalRooms} habitaciones).`;
    case "get_recent_revenue_snapshot":
      return `Último snapshot ${d.snapshotDate}: ocupación ${fmtPct(Number(d.occupancyPct))}, ADR ${fmtMoney(Number(d.adr), String(d.currency))}, RevPAR ${fmtMoney(Number(d.revpar), String(d.currency))}.`;
    case "get_pickup_7d":
      return `Pickup últimos 7 días: ${d.reservationsCreated} reservas creadas.`;
    case "get_open_balance":
      return `Saldo pendiente: ${fmtMoney(Number(d.balanceDue), String(d.currency))} en ${d.openFolios} folios abiertos.`;
    case "get_housekeeping_status": {
      const breakdown = d.statusBreakdown as Record<string, number>;
      const parts = Object.entries(breakdown).map(([k, v]) => `${k}: ${v}`);
      return `Pisos (${d.totalRooms} habitaciones) — ${parts.join(", ")}.`;
    }
    case "get_compliance_summary": {
      const bySev = (d.bySeverity ?? {}) as Record<string, number>;
      const parts = Object.entries(bySev).map(([k, v]) => `${k}: ${v}`);
      return parts.length > 0 ? `Cumplimiento por severidad — ${parts.join(", ")}.` : "Sin datos de cumplimiento.";
    }
    default:
      return JSON.stringify(d);
  }
}

function composeAnswer(question: string, results: Array<{ tool: ToolDefinition; result: ToolResult }>): string {
  if (results.length === 0) {
    const supported = ASSISTANT_TOOLS.map((t) => `• ${t.name}: ${t.description}`).join("\n");
    return [
      "No he sabido enrutar tu pregunta a una herramienta concreta. Puedo responder, entre otras cosas, a:",
      "",
      supported,
      "",
      "Reformula la pregunta usando una de esas áreas y te responderé con datos reales."
    ].join("\n");
  }
  const lines: string[] = [];
  const intro = results.length === 1 ? "Aquí tienes la respuesta:" : `He consultado ${results.length} fuentes:`;
  lines.push(intro);
  lines.push("");
  for (const { tool, result } of results) {
    lines.push(`• ${renderToolSummary(tool.name, result)}`);
  }
  lines.push("");
  lines.push("Datos consultados en tiempo real desde Prisma. Si necesitas detalle, pídelo por entidad concreta (reservas, folios, etc.).");
  return lines.join("\n");
}

export async function answerQuestion(input: { context: UserContext; question: string }): Promise<AssistantTurn> {
  const correlationId = createId("corr");
  const t0 = Date.now();
  const tools = findToolsByKeyword(input.question);

  // Ejecuta todas las tools en paralelo (cada una es 1 query Prisma)
  const ctx = { organizationId: input.context.organizationId, propertyId: input.context.propertyId };
  const results = await Promise.all(
    tools.map(async (tool) => {
      try {
        const r = await tool.run(ctx);
        return { tool, result: r };
      } catch (e) {
        return {
          tool,
          result: {
            ok: false,
            data: { error: e instanceof Error ? e.message : String(e) },
            source: tool.name,
            generatedAt: new Date().toISOString()
          } as ToolResult
        };
      }
    })
  );

  const answer = composeAnswer(input.question, results);
  const turn: AssistantTurn = {
    question: input.question,
    answer,
    toolCalls: results.map(({ tool, result }) => ({
      name: tool.name,
      ok: result.ok,
      source: result.source,
      summary: renderToolSummary(tool.name, result)
    })),
    mode: deriveAssistantMode(results),
    generatedAt: new Date().toISOString(),
    correlationId
  };

  // Telemetría real del pipeline (patrón messaging.service.ts): un fallo al
  // insertar nunca rompe la respuesta, pero se avisa para que no pase inadvertido.
  recordToolCall({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    userId: input.context.userId,
    toolName: "answerAnalyticsQuestion",
    status: "succeeded",
    inputJson: { question: input.question },
    outputJson: { toolCalls: turn.toolCalls },
    latencyMs: Date.now() - t0,
    automationLevel: "suggest"
  }).catch((err: unknown) =>
    console.warn("[ai.telemetry] insert failed", {
      toolName: "answerAnalyticsQuestion",
      correlationId,
      error: err instanceof Error ? err.message : String(err)
    })
  );
  return turn;
}

export function getAvailableTools() {
  return ASSISTANT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    keywords: t.keywords
  }));
}
