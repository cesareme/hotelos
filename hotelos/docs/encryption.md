# Encryption at rest for PII

Sprint 32 introduces transparent field-level encryption for PII columns on
`Guest` and `GuestRegisterRecord`. The platform stays on plain `String`
Prisma columns; encryption is applied by a Prisma client extension at
the boundary so callers do not have to think about it.

## Key generation and configuration

Generate a 256-bit master key locally:

```bash
openssl rand -base64 32
```

Set it on the API and worker processes as:

```bash
export HOTELOS_FIELD_KEY="<base64 from openssl>"
```

The key must decode to exactly **32 raw bytes**. In production it should
be sourced from a secret manager (AWS Secrets Manager, GCP Secret
Manager, Vault, etc.) and injected at boot.

If `HOTELOS_FIELD_KEY` is missing or malformed the encryption helpers
fall back to **plaintext pass-through** and log a single warning. This
keeps local development frictionless. Production deployments MUST set
the variable; you should add a startup assertion in your deployment
playbook.

## What is encrypted

The field set is centralised in `PII_FIELDS` (see
`packages/database/src/crypto-fields.ts`):

| Model                  | Encrypted columns                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `Guest`                | `email`, `documentNumber`, `phone`, `residenceAddress`                               |
| `GuestRegisterRecord`  | `documentNumber`, `residenceFullAddress`, `email`, `phoneMobile`, `phoneLandline`    |

> The Sprint 32 brief also called out `Guest.taxId` and `Guest.phoneMobile`,
> but those columns do not exist on the Guest model in `schema.prisma`
> (Guest has `documentNumber` and `phone`). When/if `taxId` / `phoneMobile`
> are added to Guest, append them to `PII_FIELDS.Guest` — no other code
> needs to change.

## Envelope format

Encrypted values are stored as:

```
v1.{iv-hex}.{ciphertext-hex}.{authTag-hex}
```

- `v1` is the **key-version prefix**.
- The cipher is `AES-256-GCM` with a 96-bit IV (Node built-in `crypto`).
- The auth tag is verified on decrypt, so tampering raises.

The version prefix is what makes rotation possible (see below).

## Reads and writes

A Prisma `$extends` query component in
`packages/database/src/client.ts` wraps the configured models. (Prisma
v5+ removed the old `$use` middleware API — `$extends` is the
idiomatic replacement and gives us the same boundary.)

- **Writes** (`create`, `createMany`, `update`, `updateMany`, `upsert`):
  before the SQL is sent, configured fields in `data`, `create`, and
  `update` payloads are encrypted. Already-encrypted values
  (starting with `v1.`) are passed through unchanged so writes are
  idempotent.
- **Reads** (`findUnique`, `findUniqueOrThrow`, `findFirst`,
  `findFirstOrThrow`, `findMany`): after the row(s) come back, configured
  fields whose value starts with `v1.` are decrypted. Legacy plaintext
  values (no prefix) are passed through unchanged so we can roll out
  without a backfill blocker.

## Backward compatibility

Existing rows that pre-date Sprint 32 are stored in plaintext. They keep
working because both encrypt and decrypt are no-ops for values that do
not start with the `v1.` prefix. The Sprint 35 backfill job streams
through `Guest` and `GuestRegisterRecord` and re-saves each row,
upgrading it to ciphertext on its own (the write path encrypts) and
populating the new `*LookupHash` sibling columns (Sprint 34). See
**Lookup hashes** and **Running the PII backfill** below.

## Lookup hashes (Sprint 34)

Equality lookups over encrypted columns (`findFirst({ where: { email:
"..." } })`) cannot hit an index — each encrypt picks a fresh IV, so
the ciphertext on disk differs every write. We mirror each searchable
PII column to a sibling `*LookupHash` column that holds a deterministic
`HMAC-SHA256(key, lower(trim(value)))` of the normalised plaintext.

| Model                  | Lookup hash columns                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `Guest`                | `emailLookupHash`, `phoneLookupHash`, `documentNumberLookupHash`                          |
| `GuestRegisterRecord`  | `emailLookupHash`, `phoneMobileLookupHash`, `documentNumberLookupHash`                    |

Key source: `HOTELOS_LOOKUP_HASH_KEY` if set, falls back to
`HOTELOS_FIELD_KEY`. The HMAC key is independent of the AES key, which
means you can rotate one without the other. If neither is configured,
the helper returns `null` and the lookup-hash columns are left empty
(the Prisma extension's where-rewrite then leaves the clause untouched —
queries will return no match against freshly-encrypted rows; this is
the same failure mode as a misconfigured key, which is the point).

The Prisma extension in `packages/database/src/client.ts`:

- On `create` / `createMany` / `update` / `updateMany` / `upsert`: when
  a PII column is written with a plaintext string (or `{ set: "..." }`),
  the deterministic hash is computed and the sibling `*LookupHash`
  column is set on the same row. Writing `null` clears the hash too.
- On `findUnique` / `findFirst` / `findMany` / `count` / `delete` /
  `deleteMany` / `update*` / `upsert`: the `where` clause is walked
  recursively (including inside `AND` / `OR` / `NOT` branches), and any
  `{ field: "plaintext" }`, `{ field: { equals: "..." } }`, or
  `{ field: { in: [...] } }` reference to a PII column is rewritten to
  use the corresponding `*LookupHash` sibling. Other operators
  (`contains`, `startsWith`, `endsWith`, `not`, range comparators) are
  left alone — they cannot work over ciphertext, and silently rewriting
  them would be wrong.

This means existing callers like
`prisma.guest.findFirst({ where: { OR: [{ email }, { documentNumber }] } })`
continue to work transparently after encryption is enabled.

## Running the PII backfill (Sprint 35)

```bash
# CLI (one-shot)
pnpm --filter @hotelos/api exec tsx src/jobs/pii-backfill.ts
# Or via the script alias
pnpm --filter @hotelos/api run backfill:pii
```

Or trigger it from a privileged operator session via the API:

```
POST /admin/jobs/pii-backfill
```

The endpoint requires `compliance.gdpr.manage` (currently falling back
to `compliance.ses.submit` until the permission catalog is extended)
and is marked `critical` risk because it touches every PII row.

The job:

1. Streams `Guest` and `GuestRegisterRecord` in batches of **500** rows,
   ordered by `id` cursor so it is restartable.
2. Inspects each row's **raw** on-disk values (via `$queryRawUnsafe`,
   bypassing the decrypting extension) to distinguish:
   - **plaintext-on-disk** columns → schedules a `delegate.update()`
     that the extension intercepts to encrypt + hash;
   - **ciphertext-on-disk but lookup-hash-missing** rows → reads the
     row through the decrypting delegate, then writes the plaintext
     back so the extension encrypts (new IV) AND populates the hash.
3. Idempotent: a row whose PII columns are all null or already
   ciphertext **and** whose lookup hashes are all populated is skipped.
4. Logs progress every batch:
   `[backfill] guest 1000 (encrypted 723, hash-only 154, skipped 123)`.
5. Returns / prints a JSON summary:

```json
{
  "guestsScanned": 45000,
  "guestsEncrypted": 41200,
  "guestsHashOnly": 3500,
  "guestRegisterRecordsScanned": 18000,
  "guestRegisterRecordsEncrypted": 17400,
  "guestRegisterRecordsHashOnly": 400,
  "durationMs": 124500
}
```

Re-running the job after success is safe — every row will fall into
the "skipped" bucket.

## Key rotation

The `v1.` prefix is the rotation handle:

1. Generate a new 32-byte key.
2. Deploy with **both** old and new keys available (today the
   implementation reads a single key; extending to a versioned keyring
   is small — switch on the prefix when decrypting).
3. Update the writer to emit `v2.` envelopes.
4. Run a backfill that reads each row (decrypts as `v1.`) and writes it
   back (now encrypted as `v2.`).
5. Once the backfill completes, retire the v1 key.

## pgcrypto

`packages/database/migrations/_pgcrypto.sql` documents the one-time
`CREATE EXTENSION IF NOT EXISTS pgcrypto;` to run on production. We are
not using pgcrypto for the main encrypt/decrypt path — Node's crypto is
authoritative — but enabling the extension unlocks future server-side
work (deterministic digest columns, `pgp_sym_*` backfills, GIN indexes on
hashed PII).

## Sharp edges

- **No `LIKE` / `ILIKE` over encrypted columns.** Substring search and
  prefix search no longer work for the wrapped fields. Point-equality
  lookups DO work transparently via the `*LookupHash` sibling columns
  (Sprint 34) — but only for equality (`{ email: "x" }`,
  `{ equals: "x" }`, `{ in: [...] }`). Other operators (`contains`,
  `startsWith`, range comparators) cannot be served from a
  deterministic hash and will return no rows against ciphertext.
- **No sorting in SQL.** `ORDER BY email` is meaningless after encryption.
- **Full-text search** over encrypted columns is not possible without
  extra columns or external search infrastructure.
- **Backups** still need encryption at rest at the volume level — this
  feature protects fields against accidental exposure in dumps, logs,
  and read-only replica access, not against full database compromise.
