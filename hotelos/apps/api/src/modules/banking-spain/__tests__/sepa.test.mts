// Unit tests · SEPA Norma 19 (pain.008) and Norma 34 (pain.001) generators
// and the IBAN / creditor-id validators (lote tesoreria-banca). Run with
//   node --import tsx --test src/modules/banking-spain/__tests__/sepa.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSepaRemittance, sepaId, sepaText, validateCreditorId, validateIban, type SepaRemittance } from "../sepa-norma19.generator.js";
import { generateSepaTransferRemittance, type SepaTransferRemittance } from "../sepa-norma34.generator.js";

const NOW = new Date("2026-09-15T10:20:30.000Z");

const norma19: SepaRemittance = {
  schema: "CORE",
  collectionDate: "2026-09-20",
  sequenceType: "RCUR",
  creditor: { name: "Hotel Ejemplo, S.L.", creditorId: "ES11000B12345674", iban: "ES91 2100 0418 4502 0005 1332" },
  debtors: [
    { mandateId: "MND-0001", mandateSignedAt: "2025-01-10", name: "Viajes Norte SL", iban: "ES9121000418450200051332", amount: "0.10", description: "Depósito grupo señal", endToEndId: "E2E-1" },
    { mandateId: "MND-0002", mandateSignedAt: "2025-02-10", name: "Empresa Sur & Cía", iban: "ES9121000418450200051332", amount: 0.2, description: "Cuota mensual", endToEndId: "E2E-2" },
    { mandateId: "MND-0003", mandateSignedAt: "2025-03-10", name: "Ana <Pérez>", iban: "ES9121000418450200051332", amount: "1234.56", description: 'Penalización "no-show"', endToEndId: "E2E 3" }
  ]
};

describe("SEPA Norma 19 (pain.008.001.02)", () => {
  it("computes the control sum in integer cents (0.10 + 0.20 + 1234.56 = 1234.86, never 1234.8599…)", () => {
    const result = generateSepaRemittance(norma19, { now: NOW });
    assert.equal(result.control.totalAmountCents, 123_486);
    assert.equal(result.control.totalAmount, 1234.86);
    assert.equal(result.control.transactions, 3);
    assert.match(result.xml, /<CtrlSum>1234\.86<\/CtrlSum>/);
    assert.equal((result.xml.match(/<CtrlSum>1234\.86<\/CtrlSum>/g) ?? []).length, 2, "group header and payment info carry the same control sum");
    assert.match(result.xml, /<NbOfTxs>3<\/NbOfTxs>/);
  });

  it("emits one DrctDbtTxInf per debtor with a 2-decimal InstdAmt, mandate, IBAN without spaces and escaped/normalised text", () => {
    const { xml } = generateSepaRemittance(norma19, { now: NOW });
    assert.equal((xml.match(/<DrctDbtTxInf>/g) ?? []).length, 3);
    assert.match(xml, /<InstdAmt Ccy="EUR">0\.10<\/InstdAmt>/);
    assert.match(xml, /<InstdAmt Ccy="EUR">0\.20<\/InstdAmt>/);
    assert.match(xml, /<InstdAmt Ccy="EUR">1234\.56<\/InstdAmt>/);
    assert.match(xml, /<MndtId>MND-0001<\/MndtId>\s*<DtOfSgntr>2025-01-10<\/DtOfSgntr>/);
    assert.match(xml, /<IBAN>ES9121000418450200051332<\/IBAN>/);
    assert.doesNotMatch(xml, /<IBAN>ES91 2100/);
    // Characters outside the SEPA set are replaced, XML specials never leak raw.
    assert.match(xml, /<Nm>Ana Perez<\/Nm>/);
    assert.match(xml, /<Nm>Empresa Sur Cia<\/Nm>/);
    assert.match(xml, /<Ustrd>Penalizacion no-show<\/Ustrd>/);
    assert.match(xml, /<EndToEndId>E2E-3<\/EndToEndId>/);
    assert.doesNotMatch(xml, /<Nm>Ana <Pérez><\/Nm>/);
  });

  it("carries schema, sequence, collection date and the creditor scheme id; the message id is deterministic for a given instant", () => {
    const a = generateSepaRemittance(norma19, { now: NOW });
    const b = generateSepaRemittance(norma19, { now: NOW });
    assert.equal(a.messageId, b.messageId);
    assert.match(a.messageId, /^HOTELOS-20260915102030-[0-9A-F]{6}$/);
    assert.ok(a.messageId.length <= 35);
    assert.match(a.xml, /<LclInstrm><Cd>CORE<\/Cd><\/LclInstrm>/);
    assert.match(a.xml, /<SeqTp>RCUR<\/SeqTp>/);
    assert.match(a.xml, /<ReqdColltnDt>2026-09-20<\/ReqdColltnDt>/);
    assert.match(a.xml, /<CdtrSchmeId>[\s\S]*<Id>ES11000B12345674<\/Id>/);
    assert.match(a.xml, /<CreDtTm>2026-09-15T10:20:30<\/CreDtTm>/);
  });
});

describe("SEPA Norma 34 (pain.001.001.03)", () => {
  const norma34: SepaTransferRemittance = {
    executionDate: "2026-09-18",
    debtor: { name: "Hotel Ejemplo SL", taxId: "B12345674", iban: "ES9121000418450200051332", bic: "CAIXESBBXXX" },
    creditors: [
      { name: "Suministros del Noroeste SL", iban: "ES9121000418450200051332", amount: "1815.00", description: "Factura F-2026-118", endToEndId: "SB-1", category: "SUPP" },
      { name: "Lavandería Ría", iban: "ES9121000418450200051332", amount: 0.05, description: "Factura L-9", endToEndId: "SB-2" }
    ]
  };

  it("builds a credit-transfer batch with control sums in cents, TRF method, execution date and category purpose", () => {
    const result = generateSepaTransferRemittance(norma34, { now: NOW });
    assert.equal(result.control.totalAmountCents, 181_505);
    assert.equal(result.control.totalAmount, 1815.05);
    assert.match(result.xml, /urn:iso:std:iso:20022:tech:xsd:pain\.001\.001\.03/);
    assert.match(result.xml, /<PmtMtd>TRF<\/PmtMtd>/);
    assert.match(result.xml, /<ReqdExctnDt>2026-09-18<\/ReqdExctnDt>/);
    assert.match(result.xml, /<BtchBookg>true<\/BtchBookg>/);
    assert.equal((result.xml.match(/<CdtTrfTxInf>/g) ?? []).length, 2);
    assert.match(result.xml, /<CtgyPurp><Cd>SUPP<\/Cd><\/CtgyPurp>/);
    assert.match(result.xml, /<InstdAmt Ccy="EUR">0\.05<\/InstdAmt>/);
    assert.match(result.xml, /<DbtrAgt><FinInstnId><BIC>CAIXESBBXXX<\/BIC>/);
    assert.match(result.xml, /<Nm>Lavanderia Ria<\/Nm>/);
  });

  it("honours batchBooking=false", () => {
    const { xml } = generateSepaTransferRemittance({ ...norma34, batchBooking: false }, { now: NOW });
    assert.match(xml, /<BtchBookg>false<\/BtchBookg>/);
  });
});

describe("IBAN / creditor id / text helpers", () => {
  it("validates IBAN by length (ES = 24) and mod-97", () => {
    assert.equal(validateIban("ES91 2100 0418 4502 0005 1332"), true);
    assert.equal(validateIban("ES9121000418450200051333"), false, "wrong check digits");
    assert.equal(validateIban("ES912100041845020005133"), false, "23 chars");
    assert.equal(validateIban("DE89370400440532013000"), true);
    assert.equal(validateIban(""), false);
  });

  it("validates the Spanish SEPA creditor identifier check digits (suffix excluded)", () => {
    assert.equal(validateCreditorId("ES11000B12345674"), true);
    assert.equal(validateCreditorId("ES11ZZZB12345674"), true, "suffix does not affect the check");
    assert.equal(validateCreditorId("ES23000B12345674"), false);
    assert.equal(validateCreditorId("B12345674"), false);
  });

  it("restricts free text to the SEPA character set and bounds its length", () => {
    assert.equal(sepaText("  Peña & Co.  ñ/ü (2026) ", 70), "Pena Co. n/u (2026)");
    assert.equal(sepaText("x".repeat(200), 140).length, 140);
    assert.equal(sepaId("E2E 3 · ref"), "E2E-3-ref");
  });
});
