// Pure unit tests for the legal-structure backfill CLI (Tanda 6b · L1). No
// database: flag parsing, code derivation, NIF resolution, clash / duplicate
// reports, installation planning, the organisation plan on Faranda-like and
// org_123-like snapshots and — the contract of the lot — idempotency: planning
// again over the post-state of a plan yields zero writes. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/backfill-legal-structure.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  AUDIT_ACTION,
  CODE_MAX_LENGTH,
  SANDBOX_INSTALL_NUMBER,
  USAGE,
  applyPlanToSnapshot,
  brandTokensOf,
  codeTokens,
  confirmsOrganization,
  deriveCode,
  detectInvoiceNumberDuplicates,
  detectPrefixClashes,
  envInstallNumber,
  normalizeToken,
  parseFlags,
  planInstallations,
  planOrganization,
  printHuman,
  resolveEntityTaxId,
  uniqueCode,
  type BackfillSummary,
  type OrgSnapshot
} from "../backfill-legal-structure.js";

const here = dirname(fileURLToPath(import.meta.url));
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const RIAS_ALTAS = "cmrhw9jy40003fyvbuu2ec2w7";
const LOS_TILOS = "cmu1mifcp0000fyo1wzvq7txo";

// ── Fixtures: the two live demo tenants as the local DB held them on 2026-09-16 ──

function farandaSnapshot(): OrgSnapshot {
  return {
    organization: { id: FARANDA_ORG, name: "Faranda Hotels & Resorts", legalName: "Faranda Hotels & Resorts", taxId: "B99999997" },
    legalEntity: null,
    properties: [
      { id: RIAS_ALTAS, name: "Hotel Faranda Rías Altas by Ascend Collection", legalName: "Hotel Faranda Rías Altas by Ascend Collection", kind: "hotel", code: null, tradeName: null, legalEntityId: null, createdAt: new Date("2026-01-10T10:00:00Z") },
      { id: LOS_TILOS, name: "Faranda Los Tilos, Ascend Hotel Collection", legalName: null, kind: "hotel", code: null, tradeName: null, legalEntityId: null, createdAt: new Date("2026-09-14T10:00:00Z") }
    ],
    installations: [],
    sequences: [
      { id: "seq_ra_fac", propertyId: RIAS_ALTAS, sequenceCode: "FAC", prefix: "FAC-2026-", year: 2026, active: true, legalEntityId: null },
      { id: "seq_ra_rec", propertyId: RIAS_ALTAS, sequenceCode: "REC", prefix: "REC-2026-", year: 2026, active: true, legalEntityId: null },
      { id: "seq_lt_fac", propertyId: LOS_TILOS, sequenceCode: "FAC", prefix: "FAC-LT-2026-", year: 2026, active: true, legalEntityId: null },
      { id: "seq_lt_rec", propertyId: LOS_TILOS, sequenceCode: "REC", prefix: "REC-LT-2026-", year: 2026, active: true, legalEntityId: null }
    ],
    invoices: [
      { propertyId: RIAS_ALTAS, total: 25, missingEntity: 25, chained: 25, chainedMissingInstallation: 25 },
      { propertyId: LOS_TILOS, total: 0, missingEntity: 0, chained: 0, chainedMissingInstallation: 0 }
    ],
    issuedNumbers: Array.from({ length: 22 }, (_, i) => ({ propertyId: RIAS_ALTAS, invoiceNumber: `FAC-2026-${String(i + 1).padStart(6, "0")}` })),
    submissions: [
      { propertyId: RIAS_ALTAS, total: 33, missingInstallation: 33, installNumbers: ["DEV-001"] },
      { propertyId: LOS_TILOS, total: 0, missingInstallation: 0, installNumbers: [] }
    ],
    bankAccounts: { total: 0, missingEntity: 0 },
    siiProperties: [RIAS_ALTAS],
    foreignTaxIds: []
  };
}

function org123Snapshot(): OrgSnapshot {
  return {
    organization: { id: "org_123", name: "HotelOS Demo Group", legalName: "HotelOS Demo SL", taxId: "B12345674" },
    legalEntity: null,
    properties: [
      { id: "prop_123", name: "Anfitorio Madrid Centro", legalName: "Anfitorio Madrid Centro SL", kind: "hotel", code: null, tradeName: null, legalEntityId: null, createdAt: new Date("2025-05-01T00:00:00Z") },
      { id: "prop_canary", name: "Anfitorio Tenerife Sur", legalName: "Anfitorio Tenerife Sur SL", kind: "hotel", code: null, tradeName: null, legalEntityId: null, createdAt: new Date("2025-05-02T00:00:00Z") }
    ],
    installations: [],
    sequences: [
      { id: "s1", propertyId: "prop_123", sequenceCode: "FAC", prefix: "FAC-2026-", year: 2026, active: true, legalEntityId: null },
      { id: "s2", propertyId: "prop_123", sequenceCode: "REC", prefix: "REC-2026-", year: 2026, active: true, legalEntityId: null },
      { id: "s3", propertyId: "prop_123", sequenceCode: "SIM", prefix: "SIM-2026-", year: 2026, active: true, legalEntityId: null },
      { id: "s4", propertyId: "prop_canary", sequenceCode: "FAC", prefix: "FAC-2026-", year: 2026, active: true, legalEntityId: null }
    ],
    invoices: [
      { propertyId: "prop_123", total: 7, missingEntity: 7, chained: 7, chainedMissingInstallation: 7 },
      { propertyId: "prop_canary", total: 1, missingEntity: 1, chained: 1, chainedMissingInstallation: 1 }
    ],
    issuedNumbers: [
      { propertyId: "prop_123", invoiceNumber: "FAC-2026-000001" },
      { propertyId: "prop_123", invoiceNumber: "FAC-2026-000002" },
      { propertyId: "prop_canary", invoiceNumber: "FAC-2026-000001" }
    ],
    submissions: [
      { propertyId: "prop_123", total: 7, missingInstallation: 7, installNumbers: ["DEV-001"] },
      { propertyId: "prop_canary", total: 1, missingInstallation: 1, installNumbers: ["DEV-001"] }
    ],
    bankAccounts: { total: 0, missingEntity: 0 },
    siiProperties: [],
    foreignTaxIds: []
  };
}

// ── Flags ─────────────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("defaults to dry-run over every organisation", () => {
    assert.deepEqual(parseFlags([]), { apply: false, confirm: [], orgs: [], installNumber: null, json: false, help: false });
    assert.deepEqual(parseFlags(["--dry-run", "--json"]).json, true);
  });
  it("--help / -h short-circuit and USAGE names every flag", () => {
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["--apply", "-h"]).help, true);
    for (const flag of ["--dry-run", "--apply", "--confirm", "--org", "--install-number", "--json", "--help"]) assert.ok(USAGE.includes(flag), `USAGE mentions ${flag}`);
  });
  it("--apply requires --confirm; --confirm without --apply is refused; dry-run and apply are exclusive", () => {
    assert.throws(() => parseFlags(["--apply"]), /--confirm/);
    assert.throws(() => parseFlags(["--confirm", "org_123"]), /only makes sense with --apply/);
    assert.throws(() => parseFlags(["--dry-run", "--apply", "--confirm", "all"]), /mutually exclusive/);
  });
  it("--confirm all cannot be mixed with ids; ids are repeatable; --org limits the set; --install-number is captured", () => {
    assert.throws(() => parseFlags(["--apply", "--confirm", "all", "--confirm", "org_123"]), /cannot be combined/);
    const flags = parseFlags(["--apply", "--confirm", "org_123", "--confirm", FARANDA_ORG, "--org", "org_123", "--install-number", "INST-0007"]);
    assert.deepEqual(flags.confirm, ["org_123", FARANDA_ORG]);
    assert.deepEqual(flags.orgs, ["org_123"]);
    assert.equal(flags.installNumber, "INST-0007");
    assert.throws(() => parseFlags(["--install-number"]), /requires a value/);
    assert.throws(() => parseFlags(["--bogus"]), /Unknown flag/);
  });
  it("confirmsOrganization honours ids and the literal all", () => {
    assert.equal(confirmsOrganization({ confirm: ["all"] }, "anything"), true);
    assert.equal(confirmsOrganization({ confirm: ["org_123"] }, "org_123"), true);
    assert.equal(confirmsOrganization({ confirm: ["org_123"] }, FARANDA_ORG), false);
  });
  it("envInstallNumber reads VERIFACTU_INSTALL_NUMBER and treats blanks as unset", () => {
    assert.equal(envInstallNumber({}), null);
    assert.equal(envInstallNumber({ VERIFACTU_INSTALL_NUMBER: "  " }), null);
    assert.equal(envInstallNumber({ VERIFACTU_INSTALL_NUMBER: " INST-1 " }), "INST-1");
  });
});

// ── Codes ─────────────────────────────────────────────────────────────────────

describe("code derivation (Property.code / LegalEntity.code)", () => {
  const brand = brandTokensOf({ name: "Faranda Hotels & Resorts", legalName: "Faranda Hotels & Resorts" });

  it("normalizes accents and case (Rías → rias)", () => {
    assert.equal(normalizeToken("Rías"), "rias");
    assert.equal(normalizeToken("S.L."), "sl");
  });
  it("drops brand and lodging words, cuts at « by » and at the first comma, keeps articles", () => {
    assert.deepEqual(codeTokens("Hotel Faranda Rías Altas by Ascend Collection", brand), ["Rías", "Altas"]);
    assert.deepEqual(codeTokens("Faranda Los Tilos, Ascend Hotel Collection", brand), ["Los", "Tilos"]);
  });
  it("derives the codes the design expects: RA, LT, AMC, ATS", () => {
    assert.equal(deriveCode("Hotel Faranda Rías Altas by Ascend Collection", brand), "RA");
    assert.equal(deriveCode("Faranda Los Tilos, Ascend Hotel Collection", brand), "LT");
    const demoBrand = brandTokensOf({ name: "HotelOS Demo Group", legalName: "HotelOS Demo SL" });
    assert.equal(deriveCode("Anfitorio Madrid Centro", demoBrand), "AMC");
    assert.equal(deriveCode("Anfitorio Tenerife Sur", demoBrand), "ATS");
  });
  it("a single meaningful token yields its first three letters; a legal name drops the legal form", () => {
    assert.equal(deriveCode("Faranda Hotels & Resorts"), "FAR");
    assert.equal(deriveCode("HotelOS Demo SL"), "HD");
    assert.equal(deriveCode("Hotel Sol"), "SOL");
  });
  it("never yields fewer than 2 or more than CODE_MAX_LENGTH characters", () => {
    for (const name of ["X", "Hotel", "A B C D E F G H", "Ñ"]) {
      const code = deriveCode(name);
      assert.match(code, /^[A-Z0-9]{2,6}$/, `${name} → ${code}`);
      assert.ok(code.length <= CODE_MAX_LENGTH);
    }
  });
  it("uniqueCode appends 2, 3… on collision within the length cap", () => {
    assert.equal(uniqueCode("RA", new Set()), "RA");
    assert.equal(uniqueCode("RA", new Set(["RA"])), "RA2");
    assert.equal(uniqueCode("RA", new Set(["RA", "RA2"])), "RA3");
    assert.equal(uniqueCode("ABCDEF", new Set(["ABCDEF"])), "ABCDE2");
  });
});

// ── NIF ───────────────────────────────────────────────────────────────────────

describe("resolveEntityTaxId", () => {
  it("copies a valid, unclaimed NIF in normalised form (the two demo tenants)", () => {
    assert.deepEqual(resolveEntityTaxId(" es-b99999997 ", new Set()), { taxId: "B99999997", warning: null });
    assert.deepEqual(resolveEntityTaxId("B12345674", new Set()), { taxId: "B12345674", warning: null });
  });
  it("leaves the NIF pending with a typed warning for missing, placeholder, invalid and duplicated values", () => {
    assert.equal(resolveEntityTaxId(null, new Set()).warning?.code, "TAX_ID_MISSING");
    assert.equal(resolveEntityTaxId("B00000000", new Set()).warning?.code, "TAX_ID_PLACEHOLDER");
    assert.equal(resolveEntityTaxId("B12345678", new Set()).warning?.code, "TAX_ID_INVALID");
    assert.equal(resolveEntityTaxId("B12345674", new Set(["B12345674"])).warning?.code, "TAX_ID_DUPLICATE");
    for (const raw of [null, "B00000000", "B12345678"]) assert.equal(resolveEntityTaxId(raw, new Set()).taxId, null);
  });
});

// ── Reports ───────────────────────────────────────────────────────────────────

describe("duplicate reports", () => {
  it("detectPrefixClashes flags the same upper(prefix) + year in two properties, ignores closed series and other years", () => {
    const rows = [
      { propertyId: "a", prefix: "FAC-2026-", year: 2026, active: true },
      { propertyId: "b", prefix: "fac-2026-", year: 2026, active: true },
      { propertyId: "c", prefix: "FAC-2026-", year: 2026, active: false },
      { propertyId: "d", prefix: "FAC-2027-", year: 2027, active: true }
    ];
    const warnings = detectPrefixClashes(rows);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, "SERIES_PREFIX_CLASH");
    assert.deepEqual(warnings[0]?.details, { prefix: "FAC-2026-", year: 2026, propertyIds: ["a", "b"] });
    assert.deepEqual(detectPrefixClashes([{ propertyId: "a", prefix: "FAC-2026-", year: 2026, active: true }, { propertyId: "a", prefix: "FAC-2026-", year: 2026, active: true }]), [], "same property is not a clash");
  });
  it("detectInvoiceNumberDuplicates flags a number issued in two properties", () => {
    const warnings = detectInvoiceNumberDuplicates([
      { propertyId: "prop_123", invoiceNumber: "FAC-2026-000001" },
      { propertyId: "prop_canary", invoiceNumber: "FAC-2026-000001" },
      { propertyId: "prop_123", invoiceNumber: "FAC-2026-000002" }
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, "INVOICE_NUMBER_DUPLICATE");
    assert.deepEqual(warnings[0]?.details, { invoiceNumber: "FAC-2026-000001", propertyIds: ["prop_123", "prop_canary"] });
  });
});

// ── Installations ─────────────────────────────────────────────────────────────

describe("planInstallations", () => {
  it("creates one installation per property WITH submissions, inheriting the number the records declared", () => {
    const snapshot = farandaSnapshot();
    const result = planInstallations({
      properties: [{ id: RIAS_ALTAS, code: "RA" }, { id: LOS_TILOS, code: "LT" }],
      submissions: snapshot.submissions,
      invoices: snapshot.invoices,
      existing: [],
      declaredNumber: null
    });
    assert.deepEqual(result.plans, [{ propertyId: RIAS_ALTAS, numeroInstalacion: "DEV-001", action: "create", id: null, invoicesToLink: 25, submissionsToLink: 33 }]);
    assert.deepEqual(result.warnings, [], "a number declared in the records needs no warning");
  });
  it("suffixes a second property of the same entity with the property code and warns; --install-number wins over the sandbox filler", () => {
    const snapshot = org123Snapshot();
    const result = planInstallations({
      properties: [{ id: "prop_123", code: "AMC" }, { id: "prop_canary", code: "ATS" }],
      submissions: snapshot.submissions,
      invoices: snapshot.invoices,
      existing: [],
      declaredNumber: null
    });
    assert.deepEqual(result.plans.map((p) => p.numeroInstalacion), ["DEV-001", "DEV-001-ATS"]);
    assert.deepEqual(result.warnings.map((w) => w.code), ["INSTALLATION_NUMBER_SUFFIXED"]);
    const declared = planInstallations({
      properties: [{ id: "p1", code: "P1" }],
      submissions: [{ propertyId: "p1", total: 3, missingInstallation: 3, installNumbers: [] }],
      invoices: [{ propertyId: "p1", total: 3, missingEntity: 3, chained: 3, chainedMissingInstallation: 3 }],
      existing: [],
      declaredNumber: "INST-0042"
    });
    assert.equal(declared.plans[0]?.numeroInstalacion, "INST-0042");
    assert.deepEqual(declared.warnings, []);
  });
  it("falls back to the sandbox filler with a warning when nothing is declared, and reuses an existing installation", () => {
    const fallback = planInstallations({
      properties: [{ id: "p1", code: "P1" }],
      submissions: [{ propertyId: "p1", total: 2, missingInstallation: 2, installNumbers: [] }],
      invoices: [],
      existing: [],
      declaredNumber: null
    });
    assert.equal(fallback.plans[0]?.numeroInstalacion, SANDBOX_INSTALL_NUMBER);
    assert.deepEqual(fallback.warnings.map((w) => w.code), ["INSTALLATION_NUMBER_SANDBOX_DEFAULT"]);
    const reuse = planInstallations({
      properties: [{ id: "p1", code: "P1" }],
      submissions: [{ propertyId: "p1", total: 2, missingInstallation: 1, installNumbers: ["DEV-001"] }],
      invoices: [{ propertyId: "p1", total: 2, missingEntity: 0, chained: 2, chainedMissingInstallation: 1 }],
      existing: [{ id: "vfi_1", legalEntityId: "le_1", propertyId: "p1", numeroInstalacion: "DEV-001", active: true }],
      declaredNumber: null
    });
    assert.deepEqual(reuse.plans, [{ propertyId: "p1", numeroInstalacion: "DEV-001", action: "exists", id: "vfi_1", invoicesToLink: 1, submissionsToLink: 1 }]);
  });
  it("SANDBOX_INSTALL_NUMBER mirrors VERIFACTU_SOFTWARE_DEFAULTS.numeroInstalacion of packages/compliance", () => {
    const source = readFileSync(resolve(here, "../../../../../packages/compliance/src/spain/verifactu/software.ts"), "utf8");
    const match = /numeroInstalacion:\s*"([^"]+)"/.exec(source);
    assert.equal(match?.[1], SANDBOX_INSTALL_NUMBER);
  });
});

// ── Organisation plan ─────────────────────────────────────────────────────────

describe("planOrganization", () => {
  it("Faranda: one implicit legal entity with the valid NIF, RA/LT codes, tradeName only where the old legalName differed, one installation, SII warning", () => {
    const claimed = new Set<string>();
    const plan = planOrganization(farandaSnapshot(), { declaredInstallNumber: null, claimedTaxIds: claimed });
    assert.equal(plan.legalEntity.action, "create");
    assert.equal(plan.legalEntity.code, "FAR");
    assert.equal(plan.legalEntity.legalName, "Faranda Hotels & Resorts");
    assert.equal(plan.legalEntity.taxId, "B99999997");
    assert.ok(claimed.has("B99999997"), "the NIF is claimed for later organisations of the same run");
    const ra = plan.properties.find((p) => p.id === RIAS_ALTAS)!;
    const lt = plan.properties.find((p) => p.id === LOS_TILOS)!;
    assert.deepEqual(ra.set, { code: "RA", legalEntityId: plan.legalEntity.id, tradeName: "Hotel Faranda Rías Altas by Ascend Collection" });
    assert.deepEqual(lt.set, { code: "LT", legalEntityId: plan.legalEntity.id });
    assert.deepEqual(plan.installations.map((i) => [i.propertyId, i.numeroInstalacion, i.action]), [[RIAS_ALTAS, "DEV-001", "create"]]);
    assert.deepEqual(plan.sequences, { total: 4, toLink: 4 });
    assert.deepEqual(plan.invoices, { total: 25, toLink: 25 });
    assert.deepEqual(plan.warnings.map((w) => w.code), ["SII_FLAG_ON_PROPERTY"]);
    // 1 entity + 2 properties + 1 installation + 25 chained invoices + 33 submissions + 4 sequences + 25 invoices + 0 banks
    assert.equal(plan.writes, 1 + 2 + 1 + 25 + 33 + 4 + 25);
  });
  it("org_123: AMC/ATS codes, suffixed installation, and the two duplicate reports that defer the unique indexes", () => {
    const plan = planOrganization(org123Snapshot(), { declaredInstallNumber: null, claimedTaxIds: new Set() });
    assert.equal(plan.legalEntity.code, "HD");
    assert.equal(plan.legalEntity.taxId, "B12345674");
    assert.deepEqual(plan.properties.map((p) => p.code), ["AMC", "ATS"]);
    assert.deepEqual(plan.installations.map((i) => i.numeroInstalacion), ["DEV-001", "DEV-001-ATS"]);
    assert.deepEqual(plan.warnings.map((w) => w.code).sort(), ["INSTALLATION_NUMBER_SUFFIXED", "INVOICE_NUMBER_DUPLICATE", "SERIES_PREFIX_CLASH"]);
    assert.equal(plan.writes, 1 + 2 + 2 + 8 + 8 + 4 + 8);
  });
  it("a NIF already claimed by another organisation of the run (or a foreign legal entity) stays pending with TAX_ID_DUPLICATE", () => {
    const claimed = new Set<string>(["B99999997"]);
    const plan = planOrganization(farandaSnapshot(), { declaredInstallNumber: null, claimedTaxIds: claimed });
    assert.equal(plan.legalEntity.taxId, null);
    assert.ok(plan.warnings.some((w) => w.code === "TAX_ID_DUPLICATE"));
    const foreign = farandaSnapshot();
    foreign.foreignTaxIds = ["b99999997"];
    assert.equal(planOrganization(foreign, { declaredInstallNumber: null, claimedTaxIds: new Set() }).legalEntity.taxId, null);
  });
  it("an existing legal entity is reused, an existing code is kept, and a property pointing at another entity is left alone with a warning", () => {
    const snapshot = farandaSnapshot();
    snapshot.legalEntity = { id: "le_existing", code: "CEL", legalName: "CELUISMA S.A.", taxId: null };
    snapshot.properties[0] = { ...snapshot.properties[0]!, code: "RIAS", legalEntityId: "le_existing", tradeName: "Rías Altas" };
    snapshot.properties[1] = { ...snapshot.properties[1]!, legalEntityId: "le_other" };
    const plan = planOrganization(snapshot, { declaredInstallNumber: null, claimedTaxIds: new Set() });
    assert.equal(plan.legalEntity.action, "exists");
    assert.equal(plan.legalEntity.id, "le_existing");
    assert.equal(plan.properties[0]?.action, "skip");
    assert.equal(plan.properties[0]?.code, "RIAS");
    assert.deepEqual(plan.properties[1]?.set, { code: "LT" });
    assert.ok(plan.warnings.some((w) => w.code === "PROPERTY_ENTITY_MISMATCH"));
  });
  it("is idempotent: planning over the post-state of a plan yields zero writes and only report-type warnings", () => {
    for (const snapshot of [farandaSnapshot(), org123Snapshot()]) {
      const first = planOrganization(snapshot, { declaredInstallNumber: null, claimedTaxIds: new Set() });
      assert.ok(first.writes > 0);
      const after = applyPlanToSnapshot(snapshot, first);
      const second = planOrganization(after, { declaredInstallNumber: null, claimedTaxIds: new Set() });
      assert.equal(second.writes, 0, `${snapshot.organization.id} converged`);
      assert.equal(second.legalEntity.action, "exists");
      assert.ok(second.properties.every((p) => p.action === "skip"));
      assert.ok(second.installations.every((i) => i.action === "exists"));
      const reportOnly = new Set(["SERIES_PREFIX_CLASH", "INVOICE_NUMBER_DUPLICATE", "SII_FLAG_ON_PROPERTY"]);
      assert.ok(second.warnings.every((w) => reportOnly.has(w.code)), JSON.stringify(second.warnings.map((w) => w.code)));
      const third = planOrganization(applyPlanToSnapshot(after, second), { declaredInstallNumber: null, claimedTaxIds: new Set() });
      assert.equal(third.writes, 0);
    }
  });
});

// ── Output ────────────────────────────────────────────────────────────────────

describe("printHuman", () => {
  it("prints the plan, the warnings and the dry-run reminder", () => {
    const plan = planOrganization(org123Snapshot(), { declaredInstallNumber: null, claimedTaxIds: new Set() });
    const summary: BackfillSummary = {
      dryRun: true,
      installNumberSource: "none",
      organizations: [{ organizationId: "org_123", label: "HotelOS Demo Group", confirmed: false, plan, applied: false, counts: null, verification: null }],
      durationMs: 5
    };
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      printHuman(summary);
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    assert.match(output, /DRY-RUN/);
    assert.match(output, /sociedad: CREAR HD «HotelOS Demo SL» NIF B12345674/);
    assert.match(output, /centro AMC · hotel/);
    assert.match(output, /AVISO SERIES_PREFIX_CLASH/);
    assert.match(output, /AVISO INVOICE_NUMBER_DUPLICATE/);
    assert.match(output, /Nada escrito/);
    assert.equal(AUDIT_ACTION, "LEGAL_STRUCTURE_BACKFILLED");
  });
});
