// Unit tests for the SES.HOSPEDAJES pure domain helpers (Tanda 3 · QC-01 / FISC-08).
// Pure-core only: no database, no env. Run from apps/api with
//   node --import tsx --test src/modules/compliance/__tests__/ses-hospedajes.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blockingIssueCodes,
  buildSesHospedajesXml,
  deriveGuestRegisterStatus,
  deriveSesSubmissionType,
  describeSesEstablishmentIssue,
  guestRegisterValidationInput,
  nextSesExternalReference,
  parseSesExternalReference,
  validateSesEstablishment,
  type SesSubmissionRecord
} from "../../../../../../packages/compliance/src/spain/ses-hospedajes/xml.ts";
import { validateSandboxEstablishment } from "../../../../../../packages/compliance/src/spain/ses-hospedajes/submitter.ts";
import { chooseKeeper, parseFlags, planGuestRegisterBackfill, type PlanRow } from "../../../scripts/backfill-guest-register.js";

// ───────────────────────────────────────────── TipoComunicacion

describe("deriveSesSubmissionType", () => {
  it("first communication of a stay is an alta, even when triggered by check-in", () => {
    assert.equal(deriveSesSubmissionType({ trigger: "checkin", hasAcceptedPrevious: false }), "alta");
    assert.equal(deriveSesSubmissionType({ trigger: "reservation", hasAcceptedPrevious: false }), "alta");
    assert.equal(deriveSesSubmissionType({ hasAcceptedPrevious: false }), "alta");
  });

  it("becomes a modificación once the MIR accepted a previous communication", () => {
    assert.equal(deriveSesSubmissionType({ trigger: "checkin", hasAcceptedPrevious: true }), "modificacion");
    assert.equal(deriveSesSubmissionType({ trigger: "alta", hasAcceptedPrevious: true }), "modificacion");
  });

  it("is a baja on cancellation regardless of history", () => {
    assert.equal(deriveSesSubmissionType({ trigger: "cancellation", hasAcceptedPrevious: false }), "baja");
    assert.equal(deriveSesSubmissionType({ trigger: "checkin", reservationStatus: "cancelled", hasAcceptedPrevious: true }), "baja");
    assert.equal(deriveSesSubmissionType({ recordType: "cancellation", hasAcceptedPrevious: true }), "baja");
    assert.equal(deriveSesSubmissionType({ recordType: "annulment", hasAcceptedPrevious: false }), "baja");
  });
});

// ───────────────────────────────────────────── establishment

const COMPLETE = {
  registryNumber: "H-CO-000123",
  taxId: "B99999999",
  legalName: "AUDIT-T1 SL",
  address: "Paseo Marítimo 1",
  municipalityCode: "15058",
  province: "A Coruña",
  postalCode: "15172",
  country: "ES"
};

describe("validateSesEstablishment", () => {
  it("accepts a complete establishment with coherent INE code and postal code", () => {
    assert.deepEqual(validateSesEstablishment(COMPLETE), { ok: true, missing: [] });
  });

  it("lists every missing field instead of defaulting to Madrid", () => {
    const result = validateSesEstablishment({
      registryNumber: null,
      taxId: "",
      legalName: "   ",
      address: undefined,
      municipalityCode: null,
      province: null,
      postalCode: null,
      country: null
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      [...result.missing].sort(),
      ["address", "country", "legalName", "municipalityCode", "postalCode", "province", "registryNumber", "taxId"]
    );
  });

  it("rejects a municipality code that is not 5 digits or has a province outside 01-52", () => {
    assert.deepEqual(validateSesEstablishment({ ...COMPLETE, municipalityCode: "2807" }).missing, ["municipalityCode.format"]);
    assert.deepEqual(validateSesEstablishment({ ...COMPLETE, municipalityCode: "ABCDE" }).missing, ["municipalityCode.format"]);
    assert.deepEqual(validateSesEstablishment({ ...COMPLETE, municipalityCode: "99001", postalCode: "99001" }).missing, [
      "municipalityCode.format",
      "postalCode.format"
    ]);
  });

  it("cross-checks the province prefix of postal code and INE code", () => {
    // Madrid postal code with an A Coruña INE code: the old hardcoded defaults would have produced exactly this.
    assert.deepEqual(validateSesEstablishment({ ...COMPLETE, postalCode: "28001" }).missing, ["postalCode.provinceMismatch"]);
    assert.deepEqual(validateSesEstablishment({ ...COMPLETE, postalCode: "1517" }).missing, ["postalCode.format"]);
  });

  it("has a Spanish description for every issue code", () => {
    for (const issue of validateSesEstablishment({ ...COMPLETE, registryNumber: null, postalCode: "28001", municipalityCode: "1" }).missing) {
      assert.match(describeSesEstablishmentIssue(issue), /\S/);
    }
  });
});

describe("sandbox stub establishment validation", () => {
  const record = (establishment: SesSubmissionRecord["establishment"]): SesSubmissionRecord => ({
    submissionType: "alta",
    externalReference: "RES-00021-alta-1",
    establishment,
    contract: {
      contractRef: "RES-00021",
      contractDate: "2026-09-13T10:00:00.000Z",
      checkinDate: "2026-09-13",
      checkoutDate: "2026-09-15",
      contractType: "alojamiento",
      numberOfPersons: 1,
      paymentMethod: "card",
      totalAmount: 120
    },
    guests: [
      {
        documentType: "DNI",
        documentNumber: "12345678Z",
        firstName: "Ana",
        surname1: "García",
        dateOfBirth: "1990-01-01",
        nationality: "ESP"
      }
    ]
  });

  it("accepts a well-formed Establecimiento block", () => {
    const xml = buildSesHospedajesXml(record({ ...COMPLETE, registryType: "establecimiento_turistico" }));
    assert.deepEqual(validateSandboxEstablishment(xml), { ok: true });
  });

  it("rejects a CodigoMunicipio that is not 5 digits", () => {
    const xml = buildSesHospedajesXml(record({ ...COMPLETE, registryType: "establecimiento_turistico", municipalityCode: "15" }));
    const result = validateSandboxEstablishment(xml);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.errorMessage, /CodigoMunicipio/);
  });

  it("rejects an empty Direccion", () => {
    const xml = buildSesHospedajesXml(record({ ...COMPLETE, registryType: "establecimiento_turistico", address: "" }));
    const result = validateSandboxEstablishment(xml);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.errorMessage, /Direccion/);
  });
});

// ───────────────────────────────────────────── ReferenciaExterna

describe("nextSesExternalReference", () => {
  it("starts at attempt 1 and is deterministic for the same state", () => {
    assert.equal(nextSesExternalReference("RES-00021", "alta", []), "RES-00021-alta-1");
    assert.equal(nextSesExternalReference("RES-00021", "alta", []), "RES-00021-alta-1");
  });

  it("continues after the highest attempt of the same reservation and type only", () => {
    const existing = ["RES-00021-alta-1", "RES-00021-alta-3", "RES-00021-modificacion-7", "RES-00099-alta-9", null, undefined];
    assert.equal(nextSesExternalReference("RES-00021", "alta", existing), "RES-00021-alta-4");
    assert.equal(nextSesExternalReference("RES-00021", "modificacion", existing), "RES-00021-modificacion-8");
    assert.equal(nextSesExternalReference("RES-00021", "baja", existing), "RES-00021-baja-1");
  });

  it("ignores legacy Date.now() references so they never inflate the counter", () => {
    assert.equal(parseSesExternalReference("RES-00021-modificacion-1789295676779"), null);
    assert.equal(nextSesExternalReference("RES-00021", "modificacion", ["RES-00021-modificacion-1789295676779"]), "RES-00021-modificacion-1");
  });

  it("parses a reservation code that itself contains dashes", () => {
    assert.deepEqual(parseSesExternalReference("RES-00021-alta-12"), { reservationCode: "RES-00021", submissionType: "alta", attempt: 12 });
    assert.equal(parseSesExternalReference("garbage"), null);
  });
});

// ───────────────────────────────────────────── parte status derivation

describe("deriveGuestRegisterStatus", () => {
  it("keeps pipeline-owned statuses untouched", () => {
    for (const status of ["queued", "exported", "submitted", "accepted", "rejected", "failed", "annulled", "corrected", "expired"]) {
      assert.equal(deriveGuestRegisterStatus({ currentStatus: status, validationValid: true, validationStatus: "ready_to_submit", signedAt: null }), status);
    }
  });

  it("marks a valid record signed when it carries a signature, ready_to_submit otherwise", () => {
    assert.equal(deriveGuestRegisterStatus({ currentStatus: "draft", validationValid: true, validationStatus: "ready_to_submit", signedAt: "2026-09-14T10:00:00.000Z" }), "signed");
    assert.equal(deriveGuestRegisterStatus({ currentStatus: "draft", validationValid: true, validationStatus: "ready_to_submit", signedAt: null }), "ready_to_submit");
  });

  it("takes the validator verdict for an invalid record when no issue codes are given", () => {
    assert.equal(deriveGuestRegisterStatus({ currentStatus: "draft", validationValid: false, validationStatus: "missing_data", signedAt: null }), "missing_data");
    assert.equal(deriveGuestRegisterStatus({ currentStatus: null, validationValid: false, validationStatus: "ready_to_sign", signedAt: null }), "ready_to_sign");
  });

  it("is ready_to_sign only when the signature is the sole blocker, missing_data otherwise", () => {
    const base = { currentStatus: "draft", validationValid: false, validationStatus: "ready_to_sign", signedAt: null };
    assert.equal(deriveGuestRegisterStatus({ ...base, blockingIssueCodes: ["signature_required"] }), "ready_to_sign");
    assert.equal(deriveGuestRegisterStatus({ ...base, blockingIssueCodes: ["signature_required", "missing_documentNumber"] }), "missing_data");
    assert.deepEqual(
      blockingIssueCodes([
        { code: "missing_sex", severity: "blocking" },
        { code: "hint", severity: "warning" }
      ]),
      ["missing_sex"]
    );
  });
});

describe("guestRegisterValidationInput", () => {
  it("maps Date columns to ISO strings and nulls to undefined", () => {
    const input = guestRegisterValidationInput({
      recordType: null,
      firstName: "Ana",
      surname1: null,
      surname2: null,
      sex: null,
      nationality: null,
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      documentType: null,
      documentNumber: null,
      documentSupportNumber: null,
      residenceFullAddress: null,
      residenceLocality: null,
      residenceCountry: null,
      phoneLandline: null,
      phoneMobile: null,
      email: null,
      travellerCount: null,
      isMinor: false,
      providedByAdultGuestId: null,
      kinshipRelationIfMinor: null,
      contractReference: null,
      contractDate: null,
      checkinAt: "2026-09-14T10:00:00.000Z",
      checkoutAt: null,
      paymentType: null,
      paymentMethodIdentifier: null,
      paymentHolder: null,
      paymentReference: null,
      signatureRequired: true,
      signedAt: null,
      idImageStored: false,
      idImageDiscarded: true
    });
    assert.equal(input.recordType, "checkin");
    assert.equal(input.dateOfBirth, "1990-01-01");
    assert.equal(input.checkinAt, "2026-09-14T10:00:00.000Z");
    assert.equal(input.surname1, undefined);
    assert.equal(input.idImageDiscarded, true);
  });
});

// ───────────────────────────────────────────── backfill planner

function planRow(overrides: Partial<PlanRow> & { id: string }): PlanRow {
  return {
    reservationId: "res_1",
    guestId: "guest_1",
    status: "draft",
    createdAt: new Date("2026-09-14T10:00:00.000Z"),
    signedAt: null,
    duplicateOf: null,
    hasAcceptedSubmission: false,
    storedIssueCodes: [],
    validation: { valid: false, status: "missing_data", issues: [{ code: "missing_surname1", severity: "blocking", message: "x" }] },
    ...overrides
  };
}

describe("planGuestRegisterBackfill", () => {
  it("recomputes draft rows whose stored verdict is empty", () => {
    const plan = planGuestRegisterBackfill([planRow({ id: "a" })]);
    assert.deepEqual(plan.statusUpdates, [{ id: "a", fromStatus: "draft", toStatus: "missing_data", issueCodes: ["missing_surname1"] }]);
    assert.deepEqual(plan.duplicates, []);
    assert.equal(plan.unchanged, 0);
  });

  it("marks a draft row with an accepted SES submission as accepted", () => {
    const plan = planGuestRegisterBackfill([planRow({ id: "a", hasAcceptedSubmission: true })]);
    assert.deepEqual(plan.statusUpdates, [{ id: "a", fromStatus: "draft", toStatus: "accepted", issueCodes: ["missing_surname1"] }]);
  });

  it("is idempotent: a row already matching the validator is unchanged", () => {
    const plan = planGuestRegisterBackfill([planRow({ id: "a", status: "missing_data", storedIssueCodes: ["missing_surname1"] })]);
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.statusUpdates, []);
  });

  it("marks duplicates by (reservation, guest) keeping the oldest and never deletes", () => {
    const plan = planGuestRegisterBackfill([
      planRow({ id: "newer", createdAt: new Date("2026-09-14T12:00:00.000Z") }),
      planRow({ id: "older", createdAt: new Date("2026-09-14T09:00:00.000Z") }),
      planRow({ id: "other_guest", guestId: "guest_2" })
    ]);
    assert.deepEqual(plan.duplicates, [{ id: "newer", duplicateOf: "older", fromStatus: "draft" }]);
    assert.deepEqual(
      plan.statusUpdates.map((update) => update.id).sort(),
      ["older", "other_guest"]
    );
  });

  it("prefers the row with an accepted SES submission, then the most advanced status", () => {
    const withAccepted = chooseKeeper([
      planRow({ id: "signed", status: "signed", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
      planRow({ id: "accepted", status: "draft", hasAcceptedSubmission: true, createdAt: new Date("2026-02-01T00:00:00.000Z") })
    ]);
    assert.equal(withAccepted.id, "accepted");
    const byStatus = chooseKeeper([
      planRow({ id: "draft", status: "draft", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
      planRow({ id: "signed", status: "signed", createdAt: new Date("2026-02-01T00:00:00.000Z") })
    ]);
    assert.equal(byStatus.id, "signed");
  });

  it("does not re-mark duplicates already expired by a previous run", () => {
    const plan = planGuestRegisterBackfill([
      planRow({ id: "keeper", status: "missing_data", storedIssueCodes: ["missing_surname1"] }),
      planRow({ id: "dup", status: "expired", duplicateOf: "keeper" })
    ]);
    assert.deepEqual(plan.duplicates, []);
    assert.deepEqual(plan.statusUpdates, []);
    assert.equal(plan.unchanged, 1);
  });

  it("skips rows without reservation or guest in the dedupe but still validates them", () => {
    const plan = planGuestRegisterBackfill([planRow({ id: "a", guestId: null }), planRow({ id: "b", guestId: null })]);
    assert.deepEqual(plan.duplicates, []);
    assert.equal(plan.statusUpdates.length, 2);
  });
});

describe("backfill parseFlags", () => {
  it("defaults to dry-run and accepts --apply / --property / --batch", () => {
    assert.deepEqual(parseFlags([]), { apply: false, propertyId: null, batch: 500, json: false });
    assert.deepEqual(parseFlags(["--apply", "--property", "prop_1", "--batch", "50", "--json"]), { apply: true, propertyId: "prop_1", batch: 50, json: true });
  });

  it("rejects unknown flags and invalid batch sizes", () => {
    assert.throws(() => parseFlags(["--nope"]), /Unknown flag/);
    assert.throws(() => parseFlags(["--batch", "0"]), /between 1 and 5000/);
    assert.throws(() => parseFlags(["--property"]), /requires a value/);
  });
});
