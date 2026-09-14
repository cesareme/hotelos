// Unit tests for the VeriFactu huella helpers: Europe/Madrid offset (real
// last-Sunday DST rule), alta canonical (unchanged), anulación canonical and
// hash (contract E).
//
// Run from the repo root:
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test packages/compliance/src/spain/verifactu/__tests__/hash.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildVerifactuAnulacionCanonical,
  buildVerifactuCanonical,
  computeVerifactuAnulacionHash,
  computeVerifactuHash,
  formatVerifactuAmount,
  formatVerifactuDate,
  formatVerifactuTimestamp,
  lastSundayOfMonthUtc,
  madridOffsetMinutes
} from "../hash.ts";

test("lastSundayOfMonthUtc: DST boundaries for years where the old fixed-day heuristic was wrong", () => {
  // 2026: last Sunday of March is the 29th, of October the 25th (the heuristic's baseline).
  assert.equal(lastSundayOfMonthUtc(2026, 2).toISOString(), "2026-03-29T01:00:00.000Z");
  assert.equal(lastSundayOfMonthUtc(2026, 9).toISOString(), "2026-10-25T01:00:00.000Z");
  // 2027: March 28 / October 31 — the heuristic would have said "no DST" on 28-Mar
  // and "DST" between 26 and 31-Oct.
  assert.equal(lastSundayOfMonthUtc(2027, 2).toISOString(), "2027-03-28T01:00:00.000Z");
  assert.equal(lastSundayOfMonthUtc(2027, 9).toISOString(), "2027-10-31T01:00:00.000Z");
  // 2028: March 26 / October 29.
  assert.equal(lastSundayOfMonthUtc(2028, 2).toISOString(), "2028-03-26T01:00:00.000Z");
  assert.equal(lastSundayOfMonthUtc(2028, 9).toISOString(), "2028-10-29T01:00:00.000Z");
});

test("madridOffsetMinutes: +60 in winter, +120 in summer, exact switch at 01:00 UTC", () => {
  assert.equal(madridOffsetMinutes(new Date("2027-03-28T00:59:59Z")), 60);
  assert.equal(madridOffsetMinutes(new Date("2027-03-28T01:00:00Z")), 120);
  assert.equal(madridOffsetMinutes(new Date("2027-10-31T00:59:59Z")), 120);
  assert.equal(madridOffsetMinutes(new Date("2027-10-31T01:00:00Z")), 60);
  // The dates the old heuristic got wrong.
  assert.equal(madridOffsetMinutes(new Date("2027-03-28T12:00:00Z")), 120, "28-Mar-2027 is already CEST");
  assert.equal(madridOffsetMinutes(new Date("2027-10-28T12:00:00Z")), 120, "28-Oct-2027 is still CEST");
  assert.equal(madridOffsetMinutes(new Date("2026-01-15T12:00:00Z")), 60);
  assert.equal(madridOffsetMinutes(new Date("2026-07-15T12:00:00Z")), 120);
});

test("formatVerifactuTimestamp renders Europe/Madrid local time with its offset and passes formatted values through", () => {
  assert.equal(formatVerifactuTimestamp("2026-09-14T12:52:35.597Z"), "2026-09-14T14:52:35+02:00");
  assert.equal(formatVerifactuTimestamp("2026-01-15T23:30:00.000Z"), "2026-01-16T00:30:00+01:00");
  assert.equal(formatVerifactuTimestamp("2027-03-28T12:00:00.000Z"), "2027-03-28T14:00:00+02:00");
  assert.equal(formatVerifactuTimestamp("2026-09-14T14:52:35+02:00"), "2026-09-14T14:52:35+02:00");
});

test("formatVerifactuDate uses the Madrid calendar day (an invoice issued at 00:30 Madrid belongs to that day)", () => {
  assert.equal(formatVerifactuDate("2026-09-13T10:28:01.173Z"), "13-09-2026");
  assert.equal(formatVerifactuDate("2026-09-13T22:30:00.000Z"), "14-09-2026");
  assert.equal(formatVerifactuDate("14-09-2026"), "14-09-2026", "dd-mm-yyyy passes through");
});

test("formatVerifactuAmount: two decimals, no negative zero, negative deltas kept (rectificativas)", () => {
  assert.equal(formatVerifactuAmount(0), "0.00");
  assert.equal(formatVerifactuAmount(-0), "0.00");
  assert.equal(formatVerifactuAmount(-0.004), "0.00");
  assert.equal(formatVerifactuAmount(121), "121.00");
  assert.equal(formatVerifactuAmount(-12.345), "-12.35");
  assert.equal(formatVerifactuAmount(1.005), "1.01");
});

test("alta canonical keeps the Orden HAC/1177/2024 order and the demo huella stays reproducible", () => {
  const input = {
    emitterTaxId: "B12345674",
    invoiceNumber: "FAC-2026-000001",
    issuedAt: "2026-07-12T15:39:35.165Z",
    invoiceType: "F1",
    vatTotal: 11,
    invoiceTotal: 121,
    previousHash: null
  };
  const canonical = buildVerifactuCanonical(input);
  assert.equal(
    canonical,
    "IDEmisorFactura=B12345674&NumSerieFactura=FAC-2026-000001&FechaExpedicionFactura=12-07-2026&TipoFactura=F1&CuotaTotal=11.00&ImporteTotal=121.00&Huella=&FechaHoraHusoGenRegistro=2026-07-12T17:39:35+02:00"
  );
  const { hash } = computeVerifactuHash(input);
  assert.equal(hash, createHash("sha256").update(canonical, "utf-8").digest("hex").toUpperCase());
  assert.match(hash, /^[0-9A-F]{64}$/);
});

test("anulación canonical: IDEmisorFacturaAnulada, NumSerieFacturaAnulada, FechaExpedicionFacturaAnulada, Huella, FechaHoraHusoGenRegistro", () => {
  const canonical = buildVerifactuAnulacionCanonical({
    emitterTaxId: "B12345674",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "14-09-2026",
    previousHash: "ABCDEF",
    generatedAt: "2026-09-14T14:59:40+02:00"
  });
  assert.equal(
    canonical,
    "IDEmisorFacturaAnulada=B12345674&NumSerieFacturaAnulada=FAC-2026-000006&FechaExpedicionFacturaAnulada=14-09-2026&Huella=ABCDEF&FechaHoraHusoGenRegistro=2026-09-14T14:59:40+02:00"
  );
});

test("computeVerifactuAnulacionHash: SHA-256 upper-case, converts ISO inputs, first record has empty Huella", () => {
  const iso = computeVerifactuAnulacionHash({
    emitterTaxId: "B12345674",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "2026-09-14T12:08:14.013Z",
    previousHash: null,
    generatedAt: "2026-09-14T12:59:40.285Z"
  });
  assert.equal(
    iso.canonical,
    "IDEmisorFacturaAnulada=B12345674&NumSerieFacturaAnulada=FAC-2026-000006&FechaExpedicionFacturaAnulada=14-09-2026&Huella=&FechaHoraHusoGenRegistro=2026-09-14T14:59:40+02:00"
  );
  assert.equal(iso.hash, createHash("sha256").update(iso.canonical, "utf-8").digest("hex").toUpperCase());

  const preformatted = computeVerifactuAnulacionHash({
    emitterTaxId: "B12345674",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "14-09-2026",
    previousHash: null,
    generatedAt: "2026-09-14T14:59:40+02:00"
  });
  assert.equal(preformatted.hash, iso.hash, "dd-mm-yyyy / offset inputs and ISO inputs hash identically");

  const chained = computeVerifactuAnulacionHash({ ...{
    emitterTaxId: "B12345674",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "14-09-2026",
    generatedAt: "2026-09-14T14:59:40+02:00"
  }, previousHash: iso.hash });
  assert.notEqual(chained.hash, iso.hash);
});

test("alta and anulación of the same invoice never collide", () => {
  const alta = computeVerifactuHash({
    emitterTaxId: "B12345674",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "2026-09-14T12:08:14.013Z",
    invoiceType: "F1",
    vatTotal: 0,
    invoiceTotal: 0,
    previousHash: null
  });
  const anulacion = computeVerifactuAnulacionHash({
    emitterTaxId: "B12345674",
    invoiceNumber: "FAC-2026-000006",
    issuedAt: "2026-09-14T12:08:14.013Z",
    previousHash: alta.hash,
    generatedAt: "2026-09-14T12:08:14.013Z"
  });
  assert.notEqual(alta.hash, anulacion.hash);
});
