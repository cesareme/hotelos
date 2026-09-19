// Unit tests · Tanda T8 · lote T8-C — job del líder (reputation-sync.job.ts):
// shouldStartReputationSyncJob puro sobre opciones (sin NodeJS.ProcessEnv),
// una vuelta con un stub de prisma: sin advisory lock → skipped y sin tocar
// nada; con lock → tick FUERA de la transacción del lock (corrección BD-03: las
// consultas del tick van por el cliente normal, nunca por el `tx`), con lock
// por propiedad; si la transacción del lock expira el resultado se conserva;
// flag anti-solape de startReputationSyncJob. Sin base de datos, sin red.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-sync-job.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { prisma } from "@hotelos/database";
import { REPUTATION_PROPERTY_LOCK_TIMEOUT_MS, REPUTATION_SYNC_LOCK_TIMEOUT_MS, reputationPropertyLockKey, withAdvisoryLock } from "../reputation-lock.js";
import {
  REPUTATION_SYNC_DEFAULT_INTERVAL_MS,
  REPUTATION_SYNC_LOCK_KEY,
  REPUTATION_SYNC_MIN_INTERVAL_MS,
  reputationSyncIntervalMs,
  runReputationSyncJobTick,
  shouldStartReputationSyncJob,
  startReputationSyncJob,
  type JobDb
} from "../reputation-sync.job.js";

type Stub = { db: JobDb; calls: string[] };

/**
 * Stub mínimo de prisma: `$transaction` ejecuta el callback con un «tx» que SOLO
 * sabe tomar el lock (si el tick usara el tx, `tx.module` no existe y fallaría);
 * los modelos viven en el cliente normal, como en producción (autocommit).
 * `lockedByKey` decide el lock por clave (global `reputation.sync`, por propiedad
 * `reputation.sync:<id>`); `expireTx` simula la expiración de la transacción del
 * lock tras el trabajo (Prisma rechaza el commit con «Transaction already closed»).
 */
function stubPrisma(options: { locked: boolean; delayMs?: number; lockedByKey?: Record<string, boolean>; expireTx?: boolean; withModule?: boolean }): Stub {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`queryRaw:${strings.join("?").trim()}:${values.join(",")}`);
      const key = String(values[0]);
      return [{ locked: options.lockedByKey?.[key] ?? options.locked }];
    }
  };
  const db = {
    $transaction: async (fn: (client: unknown) => Promise<unknown>, txOptions?: { maxWait?: number; timeout?: number }) => {
      calls.push(`transaction:${txOptions?.maxWait ?? "-"}:${txOptions?.timeout ?? "-"}`);
      const out = await fn(tx);
      if (options.expireTx) throw new Error("Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction.");
      return out;
    },
    $queryRaw: async () => [],
    module: {
      findFirst: async () => {
        calls.push("module.findFirst");
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        return options.withModule ? { id: "mod_rep" } : null;
      }
    },
    propertyModule: { findMany: async () => (options.withModule ? [{ propertyId: "prop_a", configurationJson: {} }, { propertyId: "prop_b", configurationJson: {} }] : []) },
    property: { findMany: async () => (options.withModule ? [{ id: "prop_a", organizationId: "org_a", name: "A" }, { id: "prop_b", organizationId: "org_a", name: "B" }] : []) },
    reviewSource: { findMany: async () => [], findFirst: async () => null },
    guestReview: { findMany: async () => [], findFirst: async () => null },
    qualityCase: { create: async () => ({}) },
    inboundEmail: { findMany: async () => [] }
  } as unknown as JobDb;
  return { db, calls };
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("shouldStartReputationSyncJob / reputationSyncIntervalMs (puros)", () => {
  it("arranca solo con runSchedulers=true y disabled=false", () => {
    assert.equal(shouldStartReputationSyncJob({ runSchedulers: true, disabled: false }), true);
    assert.equal(shouldStartReputationSyncJob({ runSchedulers: false, disabled: false }), false);
    assert.equal(shouldStartReputationSyncJob({ runSchedulers: true, disabled: true }), false);
    assert.equal(shouldStartReputationSyncJob({ runSchedulers: false, disabled: true }), false);
  });

  it("intervalo: 24 h por defecto (86.400.000 ms); valores no finitos o < 60 s vuelven al defecto", () => {
    assert.equal(REPUTATION_SYNC_DEFAULT_INTERVAL_MS, 86_400_000);
    assert.equal(REPUTATION_SYNC_MIN_INTERVAL_MS, 60_000);
    assert.equal(reputationSyncIntervalMs(undefined), REPUTATION_SYNC_DEFAULT_INTERVAL_MS);
    assert.equal(reputationSyncIntervalMs(null), REPUTATION_SYNC_DEFAULT_INTERVAL_MS);
    assert.equal(reputationSyncIntervalMs(Number.NaN), REPUTATION_SYNC_DEFAULT_INTERVAL_MS);
    assert.equal(reputationSyncIntervalMs(1_000), REPUTATION_SYNC_DEFAULT_INTERVAL_MS);
    assert.equal(reputationSyncIntervalMs(3_600_000), 3_600_000);
  });

  it("la clave del advisory lock es reputation.sync (y por propiedad reputation.sync:<id>)", () => {
    assert.equal(REPUTATION_SYNC_LOCK_KEY, "reputation.sync");
    assert.equal(reputationPropertyLockKey("prop_a"), "reputation.sync:prop_a");
    assert.ok(REPUTATION_SYNC_LOCK_TIMEOUT_MS > 300_000 && REPUTATION_PROPERTY_LOCK_TIMEOUT_MS > 60_000);
  });
});

describe("withAdvisoryLock (reputation-lock.ts)", () => {
  it("la transacción solo toma el lock; el trabajo corre fuera y su resultado vuelve", async () => {
    const stub = stubPrisma({ locked: true });
    const out = await withAdvisoryLock({ db: stub.db, key: "k", timeoutMs: 1000, run: async () => 42 });
    assert.deepEqual(out, { locked: true, result: 42, lockExpired: false });
    assert.deepEqual(stub.calls, ["transaction:5000:1000", "queryRaw:SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked:k"]);
  });
  it("sin lock → { locked: false } sin ejecutar el trabajo", async () => {
    const stub = stubPrisma({ locked: false });
    let ran = false;
    const out = await withAdvisoryLock({ db: stub.db, key: "k", timeoutMs: 1000, run: async () => (ran = true) });
    assert.deepEqual(out, { locked: false });
    assert.equal(ran, false);
  });
  it("si la transacción del lock expira tras el trabajo, el resultado se conserva (lockExpired) y se avisa", async () => {
    const stub = stubPrisma({ locked: true, expireTx: true });
    const warnings: string[] = [];
    const out = await withAdvisoryLock({ db: stub.db, key: "k", timeoutMs: 1000, log: { warn: (_obj, msg) => warnings.push(msg ?? "") }, run: async () => "hecho" });
    assert.deepEqual(out, { locked: true, result: "hecho", lockExpired: true });
    assert.equal(warnings.length, 1);
  });
  it("un error del trabajo se relanza (no se traga por el lock)", async () => {
    const stub = stubPrisma({ locked: true });
    await assert.rejects(withAdvisoryLock({ db: stub.db, key: "k", timeoutMs: 1000, run: async () => { throw new Error("boom"); } }), /boom/);
  });
});

describe("runReputationSyncJobTick", () => {
  it("sin advisory lock → skipped:true, summary null y ninguna consulta más", async () => {
    const stub = stubPrisma({ locked: false });
    const out = await runReputationSyncJobTick({ db: stub.db, now: new Date("2026-09-19T04:00:00Z"), log: silent });
    assert.equal(out.skipped, true);
    assert.equal(out.summary, null);
    assert.ok(Date.parse(out.startedAt) <= Date.parse(out.finishedAt));
    assert.deepEqual(stub.calls, [`transaction:5000:${REPUTATION_SYNC_LOCK_TIMEOUT_MS}`, `queryRaw:SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked:${REPUTATION_SYNC_LOCK_KEY}`]);
  });

  it("con lock → corre el tick FUERA de la transacción del lock (el tx solo sabe tomar el lock; aquí vacío: sin fila del módulo)", async () => {
    const stub = stubPrisma({ locked: true });
    const out = await runReputationSyncJobTick({ db: stub.db, now: new Date("2026-09-19T04:00:00Z"), log: silent });
    assert.equal(out.skipped, false);
    assert.ok(out.summary);
    assert.equal(out.summary!.properties, 0);
    assert.equal(out.summary!.trigger, "scheduler");
    assert.equal(out.lockExpired, undefined);
    assert.ok(stub.calls.includes("module.findFirst"));
  });

  it("lock por propiedad: la propiedad cuyo lock tiene otro proceso (importación / sincronización manual) se salta con skipReason lock; la otra corre", async () => {
    const stub = stubPrisma({ locked: true, withModule: true, lockedByKey: { [reputationPropertyLockKey("prop_a")]: false } });
    const out = await runReputationSyncJobTick({ db: stub.db, now: new Date("2026-09-19T04:00:00Z"), log: silent });
    assert.equal(out.skipped, false);
    const a = out.summary!.byProperty.find((entry) => entry.propertyId === "prop_a");
    const b = out.summary!.byProperty.find((entry) => entry.propertyId === "prop_b");
    assert.equal(a?.skipped, true);
    assert.equal(a?.skipReason, "lock");
    assert.equal(b?.skipped, true);
    assert.equal(b?.skipReason, "no_sources");
    assert.deepEqual(out.summary!.skipped, [{ sourceId: "", propertyId: "prop_a", reason: "lock" }]);
    assert.equal(stub.calls.filter((call) => call.startsWith("transaction:")).length, 3, "una transacción por lock: global + 2 propiedades");
    assert.ok(stub.calls.includes(`transaction:5000:${REPUTATION_PROPERTY_LOCK_TIMEOUT_MS}`));
  });

  it("si la transacción del lock global expira tras el tick, la vuelta devuelve el resumen con lockExpired (nada se revierte: autocommit)", async () => {
    const stub = stubPrisma({ locked: true, expireTx: true });
    const out = await runReputationSyncJobTick({ db: stub.db, now: new Date("2026-09-19T04:00:00Z"), log: silent });
    assert.equal(out.skipped, false);
    assert.ok(out.summary);
    assert.equal(out.lockExpired, true);
  });
});

describe("startReputationSyncJob", () => {
  it("runAtBoot:false no ejecuta al arrancar; runNow corre una vuelta; una segunda llamada solapada devuelve null; stop limpia el intervalo", async () => {
    const stub = stubPrisma({ locked: true, delayMs: 20 });
    const job = startReputationSyncJob({ db: stub.db, log: silent, intervalMs: 3_600_000, runAtBoot: false });
    assert.equal(stub.calls.length, 0);
    const [first, second] = await Promise.all([job.runNow(), job.runNow()]);
    assert.ok(first);
    assert.equal(first!.skipped, false);
    assert.equal(second, null);
    job.stop();
    const third = await job.runNow();
    assert.ok(third);
    assert.equal(stub.calls.filter((call) => call === "module.findFirst").length, 2);
  });

  it("runAtBoot por defecto ejecuta una vuelta al arrancar", async () => {
    const stub = stubPrisma({ locked: false });
    const job = startReputationSyncJob({ db: stub.db, log: silent, intervalMs: 3_600_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    job.stop();
    assert.equal(stub.calls.filter((call) => call.startsWith("transaction:")).length, 1);
  });
});
