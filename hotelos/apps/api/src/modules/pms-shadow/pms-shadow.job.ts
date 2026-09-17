// OPERA Cloud · modo sombra · Tanda 7b · L3 · job del líder (diseño §6.5 con §10 nº 10).
//
// Vive en el API, en el bloque de schedulers de server.ts bajo `schedulerLeader`
// (isSchedulerLeader: RUN_SCHEDULERS) — apps/worker no depende de @hotelos/api y
// no puede importar los servicios del modo sombra. Patrón de
// channel-manager/drain.service.ts startChannelDeliveryDrain: setInterval con
// `unref`, flag `running` anti-solape en proceso y `stop()` para el apagado.
//
// Cada vuelta abre UNA transacción y toma
// `pg_try_advisory_xact_lock(hashtext('pms_shadow.job'))` (como el barrido
// VeriFactu de verifactu-submission.service.ts): si otra réplica lo tiene, la vuelta
// se salta (`skipped`) en vez de duplicar alertas. Dentro: perfiles activos →
// OPERA_FEED_LATE (una por feed y business date, dedupe en createAlertIfOpen) y
// runs `processing` con más de 30 minutos → `failed` «interrumpido». No sondea el
// correo (mailbox poll) ni el SFTP (cron del agente pms-shadow:pull).
//
// Lecturas de entorno (declaradas en env.partial.ts, corrección g): RUN_SCHEDULERS,
// PMS_SHADOW_JOB_DISABLED, PMS_SHADOW_JOB_INTERVAL_MS.

import { prisma } from "@hotelos/database";
import { sweepLateFeeds, type PmsShadowLateSweepResult } from "./pms-shadow.service.js";

export const PMS_SHADOW_JOB_LOCK_KEY = "pms_shadow.job";
export const PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const TX_OPTIONS = { maxWait: 5_000, timeout: 120_000 } as const;
const LOG = "[pms-shadow.job]";

export type PmsShadowJobLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLog: PmsShadowJobLogger = {
  info: (obj, msg) => console.info(msg ?? LOG, obj),
  warn: (obj, msg) => console.warn(msg ?? LOG, obj),
  error: (obj, msg) => console.error(msg ?? LOG, obj)
};

export type PmsShadowJobTickResult = PmsShadowLateSweepResult & { skipped: boolean; startedAt: string; finishedAt: string };

/** Puro: el job arranca solo en el líder (RUN_SCHEDULERS ≠ false) y sin PMS_SHADOW_JOB_DISABLED=true. */
export function shouldStartPmsShadowJob(env: NodeJS.ProcessEnv): boolean {
  return env.RUN_SCHEDULERS !== "false" && env.PMS_SHADOW_JOB_DISABLED !== "true";
}

/** Periodo del job desde el entorno (por defecto 15 min; valores no numéricos → por defecto). */
export function pmsShadowJobIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PMS_SHADOW_JOB_INTERVAL_MS ?? PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS;
}

type JobDb = Pick<typeof prisma, "$transaction">;

/**
 * Una vuelta: transacción + advisory lock (skip si no se obtiene) + barrido. `db`
 * y `now` se inyectan en los tests (stub de prisma sin base de datos).
 */
export async function runPmsShadowJobTick(options: { db?: JobDb; now?: Date; log?: PmsShadowJobLogger } = {}): Promise<PmsShadowJobTickResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const startedAt = new Date();
  const empty: PmsShadowLateSweepResult = { profiles: 0, late: 0, alertsCreated: 0, staleRuns: 0 };
  const outcome = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${PMS_SHADOW_JOB_LOCK_KEY})) AS locked`;
    if (!rows[0]?.locked) return { ...empty, skipped: true };
    const swept = await sweepLateFeeds({ db: tx, now });
    return { ...swept, skipped: false };
  }, TX_OPTIONS);
  return { ...outcome, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString() };
}

let running = false;

/**
 * Arranca el job (el integrador lo llama en el bloque de schedulers de server.ts
 * tras comprobar shouldStartPmsShadowJob). Devuelve `runNow()` (null si ya hay una
 * vuelta en curso) y `stop()`.
 */
export function startPmsShadowJob(options: { log?: PmsShadowJobLogger; intervalMs?: number } = {}): { runNow: () => Promise<PmsShadowJobTickResult | null>; stop: () => void } {
  const log = options.log ?? defaultLog;
  const intervalMs = options.intervalMs ?? PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS;
  const runNow = async (): Promise<PmsShadowJobTickResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await runPmsShadowJobTick({ log });
      if (result.skipped) log.info({ pmsShadow: result }, `${LOG} tick skipped (another replica holds the lock)`);
      else if (result.late > 0 || result.staleRuns > 0) log.warn({ pmsShadow: result }, `${LOG} tick with late feeds or stale runs`);
      else log.info({ pmsShadow: result }, `${LOG} tick`);
      return result;
    } catch (error) {
      // QC-06: un fallo del barrido se registra con contexto y no tumba el intervalo.
      log.error({ err: error instanceof Error ? error.message : String(error) }, `${LOG} tick failed`);
      return null;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref?.();
  log.info({ intervalMs }, `${LOG} enabled (every ${Math.round(intervalMs / 1000)}s · OPERA_FEED_LATE + runs interrumpidos)`);
  return { runNow, stop: () => clearInterval(timer) };
}
