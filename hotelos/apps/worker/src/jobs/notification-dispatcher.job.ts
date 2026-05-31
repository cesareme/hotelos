// Notification dispatcher worker job (Sprint 30).
//
// Sprint 26 built the API-side `dispatch()` which writes a NotificationDelivery
// row with `status="queued"`. When `scheduledFor > now`, dispatch persisted the
// row and returned without sending — leaving the future-dated delivery sitting
// in the queue forever. This job is what eventually picks those rows up and
// fires the configured provider.
//
// It also handles transient failure recovery: a row that failed (status
// "failed", attempts < 3) is re-queued with exponential backoff so the next
// scheduled tick will retry it.
//
// Concurrency model:
//   - Multiple worker instances may run side-by-side in production. We use a
//     conditional UPDATE (status="queued" → "sending") wrapped around the row
//     selection to ensure at most one worker picks up any given row. Prisma's
//     `updateMany` returns a `count`; a count of 0 means another instance got
//     it first and we skip silently. This is the single most important
//     correctness invariant in this file.

import { prisma, type Prisma } from "@hotelos/database";
import { resolveProvider } from "../providers/index.js";

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_FLOOR_AGE_MS = 5 * 60 * 1000; // re-queue failed rows older than 5 min
const STUCK_SENDING_AGE_MS = 15 * 60 * 1000; // re-queue "sending" rows older than 15 min

/**
 * Pull up to BATCH_SIZE due deliveries (queued and scheduledFor ≤ now), claim
 * each one atomically, attempt the provider call, then write the terminal
 * state. Returns a small summary suitable for logging.
 */
export async function runScheduledNotifications(now: Date = new Date()): Promise<{
  considered: number;
  sent: number;
  failed: number;
  rescheduled: number;
  skipped: number;
}> {
  const due = await prisma.notificationDelivery.findMany({
    where: {
      status: "queued",
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }]
    },
    take: BATCH_SIZE,
    orderBy: { scheduledFor: "asc" }
  });

  let sent = 0;
  let failed = 0;
  let rescheduled = 0;
  let skipped = 0;

  for (const row of due) {
    // Atomic claim: only proceed if THIS instance flips queued→sending. Any
    // other worker that read the same row will see updateMany return 0.
    const claim = await prisma.notificationDelivery.updateMany({
      where: { id: row.id, status: "queued" },
      data: { status: "sending" }
    });
    if (claim.count === 0) {
      skipped += 1;
      continue;
    }

    const outcome = await sendOne({
      id: row.id,
      channel: row.channel,
      recipient: row.recipient,
      subject: row.subject ?? "",
      body: row.bodyRendered ?? "",
      attempts: row.attempts
    });
    if (outcome === "sent") sent += 1;
    else if (outcome === "rescheduled") rescheduled += 1;
    else failed += 1;
  }

  return { considered: due.length, sent, failed, rescheduled, skipped };
}

/**
 * Sweep terminal-failed rows (status="failed", attempts<MAX_ATTEMPTS, last
 * failure ≥ RETRY_FLOOR_AGE_MS ago) back into the queue. The main loop's
 * exponential-backoff path also re-queues during the initial send; this sweep
 * is the safety net that catches deliveries marked failed via other code paths
 * (e.g. the API-side `retryDelivery`) and gives them another scheduled tick.
 */
export async function runFailedRetries(now: Date = new Date()): Promise<{ requeued: number }> {
  const cutoff = new Date(now.getTime() - RETRY_FLOOR_AGE_MS);
  const result = await prisma.notificationDelivery.updateMany({
    where: {
      status: "failed",
      attempts: { lt: MAX_ATTEMPTS },
      failedAt: { lte: cutoff }
    },
    data: {
      status: "queued",
      scheduledFor: now,
      failedAt: null
    }
  });
  return { requeued: result.count };
}

/**
 * Janitor for rows wedged in the "sending" state. The main loop claims a row by
 * flipping queued→sending and only writes a terminal state (sent/failed/queued)
 * after the provider call returns. If a worker crashes between the claim and the
 * provider write, the row stays "sending" forever and is never reconsidered by
 * `runScheduledNotifications` (which only looks at "queued").
 *
 * This sweep finds rows that have sat in "sending" longer than
 * STUCK_SENDING_AGE_MS (15 min — comfortably longer than the 15s OAuth/provider
 * timeout plus any retries) and resets them to "queued" so the next scheduled
 * tick reprocesses them. We use findMany + per-row update (rather than a single
 * updateMany) so each rescue can be logged individually for forensics. The
 * per-row update is itself a conditional reset (where status still "sending") to
 * avoid clobbering a row a live worker just finished.
 */
export async function runStuckSendingSweep(now: Date = new Date()): Promise<{ requeued: number }> {
  const cutoff = new Date(now.getTime() - STUCK_SENDING_AGE_MS);
  const stuck = await prisma.notificationDelivery.findMany({
    where: {
      status: "sending",
      updatedAt: { lt: cutoff }
    },
    take: BATCH_SIZE
  });

  let requeued = 0;
  for (const row of stuck) {
    const reset = await prisma.notificationDelivery.updateMany({
      where: { id: row.id, status: "sending" },
      data: { status: "queued" }
    });
    if (reset.count > 0) {
      requeued += 1;
      console.warn(
        `[notifications.sending-sweep] rescued stuck delivery id=${row.id} ` +
          `channel=${row.channel} recipient=${row.recipient} ` +
          `stuckSince=${row.updatedAt.toISOString()} → re-queued`
      );
    }
  }

  return { requeued };
}

type SendArgs = {
  id: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  attempts: number;
};

type SendOutcome = "sent" | "failed" | "rescheduled";

async function sendOne(args: SendArgs): Promise<SendOutcome> {
  let result: { status: "sent" | "failed"; providerMessageId?: string; error?: string };
  try {
    const provider = resolveProvider(args.channel);
    result = await provider.send({
      recipient: args.recipient,
      subject: args.subject || undefined,
      body: args.body
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { status: "failed", error: message };
  }

  const now = new Date();
  if (result.status === "sent") {
    await prisma.notificationDelivery.update({
      where: { id: args.id },
      data: {
        status: "sent",
        sentAt: now,
        providerMessageId: result.providerMessageId ?? null,
        errorMessage: null,
        attempts: { increment: 1 }
      }
    });
    return "sent";
  }

  const nextAttempts = args.attempts + 1;
  const shouldRetry = nextAttempts < MAX_ATTEMPTS;

  if (shouldRetry) {
    // Exponential backoff: 5min * 2^(attempts after increment). Using the
    // post-increment count keeps the delays at 10min, 20min for attempts
    // 1 and 2 — the spec said "5min * 2^attempts" with `attempts++`.
    const delayMs = BACKOFF_BASE_MS * Math.pow(2, nextAttempts);
    await prisma.notificationDelivery.update({
      where: { id: args.id },
      data: {
        status: "queued",
        scheduledFor: new Date(now.getTime() + delayMs),
        failedAt: null,
        errorMessage: result.error ?? "Unknown provider error.",
        attempts: { increment: 1 }
      }
    });
    return "rescheduled";
  }

  await prisma.notificationDelivery.update({
    where: { id: args.id },
    data: {
      status: "failed",
      failedAt: now,
      errorMessage: result.error ?? "Unknown provider error.",
      attempts: { increment: 1 }
    }
  });
  return "failed";
}

// Re-export internals for the unit test only.
export const __internals = {
  BATCH_SIZE,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  RETRY_FLOOR_AGE_MS,
  STUCK_SENDING_AGE_MS,
  sendOne
};

// Convenience helpers if a future test wants to inject a fake prisma client
// without re-shaping the module. Kept here so the type matches the real
// surface area we touch.
export type DeliveryPrismaShape = Pick<typeof prisma, "notificationDelivery">;
// (Currently unused — the unit test mocks via module replacement under @hotelos/database.)

// re-exported types to satisfy Prisma narrowing if a caller needs it:
export type { Prisma };
