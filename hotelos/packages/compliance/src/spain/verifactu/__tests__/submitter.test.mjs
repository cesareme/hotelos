// Unit tests for the VeriFactu transport helpers: mode resolution, credential
// split (mTLS P12 vs signing PEM, legacy VERIFACTU_CERT_PATH), SOAP envelope,
// AEAT response parsing/classification and the sandbox stub. No network.
//
// Run from the repo root:
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test packages/compliance/src/spain/verifactu/__tests__/submitter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyVerifactuResponse,
  generateSandboxCsv,
  isTransientVerifactuError,
  isVerifactuSimulatedEndpoint,
  parseVerifactuSoapResponse,
  resolveVerifactuCredentials,
  resolveVerifactuMode,
  sniffCertificateFormat,
  submitVerifactuRegistro,
  VERIFACTU_ENDPOINTS,
  wrapVerifactuSoapEnvelope
} from "../submitter.ts";
import { resolveVerifactuSoftware } from "../submitter.ts";

const REGISTRO = `<?xml version="1.0" encoding="UTF-8"?>
<sum:RegFactuSistemaFacturacion xmlns:sum="x" xmlns:sum1="y">
  <sum:RegistroFactura><sum1:RegistroAlta><sum1:Huella>ABC</sum1:Huella></sum1:RegistroAlta></sum:RegistroFactura>
</sum:RegFactuSistemaFacturacion>`;

test("resolveVerifactuMode: sandbox unless an exact known value is set", () => {
  assert.equal(resolveVerifactuMode({}), "sandbox");
  assert.equal(resolveVerifactuMode({ VERIFACTU_MODE: "" }), "sandbox");
  assert.equal(resolveVerifactuMode({ VERIFACTU_MODE: "prod" }), "sandbox");
  assert.equal(resolveVerifactuMode({ VERIFACTU_MODE: "preproduction" }), "preproduction");
  assert.equal(resolveVerifactuMode({ VERIFACTU_MODE: " production " }), "production");
  assert.equal(VERIFACTU_ENDPOINTS.sandbox, "stub://verifactu-mock");
  assert.equal(isVerifactuSimulatedEndpoint("stub://verifactu-mock"), true);
  assert.equal(isVerifactuSimulatedEndpoint(VERIFACTU_ENDPOINTS.production), false);
  assert.equal(isVerifactuSimulatedEndpoint(null), false);
});

test("software resolver is reachable through submitter.ts (spain/index.ts re-export path)", () => {
  assert.equal(typeof resolveVerifactuSoftware, "function");
});

test("credentials: explicit VERIFACTU_CERT_P12 + VERIFACTU_SIGN_PEM are independent", () => {
  const creds = resolveVerifactuCredentials(
    {
      VERIFACTU_CERT_P12: "/certs/mtls.p12",
      VERIFACTU_CERT_P12_PASSPHRASE: "p12pass",
      VERIFACTU_SIGN_PEM: "/certs/sign.pem",
      VERIFACTU_SIGN_PEM_PASSPHRASE: "pempass"
    },
    () => {
      throw new Error("must not sniff explicit paths");
    }
  );
  assert.deepEqual(creds.mtls, { path: "/certs/mtls.p12", passphrase: "p12pass", format: "p12", source: "VERIFACTU_CERT_P12" });
  assert.deepEqual(creds.signing, { certPath: "/certs/sign.pem", certPassphrase: "pempass", source: "VERIFACTU_SIGN_PEM" });
  assert.deepEqual(creds.warnings, []);
});

test("credentials: legacy VERIFACTU_CERT_PATH is sniffed — PEM serves both roles, P12 only mTLS (with a warning)", () => {
  const pem = resolveVerifactuCredentials(
    { VERIFACTU_CERT_PATH: "/certs/legacy.pem", VERIFACTU_CERT_PASSPHRASE: "secret" },
    () => Buffer.from("-----BEGIN PRIVATE KEY-----\nMIIE...")
  );
  assert.equal(pem.mtls?.format, "pem");
  assert.equal(pem.mtls?.source, "VERIFACTU_CERT_PATH");
  assert.equal(pem.signing?.certPath, "/certs/legacy.pem");
  assert.equal(pem.signing?.certPassphrase, "secret");
  assert.deepEqual(pem.warnings, []);

  const p12 = resolveVerifactuCredentials(
    { VERIFACTU_CERT_PATH: "/certs/legacy.p12", VERIFACTU_CERT_PASSPHRASE: "secret" },
    () => Buffer.from([0x30, 0x82, 0x0a, 0x00])
  );
  assert.equal(p12.mtls?.format, "p12");
  assert.equal(p12.signing, null);
  assert.equal(p12.warnings.length, 1);
  assert.match(p12.warnings[0], /VERIFACTU_SIGN_PEM/);
});

test("credentials: unreadable legacy file is a warning, never a throw; empty strings are absent", () => {
  const creds = resolveVerifactuCredentials({ VERIFACTU_CERT_PATH: "/nope.p12", VERIFACTU_CERT_P12: "", VERIFACTU_SIGN_PEM: " " }, () => {
    throw new Error("ENOENT");
  });
  assert.equal(creds.mtls, null);
  assert.equal(creds.signing, null);
  assert.equal(creds.warnings.length, 1);
  assert.match(creds.warnings[0], /ENOENT/);
  assert.deepEqual(resolveVerifactuCredentials({}), { mtls: null, signing: null, warnings: [] });
});

test("credentials: P12 without passphrase is flagged; sniff reads the real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "verifactu-cert-"));
  const pemPath = join(dir, "cert.pem");
  writeFileSync(pemPath, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  assert.equal(sniffCertificateFormat(pemPath, (p) => readFileSync(p)), "pem");
  const creds = resolveVerifactuCredentials({ VERIFACTU_CERT_P12: "/certs/x.p12" });
  assert.equal(creds.warnings.length, 1);
  assert.match(creds.warnings[0], /VERIFACTU_CERT_P12_PASSPHRASE/);
});

test("wrapVerifactuSoapEnvelope: SOAP 1.1 envelope with the registro as the only Body child, XML declaration dropped", () => {
  const soap = wrapVerifactuSoapEnvelope(REGISTRO);
  assert.ok(soap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope'));
  assert.equal((soap.match(/<\?xml/g) ?? []).length, 1, "exactly one XML declaration");
  assert.match(soap, /xmlns:soapenv="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"/);
  assert.match(soap, /<soapenv:Header\/>\s*<soapenv:Body>\s*<sum:RegFactuSistemaFacturacion/);
  assert.match(soap, /<\/sum:RegFactuSistemaFacturacion>\s*<\/soapenv:Body>\s*<\/soapenv:Envelope>$/);
});

test("parseVerifactuSoapResponse is namespace-agnostic and classifies Correcto / AceptadoConErrores / Incorrecto / Fault", () => {
  const ok = parseVerifactuSoapResponse(`<env:Envelope xmlns:env="e"><env:Body><tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="r">
    <tikR:CSV>ABCDEF1234567890</tikR:CSV><tikR:EstadoEnvio>Correcto</tikR:EstadoEnvio>
    <tikR:RespuestaLinea><tikR:EstadoRegistro>Correcto</tikR:EstadoRegistro></tikR:RespuestaLinea>
    </tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>`);
  assert.equal(ok.csv, "ABCDEF1234567890");
  assert.equal(ok.estadoEnvio, "Correcto");
  assert.equal(ok.estadoRegistro, "Correcto");
  assert.equal(ok.soapFault, null);
  assert.deepEqual(classifyVerifactuResponse(ok), { status: "accepted" });

  const partial = parseVerifactuSoapResponse(`<RespuestaRegFactuSistemaFacturacion><CSV>X</CSV><EstadoEnvio>ParcialmenteCorrecto</EstadoEnvio>
    <RespuestaLinea><EstadoRegistro>AceptadoConErrores</EstadoRegistro><CodigoErrorRegistro>3002</CodigoErrorRegistro>
    <DescripcionErrorRegistro>Huella anterior incorrecta</DescripcionErrorRegistro></RespuestaLinea></RespuestaRegFactuSistemaFacturacion>`);
  assert.deepEqual(classifyVerifactuResponse(partial), {
    status: "accepted_with_errors",
    errorCode: "3002",
    errorMessage: "Huella anterior incorrecta"
  });

  const rejected = parseVerifactuSoapResponse(`<r><EstadoEnvio>Incorrecto</EstadoEnvio><RespuestaLinea><EstadoRegistro>Incorrecto</EstadoRegistro>
    <CodigoErrorRegistro>1100</CodigoErrorRegistro><DescripcionErrorRegistro>NIF no identificado</DescripcionErrorRegistro></RespuestaLinea></r>`);
  assert.deepEqual(classifyVerifactuResponse(rejected), { status: "rejected", errorCode: "1100", errorMessage: "NIF no identificado" });

  const fault = parseVerifactuSoapResponse(`<soapenv:Envelope xmlns:soapenv="e"><soapenv:Body><soapenv:Fault><faultcode>soapenv:Client</faultcode>
    <faultstring>Error de validación del XML</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`);
  assert.deepEqual(fault.soapFault, { code: "soapenv:Client", message: "Error de validación del XML" });
  assert.deepEqual(classifyVerifactuResponse(fault), { status: "rejected", errorCode: "SOAP_FAULT_CLIENT", errorMessage: "Error de validación del XML" });

  const garbage = classifyVerifactuResponse(parseVerifactuSoapResponse("<html>gateway</html>"));
  assert.equal(garbage.status, "rejected");
  assert.equal(garbage.errorCode, "UNPARSEABLE_RESPONSE");
});

test("isTransientVerifactuError: NETWORK_* and the two configuration codes retry; AEAT codes do not", () => {
  assert.equal(isTransientVerifactuError("NETWORK_TIMEOUT"), true);
  assert.equal(isTransientVerifactuError("NETWORK_HTTP_503"), true);
  assert.equal(isTransientVerifactuError("CERT_NOT_CONFIGURED"), true);
  assert.equal(isTransientVerifactuError("SOFTWARE_NOT_CONFIGURED"), true);
  assert.equal(isTransientVerifactuError("1100"), false);
  assert.equal(isTransientVerifactuError("HTTP_400"), false);
  assert.equal(isTransientVerifactuError(null), false);
});

test("sandbox stub: deterministic CSV/hash, mode on the response, missing huella rejected", async () => {
  const req = { invoiceId: "inv", invoiceNumber: "FAC-2026-000001", emitterTaxId: "B12345674", xmlPayload: REGISTRO };
  const a = await submitVerifactuRegistro(req, { env: { VERIFACTU_MODE: "sandbox" } });
  const b = await submitVerifactuRegistro(req, { env: {} });
  assert.equal(a.status, "accepted");
  assert.equal(a.mode, "sandbox");
  assert.equal(a.endpoint, "stub://verifactu-mock");
  assert.equal(a.csvCode, b.csvCode);
  assert.equal(a.acceptedHash, b.acceptedHash);
  assert.match(a.csvCode, /^[A-Z0-9]{16}$/);
  const noHash = await submitVerifactuRegistro({ ...req, xmlPayload: "<x/>" }, { env: {} });
  assert.equal(noHash.status, "rejected");
  assert.equal(noHash.errorCode, "MISSING_HUELLA");
});

test("sandbox stub: the CSV is derived per (NIF | número | registro) — the anulación never shares the alta's CSV", async () => {
  const alta = generateSandboxCsv("B12345674", "FAC-2026-000006", "alta");
  const anulacion = generateSandboxCsv("B12345674", "FAC-2026-000006", "anulacion");
  assert.match(alta, /^[A-Z0-9]{16}$/);
  assert.match(anulacion, /^[A-Z0-9]{16}$/);
  assert.notEqual(alta, anulacion, "AEAT assigns one CSV per registro, not per invoice");
  // Legacy callers (no registroType) keep getting the alta's CSV, so replays of
  // registros sent before Tanda 3 still match what was stored.
  assert.equal(generateSandboxCsv("B12345674", "FAC-2026-000006"), alta);
  // Different NIF or number → different CSV; same inputs → same CSV (deterministic).
  assert.notEqual(generateSandboxCsv("B99999997", "FAC-2026-000006", "alta"), alta);
  assert.notEqual(generateSandboxCsv("B12345674", "FAC-2026-000007", "alta"), alta);
  assert.equal(generateSandboxCsv("B12345674", "FAC-2026-000006", "anulacion"), anulacion);

  const base = { invoiceId: "inv", invoiceNumber: "FAC-2026-000006", emitterTaxId: "B12345674", xmlPayload: REGISTRO };
  const altaAck = await submitVerifactuRegistro({ ...base, registroType: "alta" }, { env: {} });
  const anulacionAck = await submitVerifactuRegistro({ ...base, registroType: "anulacion" }, { env: {} });
  const legacyAck = await submitVerifactuRegistro(base, { env: {} });
  assert.equal(altaAck.status, "accepted");
  assert.equal(anulacionAck.status, "accepted");
  assert.equal(altaAck.csvCode, alta);
  assert.equal(anulacionAck.csvCode, anulacion);
  assert.equal(legacyAck.csvCode, alta);
  assert.notEqual(altaAck.csvCode, anulacionAck.csvCode);
  assert.match(anulacionAck.rawResponse, new RegExp(`<csv>${anulacion}</csv>`));
});

test("real modes without an mTLS certificate answer CERT_NOT_CONFIGURED (transient) instead of throwing", async () => {
  const res = await submitVerifactuRegistro(
    { invoiceId: "inv", invoiceNumber: "N", emitterTaxId: "B12345674", xmlPayload: REGISTRO },
    { env: { VERIFACTU_MODE: "preproduction" } }
  );
  assert.equal(res.status, "rejected");
  assert.equal(res.errorCode, "CERT_NOT_CONFIGURED");
  assert.equal(res.mode, "preproduction");
  assert.equal(res.endpoint, VERIFACTU_ENDPOINTS.preproduction);
  assert.equal(isTransientVerifactuError(res.errorCode), true);
});

test("real modes: injected fetch receives the SOAP envelope of transportXml; 5xx → NETWORK_HTTP_*, 4xx → HTTP_*, throw → NETWORK_ERROR", async () => {
  const env = { VERIFACTU_MODE: "production", VERIFACTU_CERT_P12: "/certs/x.p12", VERIFACTU_CERT_P12_PASSPHRASE: "p" };
  const calls = [];
  const okFetch = async (endpoint, init) => {
    calls.push({ endpoint, init });
    return { ok: true, status: 200, text: async () => "<r><CSV>CSV123</CSV><EstadoEnvio>Correcto</EstadoEnvio><RespuestaLinea><EstadoRegistro>Correcto</EstadoRegistro></RespuestaLinea></r>" };
  };
  const signed = REGISTRO.replace("</sum:RegFactuSistemaFacturacion>", "<ds:Signature/></sum:RegFactuSistemaFacturacion>");
  const accepted = await submitVerifactuRegistro(
    { invoiceId: "inv", invoiceNumber: "N", emitterTaxId: "B12345674", xmlPayload: signed, transportXml: REGISTRO },
    { env, fetchImpl: okFetch }
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.csvCode, "CSV123");
  assert.equal(accepted.mode, "production");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, VERIFACTU_ENDPOINTS.production);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.SOAPAction, "");
  assert.match(calls[0].init.body, /<soapenv:Envelope/);
  assert.ok(!calls[0].init.body.includes("<ds:Signature"), "the wire carries the unsigned registro");
  assert.ok(accepted.acceptedHash, "hash over the stored (signed) payload");

  const unavailable = await submitVerifactuRegistro(
    { invoiceId: "inv", invoiceNumber: "N", emitterTaxId: "B12345674", xmlPayload: REGISTRO },
    { env, fetchImpl: async () => ({ ok: false, status: 503, text: async () => "busy" }) }
  );
  assert.equal(unavailable.status, "network_error");
  assert.equal(unavailable.errorCode, "NETWORK_HTTP_503");

  const bad = await submitVerifactuRegistro(
    { invoiceId: "inv", invoiceNumber: "N", emitterTaxId: "B12345674", xmlPayload: REGISTRO },
    { env, fetchImpl: async () => ({ ok: false, status: 400, text: async () => "bad xml" }) }
  );
  assert.equal(bad.status, "rejected");
  assert.equal(bad.errorCode, "HTTP_400");

  const down = await submitVerifactuRegistro(
    { invoiceId: "inv", invoiceNumber: "N", emitterTaxId: "B12345674", xmlPayload: REGISTRO },
    {
      env,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      }
    }
  );
  assert.equal(down.status, "network_error");
  assert.equal(down.errorCode, "NETWORK_ERROR");
  assert.match(down.errorMessage, /ECONNRESET/);
});
