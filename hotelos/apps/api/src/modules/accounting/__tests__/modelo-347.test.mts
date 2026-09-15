// Unit tests of the Modelo 347 threshold logic and the 390 aggregation
// (Finanzas · lote «iva-modelos»). No database. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/modelo-347.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { MODELO_347_THRESHOLD, compute347 } from "../modelo-347.service.js";
import { aggregate390 } from "../modelo-390.service.js";
import { compute303 } from "../modelo-303.service.js";
import { ZERO, parseFiscalPeriod, type VatBookRow } from "../vat-books.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);

function row(overrides: Partial<VatBookRow>): VatBookRow {
  const base = overrides.base ?? D("1000");
  const quota = overrides.quota ?? D("100");
  return {
    id: null,
    organizationId: "org_t",
    propertyId: "prop_t",
    book: "emitidas",
    date: "2026-05-10",
    series: "FAC-2026",
    number: "FAC-2026-000001",
    counterpartyNif: "B12345674",
    counterpartyName: "Cliente SL",
    base,
    rate: D("10"),
    quota,
    total: base.plus(quota),
    retention: ZERO,
    taxFigure: "IVA",
    surchargeRate: null,
    surchargeQuota: null,
    sourceType: "invoice",
    sourceId: "inv_1",
    period: "2026-Q2",
    deductible: true,
    ...overrides
  };
}

describe("compute347", () => {
  it("declares only third parties above 3.005,06 € (IVA included) with the quarterly breakdown per clave", () => {
    assert.equal(MODELO_347_THRESHOLD.toString(), "3005.06");
    const rows = [
      row({ sourceId: "a1", base: D("3000"), quota: D("300"), date: "2026-05-10" }), // B = 3300 in T2
      row({ sourceId: "a2", counterpartyNif: "B12345674", base: D("100"), quota: D("10"), date: "2026-11-02" }), // same NIF, T4
      row({ sourceId: "b1", counterpartyNif: "B00000000", base: D("2731.87"), quota: D("273.19"), date: "2026-02-01" }), // 3005.06 exactly → not declared
      row({ sourceId: "s1", book: "recibidas", counterpartyNif: "B99999997", counterpartyName: "Proveedor", base: D("4000"), quota: D("840"), date: "2026-08-15" }), // A = 4840 in T3
      row({ sourceId: "s2", book: "bienes_inversion", counterpartyNif: "B99999997", base: D("100"), quota: D("21"), date: "2026-08-16" })
    ];
    const computation = compute347(rows);
    assert.equal(computation.declarados.length, 2);
    const ventas = computation.declarados.find((declarado) => declarado.clave === "B")!;
    assert.deepEqual([ventas.nif, ventas.importeAnual.toString(), ventas.trimestres.map((quarter) => quarter.toString())], ["B12345674", "3410", ["0", "3300", "0", "110"]]);
    const compras = computation.declarados.find((declarado) => declarado.clave === "A")!;
    assert.deepEqual([compras.nif, compras.nombre, compras.importeAnual.toString(), compras.trimestres[2]!.toString()], ["B99999997", "Proveedor", "4961", "4961"]);
    assert.equal(computation.bajoUmbral, 1);
    assert.equal(computation.totales.importeTotal, 8371);
    assert.ok(computation.avisos.some((aviso) => /1 tercero\(s\) por debajo del umbral/.test(aviso)));
  });

  it("excludes rows without NIF and rows with IRPF retention, reporting them", () => {
    const rows = [
      row({ sourceId: "t1", counterpartyNif: null, sourceType: "simplified", base: D("5000"), quota: D("500") }),
      row({ sourceId: "p1", book: "recibidas", counterpartyNif: "12345678Z", base: D("5000"), quota: D("1050"), retention: D("750") })
    ];
    const computation = compute347(rows);
    assert.equal(computation.declarados.length, 0);
    assert.deepEqual([computation.sinNif.filas, computation.sinNif.importe.toString(), computation.conRetencion.filas, computation.conRetencion.importe.toString()], [1, "5500", 1, "6050"]);
    assert.ok(computation.avisos.some((aviso) => /sin NIF del tercero \(5500.00 €\)/.test(aviso)));
    assert.ok(computation.avisos.some((aviso) => /con retención IRPF \(6050.00 €\)/.test(aviso)));
  });

  it("nets rectificativas and cancellations against the same third party", () => {
    const rows = [row({ sourceId: "a1", base: D("3000"), quota: D("300") }), row({ sourceId: "r1", sourceType: "rectification", base: D("-100"), quota: D("-10") })];
    const computation = compute347(rows);
    assert.equal(computation.declarados.length, 1);
    assert.equal(computation.declarados[0]!.importeAnual.toString(), "3190");
  });
});

describe("aggregate390", () => {
  const settings = { prorrataPct: null, regime: "general" as const, taxFigure: "IVA" as const };

  it("sums the periods by rate, carries the last pending compensation and flags the numbering", () => {
    const q1 = compute303({ rows: [row({ sourceId: "q1", base: D("1000"), quota: D("100") })], settings, compensacionPendiente: ZERO });
    const q2 = compute303({ rows: [row({ sourceId: "q2", base: D("2000"), quota: D("420"), rate: D("21") }), row({ sourceId: "s", book: "recibidas", base: D("500"), quota: D("105"), rate: D("21") })], settings, compensacionPendiente: ZERO });
    const aggregated = aggregate390({ year: 2026, periods: [{ periodo: parseFiscalPeriod("2026-Q1"), computation: q1, liquidado: true }, { periodo: parseFiscalPeriod("2026-Q2"), computation: q2, liquidado: false }], rows: [] });
    const clave = (code: string) => aggregated.casillas.find((box) => box.clave === code)!;
    assert.equal(clave("DEV_BASE_21").importe, 2000);
    assert.equal(clave("DEV_CUOTA_10").importe, 100);
    assert.equal(clave("DEV_TOTAL_CUOTA").importe, 520);
    assert.equal(clave("DED_CUOTA_CORRIENTE").importe, 105);
    assert.equal(clave("RESULTADO_REGIMEN_GENERAL").importe, 415);
    assert.equal(clave("RESULTADO_LIQUIDACIONES").importe, 415);
    assert.equal(clave("VOLUMEN_OPERACIONES").importe, 3000);
    assert.ok(aggregated.casillas.every((box) => box.casilla === null));
    assert.ok(aggregated.avisos.some((aviso) => /numeración de casillas pendiente de validar/.test(aviso)));
    assert.ok(aggregated.avisos.some((aviso) => /1 de 2 periodos del ejercicio 2026 sin asiento de liquidación/.test(aviso)));
    assert.deepEqual([aggregated.totales.periodos, aggregated.totales.periodosLiquidados], [2, 1]);
  });
});
