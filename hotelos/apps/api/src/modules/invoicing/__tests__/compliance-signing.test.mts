import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  readXadesTimestampSettings,
  signSubmissionXml
} from "../../../lib/compliance-signing.js";

// Integration test for the env-driven XAdES-T opt-in used by all four
// submission services (VeriFactu, TBAI, IGIC, SES Hospedajes). We exercise
// signSubmissionXml directly because it is the single funnel every service
// now goes through; if this branches correctly, the persisted xmlPayload of
// every service will reflect the env flag.

const MINIMAL_INVOICE_XML =
  '<Envelope xmlns="urn:hotelos:test"><InvoiceNumber>F-2025/0001</InvoiceNumber><Total>100.00</Total></Envelope>';

function clearEnv(): void {
  delete process.env.XADES_TIMESTAMP_ENABLED;
  delete process.env.XADES_TIMESTAMP_MODE;
  delete process.env.XADES_TIMESTAMP_TSA_URL;
}

describe("XAdES-T opt-in (compliance-signing helper)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("defaults to disabled when env vars are absent", () => {
    const settings = readXadesTimestampSettings();
    assert.deepEqual(settings, { enabled: false });
  });

  it("parses stub-mode settings when enabled", () => {
    const settings = readXadesTimestampSettings({
      XADES_TIMESTAMP_ENABLED: "true",
      XADES_TIMESTAMP_MODE: "stub",
      XADES_TIMESTAMP_TSA_URL: "http://example.tsa/"
    } as NodeJS.ProcessEnv);
    assert.deepEqual(settings, {
      enabled: true,
      mode: "stub",
      tsaUrl: "http://example.tsa/"
    });
  });

  it("rejects unknown modes and falls back to stub", () => {
    const settings = readXadesTimestampSettings({
      XADES_TIMESTAMP_ENABLED: "1",
      XADES_TIMESTAMP_MODE: "bogus"
    } as NodeJS.ProcessEnv);
    assert.equal(settings.enabled, true);
    if (settings.enabled) assert.equal(settings.mode, "stub");
  });

  it("produces XAdES-EPES output (no SignatureTimeStamp) when timestamping is disabled", async () => {
    const result = await signSubmissionXml({ xml: MINIMAL_INVOICE_XML });
    assert.equal(result.timestamp, undefined);
    assert.ok(
      !result.signedXml.includes("<xades:SignatureTimeStamp"),
      "default output must not contain <xades:SignatureTimeStamp>"
    );
  });

  it("produces XAdES-T output containing <xades:SignatureTimeStamp> when enabled in stub mode", async () => {
    process.env.XADES_TIMESTAMP_ENABLED = "true";
    process.env.XADES_TIMESTAMP_MODE = "stub";

    const result = await signSubmissionXml({ xml: MINIMAL_INVOICE_XML });
    // signSubmissionXml is what each submission service stores into
    // submission.xmlPayload, so this is exactly what the database row contains.
    const xmlPayload = result.signedXml;

    assert.ok(
      xmlPayload.includes("<xades:SignatureTimeStamp"),
      `expected xmlPayload to contain <xades:SignatureTimeStamp>; got: ${xmlPayload}`
    );
    assert.equal(result.timestamp?.mode, "stub");
  });

  it("keeps default-env output byte-identical between calls (backward compatibility canary)", async () => {
    // Two calls with timestamping disabled must produce structurally identical
    // signed XML modulo the per-call signatureId / signedAt. We strip those
    // and compare — the relevant invariant is that no SignatureTimeStamp
    // sneaks in.
    const a = (await signSubmissionXml({ xml: MINIMAL_INVOICE_XML })).signedXml;
    const b = (await signSubmissionXml({ xml: MINIMAL_INVOICE_XML })).signedXml;
    const normalise = (s: string): string =>
      s
        .replace(/sig-[0-9a-f-]+/g, "sig-X")
        .replace(/<!--[\s\S]*?-->/g, "<!--C-->");
    assert.equal(normalise(a), normalise(b));
    assert.ok(!a.includes("<xades:SignatureTimeStamp"));
    assert.ok(!b.includes("<xades:SignatureTimeStamp"));
  });
});
