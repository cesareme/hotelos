// Tanda CHK · W2-B: PDF del parte de entrada (escritor PDF propio, sin librerías).
// From apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/entry-form-pdf.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { ENTRY_FORM_LEGAL_FOOTER, renderEntryFormPdf, type EntryFormRecord } from "../entry-form-pdf.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]);
const SHA = createHash("sha256").update(PNG).digest("hex");

const RECORD: EntryFormRecord = {
  id: "grr_pdf_1",
  firstName: "ANNA",
  surname1: "PRUEBA",
  surname2: undefined,
  sex: "M",
  nationality: "ESP",
  dateOfBirth: "1990-01-15",
  documentType: "DNI",
  documentNumber: "12345678Z",
  documentSupportNumber: "AAA123456",
  residenceFullAddress: "Rúa da Proba 1, 15001",
  residenceLocality: "A Coruña",
  residenceCountry: "ES",
  phoneMobile: "+34600000001",
  phoneLandline: undefined,
  email: "huesped.01@chk.test",
  travellerCount: 2,
  isMinor: false,
  kinshipRelationIfMinor: undefined,
  contractReference: "CHK-01",
  contractDate: "2026-09-19T15:00:00.000Z",
  checkinAt: "2026-09-19T15:00:00.000Z",
  checkoutAt: "2026-09-21T11:00:00.000Z",
  paymentType: "TARJET",
  signedAt: "2026-09-19T15:30:00.000Z"
};

const PROPERTY = { name: "Hotel CHK (prueba)", address: "Rúa da Proba 1", postalCode: "15001", municipality: "A Coruña", province: "A Coruña", country: "ES", sesEstablishmentCode: "CHK0000001" };

describe("renderEntryFormPdf", () => {
  it("devuelve %PDF- de 1 página con los campos y el hash", () => {
    const pdf = renderEntryFormPdf({ record: RECORD, property: PROPERTY, signature: { id: "sgn_0000000000000001", signedAt: "2026-09-19T15:30:00.000Z", method: "touch_portal" }, generatedAt: new Date("2026-09-19T15:30:05.000Z") }, PNG);
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    const text = pdf.toString("latin1");
    assert.equal(text.match(/\/Type \/Page(?!s)/g)?.length, 1, "una sola página");
    assert.equal(text.match(/\/Count 1\b/g)?.length, 1);
    assert.ok(text.trimEnd().endsWith("%%EOF"));
    // Campos del Anexo I A.3 y de la estancia, en el flujo de contenido sin comprimir.
    for (const value of ["(ANNA)", "(PRUEBA)", "(12345678Z)", "(AAA123456)", "(ESP)", "(1990-01-15)", "(DNI)", "(+34600000001)", "(huesped.01@chk.test)", "(CHK-01)", "(2)", "(TARJET)", "2026-09-19 15:00 UTC", "2026-09-21 11:00 UTC"]) {
      assert.ok(text.includes(value), `campo ${value} presente`);
    }
    // Cabecera del establecimiento y código SES.
    assert.ok(text.includes("Hotel CHK \\(prueba\\)"), "paréntesis escapados en el literal PDF");
    assert.ok(text.includes("CHK0000001"));
    // Firma: hash calculado sobre el PNG recibido, id de la firma, fecha y método.
    assert.ok(text.includes(SHA), "SHA-256 del PNG de la firma");
    assert.ok(text.includes("(sgn_0000000000000001)"));
    assert.ok(text.includes("2026-09-19 15:30 UTC"));
    assert.ok(text.includes("firma t"), "método de firma en español (firma táctil…)");
    // Pie legal.
    assert.ok(text.includes("Orden INT/1922/2003"));
    assert.ok(text.includes("RD 933/2021"));
    assert.equal(ENTRY_FORM_LEGAL_FOOTER, "Orden INT/1922/2003 · RD 933/2021");
  });

  it("usa el sha256 dado sin PNG, imprime el bloque de menor y falla sin ningún hash", () => {
    const withHash = renderEntryFormPdf({ record: { ...RECORD, isMinor: true, kinshipRelationIfMinor: "hijo", surname2: "SEGUNDA" }, property: { name: "Hotel CHK (prueba)" }, signature: { id: "sgn_2", sha256: "ab".repeat(32), signedAt: new Date("2026-09-19T15:30:00.000Z"), method: "paper_scanned" } });
    const text = withHash.toString("latin1");
    assert.ok(text.includes("ab".repeat(32)));
    assert.ok(text.includes("(SEGUNDA)"));
    assert.ok(text.includes("(hijo)"));
    assert.ok(text.includes("(Menor de edad)"));
    assert.ok(text.includes("(S\\355)"), "«Sí» en WinAnsi (í = octal 355)");
    assert.ok(text.includes("papel digitalizada"));
    assert.equal(text.match(/\/Type \/Page(?!s)/g)?.length, 1);
    assert.throws(() => renderEntryFormPdf({ record: RECORD, property: PROPERTY, signature: { id: "sgn_3", signedAt: "2026-09-19T15:30:00.000Z", method: "touch_kiosk" } }), /falta el hash de la firma/);
  });

  it("es determinista para la misma entrada y fecha de generación", () => {
    const input = { record: RECORD, property: PROPERTY, signature: { id: "sgn_4", sha256: SHA, signedAt: "2026-09-19T15:30:00.000Z", method: "touch_kiosk" }, generatedAt: new Date("2026-09-19T15:30:05.000Z") };
    const a = renderEntryFormPdf(input);
    const b = renderEntryFormPdf(input);
    // El escritor estampa CreationDate con la hora real: todo lo demás es idéntico.
    const strip = (buffer: Buffer): string => buffer.toString("latin1").replace(/\/CreationDate \(D:\d+Z\)/, "");
    assert.equal(strip(a), strip(b));
  });
});
