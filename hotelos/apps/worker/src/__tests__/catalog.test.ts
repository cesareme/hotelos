// Contrato del catálogo honesto del worker (Tanda L2 · L2-07).
//
// El catálogo son las colas de JOB_QUEUES (scheduler.ts): cada una tiene un
// boss.work, un boss.schedule y corre dentro de withJobRun. No queda ningún
// handler sin implementación ni el catálogo de 85 nombres que respondía
// «completed» sin hacer nada, y index.ts ya no exporta handleJob.
//
// Sin base de datos: se lee el fuente y se importan los módulos (importar
// index.ts no arranca nada: el autostart solo salta cuando es el entrypoint).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import * as worker from "../index.js";
import { JOB_QUEUES } from "../scheduler.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const schedulerSource = readFileSync(join(SRC, "scheduler.ts"), "utf8");
const indexSource = readFileSync(join(SRC, "index.ts"), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") sourceFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const escape = (name: string): string => name.replaceAll(".", "\\.");

describe("catálogo honesto del worker", () => {
  it("declara exactamente las cuatro colas pg-boss reales", () => {
    assert.deepEqual([...JOB_QUEUES].sort(), [
      "notifications.retry",
      "notifications.scheduled",
      "notifications.sending-sweep",
      "webhooks.deliver"
    ]);
    // modelo303.aggregate solo aparece en el boss.unschedule que limpia crons huérfanos.
    assert.equal((JOB_QUEUES as readonly string[]).includes("modelo303.aggregate"), false);
    assert.doesNotMatch(schedulerSource, /boss\.work\(\s*"modelo303\.aggregate"/);
  });

  it("cada cola tiene boss.work, boss.schedule y corre dentro de withJobRun", () => {
    for (const queue of JOB_QUEUES) {
      assert.match(schedulerSource, new RegExp(`boss\\.work\\(\\s*"${escape(queue)}"`), `${queue}: boss.work`);
      assert.match(schedulerSource, new RegExp(`boss\\.schedule\\("${escape(queue)}", "[^"]+"`), `${queue}: boss.schedule`);
      assert.match(schedulerSource, new RegExp(`tick\\("${escape(queue)}"`), `${queue}: tick → withJobRun`);
    }
    assert.match(schedulerSource, /await withJobRun\(\{ jobName: queue, queueName: queue/);
  });

  it("ningún fichero del worker devuelve un resultado scaffold", () => {
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /scaffold/, `${relative(SRC, file)} contiene un resultado scaffold`);
    }
  });

  it("index.ts no exporta ADVANCED_WORKER_JOB_NAMES ni handleJob ni importa @hotelos/integrations", () => {
    assert.equal(Object.hasOwn(worker, "ADVANCED_WORKER_JOB_NAMES"), false);
    assert.equal(Object.hasOwn(worker, "handleJob"), false);
    assert.doesNotMatch(indexSource, /@hotelos\/integrations/);
    assert.doesNotMatch(indexSource, /handleAdvancedJob|AdvancedWorkerJob/);
  });

  it("getWorkerHealth expone failedSchedules y los últimos runs por cola", async () => {
    const runs = prisma.workerJobRun as unknown as { findMany: (args: unknown) => Promise<unknown[]> };
    const original = runs.findMany;
    const seen: Array<{ where?: { jobName?: string }; take?: number }> = [];
    runs.findMany = async (args: unknown) => {
      seen.push(args as { where?: { jobName?: string }; take?: number });
      return [];
    };
    try {
      const health = await worker.getWorkerHealth();
      assert.equal(health.service, "hotelos-worker");
      assert.equal(health.status, "ok");
      assert.deepEqual(health.failedSchedules, []);
      assert.deepEqual(Object.keys(health.lastRuns).sort(), [...JOB_QUEUES].sort());
      assert.deepEqual(
        seen.map((call) => call.where?.jobName),
        [...JOB_QUEUES],
        "cada lectura de runs filtra por jobName (tabla compartida con treasury.sepa_remittance)"
      );
      assert.ok(seen.every((call) => call.take === 10), "últimos 10 por cola");
    } finally {
      runs.findMany = original;
    }
  });

  it("avisa una sola vez si hay un proveedor real definido y el worker sigue con stubs", () => {
    assert.equal(worker.stubProviderWarning({}), null);
    assert.equal(worker.stubProviderWarning({ EMAIL_PROVIDER: "   " }), null);
    const warning = worker.stubProviderWarning({ EMAIL_PROVIDER: "postmark", WHATSAPP_PHONE_ID: "123" });
    assert.ok(warning);
    assert.match(warning, /EMAIL_PROVIDER, WHATSAPP_PHONE_ID/);
    assert.match(warning, /stubs/);
    assert.doesNotMatch(warning, /TWILIO_ACCOUNT_SID/);
    assert.match(indexSource, /console\.warn\(warning\)/);
  });
});
