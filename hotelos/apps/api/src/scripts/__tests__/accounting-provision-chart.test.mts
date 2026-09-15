// Pure unit tests for the chart-of-accounts provisioning CLI: flag parsing,
// confirm guard and the human summary. No database. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/accounting-provision-chart.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIT_ACTION, USAGE, assertConfirmMatches, formatSummary, parseFlags } from "../accounting-provision-chart.js";

const FARANDA = "cmrhw9jy30002fyvb6tsdiugt";

describe("parseFlags", () => {
  it("defaults to dry-run with the organisation", () => {
    assert.deepEqual(parseFlags(["--org", FARANDA]), { orgs: [FARANDA], apply: false, confirm: [], json: false, help: false });
  });
  it("--help / -h short-circuit every other validation and USAGE names every flag", () => {
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["-h"]).help, true);
    assert.equal(parseFlags(["--apply", "--help"]).help, true);
    for (const flag of ["--org", "--dry-run", "--apply", "--confirm", "--json", "--help"]) assert.ok(USAGE.includes(flag), `USAGE mentions ${flag}`);
  });
  it("accepts several organisations, --dry-run and --json explicitly", () => {
    const flags = parseFlags(["--org", FARANDA, "--org", "org_123", "--dry-run", "--json"]);
    assert.deepEqual(flags.orgs, [FARANDA, "org_123"]);
    assert.equal(flags.apply, false);
    assert.equal(flags.json, true);
  });
  it("--apply requires --confirm and the confirmations must match the organisations", () => {
    assert.throws(() => parseFlags(["--org", FARANDA, "--apply"]), /--confirm/);
    const ok = parseFlags(["--org", FARANDA, "--org", "org_123", "--apply", "--confirm", FARANDA, "--confirm", "org_123"]);
    assert.doesNotThrow(() => assertConfirmMatches(ok));
    const partial = parseFlags(["--org", FARANDA, "--org", "org_123", "--apply", "--confirm", FARANDA]);
    assert.throws(() => assertConfirmMatches(partial), /missing: org_123/);
    const wrong = parseFlags(["--org", FARANDA, "--apply", "--confirm", "org_123"]);
    assert.throws(() => assertConfirmMatches(wrong), /does not match/);
  });
  it("assertConfirmMatches is a no-op in dry-run", () => {
    assert.doesNotThrow(() => assertConfirmMatches(parseFlags(["--org", FARANDA])));
  });
  it("rejects unknown flags, a missing --org, duplicates, dangling values, --dry-run with --apply and --confirm without --apply", () => {
    assert.throws(() => parseFlags(["--org", FARANDA, "--force"]), /Unknown flag/);
    assert.throws(() => parseFlags([]), /--org/);
    assert.throws(() => parseFlags(["--org"]), /requires a value/);
    assert.throws(() => parseFlags(["--org", FARANDA, "--org", FARANDA]), /twice/);
    assert.throws(() => parseFlags(["--org", FARANDA, "--dry-run", "--apply", "--confirm", FARANDA]), /mutually exclusive/);
    assert.throws(() => parseFlags(["--org", FARANDA, "--confirm", FARANDA]), /only makes sense with --apply/);
  });
});

describe("formatSummary", () => {
  it("prints the plan, the name differences (never changed) and the errors", () => {
    const text = formatSummary({
      templateCode: "pgc_pymes_hotelero_v1",
      templateSize: 3,
      apply: true,
      results: [
        {
          organizationId: "org_123",
          result: {
            applied: true,
            created: 2,
            linked: 3,
            usaliFilled: 1,
            settingWritten: true,
            totalAfter: 5,
            plan: {
              organizationId: "org_123",
              templateCode: "pgc_pymes_hotelero_v1",
              templateSize: 3,
              existing: 3,
              toCreate: ["705.1", "705.2"],
              toLink: [{ code: "4300", parentCode: "430" }],
              toFillUsali: [{ code: "705", usaliDepartment: "rooms", usaliLine: "revenue" }],
              nameDiffers: [{ code: "705", current: "Prestaciones de servicios (alojamiento)", template: "Prestaciones de servicios" }],
              setting: "update",
              missingCanonical: []
            }
          }
        },
        { organizationId: "nope", error: "La organización \"nope\" no existe." }
      ],
      errors: ["nope: La organización \"nope\" no existe."]
    });
    assert.match(text, /modo APPLY/);
    assert.match(text, /org_123: 3 cuentas existentes/);
    assert.match(text, /crear 2 · enlazar padre 1 · rellenar USALI 1 · accounting_settings: update/);
    assert.match(text, /a crear: 705\.1, 705\.2/);
    assert.match(text, /NO se cambian/);
    assert.match(text, /aplicado: creadas 2 · enlazadas 3 · USALI rellenado 1 · setting escrito · total 5/);
    assert.match(text, /nope: ERROR/);
    assert.match(text, /Errores:/);
    assert.equal(AUDIT_ACTION, "ACCOUNTING_CHART_PROVISIONED");
  });
});
