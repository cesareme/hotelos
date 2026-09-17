// Unit tests for the VeriFactu registro builders: Desglose from contract B
// groups (S1/N1, IVA/IGIC/IPSI), Destinatarios, RegistroAnterior with the
// previous NIF snapshot, SistemaInformatico from the resolved software block,
// rectificativa I/S semantics and RegistroAnulacion.
//
// Run from the repo root:
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test packages/compliance/src/spain/verifactu/__tests__/xml.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertVerifactuRecipient, buildVerifactuRegistroAlta, buildVerifactuRegistroAnulacion, sumDesgloseQuotas } from "../xml.ts";

const SOFTWARE = {
  nombreRazon: "Anfitorio Software SL",
  nif: "B12345674",
  nombreSistema: "ehotelOS",
  idSistema: "01",
  version: "1.4.0",
  numeroInstalacion: "VPS-001",
  tipoUsoPosibleSoloVerifactu: "S",
  tipoUsoPosibleMultiOT: "S",
  indicadorMultiplesOT: "S"
};

const BASE = {
  emitterTaxId: "B99999997",
  emitterName: "Hotel Faranda SL",
  invoiceNumber: "FAC-2026-000013",
  issuedAt: "2026-09-14T12:52:35.597Z",
  invoiceType: "F1",
  description: "Servicios hoteleros FAC-2026-000013",
  invoiceTotal: 121,
  vatTotal: 11,
  breakdowns: [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 110, quota: 11 }],
  previousHash: null,
  currentHash: "CAFEBABE",
  software: SOFTWARE
};

function between(xml, first, second) {
  const a = xml.indexOf(first);
  const b = xml.indexOf(second);
  assert.ok(a >= 0, `${first} missing`);
  assert.ok(b >= 0, `${second} missing`);
  assert.ok(a < b, `${first} must precede ${second}`);
}

test("S1 IVA group: Impuesto 01, ClaveRegimen 01, TipoImpositivo, base and quota; CuotaTotal/ImporteTotal as hashed", () => {
  const xml = buildVerifactuRegistroAlta(BASE);
  assert.match(xml, /<sum1:Impuesto>01<\/sum1:Impuesto>\s*<sum1:ClaveRegimen>01<\/sum1:ClaveRegimen>\s*<sum1:CalificacionOperacion>S1<\/sum1:CalificacionOperacion>\s*<sum1:TipoImpositivo>10\.00<\/sum1:TipoImpositivo>\s*<sum1:BaseImponibleOimporteNoSujeto>110\.00<\/sum1:BaseImponibleOimporteNoSujeto>\s*<sum1:CuotaRepercutida>11\.00<\/sum1:CuotaRepercutida>/);
  assert.match(xml, /<sum1:CuotaTotal>11\.00<\/sum1:CuotaTotal>\s*<sum1:ImporteTotal>121\.00<\/sum1:ImporteTotal>/);
  assert.match(xml, /<sum1:FechaExpedicionFactura>14-09-2026<\/sum1:FechaExpedicionFactura>/);
  assert.match(xml, /<sum1:FechaHoraHusoGenRegistro>2026-09-14T14:52:35\+02:00<\/sum1:FechaHoraHusoGenRegistro>/);
  assert.match(xml, /<sum1:PrimerRegistro>S<\/sum1:PrimerRegistro>/);
  assert.match(xml, /<sum1:TipoHuella>01<\/sum1:TipoHuella>\s*<sum1:Huella>CAFEBABE<\/sum1:Huella>/);
});

test("N1 group (no-show indemnity): only CalificacionOperacion + BaseImponibleOimporteNoSujeto, no rate, no quota", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE,
    invoiceTotal: 171,
    breakdowns: [
      { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 110, quota: 11 },
      { figure: "IVA", impuesto: "01", calificacion: "N1", ratePercent: 0, base: 50, quota: 0 }
    ]
  });
  const n1 = xml.slice(xml.indexOf("<sum1:CalificacionOperacion>N1"), xml.indexOf("</sum1:Desglose>"));
  assert.match(n1, /<sum1:CalificacionOperacion>N1<\/sum1:CalificacionOperacion>\s*<sum1:BaseImponibleOimporteNoSujeto>50\.00<\/sum1:BaseImponibleOimporteNoSujeto>\s*<\/sum1:DetalleDesglose>/);
  assert.ok(!n1.includes("<sum1:TipoImpositivo>"), "N1 has no TipoImpositivo");
  assert.ok(!n1.includes("<sum1:CuotaRepercutida>"), "N1 has no CuotaRepercutida");
  assert.equal((xml.match(/<sum1:DetalleDesglose>/g) ?? []).length, 2);
});

test("IGIC (Canarias) goes to VeriFactu with Impuesto 03 and ClaveRegimen 01", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE,
    invoiceTotal: 107,
    vatTotal: 7,
    breakdowns: [{ figure: "IGIC", impuesto: "03", calificacion: "S1", ratePercent: 7, base: 100, quota: 7 }]
  });
  assert.match(xml, /<sum1:Impuesto>03<\/sum1:Impuesto>\s*<sum1:ClaveRegimen>01<\/sum1:ClaveRegimen>/);
  assert.match(xml, /<sum1:TipoImpositivo>7\.00<\/sum1:TipoImpositivo>/);
  assert.ok(!xml.includes("<sum1:Impuesto>01</sum1:Impuesto>"));
});

test("IPSI (Ceuta/Melilla): Impuesto 02 without ClaveRegimen", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE,
    invoiceTotal: 102,
    vatTotal: 2,
    breakdowns: [{ figure: "IPSI", impuesto: "02", calificacion: "S1", ratePercent: 2, base: 100, quota: 2 }]
  });
  assert.match(xml, /<sum1:Impuesto>02<\/sum1:Impuesto>\s*<sum1:CalificacionOperacion>S1<\/sum1:CalificacionOperacion>/);
  assert.ok(!xml.includes("<sum1:ClaveRegimen>"), "IPSI has no regime key in the XSD");
});

test("Destinatarios/IDDestinatario for an identified F1 recipient; never for F2", () => {
  const recipient = { name: "Acme & Co <SL>", taxId: "A58818501" };
  const f1 = buildVerifactuRegistroAlta({ ...BASE, recipient });
  assert.match(f1, /<sum1:Destinatarios>\s*<sum1:IDDestinatario>\s*<sum1:NombreRazon>Acme &amp; Co &lt;SL&gt;<\/sum1:NombreRazon>\s*<sum1:NIF>A58818501<\/sum1:NIF>\s*<\/sum1:IDDestinatario>\s*<\/sum1:Destinatarios>/);
  between(f1, "<sum1:DescripcionOperacion>", "<sum1:Destinatarios>");
  between(f1, "<sum1:Destinatarios>", "<sum1:Desglose>");

  const f2 = buildVerifactuRegistroAlta({ ...BASE, invoiceType: "F2", recipient });
  assert.ok(!f2.includes("<sum1:Destinatarios>"));
  const none = buildVerifactuRegistroAlta({ ...BASE, recipient: null });
  assert.ok(!none.includes("<sum1:Destinatarios>"));
});

test("Destinatarios/NombreRazon is the recipient's own name: the NIF or an empty value is refused, never shipped", () => {
  // The builder validates the block instead of fabricating recipient data.
  assert.throws(() => assertVerifactuRecipient({ name: "", taxId: "A58818501" }), /nombre o razón social/);
  assert.throws(() => assertVerifactuRecipient({ name: "   ", taxId: "A58818501" }), /nombre o razón social/);
  assert.throws(() => assertVerifactuRecipient({ name: "A58818501", taxId: "A58818501" }), /no puede .* ser el NIF/);
  // Same NIF written with separators / lower case is still the NIF, not a name.
  assert.throws(() => assertVerifactuRecipient({ name: "a-588.18501", taxId: "A58818501" }), /NIF/);
  assert.doesNotThrow(() => assertVerifactuRecipient({ name: "Acme SL", taxId: "A58818501" }));

  assert.throws(() => buildVerifactuRegistroAlta({ ...BASE, recipient: { name: "A58818501", taxId: "A58818501" } }), /NIF/);
  assert.throws(() => buildVerifactuRegistroAlta({ ...BASE, recipient: { name: "", taxId: "12345678Z" } }), /nombre o razón social/);
  // An R* rectificativa of an F1 carries the same rule (it copies the F1's recipient).
  assert.throws(() => buildVerifactuRegistroAlta({ ...BASE, invoiceType: "R1", recipient: { name: "12345678Z", taxId: "12345678Z" } }), /NIF/);
  const ok = buildVerifactuRegistroAlta({ ...BASE, recipient: { name: "María Pérez García", taxId: "12345678Z" } });
  assert.match(ok, /<sum1:NombreRazon>María Pérez García<\/sum1:NombreRazon>\s*<sum1:NIF>12345678Z<\/sum1:NIF>/);
});

test("RegistroAnterior carries the previous record's NIF snapshot, not the current issuer", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE,
    previousHash: "PREV",
    previousInvoiceNumber: "FAC-2026-000012",
    previousIssuedAt: "2026-09-14T12:52:21.402Z",
    previousEmitterTaxId: "B00000000"
  });
  assert.match(xml, /<sum1:RegistroAnterior>\s*<sum1:IDEmisorFactura>B00000000<\/sum1:IDEmisorFactura>\s*<sum1:NumSerieFactura>FAC-2026-000012<\/sum1:NumSerieFactura>\s*<sum1:FechaExpedicionFactura>14-09-2026<\/sum1:FechaExpedicionFactura>\s*<sum1:Huella>PREV<\/sum1:Huella>/);
  assert.ok(!xml.includes("<sum1:PrimerRegistro>"));
  // Legacy callers without the snapshot fall back to the current issuer.
  const legacy = buildVerifactuRegistroAlta({ ...BASE, previousHash: "PREV", previousInvoiceNumber: "X" });
  assert.match(legacy, /<sum1:RegistroAnterior>\s*<sum1:IDEmisorFactura>B99999997<\/sum1:IDEmisorFactura>/);
});

test("SistemaInformatico renders every field of the resolved block (multi-OT SaaS = S)", () => {
  const xml = buildVerifactuRegistroAlta(BASE);
  assert.match(xml, /<sum1:SistemaInformatico>\s*<sum1:NombreRazon>Anfitorio Software SL<\/sum1:NombreRazon>\s*<sum1:NIF>B12345674<\/sum1:NIF>\s*<sum1:NombreSistemaInformatico>ehotelOS<\/sum1:NombreSistemaInformatico>\s*<sum1:IdSistemaInformatico>01<\/sum1:IdSistemaInformatico>\s*<sum1:Version>1\.4\.0<\/sum1:Version>\s*<sum1:NumeroInstalacion>VPS-001<\/sum1:NumeroInstalacion>\s*<sum1:TipoUsoPosibleSoloVerifactu>S<\/sum1:TipoUsoPosibleSoloVerifactu>\s*<sum1:TipoUsoPosibleMultiOT>S<\/sum1:TipoUsoPosibleMultiOT>\s*<sum1:IndicadorMultiplesOT>S<\/sum1:IndicadorMultiplesOT>\s*<\/sum1:SistemaInformatico>/);
  assert.ok(!xml.includes("<sum1:NIF></sum1:NIF>"), "no empty NIF ever");
});

test("rectificativa 'I' (por diferencias): TipoRectificativa + FacturasRectificadas/IDFacturaRectificada, no ImporteRectificacion", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE,
    invoiceType: "R1",
    invoiceNumber: "REC-2026-000001",
    invoiceTotal: -121,
    vatTotal: -11,
    breakdowns: [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: -110, quota: -11 }],
    rectification: {
      type: "I",
      rectifiedInvoices: [{ invoiceNumber: "FAC-2026-000002", issueDate: "2026-09-13T10:28:01.173Z", emitterTaxId: "B00000000" }]
    }
  });
  assert.match(xml, /<sum1:TipoRectificativa>I<\/sum1:TipoRectificativa>/);
  assert.match(xml, /<sum1:FacturasRectificadas>\s*<sum1:IDFacturaRectificada>\s*<sum1:IDEmisorFactura>B00000000<\/sum1:IDEmisorFactura>\s*<sum1:NumSerieFactura>FAC-2026-000002<\/sum1:NumSerieFactura>\s*<sum1:FechaExpedicionFactura>13-09-2026<\/sum1:FechaExpedicionFactura>\s*<\/sum1:IDFacturaRectificada>\s*<\/sum1:FacturasRectificadas>/);
  assert.ok(!xml.includes("<sum1:ImporteRectificacion>"));
  assert.match(xml, /<sum1:CuotaTotal>-11\.00<\/sum1:CuotaTotal>\s*<sum1:ImporteTotal>-121\.00<\/sum1:ImporteTotal>/);
  between(xml, "<sum1:TipoFactura>", "<sum1:TipoRectificativa>");
  between(xml, "<sum1:TipoRectificativa>", "<sum1:FacturasRectificadas>");
  between(xml, "<sum1:FacturasRectificadas>", "<sum1:DescripcionOperacion>");
});

test("rectificativa 'S' (sustitución): ImporteRectificacion with the original's base/cuota is mandatory", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE,
    invoiceType: "R4",
    rectification: {
      type: "S",
      rectifiedInvoices: [{ invoiceNumber: "FAC-2026-000002", issueDate: "2026-09-13T10:28:01.173Z", emitterTaxId: "B99999997" }],
      importeRectificacion: { baseRectificada: 100.55, cuotaRectificada: 10.06 }
    }
  });
  assert.match(xml, /<sum1:TipoRectificativa>S<\/sum1:TipoRectificativa>/);
  assert.match(xml, /<sum1:ImporteRectificacion>\s*<sum1:BaseRectificada>100\.55<\/sum1:BaseRectificada>\s*<sum1:CuotaRectificada>10\.06<\/sum1:CuotaRectificada>\s*<\/sum1:ImporteRectificacion>/);
  between(xml, "<sum1:FacturasRectificadas>", "<sum1:ImporteRectificacion>");
  between(xml, "<sum1:ImporteRectificacion>", "<sum1:DescripcionOperacion>");

  assert.throws(
    () =>
      buildVerifactuRegistroAlta({
        ...BASE,
        invoiceType: "R4",
        rectification: { type: "S", rectifiedInvoices: [{ invoiceNumber: "X", issueDate: "2026-09-13T10:28:01.173Z", emitterTaxId: "B99999997" }] }
      }),
    /requires importeRectificacion/
  );
});

test("rectification input is ignored for non-rectifying types", () => {
  const xml = buildVerifactuRegistroAlta({
    ...BASE,
    rectification: { type: "I", rectifiedInvoices: [{ invoiceNumber: "X", issueDate: "2026-09-13T10:28:01.173Z", emitterTaxId: "B99999997" }] }
  });
  assert.ok(!xml.includes("<sum1:TipoRectificativa>"));
  assert.ok(!xml.includes("<sum1:FacturasRectificadas>"));
});

test("sumDesgloseQuotas adds S1 quotas in cents and ignores N1", () => {
  assert.equal(
    sumDesgloseQuotas([
      { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 110, quota: 11 },
      { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 21, base: 10, quota: 2.1 },
      { figure: "IVA", impuesto: "01", calificacion: "N1", ratePercent: 0, base: 50, quota: 0 }
    ]),
    13.1
  );
  assert.equal(sumDesgloseQuotas([]), 0);
});

test("RegistroAnulacion: IDFactura *Anulada, chained RegistroAnterior, SistemaInformatico, generation time and huella", () => {
  const xml = buildVerifactuRegistroAnulacion({
    emitterTaxId: "B99999997",
    emitterName: "Hotel Faranda SL",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "2026-09-14T12:08:14.013Z",
    previous: { emitterTaxId: "B99999997", invoiceNumber: "FAC-2026-000013", issuedAt: "2026-09-14T12:52:35.597Z", hash: "LASTALTA" },
    currentHash: "ANULHASH",
    generatedAt: "2026-09-14T12:59:40.285Z",
    software: SOFTWARE
  });
  assert.match(xml, /<sum:RegistroFactura>\s*<sum1:RegistroAnulacion>\s*<sum1:IDVersion>1\.0<\/sum1:IDVersion>\s*<sum1:IDFactura>\s*<sum1:IDEmisorFacturaAnulada>B99999997<\/sum1:IDEmisorFacturaAnulada>\s*<sum1:NumSerieFacturaAnulada>FAC-2026-000006<\/sum1:NumSerieFacturaAnulada>\s*<sum1:FechaExpedicionFacturaAnulada>14-09-2026<\/sum1:FechaExpedicionFacturaAnulada>\s*<\/sum1:IDFactura>/);
  assert.match(xml, /<sum1:RegistroAnterior>\s*<sum1:IDEmisorFactura>B99999997<\/sum1:IDEmisorFactura>\s*<sum1:NumSerieFactura>FAC-2026-000013<\/sum1:NumSerieFactura>\s*<sum1:FechaExpedicionFactura>14-09-2026<\/sum1:FechaExpedicionFactura>\s*<sum1:Huella>LASTALTA<\/sum1:Huella>/);
  assert.match(xml, /<sum1:FechaHoraHusoGenRegistro>2026-09-14T14:59:40\+02:00<\/sum1:FechaHoraHusoGenRegistro>\s*<sum1:TipoHuella>01<\/sum1:TipoHuella>\s*<sum1:Huella>ANULHASH<\/sum1:Huella>\s*<\/sum1:RegistroAnulacion>/);
  assert.match(xml, /<sum1:ObligadoEmision>\s*<sum1:NombreRazon>Hotel Faranda SL<\/sum1:NombreRazon>\s*<sum1:NIF>B99999997<\/sum1:NIF>/);
  assert.ok(xml.includes("<sum1:SistemaInformatico>"));
  assert.ok(!xml.includes("<sum1:Desglose>"), "an anulación has no breakdown");
  assert.ok(!xml.includes("<sum1:RegistroAlta>"));
  between(xml, "</sum1:Encadenamiento>", "<sum1:SistemaInformatico>");
  between(xml, "</sum1:SistemaInformatico>", "<sum1:FechaHoraHusoGenRegistro>");

  const first = buildVerifactuRegistroAnulacion({
    emitterTaxId: "B99999997",
    emitterName: "Hotel Faranda SL",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "14-09-2026",
    previous: null,
    currentHash: "ANULHASH",
    generatedAt: "2026-09-14T14:59:40+02:00",
    software: SOFTWARE
  });
  assert.match(first, /<sum1:PrimerRegistro>S<\/sum1:PrimerRegistro>/);
});
