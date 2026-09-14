import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapeRegex,
  formatReservationCode,
  isReservationCodeConflict,
  maxSuffixOf,
  reservationCodeLockKey,
  suffixPattern,
  withReservationCodeRetry
} from "../reservation-code.js";
import { ConflictError } from "../http-error.js";

// `allocateReservationCode` itself needs Postgres (advisory lock + aggregate
// over `reservations`) and is covered by integration (a live transaction
// against the demo dataset, rolled back). These tests pin the pure pieces it
// is built from: the regexp, the MAX-suffix parse (with gaps, other prefixes
// and non-numeric suffixes), the padded/untruncated format, the conflict
// detector and the retry safety net.

describe("suffixPattern / escapeRegex", () => {
  it("escapes regexp metacharacters in the prefix so group codes are matched literally", () => {
    assert.equal(escapeRegex("AUDIT-T4.REG+1(x)"), "AUDIT-T4\\.REG\\+1\\(x\\)");
    const re = new RegExp(suffixPattern("A.B"));
    assert.ok(re.test("A.B-001"));
    assert.ok(!re.test("AXB-001"), "dot must not act as a wildcard");
  });

  it("anchors both ends and captures only the digits", () => {
    const re = new RegExp(suffixPattern("RES"));
    assert.equal(re.exec("RES-00036")?.[1], "00036");
    assert.equal(re.exec("RES-00036-bis"), null);
    assert.equal(re.exec("XRES-00036"), null);
    assert.equal(re.exec("RES-abc"), null);
  });
});

describe("maxSuffixOf (pure counterpart of the SQL MAX aggregate)", () => {
  it("returns the highest suffix even when the sequence has gaps (the T4 regression)", () => {
    // 35 rows but the sequence reaches 85: count+1 would collide with RES-00036.
    const codes = ["RES-00001", "RES-00002", "RES-00036", "RES-00085", "RES-00040"];
    assert.equal(maxSuffixOf(codes, "RES"), 85);
  });

  it("ignores other prefixes and non-numeric suffixes", () => {
    const codes = ["AUDIT-T4-REG-001", "AUDIT-T4-REG2-001", "RES-x", "RES-", "RES-00007"];
    assert.equal(maxSuffixOf(codes, "RES"), 7);
    // A group prefix that is itself a prefix of another group's code must not
    // swallow that group's rows (REG vs REG2).
    assert.equal(maxSuffixOf(codes, "AUDIT-T4-REG"), 1);
    assert.equal(maxSuffixOf(codes, "AUDIT-T4-REG2"), 1);
  });

  it("returns 0 for an empty set or when nothing matches", () => {
    assert.equal(maxSuffixOf([], "RES"), 0);
    assert.equal(maxSuffixOf(["GRP-001"], "RES"), 0);
  });

  it("handles leading zeros and unpadded suffixes alike", () => {
    assert.equal(maxSuffixOf(["RES-00009", "RES-10"], "RES"), 10);
  });
});

describe("formatReservationCode", () => {
  it("zero-pads to 5 digits by default", () => {
    assert.equal(formatReservationCode("RES", 1), "RES-00001");
    assert.equal(formatReservationCode("RES", 86), "RES-00086");
    assert.equal(formatReservationCode("RES", 99999), "RES-99999");
  });

  it("never truncates once the sequence passes the pad width", () => {
    assert.equal(formatReservationCode("RES", 100000), "RES-100000");
    assert.equal(formatReservationCode("RES", 1234567), "RES-1234567");
  });

  it("supports a custom pad (rooming-list codes use 3 digits)", () => {
    assert.equal(formatReservationCode("GRP", 2, 3), "GRP-002");
    assert.equal(formatReservationCode("GRP", 1000, 3), "GRP-1000");
  });

  it("round-trips through maxSuffixOf", () => {
    const next = maxSuffixOf(["RES-00085"], "RES") + 1;
    assert.equal(formatReservationCode("RES", next), "RES-00086");
  });

  it("rejects negative or non-integer suffixes", () => {
    assert.throws(() => formatReservationCode("RES", -1), RangeError);
    assert.throws(() => formatReservationCode("RES", 1.5), RangeError);
  });
});

describe("reservationCodeLockKey", () => {
  it("is one key per (property, prefix)", () => {
    assert.equal(reservationCodeLockKey("prop1", "RES"), "prop1:reservation-code:RES");
    assert.notEqual(reservationCodeLockKey("prop1", "RES"), reservationCodeLockKey("prop1", "GRP"));
    assert.notEqual(reservationCodeLockKey("prop1", "RES"), reservationCodeLockKey("prop2", "RES"));
  });
});

describe("isReservationCodeConflict", () => {
  it("recognises P2002 on the (property_id, code) index", () => {
    assert.ok(isReservationCodeConflict({ code: "P2002", meta: { target: ["property_id", "code"] } }));
    assert.ok(isReservationCodeConflict({ code: "P2002", meta: { target: "reservations_property_id_code_key" } }));
    assert.ok(isReservationCodeConflict({ code: "P2002" }), "no meta → assume ours (retry is harmless)");
  });

  it("ignores other errors and P2002 on unrelated uniques", () => {
    assert.ok(!isReservationCodeConflict({ code: "P2002", meta: { target: ["email"] } }));
    assert.ok(!isReservationCodeConflict({ code: "P2025" }));
    assert.ok(!isReservationCodeConflict(new Error("boom")));
    assert.ok(!isReservationCodeConflict(null));
  });
});

describe("withReservationCodeRetry", () => {
  const p2002 = () => Object.assign(new Error("Unique constraint failed on the fields: (`property_id`,`code`)"), {
    code: "P2002",
    meta: { target: ["property_id", "code"] }
  });

  it("returns the first successful attempt", async () => {
    let calls = 0;
    const out = await withReservationCodeRetry(async () => {
      calls += 1;
      return "RES-00086";
    });
    assert.equal(out, "RES-00086");
    assert.equal(calls, 1);
  });

  it("re-runs the transaction on a code conflict and succeeds on a later attempt", async () => {
    let calls = 0;
    const out = await withReservationCodeRetry(async (attempt) => {
      calls += 1;
      if (attempt < 3) throw p2002();
      return `RES-0008${attempt}`;
    });
    assert.equal(out, "RES-00083");
    assert.equal(calls, 3);
  });

  it("gives up after 3 attempts with a typed 409 (Spanish message + RESERVATION_CODE_CONFLICT)", async () => {
    let calls = 0;
    await assert.rejects(
      withReservationCodeRetry(async () => {
        calls += 1;
        throw p2002();
      }),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /código de reserva/);
        assert.ok(!/Unique constraint|invocation/i.test(err.message), "must not leak Prisma text");
        assert.equal((err.details as { code: string }).code, "RESERVATION_CODE_CONFLICT");
        assert.equal((err as Error & { cause?: unknown }).cause instanceof Error, true, "original error kept as cause");
        return true;
      }
    );
    assert.equal(calls, 3);
  });

  it("propagates any other error immediately without retrying", async () => {
    let calls = 0;
    await assert.rejects(
      withReservationCodeRetry(async () => {
        calls += 1;
        throw new ConflictError("No hay disponibilidad.");
      }),
      /No hay disponibilidad/
    );
    assert.equal(calls, 1);
  });
});
