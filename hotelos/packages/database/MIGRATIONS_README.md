# Database migrations — operations guide

This package owns the Postgres schema for the HotelOS platform via Prisma
migrations.

## TL;DR

- `prisma/schema.prisma` declares the 248 models that make up the schema.
- `prisma/migrations/` holds the historical SQL applied to every Postgres
  database we manage.
- The baseline migration `20260601000000_baseline_missing_tables/` covers
  50 tables that exist in the schema (and in every live database) but were
  never recorded in a migration. **Read [Baseline migration](#baseline-migration-20260601000000_baseline_missing_tables)
  before deploying to any new or existing environment.**

## How we got here

For a stretch of early development, schema changes were applied to live
databases with `prisma db push` instead of `prisma migrate dev`. `db push`
mutates the database directly and does **not** create a migration file.

The result:

| | Tables |
|---|---:|
| `schema.prisma` (source of truth) | 248 |
| Existing migrations (5 files) | 198 |
| Live dev/staging databases | 248 |
| **Drift** | **50 tables** |

Without intervention, running `prisma migrate deploy` against a fresh
database produces a 198-table copy of the schema — every code path that
touches one of the 50 missing tables blows up at runtime. The baseline
migration described below closes that gap **without** touching any of the
already-recorded tables.

## Baseline migration: `20260601000000_baseline_missing_tables`

### What it contains

Strictly **additive** SQL extracted from
`prisma migrate diff --from-empty --to-schema-datamodel`, filtered to the
50 tables present in `schema.prisma` but absent from prior migrations:

- 50 `CREATE TABLE` statements (with their PRIMARY KEY constraints)
- 94 `CREATE INDEX` / `CREATE UNIQUE INDEX` statements
- No `DROP`s, no `ALTER` of pre-existing tables, no destructive operations
- No `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` — the schema currently
  declares only 7 DB-level foreign keys and none of them target the new
  tables. (Most relations are modeled via shared columns and enforced in
  application code.)

### What it does **not** do

- It does not reconcile the historical migrations with the live schema for
  the 198 tables that already exist in both — those are assumed to be in
  sync. If you suspect column-level drift on any of those, run the CI
  check below and address findings in a follow-up migration.
- It does not insert or modify any rows.

### Applying it

The same migration file works for all environments, but the command you
run depends on whether the destination database already has the 50 tables.

#### Dev / staging / production — DB already has these tables

These databases were populated by historical `db push` calls. Running
`prisma migrate deploy` would try to `CREATE TABLE` against tables that
already exist and fail. Instead, mark the baseline as already applied:

```bash
npm exec prisma migrate resolve -- --applied 20260601000000_baseline_missing_tables
```

Prisma records the migration in the `_prisma_migrations` table as if it
had been executed, leaving the data untouched. Subsequent
`prisma migrate deploy` runs see the migration as applied and skip it.

#### Fresh environment — empty DB

Run the normal flow:

```bash
npm exec prisma migrate deploy
```

The baseline migration is timestamped `20260601000000` so it runs after
the existing five (`20260518...`) and produces the full 248-table schema.

#### Local development (re-creating a clean DB)

```bash
npm exec prisma migrate reset
```

This drops the schema and re-applies every migration in order, ending at
the baseline. Use this when seeding fresh dev environments.

## Preventing future drift

Two practices stop this class of bug from recurring.

### 1. Never use `prisma db push` against shared databases

`db push` is acceptable for one-off schema prototyping in a throwaway
sandbox. For every other database — dev, staging, preview, production —
schema changes must go through `prisma migrate dev` (or
`prisma migrate deploy` for non-interactive environments) so the change
is captured in a versioned migration file under
`prisma/migrations/`.

### 2. Add a CI check that catches drift early

Run the following step in CI on the main branch (and ideally on every
PR that touches `schema.prisma` or `prisma/migrations/`):

```bash
npm exec prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code
```

`--exit-code` returns:

- `0` when the database matches the schema (no drift)
- `2` when there is a diff

Point `DATABASE_URL` at a database that mirrors production (a freshly
restored snapshot, or a CI database that has had `prisma migrate deploy`
applied). A non-zero exit fails the build, surfaces the drift, and forces
the author to either fix the schema, write a migration, or both.

For a stricter check that also asserts that `migrate deploy` would not
need to do anything, compare migrations to schema directly:

```bash
npm exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code
```

This catches the exact failure mode this baseline migration was created
to fix: a schema model with no corresponding migration.

## Reference

- Migration directory: `packages/database/prisma/migrations/`
- Schema: `packages/database/prisma/schema.prisma`
- Prisma docs on baselining:
  <https://www.prisma.io/docs/orm/prisma-migrate/getting-started#baseline-your-production-environment>
- Prisma docs on `migrate resolve`:
  <https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-resolve>
