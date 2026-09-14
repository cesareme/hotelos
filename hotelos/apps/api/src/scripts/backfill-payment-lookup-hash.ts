// Payment.pspReferenceLookupHash backfill CLI (Tanda 2 · PSP-IDEMPOTENCY-ENCRYPTED).
//
// Payment.pspReference is stored as AES-GCM ciphertext with a random IV, so
// markInvoicePaid's idempotency lookup `findFirst({ where: { invoiceId,
// pspReference } })` is served by the deterministic `psp_reference_lookup_hash`
// sibling column (LOOKUP_HASH_FIELDS.Payment). The Prisma encryption extension
// fills that column on every create/update from now on, but rows written
// before the column existed carry a NULL hash and are invisible to the lookup
// — a PSP retry against one of them would still create a duplicate capture.
// This command decrypts those rows through the extended Prisma client (the
// extension decrypts on read; legacy plaintext values pass through) and
// writes the HMAC for each of them.
//
// Usage (from apps/api, DATABASE_URL + HOTELOS_FIELD_KEY/ENCRYPTION_KEY in env
// or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-payment-lookup-hash.ts \
//     [--apply] [--batch <n>] [--json]
//
//   (default)      DRY-RUN: report how many rows would be hashed, write nothing
//   --apply        write the hashes
//   --batch <n>    rows per page / write transaction (default 500)
//   --json         machine-readable output
//
// Idempotent: only rows with psp_reference NOT NULL and a NULL hash are
// visited, and each write is conditional on the hash still being NULL, so
// re-running converges and never clobbers a hash written by the extension in
// the meantime. The hash key must be configured (HOTELOS_LOOKUP_HASH_KEY,
// else HOTELOS_FIELD_KEY / ENCRYPTION_KEY): --apply refuses to run without it
// because the hashes it wrote would never match the ones the API computes.
//
// Exit codes: 0 ok · 1 failure (DB unreachable, key missing on --apply, any
// row failed) · 2 unknown flag / invalid argument.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { computeLookupHash, isCiphertext, prisma } from "@hotelos/database";

export type PaymentHashBackfillFlags = {
  apply: boolean;
  batch: number;
  json: boolean;
};

export type PaymentHashBackfillSummary = {
  dryRun: boolean;
  batch: number;
  scanned: number;
  /** Rows whose hash was written (or would be, in dry-run). */
  hashed: number;
  /** Rows skipped because a concurrent writer filled the hash first (apply only). */
  raced: number;
  /** Rows whose reference is empty after trim (hash is null by definition). */
  skippedEmpty: number;
  /** Rows whose envelope could not be decrypted (wrong key?) — left untouched. */
  failed: Array<{ id: string; error: string }>;
  durationMs: number;
};

const DEFAULT_BATCH = 500;

export function parseFlags(argv: readonly string[]): PaymentHashBackfillFlags {
  const flags: PaymentHashBackfillFlags = { apply: false, batch: DEFAULT_BATCH, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--dry-run") flags.apply = false;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--batch") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error('Flag "--batch" requires a value.');
      i++;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error("--batch must be an integer between 1 and 5000.");
      flags.batch = n;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --apply, --dry-run, --batch <n>, --json.`);
  }
  return flags;
}

/** True when a lookup-hash key is configured (computeLookupHash returns null otherwise). */
export function lookupHashKeyConfigured(): boolean {
  return computeLookupHash("probe") !== null;
}

/**
 * Pure per-row decision so the classification is testable without a DB:
 * `value` is what the extended client returned (plaintext, or a still-wrapped
 * envelope when decryption failed).
 */
export function classifyReference(value: string | null): { kind: "hash"; hash: string } | { kind: "empty" } | { kind: "failed"; error: string } {
  if (value === null || value.trim() === "") return { kind: "empty" };
  if (isCiphertext(value)) return { kind: "failed", error: "psp_reference could not be decrypted with the configured key." };
  const hash = computeLookupHash(value);
  if (hash === null) return { kind: "failed", error: "no lookup-hash key configured." };
  return { kind: "hash", hash };
}

export async function runPaymentHashBackfill(flags: PaymentHashBackfillFlags): Promise<PaymentHashBackfillSummary> {
  const start = Date.now();
  if (flags.apply && !lookupHashKeyConfigured()) {
    throw new Error(
      "No lookup-hash key configured (HOTELOS_LOOKUP_HASH_KEY / HOTELOS_FIELD_KEY / ENCRYPTION_KEY); refusing to --apply."
    );
  }
  const summary: PaymentHashBackfillSummary = {
    dryRun: !flags.apply,
    batch: flags.batch,
    scanned: 0,
    hashed: 0,
    raced: 0,
    skippedEmpty: 0,
    failed: [],
    durationMs: 0
  };

  // Keyset pagination on id: in dry-run nothing changes, and even on --apply a
  // row we fail to hash stays in the candidate set, so `id > cursor` is the
  // only cursor that cannot loop.
  let cursor: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // The extension decrypts pspReference on read (legacy plaintext passes
    // through) and leaves the envelope untouched when decryption fails.
    const rows: Array<{ id: string; pspReference: string | null }> = await prisma.payment.findMany({
      where: {
        pspReference: { not: null },
        pspReferenceLookupHash: null,
        ...(cursor ? { id: { gt: cursor } } : {})
      },
      select: { id: true, pspReference: true },
      orderBy: { id: "asc" },
      take: flags.batch
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    summary.scanned += rows.length;

    const writes: Array<{ id: string; hash: string }> = [];
    for (const row of rows) {
      const decision = classifyReference(row.pspReference ?? null);
      if (decision.kind === "empty") summary.skippedEmpty++;
      else if (decision.kind === "failed") summary.failed.push({ id: row.id, error: decision.error });
      else writes.push({ id: row.id, hash: decision.hash });
    }

    if (!flags.apply) {
      summary.hashed += writes.length;
    } else if (writes.length > 0) {
      // Conditional on the hash still being NULL: a payment updated by the API
      // between our read and this write already got its hash from the
      // extension and must not be overwritten.
      const results = await prisma.$transaction(
        writes.map((w) =>
          prisma.payment.updateMany({
            where: { id: w.id, pspReferenceLookupHash: null },
            data: { pspReferenceLookupHash: w.hash }
          })
        )
      );
      for (const r of results) {
        if (r.count === 1) summary.hashed++;
        else summary.raced++;
      }
    }

    if (rows.length < flags.batch) break;
  }

  summary.durationMs = Date.now() - start;
  return summary;
}

function printHuman(summary: PaymentHashBackfillSummary): void {
  const mode = summary.dryRun ? "DRY-RUN (no writes) — re-run with --apply to write" : "APPLIED";
  const lines = [
    `[backfill:payment-hash] ${mode} · batch ${summary.batch} · ${summary.durationMs} ms`,
    `  scanned ${summary.scanned} payments with psp_reference and no lookup hash`,
    `  ${summary.dryRun ? "would hash" : "hashed"} ${summary.hashed} · raced ${summary.raced} · empty ${summary.skippedEmpty} · failed ${summary.failed.length}`
  ];
  for (const f of summary.failed) lines.push(`    FAILED ${f.id}: ${f.error}`);
  console.log(lines.join("\n"));
}

// CLI entrypoint: only runs when invoked directly (same guard as backfill-snapshots.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: PaymentHashBackfillFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[backfill:payment-hash] ${(error as Error).message}`);
    process.exit(2);
  }
  runPaymentHashBackfill(flags)
    .then((summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      return prisma.$disconnect().then(() => summary.failed.length);
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[backfill:payment-hash] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
