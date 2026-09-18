// Contexto y contrato de las implementaciones AiTool del API (Tanda L6a, lote 3).
// Cada herramienta declara nombre del registro, efecto, esquemas zod y un
// `execute` sobre los servicios existentes; el tool runner
// (@hotelos/ai-core/runner) decide si se ejecuta, queda pendiente o se
// deniega, y es el ÚNICO que registra telemetría y auditoría.

import type { ZodType, ZodTypeDef } from "zod";
import type { AiContext, AiPurpose, AiResult, AiSuccessMeta, AiTelemetry, JsonSchema } from "@hotelos/ai-core";
import { telemetryFromAiResult } from "@hotelos/ai-core";
import type { ExecuteResult, JsonValue, RunnerContext } from "@hotelos/ai-core/runner";
import type { HotelOsToolName, ToolEffect } from "@hotelos/ai-tools";
import type { AiSource, ToolContext } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { BadRequestError } from "../../../lib/http-error.js";

/** ToolContext compartido más el UserContext real (servicios con requirePermissions) y la correlación. */
export type ApiToolContext = ToolContext & { user: UserContext; correlationId: string };

/** Sin modelo utilizable (o rechazo del modelo): el runner lo persiste como skipped (o failed con coste real). */
export type NotConfiguredOutput = { configured: false; reason: string; message: string; telemetry?: AiTelemetry | null };

/** Resultado envuelto de un `execute`: salida, telemetría del modelo (una sola vez) y `record` sin PII para outputJson. */
export type WrappedToolOutput<O> = { output: O; telemetry?: AiTelemetry | null; record?: JsonValue };

export type ToolExecuteResult<O> = ExecuteResult<O> | NotConfiguredOutput;

export type AiToolImpl<I = unknown, O = unknown> = {
  name: HotelOsToolName;
  /** Debe coincidir con el `effect` de la definición del registro (tools-coverage lo comprueba). */
  effect: ToolEffect;
  description: string;
  inputSchema: ZodType<I, ZodTypeDef, unknown>;
  outputSchema: ZodType<O, ZodTypeDef, unknown>;
  /** JSON Schema escrito a mano para exponer la herramienta al modelo (tools de ai-core, L6b). */
  modelInputSchema?: JsonSchema;
  execute(input: I, ctx: ApiToolContext): Promise<ToolExecuteResult<O>>;
  /** Tarjeta determinista (sin modelo) para la fila awaiting_confirmation. */
  preview?(input: I, ctx: ApiToolContext): JsonValue | undefined | Promise<JsonValue | undefined>;
};

/** Identidad tipada: fija I/O desde los esquemas y evita repetir los genéricos. */
export function defineAiTool<I, O>(impl: AiToolImpl<I, O>): AiToolImpl<I, O> {
  return impl;
}

/** Valida la entrada de una herramienta con su esquema zod → 400 en español si no cumple. */
export function parseToolInput<I>(schema: ZodType<I, ZodTypeDef, unknown>, value: unknown, toolName: string): I {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
  throw new BadRequestError(`Entrada no válida para la herramienta ${toolName}: ${detail}`);
}

export function apiToolContext(user: UserContext, correlationId: string, options: { source?: AiSource; locale?: string } = {}): ApiToolContext {
  return {
    organizationId: user.organizationId,
    propertyId: user.propertyId,
    userId: user.userId,
    deviceId: user.deviceId,
    locale: options.locale ?? "es-ES",
    source: options.source ?? "text",
    auditCorrelationId: correlationId,
    permissions: [...user.permissions],
    user,
    correlationId
  };
}

/** RunnerContext (lo que el runner pasa a `execute`) → ApiToolContext con el UserContext original. */
export function apiToolContextFromRunner(ctx: RunnerContext, user: UserContext): ApiToolContext {
  return {
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    userId: ctx.userId,
    ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : { deviceId: user.deviceId }),
    locale: ctx.locale,
    source: ctx.source,
    auditCorrelationId: ctx.correlationId,
    permissions: [...ctx.permissions],
    // El servicio ya se ejecuta con el ámbito del runner (propiedad y permisos del contexto).
    user: { ...user, organizationId: ctx.organizationId, propertyId: ctx.propertyId, userId: ctx.userId, permissions: [...ctx.permissions] },
    correlationId: ctx.correlationId
  };
}

/** Contexto para getAiCore(): nombre de herramienta, propósito y correlación (rate limit por organización). */
export function aiContextFor(ctx: ApiToolContext, toolName: HotelOsToolName, purpose: AiPurpose, conversationId?: string): AiContext {
  return {
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    userId: ctx.userId,
    toolName,
    purpose,
    correlationId: ctx.correlationId,
    ...(conversationId ? { conversationId } : {})
  };
}

export type ModelUsageSummary = {
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cacheReadTokens: number;
  costUsd: number | null;
  costEur: number | null;
  latencyMs: number;
};

export function usageOf(result: AiSuccessMeta): ModelUsageSummary {
  return {
    model: result.model,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    cacheReadTokens: result.usage.cacheReadTokens,
    costUsd: result.costUsd,
    costEur: result.costEur,
    latencyMs: result.latencyMs
  };
}

/**
 * Traduce un AiResult a lo que devuelve un `execute`: sin modelo → el propio
 * `{ configured:false, reason, message }` (el runner lo persiste como skipped con coste 0);
 * con modelo → `{ output, telemetry }` (el runner persiste la telemetría UNA sola vez).
 */
export function fromAiResult<T, O>(result: AiResult<T>, pick: (value: AiSuccessMeta & T) => O): WrappedToolOutput<O> | NotConfiguredOutput {
  if (result.configured === false) {
    return { configured: false, reason: result.reason, message: result.message, ...(result.telemetry ? { telemetry: result.telemetry } : {}) };
  }
  return { output: pick(result), telemetry: telemetryFromAiResult(result) };
}
