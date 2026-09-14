# Database migrations — operations guide

This package owns the Postgres schema of Anfitorio (HotelOS) through Prisma
migrations. Since 2026-09-14 (Tanda 4, DATA-01) the chain is **one squashed
baseline** generated from `schema.prisma`, and every environment must carry it
in `_prisma_migrations` — either because `migrate deploy` applied it (new
databases) or because it was *adopted* (databases created before the squash).

## TL;DR

| Situation | Command (monorepo root) |
|---|---|
| Empty database (new install, CI) | `pnpm db:generate && pnpm db:migrate:deploy` |
| Database that already exists (demo Mac, VPS, restored dump) | `pnpm db:adopt-baseline` (dry-run) → `pnpm db:adopt-baseline -- --apply` → `pnpm db:migrate:deploy` |
| Verify any database | `pnpm db:drift:check` (exit 0 = schema.prisma == database) · `pnpm --filter @hotelos/database db:migrate:status` |
| Prove the chain installs from scratch (temporary DB) | `pnpm db:install:check` |
| Tree-only check, no database (CI / contract test) | `pnpm db:migrations:check` |
| Change the schema | edit `schema.prisma` → `pnpm --filter @hotelos/database db:migrate -- --name <change>` → commit the new folder |

Prisma's CLI does **not** read the root `.env`: every `db:*` script here runs
through `node --env-file-if-exists=../../.env`, so on a developer Mac the root
`.env` is picked up automatically, and in CI/containers an exported
`DATABASE_URL` wins (the environment always takes precedence over the file).
Root shortcuts (`pnpm db:…`) delegate with `pnpm --filter`, so `pnpm` must be on
`PATH` (`corepack enable`); otherwise call the package script directly:
`corepack pnpm --filter @hotelos/database db:adopt-baseline -- --apply`.

## Layout

```
packages/database/prisma/
├── schema.prisma                         # source of truth (251 models, 11 enums)
├── migrations/
│   ├── migration_lock.toml               # provider = "postgresql"
│   └── 20260914000000_baseline_squash/   # THE baseline (generated, do not edit)
│       └── migration.sql
└── migrations-archive/
    └── 2026-05-18_to_2026-06-01/         # the six historical folders, reference only
        ├── README.md
        ├── 20260518055959_initial/ … 20260601000000_baseline_missing_tables/
packages/database/scripts/adopt-baseline.mjs   # marks the baseline as applied on existing DBs
scripts/check-fresh-install.sh                 # pnpm db:install:check
scripts/check-migrations-vs-schema.mjs         # pnpm db:migrations:check
packages/database/migrations/_pgcrypto.sql     # optional, NOT required by any code today
```

## How we got here (and why a squash)

The original chain (six folders, 2026-05-18 → 2026-06-01, all from the initial
commit) stopped at 248 tables, 0 foreign keys and two UNIQUE indexes the schema
later dropped (`invoice_sequences_property_id_sequence_code_key`,
`verifactu_submissions_invoice_id_key`, replaced in Tanda 3). Everything after
June 2026 — Tandas 1-3 and months of `prisma db push` — never produced a
migration: 3 tables (`payment_tokens`, `rate_change_journals`,
`user_invitations`), ~255 columns, 59 indexes, the enum value
`SubmissionStatus.retrying` and all 10 foreign keys existed only in live
databases. Consequences, measured on 2026-09-14:

- empty DB + `migrate deploy` → 248-table schema, the Prisma client failed on
  the first query (P2022) and invoice sequences / VeriFactu retries hit the
  obsolete uniques;
- DB created with `db push` + `migrate deploy` → **P3005** ("schema is not
  empty"); once a failed row exists → **P3009** on every later attempt;
- DB with the five 2026-05 migrations applied by `migrate dev` and later
  `db push` → `baseline_missing_tables` failed on `password_reset_tokens` →
  P3009 (the VPS symptom).

The drift was not additive (uniques to drop, enum value to add), so a single
regenerated baseline is safer than patching the old chain.

## The baseline: `20260914000000_baseline_squash`

Generated with `prisma migrate diff --from-empty --to-schema-datamodel
prisma/schema.prisma --script` (Prisma 6.19.3) right after verifying that the
demo database matched `schema.prisma` exactly (`migrate diff
--from-schema-datasource … --exit-code` = 0, HEAD `7e5c1c3` + `Role.templateKey`).

Contents: `CREATE SCHEMA IF NOT EXISTS "public"` (standard Prisma output, keep
it), 11 `CREATE TYPE`, 251 `CREATE TABLE`, 384 `CREATE INDEX`/`CREATE UNIQUE
INDEX`, 10 `ADD FOREIGN KEY`. No `DROP`, no extensions, functions, triggers,
views or partial indexes — nothing lives outside Prisma in any known database.

**Never edit or regenerate this file.** Future schema changes are incremental
folders on top of it (see below). The archived folders are not read by Prisma
(the CLI only scans `prisma/migrations/`) and must not be copied back.

## New database (install from scratch, CI)

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate:deploy          # "1 migration found … applied"
pnpm db:drift:check             # exit 0
# demo data (order matters):
cd packages/database && node --env-file=../../.env --import tsx prisma/seed.ts && cd ../..
pnpm db:seed:commercial
```

`pnpm db:install:check` automates exactly this on a temporary database
(`hotelos_install_test` on the same server as `DATABASE_URL`, dropped on exit):
migrate deploy → drift check → base seed → `rbac:sync --dry-run` → no
functions/triggers/views in `public` → sanity counts → `adopt-baseline` reports
`adopted`. Run it after any migration change; CI runs it as the `fresh-install`
job.

## Existing database (demo Mac, VPS, restored dumps): adopt the baseline

Databases whose schema already exists were built with `db push` (no
`_prisma_migrations`) or carry rows of the archived chain. `migrate deploy`
would try to execute the baseline and fail (P3005/P3009). Adopt it instead:

```bash
bash scripts/backup-postgres.sh            # or: pg_dump -Fc "$DATABASE_URL" > before-adopt.dump
pnpm db:drift:check                        # MUST be 0: the DB has to match schema.prisma first
pnpm db:adopt-baseline                     # dry-run: shows the plan, writes nothing
pnpm db:adopt-baseline -- --apply          # writes
pnpm --filter @hotelos/database db:migrate:status   # "Database schema is up to date!"
pnpm db:migrate:deploy                     # "No pending migrations to apply."
```

`scripts/adopt-baseline.mjs` (Node + `@prisma/client` only; no psql, no Prisma
CLI, so it also runs inside the api container) is idempotent:

| Database state | Behaviour |
|---|---|
| 0 tables, 0 enums | no-op (`migrate deploy` will apply the baseline); leftover history rows are deleted with `--apply` |
| enums but no tables | refuses (exit 1): remains of a failed migration — recreate the DB |
| tables/columns/enums of the baseline missing | refuses (exit 1): align the schema first, then re-run. Throwaway local DB: `pnpm db:push`. Shared DB (dev/demo VPS, pilot, production): **never `db push`** — restore a dump already aligned with the baseline, or create an empty DB, `migrate deploy` (applies the baseline) and load the data with a reviewed `pg_restore --data-only` |
| clean baseline row already present, nothing stale | no-op ("adopted") |
| otherwise | `DELETE` every other row (archived names, failed/rolled-back attempts, duplicate baseline rows) and `INSERT` the baseline row exactly as `prisma migrate resolve --applied` would (sha256 checksum of `migration.sql`, `logs=''`, `applied_steps_count=0`) in one transaction |

Flags: `--apply` (default is dry-run), `--json`, `--help`. Exit codes: 0 ok /
nothing to do · 1 failure · 2 unknown flag.

Dumps taken **before** adoption do not contain `_prisma_migrations`: after a
restore, run `db:adopt-baseline -- --apply` again (idempotent). Dumps taken
after adoption already include the table.

The VPS databases (hotelos-dev 72.61.194.216, demo 76.13.55.180) have unknown
history; ask for `SELECT migration_name, finished_at, rolled_back_at FROM
_prisma_migrations` first, and remember the demo VPS schema is older than
Tandas 2-3: `adopt-baseline` will refuse until the schema is aligned. Those
are shared databases, so `db push` is **not** an option there: align them by
restoring an aligned dump, or with an empty database + `migrate deploy` (which
applies the baseline) + a reviewed `pg_restore --data-only`, always **before**
the adoption, never after.

## Changing the schema from now on

1. Edit `schema.prisma`.
2. `pnpm --filter @hotelos/database db:migrate -- --name <change>` (`prisma
   migrate dev`; it needs a database that already carries the baseline and a
   role allowed to create the shadow database — the local demo qualifies after
   adoption). Review the generated SQL; `--create-only` if you want to edit it
   before applying.
3. `pnpm db:migrations:check` and `pnpm db:install:check`.
4. Commit `schema.prisma` **and** the new folder together.

**Never `prisma db push` a shared database** (dev VPS, demo VPS, pilot,
production): it leaves no migration and re-creates the drift this squash
removed. `pnpm db:push` stays only for throwaway local databases (prototyping,
or aligning a *local* pre-squash copy right before adopting the baseline);
on any shared database the only sequence is `db:adopt-baseline -- --apply` →
`db:migrate:deploy` → `db:drift:check`.
`deploy/scripts/deploy.sh` keeps its drift guard: any future migration that
contains a `DROP` is blocked unless `ALLOW_DESTRUCTIVE_MIGRATION=1`.

## Verification cheat-sheet

```bash
pnpm db:drift:check                                    # 0 = database == schema.prisma
pnpm db:migrations:check                               # 0 = migrations create every model/enum (no DB)
pnpm --filter @hotelos/database db:migrate:status      # 0 = up to date (1 = pending/failed migrations)
psql "$DATABASE_URL" -c "SELECT migration_name, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at"
pnpm db:install:check                                  # full fresh install on a temporary DB
```

Strict CI variant (needs a shadow DB with `CREATE` rights):
`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel
prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code`.

## Reference

- Prisma baselining: <https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining>
- `migrate resolve`: <https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-resolve>
- Archived chain: `prisma/migrations-archive/2026-05-18_to_2026-06-01/README.md`
- Audit trail: `docs/audits/AUDITORIA-360-2026-09-13.md` (DATA-01)
