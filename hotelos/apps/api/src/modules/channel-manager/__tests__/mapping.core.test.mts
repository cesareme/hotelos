// Shared external codes (mapping.core.ts): what a room / rate code used by
// two room types means per provider, and the Spanish upsert warnings.
//
//   · a ROOM code shared across types warns on EVERY provider (availability
//     goes by room; Booking / Expedia price by room too) — the collision the
//     hub let through silently (IND mapped to EX-DBL while DBL used EX-DBL);
//   · a RATE code shared across types warns only on the Channex-routed ones
//     (Booking / Expedia legitimately share RP-<plan> across rooms);
//   · inactive rows and the saved row's own type never count.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressesByRatePlanOnly, productMappingWarnings, providerLabelEs, sharedProductCodes, type MappingCodeRow } from "../mapping.core.js";

const ENGLISH = /\b(Required|Invalid|Expected|received|shared|room type|rate plan id)\b/;

function row(roomTypeId: string, roomTypeCode: string, externalRoomCode: string, externalRateCode: string, status = "active"): MappingCodeRow {
  return { roomTypeId, roomTypeCode, externalRoomCode, externalRateCode, status };
}

// Los Tilos / Expedia after the hub saved IND with DBL's room code.
const EXPEDIA_COLLIDED = [row("rt_ind", "IND", "EX-DBL", "RP-BAR"), row("rt_dbl", "DBL", "EX-DBL", "RP-BAR"), row("rt_dbm", "DBM", "EX-DBM", "RP-BAR"), row("rt_sui", "SUI", "EX-SUI", "RP-BAR")];
const EXPEDIA_SEEDED = [row("rt_ind", "IND", "EX-IND", "RP-BAR"), row("rt_dbl", "DBL", "EX-DBL", "RP-BAR"), row("rt_dbm", "DBM", "EX-DBM", "RP-BAR"), row("rt_sui", "SUI", "EX-SUI", "RP-BAR")];

describe("mapping.core — providers and shared codes", () => {
  it("only the Channex-routed providers address ARI by rate plan; labels name the receiving system", () => {
    for (const code of ["channex", "airbnb", "vrbo", "hotelbeds"]) assert.equal(addressesByRatePlanOnly(code), true, code);
    for (const code of ["booking_com", "booking", "Booking.com", "expedia", "unknown"]) assert.equal(addressesByRatePlanOnly(code), false, code);
    assert.equal(providerLabelEs("booking_com"), "Booking.com");
    assert.equal(providerLabelEs("expedia"), "Expedia");
    assert.equal(providerLabelEs("channex"), "Channex");
    assert.equal(providerLabelEs("airbnb"), "Channex");
  });

  it("sharedProductCodes groups room and rate codes used by more than one ACTIVE room type, sorted", () => {
    const shared = sharedProductCodes(EXPEDIA_COLLIDED);
    assert.deepEqual(shared.roomCodes, [{ code: "EX-DBL", roomTypeIds: ["rt_dbl", "rt_ind"] }]);
    assert.deepEqual(shared.rateCodes, [{ code: "RP-BAR", roomTypeIds: ["rt_dbl", "rt_dbm", "rt_ind", "rt_sui"] }]);
    assert.deepEqual(sharedProductCodes(EXPEDIA_SEEDED).roomCodes, []);
    // An inactive duplicate does not count; two plans of the SAME type sharing a room code is not a collision.
    const sameType = [row("rt_dbl", "DBL", "EX-DBL", "RP-BAR"), row("rt_dbl", "DBL", "EX-DBL", "RP-NR"), row("rt_ind", "IND", "EX-DBL", "RP-BAR", "inactive")];
    assert.deepEqual(sharedProductCodes(sameType), { roomCodes: [], rateCodes: [] });
  });
});

describe("mapping.core — productMappingWarnings", () => {
  it("Expedia: a room code already used by another type warns (Spanish, names the other type); the shared RP-<plan> does not", () => {
    const warnings = productMappingWarnings({ providerCode: "expedia", roomTypeId: "rt_ind", externalRoomCode: "EX-DBL", externalRateCode: "RP-BAR", mappings: EXPEDIA_COLLIDED });
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    const text = warnings[0] as string;
    assert.ok(text.startsWith("En Expedia cada código de habitación externo identifica un solo tipo de habitación: el código EX-DBL también está mapeado en DBL;"), text);
    assert.ok(text.includes("solo se aplicaría el último valor enviado"), text);
    assert.equal(ENGLISH.test(text), false, text);
    assert.equal(text.includes("RP-BAR"), false, "the shared plan code is legitimate on Expedia");
    // Restored to its own code: nothing to warn about.
    assert.deepEqual(productMappingWarnings({ providerCode: "expedia", roomTypeId: "rt_ind", externalRoomCode: "EX-IND", externalRateCode: "RP-BAR", mappings: EXPEDIA_SEEDED }), []);
  });

  it("Booking.com: same rule, labelled Booking.com; inactive rows never collide", () => {
    const booking = EXPEDIA_COLLIDED.map((m) => ({ ...m, externalRoomCode: m.externalRoomCode.replace("EX-", "BK-") }));
    const [text] = productMappingWarnings({ providerCode: "booking_com", roomTypeId: "rt_ind", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", mappings: booking });
    assert.ok(text?.startsWith("En Booking.com cada código de habitación externo"), text);
    const inactive = booking.map((m) => (m.roomTypeId === "rt_dbl" ? { ...m, status: "inactive" } : m));
    assert.deepEqual(productMappingWarnings({ providerCode: "booking_com", roomTypeId: "rt_ind", externalRoomCode: "BK-DBL", externalRateCode: "RP-BAR", mappings: inactive }), []);
  });

  it("Channex-routed: a shared rate code keeps the existing Channex warning; a shared room code adds the room one (two findings, room first)", () => {
    const channex = [row("rt_ind", "IND", "CX-IND", "RP-BAR-DBL"), row("rt_dbl", "DBL", "CX-DBL", "RP-BAR-DBL"), row("rt_dbm", "DBM", "CX-DBM", "RP-BAR-DBM")];
    const rateOnly = productMappingWarnings({ providerCode: "channex", roomTypeId: "rt_ind", externalRoomCode: "CX-IND", externalRateCode: "RP-BAR-DBL", mappings: channex });
    assert.equal(rateOnly.length, 1);
    assert.ok(rateOnly[0]?.startsWith("En Channex cada rate plan pertenece a un solo tipo de habitación: el código RP-BAR-DBL también está mapeado en DBL;"), rateOnly[0]);
    const both = productMappingWarnings({ providerCode: "airbnb", roomTypeId: "rt_ind", externalRoomCode: "CX-DBL", externalRateCode: "RP-BAR-DBL", mappings: channex.map((m) => (m.roomTypeId === "rt_ind" ? { ...m, externalRoomCode: "CX-DBL" } : m)) });
    assert.equal(both.length, 2, JSON.stringify(both));
    assert.ok(both[0]?.includes("código de habitación externo") && both[0]?.includes("CX-DBL"), both[0]);
    assert.ok(both[1]?.includes("rate plan") && both[1]?.includes("RP-BAR-DBL"), both[1]);
    for (const w of both) assert.equal(ENGLISH.test(w), false, w);
  });
});
