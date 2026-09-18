import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
{
  for (const candidate of [resolvePath(process.cwd(), ".env"), resolvePath(process.cwd(), "../../.env")]) {
    if (!existsSync(candidate)) continue;
    for (const rawLine of readFileSync(candidate, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      // Never override what the process was started with: an orchestrator
      // (compose, systemd EnvironmentFile, CI) must always win over a stray
      // .env on disk — same rule as apps/api/src/server.ts (Tanda 4 · DATA-04).
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}
import { buildHealthResponse, SERVICE_NAMES } from "@hotelos/config";
import { describeError, getRecentJobRuns, type JobRunSummary } from "./jobs/job-runs.js";
import { getFailedSchedules, JOB_QUEUES, startScheduler } from "./scheduler.js";

// Worker honesto (Tanda L2 · L2-07).
//
// Este proceso ejecuta EXCLUSIVAMENTE las cuatro colas pg-boss declaradas en
// scheduler.ts (JOB_QUEUES): notifications.scheduled, notifications.retry,
// notifications.sending-sweep y webhooks.deliver. Cada ejecución escribe un
// WorkerJobRun (jobs/job-runs.ts) con status running → completed | failed.
//
// Responsabilidades que SIGUEN en el API como schedulers in-process (una sola
// instancia con RUN_SCHEDULERS=true; apps/api/src/server.ts y
// apps/api/src/lib/scheduler-leader.ts) y que el worker NO duplica:
//   - SES Hospedajes: reintentos y plazos de 24h del parte de viajeros.
//   - VeriFactu: reenvío de registros en "retrying" y reconciliación con la AEAT.
//   - Pace: instantánea diaria OTB por hotel (+ instantánea de night-audit).
//   - Allotment release: liberación diaria de cupos B2B vencidos.
//   - Group cut-off: liberación diaria de bloques de grupo vencidos.
//   - Mailbox: sondeo del buzón de entrada.
//   - PMS sombra: sincronización con el PMS de origen (OPERA sombra).
//   - Drain del channel manager: vaciado de la cola de sincronización.
//
// Retirado aquí en L2-07: el catálogo de 85 nombres de job sin implementación
// (respondían «completed» sin hacer nada), handleJob y sus siete handlers
// tipados sin productor (ses_hospedajes.submit, invoice.compliance.check,
// messaging.send, ota.channel_sync, bank.reconciliation.match,
// retention.delete_expired, reports.daily_briefing), tres de los cuales
// fabricaban éxito con stubs de packages/integrations, y la cola
// modelo303.aggregate (solo un console.log). La decisión de retención sigue
// viviendo en packages/compliance (shouldDeleteRetentionCandidate) y la
// consume el API.

/** Variables que, definidas, indican un proveedor real que el worker todavía no usa. */
export const STUB_PROVIDER_ENV_KEYS = ["EMAIL_PROVIDER", "TWILIO_ACCOUNT_SID", "WHATSAPP_PHONE_ID"] as const;

/**
 * Aviso único de arranque: los proveedores del worker (providers/*.ts) son
 * stubs que marcan «enviado» sin enviar. Sustituirlos por los del API es de la
 * Tanda L8; hasta entonces, si el entorno declara un proveedor real, se avisa.
 */
export function stubProviderWarning(env: NodeJS.ProcessEnv): string | null {
  const configured = STUB_PROVIDER_ENV_KEYS.filter((key) => (env[key] ?? "").trim() !== "");
  if (configured.length === 0) return null;
  return (
    `[worker] ${configured.join(", ")} definidas, pero los proveedores del worker ` +
    "(apps/worker/src/providers/*) son stubs que marcan «enviado» sin enviar: las " +
    "notificaciones programadas NO saldrán por esos canales hasta unificar los " +
    "proveedores con los del API (Tanda L8)."
  );
}

export type WorkerHealth = ReturnType<typeof buildHealthResponse> & {
  /** Pasos de setup de pg-boss fallidos en el último startScheduler() ("<paso>:<cola>"). */
  failedSchedules: readonly string[];
  /** Últimos 10 WorkerJobRun por cola (jobs/job-runs.ts), del más reciente al más antiguo. */
  lastRuns: Record<string, JobRunSummary[]>;
};

export async function getWorkerHealth(): Promise<WorkerHealth> {
  let postgres: "ok" | "degraded" = "ok";
  let lastRuns: Record<string, JobRunSummary[]> = {};
  try {
    lastRuns = await getRecentJobRuns(JOB_QUEUES, 10);
  } catch (error) {
    postgres = "degraded";
    console.error("[worker] no se pudo leer worker_job_runs para la salud:", describeError(error));
  }
  const failedSchedules = getFailedSchedules();
  return {
    ...buildHealthResponse({
      service: SERVICE_NAMES.worker,
      // Solo lo que el worker usa de verdad: Postgres (datos + esquema pgboss) y la cola.
      // La antigua salud declaraba redis "ok" (no se usa) y objectStorage
      // "unconfigured" (no se usa), lo que la dejaba siempre en "degraded".
      dependencies: {
        postgres,
        queue: failedSchedules.length > 0 ? "degraded" : "ok"
      }
    }),
    failedSchedules,
    lastRuns
  };
}

async function main(): Promise<void> {
  const warning = stubProviderWarning(process.env);
  if (warning) console.warn(warning);
  if (process.env.WORKER_AUTOSTART !== "false") {
    await startScheduler();
  }
  console.log(JSON.stringify(await getWorkerHealth()));
}

import { fileURLToPath } from "node:url";
import { resolve as resolvePath2 } from "node:path";
const __entryFile = resolvePath2(fileURLToPath(import.meta.url));
const __argFile = process.argv[1] ? resolvePath2(process.argv[1]) : "";
if (__entryFile === __argFile) {
  void main().catch((err) => {
    console.error("[worker] failed to start scheduler:", err);
    process.exit(1);
  });
}
