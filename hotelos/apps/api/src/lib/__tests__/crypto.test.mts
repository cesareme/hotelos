import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  __resetCryptoWarningForTests,
  decryptField,
  encryptField,
  isCiphertext
} from "../crypto.service.js";

function setRandomKey(): string {
  const key = randomBytes(32).toString("base64");
  process.env.HOTELOS_FIELD_KEY = key;
  __resetCryptoWarningForTests();
  return key;
}

function clearKey(): void {
  delete process.env.HOTELOS_FIELD_KEY;
  __resetCryptoWarningForTests();
}

describe("crypto.service (envelope encryption)", () => {
  afterEach(clearKey);

  it("produces ciphertext distinct from plaintext", () => {
    setRandomKey();
    const plaintext = "12345678X";
    const ciphertext = encryptField(plaintext);
    assert.notEqual(ciphertext, plaintext);
    assert.ok(typeof ciphertext === "string" && ciphertext.length > 0);
  });

  it("round-trips arbitrary string content (decryptField(encryptField(x)) === x)", () => {
    setRandomKey();
    const samples = [
      "alice@example.com",
      "+34 612 345 678",
      "Calle Mayor 1, 28013 Madrid",
      "Aañéíóúü emoji \u{1F600} mix"
    ];
    for (const sample of samples) {
      const ct = encryptField(sample);
      assert.ok(typeof ct === "string");
      const back = decryptField(ct);
      assert.equal(back, sample);
    }
  });

  it("output format matches v1.{hex}.{hex}.{hex}", () => {
    setRandomKey();
    const ct = encryptField("payload");
    assert.ok(typeof ct === "string");
    const parts = (ct as string).split(".");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], "v1");
    assert.match(parts[1]!, /^[0-9a-f]+$/);
    assert.match(parts[2]!, /^[0-9a-f]+$/);
    assert.match(parts[3]!, /^[0-9a-f]+$/);
    assert.ok(isCiphertext(ct));
  });

  it("falls back to plaintext + logs a single warning when env var is missing", () => {
    clearKey();
    const originalWarn = console.warn;
    let warnings = 0;
    console.warn = () => {
      warnings += 1;
    };
    try {
      const out1 = encryptField("hello");
      const out2 = encryptField("world");
      assert.equal(out1, "hello");
      assert.equal(out2, "world");
      assert.equal(warnings, 1, "expected exactly one warning across multiple calls");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("passes through values that are already encrypted (no double-wrap)", () => {
    setRandomKey();
    const once = encryptField("hello") as string;
    const twice = encryptField(once);
    assert.equal(twice, once);
  });

  it("passes through legacy plaintext on decrypt (no v1. prefix)", () => {
    setRandomKey();
    assert.equal(decryptField("legacy-plaintext"), "legacy-plaintext");
  });

  it("preserves null and undefined inputs", () => {
    setRandomKey();
    assert.equal(encryptField(null), null);
    assert.equal(encryptField(undefined), undefined);
    assert.equal(decryptField(null), null);
    assert.equal(decryptField(undefined), undefined);
  });

  it("throws on decrypt when the key is wrong", () => {
    setRandomKey();
    const ct = encryptField("secret") as string;
    // Rotate the key in-place — the existing envelope is now undecryptable.
    process.env.HOTELOS_FIELD_KEY = randomBytes(32).toString("base64");
    __resetCryptoWarningForTests();
    assert.throws(() => decryptField(ct));
  });
});

describe("crypto.service — invalid env values fall back safely", () => {
  beforeEach(__resetCryptoWarningForTests);
  afterEach(clearKey);

  it("falls back when HOTELOS_FIELD_KEY is the wrong byte length", () => {
    process.env.HOTELOS_FIELD_KEY = Buffer.from("too-short").toString("base64");
    const originalWarn = console.warn;
    let warnings = 0;
    console.warn = () => {
      warnings += 1;
    };
    try {
      const out = encryptField("plain");
      assert.equal(out, "plain");
      assert.equal(warnings, 1);
    } finally {
      console.warn = originalWarn;
    }
  });
});
