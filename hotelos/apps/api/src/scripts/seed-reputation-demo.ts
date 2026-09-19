// Reputación · Tanda T8 · lote T8-H — seed de demo con reseñas FICTICIAS
// (apps/api/src/scripts/seed-reputation-demo.ts).
//
// packages/database/prisma/** es de L5: el seed vive en apps/api/src/scripts
// (precedente seed-sandbox-channels.ts) y reutiliza la guarda demo de
// packages/database/prisma/lib/demo-guard.ts pasándole un objeto de entorno
// EXPLÍCITO construido desde los flags (--allow-real / --confirm), sin leer el
// entorno del proceso (una lectura nueva en apps/api/src cambiaría el censo de
// tests/env-contract.test.mjs). El dataset es puro y determinista
// (seed-reputation-demo.dataset.ts); este fichero solo orquesta Prisma.
//
// Uso (desde apps/api):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/seed-reputation-demo.ts \
//     [--dry-run (defecto) | --apply] [--property <id>]… (defecto prop_123) \
//     [--allow-real --confirm <organizationId|propertyId>]… [--purge] \
//     [--days 180] [--reviews 90] [--seed 42] [--json]
//
// Qué escribe (--apply), por propiedad: los pasos 1-3 dentro de UNA transacción
// (fuentes, reseñas y encuestas, todo o nada) y el paso 4 (tick) DESPUÉS de
// confirmarla, sobre el cliente normal (corrección ronda 1, BD-03: el tick
// analiza, abre casos y emite eventos ReviewReceived por colas globales; dentro
// de una transacción larga un tope de tiempo lo revertía todo dejando eventos
// huérfanos):
//   1. 3 fuentes demo por createReviewSource (google api → `unavailable` «sin
//      credenciales», booking api → `unavailable` «solo connectivity
//      partners», csv → `connected`; provider `<p>_demo`, configJson.isDemo);
//      idempotente: reutiliza la fila existente por (propertyId, provider);
//   2. N reseñas FICTICIAS por upsertReviewFromNormalized (idempotente por
//      externalReference `demo:<seed>:<n>` + contentHash; topicsJson.isDemo);
//      el hash usa la referencia explícita como identidad (no autor+fecha), así
//      repetir --apply CUALQUIER día deja las 90 reseñas «sin cambios» (BD-07:
//      antes cada día cambiaba receivedAt y con él el hash → 90 `updated` y
//      re-análisis); el dataset se ancla a las 00:00 UTC del día (datasetAnchor)
//      y las filas conservan el receivedAt de la primera siembra; createdAt =
//      receivedAt para que los paneles por createdAt no cuenten todo como
//      «últimos 30 días»; el 40 % llega ya respondida (portalReply con la
//      plantilla de RulesReputationAi);
//   3. 2 encuestas «… (demo)» con 30 respuestas (responsesJson.isDemo +
//      demoRef; solo se crean las que falten);
//   4. si el módulo reputation_quality está activo, un tick runReputationSync
//      (trigger `import`, IA = RulesReputationAi → etiqueta `dictionary`) que
//      analiza las reseñas y abre los casos review_negative; el seed NUNCA
//      activa el módulo (decisión de producto: activarlo da 409
//      MODULE_DEPENDENCIES_MISSING por ai_concierge, product-modules.service.ts:87-91):
//      solo avisa si está apagado.
// Después: auditoría ReputationDemoSeeded (actor de sistema
// reputationSystemContext), flushAuditQueues e invalidación de la caché del índice.
//
// --purge --apply borra SOLO filas marcadas isDemo (guest_reviews por
// topicsJson.isDemo, review_sources por configJson.isDemo, surveys «(demo)» y
// sus respuestas por surveyId, quality_cases review_negative cuya descripción
// empieza por «[reseña:<id demo>]»); nunca deleteMany sin filtro isDemo.
//
// Guarda: propiedades fuera de la allowlist (org_123 / prop_123 / prop_canary)
// exigen --apply --allow-real --confirm <organizationId|propertyId>; la
// pertenencia de la propiedad a la organización confirmada se comprueba con
// prisma.property.findUnique. Sin ello imprime el plan (formatPlannedWrites) y
// sale con código 2 sin escribir.
//
// Exit codes: 0 ok · 1 fallo (propiedad inexistente, error de BD) · 2 flags o guarda.
// Tests (sin BD): src/scripts/__tests__/seed-reputation-demo.test.mts (importa solo el dataset).

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { formatPlannedWrites, type PlannedWrite } from "../../../../packages/database/prisma/lib/demo-guard.js";
import { RulesReputationAi } from "../modules/reputation/reputation-ai.rules.js";
import { REPUTATION_MODULE_CODE, reputationSystemContext } from "../modules/reputation/reputation-context.js";
import { getReputationSnapshot, invalidateReputationCache } from "../modules/reputation/reputation-score.service.js";
import { runReputationSync, type ReputationSyncLogger } from "../modules/reputation/reputation-sync.service.js";
import { REVIEW_ALERT_CASE_TYPE } from "../modules/reputation/review-alerts.service.js";
import { upsertReviewFromNormalized } from "../modules/reputation/review-meta.store.js";
import { createReviewSource } from "../modules/reputation/review-sources.service.js";
import {
  DEMO_DAYS_MAX,
  DEMO_DAYS_MIN,
  DEMO_DEFAULT_DAYS,
  DEMO_DEFAULT_REVIEWS,
  DEMO_DEFAULT_SEED,
  DEMO_REVIEWS_MAX,
  DEMO_REVIEWS_MIN,
  DEMO_SURVEY_SUFFIX,
  buildPurgePlan,
  buildReputationDemoDataset,
  buildSeedPlan,
  explainSeedTargets,
  type DemoDatasetStats,
  type PurgePlanCounts,
  type ReputationDemoDataset,
  type SeedTargetDecision
} from "./seed-reputation-demo.dataset.js";

export const SEED_ACTION = "seed-reputation-demo";
export const DEFAULT_PROPERTY_ID = "prop_123";
export const CORRELATION_PREFIX = "corr_reputation_demo_seed";
export const FINAL_NOTICE = "Datos ficticios: ninguna reseña procede de un portal real.";
const LOG = "[demo:seed-reputation]";
const TX_OPTIONS = { maxWait: 10_000, timeout: 600_000 } as const;

// ───────────────────────────────────────────────────────────── flags

export const SEED_FLAGS_SCHEMA = z
  .object({
    apply: z.boolean(),
    purge: z.boolean(),
    json: z.boolean(),
    allowReal: z.boolean(),
    propertyIds: z.array(z.string().trim().min(1).max(64)).min(1, "Indica al menos una propiedad (--property <id>)."),
    confirm: z.array(z.string().trim().min(1).max(64)),
    days: z.number().int().min(DEMO_DAYS_MIN).max(DEMO_DAYS_MAX),
    reviews: z.number().int().min(DEMO_REVIEWS_MIN).max(DEMO_REVIEWS_MAX),
    seed: z.number().int().min(0).max(2_147_483_647)
  })
  .strict();

export type SeedFlags = z.infer<typeof SEED_FLAGS_SCHEMA>;

const KNOWN_FLAGS = "--dry-run, --apply, --property <id> (repetible), --allow-real, --confirm <organizationId|propertyId> (repetible), --purge, --days <1-730>, --reviews <60-120>, --seed <n>, --json";

export function parseFlags(argv: readonly string[]): SeedFlags {
  const raw = { apply: false, purge: false, json: false, allowReal: false, propertyIds: [] as string[], confirm: [] as string[], days: DEMO_DEFAULT_DAYS, reviews: DEMO_DEFAULT_REVIEWS, seed: DEMO_DEFAULT_SEED };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`El flag "${arg}" necesita un valor.`);
      i += 1;
      return value;
    };
    const nextInt = (): number => {
      const value = next();
      if (!/^-?\d+$/.test(value)) throw new Error(`El flag "${arg}" espera un entero (recibido "${value}").`);
      return Number(value);
    };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") raw.apply = true;
    else if (arg === "--purge") raw.purge = true;
    else if (arg === "--json") raw.json = true;
    else if (arg === "--allow-real") raw.allowReal = true;
    else if (arg === "--property") raw.propertyIds.push(next());
    else if (arg === "--confirm") raw.confirm.push(next());
    else if (arg === "--days") raw.days = nextInt();
    else if (arg === "--reviews") raw.reviews = nextInt();
    else if (arg === "--seed") raw.seed = nextInt();
    else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Conocidos: ${KNOWN_FLAGS}.`);
  }
  if (raw.propertyIds.length === 0) raw.propertyIds.push(DEFAULT_PROPERTY_ID);
  if (sawDryRun && raw.apply) throw new Error("--dry-run y --apply son excluyentes.");
  if (raw.confirm.length > 0 && !raw.allowReal) throw new Error("--confirm solo tiene sentido junto a --allow-real.");
  const parsed = SEED_FLAGS_SCHEMA.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "flags"}: ${issue.message}`).join("; "));
  return { ...parsed.data, propertyIds: [...new Set(parsed.data.propertyIds)] };
}

// ───────────────────────────────────────────────────────────── resumen

export type SeedSourceOutcome = { code: string; id: string | null; status: string; created: boolean; reason: string | null };

export type SeedPropertySummary = {
  propertyId: string;
  propertyName: string | null;
  organizationId: string | null;
  decision: SeedTargetDecision;
  reason: string | null;
  moduleEnabled: boolean | null;
  warnings: string[];
  plan: PlannedWrite[];
  dataset: DemoDatasetStats | null;
  sources: SeedSourceOutcome[];
  reviews: { planned: number; created: number; updated: number; unchanged: number };
  surveys: { planned: number; created: number; reused: number; responsesPlanned: number; responsesCreated: number; responsesExisting: number };
  sync: { ran: boolean; analyzed: number; casesOpened: number; skippedSources: number; errors: number; correlationId: string | null } | null;
  purged: PurgePlanCounts | null;
  index30: { status: string; index: number | null; reviewCount: number } | null;
};

export type SeedSummary = {
  mode: "seed" | "purge";
  dryRun: boolean;
  seed: number;
  days: number;
  reviews: number;
  properties: SeedPropertySummary[];
  refused: boolean;
  applied: boolean;
  error?: string;
  durationMs: number;
  notice: string;
};

function emptyPropertySummary(propertyId: string): SeedPropertySummary {
  return {
    propertyId,
    propertyName: null,
    organizationId: null,
    decision: "refused",
    reason: null,
    moduleEnabled: null,
    warnings: [],
    plan: [],
    dataset: null,
    sources: [],
    reviews: { planned: 0, created: 0, updated: 0, unchanged: 0 },
    surveys: { planned: 0, created: 0, reused: 0, responsesPlanned: 0, responsesCreated: 0, responsesExisting: 0 },
    sync: null,
    purged: null,
    index30: null
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ancla temporal del dataset: las 00:00 UTC del día en curso. Las fechas de
 * las reseñas dependen de `now`; el contentHash ya no (la identidad es la
 * referencia `demo:<seed>:<n>`), así que repetir --apply otro día deja las 90
 * reseñas «sin cambios» y conserva el receivedAt de la primera siembra. El
 * tick y la auditoría usan el ahora real.
 */
export function datasetAnchor(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Filtro JSON reutilizado en cada lectura/borrado de reseñas demo: nunca un where sin él. */
const DEMO_REVIEW_FILTER = { topicsJson: { path: ["isDemo"], equals: true } } as const;
const DEMO_SOURCE_FILTER = { configJson: { path: ["isDemo"], equals: true } } as const;
const DEMO_SURVEY_FILTER = { name: { contains: DEMO_SURVEY_SUFFIX } } as const;

type Db = Prisma.TransactionClient | typeof prisma;

async function isModuleEnabled(db: Db, propertyId: string): Promise<boolean | null> {
  const module = await db.module.findFirst({ where: { code: REPUTATION_MODULE_CODE }, select: { id: true } });
  if (!module) return null;
  const row = await db.propertyModule.findFirst({ where: { moduleId: module.id, propertyId, status: "enabled" }, select: { id: true } });
  return row !== null;
}

/** Recuento (solo lectura) de lo que borraría --purge en la propiedad. */
export async function countDemoRows(db: Db, propertyId: string): Promise<PurgePlanCounts> {
  const demoReviews = await db.guestReview.findMany({ where: { propertyId, ...DEMO_REVIEW_FILTER }, select: { id: true } });
  const demoSurveys = await db.survey.findMany({ where: { propertyId, ...DEMO_SURVEY_FILTER }, select: { id: true } });
  const surveyIds = demoSurveys.map((row) => row.id);
  const [cases, responses, sources] = await Promise.all([
    demoReviews.length > 0
      ? db.qualityCase.count({ where: { propertyId, caseType: REVIEW_ALERT_CASE_TYPE, OR: demoReviews.map((row) => ({ description: { startsWith: `[reseña:${row.id}]` } })) } })
      : Promise.resolve(0),
    surveyIds.length > 0 ? db.surveyResponse.count({ where: { surveyId: { in: surveyIds } } }) : Promise.resolve(0),
    db.reviewSource.count({ where: { propertyId, ...DEMO_SOURCE_FILTER } })
  ]);
  return { quality_cases: cases, survey_responses: responses, surveys: surveyIds.length, guest_reviews: demoReviews.length, review_sources: sources };
}

/** Borra SOLO filas marcadas isDemo de la propiedad (dentro de la transacción del llamador). */
export async function purgeDemoRows(tx: Prisma.TransactionClient, propertyId: string): Promise<PurgePlanCounts> {
  const demoReviews = await tx.guestReview.findMany({ where: { propertyId, ...DEMO_REVIEW_FILTER }, select: { id: true } });
  let cases = 0;
  if (demoReviews.length > 0) {
    const deleted = await tx.qualityCase.deleteMany({
      where: { propertyId, caseType: REVIEW_ALERT_CASE_TYPE, OR: demoReviews.map((row) => ({ description: { startsWith: `[reseña:${row.id}]` } })) }
    });
    cases = deleted.count;
  }
  const demoSurveys = await tx.survey.findMany({ where: { propertyId, ...DEMO_SURVEY_FILTER }, select: { id: true } });
  const surveyIds = demoSurveys.map((row) => row.id);
  let responses = 0;
  let surveys = 0;
  if (surveyIds.length > 0) {
    responses = (await tx.surveyResponse.deleteMany({ where: { surveyId: { in: surveyIds } } })).count;
    surveys = (await tx.survey.deleteMany({ where: { id: { in: surveyIds }, propertyId, ...DEMO_SURVEY_FILTER } })).count;
  }
  const reviews = (await tx.guestReview.deleteMany({ where: { propertyId, ...DEMO_REVIEW_FILTER } })).count;
  const sources = (await tx.reviewSource.deleteMany({ where: { propertyId, ...DEMO_SOURCE_FILTER } })).count;
  return { quality_cases: cases, survey_responses: responses, surveys, guest_reviews: reviews, review_sources: sources };
}

type ApplyInput = {
  tx: Prisma.TransactionClient;
  dataset: ReputationDemoDataset;
  property: { id: string; name: string; organizationId: string };
  moduleEnabled: boolean | null;
  now: Date;
  correlationId: string;
  summary: SeedPropertySummary;
};

/** Siembra fuentes, reseñas y encuestas dentro de `tx`. El tick va aparte (runSeedTick), fuera de la transacción. */
export async function applyDataset(input: ApplyInput): Promise<void> {
  const { tx, dataset, property, now, correlationId, summary } = input;

  // 1. Fuentes demo (idempotentes por provider `<p>_demo`).
  const sourceIdByCode = new Map<string, string>();
  for (const spec of dataset.sources) {
    const existing = await tx.reviewSource.findFirst({ where: { propertyId: property.id, provider: spec.code }, orderBy: { createdAt: "asc" } });
    if (existing) {
      sourceIdByCode.set(spec.code, existing.id);
      summary.sources.push({ code: spec.code, id: existing.id, status: existing.status, created: false, reason: null });
      continue;
    }
    // Sin userId: createReviewSource audita ReviewSourceCreated con actorType `system` (como el tick).
    const dto = await createReviewSource({
      db: tx,
      propertyId: property.id,
      input: { provider: spec.provider, mode: spec.mode, displayName: spec.displayName, isDemo: true },
      actor: { organizationId: property.organizationId, correlationId },
      now
    });
    sourceIdByCode.set(spec.code, dto.id);
    summary.sources.push({ code: spec.code, id: dto.id, status: dto.status, created: true, reason: dto.lastError });
  }

  // 2. Reseñas ficticias (upsert idempotente por externalReference + contentHash).
  summary.reviews.planned = dataset.reviews.length;
  for (const review of dataset.reviews) {
    const sourceId = sourceIdByCode.get(review.source);
    const outcome = await upsertReviewFromNormalized({
      db: tx,
      propertyId: property.id,
      source: review.source,
      ...(sourceId ? { sourceId } : {}),
      sourceMode: review.sourceMode,
      item: review.item,
      now,
      externalReference: review.externalReference,
      isDemo: true
    });
    if (outcome.outcome === "created") {
      summary.reviews.created += 1;
      await tx.guestReview.update({ where: { id: outcome.id }, data: { createdAt: new Date(review.item.receivedAt) } });
    } else if (outcome.outcome === "updated") summary.reviews.updated += 1;
    else summary.reviews.unchanged += 1;
  }

  // 3. Encuestas «(demo)» y respuestas (solo las que falten por demoRef).
  summary.surveys.planned = dataset.surveys.length;
  summary.surveys.responsesPlanned = dataset.stats.surveyResponses;
  for (const survey of dataset.surveys) {
    let row = await tx.survey.findFirst({ where: { propertyId: property.id, name: survey.name }, select: { id: true } });
    if (row) summary.surveys.reused += 1;
    else {
      row = await tx.survey.create({
        data: { propertyId: property.id, name: survey.name, surveyType: survey.surveyType, questionsJson: asJson(survey.questions), active: true },
        select: { id: true }
      });
      summary.surveys.created += 1;
    }
    const existing = await tx.surveyResponse.findMany({ where: { surveyId: row.id, responsesJson: { path: ["isDemo"], equals: true } }, select: { responsesJson: true } });
    const knownRefs = new Set<string>();
    for (const entry of existing) {
      const json = entry.responsesJson;
      if (json && typeof json === "object" && !Array.isArray(json) && typeof (json as Record<string, unknown>).demoRef === "string") knownRefs.add((json as Record<string, string>).demoRef);
    }
    const missing = survey.responses.filter((response) => !knownRefs.has(response.demoRef));
    summary.surveys.responsesExisting += survey.responses.length - missing.length;
    if (missing.length > 0) {
      await tx.surveyResponse.createMany({
        data: missing.map((response) => ({ surveyId: (row as { id: string }).id, responsesJson: asJson(response.answers), score: response.score, createdAt: new Date(response.createdAt) }))
      });
      summary.surveys.responsesCreated += missing.length;
    }
  }

}

/**
 * 4. Tick de análisis + casos (solo con el módulo activo; el seed nunca lo
 * activa). Corre DESPUÉS de confirmar la transacción de applyDataset, sobre el
 * cliente normal: cada escritura se confirma por sí sola y los eventos
 * ReviewReceived que emite nunca apuntan a casos revertidos.
 */
export async function runSeedTick(input: { property: { id: string }; moduleEnabled: boolean | null; now: Date; reviewsPlanned: number; summary: SeedPropertySummary }): Promise<void> {
  const { summary } = input;
  if (input.moduleEnabled !== true) {
    summary.sync = { ran: false, analyzed: 0, casesOpened: 0, skippedSources: 0, errors: 0, correlationId: null };
    return;
  }
  const log: ReputationSyncLogger = {
    info: () => undefined,
    warn: (_obj, msg) => summary.warnings.push(`sync: ${msg ?? "aviso"}`),
    error: (_obj, msg) => summary.warnings.push(`sync: ${msg ?? "error"}`)
  };
  const tick = await runReputationSync({
    db: prisma,
    now: input.now,
    trigger: "import",
    propertyIds: [input.property.id],
    ai: new RulesReputationAi(),
    log,
    maxAnalysisPerTick: input.reviewsPlanned + 10
  });
  summary.sync = { ran: true, analyzed: tick.analyzed, casesOpened: tick.alerts, skippedSources: tick.skipped.length, errors: tick.errors.length, correlationId: tick.correlationId };
  for (const error of tick.errors) summary.warnings.push(`sync: ${error.sourceId || "propiedad"} → ${error.message}`);
}

// ───────────────────────────────────────────────────────────── orquestación

export async function runSeed(flags: SeedFlags): Promise<SeedSummary> {
  const start = Date.now();
  const now = new Date();
  const anchor = datasetAnchor(now);
  const summary: SeedSummary = {
    mode: flags.purge ? "purge" : "seed",
    dryRun: !flags.apply,
    seed: flags.seed,
    days: flags.days,
    reviews: flags.reviews,
    properties: [],
    refused: false,
    applied: false,
    durationMs: 0,
    notice: FINAL_NOTICE
  };

  try {
    // Propiedades (findUnique: la pertenencia a la organización confirmada se comprueba con la fila real).
    const properties: Array<{ id: string; name: string; organizationId: string }> = [];
    for (const propertyId of flags.propertyIds) {
      const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, name: true, organizationId: true } });
      if (!property) {
        summary.error = `La propiedad ${propertyId} no existe.`;
        summary.durationMs = Date.now() - start;
        return summary;
      }
      properties.push(property);
    }

    const decisions = explainSeedTargets({
      propertyIds: properties.map((property) => property.id),
      orgIds: properties.map((property) => property.organizationId),
      allowReal: flags.allowReal,
      confirm: flags.confirm,
      action: `${SEED_ACTION} (${summary.mode}${flags.apply ? ", --apply" : ", dry-run"})`
    });

    for (const [index, property] of properties.entries()) {
      const decision = decisions[index] as (typeof decisions)[number];
      const entry = emptyPropertySummary(property.id);
      entry.propertyName = property.name;
      entry.organizationId = property.organizationId;
      entry.decision = decision.decision;
      entry.reason = decision.reason ?? null;
      entry.moduleEnabled = await isModuleEnabled(prisma, property.id);
      if (entry.moduleEnabled !== true) {
        entry.warnings.push(
          entry.moduleEnabled === null
            ? `No existe el módulo ${REPUTATION_MODULE_CODE} en el catálogo: las reseñas se siembran, pero el bot no las analizará ni abrirá casos.`
            : `El módulo ${REPUTATION_MODULE_CODE} no está activado en ${property.id}: las reseñas se siembran, pero el bot no las analizará ni abrirá casos hasta activarlo por API (exige ai_concierge). Este seed no lo activa.`
        );
      }
      if (flags.purge) {
        entry.purged = null;
        entry.plan = buildPurgePlan({ propertyId: property.id, counts: await countDemoRows(prisma, property.id) });
      } else {
        const dataset = buildReputationDemoDataset({ propertyId: property.id, hotelName: property.name, now: anchor, days: flags.days, reviews: flags.reviews, seed: flags.seed });
        entry.dataset = dataset.stats;
        entry.plan = buildSeedPlan(dataset, entry.moduleEnabled);
      }
      if (decision.decision === "refused") summary.refused = true;
      summary.properties.push(entry);
    }

    if (summary.refused || summary.dryRun) {
      summary.durationMs = Date.now() - start;
      return summary;
    }

    const audit = await import("../modules/audit/audit.service.js");
    await audit.hydrateAuditChainFromPostgres();

    for (const [index, property] of properties.entries()) {
      const entry = summary.properties[index] as SeedPropertySummary;
      const correlationId = `${CORRELATION_PREFIX}_${flags.seed}_${property.id.slice(-6)}`;
      const context = reputationSystemContext(property.organizationId, property.id);
      if (flags.purge) {
        entry.purged = await prisma.$transaction(async (tx) => purgeDemoRows(tx, property.id), TX_OPTIONS);
        invalidateReputationCache(property.id);
        audit.recordAuditEvent({
          organizationId: property.organizationId,
          propertyId: property.id,
          actorUserId: context.userId,
          actorType: "system",
          action: "ReputationDemoPurged",
          entityType: "review_source",
          afterJson: { ...entry.purged, isDemo: true },
          correlationId
        });
        continue;
      }
      const dataset = buildReputationDemoDataset({ propertyId: property.id, hotelName: property.name, now: anchor, days: flags.days, reviews: flags.reviews, seed: flags.seed });
      await prisma.$transaction(async (tx) => applyDataset({ tx, dataset, property, moduleEnabled: entry.moduleEnabled, now, correlationId, summary: entry }), TX_OPTIONS);
      // El tick va fuera de la transacción (ya confirmada): escrituras por autocommit, eventos coherentes.
      await runSeedTick({ property, moduleEnabled: entry.moduleEnabled, now, reviewsPlanned: dataset.reviews.length, summary: entry });
      invalidateReputationCache(property.id);
      audit.recordAuditEvent({
        organizationId: property.organizationId,
        propertyId: property.id,
        actorUserId: context.userId,
        actorType: "system",
        action: "ReputationDemoSeeded",
        entityType: "review_source",
        afterJson: {
          seed: flags.seed,
          days: flags.days,
          sources: entry.sources.length,
          reviews: entry.reviews,
          surveys: entry.surveys,
          sync: entry.sync,
          isDemo: true
        },
        correlationId
      });
      const snapshot = await getReputationSnapshot({ propertyId: property.id, now, isModuleEnabled: () => entry.moduleEnabled === true, skipCache: true });
      entry.index30 = { status: snapshot.index30.status, index: snapshot.index30.index ?? null, reviewCount: snapshot.index30.reviewCount };
    }
    await audit.flushAuditQueues();
    summary.applied = true;
  } catch (error) {
    summary.error = errorMessage(error);
  }
  summary.durationMs = Date.now() - start;
  return summary;
}

// ───────────────────────────────────────────────────────────── salida

function fmtCounts(counts: PurgePlanCounts | null): string {
  if (!counts) return "—";
  return Object.entries(counts)
    .map(([table, count]) => `${table}=${count}`)
    .join(" · ");
}

export function printHuman(summary: SeedSummary): void {
  const lines: string[] = [];
  lines.push(`${LOG} ${summary.mode === "purge" ? "PURGA" : "SIEMBRA"} · ${summary.dryRun ? "DRY-RUN (nada escrito)" : summary.applied ? "APLICADO" : "NO APLICADO"} · seed ${summary.seed} · ${summary.days} días · ${summary.reviews} reseñas · ${summary.durationMs} ms`);
  for (const property of summary.properties) {
    lines.push(`  propiedad ${property.propertyId}${property.propertyName ? ` (${property.propertyName})` : ""} · org ${property.organizationId ?? "?"} · guarda: ${property.decision}${property.reason ? ` — ${property.reason}` : ""}`);
    lines.push(`    módulo ${REPUTATION_MODULE_CODE}: ${property.moduleEnabled === null ? "sin fila en el catálogo" : property.moduleEnabled ? "activo" : "APAGADO (el seed no lo activa)"}`);
    if (property.dataset) {
      const d = property.dataset;
      lines.push(`    dataset: ${d.reviews} reseñas (≥ 8,5: ${d.positive} · neutras: ${d.neutral} · < 6: ${d.negative} · respondidas: ${d.responded}) · google ${d.byProvider.google} / booking ${d.byProvider.booking} / csv ${d.byProvider.csv} · es ${d.byLanguage.es} / en ${d.byLanguage.en} / de ${d.byLanguage.de} · ${d.surveys} encuestas / ${d.surveyResponses} respuestas`);
    }
    lines.push("    plan:");
    lines.push(...formatPlannedWrites(property.plan).map((line) => `    ${line}`));
    if (property.sources.length > 0) {
      for (const source of property.sources) lines.push(`    fuente ${source.code}: ${source.created ? "creada" : "reutilizada"} · estado ${source.status}${source.reason ? ` — ${source.reason}` : ""}`);
      lines.push(`    reseñas: creadas ${property.reviews.created} · actualizadas ${property.reviews.updated} · sin cambios ${property.reviews.unchanged} (de ${property.reviews.planned})`);
      lines.push(`    encuestas: creadas ${property.surveys.created} · reutilizadas ${property.surveys.reused} · respuestas creadas ${property.surveys.responsesCreated} · ya existentes ${property.surveys.responsesExisting} (de ${property.surveys.responsesPlanned})`);
      if (property.sync) {
        lines.push(
          property.sync.ran
            ? `    tick (import, IA por reglas): analizadas ${property.sync.analyzed} · casos abiertos ${property.sync.casesOpened} · fuentes omitidas ${property.sync.skippedSources} · errores ${property.sync.errors} · ${property.sync.correlationId ?? ""}`
            : "    tick: no ejecutado (módulo apagado): sin análisis ni casos"
        );
      }
    }
    if (property.purged) lines.push(`    purgado: ${fmtCounts(property.purged)}`);
    if (property.index30) lines.push(`    índice 30 d: ${property.index30.status}${property.index30.index !== null ? ` · ${property.index30.index}/100` : ""} · ${property.index30.reviewCount} reseñas en ventana`);
    for (const warning of property.warnings) lines.push(`    WARN ${warning}`);
  }
  if (summary.error) lines.push(`  ERROR ${summary.error}`);
  if (summary.refused) lines.push("  BLOQUEADO por la guarda demo: nada escrito. Propiedades fuera de la allowlist (org_123 / prop_123 / prop_canary) exigen --apply --allow-real --confirm <organizationId|propertyId>.");
  else if (summary.dryRun) lines.push(`  Nada escrito. Repite con --apply${summary.mode === "purge" ? " --purge" : ""} para ejecutar el plan.`);
  lines.push(`  ${FINAL_NOTICE}`);
  console.log(lines.join("\n"));
}

/** Código de salida: 2 guarda/flags · 1 error · 0 ok. */
export function exitCodeFor(summary: SeedSummary): number {
  if (summary.refused) return 2;
  if (summary.error) return 1;
  return 0;
}

// CLI: solo corre cuando se invoca directamente (misma guarda que refresh-demo-dataset.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: SeedFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`${LOG} ${errorMessage(error)}`);
    process.exit(2);
  }
  runSeed(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return exitCodeFor(summary);
    })
    .then((code) => process.exit(code))
    .catch(async (error) => {
      console.error(`${LOG} fallo:`, error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
