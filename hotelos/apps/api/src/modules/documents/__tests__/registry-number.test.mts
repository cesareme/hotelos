// Unit tests · Tanda T9 · lote T9-03 — número de registro del papel
// (registry-number.ts): formato, fallback sin código de centro, año y la
// secuencia bajo pg_advisory_xact_lock con un TransactionClient simulado.
// Sin base de datos real (la parte SQL se cubre en el lote de integración).
//   node --import tsx --test src/modules/documents/__tests__/registry-number.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REGISTRY_NUMBER_RE,
  REGISTRY_SEQ_COLUMN,
  REGISTRY_TABLE,
  REGISTRY_YEAR_COLUMN,
  allocateRegistryNumber,
  formatRegistryNumber,
  isRegistryNumber,
  registryLockKey,
  registryPropertySegment,
  registryYearOf,
  type RegistryTx
} from "../registry-number.js";

describe("formatRegistryNumber", () => {
  it("DOC-<code>-<AAAA>-<nnnnnn> con el código del centro en mayúsculas", () => {
    assert.equal(formatRegistryNumber({ propertyCode: "COR", propertyId: "prop_0123456789abcdef", year: 2026, seq: 1 }), "DOC-COR-2026-000001");
    assert.equal(formatRegistryNumber({ propertyCode: "h-vigo2", propertyId: "prop_x", year: 2027, seq: 123456 }), "DOC-H-VIGO2-2027-123456");
    assert.equal(formatRegistryNumber({ propertyCode: "COR", propertyId: "prop_x", year: 2026, seq: 1_234_567 }), "DOC-COR-2026-1234567", "sin truncar si desborda 6 dígitos");
  });

  it("sin Property.code usa los 4 últimos caracteres del id en mayúsculas (código nulo, vacío o solo espacios)", () => {
    for (const code of [null, undefined, "", "   "]) {
      assert.equal(formatRegistryNumber({ propertyCode: code, propertyId: "prop_0123456789abcdef", year: 2026, seq: 7 }), "DOC-CDEF-2026-000007", String(code));
    }
    assert.equal(registryPropertySegment(null, "prop_00aa"), "00AA");
    assert.equal(registryPropertySegment("Ría 1", "prop_x"), "RA1", "solo [A-Z0-9-]");
  });

  it("valida año y secuencia; el formato resultante cumple la regex pública", () => {
    assert.throws(() => formatRegistryNumber({ propertyCode: "COR", propertyId: "p", year: 26, seq: 1 }), RangeError);
    assert.throws(() => formatRegistryNumber({ propertyCode: "COR", propertyId: "p", year: 2026, seq: 0 }), RangeError);
    assert.throws(() => formatRegistryNumber({ propertyCode: "COR", propertyId: "p", year: 2026, seq: 1.5 }), RangeError);
    assert.equal(isRegistryNumber("DOC-COR-2026-000001"), true);
    assert.equal(isRegistryNumber("DOC-COR-2026-1"), false);
    assert.equal(isRegistryNumber("doc-cor-2026-000001"), false);
    assert.match("DOC-CDEF-2026-000007", REGISTRY_NUMBER_RE);
  });

  it("registryYearOf usa el año UTC del instante y registryLockKey es único por centro y año", () => {
    assert.equal(registryYearOf(new Date("2026-12-31T23:30:00Z")), 2026);
    assert.equal(registryYearOf(new Date("2027-01-01T00:00:00Z")), 2027);
    assert.equal(registryLockKey("prop_a", 2026), "documents.registry:prop_a:2026");
    assert.notEqual(registryLockKey("prop_a", 2026), registryLockKey("prop_a", 2027));
    assert.notEqual(registryLockKey("prop_a", 2026), registryLockKey("prop_b", 2026));
  });
});

type RawCall = { kind: "execute" | "query"; sql: string; values: unknown[] };

function fakeTx(nextSeq: number | bigint | null): { tx: RegistryTx; calls: RawCall[] } {
  const calls: RawCall[] = [];
  const record = (kind: RawCall["kind"], strings: TemplateStringsArray, values: unknown[]) => calls.push({ kind, sql: strings.join("?"), values });
  const tx = {
    $executeRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record("execute", strings, values);
      return 0;
    }) as unknown as RegistryTx["$executeRaw"],
    $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record("query", strings, values);
      return nextSeq === null ? [] : [{ next: nextSeq }];
    }) as unknown as RegistryTx["$queryRaw"]
  };
  return { tx, calls };
}

describe("allocateRegistryNumber (TransactionClient simulado)", () => {
  it("toma el advisory lock por (centro, año) ANTES del MAX+1 y devuelve el número formateado", async () => {
    const { tx, calls } = fakeTx(42n);
    const out = await allocateRegistryNumber(tx, { propertyId: "prop_0123456789abcdef", propertyCode: "COR", year: 2026 });
    assert.deepEqual(out, { registryNumber: "DOC-COR-2026-000042", registryYear: 2026, registrySeq: 42 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.kind, "execute");
    assert.match(calls[0]!.sql, /pg_advisory_xact_lock\(hashtext\(\?\)\)/);
    assert.deepEqual(calls[0]!.values, ["documents.registry:prop_0123456789abcdef:2026"]);
    assert.equal(calls[1]!.kind, "query");
    assert.match(calls[1]!.sql, new RegExp(`MAX\\(${REGISTRY_SEQ_COLUMN}\\)`));
    assert.match(calls[1]!.sql, new RegExp(`FROM\\s+${REGISTRY_TABLE}`));
    assert.match(calls[1]!.sql, new RegExp(`${REGISTRY_YEAR_COLUMN} = \\?`));
    assert.deepEqual(calls[1]!.values, ["prop_0123456789abcdef", 2026]);
  });

  it("primer documento del año → 1; sin código de centro → fallback del id", async () => {
    const { tx } = fakeTx(null);
    const out = await allocateRegistryNumber(tx, { propertyId: "prop_0123456789abcdef", year: 2027 });
    assert.equal(out.registrySeq, 1);
    assert.equal(out.registryNumber, "DOC-CDEF-2027-000001");
  });
});
