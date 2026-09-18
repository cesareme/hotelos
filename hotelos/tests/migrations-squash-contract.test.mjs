import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Tanda 4 · DATA-01: the migration chain is ONE squashed baseline generated from
// schema.prisma. No database needed: this guards the tree and the scripts that
// install / adopt it. Column-level parity with a real database is what
// `pnpm db:install:check` (temporary DB) and `pnpm db:drift:check` are for.

const BASELINE = "20260914000000_baseline_squash";
const migrationsDir = new URL("../packages/database/prisma/migrations/", import.meta.url);
const archiveDir = new URL("../packages/database/prisma/migrations-archive/2026-05-18_to_2026-06-01/", import.meta.url);
const migrationFolders = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const baselineSql = readFileSync(new URL(`${BASELINE}/migration.sql`, migrationsDir), "utf8");
// The whole chain (baseline + later migrations): what a fresh `migrate deploy` produces.
const chainSql = migrationFolders.map((folder) => readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), "utf8")).join("\n");
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const databasePackage = JSON.parse(readFileSync(new URL("../packages/database/package.json", import.meta.url), "utf8"));
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");

const count = (source, re) => (source.match(re) ?? []).length;

describe("Migrations squash contract (DATA-01)", () => {
  it("starts with the squashed baseline; later migrations are timestamped after it (plus migration_lock.toml)", () => {
    // DATA-01 squashed the old chain into ONE baseline. New schema changes land
    // as ordinary `migrate` folders AFTER it (rate grid v2 was the first one),
    // so the contract is: baseline first, every other folder newer than it.
    assert.equal(migrationFolders[0], BASELINE, `the first migration must be the baseline, got ${migrationFolders[0]}`);
    for (const folder of migrationFolders.slice(1)) {
      assert.match(folder, /^\d{14}_[a-z0-9_]+$/, `migration folder ${folder} must be <timestamp>_<name>`);
      assert.ok(folder > BASELINE, `${folder} must be newer than the baseline`);
      assert.ok(existsSync(new URL(`${folder}/migration.sql`, migrationsDir)), `${folder}/migration.sql missing`);
    }
    assert.ok(existsSync(new URL("migration_lock.toml", migrationsDir)), "migration_lock.toml must stay in prisma/migrations");
    assert.match(readFileSync(new URL("migration_lock.toml", migrationsDir), "utf8"), /provider = "postgresql"/);
  });

  it("archived the 2026-05/06 chain outside the Prisma glob, with a README", () => {
    assert.ok(!existsSync(new URL("20260601000000_baseline_missing_tables/", migrationsDir)));
    assert.ok(!existsSync(new URL("20260518055959_initial/", migrationsDir)));
    for (const folder of [
      "20260518055959_initial",
      "20260518103002_night_audit_business_date",
      "20260518142803_fiscal_period",
      "20260518152934_taxes_verifactu_submissions",
      "20260518174312_tbai_igic_xades",
      "20260601000000_baseline_missing_tables"
    ]) {
      assert.ok(existsSync(new URL(`${folder}/migration.sql`, archiveDir)), `${folder} must be archived`);
    }
    assert.ok(existsSync(new URL("README.md", archiveDir)));
  });

  it("the migration chain covers every model and enum of schema.prisma (Tanda 3 + Role.templateKey included)", () => {
    const models = count(schema, /^model\s+\w+\s*\{/gm);
    const enums = count(schema, /^enum\s+\w+\s*\{/gm);
    // Tanda L2 (20260918130000_persistencia_l2) is the first migration of the chain
    // that retires tables (18 DROP TABLE): live tables = CREATE TABLE − DROP TABLE.
    assert.equal(count(chainSql, /^CREATE TABLE "/gm) - count(chainSql, /^DROP TABLE "/gm), models, "one live CREATE TABLE (minus DROP TABLE) per model across the chain");
    assert.equal(count(chainSql, /^CREATE TYPE "/gm), enums, "one CREATE TYPE per enum across the chain");
    assert.ok(count(chainSql, /^CREATE (UNIQUE )?INDEX "/gm) >= 380);
    assert.equal(count(chainSql, /ADD CONSTRAINT "\w+" FOREIGN KEY/g), count(schema, /@relation\([^)]*fields:/g), "one FOREIGN KEY per @relation(fields:)");
    assert.match(baselineSql, /^CREATE TABLE "user_invitations" \($/m);
    assert.match(baselineSql, /^CREATE TABLE "payment_tokens" \($/m);
    assert.match(baselineSql, /^CREATE TABLE "rate_change_journals" \($/m);
    assert.match(baselineSql, /^CREATE TABLE "roles" \([\s\S]*?"template_key" TEXT,[\s\S]*?^\);/m);
    assert.match(baselineSql, /CREATE INDEX "roles_organization_id_template_key_idx"/);
    assert.match(baselineSql, /'retrying'/, "SubmissionStatus.retrying (missing from the archived chain)");
    // Uniques replaced in Tanda 3 must NOT come back.
    assert.doesNotMatch(baselineSql, /"invoice_sequences_property_id_sequence_code_key"/);
    assert.doesNotMatch(baselineSql, /"verifactu_submissions_invoice_id_key"/);
  });

  it("baseline is pure Prisma DDL: no DROP, extensions, functions, triggers or views", () => {
    assert.doesNotMatch(baselineSql, /^(DROP|CREATE EXTENSION|CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER|CREATE (OR REPLACE )?VIEW)/m);
    assert.match(baselineSql, /migrate diff --from-empty/, "header documents how it was generated");
    assert.match(baselineSql, /db:adopt-baseline/, "header points at the adoption script");
  });

  it("exposes the install / adopt / drift scripts in both package.json files", () => {
    assert.equal(databasePackage.scripts["db:adopt-baseline"], "node --env-file-if-exists=../../.env scripts/adopt-baseline.mjs");
    assert.match(databasePackage.scripts["db:migrate:deploy"], /migrate deploy$/);
    assert.match(databasePackage.scripts["db:migrate:status"], /migrate status$/);
    assert.match(databasePackage.scripts["db:drift:check"], /migrate diff --from-schema-datasource prisma\/schema\.prisma --to-schema-datamodel prisma\/schema\.prisma --exit-code$/);
    for (const script of ["db:migrate:deploy", "db:migrate:status", "db:drift:check", "db:migrate"]) {
      assert.match(databasePackage.scripts[script], /^node --env-file-if-exists=\.\.\/\.\.\/\.env /, `${script} loads ../../.env when present`);
    }
    assert.equal(rootPackage.scripts["db:migrate:deploy"], "pnpm --filter @hotelos/database db:migrate:deploy");
    assert.equal(rootPackage.scripts["db:adopt-baseline"], "pnpm --filter @hotelos/database db:adopt-baseline");
    assert.equal(rootPackage.scripts["db:drift:check"], "pnpm --filter @hotelos/database db:drift:check");
    assert.equal(rootPackage.scripts["db:install:check"], "bash scripts/check-fresh-install.sh");
    assert.equal(rootPackage.scripts["db:migrations:check"], "node scripts/check-migrations-vs-schema.mjs");
  });

  it("ships the adoption script, the fresh-install check and the DB-less migrations check", () => {
    const adopt = readFileSync(new URL("../packages/database/scripts/adopt-baseline.mjs", import.meta.url), "utf8");
    assert.match(adopt, new RegExp(`BASELINE_NAME = "${BASELINE}"`));
    assert.match(adopt, /--apply/);
    assert.match(adopt, /--json/);
    assert.match(adopt, /INSERT INTO "_prisma_migrations"/);
    assert.match(adopt, /DELETE FROM "_prisma_migrations" WHERE id = \$1/);
    const fresh = readFileSync(new URL("../scripts/check-fresh-install.sh", import.meta.url), "utf8");
    assert.match(fresh, /hotelos_install_test/);
    assert.match(fresh, /db:migrate:deploy/);
    assert.match(fresh, /db:drift:check/);
    assert.match(fresh, /prisma\/seed\.ts/);
    assert.match(fresh, /rbac:sync -- --dry-run/);
    assert.match(fresh, /trap cleanup EXIT/);
    assert.ok(existsSync(new URL("../scripts/check-migrations-vs-schema.mjs", import.meta.url)));
  });

  it("migrations-vs-schema check agrees with the tree (tables and enums)", async () => {
    const { check } = await import("../scripts/check-migrations-vs-schema.mjs");
    const result = check();
    assert.equal(result.ok, true, JSON.stringify({ tables: result.tables, enums: result.enums }));
    assert.equal(result.chain.tables, result.schema.tables);
  });

  it("documents the new flow and no longer tells operators to db push shared databases", () => {
    const readme = readFileSync(new URL("../packages/database/MIGRATIONS_README.md", import.meta.url), "utf8");
    assert.match(readme, new RegExp(BASELINE));
    assert.match(readme, /db:adopt-baseline/);
    assert.match(readme, /db:install:check/);
    assert.doesNotMatch(readme, /20260601000000_baseline_missing_tables\/`? *covers/);
    const runbook = readFileSync(new URL("../docs/pilot-client/runbook.md", import.meta.url), "utf8");
    assert.match(runbook, /db:migrate:deploy/);
    assert.doesNotMatch(runbook, /prisma db push --skip-generate/);
    const playbook = readFileSync(new URL("../docs/pilot-client/cloud-saas-playbook.md", import.meta.url), "utf8");
    assert.match(playbook, /db:adopt-baseline/);
    assert.doesNotMatch(playbook, /migrate resolve --applied 20260601000000_baseline_missing_tables/);
    const claude = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
    assert.match(claude, /db:migrate:deploy/);
    assert.match(claude, /db:adopt-baseline/);
  });
});
