// Unit tests for the pure parte-de-viajeros payload of the check-in (Tanda L5 · L5-B1).
// No database: guestRegisterPayloadForLink / ageAtDate are pure. Run from apps/api with
//   node --import tsx --test src/modules/compliance/__tests__/guest-register-ensure.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ageAtDate, GUEST_REGISTER_MINOR_AGE, guestRegisterPayloadForLink, type GuestRegisterLinkGuest } from "../compliance.service.js";

const CHECKIN_AT = "2026-09-19T14:00:00.000Z";

function guest(overrides: Partial<GuestRegisterLinkGuest> & { id: string }): GuestRegisterLinkGuest {
  return {
    firstName: "Ana",
    surname1: "García",
    surname2: null,
    sex: "F",
    nationality: "ESP",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    documentType: "PASSPORT",
    documentNumber: "XDA123456",
    documentSupportNumber: null,
    residenceAddress: "Calle Real 1",
    residenceLocality: "A Coruña",
    residenceCountry: "ESP",
    phone: null,
    mobilePhone: "+34600000000",
    email: "ana@example.com",
    ...overrides
  };
}

describe("ageAtDate", () => {
  it("counts whole years at the reference date (day before / on / after the birthday)", () => {
    assert.equal(ageAtDate("2012-09-20", "2026-09-19T14:00:00.000Z"), 13, "the day before the 14th birthday is still 13");
    assert.equal(ageAtDate("2012-09-19", "2026-09-19T14:00:00.000Z"), 14, "on the birthday");
    assert.equal(ageAtDate(new Date("2012-09-18T00:00:00.000Z"), new Date("2026-09-19T14:00:00.000Z")), 14);
    assert.equal(ageAtDate("2018-06-01", CHECKIN_AT), 8);
  });

  it("is undefined without a parsable birth date", () => {
    assert.equal(ageAtDate(null, CHECKIN_AT), undefined);
    assert.equal(ageAtDate(undefined, CHECKIN_AT), undefined);
    assert.equal(ageAtDate("no-es-una-fecha", CHECKIN_AT), undefined);
  });

  it("pins the legal threshold at 14", () => {
    assert.equal(GUEST_REGISTER_MINOR_AGE, 14);
  });
});

describe("guestRegisterPayloadForLink", () => {
  it("corrector L5 (CS-06): the expected departure travels as checkoutAt (retention base = end of service), optional", () => {
    const withCheckout = guestRegisterPayloadForLink({
      link: { isPrimary: true, relationshipType: null },
      guest: guest({ id: "guest_adult" }),
      reservationCode: "RES-00001",
      checkinAt: CHECKIN_AT,
      checkoutAt: "2026-09-21T00:00:00.000Z",
      primaryGuestId: "guest_adult"
    });
    assert.equal(withCheckout.checkoutAt, "2026-09-21T00:00:00.000Z");
    const without = guestRegisterPayloadForLink({ link: { isPrimary: true, relationshipType: null }, guest: guest({ id: "guest_adult" }), reservationCode: "RES-00001", checkinAt: CHECKIN_AT, primaryGuestId: "guest_adult" });
    assert.equal(without.checkoutAt, undefined);
  });

  it("primary adult: isPrimaryGuest true, not a minor, no adult link, profile columns mapped, discard flag set", () => {
    const adult = guest({ id: "guest_adult" });
    const payload = guestRegisterPayloadForLink({
      link: { isPrimary: true, relationshipType: null },
      guest: adult,
      reservationCode: "RES-00001",
      checkinAt: CHECKIN_AT,
      primaryGuestId: "guest_adult"
    });
    assert.equal(payload.guestId, "guest_adult");
    assert.equal(payload.isPrimaryGuest, true);
    assert.equal(payload.isMinor, false);
    assert.equal(payload.age, 36);
    assert.equal(payload.providedByAdultGuestId, undefined);
    assert.equal(payload.kinshipRelationIfMinor, undefined);
    assert.equal(payload.recordType, "checkin");
    assert.equal(payload.contractReference, "RES-00001");
    assert.equal(payload.checkinAt, CHECKIN_AT);
    assert.equal(payload.dateOfBirth, "1990-01-01");
    assert.equal(payload.residenceFullAddress, "Calle Real 1");
    assert.equal(payload.phoneMobile, "+34600000000");
    assert.equal(payload.phoneLandline, undefined);
    assert.equal(payload.travellerCount, 1);
    assert.equal(payload.idImageDiscarded, true);
  });

  it("non-primary adult: isPrimaryGuest false and no adult link even though a primary exists", () => {
    const payload = guestRegisterPayloadForLink({
      link: { isPrimary: false, relationshipType: "pareja" },
      guest: guest({ id: "guest_partner", firstName: "Luis", dateOfBirth: "1988-03-03" }),
      reservationCode: "RES-00001",
      checkinAt: CHECKIN_AT,
      primaryGuestId: "guest_adult"
    });
    assert.equal(payload.isPrimaryGuest, false);
    assert.equal(payload.isMinor, false);
    assert.equal(payload.providedByAdultGuestId, undefined, "an adult is never declared through another guest");
    assert.equal(payload.kinshipRelationIfMinor, "pareja", "the link relationship travels as-is (the validator only demands it for minors)");
    assert.equal(payload.dateOfBirth, "1988-03-03", "ISO string birth dates are accepted too");
  });

  it("minor of 8 with a relationship: isMinor, age at the check-in date, providedByAdultGuestId = primary, kinship from the link", () => {
    const payload = guestRegisterPayloadForLink({
      link: { isPrimary: false, relationshipType: "hija" },
      guest: guest({ id: "guest_child", firstName: "Lucía", dateOfBirth: new Date("2018-06-01T00:00:00.000Z"), documentNumber: "XDA654321" }),
      reservationCode: "RES-00001",
      checkinAt: CHECKIN_AT,
      primaryGuestId: "guest_adult"
    });
    assert.equal(payload.isPrimaryGuest, false);
    assert.equal(payload.isMinor, true);
    assert.equal(payload.age, 8);
    assert.equal(payload.providedByAdultGuestId, "guest_adult");
    assert.equal(payload.kinshipRelationIfMinor, "hija");
  });

  it("age is computed at the check-in date, not today: 13 the day before the 14th birthday, 14 on it", () => {
    const born = "2012-09-20";
    const before = guestRegisterPayloadForLink({
      link: { isPrimary: false, relationshipType: "hijo" },
      guest: guest({ id: "guest_teen", dateOfBirth: born }),
      reservationCode: "RES-00002",
      checkinAt: "2026-09-19T23:00:00.000Z",
      primaryGuestId: "guest_adult"
    });
    assert.equal(before.age, 13);
    assert.equal(before.isMinor, true);
    assert.equal(before.providedByAdultGuestId, "guest_adult");
    const onBirthday = guestRegisterPayloadForLink({
      link: { isPrimary: false, relationshipType: "hijo" },
      guest: guest({ id: "guest_teen", dateOfBirth: born }),
      reservationCode: "RES-00002",
      checkinAt: "2026-09-20T00:30:00.000Z",
      primaryGuestId: "guest_adult"
    });
    assert.equal(onBirthday.age, 14);
    assert.equal(onBirthday.isMinor, false);
    assert.equal(onBirthday.providedByAdultGuestId, undefined);
  });

  it("a minor that is itself the primary guest (or without any primary) has no adult to be declared through", () => {
    const selfPrimary = guestRegisterPayloadForLink({
      link: { isPrimary: true, relationshipType: null },
      guest: guest({ id: "guest_child", dateOfBirth: "2018-06-01" }),
      reservationCode: "RES-00003",
      checkinAt: CHECKIN_AT,
      primaryGuestId: "guest_child"
    });
    assert.equal(selfPrimary.isMinor, true);
    assert.equal(selfPrimary.providedByAdultGuestId, undefined);
    const noPrimary = guestRegisterPayloadForLink({
      link: { isPrimary: false, relationshipType: null },
      guest: guest({ id: "guest_child", dateOfBirth: "2018-06-01" }),
      reservationCode: "RES-00003",
      checkinAt: CHECKIN_AT,
      primaryGuestId: null
    });
    assert.equal(noPrimary.providedByAdultGuestId, undefined);
  });

  it("without a birth date nobody is a minor (age undefined) and the signature stays required", () => {
    const payload = guestRegisterPayloadForLink({
      link: { isPrimary: true, relationshipType: null },
      guest: guest({ id: "guest_unknown", dateOfBirth: null }),
      reservationCode: "RES-00004",
      checkinAt: CHECKIN_AT,
      primaryGuestId: "guest_unknown"
    });
    assert.equal(payload.age, undefined);
    assert.equal(payload.isMinor, false);
    assert.equal(payload.dateOfBirth, undefined);
  });
});
