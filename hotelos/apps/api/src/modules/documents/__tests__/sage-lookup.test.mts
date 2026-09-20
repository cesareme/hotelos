// Unit tests · Tanda T9 · lote T9-06b — consultas SOLO LECTURA sobre Sage (diseño §5.1, §7.1).
// Sin base de datos: un doble en memoria de los dos delegados Prisma registra los
// argumentos (where / select / take) y devuelve filas inventadas. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/sage-lookup.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cifFor } from "./fixtures.js";
import {
  SAGE_FUZZY_DAYS,
  SAGE_LOOKUP_LIMIT,
  aggregateSageReceived,
  findSageReceivedByNifAndNumber,
  findSageReceivedFuzzy,
  findSageSupplierByNif,
  normalizeSageNif,
  normalizeSageNumber,
  type SageDb,
  type SageReceivedRow
} from "../sage-lookup.js";

const ORG = "org_demo";
const NIF = cifFor("B", "7654321");

type Call = Record<string, unknown>;

function fakeDb(thirdParties: Array<Record<string, unknown>>, entries: SageReceivedRow[]) {
  const calls: { thirdParty: Call[]; vat: Call[] } = { thirdParty: [], vat: [] };
  const db = {
    ledgerThirdParty: {
      findMany: async (args: Call) => {
        calls.thirdParty.push(args);
        return thirdParties.slice(0, args.take as number);
      }
    },
    vatBookEntry: {
      findMany: async (args: Call) => {
        calls.vat.push(args);
        return entries.slice(0, args.take as number);
      }
    }
  } as unknown as SageDb;
  return { db, calls };
}

const row = (over: Partial<SageReceivedRow> = {}): SageReceivedRow => ({
  sourceId: "1:2026:F-2026-0042",
  number: "F-2026-0042",
  counterpartyNif: NIF,
  date: new Date("2026-09-10T00:00:00.000Z"),
  base: "170.00",
  quota: "35.70",
  total: "205.70",
  retention: "0.00",
  rate: "21.00",
  ...over
});

describe("normalización", () => {
  it("NIF en mayúsculas sin espacios, guiones ni prefijo ES; número sin separadores", () => {
    assert.equal(normalizeSageNif(` es-${NIF.toLowerCase().slice(0, 4)} ${NIF.slice(4)} `), NIF);
    assert.equal(normalizeSageNif("b 76.543.21x"), "B7654321X");
    assert.equal(normalizeSageNif(""), null);
    assert.equal(normalizeSageNif(null), null);
    assert.equal(normalizeSageNumber(" f/2026-0042 "), "F20260042");
  });
});

describe("findSageSupplierByNif", () => {
  it("where con role supplier, system sage200 y NIF normalizado; take 20; elige la fila con cuenta y lista las cuentas distintas", async () => {
    const { db, calls } = fakeDb(
      [
        { id: "ltp_1", sourceCode: "P001", sourceAccount: null, taxId: NIF, name: "LAVANDERIA DEMO SL", countryCode: "ES", supplierId: null },
        { id: "ltp_2", sourceCode: "P002", sourceAccount: "4100007", taxId: NIF, name: "LAVANDERIA DEMO SL", countryCode: "ES", supplierId: null },
        { id: "ltp_3", sourceCode: "P003", sourceAccount: "4000012", taxId: NIF, name: "LAVANDERIA DEMO SL", countryCode: "ES", supplierId: null },
        { id: "ltp_4", sourceCode: "P004", sourceAccount: "4100007", taxId: NIF, name: "LAVANDERIA DEMO SL", countryCode: "ES", supplierId: null }
      ],
      []
    );
    const found = await findSageSupplierByNif(db, ORG, ` ${NIF.toLowerCase()} `);
    assert.equal(calls.thirdParty.length, 1);
    const args = calls.thirdParty[0]!;
    assert.deepEqual(args.where, { organizationId: ORG, system: "sage200", role: "supplier", taxId: NIF });
    assert.equal(args.take, SAGE_LOOKUP_LIMIT);
    assert.deepEqual(Object.keys(args.select as Record<string, boolean>).sort(), ["countryCode", "id", "name", "sourceAccount", "sourceCode", "supplierId", "taxId"]);
    assert.ok(found);
    assert.equal(found.id, "ltp_2");
    assert.equal(found.sourceAccount, "4100007");
    assert.equal(found.name, "LAVANDERIA DEMO SL");
    assert.deepEqual(found.accounts, ["4000012", "4100007"]);
    assert.equal(found.rowCount, 4);
  });

  it("prefiere la fila ya enlazada a un Supplier; null sin filas; sin NIF no consulta", async () => {
    const linked = fakeDb(
      [
        { id: "ltp_1", sourceCode: "P001", sourceAccount: "4000012", taxId: NIF, name: "X", countryCode: "ES", supplierId: null },
        { id: "ltp_2", sourceCode: "P002", sourceAccount: "4100007", taxId: NIF, name: "X", countryCode: "ES", supplierId: "sup_1" }
      ],
      []
    );
    assert.equal((await findSageSupplierByNif(linked.db, ORG, NIF))?.supplierId, "sup_1");
    const empty = fakeDb([], []);
    assert.equal(await findSageSupplierByNif(empty.db, ORG, NIF), null);
    assert.equal(await findSageSupplierByNif(empty.db, ORG, "  "), null);
    assert.equal(empty.calls.thirdParty.length, 1, "solo la consulta con NIF");
  });
});

describe("findSageReceivedByNifAndNumber", () => {
  it("where con book recibidas, sourceType sage200, NIF y número recortado; take 20; agrega las filas por tipo en un documento", async () => {
    const { db, calls } = fakeDb([], [row({ rate: "21.00", base: "100.00", quota: "21.00", total: "121.00" }), row({ rate: "10.00", base: "50.00", quota: "5.00", total: "55.00" })]);
    const docs = await findSageReceivedByNifAndNumber(db, ORG, NIF, " F-2026-0042 ");
    const args = calls.vat[0]!;
    assert.deepEqual(args.where, { organizationId: ORG, book: "recibidas", sourceType: "sage200", counterpartyNif: NIF, number: "F-2026-0042" });
    assert.equal(args.take, SAGE_LOOKUP_LIMIT);
    assert.deepEqual(docs, [
      { sourceId: "1:2026:F-2026-0042", number: "F-2026-0042", counterpartyNif: NIF, date: "2026-09-10", total: "176.00", base: "150.00", quota: "26.00", retention: "0.00", rates: ["10", "21"], rowCount: 2 }
    ]);
  });

  it("sin NIF o sin número → [] sin consultar", async () => {
    const { db, calls } = fakeDb([], [row()]);
    assert.deepEqual(await findSageReceivedByNifAndNumber(db, ORG, null, "F-1"), []);
    assert.deepEqual(await findSageReceivedByNifAndNumber(db, ORG, NIF, ""), []);
    assert.equal(calls.vat.length, 0);
  });
});

describe("findSageReceivedFuzzy", () => {
  it("ventanas OR: fecha ± 3 días y total ± 0,01; take 20", async () => {
    const { db, calls } = fakeDb([], [row()]);
    await findSageReceivedFuzzy(db, ORG, NIF, "205.70", "2026-09-10");
    const args = calls.vat[0]!;
    const where = args.where as { organizationId: string; book: string; sourceType: string; counterpartyNif: string; OR: Array<Record<string, { gte: unknown; lte: unknown }>> };
    assert.equal(where.book, "recibidas");
    assert.equal(where.sourceType, "sage200");
    assert.equal(where.counterpartyNif, NIF);
    assert.equal(where.OR.length, 2);
    const dateWindow = where.OR[0]!.date!;
    assert.equal((dateWindow.gte as Date).toISOString().slice(0, 10), "2026-09-07");
    assert.equal((dateWindow.lte as Date).toISOString().slice(0, 10), "2026-09-13");
    assert.equal(SAGE_FUZZY_DAYS, 3);
    const totalWindow = where.OR[1]!.total!;
    assert.equal(String(totalWindow.gte), "205.69");
    assert.equal(String(totalWindow.lte), "205.71");
    assert.equal(args.take, SAGE_LOOKUP_LIMIT);
  });

  it("solo una ventana cuando falta el total o la fecha; ninguna → [] sin consultar; nunca más de 20 filas", async () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ sourceId: `1:2026:F-${i}`, number: `F-${i}`, date: new Date(Date.UTC(2026, 8, 1 + (i % 28))) }));
    const { db, calls } = fakeDb([], many);
    const byDate = await findSageReceivedFuzzy(db, ORG, NIF, null, new Date("2026-09-10T15:00:00Z"));
    assert.equal((calls.vat[0]!.where as { OR: unknown[] }).OR.length, 1);
    assert.ok(byDate.length <= SAGE_LOOKUP_LIMIT);
    assert.equal(byDate.length, 20);
    const byTotal = await findSageReceivedFuzzy(db, ORG, NIF, 99.5, null);
    assert.equal((calls.vat[1]!.where as { OR: unknown[] }).OR.length, 1);
    assert.ok(byTotal.length <= SAGE_LOOKUP_LIMIT);
    assert.deepEqual(await findSageReceivedFuzzy(db, ORG, NIF, null, null), []);
    assert.deepEqual(await findSageReceivedFuzzy(db, ORG, "", "10.00", "2026-09-10"), []);
    assert.equal(calls.vat.length, 2);
  });
});

describe("aggregateSageReceived", () => {
  it("suma total / base / cuota / retención por sourceId, fecha mínima, tipos ordenados, documentos por fecha descendente", () => {
    const docs = aggregateSageReceived([
      row({ sourceId: "b", number: "B-1", date: new Date("2026-09-01T00:00:00Z"), total: "10.00", base: "8.26", quota: "1.74" }),
      row({ sourceId: "a", number: "A-1", rate: "4.00", total: "104.00", base: "100.00", quota: "4.00", retention: "15.00" }),
      row({ sourceId: "a", number: null, rate: "21.00", date: new Date("2026-09-09T00:00:00Z"), total: "12.10", base: "10.00", quota: "2.10" })
    ]);
    assert.deepEqual(
      docs.map((d) => [d.sourceId, d.number, d.date, d.total, d.base, d.quota, d.retention, d.rates, d.rowCount]),
      [
        ["a", "A-1", "2026-09-09", "116.10", "110.00", "6.10", "15.00", ["4", "21"], 2],
        ["b", "B-1", "2026-09-01", "10.00", "8.26", "1.74", "0.00", ["21"], 1]
      ]
    );
    assert.deepEqual(aggregateSageReceived([]), []);
  });
});
