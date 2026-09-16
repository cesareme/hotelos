// Estructura societaria · lote fix:integrador (Tanda 6b, 2026-09-16) — contrato
// de texto de las correcciones t6b#7 / #9 / #12 / #13 / #14 (sin BD;
// `corepack pnpm test`). El comportamiento real sobre Postgres se prueba en
// tests/integration/integrador-fix-t6b.test.mts.
//   · t6b#7  el go-live de onboarding materializa la sociedad implícita y un
//            centro codificado (materialiseOnboardingStructure) y NINGÚN módulo
//            escribe ya Organization.legalName/taxId ni Property.legalName
//            (contrato de escritores, lista que solo encoge);
//   · t6b#9  GET /organizations/me/structure se redacta sin accounting.entity.read
//            ∨ organization.structure.manage y GET /legal-entities/:id exige
//            accounting.entity.read; recepción no lleva ninguna de las dos;
//   · t6b#12 la carpeta de inspección, el buscador y el resumen de propiedad
//            no leen Property.legalName (razón social = sociedad);
//   · t6b#13 los schedulers de cupos y cut-off iteran listOperationalProperties;
//   · t6b#14 imports relativos a packages/shared/src: lista cerrada que solo encoge.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const toPosix = (path) => path.split("\\").join("/");

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

/** Balanced argument list of the call whose `(` follows `start` (handles nested objects / arrays). */
function callArgument(source, start) {
  const open = source.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** Source between the declaration of `name` and the next top-level `\n}` (function body). */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end);
}

/** Body of a template in ROLE_PERMISSION_MAP (`  <key>: [ … ],`). */
function templateBlock(permissionsSource, key) {
  const start = permissionsSource.indexOf(`\n  ${key}: [`);
  assert.ok(start >= 0, `template ${key} not found`);
  const end = permissionsSource.indexOf("\n  ],", start);
  return permissionsSource.slice(start, end);
}

const onboarding = read("apps/api/src/modules/onboarding/onboarding.service.ts");
const legalEntityService = read("apps/api/src/modules/structure/legal-entity.service.ts");
const structurePartial = read("apps/api/src/modules/structure/route-permissions.partial.ts");
const securityManifest = read("apps/api/src/security/route-permissions.ts");
const permissions = read("packages/shared/src/permissions.ts");
const server = read("apps/api/src/server.ts");

// ── t6b#7 ───────────────────────────────────────────────────────────────────

describe("t6b#7 · el go-live de onboarding crea la sociedad implícita y un centro codificado", () => {
  it("materialiseOnboardingStructure existe, la usa materialiseOnboardingProject y no queda ningún organization.upsert", () => {
    assert.match(onboarding, /export async function materialiseOnboardingStructure\(/);
    const body = functionBody(onboarding, "async function materialiseOnboardingProject(");
    assert.match(body, /await materialiseOnboardingStructure\(\{/);
    assert.doesNotMatch(onboarding, /\.organization\.upsert\(/);
    assert.match(onboarding, /import \{ codeInUse, createImplicitLegalEntity, ensureDefaultLegalEntity, planPropertyCode \} from "\.\.\/structure\/legal-entity\.service\.js"/);
  });

  it("la sociedad y el centro se escriben en una transacción: nombre de la organización, LegalEntity con el NIF, Property con legalEntityId / kind / code / tradeName", () => {
    const body = functionBody(onboarding, "export async function materialiseOnboardingStructure(");
    assert.match(body, /prisma\.\$transaction\(async \(tx\) =>/);
    const organizationCreate = callArgument(body, body.indexOf("tx.organization.create("));
    assert.doesNotMatch(organizationCreate, /^\s*(taxId|legalName)\s*:/m, "the deprecated Organization columns are never written");
    assert.match(body, /createImplicitLegalEntity\(tx, \{/);
    assert.match(body, /ensureDefaultLegalEntity\(tx, existingOrganization\.id\)/);
    const propertyCreate = callArgument(body, body.indexOf("tx.property.create("));
    for (const token of ["legalEntityId: legalEntity.id", "kind: input.kind", "code", "...columns"]) {
      assert.ok(propertyCreate.includes(token), `property.create carries ${token}`);
    }
    assert.match(body, /const tradeName = input\.tradeName && input\.tradeName !== legalEntity\.legalName \? input\.tradeName : null/, "the trade name is stored only when it differs from the razón social");
    assert.match(body, /const columns = \{ \.\.\.input\.property, tradeName, status: "open" as const \}/);
    assert.doesNotMatch(propertyCreate, /^\s*legalName\s*:/m, "Property.legalName is deprecated: never written");
    assert.match(body, /throw codeInUse\("property", code\)/);
    assert.match(body, /throw new NotFoundError\("Propiedad no encontrada\."\)/, "a property of another organization is an opaque 404");
    assert.match(onboarding, /code: "TAX_ID_INVALID"/, "the NIF error of the payload is typed like the sociedad guard");
  });

  it("contrato de escritores: ningún módulo del API escribe Organization.taxId / legalName; Property.legalName solo en la lista heredada (que solo encoge)", () => {
    // file → lot that still writes Property.legalName. Only remove entries. Empty since the
    // final integration of the Tanda 6b (the backoffice profile upsert stopped copying it):
    // any writer of the deprecated column fails this test.
    const LEGACY_PROPERTY_LEGAL_NAME_WRITERS = {};
    const files = walk(join(ROOT, "apps/api/src/modules")).map((file) => toPosix(relative(ROOT, file)));
    const organizationWriters = [];
    const propertyWriters = [];
    for (const file of files) {
      const source = read(file);
      for (const match of source.matchAll(/\.organization\.(create|upsert|update|updateMany|createMany)\(/g)) {
        if (/^\s*(taxId|legalName)\s*:/m.test(callArgument(source, match.index))) organizationWriters.push(file);
      }
      for (const match of source.matchAll(/\.property\.(create|upsert|update|updateMany|createMany)\(/g)) {
        if (/^\s*legalName\s*:/m.test(callArgument(source, match.index))) propertyWriters.push(file);
      }
    }
    assert.deepEqual([...new Set(organizationWriters)], [], "Organization.taxId / legalName are deprecated: the NIF and the razón social live in LegalEntity (design §5.1 decisión 2)");
    const unexpected = [...new Set(propertyWriters)].filter((file) => !(file in LEGACY_PROPERTY_LEGAL_NAME_WRITERS)).sort();
    assert.deepEqual(unexpected, [], `nuevos escritores de Property.legalName: ${unexpected.join(", ")} → tradeName`);
    const stale = Object.keys(LEGACY_PROPERTY_LEGAL_NAME_WRITERS).filter((file) => !propertyWriters.includes(file));
    assert.deepEqual(stale, [], `entradas obsoletas en LEGACY_PROPERTY_LEGAL_NAME_WRITERS: ${stale.join(", ")}`);
  });
});

// ── t6b#9 ───────────────────────────────────────────────────────────────────

describe("t6b#9 · la estructura se redacta por centro asignado y la sociedad completa exige accounting.entity.read", () => {
  it("manifiesto: GET /organizations/me/structure conserva accounting.read (redactado en el servicio); GET /legal-entities/:id lleva accounting.entity.read", () => {
    assert.match(structurePartial, /\{ method: "GET", path: "\/organizations\/me\/structure", permissions: \["accounting\.read"\]/);
    assert.match(structurePartial, /\{ method: "GET", path: "\/legal-entities\/:legalEntityId", permissions: \["accounting\.entity\.read"\]/);
    const calendar = securityManifest.slice(securityManifest.indexOf("export const ACCOUNTING_CALENDAR_GET_PATHS"), securityManifest.indexOf("];", securityManifest.indexOf("export const ACCOUNTING_CALENDAR_GET_PATHS")));
    assert.ok(calendar.includes('"/organizations/me/structure"'), "the structure read stays a calendar-key GET");
    assert.ok(!calendar.includes('"/legal-entities/:legalEntityId"'), "the full legal-entity DTO left the calendar key");
  });

  it("servicio: ENTITY_WIDE_READ = accounting.entity.read ∨ organization.structure.manage; getStructure filtra por propertyWithinScope y redacta; getLegalEntity exige la lectura de sociedad", () => {
    assert.match(legalEntityService, /export const ENTITY_WIDE_READ: readonly PermissionKey\[\] = \["accounting\.entity\.read", "organization\.structure\.manage"\]/);
    assert.match(legalEntityService, /export function hasEntityWideRead\(/);
    assert.match(legalEntityService, /export function requireEntityWideRead\(/);
    assert.match(legalEntityService, /export function redactLegalEntityDto\(/);
    const getStructure = functionBody(legalEntityService, "export async function getStructure(");
    assert.match(getStructure, /const entityWide = hasEntityWideRead\(context\)/);
    assert.match(getStructure, /allProperties\.filter\(\(row\) => propertyWithinScope\(context, row\.id\)\)/);
    assert.match(getStructure, /scope: entityWide \? "entity" : "assigned_properties"/);
    assert.match(getStructure, /redactLegalEntityDto\(toLegalEntityDto\(entity\)\)/);
    const getLegalEntity = functionBody(legalEntityService, "export async function getLegalEntity(");
    assert.match(getLegalEntity, /requireEntityWideRead\(context\)/);
    assert.doesNotMatch(getLegalEntity, /STRUCTURE_READ_ANY/);
  });

  it("plantillas: recepción no lleva accounting.entity.read ni organization.structure.manage; dirección y contabilidad sí leen toda la sociedad", () => {
    const receptionist = templateBlock(permissions, "receptionist");
    assert.doesNotMatch(receptionist, /"accounting\.entity\.read"/);
    assert.doesNotMatch(receptionist, /"organization\.structure\.manage"/);
    assert.match(receptionist, /"accounting\.read"/, "reception keeps the calendar key (and the redacted structure)");
    for (const key of ["manager", "accountant"]) assert.match(templateBlock(permissions, key), /"accounting\.entity\.read"/, `${key} reads the whole sociedad`);
  });
});

// ── t6b#12 ──────────────────────────────────────────────────────────────────

describe("t6b#12 · Property.legalName (nombre comercial deprecado) no se imprime como razón social", () => {
  it("la carpeta de inspección toma el titular de resolveIssuerIdentity (sociedad + establecimiento)", () => {
    const source = read("apps/api/src/modules/compliance/compliance-inspection.service.ts");
    assert.match(source, /import \{ resolveIssuerIdentity \} from "\.\.\/invoicing\/issuer-identity\.service\.js"/);
    assert.match(source, /resolveIssuerIdentity\(propertyId\)/);
    assert.doesNotMatch(source, /\bproperty\??\.legalName\b/);
    assert.match(source, /titular: issuer \? \{ legalName: issuer\.legalName, taxId: issuer\.taxId, fiscalAddress: issuer\.fiscalAddress \} : null/);
    assert.match(source, /Titular: <strong>\$\{esc\(data\.titular\.legalName\)\}/);
    assert.match(source, /issuer\?\.establishment\.tradeName/);
  });

  it("el buscador y el resumen de propiedad usan tradeName / la identidad de la sociedad", () => {
    const search = read("apps/api/src/modules/search/search.service.ts");
    assert.doesNotMatch(search, /\b(p|property)\??\.legalName\b|legalName: \{ contains|legalName: true/);
    assert.match(search, /\{ tradeName: \{ contains: q, mode: "insensitive" \} \}/);
    const overview = read("apps/api/src/modules/dashboards/property-overview.service.ts");
    assert.doesNotMatch(overview, /\bproperty\??\.legalName\b/);
    assert.doesNotMatch(overview, /^\s*legalName: true,?$/m, "the deprecated column left the select");
    assert.match(overview, /resolveLegalIdentity\(property\.organizationId\)/);
    assert.match(overview, /legalName: legalIdentity\?\.legalName \?\? undefined/);
  });
});

// ── t6b#13 ──────────────────────────────────────────────────────────────────

describe("t6b#13 · los schedulers operativos iteran solo hoteles (R6)", () => {
  it("server.ts importa listOperationalProperties, define listSchedulerHotels sobre él y ambos schedulers lo usan", () => {
    assert.match(server, /import \{[^}]*\blistOperationalProperties\b[^}]*\} from "\.\/lib\/tenancy\.js"/s);
    assert.match(server, /const listSchedulerHotels = async \(\): Promise<Array<\{ id: string \}>> =>/);
    assert.match(server, /listOperationalProperties\(organization\.id, prismaClient, \{ includeClosed: true \}\)/);
    assert.match(server, /\.filter\(\(property\) => property\.status !== "archived"\)/, "archived centres keep being skipped");
    const release = server.slice(server.indexOf("// Allotment release scheduler"), server.indexOf("[allotment.release.scheduler] enabled"));
    const cutoff = server.slice(server.indexOf("// Group cut-off scheduler"), server.indexOf("[group.cutoff.scheduler] enabled"));
    assert.match(release, /const properties = await listSchedulerHotels\(\)/);
    assert.match(cutoff, /const properties = await listSchedulerHotels\(\)/);
    assert.doesNotMatch(release, /property\.findMany/);
    assert.doesNotMatch(cutoff, /property\.findMany/);
    assert.doesNotMatch(server, /property\.findMany\(\{\s*where:\s*\{\s*status:\s*\{\s*not:\s*"archived"\s*\}\s*\}/s, "no scheduler iterates every property regardless of kind");
  });
});

// ── t6b#14 ──────────────────────────────────────────────────────────────────

describe("t6b#14 · imports relativos a packages/shared/src (lista cerrada que solo encoge)", () => {
  /**
   * Files that still import a shared type file by relative path. `@hotelos/shared`
   * resolves to packages/shared/src/index.ts (tsconfig paths / tsx), which
   * re-exports every finance contract, so each entry is a pending cleanup of its
   * lot (L3 invoicing, L4 accounting/treasury, L5 financial-statements, payments,
   * folio, schemas, scripts). Only ever REMOVE entries.
   */
  const RELATIVE_SHARED_IMPORTERS = [
    "apps/api/src/modules/accounting/accounting.service.ts",
    "apps/api/src/modules/accounting/customer-account-relabel.ts",
    "apps/api/src/modules/accounting/posting-rules.ts",
    "apps/api/src/modules/accounting/projection.ts",
    "apps/api/src/modules/financial-statements/annual-accounts.service.ts",
    "apps/api/src/modules/financial-statements/gestoria-export.service.ts",
    "apps/api/src/modules/financial-statements/source.ts",
    "apps/api/src/modules/financial-statements/statement-render.ts",
    "apps/api/src/modules/financial-statements/usali-mapping.service.ts",
    "apps/api/src/modules/financial-statements/usali.service.ts",
    "apps/api/src/modules/folio/folio.service.ts",
    "apps/api/src/modules/invoicing/invoice-email.service.ts",
    "apps/api/src/modules/invoicing/invoice-snapshot.ts",
    "apps/api/src/modules/invoicing/invoice.service.ts",
    "apps/api/src/modules/invoicing/simplified-invoice.service.ts",
    "apps/api/src/modules/payments/payment-method.ts",
    "apps/api/src/modules/payments/payments.service.ts",
    "apps/api/src/modules/payments/psp/index.ts",
    "apps/api/src/modules/payments/psp/psp.types.ts",
    "apps/api/src/modules/treasury/ledger-bridge.ts",
    "apps/api/src/schemas/folios.schemas.ts",
    "apps/api/src/scripts/accounting-replay.ts"
  ];
  const RELATIVE_IMPORT = /from\s+"(?:\.\.\/)+packages\/shared\/src\/[^"]+"/;

  it("los tres ficheros de L5 del hallazgo importan de @hotelos/shared", () => {
    for (const file of ["allocation.service.ts", "pnl-by-property.service.ts", "financial-statements.routes.ts"]) {
      const source = read(`apps/api/src/modules/financial-statements/${file}`);
      assert.doesNotMatch(source, RELATIVE_IMPORT, `${file} still imports packages/shared/src by relative path`);
      assert.match(source, /from "@hotelos\/shared"/, `${file} imports @hotelos/shared`);
    }
  });

  it("ningún fichero nuevo importa packages/shared/src por ruta relativa; la lista heredada no tiene entradas obsoletas", () => {
    const files = walk(join(ROOT, "apps/api/src")).map((file) => toPosix(relative(ROOT, file)));
    const importers = files.filter((file) => RELATIVE_IMPORT.test(read(file))).sort();
    const unexpected = importers.filter((file) => !RELATIVE_SHARED_IMPORTERS.includes(file));
    assert.deepEqual(unexpected, [], `nuevos imports relativos a packages/shared/src: ${unexpected.join(", ")} → import from "@hotelos/shared"`);
    const stale = RELATIVE_SHARED_IMPORTERS.filter((file) => !importers.includes(file));
    assert.deepEqual(stale, [], `entradas obsoletas en RELATIVE_SHARED_IMPORTERS (ya migradas, bórralas): ${stale.join(", ")}`);
  });
});
