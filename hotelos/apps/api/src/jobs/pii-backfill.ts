// PII backfill job (Sprint 35).
//
// Rewrites every Guest and GuestRegisterRecord row so that:
//   1. PII columns whose value is still plaintext become ciphertext
//      (via the Prisma encryption extension on write), AND
//   2. The new `*LookupHash` sibling columns are populated with the
//      deterministic HMAC of the normalised plaintext (also via the
//      extension on write).
//
// Idempotency: a row is "skipped" when every configured PII column is
// either null or already ciphertext (we detect ciphertext via
// `isCiphertext`'s `v1.` prefix). When at least one column is
// plaintext, we re-write the whole row — the extension does the work.
//
// Even when a row's PII columns are already ciphertext, its lookup-hash
// columns may still be null (for rows written before Sprint 34). The
// extension's encrypt-on-write step can't recover the hash from a
// ciphertext, so those rows are reported separately as
// "skipped-needs-hash-only": running the legacy decrypt-encrypt cycle
// against an existing ciphertext row would generate a fresh IV without
// changing the plaintext, but would NOT populate the hash, because
// encryptArgsForModel only hashes plaintext incoming values. We handle
// those rows by decrypting the row in-memory and re-writing the
// plaintext — the extension then encrypts (with a new IV) AND writes
// the hash. This costs an extra read per row but is safe and correct.
//
// CLI: pnpm --filter @hotelos/api exec tsx src/jobs/pii-backfill.ts
// Or: pnpm --filter @hotelos/api run backfill:pii

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  isCiphertext,
  PII_FIELDS,
  LOOKUP_HASH_FIELDS,
  prisma
} from "@hotelos/database";

const BATCH_SIZE = 500;

export type PiiBackfillSummary = {
  guestsScanned: number;
  guestsEncrypted: number;
  guestsHashOnly: number;
  guestRegisterRecordsScanned: number;
  guestRegisterRecordsEncrypted: number;
  guestRegisterRecordsHashOnly: number;
  durationMs: number;
};

type PrismaDelegate = {
  findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
  update: (args: unknown) => Promise<unknown>;
};

type ModelSpec = {
  modelName: "Guest" | "GuestRegisterRecord";
  delegate: PrismaDelegate;
  logLabel: string;
};

// Direct raw fetch via $queryRawUnsafe — we need to see ciphertext
// without the extension intercepting. The extension only attaches to
// model delegates; raw queries bypass it.
async function fetchRawBatch(
  modelName: "Guest" | "GuestRegisterRecord",
  cursorId: string | null,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const tableName = modelName === "Guest" ? "guests" : "guest_register_records";
  const piiColumns = (PII_FIELDS[modelName] ?? []).map((f) => snakeCase(f));
  const hashMap = (LOOKUP_HASH_FIELDS as Record<string, Record<string, string>>)[modelName] ?? {};
  const hashColumns = Object.values(hashMap).map((c) => snakeCase(c));
  const cols = ["id", ...piiColumns, ...hashColumns]
    .map((c) => `"${c}"`)
    .join(", ");
  const where = cursorId ? `WHERE "id" > '${cursorId.replace(/'/g, "''")}'` : "";
  const sql = `SELECT ${cols} FROM "${tableName}" ${where} ORDER BY "id" ASC LIMIT ${limit}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (prisma as any).$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;
  return rows;
}

function snakeCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

async function backfillModel(spec: ModelSpec): Promise<{
  scanned: number;
  encrypted: number;
  hashOnly: number;
}> {
  const { modelName, delegate, logLabel } = spec;
  const piiFields = PII_FIELDS[modelName] ?? [];
  const hashMap = (LOOKUP_HASH_FIELDS as Record<string, Record<string, string>>)[modelName] ?? {};

  let cursorId: string | null = null;
  let scanned = 0;
  let encrypted = 0;
  let hashOnly = 0;

  // We need raw on-disk values to tell plaintext from ciphertext. The
  // model delegate decrypts ciphertext transparently on read, which
  // would conflate the two states. We use a raw SELECT to inspect each
  // row's storage form, then call the model delegate's `update` so the
  // extension applies encrypt + hash for us.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rawRows = await fetchRawBatch(modelName, cursorId, BATCH_SIZE);
    if (rawRows.length === 0) break;
    cursorId = rawRows[rawRows.length - 1]!.id as string;

    for (const raw of rawRows) {
      scanned += 1;
      const data: Record<string, unknown> = {};
      let hasPlaintext = false;
      let hasMissingHash = false;

      for (const field of piiFields) {
        const dbCol = snakeCase(field);
        const value = raw[dbCol];
        if (value == null) continue;
        if (typeof value !== "string") continue;
        if (isCiphertext(value)) {
          // Ciphertext on disk — does the sibling hash also exist?
          const hashColumn = hashMap[field];
          if (hashColumn !== undefined) {
            const hashDbCol = snakeCase(hashColumn);
            if (raw[hashDbCol] == null) {
              hasMissingHash = true;
              // Decrypt-then-re-encrypt rewrites the row and the
              // extension will populate the hash from the plaintext we
              // pass in. We need the actual plaintext for that; fetch
              // via the (decrypting) delegate below.
            }
          }
          continue;
        }
        // Plaintext on disk — schedule a re-write; the extension will
        // encrypt + hash on update.
        data[field] = value;
        hasPlaintext = true;
      }

      if (hasPlaintext) {
        await delegate.update({ where: { id: raw.id }, data });
        encrypted += 1;
        continue;
      }

      if (hasMissingHash) {
        // Read via the delegate (decrypts on read), then re-write the
        // plaintext we got back. The extension will encrypt with a new
        // IV AND populate the missing hash columns.
        const decryptedRows = await delegate.findMany({
          where: { id: raw.id },
          take: 1
        });
        const decrypted = decryptedRows[0];
        if (!decrypted) continue;
        const rewriteData: Record<string, unknown> = {};
        for (const field of piiFields) {
          const v = decrypted[field];
          if (typeof v === "string" && v.length > 0) {
            rewriteData[field] = v;
          }
        }
        if (Object.keys(rewriteData).length > 0) {
          await delegate.update({ where: { id: raw.id }, data: rewriteData });
          hashOnly += 1;
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[backfill] ${logLabel} ${scanned} (encrypted ${encrypted}, hash-only ${hashOnly}, skipped ${
        scanned - encrypted - hashOnly
      })`
    );

    if (rawRows.length < BATCH_SIZE) break;
  }

  return { scanned, encrypted, hashOnly };
}

export async function runPiiBackfill(): Promise<PiiBackfillSummary> {
  const start = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any;
  const guestResult = await backfillModel({
    modelName: "Guest",
    delegate: p.guest as PrismaDelegate,
    logLabel: "guest"
  });
  const grrResult = await backfillModel({
    modelName: "GuestRegisterRecord",
    delegate: p.guestRegisterRecord as PrismaDelegate,
    logLabel: "guestRegisterRecord"
  });

  const summary: PiiBackfillSummary = {
    guestsScanned: guestResult.scanned,
    guestsEncrypted: guestResult.encrypted,
    guestsHashOnly: guestResult.hashOnly,
    guestRegisterRecordsScanned: grrResult.scanned,
    guestRegisterRecordsEncrypted: grrResult.encrypted,
    guestRegisterRecordsHashOnly: grrResult.hashOnly,
    durationMs: Date.now() - start
  };
  return summary;
}

// CLI entrypoint: only runs when invoked directly (not when imported
// from server.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  runPiiBackfill()
    .then((summary) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(summary, null, 2));
      return prisma.$disconnect();
    })
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[backfill] failed:", err);
      process.exit(1);
    });
}
