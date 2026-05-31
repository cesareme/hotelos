// Envelope encryption service for PII fields.
//
// The runtime implementation lives in @hotelos/database (so the Prisma
// client extension in packages/database/src/client.ts can call it
// without a cyclic apps/api → packages/database import). This module
// is the API-facing facade callers should import.
//
// Format: v1.{iv-hex}.{ciphertext-hex}.{authTag-hex}
// Algorithm: AES-256-GCM with a 96-bit IV.
//
// Key source: HOTELOS_FIELD_KEY env var (base64, 32 raw bytes once
// decoded). Generate one with: openssl rand -base64 32
//
// "v1" is a key-version prefix. Future master-key rotations will write
// v2 envelopes while v1 rows stay readable until a backfill rewrites
// them.
//
// Fallback: when the env var is missing or malformed, the helpers act
// as a pass-through and log a single warning. Production deployments
// MUST set HOTELOS_FIELD_KEY.

export {
  encryptField,
  decryptField,
  isCiphertext,
  PII_FIELDS,
  LOOKUP_HASH_FIELDS,
  computeLookupHash,
  __resetCryptoWarningForTests
} from "@hotelos/database";
