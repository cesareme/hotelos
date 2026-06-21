/**
 * Scheduler leadership gate (audit 2026-06 · #13 · HA).
 *
 * The five in-process schedulers (SES Hospedajes, revenue pace, allotment
 * release, group cut-off, mailbox poll) MUST run on exactly ONE instance.
 * With more than one replica, every replica would fire every scheduler,
 * producing DUPLICATE SES / VeriFactu submissions to the AEAT — which is
 * sanctionable, and duplicate inventory releases.
 *
 * Single switch (replaces the previous five independent *_SCHEDULER_DISABLED
 * flags as the primary control): set `RUN_SCHEDULERS=false` on every replica
 * except one — or run the schedulers only on the dedicated `apps/worker`
 * process. Default is `true`, so single-node dev and the current single-replica
 * deployment keep their exact behaviour. The per-scheduler `*_DISABLED` flags
 * still work as fine-grained overrides on the leader.
 *
 * Future upgrade path (tracked): replace this env switch with automatic leader
 * election — a Postgres advisory-lock lease (heartbeat table) or pg-boss — so
 * no manual per-replica configuration is needed and failover is automatic.
 */
type Logger = { info: (obj: unknown, msg?: string) => void };

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
