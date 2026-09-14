# Archived migrations (2026-05-18 → 2026-06-01)

These six folders are the original Prisma migration chain of the project
(`20260518055959_initial` … `20260601000000_baseline_missing_tables`, all from
the initial commit `34766df`). They are kept **for reference only** and are
**not** read by Prisma: the CLI only scans `prisma/migrations/`.

Why they were archived (2026-09-14, Tanda 4 / DATA-01): the chain stopped at
248 tables, 0 foreign keys and two UNIQUE indexes the schema no longer has;
every later change (Tandas 1-3, months of `prisma db push`) never got a
migration, so `migrate deploy` could not install a working Anfitorio from
scratch and failed with P3009 on databases created with `db push`. They were
replaced by the single squashed baseline
`prisma/migrations/20260914000000_baseline_squash/` generated from
`schema.prisma` at commit `7e5c1c3` (+ `Role.templateKey`).

Do not copy these folders back into `prisma/migrations/`. Databases that still
carry rows for them in `_prisma_migrations` are cleaned by
`scripts/adopt-baseline.mjs` (see `packages/database/MIGRATIONS_README.md`).
