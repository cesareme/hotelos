// Unit tests for the Spain guest-register validator (parte de viajeros · RD 933/2021).
//
// Tanda L5 · lote L5-B1: the validator's status must agree with the persisted
// status of the parte (deriveGuestRegisterStatus in ses-hospedajes/xml.ts):
//   · missing identity data + pending signature → `missing_data` (never a
//     "ready" label that hides the missing fields);
//   · only the signature pending → `ready_to_sign`;
//   · a child under 14 (age or isMinor) does not sign, but must be linked to
//     the adult who provides the data and carry the kinship relation.
//
// Run from packages/compliance:
//   node --experimental-strip-types --import ./src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test src/spain/__tests__/guest-register-validator.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateSpainGuestRegisterRecord } from "../guest-register-validator.ts";

/** Every legal field present; no signature, no minor flags (the callers add them). */
const COMPLETE_ADULT = {
  recordType: "checkin",
  firstName: "Ana",
  surname1: "García",
  sex: "F",
  nationality: "ESP",
  dateOfBirth: "1990-01-01",
  documentType: "PASSPORT",
  documentNumber: "XDA123456",
  residenceFullAddress: "Calle Real 1",
  residenceLocality: "A Coruña",
  residenceCountry: "ESP",
  phoneMobile: "+34600000000",
  travellerCount: 1,
  contractReference: "RES-00001",
  checkinAt: "2026-09-19T10:00:00.000Z",
  idImageDiscarded: true
};

const codes = (result) => result.issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.code);

describe("validateSpainGuestRegisterRecord — status", () => {
  it("missing identity data + pending signature → missing_data (not ready_to_sign)", () => {
    const result = validateSpainGuestRegisterRecord({ ...COMPLETE_ADULT, documentNumber: undefined, sex: undefined });
    assert.equal(result.valid, false);
    assert.equal(result.status, "missing_data");
    const blocking = codes(result);
    assert.ok(blocking.includes("signature_required"), blocking.join(","));
    assert.ok(blocking.includes("missing_documentNumber"), blocking.join(","));
    assert.ok(blocking.includes("missing_sex"), blocking.join(","));
  });

  it("only the signature pending → ready_to_sign", () => {
    const result = validateSpainGuestRegisterRecord(COMPLETE_ADULT);
    assert.equal(result.valid, false);
    assert.equal(result.status, "ready_to_sign");
    assert.deepEqual(codes(result), ["signature_required"]);
  });

  it("complete and signed → ready_to_submit and valid", () => {
    const result = validateSpainGuestRegisterRecord({ ...COMPLETE_ADULT, signedAt: "2026-09-19T10:05:00.000Z" });
    assert.equal(result.valid, true);
    assert.equal(result.status, "ready_to_submit");
    assert.deepEqual(codes(result), []);
  });

  it("signature not required (signatureRequired false) → ready_to_submit without signedAt", () => {
    const result = validateSpainGuestRegisterRecord({ ...COMPLETE_ADULT, signatureRequired: false });
    assert.equal(result.valid, true);
    assert.equal(result.status, "ready_to_submit");
  });

  it("DNI without support number and no phone → missing_data with both codes", () => {
    const result = validateSpainGuestRegisterRecord({
      ...COMPLETE_ADULT,
      documentType: "DNI",
      documentNumber: "12345678Z",
      documentSupportNumber: undefined,
      phoneMobile: undefined,
      signedAt: "2026-09-19T10:05:00.000Z"
    });
    assert.equal(result.status, "missing_data");
    assert.deepEqual(codes(result).sort(), ["missing_documentSupportNumber", "missing_phone_contact"]);
  });
});

describe("validateSpainGuestRegisterRecord — minors (under 14)", () => {
  const MINOR = {
    ...COMPLETE_ADULT,
    firstName: "Lucía",
    dateOfBirth: "2018-06-01",
    documentNumber: "XDA654321",
    providedByAdultGuestId: "guest_adult",
    kinshipRelationIfMinor: "madre"
  };

  it("age < 14 with adult link and kinship: no signature required → ready_to_submit", () => {
    const result = validateSpainGuestRegisterRecord({ ...MINOR, age: 8 });
    assert.equal(result.valid, true);
    assert.equal(result.status, "ready_to_submit");
    assert.ok(!codes(result).includes("signature_required"));
  });

  it("isMinor true behaves like age < 14 (persisted column, no age at hand)", () => {
    const result = validateSpainGuestRegisterRecord({ ...MINOR, isMinor: true });
    assert.equal(result.valid, true);
    assert.equal(result.status, "ready_to_submit");
  });

  it("minor without adult link nor kinship → missing_data with both codes and still no signature issue", () => {
    const result = validateSpainGuestRegisterRecord({ ...MINOR, age: 8, providedByAdultGuestId: undefined, kinshipRelationIfMinor: undefined });
    assert.equal(result.valid, false);
    assert.equal(result.status, "missing_data");
    assert.deepEqual(codes(result).sort(), ["missing_kinshipRelationIfMinor", "missing_providedByAdultGuestId"]);
  });

  it("age 14 or older signs like any adult (age boundary)", () => {
    const result = validateSpainGuestRegisterRecord({ ...COMPLETE_ADULT, age: 14 });
    assert.equal(result.status, "ready_to_sign");
    assert.deepEqual(codes(result), ["signature_required"]);
  });
});
