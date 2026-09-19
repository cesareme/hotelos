// Contrato del worker (Tanda L2 · L2-07 · worker honesto).
//
// El worker ejecuta exactamente cinco colas pg-boss reales y escribe un
// WorkerJobRun por ejecución. El antiguo catálogo de 85 nombres sin
// implementación, handleJob y sus siete handlers tipados sin productor
// (ses_hospedajes.submit, invoice.compliance.check, messaging.send,
// ota.channel_sync, bank.reconciliation.match, retention.delete_expired,
// reports.daily_briefing) se retiraron; los adapters de packages/integrations
// siguen exportados para el API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const worker = read("apps/worker/src/index.ts");
const scheduler = read("apps/worker/src/scheduler.ts");
const jobRuns = read("apps/worker/src/jobs/job-runs.ts");
const reputationMaintenanceJob = read("apps/worker/src/jobs/reputation-maintenance.job.ts");
const workerPackage = JSON.parse(read("apps/worker/package.json"));
const integrationsIndex = read("packages/integrations/src/index.ts");
const schema = read("packages/database/prisma/schema.prisma");
const deploymentDoc = read("docs/deployment.md");
const compose = read("deploy/docker-compose.production.yml");

const WORKER_QUEUES = ["notifications.scheduled", "notifications.retry", "notifications.sending-sweep", "webhooks.deliver", "reputation.maintenance"];
const escape = (name) => name.replaceAll(".", "\\.");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("Worker integration contract", () => {
  it("exports integration adapters for messaging, channels, and bank reconciliation", () => {
    assert.match(integrationsIndex, /messaging\.js/);
    assert.match(integrationsIndex, /channel-manager\.js/);
    assert.match(integrationsIndex, /bank-reconciliation\.js/);
  });

  it("has a durable worker job run table", () => {
    assert.match(schema, /model WorkerJobRun/);
    assert.match(schema, /@@map\("worker_job_runs"\)/);
    assert.match(schema, /payloadJson\s+Json/);
    assert.match(schema, /resultJson\s+Json\?/);
    assert.match(schema, /lastError\s+String\?/);
  });

  it("runs exactly the five real pg-boss queues, each with boss.work and boss.schedule", () => {
    const union = scheduler.match(/export type JobQueueName =([\s\S]*?);/)?.[1] ?? "";
    const members = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(members, [...WORKER_QUEUES].sort());
    for (const queue of WORKER_QUEUES) {
      if (queue === "reputation.maintenance") {
        // Registrada por jobs/reputation-maintenance.job.ts (registerReputationMaintenanceQueue), con la misma forma.
        assert.match(scheduler, /registerReputationMaintenanceQueue\(boss/, `${queue}: registrada desde scheduler.ts`);
        assert.match(reputationMaintenanceJob, /const queue = REPUTATION_MAINTENANCE_QUEUE;/, `${queue}: nombre de la cola`);
        assert.match(reputationMaintenanceJob, /boss\.work\(queue, \{ batchSize: 1 \}/, `${queue}: boss.work`);
        assert.match(reputationMaintenanceJob, /boss\.schedule\(queue, options\.cron \?\? REPUTATION_MAINTENANCE_CRON/, `${queue}: boss.schedule`);
        assert.match(reputationMaintenanceJob, /await withJobRun\(\{ jobName: queue, queueName: queue/, `${queue}: withJobRun`);
        continue;
      }
      assert.match(scheduler, new RegExp(`boss\\.work\\(\\s*"${escape(queue)}"`), `${queue}: boss.work`);
      assert.match(scheduler, new RegExp(`boss\\.schedule\\("${escape(queue)}", "[^"]+"`), `${queue}: boss.schedule`);
      assert.match(scheduler, new RegExp(`tick\\("${escape(queue)}"`), `${queue}: withJobRun`);
    }
    assert.doesNotMatch(scheduler, /boss\.work\(\s*"modelo303\.aggregate"/);
    assert.match(scheduler, /boss\.unschedule\("verifactu\.retry"\)/);
    assert.match(scheduler, /boss\.unschedule\("modelo303\.aggregate"\)/);
  });

  it("retired the empty catalogue and the producer-less handlers", () => {
    assert.doesNotMatch(worker, /export (const|type|async function|function) (ADVANCED_WORKER_JOB_NAMES|AdvancedWorkerJob|AdvancedWorkerJobName|WorkerJob|handleJob)\b/);
    assert.doesNotMatch(worker, /handleAdvancedJob|handleSesHospedajesSubmit|handleRetentionDeleteExpired|handleDailyBriefing/);
    assert.doesNotMatch(worker, /from "@hotelos\/(integrations|compliance)"/);
    for (const file of walk(fileURLToPath(new URL("../apps/worker/src", import.meta.url)))) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /scaffolded/, `${file} still returns scaffolded`);
    }
    // Dependencies stay (removing one rewrites pnpm-lock.yaml); retention-policy-contract pins @hotelos/compliance.
    assert.equal(workerPackage.dependencies["@hotelos/integrations"], "workspace:*");
  });

  it("records one WorkerJobRun per execution: running → completed | failed", () => {
    assert.match(jobRuns, /export async function withJobRun/);
    assert.match(jobRuns, /prisma\.workerJobRun\.create\(/);
    assert.match(jobRuns, /status: "running"/);
    assert.match(jobRuns, /attempts: 1/);
    assert.match(jobRuns, /status: "completed", resultJson/);
    assert.match(jobRuns, /status: "failed", lastError: describeError\(error\), finishedAt/);
    // Shared table: every read filters by jobName (treasury.sepa_remittance lives here too).
    assert.match(jobRuns, /where: \{ jobName \}/);
    assert.match(jobRuns, /treasury\.sepa_remittance/);
    assert.match(scheduler, /await withJobRun\(\{ jobName: queue, queueName: queue, payload: job\.data \?\? \{\}, correlationId: job\.id \}, run\)/);
    assert.match(worker, /lastRuns/);
    assert.match(worker, /failedSchedules/);
    assert.match(worker, /getRecentJobRuns\(JOB_QUEUES, 10\)/);
  });

  it("never runs the API in-process schedulers (RUN_SCHEDULERS=false, pg-boss schedule unique per name)", () => {
    const workerBlock = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  admin-web:"));
    assert.match(workerBlock, /RUN_SCHEDULERS: "false"/);
    // Postgres reserves "pg_*" schema names (42939): the old schema: "pg_boss" never booted.
    assert.match(scheduler, /schema: "pgboss"/);
    assert.doesNotMatch(scheduler, /schema: "pg_boss"/);
    assert.match(scheduler, /pgboss\.schedule/);
    assert.match(scheduler, /PRIMARY KEY \(name\)/);
    assert.match(scheduler, /SKIP LOCKED/);
    assert.doesNotMatch(worker, /^import .* from "(\.\.\/)+api\//m);
    for (const responsibility of ["SES Hospedajes", "VeriFactu", "Pace", "Allotment release", "Group cut-off", "Mailbox", "PMS sombra", "Drain del channel manager"]) {
      assert.match(worker, new RegExp(responsibility), `index.ts documents that ${responsibility} stays in the API`);
    }
  });

  it("warns once at boot when a real provider is configured but the worker still ships stubs (L8)", () => {
    assert.match(worker, /STUB_PROVIDER_ENV_KEYS = \["EMAIL_PROVIDER", "TWILIO_ACCOUNT_SID", "WHATSAPP_PHONE_ID"\]/);
    assert.match(worker, /export function stubProviderWarning/);
    assert.match(worker, /if \(warning\) console\.warn\(warning\);/);
  });

  it("has a unit test gate for the worker", () => {
    assert.equal(workerPackage.scripts.test, 'node --import tsx --test "src/**/__tests__/*.test.ts"');
    const tests = readdirSync(fileURLToPath(new URL("../apps/worker/src/__tests__", import.meta.url))).sort();
    assert.deepEqual(tests, ["catalog.test.ts", "job-runs.test.ts", "notification-dispatcher.test.ts"]);
  });

  it("documents each scheduled worker responsibility", () => {
    for (const queue of WORKER_QUEUES) {
      assert.match(deploymentDoc, new RegExp(`\`${escape(queue)}\``));
    }
    assert.match(deploymentDoc, /worker_job_runs/);
    assert.match(deploymentDoc, /running/);
    assert.match(deploymentDoc, /last_error/);
    assert.match(deploymentDoc, /RUN_SCHEDULERS=false/);
    assert.match(deploymentDoc, /corepack pnpm --filter @hotelos\/worker test/);
    assert.match(deploymentDoc, /pgboss\.schedule/);
    assert.doesNotMatch(deploymentDoc, /FROM pg_boss\./, "the doc must not query the reserved pg_boss schema");
    assert.doesNotMatch(deploymentDoc, /registra cada intento/);
    assert.doesNotMatch(deploymentDoc, /modelo303\.aggregate`: /);
  });
});
