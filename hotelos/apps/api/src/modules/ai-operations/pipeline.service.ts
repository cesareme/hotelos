import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

// AI Pipeline Status — tool-call telemetry surface (Sprint 48).
//
// Two responsibilities:
//   1) `recordToolCall` — a thin write helper other modules call to log an
//      AI tool execution into `AiToolCall`. It persists exactly what it is
//      given (no derived computation) and returns the created row. This is
//      what makes the pipeline "real" going forward; existing in-memory
//      loggers (e.g. check-in.command.ts) can adopt it later.
//   2) `buildPipelineDashboard` / `getToolCall` — read-only aggregation +
//      drill-down for the operations telemetry dashboard.
//
// Sharp edges (see report):
//   * `moduleCode` is NOT on AiToolCall — it is resolved by joining
//     toolName -> AiToolRegistry. We fetch the registry ONCE and build an
//     in-memory Map (toolName -> moduleCode) to avoid an N+1 lookup while
//     grouping calls by module.
//   * Decimal columns (`confidence`, `costEur`) come back as Prisma.Decimal
//     and are coerced via `dec()`; `latencyMs`/tokens are nullable Ints.
//   * Cost MTD / tokens MTD are scoped to the current *calendar* month
//     (UTC) regardless of the `days` window used for the rest of the view.
//   * `successRatePct` counts status === "succeeded" over the total calls in
//     scope; a 0-call denominator yields 0 (not NaN).
//   * Everything defaults to 0 / [] for an empty org so the UI never has to
//     special-case nulls.

export type ToolCallStatus =
  | "succeeded"
  | "failed"
  | "pending"
  | "awaiting_confirmation"
  | "rejected";

export type RecordToolCallInput = {
  organizationId: string;
  toolName: string;
  status: ToolCallStatus | string;
  inputJson: Prisma.InputJsonValue;
  propertyId?: string;
  userId?: string;
  conversationId?: string;
  outputJson?: Prisma.InputJsonValue;
  confidence?: number;
  requiredConfirmation?: boolean;
  confirmedBy?: string;
  model?: string;
  latencyMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costEur?: number;
  errorMessage?: string;
  automationLevel?: string;
};

export type PipelineDashboard = {
  kpis: {
    callsTotal: number;
    calls24h: number;
    successRatePct: number;
    avgLatencyMs: number;
    avgConfidence: number;
    awaitingConfirmation: number;
    failed24h: number;
    costMtdEur: number;
    tokensMtd: number;
  };
  byTool: Array<{
    toolName: string;
    calls: number;
    successRatePct: number;
    avgLatencyMs: number;
    avgConfidence: number;
    costEur: number;
  }>;
  byModule: Array<{ moduleCode: string; calls: number; successRatePct: number }>;
  byStatus: Array<{ status: string; count: number }>;
  confidenceBuckets: Array<{ bucket: string; count: number }>;
  latencyTrend: Array<{ date: string; avgLatencyMs: number; calls: number }>;
  recentCalls: Array<{
    id: string;
    toolName: string;
    status: string;
    confidence: number | null;
    latencyMs: number | null;
    costEur: number | null;
    automationLevel: string | null;
    createdAt: string;
    hasError: boolean;
  }>;
  anomalies: Array<{
    id: string;
    type: string;
    severity: string;
    description: string;
    detectedAt: string;
    status: string;
  }>;
};

export type ToolCallDetail = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  userId: string | null;
  conversationId: string | null;
  toolName: string;
  status: string;
  inputJson: unknown;
  outputJson: unknown;
  confidence: number | null;
  requiredConfirmation: boolean;
  confirmedBy: string | null;
  model: string | null;
  latencyMs: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costEur: number | null;
  errorMessage: string | null;
  automationLevel: string | null;
  createdAt: string;
} | null;

function dec(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyDashboard(): PipelineDashboard {
  return {
    kpis: {
      callsTotal: 0,
      calls24h: 0,
      successRatePct: 0,
      avgLatencyMs: 0,
      avgConfidence: 0,
      awaitingConfirmation: 0,
      failed24h: 0,
      costMtdEur: 0,
      tokensMtd: 0
    },
    byTool: [],
    byModule: [],
    byStatus: [],
    confidenceBuckets: [],
    latencyTrend: [],
    recentCalls: [],
    anomalies: []
  };
}

/**
 * Persist a single AI tool execution. No derived computation — callers pass
 * the already-known status/latency/cost. Returns the created row.
 */
export async function recordToolCall(input: RecordToolCallInput) {
  const data: Prisma.AiToolCallUncheckedCreateInput = {
    organizationId: input.organizationId,
    toolName: input.toolName,
    status: input.status,
    inputJson: input.inputJson,
    requiredConfirmation: input.requiredConfirmation ?? false
  };
  if (input.propertyId !== undefined) data.propertyId = input.propertyId;
  if (input.userId !== undefined) data.userId = input.userId;
  if (input.conversationId !== undefined) data.conversationId = input.conversationId;
  if (input.outputJson !== undefined) data.outputJson = input.outputJson;
  if (input.confidence !== undefined) data.confidence = input.confidence;
  if (input.confirmedBy !== undefined) data.confirmedBy = input.confirmedBy;
  if (input.model !== undefined) data.model = input.model;
  if (input.latencyMs !== undefined) data.latencyMs = input.latencyMs;
  if (input.tokensInput !== undefined) data.tokensInput = input.tokensInput;
  if (input.tokensOutput !== undefined) data.tokensOutput = input.tokensOutput;
  if (input.costEur !== undefined) data.costEur = input.costEur;
  if (input.errorMessage !== undefined) data.errorMessage = input.errorMessage;
  if (input.automationLevel !== undefined) data.automationLevel = input.automationLevel;

  return prisma.aiToolCall.create({ data });
}

export async function buildPipelineDashboard(input: {
  organizationId: string;
  propertyId?: string;
  days?: number;
}): Promise<PipelineDashboard> {
  const organizationId = input.organizationId;
  if (!organizationId) return emptyDashboard();

  const days =
    Number.isFinite(input.days) && (input.days as number) > 0
      ? Math.floor(input.days as number)
      : 30;
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const last24hStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // propertyId is nullable on AiToolCall (org-wide rows). When a property is
  // requested we include both the property's own rows and org-wide (null)
  // rows, matching the read pattern of the analytics dashboards.
  const scopeFilter: Prisma.AiToolCallWhereInput = input.propertyId
    ? { organizationId, OR: [{ propertyId: input.propertyId }, { propertyId: null }] }
    : { organizationId };

  // Parallel fetch: windowed calls (drives all aggregations), MTD calls
  // (cost/tokens), the tool registry (moduleCode resolution), and anomalies.
  const [calls, mtdCalls, registry, anomalies] = await Promise.all([
    prisma.aiToolCall.findMany({
      where: { ...scopeFilter, createdAt: { gte: windowStart, lte: now } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.aiToolCall.findMany({
      where: { ...scopeFilter, createdAt: { gte: monthStart, lte: now } },
      select: { costEur: true, tokensInput: true, tokensOutput: true }
    }),
    prisma.aiToolRegistry.findMany({ select: { toolName: true, moduleCode: true } }),
    prisma.anomalyEvent.findMany({
      where: input.propertyId
        ? { organizationId, OR: [{ propertyId: input.propertyId }, { propertyId: null }] }
        : { organizationId },
      orderBy: { detectedAt: "desc" },
      take: 10
    })
  ]);

  if (calls.length === 0 && mtdCalls.length === 0 && anomalies.length === 0) {
    // Nothing recorded — return a fully-zeroed shape (anomalies still empty).
    return emptyDashboard();
  }

  // toolName -> moduleCode, built once to avoid an N+1 join while grouping.
  const moduleByTool = new Map(registry.map((r) => [r.toolName, r.moduleCode] as const));

  const callsTotal = calls.length;
  const calls24h = calls.filter((c) => c.createdAt >= last24hStart).length;
  const succeeded = calls.filter((c) => c.status === "succeeded").length;
  const successRatePct = callsTotal > 0 ? round1((succeeded / callsTotal) * 100) : 0;
  const awaitingConfirmation = calls.filter((c) => c.status === "awaiting_confirmation").length;
  const failed24h = calls.filter((c) => c.status === "failed" && c.createdAt >= last24hStart).length;

  // avgLatency / avgConfidence average only over non-null rows.
  const latencyValues = calls
    .map((c) => c.latencyMs)
    .filter((v): v is number => typeof v === "number");
  const avgLatencyMs =
    latencyValues.length > 0
      ? Math.round(latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length)
      : 0;
  const confidenceValues = calls
    .map((c) => dec(c.confidence))
    .filter((v): v is number => v !== null);
  const avgConfidence =
    confidenceValues.length > 0
      ? round4(confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length)
      : 0;

  // MTD cost + tokens (current calendar month, independent of `days`).
  const costMtdEur = round2(
    mtdCalls.reduce((sum, c) => sum + (dec(c.costEur) ?? 0), 0)
  );
  const tokensMtd = mtdCalls.reduce(
    (sum, c) => sum + (c.tokensInput ?? 0) + (c.tokensOutput ?? 0),
    0
  );

  // byTool — group windowed calls by toolName, top 20 by call count.
  type ToolAgg = {
    calls: number;
    succeeded: number;
    latencySum: number;
    latencyN: number;
    confSum: number;
    confN: number;
    cost: number;
  };
  const toolAgg = new Map<string, ToolAgg>();
  for (const c of calls) {
    let agg = toolAgg.get(c.toolName);
    if (!agg) {
      agg = { calls: 0, succeeded: 0, latencySum: 0, latencyN: 0, confSum: 0, confN: 0, cost: 0 };
      toolAgg.set(c.toolName, agg);
    }
    agg.calls += 1;
    if (c.status === "succeeded") agg.succeeded += 1;
    if (typeof c.latencyMs === "number") {
      agg.latencySum += c.latencyMs;
      agg.latencyN += 1;
    }
    const conf = dec(c.confidence);
    if (conf !== null) {
      agg.confSum += conf;
      agg.confN += 1;
    }
    agg.cost += dec(c.costEur) ?? 0;
  }
  const byTool = Array.from(toolAgg.entries())
    .map(([toolName, agg]) => ({
      toolName,
      calls: agg.calls,
      successRatePct: agg.calls > 0 ? round1((agg.succeeded / agg.calls) * 100) : 0,
      avgLatencyMs: agg.latencyN > 0 ? Math.round(agg.latencySum / agg.latencyN) : 0,
      avgConfidence: agg.confN > 0 ? round4(agg.confSum / agg.confN) : 0,
      costEur: round2(agg.cost)
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 20);

  // byModule — resolve moduleCode via registry; unregistered tools fall into
  // an "unregistered" bucket so the totals still reconcile.
  const moduleAgg = new Map<string, { calls: number; succeeded: number }>();
  for (const c of calls) {
    const moduleCode = moduleByTool.get(c.toolName) ?? "unregistered";
    let agg = moduleAgg.get(moduleCode);
    if (!agg) {
      agg = { calls: 0, succeeded: 0 };
      moduleAgg.set(moduleCode, agg);
    }
    agg.calls += 1;
    if (c.status === "succeeded") agg.succeeded += 1;
  }
  const byModule = Array.from(moduleAgg.entries())
    .map(([moduleCode, agg]) => ({
      moduleCode,
      calls: agg.calls,
      successRatePct: agg.calls > 0 ? round1((agg.succeeded / agg.calls) * 100) : 0
    }))
    .sort((a, b) => b.calls - a.calls);

  // byStatus — simple count per status, descending.
  const statusAgg = new Map<string, number>();
  for (const c of calls) {
    statusAgg.set(c.status, (statusAgg.get(c.status) ?? 0) + 1);
  }
  const byStatus = Array.from(statusAgg.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  // confidenceBuckets — fixed four-bucket histogram over rows with a
  // confidence value. Upper bound inclusive on the top bucket only.
  const buckets = [
    { bucket: "0-0.5", min: 0, max: 0.5, count: 0 },
    { bucket: "0.5-0.7", min: 0.5, max: 0.7, count: 0 },
    { bucket: "0.7-0.9", min: 0.7, max: 0.9, count: 0 },
    { bucket: "0.9-1.0", min: 0.9, max: 1.0001, count: 0 }
  ];
  for (const conf of confidenceValues) {
    const hit = buckets.find((b) => conf >= b.min && conf < b.max);
    if (hit) hit.count += 1;
  }
  const confidenceBuckets = buckets.map((b) => ({ bucket: b.bucket, count: b.count }));

  // latencyTrend — last 14 days, one row per calendar day (UTC), even for
  // days with no calls (so the bar chart has a continuous x-axis).
  const trendByDay = new Map<string, { latencySum: number; latencyN: number; calls: number }>();
  const trendStart = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(trendStart.getTime() + i * 24 * 60 * 60 * 1000);
    trendByDay.set(isoDay(d), { latencySum: 0, latencyN: 0, calls: 0 });
  }
  for (const c of calls) {
    const key = isoDay(c.createdAt);
    const slot = trendByDay.get(key);
    if (!slot) continue; // older than 14d (window may be longer)
    slot.calls += 1;
    if (typeof c.latencyMs === "number") {
      slot.latencySum += c.latencyMs;
      slot.latencyN += 1;
    }
  }
  const latencyTrend = Array.from(trendByDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, slot]) => ({
      date,
      avgLatencyMs: slot.latencyN > 0 ? Math.round(slot.latencySum / slot.latencyN) : 0,
      calls: slot.calls
    }));

  // recentCalls — most recent 25 (calls is already desc by createdAt).
  const recentCalls = calls.slice(0, 25).map((c) => ({
    id: c.id,
    toolName: c.toolName,
    status: c.status,
    confidence: dec(c.confidence),
    latencyMs: c.latencyMs,
    costEur: dec(c.costEur),
    automationLevel: c.automationLevel,
    createdAt: c.createdAt.toISOString(),
    hasError: Boolean(c.errorMessage) || c.status === "failed"
  }));

  return {
    kpis: {
      callsTotal,
      calls24h,
      successRatePct,
      avgLatencyMs,
      avgConfidence,
      awaitingConfirmation,
      failed24h,
      costMtdEur,
      tokensMtd
    },
    byTool,
    byModule,
    byStatus,
    confidenceBuckets,
    latencyTrend,
    recentCalls,
    anomalies: anomalies.map((a) => ({
      id: a.id,
      type: a.anomalyType,
      severity: a.severity,
      description: a.description ?? a.title,
      detectedAt: a.detectedAt.toISOString(),
      status: a.status
    }))
  };
}

/**
 * Full row (including input/output JSON) for the drill-down panel.
 * Returns null when the id does not exist.
 */
export async function getToolCall(id: string): Promise<ToolCallDetail> {
  if (!id) return null;
  const row = await prisma.aiToolCall.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    userId: row.userId,
    conversationId: row.conversationId,
    toolName: row.toolName,
    status: row.status,
    inputJson: row.inputJson,
    outputJson: row.outputJson,
    confidence: dec(row.confidence),
    requiredConfirmation: row.requiredConfirmation,
    confirmedBy: row.confirmedBy,
    model: row.model,
    latencyMs: row.latencyMs,
    tokensInput: row.tokensInput,
    tokensOutput: row.tokensOutput,
    costEur: dec(row.costEur),
    errorMessage: row.errorMessage,
    automationLevel: row.automationLevel,
    createdAt: row.createdAt.toISOString()
  };
}
