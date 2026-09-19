// Reputación · Tanda T8 · lote T8-C — job diario del líder
// (apps/api/src/modules/reputation/reputation-sync.job.ts).
//
// Patrón de modules/pms-shadow/pms-shadow.job.ts:1-100: vive en el API, en el
// bloque de schedulers de server.ts bajo `schedulerLeader` (apps/worker no
// depende de @hotelos/api y no puede importar los colectores, la IA ni la
// auditoría). NO está registrado en server.ts: el integrador añade el bloque
// entre :8804 y :8805 (patrón :8665-8687 / :8789-8804) con
// shouldStartReputationSyncJob({ runSchedulers, disabled }) y
// startReputationSyncJob({ log, intervalMs, runAtBoot, collectorOptions }).
//
// Cada vuelta toma `pg_try_advisory_xact_lock(hashtext('reputation.sync'))` en
// una transacción que NO hace nada más (reputation-lock.ts): si otra réplica lo
// tiene, la vuelta se salta (`skipped`). El tick corre FUERA de esa transacción,
// sobre el cliente normal (autocommit): antes iba dentro con `db: tx` y un tope
// de 300 s, y al expirar Prisma revertía reseñas, ejecuciones y casos de todas
// las propiedades mientras los eventos ReviewReceived ya emitidos quedaban
// huérfanos (corrección ronda 1, BD-03). Además cada propiedad corre bajo su
// lock `reputation.sync:<propertyId>` (withPropertyLock), el mismo que toman la
// sincronización manual y la importación CSV (reputation.routes.ts): quien no
// lo obtiene se salta (job) o responde 409 REPUTATION_SYNC_BUSY (rutas).
//
// Sin lecturas de entorno en este fichero: shouldStartReputationSyncJob es
// pura sobre opciones ya leídas del contrato (env.partial.ts) por server.ts,
// a diferencia del patrón pms-shadow que recibía NodeJS.ProcessEnv.

import { prisma } from "@hotelos/database";
import type { CollectorOptions, FetchLike } from "./collectors/index.js";
import type { ReputationAiPort } from "./reputation-ai.port.js";
import { REPUTATION_PROPERTY_LOCK_TIMEOUT_MS, REPUTATION_SYNC_LOCK_KEY, REPUTATION_SYNC_LOCK_TIMEOUT_MS, reputationPropertyLockKey, withAdvisoryLock, type LockDb } from "./reputation-lock.js";
import { runReputationSync, silentReputationLog, type ReputationSyncLogger, type ReputationSyncTickSummary } from "./reputation-sync.service.js";
import type { ReputationDb } from "./review-meta.store.js";

export { REPUTATION_SYNC_LOCK_KEY } from "./reputation-lock.js";
export const REPUTATION_SYNC_DEFAULT_INTERVAL_MS = 86_400_000;
export const REPUTATION_SYNC_MIN_INTERVAL_MS = 60_000;
const LOG = "[reputation.sync.job]";

const defaultLog: ReputationSyncLogger = {
  info: (obj, msg) => console.info(msg ?? LOG, obj),
  warn: (obj, msg) => console.warn(msg ?? LOG, obj),
  error: (obj, msg) => console.error(msg ?? LOG, obj)
};

export type ReputationSyncJobTickResult = {
  skipped: boolean;
  startedAt: string;
  finishedAt: string;
  summary: ReputationSyncTickSummary | null;
  /** La transacción que sostenía el lock global expiró antes de terminar el tick (el trabajo se conservó). */
  lockExpired?: boolean;
};

/** Puro: el job arranca solo en el líder (RUN_SCHEDULERS) y sin el interruptor de desactivación. */
export function shouldStartReputationSyncJob(options: { runSchedulers: boolean; disabled: boolean }): boolean {
  return options.runSchedulers === true && options.disabled !== true;
}

/** Periodo efectivo: valores no finitos o por debajo del mínimo vuelven al defecto (24 h). */
export function reputationSyncIntervalMs(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= REPUTATION_SYNC_MIN_INTERVAL_MS ? value : REPUTATION_SYNC_DEFAULT_INTERVAL_MS;
}

/** Cliente del job: `$transaction` para los locks y los modelos del tick (autocommit). El singleton prisma lo cumple. */
export type JobDb = LockDb & ReputationDb;

export type ReputationSyncJobOptions = {
  db?: JobDb;
  now?: Date;
  log?: ReputationSyncLogger;
  ai?: ReputationAiPort;
  fetchImpl?: FetchLike;
  collectorOptions?: CollectorOptions;
  maxAnalysisPerTick?: number;
};

/**
 * Una vuelta: advisory lock global (skip si no se obtiene) + tick FUERA de la
 * transacción del lock, con lock por propiedad. `db` y `now` se inyectan en los
 * tests (stub de prisma sin base de datos).
 */
export async function runReputationSyncJobTick(options: ReputationSyncJobOptions = {}): Promise<ReputationSyncJobTickResult> {
  const db: JobDb = options.db ?? (prisma as JobDb);
  const now = options.now ?? new Date();
  const log = options.log ?? silentReputationLog;
  const startedAt = new Date();
  const outcome = await withAdvisoryLock({
    db,
    key: REPUTATION_SYNC_LOCK_KEY,
    timeoutMs: REPUTATION_SYNC_LOCK_TIMEOUT_MS,
    log,
    run: () =>
      runReputationSync({
        db,
        now,
        trigger: "scheduler",
        log,
        withPropertyLock: (propertyId, run) => withAdvisoryLock({ db, key: reputationPropertyLockKey(propertyId), timeoutMs: REPUTATION_PROPERTY_LOCK_TIMEOUT_MS, log, run }),
        ...(options.ai ? { ai: options.ai } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.collectorOptions ? { collectorOptions: options.collectorOptions } : {}),
        ...(options.maxAnalysisPerTick !== undefined ? { maxAnalysisPerTick: options.maxAnalysisPerTick } : {})
      })
  });
  const finishedAt = new Date().toISOString();
  if (!outcome.locked) return { skipped: true, summary: null, startedAt: startedAt.toISOString(), finishedAt };
  return { skipped: false, summary: outcome.result, startedAt: startedAt.toISOString(), finishedAt, ...(outcome.lockExpired ? { lockExpired: true } : {}) };
}

export type StartReputationSyncJobOptions = {
  log?: ReputationSyncLogger;
  intervalMs?: number;
  /** Ejecuta una vuelta al arrancar (REPUTATION_SYNC_RUN_AT_BOOT, por defecto true). */
  runAtBoot?: boolean;
  db?: JobDb;
  ai?: ReputationAiPort;
  fetchImpl?: FetchLike;
  collectorOptions?: CollectorOptions;
  maxAnalysisPerTick?: number;
};

/**
 * Arranca el job (el integrador lo llama en el bloque de schedulers de
 * server.ts tras comprobar shouldStartReputationSyncJob). Devuelve `runNow()`
 * (null si ya hay una vuelta en curso: flag anti-solape) y `stop()`.
 */
export function startReputationSyncJob(options: StartReputationSyncJobOptions = {}): { runNow: () => Promise<ReputationSyncJobTickResult | null>; stop: () => void } {
  const log = options.log ?? defaultLog;
  const intervalMs = reputationSyncIntervalMs(options.intervalMs);
  const runAtBoot = options.runAtBoot ?? true;
  let running = false;
  const runNow = async (): Promise<ReputationSyncJobTickResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await runReputationSyncJobTick({
        log,
        ...(options.db ? { db: options.db } : {}),
        ...(options.ai ? { ai: options.ai } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.collectorOptions ? { collectorOptions: options.collectorOptions } : {}),
        ...(options.maxAnalysisPerTick !== undefined ? { maxAnalysisPerTick: options.maxAnalysisPerTick } : {})
      });
      if (result.skipped) log.info({ reputation: result }, `${LOG} tick skipped (another replica holds the lock)`);
      else if (result.summary && result.summary.errors.length > 0) log.warn({ reputation: result.summary }, `${LOG} tick with source errors`);
      else log.info({ reputation: result.summary }, `${LOG} tick`);
      return result;
    } catch (error) {
      // QC-06: un fallo del tick se registra con contexto y no tumba el intervalo.
      log.error({ err: error instanceof Error ? error.message : String(error) }, `${LOG} tick failed`);
      return null;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref?.();
  log.info({ intervalMs, runAtBoot }, `${LOG} enabled (every ${Math.round(intervalMs / 1000)}s · sync + análisis + alertas + purga)`);
  if (runAtBoot) void runNow();
  return { runNow, stop: () => clearInterval(timer) };
}
