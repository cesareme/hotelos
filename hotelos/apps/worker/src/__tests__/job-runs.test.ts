// Test unitario de jobs/job-runs.ts (Tanda L2 · L2-07): un WorkerJobRun por
// ejecución, running → completed | failed. Sin base de datos: se sustituyen
// los métodos de prisma.workerJobRun sobre el singleton, igual que hace
// notification-dispatcher.test.ts con prisma.notificationDelivery.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "@hotelos/database";
import { describeError, getRecentJobRuns, pruneJobRuns, toJsonValue, withJobRun } from "../jobs/job-runs.js";
import { jobRunRetentionDays } from "../scheduler.js";

type RunRow = {
  id: string;
  jobName: string;
  queueName: string;
  organizationId: string | null;
  propertyId: string | null;
  correlationId: string | null;
  payloadJson: unknown;
  resultJson: unknown;
  status: string;
  attempts: number;
  lastError: string | null;
  scheduledFor: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type DeleteManyArgs = { where: { jobName: string; status: string; createdAt: { lt: Date } } };

type MockState = {
  rows: Map<string, RunRow>;
  createCalls: Array<{ data: Partial<RunRow>; select?: Record<string, boolean> }>;
  updateCalls: Array<{ where: { id: string }; data: Partial<RunRow> }>;
  findManyCalls: Array<{ where?: { jobName?: string }; take?: number; orderBy?: unknown }>;
  deleteManyCalls: DeleteManyArgs[];
};

let sequence = 0;

function installMock(state: MockState) {
  const runs = prisma.workerJobRun as unknown as Record<string, (args: never) => Promise<unknown>>;

  runs.create = (async (args: { data: Partial<RunRow>; select?: Record<string, boolean> }) => {
    state.createCalls.push(args);
    sequence += 1;
    const now = new Date(Date.now() + sequence);
    const row: RunRow = {
      id: `run-${sequence}`,
      jobName: "",
      queueName: "default",
      organizationId: null,
      propertyId: null,
      correlationId: null,
      payloadJson: null,
      resultJson: null,
      status: "queued",
      attempts: 0,
      lastError: null,
      scheduledFor: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
      ...args.data
    };
    state.rows.set(row.id, row);
    return args.select ? Object.fromEntries(Object.keys(args.select).map((key) => [key, row[key as keyof RunRow]])) : row;
  }) as never;

  runs.update = (async (args: { where: { id: string }; data: Partial<RunRow> }) => {
    state.updateCalls.push(args);
    const row = state.rows.get(args.where.id);
    if (!row) throw new Error(`row not found: ${args.where.id}`);
    Object.assign(row, args.data, { updatedAt: new Date() });
    return row;
  }) as never;

  runs.findMany = (async (args: { where?: { jobName?: string }; take?: number; orderBy?: unknown }) => {
    state.findManyCalls.push(args);
    const out = [...state.rows.values()]
      .filter((row) => !args.where?.jobName || row.jobName === args.where.jobName)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out.slice(0, args.take ?? out.length);
  }) as never;

  runs.deleteMany = (async (args: DeleteManyArgs) => {
    state.deleteManyCalls.push(args);
    let count = 0;
    for (const [id, row] of state.rows) {
      if (row.jobName === args.where.jobName && row.status === args.where.status && row.createdAt.getTime() < args.where.createdAt.lt.getTime()) {
        state.rows.delete(id);
        count += 1;
      }
    }
    return { count };
  }) as never;
}

describe("withJobRun", () => {
  let state: MockState;

  beforeEach(() => {
    sequence = 0;
    state = { rows: new Map(), createCalls: [], updateCalls: [], findManyCalls: [], deleteManyCalls: [] };
    installMock(state);
  });

  it("pruneJobRuns borra solo los completed/failed antiguos de SU jobName (nunca running ni otro jobName)", async () => {
    const old = new Date("2026-09-01T00:00:00.000Z");
    const recent = new Date("2026-09-18T00:00:00.000Z");
    const seed = (id: string, jobName: string, status: string, createdAt: Date) =>
      state.rows.set(id, { id, jobName, queueName: jobName, organizationId: null, propertyId: null, correlationId: null, payloadJson: {}, resultJson: null, status, attempts: 1, lastError: null, scheduledFor: null, startedAt: createdAt, finishedAt: createdAt, createdAt, updatedAt: createdAt });
    seed("a", "webhooks.deliver", "completed", old);
    seed("b", "webhooks.deliver", "completed", recent);
    seed("c", "webhooks.deliver", "failed", old);
    seed("d", "webhooks.deliver", "running", old);
    seed("e", "treasury.sepa_remittance", "completed", old);
    seed("f", "notifications.scheduled", "completed", old);
    const removed = await pruneJobRuns({ jobName: "webhooks.deliver", completedBefore: new Date("2026-09-11T00:00:00.000Z"), failedBefore: new Date("2026-08-20T00:00:00.000Z") });
    assert.equal(removed, 1, "solo el completed antiguo: el failed es más reciente que failedBefore");
    assert.deepEqual([...state.rows.keys()].sort(), ["b", "c", "d", "e", "f"]);
    assert.deepEqual(state.deleteManyCalls.map((call) => [call.where.jobName, call.where.status]), [["webhooks.deliver", "completed"], ["webhooks.deliver", "failed"]]);
    const removedFailed = await pruneJobRuns({ jobName: "webhooks.deliver", completedBefore: new Date("2026-09-11T00:00:00.000Z") });
    assert.equal(removedFailed, 1, "sin failedBefore, los failed siguen la misma retención");
    assert.deepEqual([...state.rows.keys()].sort(), ["b", "d", "e", "f"]);
  });

  it("jobRunRetentionDays lee WORKER_JOB_RUN_RETENTION_DAYS con 7 por defecto y rechaza valores inválidos", () => {
    assert.equal(jobRunRetentionDays({}), 7);
    assert.equal(jobRunRetentionDays({ WORKER_JOB_RUN_RETENTION_DAYS: "30" }), 30);
    assert.equal(jobRunRetentionDays({ WORKER_JOB_RUN_RETENTION_DAYS: "0" }), 7);
    assert.equal(jobRunRetentionDays({ WORKER_JOB_RUN_RETENTION_DAYS: "abc" }), 7);
  });

  it("escribe running → completed con resultJson y devuelve el resultado de fn", async () => {
    const result = await withJobRun(
      { jobName: "notifications.scheduled", queueName: "notifications.scheduled", payload: { tick: 1 }, correlationId: "job-1" },
      async (ctx) => {
        const row = state.rows.get(ctx.runId);
        assert.ok(row, "la fila existe mientras corre fn");
        assert.equal(row.status, "running");
        assert.equal(row.attempts, 1);
        assert.ok(row.startedAt instanceof Date);
        assert.equal(row.finishedAt, null);
        return { considered: 2, sent: 2 };
      }
    );

    assert.deepEqual(result, { considered: 2, sent: 2 });
    assert.equal(state.createCalls.length, 1);
    const created = state.createCalls[0].data;
    assert.equal(created.status, "running");
    assert.equal(created.attempts, 1);
    assert.equal(created.jobName, "notifications.scheduled");
    assert.equal(created.queueName, "notifications.scheduled");
    assert.equal(created.correlationId, "job-1");
    assert.deepEqual(created.payloadJson, { tick: 1 });
    assert.equal(created.organizationId, null, "barrido global: organizationId null");
    assert.equal(created.propertyId, null, "barrido global: propertyId null");

    const row = state.rows.get("run-1");
    assert.ok(row);
    assert.equal(row.status, "completed");
    assert.deepEqual(row.resultJson, { considered: 2, sent: 2 });
    assert.equal(row.lastError, null);
    assert.ok(row.finishedAt instanceof Date);
    assert.equal(state.updateCalls.length, 1);
  });

  it("escribe running → failed con lastError y relanza el error", async () => {
    await assert.rejects(
      withJobRun({ jobName: "webhooks.deliver", queueName: "webhooks.deliver", payload: {} }, async () => {
        throw new Error("boom: destino inalcanzable");
      }),
      /boom: destino inalcanzable/
    );

    const row = state.rows.get("run-1");
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, "Error: boom: destino inalcanzable");
    assert.equal(row.resultJson, null);
    assert.ok(row.finishedAt instanceof Date);
    assert.equal(state.updateCalls.length, 1);
    assert.equal(state.updateCalls[0].data.status, "failed");
  });

  it("conserva organizationId y propertyId cuando el productor tiene ámbito", async () => {
    await withJobRun(
      { jobName: "webhooks.deliver", queueName: "webhooks.deliver", payload: {}, organizationId: "org-1", propertyId: "prop-1" },
      async () => "ok"
    );
    const row = state.rows.get("run-1");
    assert.ok(row);
    assert.equal(row.organizationId, "org-1");
    assert.equal(row.propertyId, "prop-1");
    assert.equal(row.resultJson, "ok");
  });

  it("si no puede cerrar un run completado, lo registra y devuelve el resultado sin relanzar", async () => {
    const runs = prisma.workerJobRun as unknown as { update: (args: never) => Promise<unknown> };
    runs.update = async () => {
      throw new Error("conexión perdida");
    };
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await withJobRun({ jobName: "notifications.retry", queueName: "notifications.retry", payload: {} }, async () => 7);
      assert.equal(result, 7);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /no se pudo cerrar como completed/);
    } finally {
      console.error = originalError;
    }
  });

  it("getRecentJobRuns filtra por jobName y limita a perJob (la tabla la comparte treasury.sepa_remittance)", async () => {
    for (let i = 0; i < 12; i += 1) {
      await withJobRun({ jobName: "notifications.retry", queueName: "notifications.retry", payload: { i } }, async () => i);
    }
    await withJobRun({ jobName: "treasury.sepa_remittance", queueName: "treasury", payload: {} }, async () => "xml");

    const recent = await getRecentJobRuns(["notifications.retry", "webhooks.deliver"]);
    assert.deepEqual(Object.keys(recent), ["notifications.retry", "webhooks.deliver"]);
    assert.equal(recent["notifications.retry"].length, 10);
    assert.ok(recent["notifications.retry"].every((run) => run.jobName === "notifications.retry"));
    assert.ok(recent["notifications.retry"].every((run) => typeof run.durationMs === "number" && run.durationMs >= 0));
    assert.equal(recent["webhooks.deliver"].length, 0);
    assert.deepEqual(
      state.findManyCalls.map((call) => call.where?.jobName),
      ["notifications.retry", "webhooks.deliver"]
    );
    assert.ok(state.findManyCalls.every((call) => call.take === 10));
  });

  it("toJsonValue y describeError nunca lanzan y acotan la salida", () => {
    assert.deepEqual(toJsonValue(undefined), {});
    assert.deepEqual(toJsonValue({ when: new Date("2026-09-18T10:00:00.000Z"), skip: undefined }), { when: "2026-09-18T10:00:00.000Z" });
    assert.deepEqual(toJsonValue({ big: 1n }), { unserializable: true, type: "object" });
    assert.equal(describeError("texto"), "texto");
    assert.equal(describeError(new TypeError("mal")), "TypeError: mal");
    assert.equal(describeError(new Error("x".repeat(3000))).length, 2000);
  });
});
