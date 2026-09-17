// Unit tests · Tanda 7b · L3 — job del líder (pms-shadow.job.ts): arranque solo con
// RUN_SCHEDULERS ≠ false y sin PMS_SHADOW_JOB_DISABLED=true; una vuelta con un stub de
// prisma: sin advisory lock → skipped; con lock → OPERA_FEED_LATE por feed required sin
// run y runs `processing` estancados → failed. Sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/pms-shadow/__tests__/pms-shadow-job.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { prisma } from "@hotelos/database";
import { DEFAULT_PMS_SHADOW_SCHEDULE } from "../pms-shadow.rules.js";
import { PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS, PMS_SHADOW_JOB_LOCK_KEY, pmsShadowJobIntervalMs, runPmsShadowJobTick, shouldStartPmsShadowJob, startPmsShadowJob } from "../pms-shadow.job.js";

type Stub = {
  db: Pick<typeof prisma, "$transaction">;
  calls: string[];
  created: Array<Record<string, unknown>>;
};

/** Stub mínimo de prisma: $transaction ejecuta el callback con un «tx» en memoria. */
function stubPrisma(options: { locked: boolean; profiles?: Array<Record<string, unknown>>; runs?: Array<Record<string, unknown>>; staleCount?: number }): Stub {
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`queryRaw:${strings.join("?")}:${values.join(",")}`);
      return [{ locked: options.locked }];
    },
    pmsShadowProfile: {
      findMany: async () => {
        calls.push("profile.findMany");
        return options.profiles ?? [];
      }
    },
    property: {
      findMany: async () => {
        calls.push("property.findMany");
        return (options.profiles ?? []).map((profile) => ({ id: profile.propertyId, timezone: "Europe/Madrid" }));
      }
    },
    pmsShadowRun: {
      findMany: async () => {
        calls.push("run.findMany");
        return options.runs ?? [];
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        calls.push(`run.updateMany:${String(args.data.status)}`);
        return { count: options.staleCount ?? 0 };
      }
    },
    pmsShadowAlert: {
      findFirst: async () => {
        calls.push("alert.findFirst");
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push("alert.create");
        created.push(args.data);
        return { id: `alert_${created.length}`, ...args.data };
      }
    }
  };
  const db = {
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx)
  } as unknown as Pick<typeof prisma, "$transaction">;
  return { db, calls, created };
}

describe("shouldStartPmsShadowJob / pmsShadowJobIntervalMs (puros)", () => {
  it("RUN_SCHEDULERS=false → no arranca; PMS_SHADOW_JOB_DISABLED=true → no arranca; por defecto sí", () => {
    assert.equal(shouldStartPmsShadowJob({ RUN_SCHEDULERS: "false" }), false);
    assert.equal(shouldStartPmsShadowJob({ RUN_SCHEDULERS: "false", PMS_SHADOW_JOB_DISABLED: "false" }), false);
    assert.equal(shouldStartPmsShadowJob({ PMS_SHADOW_JOB_DISABLED: "true" }), false);
    assert.equal(shouldStartPmsShadowJob({ RUN_SCHEDULERS: "true", PMS_SHADOW_JOB_DISABLED: "true" }), false);
    assert.equal(shouldStartPmsShadowJob({}), true);
    assert.equal(shouldStartPmsShadowJob({ RUN_SCHEDULERS: "true" }), true);
    assert.equal(shouldStartPmsShadowJob({ PMS_SHADOW_JOB_DISABLED: "false" }), true);
  });

  it("intervalo: por defecto 15 min; valores inválidos o < 10 s vuelven al defecto", () => {
    assert.equal(PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS, 15 * 60 * 1000);
    assert.equal(pmsShadowJobIntervalMs({}), PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS);
    assert.equal(pmsShadowJobIntervalMs({ PMS_SHADOW_JOB_INTERVAL_MS: "60000" }), 60_000);
    assert.equal(pmsShadowJobIntervalMs({ PMS_SHADOW_JOB_INTERVAL_MS: "abc" }), PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS);
    assert.equal(pmsShadowJobIntervalMs({ PMS_SHADOW_JOB_INTERVAL_MS: "5" }), PMS_SHADOW_JOB_DEFAULT_INTERVAL_MS);
  });
});

describe("runPmsShadowJobTick — advisory lock y barrido", () => {
  it("sin lock (otra réplica lo tiene) → skipped, sin tocar perfiles ni runs", async () => {
    const stub = stubPrisma({ locked: false });
    const result = await runPmsShadowJobTick({ db: stub.db, now: new Date("2026-09-17T07:30:00Z") });
    assert.equal(result.skipped, true);
    assert.deepEqual([result.profiles, result.late, result.alertsCreated, result.staleRuns], [0, 0, 0, 0]);
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0]!, /pg_try_advisory_xact_lock\(hashtext\(\?\)\)/);
    assert.match(stub.calls[0]!, new RegExp(PMS_SHADOW_JOB_LOCK_KEY));
    assert.equal(PMS_SHADOW_JOB_LOCK_KEY, "pms_shadow.job");
  });

  it("con lock y sin perfiles → nada tardío; los runs estancados se cierran igualmente", async () => {
    const stub = stubPrisma({ locked: true, staleCount: 2 });
    const result = await runPmsShadowJobTick({ db: stub.db, now: new Date("2026-09-17T07:30:00Z") });
    assert.equal(result.skipped, false);
    assert.deepEqual([result.profiles, result.late, result.alertsCreated, result.staleRuns], [0, 0, 0, 2]);
    assert.ok(stub.calls.includes("run.updateMany:failed"));
    assert.ok(!stub.calls.includes("run.findMany"), "sin perfiles no se consultan runs");
  });

  it("perfil activo a las 09:30 de Madrid sin ficheros → OPERA_FEED_LATE por feed required (arrivals hoy; departures y revenue ayer), una alerta por feed", async () => {
    // El run de departures llegó con el business date de AYER (offset −1 por defecto, SC-07): no es tardío.
    const stub = stubPrisma({ locked: true, profiles: [{ organizationId: "org_1", propertyId: "prop_ra", scheduleJson: DEFAULT_PMS_SHADOW_SCHEDULE }], runs: [{ propertyId: "prop_ra", feed: "departures", businessDate: new Date("2026-09-16T00:00:00Z") }] });
    const result = await runPmsShadowJobTick({ db: stub.db, now: new Date("2026-09-17T07:30:00Z") });
    assert.equal(result.skipped, false);
    assert.deepEqual([result.profiles, result.late, result.alertsCreated, result.staleRuns], [1, 2, 2, 0]);
    assert.deepEqual(
      stub.created.map((alert) => [alert.code, alert.propertyId, alert.organizationId, (alert.businessDate as Date).toISOString().slice(0, 10), (alert.expectedJson as { feed: string }).feed]),
      [
        ["OPERA_FEED_LATE", "prop_ra", "org_1", "2026-09-17", "arrivals"],
        ["OPERA_FEED_LATE", "prop_ra", "org_1", "2026-09-16", "revenue"]
      ]
    );
    for (const alert of stub.created) {
      assert.equal(alert.severity, "warning");
      assert.equal(alert.runId, null);
      assert.match(String(alert.message), /no ha llegado a la hora prevista/);
    }
  });

  it("startPmsShadowJob devuelve runNow/stop, respeta el anti-solape y stop no lanza", async () => {
    const logs: string[] = [];
    const log = { info: (_o: unknown, m?: string) => logs.push(`info:${m ?? ""}`), warn: (_o: unknown, m?: string) => logs.push(`warn:${m ?? ""}`), error: (_o: unknown, m?: string) => logs.push(`error:${m ?? ""}`) };
    const job = startPmsShadowJob({ log, intervalMs: 24 * 60 * 60 * 1000 });
    assert.equal(typeof job.runNow, "function");
    assert.equal(typeof job.stop, "function");
    assert.ok(logs.some((line) => line.startsWith("info:") && line.includes("enabled")));
    job.stop();
    job.stop();
  });
});
