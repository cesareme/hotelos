import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes
} from "node:crypto";

// Envelope encryption helpers for PII fields stored on Guest /
// GuestRegisterRecord rows.
//
// Format produced by encryptField():
//   v1.{iv-hex}.{ciphertext-hex}.{authTag-hex}
//
// "v1" is a key-version prefix. When the master key rotates, future
// writes will use a "v2" envelope while existing "v1" rows remain
// decryptable until a backfill job re-encrypts them. The decrypt path
// dispatches on the prefix.
//
// The master key is read from HOTELOS_FIELD_KEY (base64-encoded, 32
// raw bytes once decoded). Generate one with: openssl rand -base64 32
//
// Fallback behaviour: if HOTELOS_FIELD_KEY is missing or invalid, the
// encrypt/decrypt helpers are transparent no-ops (returning their input
// unchanged) and log a single warning. This keeps local dev frictionless.
// Production deployments MUST set the key.

const VERSION_PREFIX = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const KEY_LENGTH = 32; // 256-bit key

let warnedAboutMissingKey = false;

function emitMissingKeyWarning(reason: string): void {
  if (warnedAboutMissingKey) return;
  warnedAboutMissingKey = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[crypto-fields] ${reason} PII fields will be stored in plaintext. ` +
      "Acceptable for local development only — production MUST set HOTELOS_FIELD_KEY " +
      "(generate with: openssl rand -base64 32)."
  );
}

function loadKey(): Buffer | null {
  // Accept ENCRYPTION_KEY as a fallback so a single env var configured in
  // .env works without renaming. HOTELOS_FIELD_KEY takes precedence.
  const raw = process.env.HOTELOS_FIELD_KEY ?? process.env.ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    emitMissingKeyWarning("HOTELOS_FIELD_KEY is not set;");
    return null;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    emitMissingKeyWarning("HOTELOS_FIELD_KEY could not be decoded as base64;");
    return null;
  }
  if (buf.length !== KEY_LENGTH) {
    emitMissingKeyWarning(
      `HOTELOS_FIELD_KEY must decode to ${KEY_LENGTH} raw bytes (got ${buf.length});`
    );
    return null;
  }
  return buf;
}

export function isCiphertext(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${VERSION_PREFIX}.`);
}

export function encryptField(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== "string") return plaintext;
  // Already encrypted — don't double-wrap.
  if (isCiphertext(plaintext)) return plaintext;
  const key = loadKey();
  if (!key) return plaintext;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION_PREFIX}.${iv.toString("hex")}.${ciphertext.toString("hex")}.${authTag.toString("hex")}`;
}

export function decryptField(ciphertext: string | null | undefined): string | null | undefined {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  if (typeof ciphertext !== "string") return ciphertext;
  // Plaintext rows pre-encryption — pass through.
  if (!isCiphertext(ciphertext)) return ciphertext;
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new Error(`Unrecognized ciphertext envelope: ${parts[0] ?? "<empty>"}`);
  }
  const key = loadKey();
  if (!key) {
    // Encrypted value but no key configured — surface the raw envelope
    // rather than crashing every read.
    return ciphertext;
  }
  const iv = Buffer.from(parts[1]!, "hex");
  const data = Buffer.from(parts[2]!, "hex");
  const authTag = Buffer.from(parts[3]!, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}

// Field map consumed by the Prisma client extension. Keep in sync with
// the schema — when you add a new PII column to Guest or
// GuestRegisterRecord, register it here.
//
// Note: the Sprint 32 spec referenced Guest.taxId / Guest.phoneMobile,
// but those columns do not exist on the Guest model (Guest has
// documentNumber / phone). We wrap the PII fields that actually exist.
// When taxId / phoneMobile land on Guest, append them here.
export const PII_FIELDS: Record<string, readonly string[]> = {
  Guest: [
    "email",
    "documentNumber",
    "documentSupportNumber",
    "phone",
    "mobilePhone",
    "residenceAddress",
    "emergencyContactName",
    "emergencyContactPhone",
    "notes"
  ],
  GuestRegisterRecord: [
    "documentNumber",
    "residenceFullAddress",
    "email",
    "phoneMobile",
    "phoneLandline"
  ],
  // OAuth refresh token + IMAP password for email connectors, encrypted at rest.
  EmailConnection: ["oauthRefreshToken", "imapPassword"],
  // Payment Service Provider references — opaque tokens that can be replayed
  // against the PSP to fetch transaction details, so we treat them as PII.
  Payment: ["pspReference"],
  PaymentIntent: ["providerReference"],
  // Secret-manager pointer for PSP credentials (Stripe/Adyen/etc.).
  PaymentProviderConnection: ["credentialsSecretRef"],
  // Stored card tokens (redsys/stripe/adyen) — the tokenRef can be replayed
  // against the PSP to charge the cardholder, so we encrypt it at rest.
  PaymentToken: ["tokenRef"]
};

// Test-only helper: reset the one-time warning latch so unit tests can
// observe the warning on demand.
export function __resetCryptoWarningForTests(): void {
  warnedAboutMissingKey = false;
  warnedAboutMissingLookupKey = false;
}

// ---------------------------------------------------------------------------
// Deterministic lookup-hash columns (Sprint 34)
//
// Because PII columns are now stored as AES-GCM ciphertext, equality
// lookups like `findFirst({ where: { email: "..." } })` can't hit an
// index any more (every encrypt picks a fresh IV, so the on-disk value
// differs every write). We mirror each PII column to a sibling
// `*LookupHash` column that holds a deterministic HMAC-SHA256 of the
// normalized plaintext (lower(trim(value))). The hash is keyed (not a
// bare SHA-256) so a leak of the column alone is not a rainbow table.
//
// Key source: HOTELOS_LOOKUP_HASH_KEY if set, else HOTELOS_FIELD_KEY.
// Both are read as base64 (32 raw bytes). The HMAC accepts any key
// length, but we require non-empty input so a fully-unconfigured env
// returns null — signalling the caller to skip writing a hash.
// ---------------------------------------------------------------------------

// Sibling lookup-hash column for each searchable PII field. Keys are
// plaintext PII field names (as they appear in `data: { ... }` payloads);
// values are the corresponding `*LookupHash` column on the same row.
export const LOOKUP_HASH_FIELDS = {
  Guest: {
    email: "emailLookupHash",
    phone: "phoneLookupHash",
    documentNumber: "documentNumberLookupHash"
  },
  GuestRegisterRecord: {
    email: "emailLookupHash",
    phoneMobile: "phoneMobileLookupHash",
    documentNumber: "documentNumberLookupHash"
  }
} as const;

export type LookupHashModel = keyof typeof LOOKUP_HASH_FIELDS;

let warnedAboutMissingLookupKey = false;

function emitMissingLookupKeyWarning(): void {
  if (warnedAboutMissingLookupKey) return;
  warnedAboutMissingLookupKey = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[crypto-fields] neither HOTELOS_LOOKUP_HASH_KEY nor HOTELOS_FIELD_KEY is set; " +
      "lookup-hash columns will be left null and equality lookups on encrypted PII " +
      "will not work. Acceptable for local development only."
  );
}

function loadLookupHashKey(): Buffer | null {
  const raw = process.env.HOTELOS_LOOKUP_HASH_KEY ?? process.env.HOTELOS_FIELD_KEY ?? process.env.ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    emitMissingLookupKeyWarning();
    return null;
  }
  // Prefer base64 decoding so the same env value used for HOTELOS_FIELD_KEY
  // works here. If it isn't valid base64, fall back to using the raw string
  // bytes — HMAC accepts arbitrary key material.
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length > 0) return decoded;
  } catch {
    // fall through
  }
  return Buffer.from(raw, "utf8");
}

function normalizeForLookup(plaintext: string): string {
  return plaintext.trim().toLowerCase();
}

/**
 * Deterministic HMAC-SHA256 hash of a normalized PII value, suitable
 * for storing in a `*LookupHash` sibling column. Returns `null` when:
 *   - the input is null/undefined/empty (after trim), OR
 *   - no lookup-hash key is configured (logs a one-time warning).
 *
 * The hash is intentionally case- and whitespace-insensitive (we lower +
 * trim before hashing) so callers can search with whatever casing the
 * user typed.
 */
export function computeLookupHash(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  if (typeof plaintext !== "string") return null;
  const normalized = normalizeForLookup(plaintext);
  if (normalized === "") return null;
  const key = loadLookupHashKey();
  if (!key) return null;
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

// Helpers used by the Prisma client extension to walk argument trees.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function encryptArgsForModel(modelName: string, args: unknown): unknown {
  const fields = PII_FIELDS[modelName];
  if (!fields || !isPlainObject(args)) return args;
  const next: Record<string, unknown> = { ...args };
  const hashMap = (LOOKUP_HASH_FIELDS as Record<string, Record<string, string>>)[modelName] ?? {};

  // create: { data: {...} | [{...}, ...] }
  // createMany: { data: [...] | {...} }
  // update / upsert: { data: {...} } and upsert.create
  // updateMany: { data: {...} }
  const dataKeys = ["data", "create", "update"] as const;
  for (const key of dataKeys) {
    const value = next[key];
    if (Array.isArray(value)) {
      next[key] = value.map((row) => encryptDataRow(fields, hashMap, row));
    } else if (isPlainObject(value)) {
      next[key] = encryptDataRow(fields, hashMap, value);
    }
  }
  return next;
}

function encryptDataRow(
  fields: readonly string[],
  hashMap: Record<string, string>,
  row: unknown
): unknown {
  if (!isPlainObject(row)) return row;
  const out: Record<string, unknown> = { ...row };
  for (const field of fields) {
    const v = out[field];
    const hashColumn = hashMap[field];
    if (typeof v === "string") {
      // Plaintext incoming: compute hash from the raw value BEFORE
      // encrypting (or pass through if it's already ciphertext).
      if (hashColumn !== undefined) {
        if (isCiphertext(v)) {
          // Already encrypted — caller is migrating ciphertext rows or
          // passing values through. Don't overwrite an existing hash
          // unless the caller explicitly set one.
          if (out[hashColumn] === undefined) {
            // Leave it; we can't hash ciphertext.
          }
        } else {
          const hash = computeLookupHash(v);
          if (hash !== null) out[hashColumn] = hash;
        }
      }
      out[field] = encryptField(v);
    } else if (isPlainObject(v) && typeof v.set === "string") {
      // Prisma update operator: { set: "value" }
      const plain = v.set;
      if (hashColumn !== undefined && !isCiphertext(plain)) {
        const hash = computeLookupHash(plain);
        if (hash !== null) out[hashColumn] = hash;
      }
      out[field] = { ...v, set: encryptField(plain) };
    } else if (v === null) {
      // Explicit null write: clear the sibling hash too.
      if (hashColumn !== undefined && !(hashColumn in out)) {
        out[hashColumn] = null;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where-clause rewrite (Sprint 34)
//
// When a caller writes `findFirst({ where: { email: "x@y" } })`, the
// raw `email` value won't match anything in the table because we now
// store ciphertext (with a fresh IV per write). We rewrite each PII
// field reference into its `*LookupHash` sibling using the deterministic
// hash. The rewrite is recursive over AND/OR/NOT trees.
//
// Skipped cases:
//   - value already looks like ciphertext (defensive; e.g. internal
//     migrations may pass through envelopes intentionally).
//   - the lookup-hash key is unset (computeLookupHash returns null) —
//     we leave the where untouched, which on a freshly-encrypted row
//     will simply return no match. That's the same failure mode users
//     would see without the hash and signals a misconfiguration.
//   - Prisma operators other than equality (e.g. `contains`, `startsWith`,
//     `endsWith`, `in`, `mode: "insensitive"`) — those genuinely can't
//     work over ciphertext. We rewrite `in: [...]` because it is also
//     equality-shaped; other operators are passed through unchanged.
// ---------------------------------------------------------------------------

const WHERE_BRANCH_KEYS = ["AND", "OR", "NOT"] as const;

function rewriteWhereNode(hashMap: Record<string, string>, node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => rewriteWhereNode(hashMap, child));
  }
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = { ...node };
  for (const branch of WHERE_BRANCH_KEYS) {
    if (branch in out) {
      out[branch] = rewriteWhereNode(hashMap, out[branch]);
    }
  }
  for (const [field, hashColumn] of Object.entries(hashMap)) {
    if (!(field in out)) continue;
    const value = out[field];
    if (typeof value === "string") {
      if (isCiphertext(value)) continue;
      const hash = computeLookupHash(value);
      if (hash === null) continue;
      delete out[field];
      out[hashColumn] = hash;
    } else if (isPlainObject(value)) {
      // Handle { equals: "x" } and { in: ["x", "y"] }. Other operators
      // (contains/startsWith/endsWith/not/lt/gt/...) cannot work over
      // ciphertext; leave them as-is so callers see SQL-level no-match
      // rather than incorrect results.
      const opEntries = Object.entries(value);
      if (opEntries.length === 1) {
        const [op, opValue] = opEntries[0]!;
        if (op === "equals" && typeof opValue === "string" && !isCiphertext(opValue)) {
          const hash = computeLookupHash(opValue);
          if (hash !== null) {
            delete out[field];
            out[hashColumn] = hash;
            continue;
          }
        }
        if (op === "in" && Array.isArray(opValue)) {
          const hashes: string[] = [];
          let allHashable = true;
          for (const item of opValue) {
            if (typeof item !== "string" || isCiphertext(item)) {
              allHashable = false;
              break;
            }
            const h = computeLookupHash(item);
            if (h === null) {
              allHashable = false;
              break;
            }
            hashes.push(h);
          }
          if (allHashable) {
            delete out[field];
            out[hashColumn] = { in: hashes };
          }
        }
      }
    }
  }
  return out;
}

export function rewriteWhereForModel(modelName: string, args: unknown): unknown {
  const hashMap = (LOOKUP_HASH_FIELDS as Record<string, Record<string, string>>)[modelName];
  if (!hashMap || !isPlainObject(args)) return args;
  const next: Record<string, unknown> = { ...args };
  if ("where" in next && isPlainObject(next.where)) {
    next.where = rewriteWhereNode(hashMap, next.where);
  }
  return next;
}

export function decryptResultForModel<T>(modelName: string, result: T): T {
  const fields = PII_FIELDS[modelName];
  if (!fields || result === null || result === undefined) return result;
  if (Array.isArray(result)) {
    return result.map((row) => decryptResultRow(fields, row)) as unknown as T;
  }
  return decryptResultRow(fields, result) as T;
}

function decryptResultRow(fields: readonly string[], row: unknown): unknown {
  if (!isPlainObject(row)) return row;
  const out: Record<string, unknown> = { ...row };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === "string" && isCiphertext(v)) {
      try {
        out[field] = decryptField(v);
      } catch {
        // Leave the envelope untouched on failure rather than blowing up
        // the whole query — the operator can investigate the row.
        out[field] = v;
      }
    }
  }
  return out;
}
