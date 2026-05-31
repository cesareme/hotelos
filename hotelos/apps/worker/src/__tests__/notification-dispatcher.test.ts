// Unit test for the Sprint 30 notification dispatcher worker job.
//
// Strategy: the job imports `prisma` from @hotelos/database (a process-wide
// singleton). We replace the `notificationDelivery` methods we care about
// with spies before invoking the job, then assert the state transitions.
//
// The provider lookup is replaced indirectly: we drive `runScheduledNotifications`
// with rows whose channel triggers our stubbed provider behaviour
// (failure simulation via `+0000000000` for SMS; normal send for a valid email).
// This keeps the test free of any real network / DB activity.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { prisma } from "@hotelos/database";
import {
  runScheduledNotifications,
  runFailedRetries,
  runStuckSendingSweep
} from "../jobs/notification-dispatcher.job.js";

type DeliveryRow = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  notificationId: string | null;
  templateCode: string | null;
  channel: string;
  recipient: string;
  status: string;
  providerMessageId: string | null;
  subject: string | null;
  bodyRendered: string | null;
  payloadJson: unknown;
  attempts: number;
  errorMessage: string | null;
  scheduledFor: Date | null;
  sentAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeRow(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  const now = new Date();
  return {
    id: overrides.id ?? `row-${Math.random().toString(36).slice(2, 8)}`,
    organizationId: "org-1",
    propertyId: "prop-1",
    notificationId: null,
    templateCode: "test.template",
    channel: "email",
    recipient: "guest@example.com",
    status: "queued",
    providerMessageId: null,
    subject: "Hello",
    bodyRendered: "Body text.",
    payloadJson: null,
    attempts: 0,
    errorMessage: null,
    scheduledFor: new Date(now.getTime() - 1000),
    sentAt: null,
    failedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

type MockState = {
  rows: Map<string, DeliveryRow>;
  findManyCalls: Array<unknown>;
  updateManyCalls: Array<{ where: any; data: any }>;
  updateCalls: Array<{ where: any; data: any }>;
};

function installMock(state: MockState) {
  const delivery = prisma.notificationDelivery as any;

  delivery.findMany = async (args: any) => {
    state.findManyCalls.push(args);
    const where = args?.where ?? {};
    const take = args?.take ?? Infinity;
    const out: DeliveryRow[] = [];
    for (const row of state.rows.values()) {
      if (where.status && row.status !== where.status) continue;
      if (where.updatedAt?.lt && !(row.updatedAt < where.updatedAt.lt)) continue;
      if (where.OR) {
        // OR: [{ scheduledFor: null }, { scheduledFor: { lte: <date> } }]
        const matchesOr = where.OR.some((clause: any) => {
          if ("scheduledFor" in clause) {
            const sf = clause.scheduledFor;
            if (sf === null) return row.scheduledFor === null;
            if (sf?.lte) return row.scheduledFor !== null && row.scheduledFor <= sf.lte;
          }
          return false;
        });
        if (!matchesOr) continue;
      }
      out.push(row);
      if (out.length >= take) break;
    }
    return out;
  };

  delivery.updateMany = async (args: any) => {
    state.updateManyCalls.push(args);
    const where = args.where ?? {};
    const data = args.data ?? {};
    let count = 0;
    for (const row of state.rows.values()) {
      if (where.id && row.id !== where.id) continue;
      if (where.status && row.status !== where.status) continue;
      if (where.attempts?.lt !== undefined && !(row.attempts < where.attempts.lt)) continue;
      if (where.failedAt?.lte && !(row.failedAt && row.failedAt <= where.failedAt.lte)) continue;
      Object.assign(row, data);
      count += 1;
    }
    return { count };
  };

  delivery.update = async (args: any) => {
    state.updateCalls.push(args);
    const row = state.rows.get(args.where.id);
    if (!row) throw new Error(`row not found: ${args.where.id}`);
    const data = args.data;
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in (value as any)) {
        (row as any)[key] = ((row as any)[key] ?? 0) + (value as any).increment;
      } else {
        (row as any)[key] = value;
      }
    }
    return row;
  };
}

function freshState(): MockState {
  return {
    rows: new Map(),
    findManyCalls: [],
    updateManyCalls: [],
    updateCalls: []
  };
}

describe("notification-dispatcher worker job", () => {
  let state: MockState;

  beforeEach(() => {
    state = freshState();
    installMock(state);
  });

  it("claims a queued row and marks it sent when the provider succeeds", async () => {
    const row = makeRow({ id: "ok-1", channel: "email", recipient: "guest@example.com" });
    state.rows.set(row.id, row);

    const summary = await runScheduledNotifications();

    assert.equal(summary.considered, 1);
    assert.equal(summary.sent, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.rescheduled, 0);
    // The row should have moved queued → sending → sent (final state: sent).
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 1);
    assert.ok(row.sentAt instanceof Date, "sentAt should be set");
    assert.ok(row.providerMessageId, "providerMessageId should be populated");
    // The atomic claim must run before the terminal update.
    assert.ok(state.updateManyCalls.length >= 1, "updateMany used for atomic claim");
    assert.equal(state.updateManyCalls[0].data.status, "sending");
  });

  it("skips rows that another worker claimed first", async () => {
    const row = makeRow({ id: "race-1", status: "queued" });
    state.rows.set(row.id, row);

    // Simulate a concurrent worker: flip status away from "queued" between
    // findMany and updateMany by patching updateMany once.
    const delivery = prisma.notificationDelivery as any;
    const originalUpdateMany = delivery.updateMany;
    delivery.updateMany = async (args: any) => {
      if (args.data?.status === "sending") {
        return { count: 0 }; // no row claimed
      }
      return originalUpdateMany(args);
    };

    const summary = await runScheduledNotifications();

    assert.equal(summary.considered, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.sent, 0);
    // Row is untouched by us; status remains as the mock left it.
  });

  it("reschedules with exponential backoff on provider failure (attempts < max)", async () => {
    const row = makeRow({
      id: "fail-1",
      channel: "sms",
      recipient: "+0000000000", // sentinel for stubbed failure
      attempts: 0
    });
    state.rows.set(row.id, row);

    const baseline = Date.now();
    const summary = await runScheduledNotifications();

    assert.equal(summary.considered, 1);
    assert.equal(summary.rescheduled, 1);
    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 0);
    assert.equal(row.status, "queued");
    assert.equal(row.attempts, 1);
    assert.equal(row.failedAt, null, "failedAt should be cleared on requeue");
    assert.ok(row.errorMessage, "errorMessage should be set");
    assert.ok(row.scheduledFor instanceof Date);
    // Backoff at attempts=1: 5min * 2^1 = 10min ≈ 600s into the future.
    const delayMs = (row.scheduledFor as Date).getTime() - baseline;
    assert.ok(delayMs >= 9 * 60 * 1000, `expected ≥ 9min backoff, got ${delayMs}ms`);
    assert.ok(delayMs <= 11 * 60 * 1000, `expected ≤ 11min backoff, got ${delayMs}ms`);
  });

  it("marks the row failed when attempts reach the maximum", async () => {
    const row = makeRow({
      id: "fail-final",
      channel: "sms",
      recipient: "+0000000000",
      attempts: 2 // next attempt brings us to 3 = MAX_ATTEMPTS
    });
    state.rows.set(row.id, row);

    const summary = await runScheduledNotifications();

    assert.equal(summary.failed, 1);
    assert.equal(summary.rescheduled, 0);
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 3);
    assert.ok(row.failedAt instanceof Date, "failedAt should be set on terminal failure");
    assert.ok(row.errorMessage, "errorMessage should describe the failure");
  });

  it("runFailedRetries re-queues old failed rows that still have attempts remaining", async () => {
    const old = makeRow({
      id: "old-fail",
      status: "failed",
      attempts: 1,
      failedAt: new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
    });
    const young = makeRow({
      id: "young-fail",
      status: "failed",
      attempts: 1,
      failedAt: new Date(Date.now() - 60 * 1000) // 1 minute ago
    });
    const exhausted = makeRow({
      id: "exhausted",
      status: "failed",
      attempts: 3,
      failedAt: new Date(Date.now() - 60 * 60 * 1000)
    });
    state.rows.set(old.id, old);
    state.rows.set(young.id, young);
    state.rows.set(exhausted.id, exhausted);

    const result = await runFailedRetries();

    assert.equal(result.requeued, 1, "only the old, still-retryable row should be re-queued");
    assert.equal(old.status, "queued");
    assert.equal(old.failedAt, null);
    assert.equal(young.status, "failed");
    assert.equal(exhausted.status, "failed");
  });

  it("runStuckSendingSweep re-queues rows wedged in 'sending' but leaves fresh ones alone", async () => {
    // Wedged: a worker crashed mid-send 20 minutes ago (> 15 min threshold).
    const stuck = makeRow({
      id: "stuck-sending",
      status: "sending",
      updatedAt: new Date(Date.now() - 20 * 60 * 1000)
    });
    // Fresh: a live worker claimed this row 1 minute ago — must NOT be touched.
    const fresh = makeRow({
      id: "fresh-sending",
      status: "sending",
      updatedAt: new Date(Date.now() - 60 * 1000)
    });
    // A queued row should be ignored entirely by the sweep.
    const queued = makeRow({
      id: "queued-row",
      status: "queued",
      updatedAt: new Date(Date.now() - 60 * 60 * 1000)
    });
    state.rows.set(stuck.id, stuck);
    state.rows.set(fresh.id, fresh);
    state.rows.set(queued.id, queued);

    const result = await runStuckSendingSweep();

    assert.equal(result.requeued, 1, "only the old stuck row should be re-queued");
    assert.equal(stuck.status, "queued", "stuck row reset to queued for reprocessing");
    assert.equal(fresh.status, "sending", "fresh in-flight row left alone");
    assert.equal(queued.status, "queued", "already-queued row untouched");
  });
});
