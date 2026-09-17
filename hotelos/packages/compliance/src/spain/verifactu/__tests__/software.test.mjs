// Unit tests for resolveVerifactuSoftware (contract E · SistemaInformatico block).
//
// Run from the repo root:
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test packages/compliance/src/spain/verifactu/__tests__/software.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveVerifactuSoftware, VERIFACTU_SOFTWARE_DEFAULTS } from "../software.ts";

const COMPLETE = {
  VERIFACTU_SOFTWARE_NAME: "Anfitorio Software SL",
  VERIFACTU_SOFTWARE_NIF: "B12345674",
  VERIFACTU_SYSTEM_NAME: "ehotelOS",
  VERIFACTU_SYSTEM_ID: "01",
  VERIFACTU_SYSTEM_VERSION: "1.4.0",
  VERIFACTU_INSTALL_NUMBER: "VPS-HOSTINGER-001",
  VERIFACTU_MULTI_OT: "S"
};

test("complete environment resolves ok with every field and the fixed VERI*FACTU flag", () => {
  const result = resolveVerifactuSoftware(COMPLETE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.software, {
    nombreRazon: "Anfitorio Software SL",
    nif: "B12345674",
    nombreSistema: "ehotelOS",
    idSistema: "01",
    version: "1.4.0",
    numeroInstalacion: "VPS-HOSTINGER-001",
    tipoUsoPosibleSoloVerifactu: "S",
    tipoUsoPosibleMultiOT: "S",
    indicadorMultiplesOT: "S"
  });
});

test("blank strings count as absent: the demo .env (NIF= and INSTALL_NUMBER=) is NOT ok", () => {
  const result = resolveVerifactuSoftware({
    VERIFACTU_SOFTWARE_NAME: "   ",
    VERIFACTU_SOFTWARE_NIF: "",
    VERIFACTU_INSTALL_NUMBER: ""
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e === "Falta la razón social del productor del software."));
  assert.ok(result.errors.some((e) => e === "Falta el NIF del productor del software (no el del hotel emisor)."));
  assert.ok(result.errors.some((e) => e === "Falta el número de instalación asignado por el productor a este despliegue."));
  // Sandbox fillers are never empty (the XML must still be well formed).
  assert.equal(result.software.nif, VERIFACTU_SOFTWARE_DEFAULTS.nif);
  assert.equal(result.software.numeroInstalacion, VERIFACTU_SOFTWARE_DEFAULTS.numeroInstalacion);
  assert.equal(result.software.nombreRazon, VERIFACTU_SOFTWARE_DEFAULTS.nombreRazon);
  assert.notEqual(result.software.nif, "");
});

test("defaults: system name ehotelOS, id 01, version from APP_VERSION, MultiOT S", () => {
  const result = resolveVerifactuSoftware({
    VERIFACTU_SOFTWARE_NAME: "Anfitorio Software SL",
    VERIFACTU_SOFTWARE_NIF: "B12345674",
    VERIFACTU_INSTALL_NUMBER: "X",
    APP_VERSION: "2026.09.1"
  });
  assert.equal(result.ok, true);
  assert.equal(result.software.nombreSistema, "ehotelOS");
  assert.equal(result.software.idSistema, "01");
  assert.equal(result.software.version, "2026.09.1");
  assert.equal(result.software.tipoUsoPosibleMultiOT, "S");
  assert.equal(result.software.indicadorMultiplesOT, "S");
});

test("VERIFACTU_SYSTEM_VERSION wins over APP_VERSION and falls back to 1.0.0", () => {
  const explicit = resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_SYSTEM_VERSION: "3.0.0", APP_VERSION: "dev" });
  assert.equal(explicit.software.version, "3.0.0");
  const none = resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_SYSTEM_VERSION: "", APP_VERSION: "" });
  assert.equal(none.software.version, "1.0.0");
});

test("NIF is normalised and checksum-validated (producer NIF, not the issuer)", () => {
  const normalised = resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_SOFTWARE_NIF: " es-b12345674 " });
  assert.equal(normalised.ok, true);
  assert.equal(normalised.software.nif, "B12345674");

  const invalid = resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_SOFTWARE_NIF: "B99999999" });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((e) => e.startsWith("El NIF del productor del software no es válido")));

  const placeholder = resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_SOFTWARE_NIF: "B00000000" });
  assert.equal(placeholder.ok, false, "the all-zero sandbox placeholder is never a valid producer NIF");
});

test("XSD lengths: NombreRazon ≤120, NombreSistema ≤30, IdSistema == 2, Version ≤50, NumeroInstalacion ≤100", () => {
  const tooLong = resolveVerifactuSoftware({
    ...COMPLETE,
    VERIFACTU_SOFTWARE_NAME: "N".repeat(121),
    VERIFACTU_SYSTEM_NAME: "S".repeat(31),
    VERIFACTU_SYSTEM_ID: "ANFITORIO-VRF-01",
    VERIFACTU_SYSTEM_VERSION: "V".repeat(51),
    VERIFACTU_INSTALL_NUMBER: "I".repeat(101)
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.errors.length, 5, tooLong.errors.join("\n"));
  assert.ok(tooLong.errors.some((e) => e.startsWith("La razón social del productor supera los 120 caracteres que admite la AEAT (121)")));
  assert.ok(tooLong.errors.some((e) => e.startsWith("El nombre del sistema supera los 30 caracteres")));
  assert.ok(tooLong.errors.some((e) => e.startsWith("El identificador del sistema debe tener exactamente 2 caracteres")));
  assert.ok(tooLong.errors.some((e) => e.startsWith("La versión del sistema supera los 50 caracteres")));
  assert.ok(tooLong.errors.some((e) => e.startsWith("El número de instalación supera los 100 caracteres")));

  const exact = resolveVerifactuSoftware({
    ...COMPLETE,
    VERIFACTU_SOFTWARE_NAME: "N".repeat(120),
    VERIFACTU_SYSTEM_NAME: "S".repeat(30),
    VERIFACTU_SYSTEM_ID: "A1",
    VERIFACTU_SYSTEM_VERSION: "V".repeat(50),
    VERIFACTU_INSTALL_NUMBER: "I".repeat(100)
  });
  assert.equal(exact.ok, true, exact.errors.join("\n"));
});

test("VERIFACTU_MULTI_OT accepts s/n case-insensitively and rejects anything else", () => {
  assert.equal(resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_MULTI_OT: "n" }).software.tipoUsoPosibleMultiOT, "N");
  assert.equal(resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_MULTI_OT: "n" }).software.indicadorMultiplesOT, "N");
  const bad = resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_MULTI_OT: "yes" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e === "El indicador de varios obligados tributarios debe ser «S» o «N» (valor actual: «yes»)."));
  assert.equal(bad.software.tipoUsoPosibleMultiOT, "S", "falls back to the SaaS default");
});

test("never throws and never mutates the environment object", () => {
  const env = { VERIFACTU_SOFTWARE_NIF: "nope" };
  const snapshot = JSON.stringify(env);
  assert.doesNotThrow(() => resolveVerifactuSoftware(env));
  assert.equal(JSON.stringify(env), snapshot);
});

test("Cocoa 22 · ola 11 (qa#14): errors read in Spanish without env variables, XML element names or table names", () => {
  const jargon = /[A-Z][A-Z0-9]*_[A-Z0-9_]+|verifactu_installations|IdSistemaInformatico|NombreRazon|SistemaInformatico|\bXSD\b|\bsandbox\b|\bstub\b|\bpreproduction\b|\bproduction\b/;
  const cases = [
    resolveVerifactuSoftware({}),
    resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_SOFTWARE_NIF: "B99999999", VERIFACTU_SYSTEM_ID: "001", VERIFACTU_MULTI_OT: "yes" }),
    resolveVerifactuSoftware({ ...COMPLETE, VERIFACTU_SOFTWARE_NAME: "N".repeat(121) }),
    resolveVerifactuSoftware(COMPLETE, { installation: null, requireInstallation: true }),
    resolveVerifactuSoftware(COMPLETE, { installation: { numeroInstalacion: "  " } })
  ];
  for (const result of cases) {
    assert.ok(result.errors.length > 0);
    for (const error of result.errors) {
      assert.doesNotMatch(error, jargon, error);
      assert.match(error, /^[A-ZÁÉÍÓÚ].*\.$/, error);
    }
  }
});
