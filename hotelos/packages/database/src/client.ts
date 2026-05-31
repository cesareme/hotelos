import { Prisma, PrismaClient } from "@prisma/client";
import {
  PII_FIELDS,
  decryptResultForModel,
  encryptArgsForModel,
  rewriteWhereForModel
} from "./crypto-fields.js";

type GlobalWithPrisma = typeof globalThis & {
  __hotelosPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

// Prisma 5+ removed `prisma.$use(...)` (the old middleware API). We
// achieve the same transparent encrypt-on-write / decrypt-on-read
// behaviour with a `$extends` query component: on configured PII fields
// of Guest and GuestRegisterRecord, write operations encrypt incoming
// values, and read operations decrypt outgoing ciphertext envelopes.
// Plaintext (legacy) values are passed through unchanged so existing
// rows keep working until a one-shot backfill job is run.
const ENCRYPTED_MODELS = Object.keys(PII_FIELDS) as readonly Prisma.ModelName[];

const READ_OPS = new Set<string>(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany"]);
const WRITE_OPS = new Set<string>([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert"
]);
// Operations whose `where` clause may reference plaintext PII fields
// and must be rewritten to the deterministic *LookupHash sibling.
const WHERE_REWRITE_OPS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany"
]);

// Set of PascalCase model names whose PII columns must be encrypted.
// `model` inside a `$allModels` query extension is the PascalCase model
// name (e.g. "Guest"), which matches the PII_FIELDS keys directly.
const ENCRYPTED_MODEL_SET = new Set<string>(ENCRYPTED_MODELS as unknown as string[]);

function applyEncryptionExtension(client: PrismaClient): PrismaClient {
  // IMPORTANT: a per-model `query: { Guest: { ... } }` map keyed by the
  // PascalCase model name does NOT fire in Prisma 6.x — the per-model
  // form requires the lowercase *delegate* name (`guest`). To avoid that
  // casing footgun entirely we use the `$allModels` / `$allOperations`
  // form, which receives the PascalCase `model` name and the operation,
  // and we filter to the encrypted models ourselves. This guarantees the
  // encrypt-on-write / decrypt-on-read hooks actually run.
  const handler = async ({
    model,
    operation,
    args,
    query
  }: {
    model?: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
  }): Promise<unknown> => {
    if (!model || !ENCRYPTED_MODEL_SET.has(model)) {
      return query(args);
    }
    // 1) Rewrite where-clauses that reference plaintext PII fields to use
    //    their deterministic *LookupHash sibling.
    let transformedArgs = WHERE_REWRITE_OPS.has(operation)
      ? rewriteWhereForModel(model, args)
      : args;
    // 2) Encrypt incoming `data` / `create` / `update` payloads and set
    //    the *LookupHash siblings on writes.
    if (WRITE_OPS.has(operation)) {
      transformedArgs = encryptArgsForModel(model, transformedArgs);
    }
    const result = await query(transformedArgs);
    if (READ_OPS.has(operation) || WRITE_OPS.has(operation)) {
      return decryptResultForModel(model, result);
    }
    return result;
  };

  // The `$extends` argument type is deeply branded; we pass a structurally
  // correct override and cast both ends back to PrismaClient (the
  // extension preserves all model delegates).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extended = (client.$extends as any)({
    name: "hotelos-pii-encryption",
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $allOperations: handler as any
      }
    }
  }) as unknown as PrismaClient;
  return extended;
}

function createPrismaClient(): PrismaClient {
  const logLevel = process.env.DATABASE_LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "warn" : "info");
  const log = logLevel === "off" ? [] : logLevel === "info" ? ["warn", "error"] : [logLevel as "info" | "warn" | "error"];
  const base = new PrismaClient({ log: log as ("query" | "info" | "warn" | "error")[] });
  return applyEncryptionExtension(base);
}

export const prisma: PrismaClient = globalForPrisma.__hotelosPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__hotelosPrisma = prisma;
}

let shutdownRegistered = false;
export function registerPrismaShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const disconnect = async () => {
    await prisma.$disconnect();
  };
  process.once("beforeExit", () => void disconnect());
  process.once("SIGINT", () => void disconnect().then(() => process.exit(0)));
  process.once("SIGTERM", () => void disconnect().then(() => process.exit(0)));
}
