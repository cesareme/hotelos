import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Estructura societaria (Tanda 6b · L1, design §5.1 decisión 2 and C8): the
// identity of the sociedad (NIF, razón social) has ONE reader —
// apps/api/src/lib/finance-scope.ts (resolveLegalIdentity). No finance module
// may read Organization.taxId / Organization.legalName or Property.legalName
// directly. No database: a grep over the finance modules and packages/compliance.
//
// LEGACY_READERS lists the readers that existed before L1 and that L3-L5 move to
// resolveLegalIdentity. The list only SHRINKS: a listed file that no longer
// reads the columns fails the test until it is removed here, and any new reader
// outside the list fails immediately. C8 (L9) is this test with an empty list.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const FINANCE_ROOTS = [
  "apps/api/src/modules/accounting",
  "apps/api/src/modules/invoicing",
  "apps/api/src/modules/financial-statements",
  "apps/api/src/modules/payables",
  "apps/api/src/modules/treasury",
  "apps/api/src/modules/payments",
  "apps/api/src/modules/payroll",
  "apps/api/src/modules/pos",
  "apps/api/src/modules/night-audit",
  // fix t6b#12 (integrador): the modules that PRINT or SEARCH a razón social
  // outside Finanzas (inspection folder, global search, property overview) read
  // the sociedad through resolveIssuerIdentity / resolveLegalIdentity too.
  "apps/api/src/modules/compliance",
  "apps/api/src/modules/search",
  "apps/api/src/modules/dashboards",
  "packages/compliance/src"
];

/**
 * file → lot that migrates it to resolveLegalIdentity. Only ever remove entries.
 * Empty since 2026-09-16 (C8 reached):
 *   L3 migrated invoicing/issuer-identity.service.ts (issuer = legal entity + establishment block);
 *   L4 migrated treasury/sepa-remittance.service.ts (SEPA debtor = legal entity) and
 *      payroll/export.service.ts (employer NIF = legal entity);
 *   L5 migrated accounting/modelo-303.service.ts (declaranteOf → getVatSettings → resolveLegalIdentity),
 *      financial-statements/source.ts (`legalIdentity()` replaces the organization loader),
 *      financial-statements/annual-accounts.service.ts and financial-statements.routes.ts
 *      (memoria / entity label from the badge).
 */
const LEGACY_READERS = {};

// Direct reads of the deprecated columns on an organisation / property object.
const DIRECT_READ = /\b(organization|organisation|org)\??\.(taxId|legalName)\b|\bproperty\??\.legalName\b/;
// A Prisma organisation query that selects the deprecated columns.
const ORGANIZATION_QUERY = /\.organization\.(findUnique|findFirst|findMany|findUniqueOrThrow|findFirstOrThrow)\(/g;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True when the file reads Organization.taxId/legalName or Property.legalName. */
export function readsLegalIdentity(source) {
  const code = stripComments(source);
  if (DIRECT_READ.test(code)) return true;
  for (const match of code.matchAll(ORGANIZATION_QUERY)) {
    const call = code.slice(match.index, match.index + 600);
    const end = call.indexOf("})");
    const args = end >= 0 ? call.slice(0, end) : call;
    if (/\b(taxId|legalName)\s*:\s*true\b/.test(args)) return true;
  }
  return false;
}

describe("Estructura societaria · lectores de la identidad fiscal (C8)", () => {
  const files = FINANCE_ROOTS.flatMap((root) => walk(join(ROOT, root))).map((f) => relative(ROOT, f).split("\\").join("/"));
  const readers = files.filter((file) => readsLegalIdentity(read(file)));

  it("no finance module outside the legacy list reads Organization.taxId / legalName or Property.legalName", () => {
    const unexpected = readers.filter((file) => !(file in LEGACY_READERS)).sort();
    assert.deepEqual(unexpected, [], `nuevos lectores directos de la identidad: ${unexpected.join(", ")} → usa resolveLegalIdentity (apps/api/src/lib/finance-scope.ts)`);
  });

  it("every legacy reader still reads them (remove the entry once its lot migrates it)", () => {
    const stale = Object.keys(LEGACY_READERS).filter((file) => !readers.includes(file));
    assert.deepEqual(stale, [], `entradas obsoletas en LEGACY_READERS: ${stale.join(", ")}`);
  });

  it("the single reader exists, reads the deprecated columns only as a fallback and exports the three indirections", () => {
    const source = read("apps/api/src/lib/finance-scope.ts");
    assert.match(source, /export async function resolveLegalIdentity\(/);
    assert.match(source, /export async function resolveLedgerScope\(/);
    assert.match(source, /export async function listOperationalProperties\(/);
    assert.match(source, /source: "organization_fallback"/);
    assert.match(source, /kind: "hotel"/, "the operational filter is kind = hotel");
    assert.equal(readsLegalIdentity(source), true, "finance-scope.ts is the reader");
  });

  it("the detector recognises the patterns it guards", () => {
    assert.equal(readsLegalIdentity("const x = organization.taxId;"), true);
    assert.equal(readsLegalIdentity("const y = org?.legalName ?? org.name;"), true);
    assert.equal(readsLegalIdentity("legalName: property.legalName ?? name"), true);
    assert.equal(readsLegalIdentity('await prisma.organization.findUnique({ where: { id }, select: { id: true, taxId: true } });'), true);
    assert.equal(readsLegalIdentity('await prisma.organization.findUnique({ where: { id }, select: { id: true, name: true } });'), false);
    assert.equal(readsLegalIdentity("// organization.taxId is deprecated"), false);
    assert.equal(readsLegalIdentity("const z = identity.taxId;"), false);
  });
});

describe("Estructura societaria · contrato L1 (schema, migraciones, tipos, permisos, runbook)", () => {
  const schema = read("packages/database/prisma/schema.prisma");
  const step1 = read("packages/database/prisma/migrations/20260916100000_estructura_societaria/migration.sql");
  const harden = read("packages/database/prisma/migrations/20260916101000_estructura_societaria_harden/migration.sql");

  function modelBlock(name) {
    const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
    assert.ok(match, `model ${name} exists`);
    return match[1];
  }

  it("declares LegalEntity, VerifactuInstallation and the PropertyKind enum with the agreed columns", () => {
    const entity = modelBlock("LegalEntity");
    for (const field of ["organizationId", "code", "legalName", "taxId", "legalForm", "fiscalAddress", "fiscalIneCode", "pgcVariant", "fiscalYearStartMonth", "largeCompany", "siiEnabled", "verifactuChainScope", "cccPrincipal", "isDefault", "status"]) {
      assert.match(entity, new RegExp(`^\\s+${field}\\s`, "m"), `LegalEntity.${field}`);
    }
    assert.match(entity, /taxId\s+String\?\s+@unique/);
    assert.match(entity, /@@unique\(\[organizationId, code\]\)/);
    const installation = modelBlock("VerifactuInstallation");
    assert.match(installation, /numeroInstalacion\s+String/);
    assert.match(installation, /retiredAt\s+DateTime\?/);
    assert.match(installation, /@@unique\(\[legalEntityId, numeroInstalacion\]\)/);
    assert.match(schema, /^enum PropertyKind \{\n  hotel\n  office\n  other\n\}/m);
    const property = modelBlock("Property");
    for (const field of ["legalEntityId", "kind", "code", "tradeName", "cadastralReference", "surfaceM2", "iaeEpigraph", "bedCapacity", "starRating", "openingMonths", "tourismRegistryNumber", "sesEstablishmentCode", "socialSecurityCcc", "laborCenterCode"]) {
      assert.match(property, new RegExp(`^\\s+${field}\\s`, "m"), `Property.${field}`);
    }
    assert.match(property, /kind\s+PropertyKind\s+@default\(hotel\)/);
    assert.match(property, /@@unique\(\[legalEntityId, code\]\)/);
    assert.match(modelBlock("InvoiceSequence"), /legalEntityId\s+String\?/);
    assert.match(modelBlock("Invoice"), /legalEntityId\s+String\?/);
    assert.match(modelBlock("Invoice"), /installationId\s+String\?/);
    assert.match(modelBlock("VerifactuSubmission"), /installationId\s+String\?/);
    assert.match(modelBlock("BankAccount"), /legalEntityId\s+String\?/);
  });

  it("marks the deprecated columns in the schema", () => {
    assert.match(modelBlock("Organization"), /\/\/\/ deprecated[^\n]*LegalEntity\.legalName/);
    assert.match(modelBlock("Organization"), /\/\/\/ deprecated[^\n]*LegalEntity\.taxId/);
    assert.match(modelBlock("Property"), /\/\/\/ deprecated[^\n]*never the issuer's legal name/);
    assert.match(modelBlock("PropertyComplianceSetting"), /\/\/\/ deprecated[^\n]*LegalEntity\.siiEnabled/);
  });

  it("step 1 is additive (nullable columns, new tables, FKs) and ships the two immutability triggers", () => {
    assert.match(step1, /migrate diff --from-schema-datasource/);
    assert.match(step1, /^CREATE TABLE "legal_entities" \(/m);
    assert.match(step1, /^CREATE TABLE "verifactu_installations" \(/m);
    assert.match(step1, /^CREATE TYPE "PropertyKind" AS ENUM \('hotel', 'office', 'other'\);/m);
    const propertiesAlter = /ALTER TABLE "properties" ADD COLUMN[\s\S]*?;/.exec(step1)?.[0] ?? "";
    assert.match(propertiesAlter, /ADD COLUMN\s+"legal_entity_id" TEXT,/, "properties.legal_entity_id is nullable until L2 writers set it");
    assert.doesNotMatch(propertiesAlter, /"legal_entity_id" TEXT NOT NULL/);
    for (const table of ["invoice_sequences", "invoices", "bank_accounts"]) {
      assert.match(step1, new RegExp(`ALTER TABLE "${table}" ADD COLUMN[^;]*"legal_entity_id" TEXT[,;]`), `${table}.legal_entity_id nullable`);
    }
    assert.match(step1, /CREATE OR REPLACE FUNCTION hotelos_verifactu_installation_immutable\(\)/);
    assert.match(step1, /CREATE TRIGGER verifactu_installations_numero_inmutable/);
    assert.match(step1, /CREATE OR REPLACE FUNCTION hotelos_invoice_issuer_immutable\(\)/);
    assert.match(step1, /CREATE TRIGGER invoices_issuer_inmutable/);
    assert.match(step1, /BEFORE UPDATE OF "issuer_tax_id", "issuer_legal_name" ON "invoices"/);
    assert.equal((step1.match(/ADD CONSTRAINT "\w+" FOREIGN KEY/g) ?? []).length, 2);
  });

  it("step 2 creates only what the duplicate report allowed and documents every deferred constraint", () => {
    assert.match(harden, /CREATE UNIQUE INDEX "legal_entities_tax_id_key" ON "legal_entities"\("tax_id"\)/);
    assert.match(harden, /-- BackfillSequencePrefix/);
    assert.doesNotMatch(harden, /^ALTER TABLE "invoice_sequences" ALTER COLUMN "prefix" SET NOT NULL;/m);
    assert.match(harden, /DEFERRED/);
    for (const deferred of ["upper\\(prefix\\)", "invoices_legal_entity_id_invoice_number_key", 'ALTER TABLE properties\\s+ALTER COLUMN legal_entity_id SET NOT NULL', "bank_accounts\\s+ALTER COLUMN property_id DROP NOT NULL"]) {
      assert.match(harden, new RegExp(deferred), `harden header documents: ${deferred}`);
    }
    assert.match(harden, /FAC-2026-000001/, "names the demo duplicate that blocks the invoice-number index");
  });

  it("ships the shared types, the permissions, the env flag, the backfill CLI and the series guard", () => {
    const types = read("packages/shared/src/legal-structure-types.ts");
    for (const name of ["PropertyKind", "LegalEntityDto", "PropertyEstablishmentDto", "VerifactuInstallationDto", "LegalIdentityDto", "FinanceScope", "StructureMode", "CorporateAllocation", "LegalStructureErrorCode", "SeriesPrefixClashDetails"]) {
      assert.match(types, new RegExp(`export type ${name}\\b`), `legal-structure-types exports ${name}`);
    }
    const permissions = read("packages/shared/src/permissions.ts");
    assert.match(permissions, /"accounting\.entity\.read":/);
    assert.match(permissions, /"organization\.structure\.manage":/);
    assert.match(read("packages/shared/src/types.ts"), /\| "accounting\.entity\.read"\n\s+\| "organization\.structure\.manage"/);
    const env = read("apps/api/src/lib/env.ts");
    assert.match(env, /STRUCTURE_ENABLED: \{/);
    assert.match(env, /VERIFACTU_INSTALL_NUMBER: \{[\s\S]*?verifactu_installations/);
    const backfill = read("apps/api/src/scripts/backfill-legal-structure.ts");
    assert.match(backfill, /--apply/);
    assert.match(backfill, /--confirm/);
    assert.match(backfill, /LEGAL_STRUCTURE_BACKFILLED/);
    assert.match(backfill, /hydrateAuditChainFromPostgres/);
    const guard = read("apps/api/src/modules/invoicing/series-prefix.service.ts");
    assert.match(guard, /export async function assertSeriesPrefixFree\(/);
    assert.match(guard, /SERIES_PREFIX_CLASH/);
  });

  it("the runbook documents the data contract of the sociedad layer", () => {
    const runbook = read("docs/runbooks/finanzas-contabilidad.md");
    assert.match(runbook, /^## 17\. Estructura societaria/m);
    for (const token of ["`LegalEntity`", "`VerifactuInstallation`", "`PropertyKind`", "20260916100000_estructura_societaria", "20260916101000_estructura_societaria_harden", "backfill-legal-structure.ts", "resolveLegalIdentity", "resolveLedgerScope", "listOperationalProperties", "assertSeriesPrefixFree", "SERIES_PREFIX_CLASH", "accounting.entity.read", "organization.structure.manage", "STRUCTURE_ENABLED"]) {
      assert.ok(runbook.includes(token), `runbook §17 mentions ${token}`);
    }
  });
});
