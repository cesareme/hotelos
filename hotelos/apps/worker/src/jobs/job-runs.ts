// Registro durable de ejecuciones del worker (Tanda L2 · L2-07 · worker honesto).
//
// Cada tick de una cola pg-boss escribe UNA fila en `worker_job_runs` (modelo
// WorkerJobRun de packages/database/prisma/schema.prisma): `running` al empezar
// (attempts = 1, startedAt, payloadJson) y `completed` (resultJson) o `failed`
// (lastError) con finishedAt al terminar. Es la fuente de verdad de la pantalla
// de jobs y del `lastRuns` que expone getWorkerHealth() (index.ts).
//
// Tenencia: las cuatro colas del worker son barridos globales (una sola consulta
// recorre todas las organizaciones), así que escriben organizationId = null y
// propertyId = null. Un productor con ámbito (un job encolado por una
// organización o un hotel concretos) debe pasar ambos identificadores.
//
// Tabla compartida: apps/api/src/modules/treasury/sepa-remittance.service.ts
// guarda las remesas SEPA en esta misma tabla con jobName
// "treasury.sepa_remittance" (lo ajusta L2-04). Por eso TODA lectura de runs
// filtra por jobName: nunca se lista la tabla entera.
//
// Límite conocido: si el proceso muere entre el create y el update final, la
// fila queda en `running` sin finishedAt; la pantalla de jobs debe mostrarlo
// como atascado (startedAt antiguo) en lugar de como éxito.
//
// Retención (corrector L2 · DP-06): cada tick escribe una fila aunque no haya
// trabajo (≈3.300 filas/día con los crons de scheduler.ts), así que pruneJobRuns
// borra por jobName los runs terminados más antiguos que la retención
// (WORKER_JOB_RUN_RETENTION_DAYS, 7 días; los `failed` se conservan 4× más).
// Nunca toca otro jobName (las remesas SEPA viven en la misma tabla).

import { prisma, type Prisma } from "@hotelos/database";

export type JobRunStatus = "running" | "completed" | "failed";

export type JobRunInput = {
  jobName: string;
  queueName: string;
  payload: unknown;
  organizationId?: string | null;
  propertyId?: string | null;
  /** Identificador del job de pg-boss (pgboss.job.id) para cruzar ambas tablas. */
  correlationId?: string | null;
};

export type JobRunContext = { runId: string; startedAt: Date };

export type JobRunSummary = {
  id: string;
  jobName: string;
  queueName: string;
  status: string;
  attempts: number;
  organizationId: string | null;
  propertyId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  lastError: string | null;
};

const MAX_ERROR_LENGTH = 2000;

/** Serializa cualquier valor a JSON de Prisma (sin undefined ni Date crudos); nunca lanza. */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return { unserializable: true, type: typeof value };
  }
}

/** Texto acotado para lastError (nombre + mensaje; sin stack para no llenar la tabla). */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

/**
 * Ejecuta `fn` dentro de un WorkerJobRun: running → completed | failed.
 * Relanza el error de `fn` (pg-boss marca el job como fallido y aplica su
 * política de reintentos); el run queda en `failed` con lastError.
 */
export async function withJobRun<T>(input: JobRunInput, fn: (ctx: JobRunContext) => Promise<T>): Promise<T> {
  const startedAt = new Date();
  const run = await prisma.workerJobRun.create({
    data: {
      jobName: input.jobName,
      queueName: input.queueName,
      organizationId: input.organizationId ?? null,
      propertyId: input.propertyId ?? null,
      correlationId: input.correlationId ?? null,
      payloadJson: toJsonValue(input.payload),
      status: "running",
      attempts: 1,
      startedAt
    },
    select: { id: true }
  });

  let result: T;
  try {
    result = await fn({ runId: run.id, startedAt });
  } catch (error) {
    try {
      await prisma.workerJobRun.update({
        where: { id: run.id },
        data: { status: "failed", lastError: describeError(error), finishedAt: new Date() }
      });
    } catch (updateError) {
      console.error(`[job-runs] no se pudo cerrar como failed el run ${run.id} (${input.jobName})`, updateError);
    }
    throw error;
  }

  try {
    await prisma.workerJobRun.update({
      where: { id: run.id },
      data: { status: "completed", resultJson: toJsonValue(result), lastError: null, finishedAt: new Date() }
    });
  } catch (updateError) {
    // El trabajo ya se hizo: no se relanza (pg-boss lo repetiría). La fila queda
    // en `running` y lo delata la pantalla de jobs; se registra para forenses.
    console.error(`[job-runs] no se pudo cerrar como completed el run ${run.id} (${input.jobName})`, updateError);
  }
  return result;
}

export type PruneJobRunsInput = {
  jobName: string;
  /** Se borran los `completed` creados antes de esta fecha. */
  completedBefore: Date;
  /** Se borran los `failed` creados antes de esta fecha (por defecto, los mismos que completed). */
  failedBefore?: Date;
};

/**
 * Retención por jobName: borra los runs `completed` anteriores a
 * `completedBefore` y los `failed` anteriores a `failedBefore`; devuelve
 * cuántas filas se borraron. Nunca borra `running` (un run atascado debe
 * verse) ni otro jobName (tabla compartida con treasury.sepa_remittance).
 */
export async function pruneJobRuns(input: PruneJobRunsInput): Promise<number> {
  const completed = await prisma.workerJobRun.deleteMany({
    where: { jobName: input.jobName, status: "completed", createdAt: { lt: input.completedBefore } }
  });
  const failed = await prisma.workerJobRun.deleteMany({
    where: { jobName: input.jobName, status: "failed", createdAt: { lt: input.failedBefore ?? input.completedBefore } }
  });
  return completed.count + failed.count;
}

/**
 * Últimos `perJob` runs de cada jobName indicado (por defecto 10), del más
 * reciente al más antiguo. Siempre filtra por jobName (tabla compartida).
 */
export async function getRecentJobRuns(jobNames: readonly string[], perJob = 10): Promise<Record<string, JobRunSummary[]>> {
  const out: Record<string, JobRunSummary[]> = {};
  for (const jobName of jobNames) {
    const rows = await prisma.workerJobRun.findMany({
      where: { jobName },
      orderBy: { createdAt: "desc" },
      take: perJob,
      select: {
        id: true,
        jobName: true,
        queueName: true,
        status: true,
        attempts: true,
        organizationId: true,
        propertyId: true,
        startedAt: true,
        finishedAt: true,
        lastError: true
      }
    });
    out[jobName] = rows.map((row) => ({
      ...row,
      durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null
    }));
  }
  return out;
}
