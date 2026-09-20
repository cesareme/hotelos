// Unit tests of the pure parts of the compliance health report (Tanda 6b · R6, t6b#17).
// Pure-core only: no database, no env. Run from apps/api with
//   node --import tsx --test src/modules/compliance/__tests__/compliance-health.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeComplianceEnvironment, selectIssuerProperties } from "../compliance-health.service.js";

// Corrector L8 (REV-03): the public /health block reads the environment only — synchronous,
// no Prisma, no organisation — so it never mixes the properties of every tenant.
describe("describeComplianceEnvironment — configuration-only readers for GET /health", () => {
  const KEYS = ["VERIFACTU_MODE", "SES_HOSPEDAJES_MODE", "TBAI_MODE", "VERIFACTU_CERT_PATH", "VERIFACTU_CERT_PASSPHRASE", "SES_HOSPEDAJES_CERT_PATH", "SES_HOSPEDAJES_CERT_PASSPHRASE", "TBAI_CERT_PATH", "TBAI_CERT_PASSPHRASE"];
  const withEnv = <T,>(overrides: Record<string, string | undefined>, run: () => T): T => {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) if (value !== undefined) process.env[key] = value;
    try {
      return run();
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };

  it("is synchronous (no database) and returns the four integrations in the report order", () => {
    const list = withEnv({}, () => describeComplianceEnvironment());
    assert.ok(Array.isArray(list), "no promise: nothing to await, nothing to query");
    assert.deepEqual(list.map((entry) => entry.integration), ["verifactu", "ses_hospedajes", "tbai", "igic"]);
    for (const entry of list) assert.ok(["sandbox", "preproduction", "production"].includes(entry.mode), entry.integration);
  });

  it("tbai speaks for the process: enabled, applicability per establishment in the note, never «ninguna propiedad» (that needs the organisation)", () => {
    const sandbox = withEnv({}, () => describeComplianceEnvironment()).find((entry) => entry.integration === "tbai")!;
    assert.equal(sandbox.enabled, true);
    assert.equal(sandbox.mode, "sandbox");
    assert.equal(sandbox.readyForReal, false);
    assert.match(sandbox.notes ?? "", /territorio foral .*por propiedad/);
    assert.doesNotMatch(sandbox.notes ?? "", /ninguna propiedad/);
    const production = withEnv({ TBAI_MODE: "production" }, () => describeComplianceEnvironment()).find((entry) => entry.integration === "tbai")!;
    assert.equal(production.mode, "production");
    assert.equal(production.readyForReal, false, "no certificate → not ready even in production");
  });

  it("verifactu / ses follow the env mode and never expose secrets", () => {
    const list = withEnv({ VERIFACTU_MODE: "preproduction", SES_HOSPEDAJES_MODE: "production" }, () => describeComplianceEnvironment());
    const byKey = Object.fromEntries(list.map((entry) => [entry.integration, entry]));
    assert.equal(byKey.verifactu!.mode, "preproduction");
    assert.equal(byKey.ses_hospedajes!.mode, "production");
    assert.equal(byKey.ses_hospedajes!.cert.configured, false);
    assert.doesNotMatch(JSON.stringify(list), /PASSPHRASE|change-me/);
  });
});

describe("selectIssuerProperties — who is an issuer in the health report", () => {
  const RA = { id: "RA", kind: "hotel" };
  const LT = { id: "LT", kind: "hotel" };
  const OC = { id: "OC", kind: "office" };
  const WH = { id: "WH", kind: "other" };
  const legacy = { id: "LEGACY", kind: null };

  it("hotels are always issuers; an office or other centre only once it has an active series", () => {
    assert.deepEqual(selectIssuerProperties([RA, LT, OC, WH], new Set()).map((p) => p.id), ["RA", "LT"]);
    assert.deepEqual(selectIssuerProperties([RA, LT, OC, WH], new Set(["OC"])).map((p) => p.id), ["RA", "LT", "OC"]);
    assert.deepEqual(selectIssuerProperties([OC, WH], new Set(["WH", "OC"])).map((p) => p.id), ["OC", "WH"], "input order is kept");
  });

  it("a row without kind (legacy mirror) is a hotel: the column default", () => {
    assert.deepEqual(selectIssuerProperties([legacy, OC], new Set()).map((p) => p.id), ["LEGACY"]);
  });

  it("billing ids that are not in the list never add rows; an empty organization has no issuers", () => {
    assert.deepEqual(selectIssuerProperties([OC], new Set(["RA"])), []);
    assert.deepEqual(selectIssuerProperties([], new Set(["OC"])), []);
  });
});
