// Unit tests · Tanda FIX-1 · lote F2 (+ corrector) — reglas puras de la reclasificación de régimen
// de las filas sage200 de los libros de IVA (vat-books-reclassify.service.ts). Sin base de datos;
// filas INVENTADAS (NIF y razones sociales sintéticos). Desde apps/api:
//   node --import tsx --test src/modules/accounting/__tests__/vat-books-reclassify.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  DUA_MRN_RE,
  EU_VAT_PREFIXES,
  RECLASSIFY_EXAMPLE_IDS,
  SPANISH_NIF_RE,
  VAT_BOOKS_RECLASSIFIED_ACTION,
  isDuaImport,
  isEuVatNif,
  isForeignNif,
  isSpanishNif,
  isZeroRateForeign,
  normalizeCounterpartyName,
  pairAutofacturas,
  planReclassification,
  resolveReclassifyPeriod,
  type ReclassifyCandidate
} from "../vat-books-reclassify.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);
let seq = 0;

function row(input: { book: "emitidas" | "recibidas"; period?: string; date?: string; base: string; rate?: string; quota: string; nif?: string | null; nombre?: string | null; number?: string | null; id?: string }): ReclassifyCandidate {
  seq += 1;
  return {
    id: input.id ?? `${input.book.slice(0, 1)}${seq}`,
    book: input.book,
    period: input.period ?? "2025-Q1",
    date: input.date ?? "2025-02-10",
    series: null,
    number: input.number === undefined ? `N-${seq}` : input.number,
    counterpartyNif: input.nif === undefined ? "B12345674" : input.nif,
    counterpartyName: input.nombre === undefined ? "SOCIEDAD INVENTADA SL" : input.nombre,
    base: D(input.base),
    rate: D(input.rate ?? "21"),
    quota: D(input.quota)
  };
}

describe("NIF español / extranjero / intracomunitario", () => {
  it("DNI, NIE y CIF son españoles (también con prefijo ES); un NIF de otro país no; null no cuenta como extranjero", () => {
    for (const nif of ["12345678Z", "X1234567L", "B12345674", "A23456783", "ESB12345674"]) assert.ok(isSpanishNif(nif) && SPANISH_NIF_RE.test(nif), nif);
    for (const nif of ["DE123456789", "FR12345678901", "PT123456789", "GB123456789", "1234"]) assert.ok(!isSpanishNif(nif) && isForeignNif(nif), nif);
    assert.equal(isForeignNif(null), false);
    assert.equal(isForeignNif(""), false);
    assert.equal(isSpanishNif(null), false);
  });

  it("isEuVatNif: prefijo de país de la UE (DE, PT, XI…) → intracomunitario; CH / GB / CO, sin prefijo, español o null → no", () => {
    assert.ok(EU_VAT_PREFIXES.has("DE") && EU_VAT_PREFIXES.has("EL") && EU_VAT_PREFIXES.has("XI") && !EU_VAT_PREFIXES.has("CH") && !EU_VAT_PREFIXES.has("GB"));
    for (const nif of ["DE123456789", "PT123456789", "PT 123 456 789", "NL123456789B01", "XI123456789", "fr12345678901"]) assert.ok(isEuVatNif(nif), nif);
    for (const nif of ["CHE123456789", "GB123456789", "CO9001234567", "1234", "B12345674", "ESB12345674", null, ""]) assert.equal(isEuVatNif(nif), false, String(nif));
  });

  it("normalizeCounterpartyName: mayúsculas sin diacríticos, solo letras y dígitos con un espacio; vacío → null", () => {
    assert.equal(normalizeCounterpartyName("  Lieferant  Nörd, GmbH. "), "LIEFERANT NORD GMBH");
    assert.equal(normalizeCounterpartyName("SWISS-TOOLS AG"), "SWISS TOOLS AG");
    assert.equal(normalizeCounterpartyName("   "), null);
    assert.equal(normalizeCounterpartyName(null), null);
  });
});

describe("reglas 1 y 4 · pairAutofacturas", () => {
  it("empareja 1:1 una emitida sin NIF con la recibida del mismo periodo, nombre, base y cuota cuyo NIF es extranjero; UE → aib, resto → isp; una recibida solo se usa una vez", () => {
    const e1 = row({ book: "emitidas", nif: null, nombre: "Lieferant Nord GmbH", base: "500.00", quota: "105.00", date: "2025-02-10", id: "e1" });
    const e2 = row({ book: "emitidas", nif: null, nombre: "LIEFERANT NORD GMBH", base: "500.00", quota: "105.00", date: "2025-02-12", id: "e2" });
    const e3 = row({ book: "emitidas", nif: null, nombre: "LIEFERANT NORD GMBH", base: "500.00", quota: "105.00", date: "2025-02-14", id: "e3" });
    const r1 = row({ book: "recibidas", nif: "DE123456789", nombre: "LIEFERANT NORD GMBH", base: "500.00", quota: "105.00", date: "2025-02-09", id: "r1" });
    const r2 = row({ book: "recibidas", nif: "CHE123456789", nombre: "Lieferant Nord, GmbH", base: "500.00", quota: "105.00", date: "2025-02-11", id: "r2" });
    const { pairs, unpaired } = pairAutofacturas([e3, e1, e2], [r2, r1]);
    assert.deepEqual(pairs.map((pair) => [pair.emitida.id, pair.recibida.id, pair.regimen]), [["e1", "r1", "aib"], ["e2", "r2", "isp"]], "orden estable por fecha; r1 (DE) es AIB y r2 (CH) es ISP");
    assert.deepEqual(unpaired.map((entry) => entry.id), ["e3"], "la tercera autofactura queda sin pareja");
  });

  it("no empareja con una recibida de NIF español o SIN NIF, ni con otro nombre, ni fuera del periodo, ni con base/cuota distintas al céntimo, ni una emitida con NIF, con cuota 0 o sin nombre", () => {
    const emitida = row({ book: "emitidas", nif: null, nombre: "SWISS TOOLS AG", base: "500.00", quota: "105.00", id: "e1" });
    const spanish = row({ book: "recibidas", nif: "B12345674", nombre: "SWISS TOOLS AG", base: "500.00", quota: "105.00", id: "r-es" });
    const noNif = row({ book: "recibidas", nif: null, nombre: "SWISS TOOLS AG", base: "500.00", quota: "105.00", id: "r-sin-nif" });
    const otherName = row({ book: "recibidas", nif: "CHE123456789", nombre: "OTRA SOCIEDAD AG", base: "500.00", quota: "105.00", id: "r-nombre" });
    const otherPeriod = row({ book: "recibidas", nif: "CHE123456789", nombre: "SWISS TOOLS AG", base: "500.00", quota: "105.00", period: "2025-Q2", id: "r-q2" });
    const cent = row({ book: "recibidas", nif: "CHE123456789", nombre: "SWISS TOOLS AG", base: "500.00", quota: "105.01", id: "r-cent" });
    const result = pairAutofacturas([emitida], [spanish, noNif, otherName, otherPeriod, cent]);
    assert.deepEqual(result.pairs, [], "una recibida sin NIF ya no es pareja de nada (antes emparejaba por importe)");
    assert.deepEqual(result.unpaired.map((entry) => entry.id), ["e1"]);
    const withNif = row({ book: "emitidas", nif: "B12345674", nombre: "SWISS TOOLS AG", base: "500.00", quota: "105.00", id: "e-nif" });
    const zero = row({ book: "emitidas", nif: null, nombre: "SWISS TOOLS AG", base: "0.00", rate: "0", quota: "0.00", id: "e-0" });
    const nameless = row({ book: "emitidas", nif: null, nombre: "", base: "500.00", quota: "105.00", id: "e-sin-nombre" });
    const match = row({ book: "recibidas", nif: "CHE123456789", nombre: "SWISS TOOLS AG", base: "500.00", quota: "105.00", id: "r-ok" });
    const zeroMatch = row({ book: "recibidas", nif: "CHE123456789", nombre: "SWISS TOOLS AG", base: "0.00", rate: "0", quota: "0.00", id: "r-0" });
    const negative = pairAutofacturas([withNif, zero, nameless], [match, zeroMatch]);
    assert.deepEqual(negative.pairs, [], "una emitida con NIF no es autofactura; con cuota 0 o sin nombre no se empareja");
    assert.deepEqual(negative.unpaired.map((entry) => entry.id), ["e-0", "e-sin-nombre"], "solo las emitidas sin NIF cuentan como «sin pareja»");
  });

  it("una venta a un particular con la misma base y cuota que una recibida extranjera NO se empareja (el nombre decide)", () => {
    const particular = row({ book: "emitidas", nif: null, nombre: "CLIENTE PARTICULAR", base: "300.00", quota: "63.00", id: "e-part" });
    const autofactura = row({ book: "emitidas", nif: null, nombre: "HOLLAND SUPPLIES BV", base: "300.00", quota: "63.00", date: "2025-02-20", id: "e-auto" });
    const recibida = row({ book: "recibidas", nif: "NL123456789B01", nombre: "HOLLAND SUPPLIES BV", base: "300.00", quota: "63.00", id: "r-nl" });
    const result = pairAutofacturas([particular, autofactura], [recibida]);
    assert.deepEqual(result.pairs.map((pair) => [pair.emitida.id, pair.recibida.id, pair.regimen]), [["e-auto", "r-nl", "aib"]]);
    assert.deepEqual(result.unpaired.map((entry) => entry.id), ["e-part"]);
  });
});

describe("regla 2 · isDuaImport", () => {
  it("recibida sin NIF con MRN de DUA (AAESXXXXXXXXXXXXXX) o con ≥ 14 dígitos → importación; con NIF o número corto, no", () => {
    assert.ok(DUA_MRN_RE.test("25ES00111122223333"));
    assert.ok(isDuaImport(row({ book: "recibidas", nif: null, number: "25ES00111122223333", base: "1", quota: "0.21" })));
    assert.ok(isDuaImport(row({ book: "recibidas", nif: null, number: "25 ES 0011 1122 2233 33", base: "1", quota: "0.21" })), "espacios y guiones se ignoran");
    assert.ok(isDuaImport(row({ book: "recibidas", nif: null, number: "DUA-2025-00123456789012", base: "1", quota: "0.21" })), "≥ 14 dígitos");
    assert.equal(isDuaImport(row({ book: "recibidas", nif: null, number: "F-2025-1234", base: "1", quota: "0.21" })), false);
    assert.equal(isDuaImport(row({ book: "recibidas", nif: null, number: null, base: "1", quota: "0.21" })), false);
    assert.equal(isDuaImport(row({ book: "recibidas", nif: "B12345674", number: "25ES00111122223333", base: "1", quota: "0.21" })), false, "con NIF no es DUA");
    assert.equal(isDuaImport(row({ book: "emitidas", nif: null, number: "25ES00111122223333", base: "1", quota: "0.21" })), false, "solo recibidas");
  });
});

describe("regla 3 · isZeroRateForeign", () => {
  it("emitida al 0 % con NIF extranjero; no con NIF español (ni con prefijo ES), ni sin NIF, ni con tipo > 0", () => {
    assert.ok(isZeroRateForeign(row({ book: "emitidas", nif: "FR12345678901", rate: "0", base: "656000.00", quota: "0.00" })));
    assert.equal(isZeroRateForeign(row({ book: "emitidas", nif: "B12345674", rate: "0", base: "10.00", quota: "0.00" })), false);
    assert.equal(isZeroRateForeign(row({ book: "emitidas", nif: "ESB12345674", rate: "0", base: "10.00", quota: "0.00" })), false);
    assert.equal(isZeroRateForeign(row({ book: "emitidas", nif: null, rate: "0", base: "10.00", quota: "0.00" })), false);
    assert.equal(isZeroRateForeign(row({ book: "emitidas", nif: "FR12345678901", rate: "21", base: "100.00", quota: "21.00" })), false);
    assert.equal(isZeroRateForeign(row({ book: "recibidas", nif: "FR12345678901", rate: "0", base: "100.00", quota: "0.00" })), false);
  });
});

describe("planReclassification (dry-run)", () => {
  function scenario(): ReclassifyCandidate[] {
    return [
      // 2 parejas AIB (Q1 y Q2), 1 pareja ISP (Q1, proveedor suizo) y una autofactura huérfana.
      row({ book: "emitidas", nif: null, nombre: "LIEFERANT NORD GMBH", base: "500.00", quota: "105.00", period: "2025-Q1", date: "2025-01-10", id: "e-a" }),
      row({ book: "recibidas", nif: "DE123456789", nombre: "LIEFERANT NORD GMBH", base: "500.00", quota: "105.00", period: "2025-Q1", date: "2025-01-09", id: "r-a" }),
      row({ book: "emitidas", nif: null, nombre: "SWISS TOOLS AG", base: "200.00", quota: "42.00", period: "2025-Q1", date: "2025-02-10", id: "e-b" }),
      row({ book: "recibidas", nif: "CHE123456789", nombre: "SWISS TOOLS AG", base: "200.00", quota: "42.00", period: "2025-Q1", date: "2025-02-09", id: "r-b" }),
      row({ book: "emitidas", nif: null, nombre: "FORNECEDOR LISBOA LDA", base: "1000.00", quota: "210.00", period: "2025-Q2", date: "2025-05-10", id: "e-c" }),
      row({ book: "recibidas", nif: "PT123456789", nombre: "FORNECEDOR LISBOA LDA", base: "1000.00", quota: "210.00", period: "2025-Q2", date: "2025-05-10", id: "r-c" }),
      row({ book: "emitidas", nif: null, nombre: "PARTICULAR SIN PAREJA", base: "60.00", quota: "12.60", period: "2025-Q2", date: "2025-06-01", id: "e-huerfana" }),
      // Mismo importe que una recibida extranjera pero otro nombre (venta a particular): sin pareja; la recibida queda tal cual.
      row({ book: "recibidas", nif: "NL123456789B01", nombre: "HOLLAND SUPPLIES BV", base: "300.00", quota: "63.00", period: "2025-Q1", date: "2025-03-03", id: "r-x" }),
      row({ book: "emitidas", nif: null, nombre: "OTRO CLIENTE", base: "300.00", quota: "63.00", period: "2025-Q1", date: "2025-03-04", id: "e-y" }),
      // Recibida SIN NIF con nombre e importe iguales: no es pareja (regla exige NIF extranjero); queda sin clasificar.
      row({ book: "emitidas", nif: null, nombre: "NO NIF SUPPLIER", base: "40.00", quota: "8.40", period: "2025-Q1", date: "2025-03-05", id: "e-z" }),
      row({ book: "recibidas", nif: null, nombre: "NO NIF SUPPLIER", base: "40.00", quota: "8.40", period: "2025-Q1", date: "2025-03-05", id: "r-z" }),
      // DUA sin NIF (regla 2) y un ticket sin NIF que ninguna regla clasifica.
      row({ book: "recibidas", nif: null, nombre: "ADUANA", number: "25ES00111122223333", base: "3000.00", quota: "630.00", period: "2025-Q1", date: "2025-03-01", id: "r-dua" }),
      row({ book: "recibidas", nif: null, nombre: null, number: "T-12", base: "10.00", quota: "2.10", period: "2025-Q1", date: "2025-03-02", id: "r-ticket" }),
      // Ventas al 0 % con NIF extranjero (regla 3) y una venta interior normal.
      row({ book: "emitidas", nif: "FR12345678901", nombre: "AGENCE PARIS SARL", rate: "0", base: "656000.00", quota: "0.00", period: "2026-Q1", date: "2026-01-15", id: "e-ar2" }),
      row({ book: "emitidas", nif: "B12345674", base: "100.00", quota: "21.00", period: "2025-Q1", date: "2025-01-20", id: "e-int" })
    ];
  }

  it("sin includeZeroRate: reglas 1 (aib), 4 (isp) y 2 con recuentos de las dos caras por periodo, ids de ejemplo, sin pareja y recibidas sin clasificar; la regla 3 a 0", () => {
    const plan = planReclassification({ rows: scenario(), includeZeroRate: false });
    assert.deepEqual(plan.reglas.map((regla) => regla.regla), [1, 2, 3, 4], "orden fijo de las reglas");
    const [r1, r2, r3, r4] = plan.reglas;
    assert.deepEqual([r1!.regimen, r1!.filas, r1!.filasEmitidas, r1!.filasRecibidas, r1!.parejas, r1!.base, r1!.cuota], ["aib", 4, 2, 2, 2, 1500, 315]);
    assert.deepEqual(r1!.porPeriodo, [
      { periodo: "2025-Q1", filas: 2, base: 500, cuota: 105 },
      { periodo: "2025-Q2", filas: 2, base: 1000, cuota: 210 }
    ]);
    assert.equal(r1!.porPeriodo.reduce((sum, bucket) => sum + bucket.filas, 0), r1!.filas, "porPeriodo suma las dos caras (F2-RULE-DTO-COUNTS)");
    assert.deepEqual(r1!.ids, ["e-a", "e-c"]);
    assert.deepEqual([r4!.regimen, r4!.filas, r4!.filasEmitidas, r4!.filasRecibidas, r4!.parejas, r4!.base, r4!.cuota, r4!.ids], ["isp", 2, 1, 1, 1, 200, 42, ["e-b"]]);
    assert.deepEqual(r4!.porPeriodo, [{ periodo: "2025-Q1", filas: 2, base: 200, cuota: 42 }]);
    assert.deepEqual([r2!.regla, r2!.regimen, r2!.filas, r2!.filasEmitidas, r2!.filasRecibidas, r2!.base, r2!.cuota, r2!.ids], [2, "importacion", 1, 0, 1, 3000, 630, ["r-dua"]]);
    assert.deepEqual([r3!.regla, r3!.regimen, r3!.filas, r3!.base, r3!.ids], [3, "exento_no_sujeto", 0, 0, []]);
    assert.match(r3!.descripcion, /NO aplicada/);
    assert.deepEqual(plan.sinPareja, { filas: 3, cuota: 84 }, "e-huerfana + e-y (otro nombre) + e-z (recibida sin NIF)");
    assert.deepEqual(plan.recibidasSinNifNoClasificadas, { filas: 2, cuota: 10.5 }, "r-ticket + r-z");
    assert.deepEqual(plan.updates.get("aib"), ["e-a", "e-c", "r-a", "r-c"], "las dos caras de las parejas intracomunitarias");
    assert.deepEqual(plan.updates.get("isp"), ["e-b", "r-b"], "las dos caras de la pareja ISP (la recibida ya no va a aib)");
    assert.deepEqual(plan.updates.get("importacion"), ["r-dua"]);
    assert.deepEqual(plan.updates.get("exento_no_sujeto"), []);
  });

  it("con includeZeroRate la regla 3 clasifica las ventas al 0 % con NIF extranjero; nunca las interiores ni las sin NIF; ≤ 5 ids de ejemplo", () => {
    const plan = planReclassification({ rows: scenario(), includeZeroRate: true });
    const r3 = plan.reglas[2]!;
    assert.deepEqual([r3.filas, r3.filasEmitidas, r3.filasRecibidas, r3.base, r3.cuota, r3.ids, r3.porPeriodo], [1, 1, 0, 656000, 0, ["e-ar2"], [{ periodo: "2026-Q1", filas: 1, base: 656000, cuota: 0 }]]);
    assert.deepEqual(plan.updates.get("exento_no_sujeto"), ["e-ar2"]);
    const many = Array.from({ length: 8 }, (_, index) => row({ book: "emitidas", nif: "FR12345678901", rate: "0", base: "1.00", quota: "0.00", id: `z${index}` }));
    assert.equal(planReclassification({ rows: many, includeZeroRate: true }).reglas[2]!.ids.length, RECLASSIFY_EXAMPLE_IDS);
    assert.equal(planReclassification({ rows: many, includeZeroRate: true }).reglas[2]!.filas, 8);
  });

  it("una recibida emparejada por las reglas 1 / 4 no se vuelve a clasificar por la regla 2 (y una DUA sin NIF nunca empareja)", () => {
    const rows = [
      row({ book: "emitidas", nif: null, nombre: "ADUANA", base: "100.00", quota: "21.00", id: "e" }),
      row({ book: "recibidas", nif: null, nombre: "ADUANA", number: "25ES00111122223333", base: "100.00", quota: "21.00", id: "r" })
    ];
    const plan = planReclassification({ rows, includeZeroRate: false });
    assert.deepEqual([plan.reglas[0]!.parejas, plan.reglas[3]!.parejas, plan.reglas[1]!.filas], [0, 0, 1], "sin NIF no hay pareja: la fila es un DUA");
    const paired = [
      row({ book: "emitidas", nif: null, nombre: "US VENDOR INC", base: "100.00", quota: "21.00", id: "e2" }),
      row({ book: "recibidas", nif: "US12345678901234", nombre: "US VENDOR INC", number: "25ES00111122223333", base: "100.00", quota: "21.00", id: "r2" })
    ];
    const plan2 = planReclassification({ rows: paired, includeZeroRate: false });
    assert.deepEqual([plan2.reglas[3]!.parejas, plan2.reglas[1]!.filas], [1, 0], "emparejada (ISP, NIF no UE) → no pasa por la regla 2");
  });
});

describe("resolveReclassifyPeriod", () => {
  it("admite el ejercicio («2025»), el trimestre y el mes; from/to naturales; el resto es 400 INVALID_PERIOD", () => {
    assert.deepEqual([resolveReclassifyPeriod({ period: "2025" }).from, resolveReclassifyPeriod({ period: "2025" }).to, resolveReclassifyPeriod({ period: "2025" }).type], ["2025-01-01", "2025-12-31", "annual"]);
    assert.equal(resolveReclassifyPeriod({ period: "2025-Q3" }).code, "2025-Q3");
    assert.equal(resolveReclassifyPeriod({ period: "2025-09" }).code, "2025-09");
    assert.equal(resolveReclassifyPeriod({ from: "2025-01-01", to: "2025-12-31" }).code, "2025");
    assert.throws(() => resolveReclassifyPeriod({}), /period es obligatorio/);
    assert.throws(() => resolveReclassifyPeriod({ from: "2025-01-05", to: "2025-02-03" }), /natural completo/);
    assert.throws(() => resolveReclassifyPeriod({ from: "2025-01-01" }), /from y to/);
    assert.equal(VAT_BOOKS_RECLASSIFIED_ACTION, "VAT_BOOKS_RECLASSIFIED");
  });
});
