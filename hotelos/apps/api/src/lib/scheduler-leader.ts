/**
 * Scheduler leadership gate (audit 2026-06 · #13 · HA) + lease (Tanda L2 · L2-02).
 *
 * The nine in-process schedulers of server.ts (SES Hospedajes, VeriFactu,
 * channel drain, revenue pace, allotment release, group cut-off, mailbox poll,
 * PMS shadow, reputation sync) MUST run on exactly ONE instance. With more than one replica,
 * every replica would fire every scheduler, producing DUPLICATE SES /
 * VeriFactu submissions to the AEAT — which is sanctionable — and duplicate
 * inventory releases.
 *
 * Two layers:
 *   1. `isSchedulerLeader()` — the env switch. `RUN_SCHEDULERS=false` disables
 *      the schedulers on a replica entirely (never leader); default `true`
 *      keeps single-node dev and the single-replica deployment unchanged. The
 *      per-scheduler `*_DISABLED` flags still work as fine-grained overrides.
 *   2. `holdsSchedulerLease()` — automatic election over the `scheduler_leases`
 *      table (L2-01): every tick of every scheduler acquires or renews ONE row
 *      per key in a single atomic statement and runs only when it succeeded.
 *      Two replicas with RUN_SCHEDULERS=true therefore never work at the same
 *      time: the second one waits until the lease expires (ttl) or the holder
 *      renews it. The holder id is `${hostname()}:${pid}`, so a restarted
 *      process is a new holder and takes over as soon as the old lease expires.
 */
import { hostname } from "node:os";
import { prisma } from "@hotelos/database";

type Logger = { info: (obj: unknown, msg?: string) => void };

export const SCHEDULER_LEASE_KEY = "api-schedulers";
export const SCHEDULER_LEASE_TTL_MS = 60_000;

export function isSchedulerLeader(log?: Logger): boolean {
  const enabled = process.env.RUN_SCHEDULERS !== "false";
  if (log) {
    if (enabled) {
      log.info({ runSchedulers: true }, "[schedulers] this instance is the scheduler leader");
    } else {
      log.info(
        { runSchedulers: false },
        "[schedulers] disabled on this instance (RUN_SCHEDULERS=false) — another replica is the leader"
      );
    }
  }
  return enabled;
}

/** Identity of THIS process in `scheduler_leases.holder_id`. */
export function schedulerHolderId(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * Acquire or renew the lease `key` for `holderId` (this process by default) in
 * ONE atomic statement: the row is inserted when missing and updated only when
 * it expired or already belongs to the same holder — `expires_at` moves to
 * now() + ttl in both cases. Resolves `true` when the statement affected one
 * row (this holder runs the tick) and `false` when another live holder keeps
 * the lease. A database failure propagates: the caller decides (the server
 * ticks log it and skip the run — never fail open).
 */
export async function holdsSchedulerLease(key = SCHEDULER_LEASE_KEY, ttlMs = SCHEDULER_LEASE_TTL_MS, holderId = schedulerHolderId()): Promise<boolean> {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("holdsSchedulerLease: ttlMs must be a positive integer.");
  const affected = await prisma.$executeRaw`
    INSERT INTO scheduler_leases (key, holder_id, expires_at, updated_at)
    VALUES (${key}, ${holderId}, now() + (${ttlMs} * interval '1 millisecond'), now())
    ON CONFLICT (key) DO UPDATE
      SET holder_id = EXCLUDED.holder_id, expires_at = EXCLUDED.expires_at, updated_at = now()
      WHERE scheduler_leases.expires_at < now() OR scheduler_leases.holder_id = EXCLUDED.holder_id`;
  return affected === 1;
}

export type SchedulerLeaseStatus = {
  /** What decides leadership right now: a live lease row, or only the env switch (no row yet / expired). */
  leader: "env" | "lease";
  /** holder_id of the live lease (null without a live lease). */
  holder: string | null;
  /** Whether the live lease belongs to this process. */
  thisInstance: boolean;
  /** ISO expiry of the live lease (null without one). */
  expiresAt: string | null;
};

/** Read-only view of the lease for /health (never acquires; a database failure reads as "env"). */
export async function describeSchedulerLease(key = SCHEDULER_LEASE_KEY): Promise<SchedulerLeaseStatus> {
  try {
    const row = await prisma.schedulerLease.findUnique({ where: { key }, select: { holderId: true, expiresAt: true } });
    if (!row || row.expiresAt.getTime() <= Date.now()) return { leader: "env", holder: null, thisInstance: false, expiresAt: null };
    return { leader: "lease", holder: row.holderId, thisInstance: row.holderId === schedulerHolderId(), expiresAt: row.expiresAt.toISOString() };
  } catch {
    return { leader: "env", holder: null, thisInstance: false, expiresAt: null };
  }
}
