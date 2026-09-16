// Pure contract tests (no database) over the hand-written SQL of the sociedad
// layer (Tanda 6b · L1, finding t6b#10). Prisma cannot declare triggers, so the
// only place that pins R10.1 / R10.5 at the database level is the migration
// text itself: this test reads it and asserts the guard that the in-process
// integration test exercises against Postgres (tests/integration). Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/legal-structure-migrations.test.mts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "../../../../../packages/database/prisma/migrations");
const STEP1 = "20260916100000_estructura_societaria";
const GUARD = "20260916102000_estructura_societaria_property_immutable";
const read = (folder: string) => readFileSync(join(MIGRATIONS, folder, "migration.sql"), "utf8");

/** Body of the first plpgsql function named `name` in `sql`. */
function functionBody(sql: string, name: string): string {
  const match = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\) RETURNS trigger[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`).exec(sql);
  assert.ok(match, `function ${name} is defined`);
  return match[1]!;
}

describe("20260916102000 · properties_sociedad_inmutable (R10.1 / R10.5)", () => {
  const sql = read(GUARD);
  const body = functionBody(sql, "hotelos_property_legal_entity_guard");

  it("is a hand-written, DDL-only migration (functions and triggers; nothing Prisma tracks)", () => {
    assert.doesNotMatch(sql, /^(ALTER|CREATE) TABLE/m, "no table change: end state == schema.prisma, drift stays 0");
    assert.doesNotMatch(sql, /^CREATE (UNIQUE )?INDEX/m);
    assert.doesNotMatch(sql, /^(UPDATE|DELETE|INSERT)\b/m, "no data step: nothing existing is rewritten");
    assert.equal((sql.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 2);
    assert.equal((sql.match(/^CREATE TRIGGER /gm) ?? []).length, 2, "check-fresh-install step 6 counts CREATE FUNCTION == CREATE TRIGGER lines");
  });

  it("fires BEFORE INSERT and BEFORE UPDATE OF legal_entity_id / organization_id on properties", () => {
    assert.match(sql, /CREATE TRIGGER properties_sociedad_inmutable\s+BEFORE INSERT OR UPDATE OF "legal_entity_id", "organization_id" ON "properties"\s+FOR EACH ROW EXECUTE FUNCTION hotelos_property_legal_entity_guard\(\);/);
  });

  it("R10.1: a non-NULL legal_entity_id must belong to the centre's organisation (INSERT and UPDATE; missing entity left to the FK)", () => {
    assert.match(body, /IF NEW\."legal_entity_id" IS NOT NULL THEN/);
    assert.match(body, /SELECT le\."organization_id" INTO entity_organization_id\s+FROM "legal_entities" le\s+WHERE le\."id" = NEW\."legal_entity_id"/);
    assert.match(body, /entity_organization_id IS NOT NULL AND entity_organization_id IS DISTINCT FROM NEW\."organization_id"/, "a missing entity is the FK's job, not the trigger's");
    assert.match(body, /R10\.1/);
    // The R10.1 branch is not gated on TG_OP: it also runs on INSERT.
    const r101 = body.slice(0, body.indexOf("R10.5"));
    assert.doesNotMatch(r101, /TG_OP/);
  });

  it("R10.5: a change of sociedad (from a NON-NULL value) or of organisation is rejected when the centre has issued invoices or an installation", () => {
    assert.match(body, /TG_OP = 'UPDATE'/);
    assert.match(body, /OLD\."legal_entity_id" IS NOT NULL AND NEW\."legal_entity_id" IS DISTINCT FROM OLD\."legal_entity_id"/, "NULL → value (backfill / L2 fill) stays allowed; value → NULL or another entity does not");
    assert.match(body, /NEW\."organization_id" IS DISTINCT FROM OLD\."organization_id"/);
    assert.match(body, /EXISTS \(SELECT 1 FROM "invoices" i WHERE i\."property_id" = OLD\."id" AND i\."status"::text <> 'draft'\)/, "every non-draft invoice counts, soft-deleted included");
    assert.doesNotMatch(body, /deleted_at/, "an issued invoice is a fiscal record whatever its deleted_at");
    assert.match(body, /EXISTS \(SELECT 1 FROM "verifactu_installations" vi WHERE vi\."property_id" = OLD\."id"\)/, "active or retired: the installation number is never reused");
    assert.doesNotMatch(body, /vi\."active"/);
    assert.match(body, /R10\.5/);
    assert.match(body, /USING ERRCODE = 'integrity_constraint_violation'/);
  });

  it("legal_entities_organizacion_inmutable closes the other side of R10.1", () => {
    const entity = functionBody(sql, "hotelos_legal_entity_organization_immutable");
    assert.match(entity, /NEW\."organization_id" IS DISTINCT FROM OLD\."organization_id"/);
    assert.match(entity, /USING ERRCODE = 'integrity_constraint_violation'/);
    assert.match(sql, /CREATE TRIGGER legal_entities_organizacion_inmutable\s+BEFORE UPDATE OF "organization_id" ON "legal_entities"/);
  });

  it("messages are Spanish, name the row and point to the design rule", () => {
    for (const message of body.match(/RAISE EXCEPTION '([^']+)'/g) ?? []) {
      assert.match(message, /%/, "every message interpolates the offending id");
      assert.match(message, /\(R10\.[15]\)/);
    }
    assert.match(body, /el traspaso de un establecimiento es un centro nuevo y una instalación retirada/);
  });

  it("documents the rollback of the backfill (DISABLE TRIGGER) and the pre-checks in the header", () => {
    assert.match(sql, /ALTER TABLE properties DISABLE TRIGGER properties_sociedad_inmutable/);
    assert.match(sql, /0 whose legal entity belongs to\s+--\s+another organisation/);
    assert.match(sql, /t6b#10/);
  });
});

describe("sociedad layer · the trigger census the fresh-install check relies on", () => {
  it("every CREATE FUNCTION of the chain has exactly one CREATE TRIGGER and vice versa", () => {
    const folders = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name)).map((e) => e.name).sort();
    assert.ok(folders.indexOf(STEP1) < folders.indexOf(GUARD), "the guard migration comes after step 1 (it references legal_entities and verifactu_installations)");
    const chain = folders.map(read).join("\n");
    const functions = [...chain.matchAll(/^CREATE OR REPLACE FUNCTION (\w+)\(\)/gm)].map((m) => m[1]);
    const triggers = [...chain.matchAll(/^CREATE TRIGGER (\w+)[\s\S]*?EXECUTE FUNCTION (\w+)\(\);/gm)].map((m) => [m[1], m[2]] as const);
    assert.deepEqual(
      functions.sort(),
      ["hotelos_invoice_issuer_immutable", "hotelos_legal_entity_organization_immutable", "hotelos_property_legal_entity_guard", "hotelos_verifactu_installation_immutable"]
    );
    assert.deepEqual(triggers.map(([, fn]) => fn).sort(), functions.sort(), "one trigger per function");
    assert.deepEqual(
      triggers.map(([name]) => name).sort(),
      ["invoices_issuer_inmutable", "legal_entities_organizacion_inmutable", "properties_sociedad_inmutable", "verifactu_installations_numero_inmutable"]
    );
    assert.doesNotMatch(chain, /^CREATE (OR REPLACE )?(MATERIALIZED )?VIEW/m, "views stay forbidden (check-fresh-install step 6)");
  });
});
