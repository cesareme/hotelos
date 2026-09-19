import { EVAL_PROMPT_CODES, getEvalSuite, isAiError, labelFor, scoreCase, telemetryFromAiResult } from "@hotelos/ai-core";
import type { AiContext, AiTelemetry } from "@hotelos/ai-core";
import { budgetStatus, monthlyBudgetEurOf } from "@hotelos/ai-core/runner";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { getAiCore, setAiPromptSource } from "../../lib/ai-client.js";
import { getAiConfig } from "../../lib/ai-config.js";
import { createId } from "../../lib/ids.js";
import { isLlmConfigured } from "../../lib/llm.js";
import { NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { monthToDateCostEur, recordToolCall } from "./pipeline.service.js";
import { getPropertyAiSettings } from "./property-ai.service.js";

// =====================================================================================
// Sprint 49 — AI Governance service
// Five sub-areas behind the /ai-operations/governance/* prefix:
//   1. Policies          — org/property guardrail configuration + a real policy-gate evaluator
//   2. Prompt versions   — draft → published → archived lifecycle + line diff
//   3. Evaluations       — create + a REAL runner (runs the prompt against a built-in test suite via the LLM provider; "skipped" when no provider is configured)
//   4. Incidents         — open → investigating → resolved workflow
//   5. Cost dashboard    — aggregation over AiToolCall
// All functions are self-contained and other modules may import the evaluator/policy helpers.
// =====================================================================================

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// -------------------------------------------------------------------------------------
// Policies
// -------------------------------------------------------------------------------------

export type PolicyRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  policyCode: string;
  name: string;
  configuration: Record<string, unknown>;
  active: boolean;
  createdAt: string;
};

// Well-known policy codes with sensible defaults. These are seeded and also act as the
// catalog the policy-gate evaluator understands.
export const DEFAULT_POLICIES: Array<{ policyCode: string; name: string; configuration: Record<string, unknown> }> = [
  { policyCode: "max_autonomous_risk", name: "Nivel máximo de riesgo autónomo", configuration: { maxLevel: "medium" } },
  {
    policyCode: "require_confirmation_above_confidence",
    name: "Requerir confirmación por encima del umbral de confianza",
    configuration: { threshold: 0.85 }
  },
  { policyCode: "pii_redaction", name: "Ocultación de datos personales (PII)", configuration: { enabled: true } },
  { policyCode: "guest_disclosure_required", name: "Aviso de IA al huésped obligatorio", configuration: { enabled: true } },
  { policyCode: "human_review_for_high_risk", name: "Revisión humana para acciones de alto riesgo", configuration: { enabled: true } }
];

function mapPolicy(row: NonNullable<Awaited<ReturnType<typeof prisma.aiPolicy.findUnique>>>): PolicyRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    policyCode: row.policyCode,
    name: row.name,
    configuration: readJsonRecord(row.configurationJson),
    active: row.active,
    createdAt: row.createdAt.toISOString()
  };
}

export async function listPolicies(input: { organizationId: string; propertyId?: string }): Promise<PolicyRecord[]> {
  const rows = await prisma.aiPolicy.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {})
    },
    orderBy: [{ policyCode: "asc" }, { createdAt: "asc" }]
  });
  return rows.map(mapPolicy);
}

// Upsert keyed on (organizationId, propertyId, policyCode). There is no DB unique on that
// triple, so we look it up manually (treating null/undefined propertyId as the org-level row).
export async function upsertPolicy(input: {
  organizationId: string;
  propertyId?: string;
  policyCode: string;
  name?: string;
  configuration?: Record<string, unknown>;
  active?: boolean;
}): Promise<PolicyRecord> {
  if (!input.policyCode) throw new Error("policyCode is required.");

  // Race-condition fix: do the lookup + (update | create) in a single
  // transaction so two concurrent upsertPolicy calls cannot both miss the
  // existing row and insert duplicates (the (org, property, policyCode) triple
  // has no DB unique constraint, so manual upsert is otherwise racy).
  const known = DEFAULT_POLICIES.find((p) => p.policyCode === input.policyCode);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.aiPolicy.findFirst({
      where: {
        organizationId: input.organizationId,
        propertyId: input.propertyId ?? null,
        policyCode: input.policyCode
      }
    });

    const name = input.name ?? existing?.name ?? known?.name ?? input.policyCode;
    const configuration =
      input.configuration ??
      (existing ? readJsonRecord(existing.configurationJson) : undefined) ??
      known?.configuration ??
      {};

    if (existing) {
      const updated = await tx.aiPolicy.update({
        where: { id: existing.id },
        data: {
          name,
          configurationJson: configuration as Prisma.InputJsonValue,
          ...(input.active === undefined ? {} : { active: input.active })
        }
      });
      return mapPolicy(updated);
    }

    const created = await tx.aiPolicy.create({
      data: {
        organizationId: input.organizationId,
        propertyId: input.propertyId ?? null,
        policyCode: input.policyCode,
        name,
        configurationJson: configuration as Prisma.InputJsonValue,
        active: input.active ?? true
      }
    });
    return mapPolicy(created);
  });
}

export async function setPolicyActive(id: string, active: boolean): Promise<PolicyRecord> {
  const existing = await prisma.aiPolicy.findUnique({ where: { id } });
  if (!existing) throw new Error("Policy was not found.");
  const updated = await prisma.aiPolicy.update({ where: { id }, data: { active } });
  return mapPolicy(updated);
}

// -------------------------------------------------------------------------------------
// Policy-gate evaluator — a real guardrail other modules can call before executing a
// tool. Resolves the effective policy for a tool call (property row overrides org row)
// and returns the gate decision.
// -------------------------------------------------------------------------------------

export type PolicyGateInput = {
  organizationId: string;
  propertyId?: string;
  toolRiskLevel: "low" | "medium" | "high" | "critical" | string;
  confidence?: number;
  automationLevel?: "manual" | "suggest" | "confirm" | "autonomous" | string;
};

export type PolicyGateDecision = {
  allowed: boolean;
  requiresConfirmation: boolean;
  requiresHumanReview: boolean;
  reasons: string[];
};

const RISK_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function riskRank(level: string): number {
  return RISK_RANK[level?.toLowerCase()] ?? 2;
}

export async function evaluatePolicyGate(input: PolicyGateInput): Promise<PolicyGateDecision> {
  const rows = await prisma.aiPolicy.findMany({
    where: {
      organizationId: input.organizationId,
      active: true,
      OR: [{ propertyId: input.propertyId ?? null }, { propertyId: null }]
    }
  });

  // Property-scoped rows take precedence over org-scoped rows for the same policyCode.
  const effective = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const isPropertyScoped = row.propertyId === (input.propertyId ?? null) && row.propertyId !== null;
    if (!effective.has(row.policyCode) || isPropertyScoped) {
      effective.set(row.policyCode, readJsonRecord(row.configurationJson));
    }
  }

  const reasons: string[] = [];
  let allowed = true;
  let requiresConfirmation = false;
  let requiresHumanReview = false;

  const callRisk = riskRank(input.toolRiskLevel);
  const isAutonomous = (input.automationLevel ?? "").toLowerCase() === "autonomous";

  // max_autonomous_risk — block autonomous execution above the configured ceiling.
  const maxAuto = effective.get("max_autonomous_risk");
  if (maxAuto) {
    const maxLevel = typeof maxAuto.maxLevel === "string" ? maxAuto.maxLevel : "medium";
    if (isAutonomous && callRisk > riskRank(maxLevel)) {
      allowed = false;
      requiresConfirmation = true;
      reasons.push(
        `Autonomous execution blocked: tool risk "${input.toolRiskLevel}" exceeds max autonomous level "${maxLevel}".`
      );
    }
  }

  // require_confirmation_above_confidence — below the threshold we ask for confirmation.
  const confPolicy = effective.get("require_confirmation_above_confidence");
  if (confPolicy && typeof input.confidence === "number") {
    const threshold = typeof confPolicy.threshold === "number" ? confPolicy.threshold : 0.85;
    if (input.confidence < threshold) {
      requiresConfirmation = true;
      reasons.push(
        `Confidence ${input.confidence.toFixed(2)} is below the required threshold ${threshold.toFixed(2)}; confirmation required.`
      );
    }
  }

  // human_review_for_high_risk — high/critical actions are routed to a human reviewer.
  const reviewPolicy = effective.get("human_review_for_high_risk");
  if (reviewPolicy && reviewPolicy.enabled !== false && callRisk >= riskRank("high")) {
    requiresHumanReview = true;
    requiresConfirmation = true;
    reasons.push(`Human review required for ${input.toolRiskLevel}-risk action.`);
  }

  if (reasons.length === 0) {
    reasons.push("No policy gate triggered; action permitted.");
  }

  return { allowed, requiresConfirmation, requiresHumanReview, reasons };
}

// -------------------------------------------------------------------------------------
// Prompt versions — lifecycle: draft → published → archived, with auto-incrementing
// version labels (v1, v2, …) per promptCode and a simple line diff.
// -------------------------------------------------------------------------------------

export type PromptVersionRecord = {
  id: string;
  promptCode: string;
  version: string;
  content: string;
  status: "draft" | "published" | "archived" | string;
  notes?: string;
  createdBy?: string;
  publishedAt?: string;
  archivedAt?: string;
  createdAt: string;
};

export type PromptGroup = {
  promptCode: string;
  versionCount: number;
  currentPublishedVersion?: string;
  currentPublishedId?: string;
  latestVersion?: string;
  updatedAt?: string;
};

function mapPromptVersion(
  row: NonNullable<Awaited<ReturnType<typeof prisma.aiPromptVersion.findUnique>>>
): PromptVersionRecord {
  return {
    id: row.id,
    promptCode: row.promptCode,
    version: row.version,
    content: row.content,
    status: row.status,
    notes: row.notes ?? undefined,
    createdBy: row.createdBy ?? undefined,
    publishedAt: row.publishedAt?.toISOString(),
    archivedAt: row.archivedAt?.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

// Parses the numeric suffix from a "vN" label (or returns 0 for anything unparseable).
function versionNumber(version: string): number {
  const m = /^v?(\d+)$/i.exec(version.trim());
  return m ? Number(m[1]) : 0;
}

export async function listPrompts(): Promise<PromptGroup[]> {
  const rows = await prisma.aiPromptVersion.findMany({ orderBy: { createdAt: "asc" } });
  const byCode = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCode.get(row.promptCode) ?? [];
    list.push(row);
    byCode.set(row.promptCode, list);
  }
  const groups: PromptGroup[] = [];
  for (const [promptCode, versions] of byCode.entries()) {
    const published = versions.find((v) => v.status === "published");
    const latest = [...versions].sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0];
    const updatedAt = versions
      .map((v) => v.createdAt.getTime())
      .reduce((max, t) => Math.max(max, t), 0);
    groups.push({
      promptCode,
      versionCount: versions.length,
      currentPublishedVersion: published?.version,
      currentPublishedId: published?.id,
      latestVersion: latest?.version,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined
    });
  }
  groups.sort((a, b) => a.promptCode.localeCompare(b.promptCode));
  return groups;
}

export async function getPromptVersions(promptCode: string): Promise<PromptVersionRecord[]> {
  const rows = await prisma.aiPromptVersion.findMany({ where: { promptCode } });
  return rows.map(mapPromptVersion).sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
}

export async function createPromptVersion(input: {
  promptCode: string;
  content: string;
  notes?: string;
  createdBy?: string;
}): Promise<PromptVersionRecord> {
  if (!input.promptCode) throw new Error("promptCode is required.");
  if (!input.content) throw new Error("content is required.");
  const existing = await prisma.aiPromptVersion.findMany({
    where: { promptCode: input.promptCode },
    select: { version: true }
  });
  const nextNumber = existing.reduce((max, v) => Math.max(max, versionNumber(v.version)), 0) + 1;
  const created = await prisma.aiPromptVersion.create({
    data: {
      promptCode: input.promptCode,
      version: `v${nextNumber}`,
      content: input.content,
      status: "draft",
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null
    }
  });
  return mapPromptVersion(created);
}

// Publishing archives the currently-published version of the same promptCode (only one
// published version may exist at a time) then promotes this one.
//
// Race-condition fix: bundle the read, the archive-of-the-currently-published row and the
// promotion into a single transaction. Without it, two concurrent publishes of different
// versions for the same promptCode could both observe the old "published" row, archive it,
// and then both promote themselves — leaving two rows in "published" status.
export async function publishPromptVersion(id: string): Promise<PromptVersionRecord> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.aiPromptVersion.findUnique({ where: { id } });
    if (!target) throw new NotFoundError("Versión de prompt no encontrada.");
    if (target.status === "published") return mapPromptVersion(target);

    await tx.aiPromptVersion.updateMany({
      where: { promptCode: target.promptCode, status: "published", id: { not: target.id } },
      data: { status: "archived", archivedAt: new Date() }
    });

    const updated = await tx.aiPromptVersion.update({
      where: { id: target.id },
      data: { status: "published", publishedAt: new Date(), archivedAt: null }
    });
    return mapPromptVersion(updated);
  });
}

/**
 * Tanda L6a (lote 4): contenido de la versión PUBLICADA de un prompt (índice
 * [promptCode, status]); null si no hay ninguna. Es la fuente que consume
 * `promptFrom` de ai-core (caché 60 s por proceso), de modo que los execute del
 * catálogo (guest_message_reply, draft_review_response, analyze_review_sentiment)
 * usan la versión publicada en ai_prompt_versions y caen al texto en código sin fila.
 */
export async function getPublishedPrompt(promptCode: string): Promise<string | null> {
  const code = (promptCode ?? "").trim();
  if (!code) return null;
  const row = await prisma.aiPromptVersion.findFirst({
    where: { promptCode: code, status: "published" },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    select: { content: true }
  });
  const content = row?.content?.trim();
  return content ? row!.content : null;
}

// Registro en la carga del módulo: el núcleo de IA se crea antes de que gobernanza exista
// (lib/ai-client.ts delega tarde), así que aquí se conecta el lector de prompts publicados.
setAiPromptSource(getPublishedPrompt);

export async function archivePromptVersion(id: string): Promise<PromptVersionRecord> {
  const target = await prisma.aiPromptVersion.findUnique({ where: { id } });
  if (!target) throw new NotFoundError("Versión de prompt no encontrada.");
  const updated = await prisma.aiPromptVersion.update({
    where: { id: target.id },
    data: { status: "archived", archivedAt: new Date() }
  });
  return mapPromptVersion(updated);
}

export type PromptDiffLine = {
  type: "equal" | "added" | "removed";
  lineNumber: number;
  text: string;
};

// A simple, deterministic line-by-line diff. Not an LCS diff — it walks both side by
// side, and emits remaining lines of the longer side as added/removed. Good enough to
// surface what changed between two prompt versions in the UI.
export async function diffPromptVersions(
  idA: string,
  idB: string
): Promise<{
  a: PromptVersionRecord;
  b: PromptVersionRecord;
  diff: PromptDiffLine[];
}> {
  const [rowA, rowB] = await Promise.all([
    prisma.aiPromptVersion.findUnique({ where: { id: idA } }),
    prisma.aiPromptVersion.findUnique({ where: { id: idB } })
  ]);
  if (!rowA) throw new Error("Prompt version A was not found.");
  if (!rowB) throw new Error("Prompt version B was not found.");

  const linesA = rowA.content.split("\n");
  const linesB = rowB.content.split("\n");
  const diff: PromptDiffLine[] = [];
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i += 1) {
    const la = linesA[i];
    const lb = linesB[i];
    if (la === lb) {
      diff.push({ type: "equal", lineNumber: i + 1, text: la ?? "" });
    } else {
      if (la !== undefined) diff.push({ type: "removed", lineNumber: i + 1, text: la });
      if (lb !== undefined) diff.push({ type: "added", lineNumber: i + 1, text: lb });
    }
  }

  return { a: mapPromptVersion(rowA), b: mapPromptVersion(rowB), diff };
}

// -------------------------------------------------------------------------------------
// Evaluations
// -------------------------------------------------------------------------------------

export type EvaluationRecord = {
  id: string;
  organizationId?: string;
  propertyId?: string;
  evaluationName: string;
  evaluationType: string;
  promptCode?: string;
  status: "pending" | "running" | "completed" | "failed" | string;
  score?: number;
  passRate?: number;
  sampleSize?: number;
  results: Record<string, unknown>;
  completedAt?: string;
  createdAt: string;
};

function mapEvaluation(
  row: NonNullable<Awaited<ReturnType<typeof prisma.aiEvaluation.findUnique>>>
): EvaluationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId ?? undefined,
    propertyId: row.propertyId ?? undefined,
    evaluationName: row.evaluationName,
    evaluationType: row.evaluationType,
    promptCode: row.promptCode ?? undefined,
    status: row.status,
    score: row.score === null || row.score === undefined ? undefined : dec(row.score),
    passRate: row.passRate === null || row.passRate === undefined ? undefined : dec(row.passRate),
    sampleSize: row.sampleSize ?? undefined,
    results: readJsonRecord(row.resultsJson),
    completedAt: row.completedAt?.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

export async function listEvaluations(input: {
  organizationId?: string;
  status?: string;
}): Promise<EvaluationRecord[]> {
  const rows = await prisma.aiEvaluation.findMany({
    where: {
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.status ? { status: input.status } : {})
    },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(mapEvaluation);
}

export async function createEvaluation(input: {
  organizationId?: string;
  propertyId?: string;
  evaluationName: string;
  evaluationType: string;
  promptCode?: string;
}): Promise<EvaluationRecord> {
  if (!input.evaluationName) throw new Error("evaluationName is required.");
  if (!input.evaluationType) throw new Error("evaluationType is required.");
  const created = await prisma.aiEvaluation.create({
    data: {
      organizationId: input.organizationId ?? null,
      propertyId: input.propertyId ?? null,
      evaluationName: input.evaluationName,
      evaluationType: input.evaluationType,
      promptCode: input.promptCode ?? null,
      status: "pending"
    }
  });
  return mapEvaluation(created);
}

// Tanda L6a (lote 4): las suites por prompt (5 casos cada una, elegidas por
// target.promptCode) y la puntuación determinista de cada caso viven en
// @hotelos/ai-core (EVAL_SUITES / getEvalSuite / scoreCase): mismo criterio que
// antes (100 si pasa, 40 si no; precio inventado = fallo) sin LLM juez, y ahora
// hay tres suites (guest_message_reply, draft_review_response,
// analyze_review_sentiment). Cada caso se ejecuta con getAiCore().complete
// (rol default, toolName runAiSafetyEvaluation) y guarda model, tokens, costEur
// y latencyMs reales; sin clave la evaluación sigue quedando `skipped`.
//
// Corrección 1 (CFC-05 / SEC-09): una evaluación gasta modelo como cualquier
// herramienta, así que pasa por las mismas puertas y deja la misma telemetría:
// organización obligatoria (sin cubo `unscoped`), aiEnabled de la propiedad,
// presupuesto mensual (antes de empezar y antes de cada caso) y UNA fila
// ai_tool_calls por caso (runAiSafetyEvaluation, coste real) con auditoría
// actorType "ai", de modo que monthToDateCostEur y el panel de coste la ven.

export const EVALUATION_TOOL_NAME = "runAiSafetyEvaluation" as const;

export async function runEvaluation(id: string): Promise<EvaluationRecord> {
  const target = await prisma.aiEvaluation.findUnique({ where: { id } });
  if (!target) throw new Error("Evaluation was not found.");

  // Honest: we no longer fabricate scores. An evaluation only produces metrics
  // when a real LLM provider is configured AND we have a test suite for the prompt.
  const suite = target.promptCode ? getEvalSuite(target.promptCode) : null;

  if (!isLlmConfigured()) {
    const updated = await prisma.aiEvaluation.update({
      where: { id: target.id },
      data: {
        status: "skipped",
        score: null,
        passRate: null,
        sampleSize: null,
        resultsJson: {
          ran: false,
          reason: "No hay proveedor de IA configurado; la evaluación no se ejecutó. Configure AI_PROVIDER + AI_PROVIDER_API_KEY.",
          checkedAt: new Date().toISOString()
        } as Prisma.InputJsonValue,
        completedAt: new Date()
      }
    });
    return mapEvaluation(updated);
  }

  if (!suite) {
    const updated = await prisma.aiEvaluation.update({
      where: { id: target.id },
      data: {
        status: "skipped",
        score: null,
        passRate: null,
        sampleSize: null,
        resultsJson: {
          ran: false,
          reason: `No hay conjunto de pruebas para el prompt "${target.promptCode ?? "(ninguno)"}". Suites disponibles: ${EVAL_PROMPT_CODES.join(", ")}.`,
          checkedAt: new Date().toISOString()
        } as Prisma.InputJsonValue,
        completedAt: new Date()
      }
    });
    return mapEvaluation(updated);
  }

  // Puertas previas (CFC-05 / SEC-09): organización, interruptor de la propiedad y presupuesto.
  const skipped = async (reason: string): Promise<EvaluationRecord> => {
    const updated = await prisma.aiEvaluation.update({
      where: { id: target.id },
      data: { status: "skipped", score: null, passRate: null, sampleSize: null, resultsJson: { ran: false, reason, checkedAt: new Date().toISOString() } as Prisma.InputJsonValue, completedAt: new Date() }
    });
    return mapEvaluation(updated);
  };
  const organizationId = target.organizationId;
  if (!organizationId) return skipped("La evaluación no tiene organización: sin ámbito de límite de peticiones ni de presupuesto no se ejecuta.");
  const propertyId = target.propertyId ?? undefined;
  const property = propertyId ? await getPropertyAiSettings(propertyId) : null;
  if (property && !property.aiEnabled) return skipped(`${labelFor("ai_disabled_for_property")}: la evaluación no se ejecutó.`);
  const budgetEur = property ? monthlyBudgetEurOf(property.configurationJson, getAiConfig().monthlyBudgetEurDefault) : getAiConfig().monthlyBudgetEurDefault;
  let spentEur = await monthToDateCostEur({ organizationId, ...(propertyId ? { propertyId } : {}) });
  const budgetAtStart = budgetStatus(spentEur, budgetEur);
  if (budgetAtStart.exceeded) return skipped(`${labelFor("budget_exceeded")} (${budgetAtStart.spentEur.toFixed(2)} € de ${budgetEur.toFixed(2)} €): la evaluación no se ejecutó.`);

  // Run the prompt against each test case with the REAL model and score the output.
  const core = getAiCore();
  const correlationId = createId("corr");
  const ctx: AiContext = {
    organizationId,
    ...(propertyId ? { propertyId } : {}),
    toolName: EVALUATION_TOOL_NAME,
    purpose: "complete",
    correlationId
  };
  const cases: Array<Record<string, unknown>> = [];
  let passCount = 0;
  let scoreSum = 0;
  let costEurTotal: number | null = 0;
  let tokensInputTotal = 0;
  let tokensOutputTotal = 0;
  /** Una fila ai_tool_calls por caso (misma telemetría que el runner) y auditoría actorType ai. */
  const recordCase = async (caseId: string, status: "succeeded" | "failed" | "skipped", telemetry: AiTelemetry | null, outputJson: Record<string, unknown>, latencyMs: number, errorMessage?: string): Promise<void> => {
    const row = await recordToolCall({
      organizationId,
      ...(propertyId ? { propertyId } : {}),
      toolName: EVALUATION_TOOL_NAME,
      status,
      inputJson: { evaluationId: target.id, promptCode: target.promptCode, caseId },
      outputJson: { ...outputJson, usage: telemetry ? { model: telemetry.model, tokensInput: telemetry.tokensInput, tokensOutput: telemetry.tokensOutput, costUsd: telemetry.costUsd, costEur: telemetry.costEur, latencyMs: telemetry.latencyMs } : null } as Prisma.InputJsonValue,
      requiredConfirmation: false,
      automationLevel: "suggest",
      latencyMs,
      ...(telemetry ? { model: telemetry.model, tokensInput: telemetry.tokensInput, tokensOutput: telemetry.tokensOutput, ...(telemetry.costEur !== null ? { costEur: telemetry.costEur } : {}) } : { tokensInput: 0, tokensOutput: 0, costEur: 0 }),
      ...(errorMessage ? { errorMessage } : {})
    });
    recordAuditEvent({
      organizationId,
      ...(propertyId ? { propertyId } : {}),
      actorType: "ai",
      action: status === "succeeded" ? "AI_TOOL_EXECUTED" : "AI_TOOL_FAILED",
      entityType: "ai_tool_call",
      entityId: row.id,
      afterJson: { toolName: EVALUATION_TOOL_NAME, evaluationId: target.id, caseId, status, model: telemetry?.model ?? null, costEur: telemetry?.costEur ?? null },
      correlationId
    });
    if (telemetry?.costEur) spentEur += telemetry.costEur;
  };
  for (let i = 0; i < suite.cases.length; i++) {
    const tc = suite.cases[i]!;
    const caseId = `case_${i + 1}`;
    const startedAt = Date.now();
    // Presupuesto re-comprobado antes de cada caso con el gasto acumulado de la propia evaluación.
    const budget = budgetStatus(spentEur, budgetEur);
    if (budget.exceeded) {
      const reason = `${labelFor("budget_exceeded")} (${budget.spentEur.toFixed(2)} € de ${budgetEur.toFixed(2)} €): caso no ejecutado.`;
      cases.push({ caseId, input: tc.input, passed: false, caseScore: 0, skipped: reason, model: null, tokensInput: null, tokensOutput: null, costEur: null, latencyMs: 0 });
      await recordCase(caseId, "skipped", null, { skipped: reason }, 0, "budget_exceeded");
      continue;
    }
    try {
      const result = await core.complete({ system: suite.system, prompt: tc.input, maxTokens: 250 }, ctx);
      const output = result.configured ? result.text : "";
      const check = scoreCase(output, tc.expect);
      if (check.passed) passCount += 1;
      scoreSum += check.score;
      const telemetry = result.configured ? result : result.telemetry ?? null;
      if (telemetry) {
        tokensInputTotal += telemetry.tokensInput;
        tokensOutputTotal += telemetry.tokensOutput;
        costEurTotal = telemetry.costEur === null || costEurTotal === null ? null : round6(costEurTotal + telemetry.costEur);
      }
      const latencyMs = telemetry?.latencyMs ?? Date.now() - startedAt;
      cases.push({
        caseId,
        input: tc.input,
        output,
        passed: check.passed,
        caseScore: check.score,
        reasons: check.reasons,
        ...(result.configured ? {} : { notConfigured: { reason: result.reason, message: result.message } }),
        model: telemetry?.model ?? null,
        tokensInput: telemetry?.tokensInput ?? null,
        tokensOutput: telemetry?.tokensOutput ?? null,
        costEur: telemetry?.costEur ?? null,
        latencyMs
      });
      await recordCase(caseId, result.configured ? "succeeded" : "failed", telemetryFromAiResult(result), { passed: check.passed, caseScore: check.score, outputChars: output.length }, latencyMs, result.configured ? undefined : `${result.reason}: ${result.message}`);
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const telemetry = isAiError(error) && error.telemetry ? error.telemetry : null;
      const message = error instanceof Error ? error.message : String(error);
      cases.push({
        caseId,
        input: tc.input,
        passed: false,
        caseScore: 0,
        error: message,
        model: telemetry?.model ?? null,
        tokensInput: telemetry?.tokensInput ?? null,
        tokensOutput: telemetry?.tokensOutput ?? null,
        costEur: telemetry?.costEur ?? null,
        latencyMs
      });
      if (telemetry) {
        tokensInputTotal += telemetry.tokensInput;
        tokensOutputTotal += telemetry.tokensOutput;
        costEurTotal = telemetry.costEur === null || costEurTotal === null ? null : round6(costEurTotal + telemetry.costEur);
      }
      await recordCase(caseId, "failed", telemetry, { error: message }, latencyMs, isAiError(error) ? `${error.code}: ${message}` : message);
    }
  }

  const sampleSize = suite.cases.length;
  const passRate = round2((passCount / sampleSize) * 100);
  const score = round2(scoreSum / sampleSize);

  const updated = await prisma.aiEvaluation.update({
    where: { id: target.id },
    data: {
      status: "completed",
      score,
      passRate,
      sampleSize,
      resultsJson: {
        ran: true,
        simulated: false,
        promptCode: target.promptCode,
        model: core.modelName(),
        generatedAt: new Date().toISOString(),
        correlationId,
        summary: { sampleSize, passCount, failCount: sampleSize - passCount, score, passRate, tokensInput: tokensInputTotal, tokensOutput: tokensOutputTotal, costEur: costEurTotal },
        cases
      } as Prisma.InputJsonValue,
      completedAt: new Date()
    }
  });
  return mapEvaluation(updated);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// -------------------------------------------------------------------------------------
// Incidents — open → investigating → resolved (and reopen).
// -------------------------------------------------------------------------------------

export type IncidentRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  incidentType: string;
  severity: string;
  title: string;
  description?: string;
  relatedAiToolCallId?: string;
  status: "open" | "investigating" | "resolved" | string;
  assignedTo?: string;
  rootCause?: string;
  resolutionNotes?: string;
  createdAt: string;
  resolvedAt?: string;
};

function mapIncident(
  row: NonNullable<Awaited<ReturnType<typeof prisma.aiIncident.findUnique>>>
): IncidentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    incidentType: row.incidentType,
    severity: row.severity,
    title: row.title,
    description: row.description ?? undefined,
    relatedAiToolCallId: row.relatedAiToolCallId ?? undefined,
    status: row.status,
    assignedTo: row.assignedTo ?? undefined,
    rootCause: row.rootCause ?? undefined,
    resolutionNotes: row.resolutionNotes ?? undefined,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString()
  };
}

export async function listIncidents(input: {
  organizationId: string;
  status?: string;
  severity?: string;
}): Promise<IncidentRecord[]> {
  const rows = await prisma.aiIncident.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.severity ? { severity: input.severity } : {})
    },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(mapIncident);
}

export async function createIncident(input: {
  organizationId: string;
  propertyId?: string;
  incidentType: string;
  severity: string;
  title: string;
  description?: string;
  relatedAiToolCallId?: string;
  assignedTo?: string;
}): Promise<IncidentRecord> {
  if (!input.title) throw new Error("title is required.");
  if (!input.incidentType) throw new Error("incidentType is required.");
  if (!input.severity) throw new Error("severity is required.");
  const created = await prisma.aiIncident.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      incidentType: input.incidentType,
      severity: input.severity,
      title: input.title,
      description: input.description ?? null,
      relatedAiToolCallId: input.relatedAiToolCallId ?? null,
      assignedTo: input.assignedTo ?? null,
      status: "open"
    }
  });
  return mapIncident(created);
}

// Assigning also moves an open incident into "investigating" so the board reflects work.
export async function assignIncident(id: string, userId: string): Promise<IncidentRecord> {
  const existing = await prisma.aiIncident.findUnique({ where: { id } });
  if (!existing) throw new Error("Incident was not found.");
  const updated = await prisma.aiIncident.update({
    where: { id },
    data: {
      assignedTo: userId,
      ...(existing.status === "open" ? { status: "investigating" } : {})
    }
  });
  return mapIncident(updated);
}

export async function resolveIncident(
  id: string,
  rootCause: string,
  resolutionNotes: string
): Promise<IncidentRecord> {
  const existing = await prisma.aiIncident.findUnique({ where: { id } });
  if (!existing) throw new Error("Incident was not found.");
  const updated = await prisma.aiIncident.update({
    where: { id },
    data: {
      status: "resolved",
      rootCause: rootCause || null,
      resolutionNotes: resolutionNotes || null,
      resolvedAt: new Date()
    }
  });
  return mapIncident(updated);
}

export async function reopenIncident(id: string): Promise<IncidentRecord> {
  const existing = await prisma.aiIncident.findUnique({ where: { id } });
  if (!existing) throw new Error("Incident was not found.");
  const updated = await prisma.aiIncident.update({
    where: { id },
    data: { status: "investigating", resolvedAt: null }
  });
  return mapIncident(updated);
}

// -------------------------------------------------------------------------------------
// Cost dashboard — aggregation over AiToolCall.
// -------------------------------------------------------------------------------------

export type CostDashboard = {
  totalCostEur: number;
  totalTokens: number;
  byTool: Array<{ toolName: string; costEur: number; tokens: number; calls: number }>;
  byModel: Array<{ model: string; costEur: number; calls: number }>;
  dailyTrend: Array<{ date: string; costEur: number; calls: number }>;
  /** Proyección a 30 días del ritmo de la ventana; null cuando no hay coste real (nunca se fabrica). */
  projectedMonthlyEur: number | null;
  /** true solo si alguna llamada de la ventana tiene modelo y cost_eur no nulos (los ceros sin modelo no cuentan). */
  hasRealCost: boolean;
  /** Presupuesto mensual por defecto de la configuración (AI_MONTHLY_BUDGET_EUR_DEFAULT). */
  budgetDefaultEur: number;
  windowDays: number;
};

export async function costDashboard(input: { organizationId: string; days?: number }): Promise<CostDashboard> {
  const days = input.days && input.days > 0 ? input.days : 30;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  const calls = await prisma.aiToolCall.findMany({
    where: { organizationId: input.organizationId, createdAt: { gte: since } },
    select: {
      toolName: true,
      model: true,
      costEur: true,
      tokensInput: true,
      tokensOutput: true,
      createdAt: true
    }
  });

  let totalCostEur = 0;
  let totalTokens = 0;
  // Tanda L6a (lote 4): coste REAL = filas con modelo y cost_eur no nulos (las de semilla sin
  // modelo y las de respaldo determinista con 0 no cuentan); sin coste real no se proyecta nada.
  let hasRealCost = false;
  const byToolMap = new Map<string, { costEur: number; tokens: number; calls: number }>();
  const byModelMap = new Map<string, { costEur: number; calls: number }>();
  const dailyMap = new Map<string, { costEur: number; calls: number }>();

  for (const call of calls) {
    const cost = dec(call.costEur);
    const tokens = (call.tokensInput ?? 0) + (call.tokensOutput ?? 0);
    totalCostEur += cost;
    totalTokens += tokens;
    if (call.model && call.costEur !== null && call.costEur !== undefined) hasRealCost = true;

    const toolKey = call.toolName || "unknown";
    const tool = byToolMap.get(toolKey) ?? { costEur: 0, tokens: 0, calls: 0 };
    tool.costEur += cost;
    tool.tokens += tokens;
    tool.calls += 1;
    byToolMap.set(toolKey, tool);

    const modelKey = call.model || "unknown";
    const model = byModelMap.get(modelKey) ?? { costEur: 0, calls: 0 };
    model.costEur += cost;
    model.calls += 1;
    byModelMap.set(modelKey, model);

    const dateKey = call.createdAt.toISOString().slice(0, 10);
    const day = dailyMap.get(dateKey) ?? { costEur: 0, calls: 0 };
    day.costEur += cost;
    day.calls += 1;
    dailyMap.set(dateKey, day);
  }

  const byTool = [...byToolMap.entries()]
    .map(([toolName, v]) => ({ toolName, costEur: round2(v.costEur), tokens: v.tokens, calls: v.calls }))
    .sort((a, b) => b.costEur - a.costEur);

  const byModel = [...byModelMap.entries()]
    .map(([model, v]) => ({ model, costEur: round2(v.costEur), calls: v.calls }))
    .sort((a, b) => b.costEur - a.costEur);

  const dailyTrend = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, costEur: round2(v.costEur), calls: v.calls }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Project the windowed run-rate out to 30 days — solo con coste real; si no, null (honesto).
  const projectedMonthlyEur = hasRealCost && days > 0 ? round2((totalCostEur / days) * 30) : null;

  return {
    totalCostEur: round2(totalCostEur),
    totalTokens,
    byTool,
    byModel,
    dailyTrend,
    projectedMonthlyEur,
    hasRealCost,
    budgetDefaultEur: getAiConfig().monthlyBudgetEurDefault,
    windowDays: days
  };
}
