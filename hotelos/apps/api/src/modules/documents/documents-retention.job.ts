// Documentos · job diario de retención del líder (Tanda T9 · lote T9-13;
// diseño §7.5: «job diario en el scheduler del API … → blockedAt al vencer →
// a los 12 meses purga, salvo legalHold»).
//
// Patrón de modules/reputation/reputation-sync.job.ts: vive en el API (apps/
// worker no depende de @hotelos/api y no puede importar el almacén ni la
// auditoría; tests/worker-integration-contract pina las 5 colas del worker).
// server.ts lo arranca en el bloque de schedulers cuando es líder
// (schedulerLeader) y DOCUMENT_RETENTION_JOB_DISABLED (variable del contrato
// env.partial.ts) no vale "true", para su temporizador propio y lo sustituye por
// uno que exige el lease (holdsSchedulerLease) en cada vuelta, y registra
// `stop()` en el apagado ordenado (lib/shutdown.ts).
//
// Cada vuelta toma `pg_try_advisory_xact_lock(hashtext('documents.retention'))`
// en una transacción que NO hace nada más (withAdvisoryLock de
// modules/reputation/reputation-lock.ts, helper genérico): si otra réplica lo
// tiene, la vuelta se salta (`skipped`). El barrido corre FUERA de esa
// transacción sobre el cliente normal (autocommit): cada bloqueo / purga se
// confirma por sí solo y un fallo no revierte a los demás (QC-06: los fallos
// van en `failed[]` del resultado, nunca se tragan). Sin lecturas de entorno
// en este fichero: `shouldStartDocumentsRetentionJob` es pura sobre opciones
// ya leídas por server.ts.

import { prisma } from "@hotelos/database";
import { withAdvisoryLock, type LockDb } from "../reputation/reputation-lock.js";
import { runRetentionSweep as runRetentionSweepDefault, silentRetentionLog, type RetentionLogger, type RetentionSweepInput, type RetentionSweepResult } from "./retention.service.js";

export const DOCUMENTS_RETENTION_LOCK_KEY = "documents.retention";
/** Tope de la transacción que sostiene el lock (red de seguridad, no un límite del barrido). */
export const DOCUMENTS_RETENTION_LOCK_TIMEOUT_MS = 2 * 3_600_000;
export const DOCUMENTS_RETENTION_DEFAULT_INTERVAL_MS = 86_400_000;
export const DOCUMENTS_RETENTION_MIN_INTERVAL_MS = 60_000;
const LOG = "[documents.retention.job]";

const defaultLog: RetentionLogger = {
  info: (obj, msg) => console.info(msg ?? LOG, obj),
  warn: (obj, msg) => console.warn(msg ?? LOG, obj),
  error: (obj, msg) => console.error(msg ?? LOG, obj)
};

export type DocumentsRetentionTickResult = {
  skipped: boolean;
  startedAt: string;
  finishedAt: string;
  result: RetentionSweepResult | null;
  /** La transacción que sostenía el lock expiró antes de terminar el barrido (el trabajo se conservó). */
  lockExpired?: boolean;
};

/** Puro: el job arranca solo en el líder (RUN_SCHEDULERS) y sin DOCUMENT_RETENTION_JOB_DISABLED. */
export function shouldStartDocumentsRetentionJob(options: { runSchedulers: boolean; disabled: boolean }): boolean {
  return options.runSchedulers === true && options.disabled !== true;
}

/** Periodo efectivo: valores no finitos o por debajo del mínimo vuelven al defecto (24 h). */
export function documentsRetentionIntervalMs(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= DOCUMENTS_RETENTION_MIN_INTERVAL_MS ? value : DOCUMENTS_RETENTION_DEFAULT_INTERVAL_MS;
}

export type DocumentsRetentionTickOptions = {
  db?: LockDb;
  now?: Date;
  log?: RetentionLogger;
  sweep?: (input: RetentionSweepInput) => Promise<RetentionSweepResult>;
};

/**
 * Una vuelta: advisory lock global (skip si no se obtiene) + barrido FUERA de
 * la transacción del lock. `db`, `now` y `sweep` se inyectan en los tests.
 */
export async function runDocumentsRetentionTick(options: DocumentsRetentionTickOptions = {}): Promise<DocumentsRetentionTickResult> {
  const db: LockDb = options.db ?? (prisma as LockDb);
  const log = options.log ?? silentRetentionLog;
  const sweep = options.sweep ?? runRetentionSweepDefault;
  const startedAt = new Date();
  const outcome = await withAdvisoryLock({
    db,
    key: DOCUMENTS_RETENTION_LOCK_KEY,
    timeoutMs: DOCUMENTS_RETENTION_LOCK_TIMEOUT_MS,
    log,
    run: () => sweep({ ...(options.now ? { now: options.now } : {}) })
  });
  const finishedAt = new Date().toISOString();
  if (!outcome.locked) return { skipped: true, result: null, startedAt: startedAt.toISOString(), finishedAt };
  return { skipped: false, result: outcome.result, startedAt: startedAt.toISOString(), finishedAt, ...(outcome.lockExpired ? { lockExpired: true } : {}) };
}

export type StartDocumentsRetentionJobOptions = {
  log?: RetentionLogger;
  intervalMs?: number;
  /** Ejecuta una vuelta al arrancar (por defecto true). */
  runAtBoot?: boolean;
  db?: LockDb;
  sweep?: DocumentsRetentionTickOptions["sweep"];
};

/**
 * Arranca el job. Devuelve `runNow()` (null si ya hay una vuelta en curso:
 * flag anti-solape) y `stop()`.
 */
export function startDocumentsRetentionJob(options: StartDocumentsRetentionJobOptions = {}): { runNow: () => Promise<DocumentsRetentionTickResult | null>; stop: () => void } {
  const log = options.log ?? defaultLog;
  const intervalMs = documentsRetentionIntervalMs(options.intervalMs);
  const runAtBoot = options.runAtBoot ?? true;
  let running = false;
  const runNow = async (): Promise<DocumentsRetentionTickResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await runDocumentsRetentionTick({ log, ...(options.db ? { db: options.db } : {}), ...(options.sweep ? { sweep: options.sweep } : {}) });
      if (result.skipped) log.info({ retention: result }, `${LOG} tick skipped (another replica holds the lock)`);
      else if (result.result && result.result.failed.length > 0) log.warn({ retention: result.result }, `${LOG} tick with failures`);
      else log.info({ retention: result.result }, `${LOG} tick`);
      return result;
    } catch (error) {
      // QC-06: un fallo de la vuelta se registra con contexto y no tumba el intervalo.
      log.error({ err: error instanceof Error ? error.message : String(error) }, `${LOG} tick failed`);
      return null;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref?.();
  log.info({ intervalMs, runAtBoot }, `${LOG} enabled (every ${Math.round(intervalMs / 1000)}s · bloqueo + purga + reextracción + decisión autónoma)`);
  if (runAtBoot) void runNow();
  return { runNow, stop: () => clearInterval(timer) };
}
