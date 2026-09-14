// Guest register (parte de viajeros) backfill CLI (Tanda 3 · QC-01).
//
// Until Tanda 3 the API kept the partes in memory and only mirrored ten
// columns to Prisma on creation: every persisted row is `draft` with an empty
// validationErrorsJson even when it was signed, validated or sent, and a
// restart could create a second parte for the same (reservation, guest). Now
// that every read goes to Prisma, this command:
//   1. re-validates each row with validateSpainGuestRegisterRecord over its
//      persisted columns and writes status + validationErrorsJson +
//      requiredPayloadJson (pipeline-owned statuses such as accepted or
//      queued are preserved; only draft/missing_data/ready_* are recomputed;
//      a row with an accepted SES submission becomes `accepted`);
//   2. deduplicates by (reservationId, guestId): the keeper is the row with an
//      accepted SES submission, else the most advanced status, else the oldest;
//      the others are NOT deleted — they are marked status `expired` with
//      requiredPayloadJson.duplicateOf = <keeper id>.
//
// Usage (from apps/api, DATABASE_URL + field key in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-guest-register.ts \
//     [--apply] [--property <id>] [--batch <n>] [--json]
//
//   (default)         DRY-RUN: report what would change, write nothing
//   --apply           write the changes
//   --property <id>   only that property
//   --batch <n>       rows per page (default 500)
//   --json            machine-readable output
//
// Idempotent: a second run finds nothing to change (duplicates already carry
// duplicateOf and status expired; statuses already match the validator).
//
// Exit codes: 0 ok · 1 failure (DB unreachable, any row failed) · 2 unknown
// flag / invalid argument.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  blockingIssueCodes,
  deriveGuestRegisterStatus,
  guestRegisterValidationInput,
  validateSpainGuestRegisterRecord,
  type SpainGuestRegisterValidationIssue
} from "@hotelos/compliance";
import { prisma, type Prisma } from "@hotelos/database";

export type GuestRegisterBackfillFlags = {
  apply: boolean;
  propertyId: string | null;
  batch: number;
  json: boolean;
};

const DEFAULT_BATCH = 500;

export function parseFlags(argv: readonly string[]): GuestRegisterBackfillFlags {
  const flags: GuestRegisterBackfillFlags = { apply: false, propertyId: null, batch: DEFAULT_BATCH, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--dry-run") flags.apply = false;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--property") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error('Flag "--property" requires a value.');
      i++;
      flags.propertyId = v;
    } else if (arg === "--batch") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error('Flag "--batch" requires a value.');
      i++;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error("--batch must be an integer between 1 and 5000.");
      flags.batch = n;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --apply, --dry-run, --property <id>, --batch <n>, --json.`);
  }
  return flags;
}

// ───────────────────────────────────────────── pure planner

/** What the planner needs to know about one row (no Prisma types: testable). */
export type PlanRow = {
  id: string;
  reservationId: string | null;
  guestId: string | null;
  status: string;
  createdAt: Date;
  signedAt: Date | string | null;
  /** requiredPayloadJson.duplicateOf already written by a previous run. */
  duplicateOf: string | null;
  /** The MIR accepted a comunicación for this row. */
  hasAcceptedSubmission: boolean;
  /** Issue codes currently stored in validationErrorsJson. */
  storedIssueCodes: string[];
  validation: { valid: boolean; status: string; issues: SpainGuestRegisterValidationIssue[] };
};

export type PlanStatusUpdate = { id: string; fromStatus: string; toStatus: string; issueCodes: string[] };
export type PlanDuplicate = { id: string; duplicateOf: string; fromStatus: string };

export type BackfillPlan = {
  statusUpdates: PlanStatusUpdate[];
  duplicates: PlanDuplicate[];
  unchanged: number;
};

/** Higher = more advanced in the legal pipeline; the keeper of a duplicate group is the most advanced row. */
const STATUS_RANK: Record<string, number> = {
  accepted: 100,
  submitted: 90,
  exported: 80,
  queued: 70,
  signed: 60,
  ready_to_submit: 50,
  ready_to_sign: 40,
  corrected: 35,
  missing_data: 30,
  draft: 20,
  rejected: 15,
  failed: 10,
  annulled: 5,
  expired: 0
};

function rank(status: string): number {
  return STATUS_RANK[status] ?? 0;
}

export function chooseKeeper(group: PlanRow[]): PlanRow {
  return [...group].sort((a, b) => {
    if (a.hasAcceptedSubmission !== b.hasAcceptedSubmission) return a.hasAcceptedSubmission ? -1 : 1;
    const byRank = rank(b.status) - rank(a.status);
    if (byRank !== 0) return byRank;
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreated !== 0) return byCreated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}

function sameCodes(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...a].sort();
  const other = [...b].sort();
  return sorted.every((code, index) => code === other[index]);
}

/**
 * Pure decision: which rows get a new status/errors and which are duplicates.
 * Duplicates are decided first so a duplicate never receives a status update.
 */
export function planGuestRegisterBackfill(rows: PlanRow[]): BackfillPlan {
  const groups = new Map<string, PlanRow[]>();
  for (const row of rows) {
    if (!row.reservationId || !row.guestId) continue;
    const key = `${row.reservationId}|${row.guestId}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const duplicates: PlanDuplicate[] = [];
  const duplicateIds = new Set<string>();
  for (const group of groups.values()) {
    const live = group.filter((row) => !row.duplicateOf);
    if (live.length < 2) {
      // Rows already marked as duplicates by a previous run stay as they are.
      for (const row of group) if (row.duplicateOf) duplicateIds.add(row.id);
      continue;
    }
    const keeper = chooseKeeper(live);
    for (const row of group) {
      if (row.id === keeper.id) continue;
      duplicateIds.add(row.id);
      if (row.duplicateOf && row.status === "expired") continue; // idempotent
      duplicates.push({ id: row.id, duplicateOf: keeper.id, fromStatus: row.status });
    }
  }

  const statusUpdates: PlanStatusUpdate[] = [];
  let unchanged = 0;
  for (const row of rows) {
    if (duplicateIds.has(row.id) || row.duplicateOf) continue;
    // A row the MIR already accepted is `accepted` whatever the columns say
    // (the pipeline never synced the status before Tanda 3).
    const toStatus = row.hasAcceptedSubmission
      ? "accepted"
      : deriveGuestRegisterStatus({
          currentStatus: row.status,
          validationValid: row.validation.valid,
          validationStatus: row.validation.status,
          signedAt: row.signedAt,
          blockingIssueCodes: blockingIssueCodes(row.validation.issues)
        });
    const issueCodes = row.validation.issues.map((issue) => issue.code);
    if (toStatus === row.status && sameCodes(issueCodes, row.storedIssueCodes)) {
      unchanged++;
      continue;
    }
    statusUpdates.push({ id: row.id, fromStatus: row.status, toStatus, issueCodes });
  }
  return { statusUpdates, duplicates, unchanged };
}

// ───────────────────────────────────────────── runner

export type GuestRegisterBackfillSummary = {
  dryRun: boolean;
  propertyId: string | null;
  scanned: number;
  statusUpdates: number;
  duplicates: number;
  unchanged: number;
  byStatus: Record<string, number>;
  failed: Array<{ id: string; error: string }>;
  plan: BackfillPlan;
  durationMs: number;
};

type Row = Awaited<ReturnType<typeof prisma.guestRegisterRecord.findUniqueOrThrow>>;

type Validation = ReturnType<typeof validateSpainGuestRegisterRecord>;

function toPlanRow(row: Row, acceptedIds: ReadonlySet<string>, validation: Validation): PlanRow {
  const payload = row.requiredPayloadJson && typeof row.requiredPayloadJson === "object" && !Array.isArray(row.requiredPayloadJson)
    ? (row.requiredPayloadJson as Record<string, unknown>)
    : {};
  const stored = Array.isArray(row.validationErrorsJson) ? (row.validationErrorsJson as Array<{ code?: unknown }>) : [];
  return {
    id: row.id,
    reservationId: row.reservationId,
    guestId: row.guestId,
    status: row.status,
    createdAt: row.createdAt,
    signedAt: row.signedAt,
    duplicateOf: typeof payload.duplicateOf === "string" ? payload.duplicateOf : null,
    hasAcceptedSubmission: acceptedIds.has(row.id),
    storedIssueCodes: stored.map((issue) => String(issue.code ?? "")),
    validation: { valid: validation.valid, status: validation.status, issues: validation.issues }
  };
}

export async function runGuestRegisterBackfill(flags: GuestRegisterBackfillFlags): Promise<GuestRegisterBackfillSummary> {
  const start = Date.now();
  const where: Prisma.GuestRegisterRecordWhereInput = flags.propertyId ? { propertyId: flags.propertyId } : {};

  // Load every row (paged) — the dedupe needs the whole (reservation, guest)
  // group in memory, and the table is small (partes of a few hotels).
  const rows: Row[] = [];
  let cursor: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page: Row[] = await prisma.guestRegisterRecord.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: flags.batch
    });
    if (page.length === 0) break;
    rows.push(...page);
    cursor = page[page.length - 1]!.id;
    if (page.length < flags.batch) break;
  }
  const accepted = await prisma.sesHospedajesSubmission.findMany({
    where: { status: "accepted", guestRegisterRecordId: { in: rows.map((row) => row.id) } },
    select: { guestRegisterRecordId: true }
  });
  const acceptedIds = new Set(accepted.map((row) => row.guestRegisterRecordId));
  const validated = new Map<string, Validation>();
  const planRows = rows.map((row) => {
    const validation = validateSpainGuestRegisterRecord(guestRegisterValidationInput(row));
    validated.set(row.id, validation);
    return toPlanRow(row, acceptedIds, validation);
  });
  const plan = planGuestRegisterBackfill(planRows);

  const summary: GuestRegisterBackfillSummary = {
    dryRun: !flags.apply,
    propertyId: flags.propertyId,
    scanned: rows.length,
    statusUpdates: plan.statusUpdates.length,
    duplicates: plan.duplicates.length,
    unchanged: plan.unchanged,
    byStatus: {},
    failed: [],
    plan,
    durationMs: 0
  };
  for (const update of plan.statusUpdates) summary.byStatus[update.toStatus] = (summary.byStatus[update.toStatus] ?? 0) + 1;
  if (plan.duplicates.length) summary.byStatus.expired = (summary.byStatus.expired ?? 0) + plan.duplicates.length;

  if (flags.apply) {
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    for (const update of plan.statusUpdates) {
      const validation = validated.get(update.id)!;
      try {
        await prisma.guestRegisterRecord.update({
          where: { id: update.id },
          data: {
            status: update.toStatus as Row["status"],
            validationErrorsJson: validation.issues as unknown as Prisma.InputJsonValue,
            requiredPayloadJson: validation.payload as Prisma.InputJsonValue
          }
        });
      } catch (error) {
        summary.failed.push({ id: update.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const duplicate of plan.duplicates) {
      const row = byId.get(duplicate.id)!;
      const payload = row.requiredPayloadJson && typeof row.requiredPayloadJson === "object" && !Array.isArray(row.requiredPayloadJson)
        ? (row.requiredPayloadJson as Record<string, unknown>)
        : {};
      try {
        await prisma.guestRegisterRecord.update({
          where: { id: duplicate.id },
          data: {
            status: "expired",
            requiredPayloadJson: { ...payload, duplicateOf: duplicate.duplicateOf, duplicateMarkedAt: new Date().toISOString() } as Prisma.InputJsonValue
          }
        });
      } catch (error) {
        summary.failed.push({ id: duplicate.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  summary.durationMs = Date.now() - start;
  return summary;
}

function printHuman(summary: GuestRegisterBackfillSummary): void {
  const mode = summary.dryRun ? "DRY-RUN (no writes) — re-run with --apply to write" : "APPLIED";
  const lines = [
    `[backfill:guest-register] ${mode} · ${summary.propertyId ? `property ${summary.propertyId}` : "all properties"} · ${summary.durationMs} ms`,
    `  scanned ${summary.scanned} partes · ${summary.dryRun ? "would update" : "updated"} ${summary.statusUpdates} status/errors · ${summary.dryRun ? "would mark" : "marked"} ${summary.duplicates} duplicates · unchanged ${summary.unchanged} · failed ${summary.failed.length}`,
    `  target statuses: ${Object.entries(summary.byStatus).map(([status, count]) => `${status}=${count}`).join(", ") || "-"}`
  ];
  for (const update of summary.plan.statusUpdates) {
    lines.push(`    ${update.id}: ${update.fromStatus} → ${update.toStatus}${update.issueCodes.length ? ` (${update.issueCodes.join(", ")})` : ""}`);
  }
  for (const duplicate of summary.plan.duplicates) {
    lines.push(`    ${duplicate.id}: ${duplicate.fromStatus} → expired (duplicateOf ${duplicate.duplicateOf})`);
  }
  for (const f of summary.failed) lines.push(`    FAILED ${f.id}: ${f.error}`);
  console.log(lines.join("\n"));
}

// CLI entrypoint: only runs when invoked directly (same guard as backfill-snapshots.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: GuestRegisterBackfillFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[backfill:guest-register] ${(error as Error).message}`);
    process.exit(2);
  }
  runGuestRegisterBackfill(flags)
    .then((summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      return prisma.$disconnect().then(() => summary.failed.length);
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[backfill:guest-register] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
