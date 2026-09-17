// Unit tests for VeriFactu rectificativa XML emission (Tanda 3 semantics).
//
// Run with Node 22.6+ (type-stripping is on by default in Node 23.6+):
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test packages/compliance/src/spain/verifactu/timestamp/__tests__/xml-rectificativa.test.mjs
//
// Tests cover:
//   - When `rectification` is omitted, no rectificativa block is emitted and
//     TipoFactura is directly followed by DescripcionOperacion.
//   - With `type: "I"` (por diferencias — Anfitorio's default: the registro
//     carries the deltas), the XML contains <sum1:TipoRectificativa>I</…> and a
//     <sum1:FacturasRectificadas> block with one <sum1:IDFacturaRectificada>
//     per row, between <sum1:TipoFactura> and <sum1:DescripcionOperacion>,
//     and NO <sum1:ImporteRectificacion>.
//   - With `type: "S"` (sustitución), <sum1:ImporteRectificacion> with the
//     ORIGINAL's BaseRectificada/CuotaRectificada is mandatory (the XSD
//     requires it) and the builder refuses to emit "S" without it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVerifactuRegistroAlta } from "../../xml.ts";

const BASE_INPUT = {
  emitterTaxId: "B12345678",
  emitterName: "Grupo Hotelero Demo SL",
  invoiceNumber: "RECT-2026-0001",
  issuedAt: "2026-05-18T10:00:00.000Z",
  invoiceType: "R1",
  description: "Servicios hoteleros",
  invoiceTotal: 121.0,
  vatTotal: 21.0,
  breakdowns: [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 21, base: 100, quota: 21 }],
  previousHash: null,
  currentHash: "DEADBEEF",
  software: {
    nombreRazon: "Anfitorio Software SL",
    nif: "B12345674",
    nombreSistema: "ehotelOS",
    idSistema: "01",
    version: "0.1.0",
    numeroInstalacion: "DEV-001",
    tipoUsoPosibleSoloVerifactu: "S",
    tipoUsoPosibleMultiOT: "S",
    indicadorMultiplesOT: "S"
  }
};

const ORIGINAL = { invoiceNumber: "ORIG-2026-0001", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" };

test("buildVerifactuRegistroAlta omits rectificativa blocks when rectification is undefined (backward compat)", () => {
  const xml = buildVerifactuRegistroAlta({ ...BASE_INPUT, invoiceType: "F1" });
  assert.ok(!xml.includes("<sum1:TipoRectificativa>"), "no TipoRectificativa for non-rectifying invoice");
  assert.ok(!xml.includes("<sum1:FacturasRectificadas>"), "no FacturasRectificadas without input");
  assert.ok(!xml.includes("<sum1:ImporteRectificacion>"), "no ImporteRectificacion without input");
  // Canonical ordering canary: TipoFactura is immediately followed by
  // DescripcionOperacion when no rectification is present.
  assert.match(
    xml,
    /<sum1:TipoFactura>F1<\/sum1:TipoFactura>\n\s+<sum1:DescripcionOperacion>/,
    "TipoFactura should be directly followed by DescripcionOperacion when no rectification"
  );
});

test("buildVerifactuRegistroAlta does not emit rectificativa blocks if invoiceType is not R1-R5 even when rectification supplied", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    invoiceType: "F1",
    rectification: { type: "I", rectifiedInvoices: [ORIGINAL] }
  });
  assert.ok(!xml.includes("<sum1:TipoRectificativa>"), "TipoRectificativa must not appear for F1");
  assert.ok(!xml.includes("<sum1:FacturasRectificadas>"), "FacturasRectificadas must not appear for F1");
});

test("buildVerifactuRegistroAlta emits TipoRectificativa=I and FacturasRectificadas for R1 por diferencias", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    rectification: { type: "I", rectifiedInvoices: [ORIGINAL] }
  });
  assert.match(xml, /<sum1:TipoRectificativa>I<\/sum1:TipoRectificativa>/);
  assert.match(xml, /<sum1:FacturasRectificadas>[\s\S]*<\/sum1:FacturasRectificadas>/);
  assert.match(xml, /<sum1:IDFacturaRectificada>[\s\S]*<sum1:NumSerieFactura>ORIG-2026-0001<\/sum1:NumSerieFactura>/);
  assert.match(xml, /<sum1:FechaExpedicionFactura>01-04-2026<\/sum1:FechaExpedicionFactura>/);
  // Schema-order canary: TipoFactura -> TipoRectificativa -> FacturasRectificadas -> DescripcionOperacion.
  const tipoFactIdx = xml.indexOf("<sum1:TipoFactura>");
  const tipoRectIdx = xml.indexOf("<sum1:TipoRectificativa>");
  const facturasIdx = xml.indexOf("<sum1:FacturasRectificadas>");
  const descIdx = xml.indexOf("<sum1:DescripcionOperacion>");
  assert.ok(
    tipoFactIdx < tipoRectIdx && tipoRectIdx < facturasIdx && facturasIdx < descIdx,
    "AEAT schema order must be TipoFactura -> TipoRectificativa -> FacturasRectificadas -> DescripcionOperacion"
  );
  // No ImporteRectificacion block when type is "I" (deltas are the registro's own amounts).
  assert.ok(!xml.includes("<sum1:ImporteRectificacion>"), "no ImporteRectificacion for type=I");
});

test("buildVerifactuRegistroAlta emits multiple IDFacturaRectificada rows when more than one original is rectified", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    rectification: {
      type: "I",
      rectifiedInvoices: [
        { invoiceNumber: "ORIG-1", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" },
        { invoiceNumber: "ORIG-2", issueDate: "2026-04-02T10:00:00.000Z", emitterTaxId: "B12345678" }
      ]
    }
  });
  const matches = xml.match(/<sum1:IDFacturaRectificada>/g) ?? [];
  assert.equal(matches.length, 2, "two IDFacturaRectificada rows expected");
  assert.ok(xml.includes("<sum1:NumSerieFactura>ORIG-1</sum1:NumSerieFactura>"));
  assert.ok(xml.includes("<sum1:NumSerieFactura>ORIG-2</sum1:NumSerieFactura>"));
});

test("buildVerifactuRegistroAlta emits ImporteRectificacion when type=S with the original's base/cuota", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    invoiceType: "R4",
    rectification: {
      type: "S",
      rectifiedInvoices: [ORIGINAL],
      importeRectificacion: { baseRectificada: 100.55, cuotaRectificada: 21.12 }
    }
  });
  assert.match(xml, /<sum1:TipoRectificativa>S<\/sum1:TipoRectificativa>/);
  assert.match(xml, /<sum1:ImporteRectificacion>[\s\S]*<\/sum1:ImporteRectificacion>/);
  assert.match(xml, /<sum1:BaseRectificada>100\.55<\/sum1:BaseRectificada>/);
  assert.match(xml, /<sum1:CuotaRectificada>21\.12<\/sum1:CuotaRectificada>/);
  assert.ok(!xml.includes("<sum1:CuotaRecargoRectificado>"), "no CuotaRecargoRectificado when omitted");
  const facturasIdx = xml.indexOf("<sum1:FacturasRectificadas>");
  const importeIdx = xml.indexOf("<sum1:ImporteRectificacion>");
  const descIdx = xml.indexOf("<sum1:DescripcionOperacion>");
  assert.ok(facturasIdx < importeIdx && importeIdx < descIdx, "FacturasRectificadas -> ImporteRectificacion -> DescripcionOperacion");
});

test("buildVerifactuRegistroAlta includes CuotaRecargoRectificado when supplied", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    invoiceType: "R2",
    rectification: {
      type: "S",
      rectifiedInvoices: [ORIGINAL],
      importeRectificacion: { baseRectificada: 50, cuotaRectificada: 10.5, cuotaRecargoRectificado: 0.26 }
    }
  });
  assert.match(xml, /<sum1:CuotaRecargoRectificado>0\.26<\/sum1:CuotaRecargoRectificado>/);
});

test("buildVerifactuRegistroAlta refuses type=S without importeRectificacion (mandatory in the XSD)", () => {
  assert.throws(
    () => buildVerifactuRegistroAlta({ ...BASE_INPUT, rectification: { type: "S", rectifiedInvoices: [ORIGINAL] } }),
    /requires importeRectificacion/
  );
});

test("buildVerifactuRegistroAlta ignores importeRectificacion for type=I", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    rectification: { type: "I", rectifiedInvoices: [ORIGINAL], importeRectificacion: { baseRectificada: 100, cuotaRectificada: 21 } }
  });
  assert.ok(!xml.includes("<sum1:ImporteRectificacion>"), "ImporteRectificacion must be suppressed when type=I");
});
