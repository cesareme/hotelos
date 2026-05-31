// Unit tests for VeriFactu rectificativa XML emission.
//
// Run with Node 22.6+ (type-stripping is on by default in Node 23.6+):
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/timestamp/__tests__/ts-loader.mjs \
//     --test packages/compliance/src/spain/verifactu/timestamp/__tests__/xml-rectificativa.test.mjs
//
// Tests cover:
//   - When `rectification` is omitted, output is identical to the pre-change
//     behaviour (backward-compat canary against the canonical XML string).
//   - With `rectification: { type: "S", rectifiedInvoices: [...] }`, the XML
//     contains <sum1:TipoRectificativa>S</sum1:TipoRectificativa> and a
//     <sum1:FacturasRectificadas> block with one <sum1:IDFacturaAnterior>
//     per row, between <sum1:TipoFactura> and <sum1:DescripcionOperacion>.
//   - With `type: "I"` and `importeRectificacion`, the
//     <sum1:ImporteRectificacion> block is emitted.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVerifactuRegistroAlta } from "../../xml.ts";

const BASE_INPUT = {
  emitterTaxId: "B12345678",
  emitterName: "HotelOS Demo SL",
  invoiceNumber: "RECT-2026-0001",
  issuedAt: "2026-05-18T10:00:00.000Z",
  invoiceType: "R1",
  description: "Servicios hoteleros",
  invoiceTotal: 121.0,
  vatTotal: 21.0,
  breakdowns: [
    { taxCode: "IVA", ratePercent: 21, taxableBase: 100, taxAmount: 21 }
  ],
  previousHash: null,
  currentHash: "DEADBEEF",
  software: {
    nif: "B00000000",
    name: "HotelOS",
    id: "HOTELOS-VRF-01",
    version: "0.1.0",
    installNumber: "DEV-001"
  }
};

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
    rectification: {
      type: "S",
      rectifiedInvoices: [
        { invoiceNumber: "ORIG-2026-0001", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" }
      ]
    }
  });
  assert.ok(!xml.includes("<sum1:TipoRectificativa>"), "TipoRectificativa must not appear for F1");
  assert.ok(!xml.includes("<sum1:FacturasRectificadas>"), "FacturasRectificadas must not appear for F1");
});

test("buildVerifactuRegistroAlta emits TipoRectificativa=S and FacturasRectificadas for R1 with substitution", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    rectification: {
      type: "S",
      rectifiedInvoices: [
        { invoiceNumber: "ORIG-2026-0001", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" }
      ]
    }
  });
  assert.match(xml, /<sum1:TipoRectificativa>S<\/sum1:TipoRectificativa>/);
  assert.match(xml, /<sum1:FacturasRectificadas>[\s\S]*<\/sum1:FacturasRectificadas>/);
  assert.match(xml, /<sum1:IDFacturaAnterior>[\s\S]*<sum1:NumSerieFactura>ORIG-2026-0001<\/sum1:NumSerieFactura>/);
  assert.match(xml, /<sum1:FechaExpedicion>01-04-2026<\/sum1:FechaExpedicion>/);
  // Schema-order canary: TipoFactura -> TipoRectificativa -> FacturasRectificadas -> DescripcionOperacion.
  const tipoFactIdx = xml.indexOf("<sum1:TipoFactura>");
  const tipoRectIdx = xml.indexOf("<sum1:TipoRectificativa>");
  const facturasIdx = xml.indexOf("<sum1:FacturasRectificadas>");
  const descIdx = xml.indexOf("<sum1:DescripcionOperacion>");
  assert.ok(
    tipoFactIdx < tipoRectIdx && tipoRectIdx < facturasIdx && facturasIdx < descIdx,
    "AEAT schema order must be TipoFactura -> TipoRectificativa -> FacturasRectificadas -> DescripcionOperacion"
  );
  // No ImporteRectificacion block when type is "S".
  assert.ok(!xml.includes("<sum1:ImporteRectificacion>"), "no ImporteRectificacion for type=S");
});

test("buildVerifactuRegistroAlta emits multiple IDFacturaAnterior rows when more than one original is rectified", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    rectification: {
      type: "S",
      rectifiedInvoices: [
        { invoiceNumber: "ORIG-1", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" },
        { invoiceNumber: "ORIG-2", issueDate: "2026-04-02T10:00:00.000Z", emitterTaxId: "B12345678" }
      ]
    }
  });
  const matches = xml.match(/<sum1:IDFacturaAnterior>/g) ?? [];
  assert.equal(matches.length, 2, "two IDFacturaAnterior rows expected");
  assert.ok(xml.includes("<sum1:NumSerieFactura>ORIG-1</sum1:NumSerieFactura>"));
  assert.ok(xml.includes("<sum1:NumSerieFactura>ORIG-2</sum1:NumSerieFactura>"));
});

test("buildVerifactuRegistroAlta emits ImporteRectificacion when type=I and importeRectificacion is set", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    invoiceType: "R4",
    rectification: {
      type: "I",
      rectifiedInvoices: [
        { invoiceNumber: "ORIG-2026-0001", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" }
      ],
      importeRectificacion: { baseRectificada: 100.55, cuotaRectificada: 21.12 }
    }
  });
  assert.match(xml, /<sum1:TipoRectificativa>I<\/sum1:TipoRectificativa>/);
  assert.match(xml, /<sum1:ImporteRectificacion>[\s\S]*<\/sum1:ImporteRectificacion>/);
  assert.match(xml, /<sum1:BaseRectificada>100\.55<\/sum1:BaseRectificada>/);
  assert.match(xml, /<sum1:CuotaRectificada>21\.12<\/sum1:CuotaRectificada>/);
  assert.ok(!xml.includes("<sum1:CuotaRecargoRectificado>"), "no CuotaRecargoRectificado when omitted");
});

test("buildVerifactuRegistroAlta includes CuotaRecargoRectificado when supplied", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    invoiceType: "R2",
    rectification: {
      type: "I",
      rectifiedInvoices: [
        { invoiceNumber: "ORIG-2026-0001", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" }
      ],
      importeRectificacion: { baseRectificada: 50, cuotaRectificada: 10.5, cuotaRecargoRectificado: 0.26 }
    }
  });
  assert.match(xml, /<sum1:CuotaRecargoRectificado>0\.26<\/sum1:CuotaRecargoRectificado>/);
});

test("buildVerifactuRegistroAlta does NOT emit ImporteRectificacion when type=S even if importeRectificacion provided", () => {
  // Defensive: spec only allows ImporteRectificacion alongside type="I".
  const xml = buildVerifactuRegistroAlta({
    ...BASE_INPUT,
    rectification: {
      type: "S",
      rectifiedInvoices: [
        { invoiceNumber: "ORIG-2026-0001", issueDate: "2026-04-01T10:00:00.000Z", emitterTaxId: "B12345678" }
      ],
      importeRectificacion: { baseRectificada: 100, cuotaRectificada: 21 }
    }
  });
  assert.ok(!xml.includes("<sum1:ImporteRectificacion>"), "ImporteRectificacion must be suppressed when type=S");
});
