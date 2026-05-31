import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  __resetCryptoWarningForTests,
  computeLookupHash,
  isCiphertext,
  LOOKUP_HASH_FIELDS
} from "../crypto.service.js";
import {
  encryptArgsForModel,
  rewriteWhereForModel
} from "@hotelos/database";

function setRandomKey(): void {
  process.env.HOTELOS_FIELD_KEY = randomBytes(32).toString("base64");
  delete process.env.HOTELOS_LOOKUP_HASH_KEY;
  __resetCryptoWarningForTests();
}

function clearKeys(): void {
  delete process.env.HOTELOS_FIELD_KEY;
  delete process.env.HOTELOS_LOOKUP_HASH_KEY;
  __resetCryptoWarningForTests();
}

describe("computeLookupHash (deterministic HMAC-SHA256 for equality lookups)", () => {
  afterEach(clearKeys);

  it("normalises case + surrounding whitespace before hashing", () => {
    setRandomKey();
    const a = computeLookupHash("foo@bar.com");
    const b = computeLookupHash("FOO@bar.com  ");
    const c = computeLookupHash("  foo@BAR.com");
    assert.ok(typeof a === "string" && a.length === 64, "should be 64-char hex");
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it("produces different hashes for different normalised inputs", () => {
    setRandomKey();
    const a = computeLookupHash("alice@example.com");
    const b = computeLookupHash("bob@example.com");
    assert.notEqual(a, b);
  });

  it("returns null for null/undefined/empty/whitespace inputs", () => {
    setRandomKey();
    assert.equal(computeLookupHash(null), null);
    assert.equal(computeLookupHash(undefined), null);
    assert.equal(computeLookupHash(""), null);
    assert.equal(computeLookupHash("   "), null);
  });

  it("returns null and logs once when no key is configured", () => {
    clearKeys();
    const originalWarn = console.warn;
    let warnings = 0;
    console.warn = () => {
      warnings += 1;
    };
    try {
      const a = computeLookupHash("x@y.com");
      const b = computeLookupHash("z@y.com");
      assert.equal(a, null);
      assert.equal(b, null);
      assert.equal(warnings, 1, "lookup-key warning should be emitted exactly once");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("prefers HOTELOS_LOOKUP_HASH_KEY over HOTELOS_FIELD_KEY when both are set", () => {
    const fieldKey = randomBytes(32).toString("base64");
    const lookupKey = randomBytes(32).toString("base64");
    process.env.HOTELOS_FIELD_KEY = fieldKey;
    process.env.HOTELOS_LOOKUP_HASH_KEY = lookupKey;
    __resetCryptoWarningForTests();
    const withBoth = computeLookupHash("alice@example.com");

    // Now only the field key — should differ because the HMAC key differs.
    delete process.env.HOTELOS_LOOKUP_HASH_KEY;
    __resetCryptoWarningForTests();
    const withFieldOnly = computeLookupHash("alice@example.com");
    assert.notEqual(withBoth, withFieldOnly);
  });

  it("LOOKUP_HASH_FIELDS exposes the expected sibling-column mapping", () => {
    assert.equal(LOOKUP_HASH_FIELDS.Guest.email, "emailLookupHash");
    assert.equal(LOOKUP_HASH_FIELDS.Guest.phone, "phoneLookupHash");
    assert.equal(LOOKUP_HASH_FIELDS.Guest.documentNumber, "documentNumberLookupHash");
    assert.equal(LOOKUP_HASH_FIELDS.GuestRegisterRecord.email, "emailLookupHash");
    assert.equal(LOOKUP_HASH_FIELDS.GuestRegisterRecord.phoneMobile, "phoneMobileLookupHash");
    assert.equal(LOOKUP_HASH_FIELDS.GuestRegisterRecord.documentNumber, "documentNumberLookupHash");
  });
});

// Behavioural tests for the Prisma extension's transformation pipeline.
// We exercise the pure helpers directly (the same ones the extension
// invokes) so the tests don't need a live database. The write pipeline
// is: args -> rewriteWhereForModel -> encryptArgsForModel -> SQL. On
// reads it's just rewriteWhereForModel on the way in + decryption on
// the way out.

describe("Prisma extension: encrypt + lookup-hash on write", () => {
  beforeEach(setRandomKey);
  afterEach(clearKeys);

  it("creating a Guest with email writes both ciphertext and lookup hash", () => {
    const out = encryptArgsForModel("Guest", {
      data: {
        organizationId: "org_demo",
        firstName: "Alice",
        email: "alice@example.com",
        phone: "+34 600 000 000",
        documentNumber: "12345678X"
      }
    }) as { data: Record<string, unknown> };
    const row = out.data;
    assert.ok(isCiphertext(row.email as string), "email should be encrypted");
    assert.ok(isCiphertext(row.phone as string), "phone should be encrypted");
    assert.ok(isCiphertext(row.documentNumber as string), "documentNumber should be encrypted");
    assert.equal(typeof row.emailLookupHash, "string");
    assert.equal((row.emailLookupHash as string).length, 64);
    assert.equal(row.emailLookupHash, computeLookupHash("alice@example.com"));
    assert.equal(row.phoneLookupHash, computeLookupHash("+34 600 000 000"));
    assert.equal(row.documentNumberLookupHash, computeLookupHash("12345678X"));
  });

  it("update with { set: ... } also computes the lookup hash", () => {
    const out = encryptArgsForModel("Guest", {
      where: { id: "g_1" },
      data: { email: { set: "new@example.com" } }
    }) as { data: Record<string, unknown> };
    const emailOut = out.data.email as { set: string };
    assert.ok(isCiphertext(emailOut.set));
    assert.equal(out.data.emailLookupHash, computeLookupHash("new@example.com"));
  });

  it("createMany rewrites each row's hash", () => {
    const out = encryptArgsForModel("Guest", {
      data: [
        { organizationId: "org_demo", firstName: "A", email: "a@x.com" },
        { organizationId: "org_demo", firstName: "B", email: "b@x.com" }
      ]
    }) as { data: Array<Record<string, unknown>> };
    assert.equal(out.data[0]!.emailLookupHash, computeLookupHash("a@x.com"));
    assert.equal(out.data[1]!.emailLookupHash, computeLookupHash("b@x.com"));
  });

  it("setting email to null clears the lookup hash sibling", () => {
    const out = encryptArgsForModel("Guest", {
      where: { id: "g_1" },
      data: { email: null }
    }) as { data: Record<string, unknown> };
    assert.equal(out.data.email, null);
    assert.equal(out.data.emailLookupHash, null);
  });
});

describe("Prisma extension: where-clause rewrite to lookup hash", () => {
  beforeEach(setRandomKey);
  afterEach(clearKeys);

  it("findFirst { where: { email: 'x@y' } } is rewritten to emailLookupHash", () => {
    const out = rewriteWhereForModel("Guest", { where: { email: "x@y.com" } }) as {
      where: Record<string, unknown>;
    };
    assert.equal("email" in out.where, false, "raw email field should be removed");
    assert.equal(out.where.emailLookupHash, computeLookupHash("x@y.com"));
  });

  it("rewrites inside OR / AND / NOT branches", () => {
    const out = rewriteWhereForModel("Guest", {
      where: {
        OR: [{ documentNumber: "12345678X" }, { email: "x@y.com" }],
        AND: [{ organizationId: "org_demo" }]
      }
    }) as { where: Record<string, unknown> };
    const orArr = out.where.OR as Array<Record<string, unknown>>;
    assert.equal(orArr[0]!.documentNumberLookupHash, computeLookupHash("12345678X"));
    assert.equal("documentNumber" in orArr[0]!, false);
    assert.equal(orArr[1]!.emailLookupHash, computeLookupHash("x@y.com"));
    assert.equal("email" in orArr[1]!, false);
    // unaffected fields untouched
    const andArr = out.where.AND as Array<Record<string, unknown>>;
    assert.equal(andArr[0]!.organizationId, "org_demo");
  });

  it("rewrites { equals: '...' } and { in: [...] } operators", () => {
    const eqOut = rewriteWhereForModel("Guest", {
      where: { email: { equals: "x@y.com" } }
    }) as { where: Record<string, unknown> };
    assert.equal(eqOut.where.emailLookupHash, computeLookupHash("x@y.com"));

    const inOut = rewriteWhereForModel("Guest", {
      where: { email: { in: ["a@x.com", "b@x.com"] } }
    }) as { where: Record<string, unknown> };
    const inClause = inOut.where.emailLookupHash as { in: string[] };
    assert.deepEqual(inClause.in, [computeLookupHash("a@x.com"), computeLookupHash("b@x.com")]);
  });

  it("leaves contains/startsWith operators alone (cannot be done over ciphertext)", () => {
    const out = rewriteWhereForModel("Guest", {
      where: { email: { contains: "example.com" } }
    }) as { where: Record<string, unknown> };
    // The clause should be preserved unchanged (it won't match anything
    // against ciphertext, but rewriting would be silently wrong).
    assert.deepEqual(out.where.email, { contains: "example.com" });
    assert.equal("emailLookupHash" in out.where, false);
  });

  it("normalised lookup makes findFirst by email work after encryption", () => {
    // Write: encrypts email + sets hash from normalised plaintext
    const createArgs = encryptArgsForModel("Guest", {
      data: { organizationId: "org", firstName: "A", email: "X@Y.com" }
    }) as { data: Record<string, unknown> };
    // Read: caller writes the natural-key shape; we rewrite to hash
    const findArgs = rewriteWhereForModel("Guest", {
      where: { email: "  x@y.com  " }
    }) as { where: Record<string, unknown> };
    assert.equal(createArgs.data.emailLookupHash, findArgs.where.emailLookupHash);
  });
});
