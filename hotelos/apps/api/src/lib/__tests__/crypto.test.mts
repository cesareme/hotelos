import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  __resetCryptoWarningForTests,
  decryptField,
  encryptField,
  isCiphertext
} from "../crypto.service.js";
// decryptResultForModel is consumed by the Prisma extension only and is not part of the
// API facade: the test reads it from the package source (same module instance under tsx).
import {
  __resetCryptoWarningForTests as resetDatabaseWarnings,
  LOOKUP_HASH_FIELDS,
  PII_FIELDS,
  computeLookupHash,
  decryptResultForModel,
  encryptArgsForModel,
  encryptField as encryptDatabaseField,
  rewriteWhereForModel
} from "../../../../../packages/database/src/crypto-fields.js";

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

// crypto-fields.ts falls back to ENCRYPTION_KEY when HOTELOS_FIELD_KEY is
// unset, so a developer shell with `.env` sourced (or CI exporting the key)
// made the "missing key" tests see a valid key. Pin the environment the
// suite assumes and restore whatever the shell had afterwards.
const ISOLATED_KEYS = ["ENCRYPTION_KEY", "HOTELOS_FIELD_KEY", "HOTELOS_LOOKUP_HASH_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();
before(() => {
  for (const name of ISOLATED_KEYS) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  __resetCryptoWarningForTests();
});
after(() => {
  for (const name of ISOLATED_KEYS) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetCryptoWarningForTests();
});

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

describe("crypto-fields — decryptResultForModel with a wrong key (Cocoa 22 · ola 11 · grr_e86d63b9)", () => {
  beforeEach(() => {
    __resetCryptoWarningForTests();
    resetDatabaseWarnings();
  });
  afterEach(clearKey);

  it("returns null in the field and never the v1. envelope, warning once per model and field", () => {
    setRandomKey();
    resetDatabaseWarnings();
    const envelope = encryptDatabaseField("12345678Z") as string;
    assert.ok(isCiphertext(envelope));
    // Rotate the key in-place — the stored envelope is now undecryptable.
    process.env.HOTELOS_FIELD_KEY = randomBytes(32).toString("base64");
    __resetCryptoWarningForTests();
    resetDatabaseWarnings();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      const rows = decryptResultForModel("GuestRegisterRecord", [
        { id: "grr_1", documentNumber: envelope, email: envelope, phoneMobile: null },
        { id: "grr_2", documentNumber: envelope, email: "plain@example.com", phoneMobile: undefined }
      ]);
      for (const row of rows) {
        assert.equal(row.documentNumber, null, "the undecryptable field reads as null");
        assert.ok(!JSON.stringify(row).includes("v1."), "the envelope never leaves the extension");
      }
      assert.equal(rows[0]!.email, null);
      assert.equal(rows[1]!.email, "plain@example.com", "legacy plaintext passes through");
      assert.equal(rows[1]!.id, "grr_2");
      assert.equal(warnings.length, 2, "one warning per (model, field): documentNumber and email");
      for (const warning of warnings) {
        assert.match(warning, /GuestRegisterRecord\.(documentNumber|email)/);
        assert.ok(!warning.includes(envelope) && !warning.includes("v1."), "the warning never carries the envelope");
        assert.ok(!warning.includes(process.env.HOTELOS_FIELD_KEY!), "the warning never carries the key");
      }
      // Same field again: no new warning.
      decryptResultForModel("GuestRegisterRecord", { id: "grr_3", documentNumber: envelope });
      assert.equal(warnings.length, 2);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("decrypts normally with the right key and leaves models without PII fields untouched", () => {
    setRandomKey();
    resetDatabaseWarnings();
    const envelope = encryptDatabaseField("12345678Z") as string;
    const row = decryptResultForModel("GuestRegisterRecord", { id: "grr_1", documentNumber: envelope });
    assert.equal(row.documentNumber, "12345678Z");
    const untouched = { id: "x", documentNumber: envelope };
    assert.equal(decryptResultForModel("Building", untouched), untouched);
  });
});

// Tanda RRHH (RRHH-1): el expediente de empleado entra en la extensión de cifrado. Datos de prueba
// FICTICIOS (NIF sintético con letra válida, correo en example.test); nunca personas reales.
describe("crypto-fields — Employee (Tanda RRHH · RRHH-1): PII cifrada y hash de búsqueda solo para taxId", () => {
  const EMPLOYEE_PII = ["taxId", "socialSecurityNumber", "email", "phone", "iban"] as const;
  const ficticio = {
    employeeNumber: "E-0001",
    firstName: "Ficticia",
    lastName: "Prueba",
    taxId: "12345678Z",
    socialSecurityNumber: "281234567890",
    email: "ficticia@example.test",
    phone: "+34600000000",
    iban: "ES9121000418450200051332",
    jobTitle: "Camarera de pisos",
    status: "active"
  };

  beforeEach(() => {
    __resetCryptoWarningForTests();
    resetDatabaseWarnings();
  });
  afterEach(clearKey);

  it("registra los 5 campos PII de Employee y el sibling taxIdLookupHash (solo el NIF se hashea)", () => {
    assert.deepEqual([...PII_FIELDS.Employee!], [...EMPLOYEE_PII]);
    assert.deepEqual(LOOKUP_HASH_FIELDS.Employee, { taxId: "taxIdLookupHash" });
  });

  it("al crear cifra NIF, NAF, correo, teléfono e IBAN, calcula taxIdLookupHash y deja nombre, número y puesto en claro", () => {
    setRandomKey();
    resetDatabaseWarnings();
    const args = encryptArgsForModel("Employee", { data: { ...ficticio } }) as { data: Record<string, unknown> };
    for (const field of EMPLOYEE_PII) {
      assert.ok(isCiphertext(args.data[field]), `${field} is encrypted`);
      assert.notEqual(args.data[field], ficticio[field]);
    }
    assert.equal(args.data.taxIdLookupHash, computeLookupHash("12345678Z"));
    assert.match(String(args.data.taxIdLookupHash), /^[0-9a-f]{64}$/);
    for (const field of ["employeeNumber", "firstName", "lastName", "jobTitle", "status"] as const) assert.equal(args.data[field], ficticio[field], `${field} stays plaintext`);
    assert.equal("socialSecurityNumberLookupHash" in args.data, false, "only taxId gets a lookup hash");
    const row = decryptResultForModel("Employee", { id: "emp_1", ...args.data }) as Record<string, unknown>;
    for (const field of EMPLOYEE_PII) assert.equal(row[field], ficticio[field], `${field} round-trips`);
    assert.equal(row.taxIdLookupHash, args.data.taxIdLookupHash, "the hash column is not touched on read");
  });

  it("reescribe where.taxId (normalizado: trim + minúsculas) al hash y no toca el resto del where", () => {
    setRandomKey();
    const next = rewriteWhereForModel("Employee", { where: { legalEntityId: "le_1", taxId: " 12345678z ", employeeNumber: "E-0001" } }) as { where: Record<string, unknown> };
    assert.equal(next.where.taxIdLookupHash, computeLookupHash("12345678Z"));
    assert.equal("taxId" in next.where, false, "the plaintext NIF never reaches SQL");
    assert.deepEqual([next.where.legalEntityId, next.where.employeeNumber], ["le_1", "E-0001"]);
  });

  it("con la clave rotada el expediente devuelve null en los campos PII sin filtrar el envelope y avisa una vez por campo", () => {
    setRandomKey();
    resetDatabaseWarnings();
    const args = encryptArgsForModel("Employee", { data: { ...ficticio } }) as { data: Record<string, unknown> };
    process.env.HOTELOS_FIELD_KEY = randomBytes(32).toString("base64");
    __resetCryptoWarningForTests();
    resetDatabaseWarnings();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      const row = decryptResultForModel("Employee", { id: "emp_1", ...args.data }) as Record<string, unknown>;
      for (const field of EMPLOYEE_PII) assert.equal(row[field], null, `${field} reads as null`);
      assert.ok(!JSON.stringify(row).includes("v1."), "the envelope never leaves the extension");
      assert.equal(row.firstName, "Ficticia");
      assert.equal(warnings.length, EMPLOYEE_PII.length, "one warning per (Employee, field)");
      for (const warning of warnings) {
        assert.match(warning, /Employee\.(taxId|socialSecurityNumber|email|phone|iban)/);
        assert.ok(!warning.includes("v1."), "the warning never carries the envelope");
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});
