// Revenue daily-snapshot backfill CLI (REV-03 · snapshot-first prerequisite).
//
// The nightly scheduler only writes YESTERDAY's top-level RevenueDailySnapshot
// (hf-board.service.ts → writeDailySnapshot, dataSource "night_audit"). Days it
// missed (API down, property created later, a 0-room close written while the
// reservations were not yet imported) are never revisited, and the shared
// realized rule (actuals.ts) trusts an existing snapshot over the reservations
// fallback. This command re-derives a date range from real reservations.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-snapshots.ts \
//     --from 2026-07-15 --to 2026-09-13 [--property <id>] [--dry-run] [--force] [--json]
//
//   --property <id>  one property (default: every property)
//   --from / --to    inclusive stay-date range (YYYY-MM-DD); `to` is clamped to
//                    yesterday — today and the future are OTB, never a close
//   --dry-run        report what would be written, write nothing
//   --force          also overwrite closes whose dataSource is NOT "night_audit"
//                    (seeded "demo" rows, imported history). Without it those
//                    days are SKIPPED so an import is never clobbered.
//                    A property with NO reservation in Anfitorio is always
//                    skipped (skippedNoReservations): there is no close to
//                    derive and a 0-room row would bury imported history.
//   --json           machine-readable output
//
// Idempotent: writeDailySnapshot is find-then-write on the top-level row, so
// re-running the same range converges to the same result.
//
// Exit codes: 0 ok · 1 failure (DB unreachable, bad range, any property failed) ·
// 2 unknown flag / invalid argument.

import { fileURLToPath } from "node:url";
import { BRAND } from "../lib/brand.js";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import { addDays, dayUtc, isoDate, MS_DAY, TOP_LEVEL_SNAPSHOT_WHERE } from "../modules/revenue/actuals.js";
import { writeDailySnapshot } from "../modules/revenue/hf-board.service.js";

export type BackfillFlags = {
  propertyId: string | null;
  from: string;
  to: string;
  dryRun: boolean;
  force: boolean;
  json: boolean;
};

export type BackfillPropertyResult = {
  propertyId: string;
  propertyName: string;
  days: number;
  created: number;
  updated: number;
  skippedProtected: Array<{ date: string; dataSource: string }>;
  /** Days not written because the property has no reservation at all (writer rule, never forced). */
  skippedNoReservations: number;
  failed: Array<{ date: string; error: string }>;
};

export type BackfillSummary = {
  dryRun: boolean;
  force: boolean;
  from: string;
  to: string;
  clampedTo: boolean;
  properties: BackfillPropertyResult[];
  totals: { days: number; created: number; updated: number; skippedProtected: number; skippedNoReservations: number; failed: number };
  durationMs: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFlags(argv: readonly string[]): BackfillFlags {
  const flags: BackfillFlags = { propertyId: null, from: "", to: "", dryRun: false, force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`Flag "${arg}" requires a value.`);
      i++;
      return v;
    };
    if (arg === "--property") flags.propertyId = next();
    else if (arg === "--from") flags.from = next();
    else if (arg === "--to") flags.to = next();
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --property <id>, --from <YYYY-MM-DD>, --to <YYYY-MM-DD>, --dry-run, --force, --json.`);
  }
  if (!DATE_RE.test(flags.from)) throw new Error("--from <YYYY-MM-DD> is required.");
  if (!DATE_RE.test(flags.to)) throw new Error("--to <YYYY-MM-DD> is required.");
  if (dayUtc(flags.to).getTime() < dayUtc(flags.from).getTime()) throw new Error("--to must be on or after --from.");
  return flags;
}

export async function runBackfill(flags: BackfillFlags, today: Date = dayUtc()): Promise<BackfillSummary> {
  const start = Date.now();
  const from = dayUtc(flags.from);
  const yesterday = addDays(dayUtc(today), -1);
  const requestedTo = dayUtc(flags.to);
  const clampedTo = requestedTo.getTime() > yesterday.getTime();
  const to = clampedTo ? yesterday : requestedTo;
  if (from.getTime() > to.getTime()) {
    throw new Error(`Nothing to backfill: the range starts on/after today (${isoDate(dayUtc(today))}); closes exist only for past days.`);
  }
  const dayCount = Math.round((to.getTime() - from.getTime()) / MS_DAY) + 1;

  const properties = await prisma.property.findMany({
    where: flags.propertyId ? { id: flags.propertyId } : undefined,
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" }
  });
  if (flags.propertyId && properties.length === 0) throw new Error(`Property ${flags.propertyId} not found.`);

  const results: BackfillPropertyResult[] = [];
  for (const p of properties) {
    const existing = await prisma.revenueDailySnapshot.findMany({
      where: { propertyId: p.id, ...TOP_LEVEL_SNAPSHOT_WHERE, snapshotDate: { gte: from, lte: to } },
      select: { snapshotDate: true, dataSource: true }
    });
    const existingByDate = new Map(existing.map((s) => [isoDate(dayUtc(s.snapshotDate)), s.dataSource]));
    // Same rule as writeDailySnapshot: a property that never had a reservation
    // has nothing to close (any status counts as "operated"). Checked once per
    // property so the dry-run reports it exactly like the apply would.
    const hasReservations = (await prisma.reservation.count({ where: { propertyId: p.id } })) > 0;
    const result: BackfillPropertyResult = { propertyId: p.id, propertyName: p.name, days: dayCount, created: 0, updated: 0, skippedProtected: [], skippedNoReservations: 0, failed: [] };
    for (let t = from.getTime(); t <= to.getTime(); t += MS_DAY) {
      const date = isoDate(new Date(t));
      const current = existingByDate.get(date);
      if (current !== undefined && current !== "night_audit" && !flags.force) {
        result.skippedProtected.push({ date, dataSource: current });
        continue;
      }
      if (!hasReservations) {
        result.skippedNoReservations++;
        continue;
      }
      if (flags.dryRun) {
        if (current === undefined) result.created++;
        else result.updated++;
        continue;
      }
      try {
        const written = await writeDailySnapshot(p.id, date, { force: flags.force });
        if (written.action === "skipped") {
          // The writer re-checks on its own (a reservation could be deleted, a
          // row could change hands between the pre-scan and the write): count
          // its skips honestly instead of reporting them as written.
          if (written.reason === "protected") result.skippedProtected.push({ date, dataSource: written.dataSource });
          else result.skippedNoReservations++;
        } else if (written.action === "created") result.created++;
        else result.updated++;
      } catch (error) {
        result.failed.push({ date, error: error instanceof Error ? error.message : String(error) });
      }
    }
    results.push(result);
  }

  const totals = results.reduce(
    (acc, r) => ({
      days: acc.days + r.days,
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      skippedProtected: acc.skippedProtected + r.skippedProtected.length,
      skippedNoReservations: acc.skippedNoReservations + r.skippedNoReservations,
      failed: acc.failed + r.failed.length
    }),
    { days: 0, created: 0, updated: 0, skippedProtected: 0, skippedNoReservations: 0, failed: 0 }
  );

  return {
    dryRun: flags.dryRun,
    force: flags.force,
    from: isoDate(from),
    to: isoDate(to),
    clampedTo,
    properties: results,
    totals,
    durationMs: Date.now() - start
  };
}

function printHuman(summary: BackfillSummary): void {
  const mode = summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED";
  const lines = [
    `[backfill:snapshots] ${mode}${summary.force ? " + force" : ""} · ${summary.from} → ${summary.to}${summary.clampedTo ? " (clamped to yesterday)" : ""} · ${summary.durationMs} ms`,
    `  properties: ${summary.properties.length} · days/property: ${summary.properties[0]?.days ?? 0}`,
    `  totals: +${summary.totals.created} created · ${summary.totals.updated} updated · ${summary.totals.skippedProtected} skipped (protected dataSource) · ${summary.totals.skippedNoReservations} skipped (no reservations) · ${summary.totals.failed} failed`
  ];
  for (const p of summary.properties) {
    lines.push(`  ${p.propertyId} (${p.propertyName}): +${p.created} / ~${p.updated} / skip ${p.skippedProtected.length} protected / skip ${p.skippedNoReservations} no-reservations / fail ${p.failed.length}`);
    if (p.skippedNoReservations > 0) {
      lines.push(`    sin reservas en ${BRAND.name}: ${p.skippedNoReservations} días no derivados (no hay cierre que escribir; la historia importada se conserva)`);
    }
    if (p.skippedProtected.length > 0) {
      const sources = [...new Set(p.skippedProtected.map((s) => s.dataSource))].join(", ");
      lines.push(`    protected (${sources}): ${p.skippedProtected[0].date} … ${p.skippedProtected[p.skippedProtected.length - 1].date} — use --force to overwrite`);
    }
    for (const f of p.failed) lines.push(`    FAILED ${f.date}: ${f.error}`);
  }
  console.log(lines.join("\n"));
}

// CLI entrypoint: only runs when invoked directly (same guard as scripts/rbac-sync.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: BackfillFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[backfill:snapshots] ${(error as Error).message}`);
    process.exit(2);
  }
  runBackfill(flags)
    .then((summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      return prisma.$disconnect().then(() => summary.totals.failed);
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[backfill:snapshots] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
