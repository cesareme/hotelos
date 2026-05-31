// Unit tests for XAdES-T integration.
//
// Run with Node 22.6+ (type-stripping is on by default in Node 23.6+):
//   node --experimental-strip-types --test \
//     packages/compliance/src/spain/verifactu/timestamp/__tests__/xades-t.test.mjs
//
// Tests cover:
//   - TimeStampReq DER shape
//   - extractTimeStampToken happy / error paths
//   - signXmlXadesEpes remains backward compatible (no timestamp -> no <xades:SignatureTimeStamp>)
//   - signXmlXadesT with mode="stub" embeds both <xades:SignatureTimeStamp> and <xades:EncapsulatedTimeStamp>
//   - signXmlXadesT with mode="real" uses injected fetch and consumes the resulting token

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Directly import the TS source — works under `node --experimental-strip-types`.
// If type-stripping is not enabled, the test runner will surface a clear error
// pointing at the source path so contributors can rerun with the flag.
import { signXmlXadesEpes, signXmlXadesT } from "../../xades-signer.ts";
import { buildTimeStampReq, extractTimeStampToken } from "../tsa-client.ts";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?><Doc xmlns="urn:example"><Body>hello</Body></Doc>`;

test("buildTimeStampReq produces a DER SEQUENCE starting with 0x30", () => {
  const digest = Buffer.alloc(32, 0xab);
  const req = buildTimeStampReq(digest, Buffer.from([0x01, 0x02]));
  assert.equal(req[0], 0x30, "outer tag should be SEQUENCE");
  assert.ok(req.length > 32, "request should include digest and headers");
});

test("extractTimeStampToken throws on rejected PKIStatus", () => {
  // SEQUENCE { SEQUENCE { INTEGER 2 } } — minimal rejected response.
  const rejected = Buffer.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02]);
  assert.throws(() => extractTimeStampToken(rejected), /PKIStatus=2/);
});

test("extractTimeStampToken returns the ContentInfo bytes for granted responses", () => {
  const pkiStatus = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]);
  const payload = Buffer.from("fake-token-bytes", "utf-8");
  const octet = Buffer.concat([Buffer.from([0x04, payload.length]), payload]);
  const token = Buffer.concat([Buffer.from([0x30, octet.length]), octet]);
  const inner = Buffer.concat([pkiStatus, token]);
  const resp = Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
  const extracted = extractTimeStampToken(resp);
  assert.deepEqual(extracted, token, "extracted token should equal the embedded SEQUENCE");
});

test("signXmlXadesEpes without timestamp is backward compatible", () => {
  const result = signXmlXadesEpes({ xml: SAMPLE_XML });
  assert.equal(result.signatureMode, "stub");
  assert.equal(result.timestamp, undefined);
  assert.ok(!result.signedXml.includes("<xades:SignatureTimeStamp"));
  assert.ok(!result.signedXml.includes("<xades:EncapsulatedTimeStamp"));
});

test("signXmlXadesEpes refuses timestamp option (must use async signXmlXadesT)", () => {
  assert.throws(
    () => signXmlXadesEpes({ xml: SAMPLE_XML, timestamp: { mode: "stub" } }),
    /signXmlXadesT/
  );
});

test("signXmlXadesT with no timestamp returns identical-shape result", async () => {
  const result = await signXmlXadesT({ xml: SAMPLE_XML });
  assert.equal(result.timestamp, undefined);
  assert.ok(!result.signedXml.includes("<xades:SignatureTimeStamp"));
});

test("signXmlXadesT stub mode (no cert) still produces <xades:SignatureTimeStamp> and <xades:EncapsulatedTimeStamp>", async () => {
  const result = await signXmlXadesT({
    xml: SAMPLE_XML,
    timestamp: { mode: "stub" }
  });
  assert.equal(result.signatureMode, "stub");
  assert.equal(result.timestamp?.mode, "stub");
  assert.match(
    result.signedXml,
    /<xades:SignatureTimeStamp\b/,
    "signed XML should contain <xades:SignatureTimeStamp>"
  );
  assert.match(
    result.signedXml,
    /<xades:EncapsulatedTimeStamp>[^<]+<\/xades:EncapsulatedTimeStamp>/,
    "signed XML should contain a non-empty <xades:EncapsulatedTimeStamp>"
  );
  assert.match(
    result.signedXml,
    /<xades:UnsignedSignatureProperties>/,
    "signed XML should contain <xades:UnsignedSignatureProperties>"
  );
});

test("signXmlXadesT with a real cert embeds <xades:SignatureTimeStamp> and <xades:EncapsulatedTimeStamp>", async (t) => {
  // Build a key+self-signed-ish PEM. node-forge may not be hoisted into this
  // package's node_modules; if not, we skip the cert-bearing assertion since
  // the previous test already covers the stub-signature path.
  let certPath;
  try {
    const forgeMod = await import("node-forge");
    const forge = forgeMod.default ?? forgeMod;
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    const attrs = [{ name: "commonName", value: "HotelOS Test" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const dir = mkdtempSync(join(tmpdir(), "xades-t-"));
    certPath = join(dir, "cert.pem");
    writeFileSync(certPath, `${keyPem}\n${certPem}`);
  } catch (err) {
    t.skip(`node-forge unavailable in this workspace: ${err.message}`);
    return;
  }

  const result = await signXmlXadesT({
    xml: SAMPLE_XML,
    certPath,
    certPassphrase: "",
    timestamp: { mode: "stub" }
  });
  assert.equal(result.signatureMode, "real");
  assert.equal(result.timestamp?.mode, "stub");
  assert.match(
    result.signedXml,
    /<xades:SignatureTimeStamp\b/,
    "signed XML should contain <xades:SignatureTimeStamp>"
  );
  assert.match(
    result.signedXml,
    /<xades:EncapsulatedTimeStamp>/,
    "signed XML should contain <xades:EncapsulatedTimeStamp>"
  );
});

test("signXmlXadesT real mode uses injected fetch and embeds returned token", async () => {
  const pkiStatus = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]);
  const tokenBody = Buffer.from("real-token-payload", "utf-8");
  const tokenOctet = Buffer.concat([Buffer.from([0x04, tokenBody.length]), tokenBody]);
  const fakeToken = Buffer.concat([Buffer.from([0x30, tokenOctet.length]), tokenOctet]);
  const respInner = Buffer.concat([pkiStatus, fakeToken]);
  const resp = Buffer.concat([Buffer.from([0x30, respInner.length]), respInner]);

  let capturedUrl = "";
  let capturedHeaders;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init?.headers;
    return new Response(resp, { status: 200 });
  };

  const result = await signXmlXadesT({
    xml: SAMPLE_XML,
    timestamp: { mode: "real", tsaUrl: "http://tsa.example/tsr", fetchImpl: fakeFetch }
  });
  assert.equal(capturedUrl, "http://tsa.example/tsr");
  assert.equal(capturedHeaders["Content-Type"], "application/timestamp-query");
  assert.equal(result.timestamp?.mode, "real");
  assert.equal(result.timestamp?.source, "http://tsa.example/tsr");
  // Token bytes should be embedded base64.
  assert.ok(result.signedXml.includes(fakeToken.toString("base64")));
});
