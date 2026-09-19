// Estructura societaria · L5 · régimen del sujeto pasivo (design §5.2 R8) and
// the whole-sociedad read scope (R11). No database: pure helpers of
// vat-books.service.ts, modelo-303/390.service.ts and ledger.routes.ts.
// Run from apps/api:
//   node --import tsx --test src/modules/accounting/__tests__/fiscal-regime.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import type { LegalIdentityDto } from "@hotelos/shared";
import { ENTITY_READ_PERMISSION, assertFinanceReadScope, assertFinanceReadScopeMany, assertFinanceWriteScope, hasEntityReadScope } from "../ledger.routes.js";
import { compute303, resolveSettlementPeriod } from "../modelo-303.service.js";
import { aggregate390, proposeRegime, type Modelo390PeriodResult } from "../modelo-390.service.js";
import { LARGE_COMPANY_THRESHOLD, VERIFACTU_EXCLUDED_BY_SII_MOTIVO, ZERO, declaranteBadge, declarantePair, parseFiscalPeriod, regimeAvisos, resolveFiscalRegime, siiModelNotFiledMotivo, type VatBookRow } from "../vat-books.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);

function identity(overrides: Partial<LegalIdentityDto> = {}): LegalIdentityDto {
  return {
    legalEntityId: "le_far",
    organizationId: "org_far",
    code: "FAR",
    legalName: "Faranda Hotels & Resorts",
    taxId: "B99999997",
    taxIdValid: true,
    source: "legal_entity",
    legalForm: "sa",
    fiscalAddress: null,
    fiscalPostalCode: null,
    fiscalMunicipality: null,
    fiscalIneCode: null,
    fiscalProvince: null,
    pgcVariant: "pymes",
    largeCompany: false,
    siiEnabled: false,
    verifactuChainScope: "per_center",
    cccPrincipal: null,
    ...overrides
  };
}

describe("resolveFiscalRegime (R8: una sola fuente)", () => {
  it("régimen general: la periodicidad guardada manda, se presentan 347/390 y VeriFactu aplica", () => {
    const regimen = resolveFiscalRegime(identity(), "quarterly");
    assert.deepEqual(regimen, {
      siiEnabled: false,
      largeCompany: false,
      periodicity: "quarterly",
      persistedPeriodicity: "quarterly",
      periodicityForcedBy: null,
      modelosNoPresentados: [],
      verifactu: { aplica: true, motivo: null }
    });
    assert.deepEqual(regimeAvisos(regimen, "303"), []);
  });

  it("gran empresa sin SII: mensual forzado, 347/390 se presentan, VeriFactu aplica", () => {
    const regimen = resolveFiscalRegime(identity({ largeCompany: true }), "quarterly");
    assert.equal(regimen.periodicity, "monthly");
    assert.equal(regimen.periodicityForcedBy, "large_company");
    assert.deepEqual(regimen.modelosNoPresentados, []);
    assert.equal(regimen.verifactu.aplica, true);
    const avisos = regimeAvisos(regimen, "111");
    assert.equal(avisos.length, 1);
    assert.match(avisos[0]!, /gran empresa.*Modelo 111.*mensualmente.*RIVA art\. 71\.3/);
    // Annual models never carry the periodicity warning.
    assert.deepEqual(regimeAvisos(regimen, "390"), []);
  });

  it("SII: mensual, 347 y 390 «no se presenta», VeriFactu desactivado con motivo (RD 1007/2023 art. 3.3)", () => {
    const regimen = resolveFiscalRegime(identity({ siiEnabled: true, largeCompany: true }), "monthly");
    assert.equal(regimen.periodicity, "monthly");
    assert.equal(regimen.periodicityForcedBy, "sii");
    assert.deepEqual(regimen.modelosNoPresentados, ["347", "390"]);
    assert.deepEqual(regimen.verifactu, { aplica: false, motivo: VERIFACTU_EXCLUDED_BY_SII_MOTIVO });
    assert.match(VERIFACTU_EXCLUDED_BY_SII_MOTIVO, /RD 1007\/2023 art\. 3\.3/);
    // Stored periodicity already monthly → no «forced» warning, but the SII notice is present on every model.
    const avisos = regimeAvisos(regimen, "303");
    assert.equal(avisos.length, 1);
    assert.match(avisos[0]!, /347 y 390 no se presentan y VeriFactu no aplica/);
    assert.match(siiModelNotFiledMotivo("347"), /Modelo 347 no se presenta/);
    assert.match(siiModelNotFiledMotivo("390"), /RIVA art\. 71\.1/);
  });

  it("declaranteBadge carries the legal entity and the regime; declarantePair is the legacy (nif · nombre)", () => {
    const badge = declaranteBadge(identity({ siiEnabled: true }), "quarterly");
    assert.deepEqual([badge.legalEntityId, badge.code, badge.legalName, badge.taxId, badge.taxIdValid, badge.source], ["le_far", "FAR", "Faranda Hotels & Resorts", "B99999997", true, "legal_entity"]);
    assert.equal(badge.regimen.periodicity, "monthly");
    assert.deepEqual(declarantePair(badge), { nif: "B99999997", nombre: "Faranda Hotels & Resorts" });
    const pending = declaranteBadge(identity({ legalEntityId: null, code: null, taxId: null, taxIdValid: false, source: "organization_fallback" }), "quarterly");
    assert.deepEqual(declarantePair(pending), { nif: null, nombre: "Faranda Hotels & Resorts" });
    assert.equal(pending.source, "organization_fallback");
  });
});

describe("resolveSettlementPeriod with a forced monthly regime", () => {
  it("names the regime in the 400 PERIOD_MISMATCH and carries forcedBy in details", () => {
    const regimen = resolveFiscalRegime(identity({ siiEnabled: true }), "quarterly");
    assert.throws(
      () => resolveSettlementPeriod({ period: "2026-Q2" }, "monthly", regimen),
      (error: unknown) => {
        const e = error as { statusCode?: number; message: string; details?: { code?: string; forcedBy?: string } };
        assert.equal(e.statusCode, 400);
        assert.equal(e.details?.code, "PERIOD_MISMATCH");
        assert.equal(e.details?.forcedBy, "sii");
        assert.match(e.message, /sociedad acogida al SII, RIVA art\. 71\.3/);
        return true;
      }
    );
    assert.equal(resolveSettlementPeriod({ period: "2026-05" }, "monthly", regimen).code, "2026-05");
    // REDEME (no regime) keeps its own wording.
    assert.throws(() => resolveSettlementPeriod({ period: "2026-Q2" }, "monthly"), /mensualmente \(REDEME\)/);
  });
});

describe("proposeRegime (RIVA art. 71.3, propuesta al cierre del ejercicio)", () => {
  const general = { regimen: resolveFiscalRegime(identity(), "quarterly") };
  const large = { regimen: resolveFiscalRegime(identity({ largeCompany: true, siiEnabled: true }), "monthly") };

  it("the threshold is 6.010.121,04 € and empty books propose nothing", () => {
    assert.equal(LARGE_COMPANY_THRESHOLD.toFixed(2), "6010121.04");
    const proposal = proposeRegime({ year: 2026, volumen: null, sociedad: general });
    assert.deepEqual([proposal.regimen, proposal.cambia], ["general", false]);
    assert.match(proposal.motivo, /Sin operaciones registradas en 2026/);
  });

  it("volumen above the threshold in régimen general → propose gran empresa from the following year (never writes)", () => {
    const proposal = proposeRegime({ year: 2026, volumen: D("6010121.05"), sociedad: general });
    assert.deepEqual([proposal.regimen, proposal.cambia], ["gran_empresa", true]);
    assert.match(proposal.motivo, /1 de enero de 2027/);
    assert.match(proposal.motivo, /SII obligatorio/);
    assert.match(proposal.motivo, /VeriFactu no aplica/);
    assert.match(proposal.motivo, /Estructura societaria › Datos fiscales/);
    // Exactly the threshold does not exceed it.
    assert.equal(proposeRegime({ year: 2026, volumen: LARGE_COMPANY_THRESHOLD, sociedad: general }).cambia, false);
  });

  it("volumen below the threshold in gran empresa → propose reviewing the return to régimen general; above → no change", () => {
    const back = proposeRegime({ year: 2026, volumen: D("74.94"), sociedad: large });
    assert.deepEqual([back.regimen, back.cambia], ["general", true]);
    assert.match(back.motivo, /revisar con la gestoría/);
    const stay = proposeRegime({ year: 2026, volumen: D("9000000.00"), sociedad: large });
    assert.deepEqual([stay.regimen, stay.cambia], ["gran_empresa", false]);
    assert.match(stay.motivo, /ya tributa como gran empresa \(mensual, SII\)/);
    const small = proposeRegime({ year: 2026, volumen: D("2595.00"), sociedad: general });
    assert.deepEqual([small.regimen, small.cambia], ["general", false]);
    // es-ES (CLDR) does not group four-digit numbers: 2595,00.
    assert.match(small.motivo, /2595,00 € ≤ 6\.010\.121,04 €/);
  });
});

describe("assertFinanceReadScope (R11: lecturas por sociedad)", () => {
  const permissions = ["accounting.read", "accounting.reports.read"] as never[];
  const director = { permissions, assignedPropertyIds: ["prop_lt"] };
  const directora = { permissions: [...permissions, ENTITY_READ_PERMISSION] as never[], assignedPropertyIds: ["prop_lt"] };
  // Tanda 8a (RBAC · §6.2): the organisation-wide scope is EXPLICIT (a live
  // organization / legal_entity assignment → `orgScope: true`); a real session
  // with an empty assignment list reaches nothing (fail-secure, H1/H2).
  const orgWide = { permissions, assignedPropertyIds: [] as string[], orgScope: true };
  const unassigned = { permissions, assignedPropertyIds: [] as string[] };
  const platform = { permissions, assignedPropertyIds: ["prop_x"], isPlatformAdmin: true };

  it("hasEntityReadScope: permission, platform admin or an EXPLICIT organisation scope open the whole sociedad; an empty assignment list does not", () => {
    assert.equal(ENTITY_READ_PERMISSION, "accounting.entity.read");
    assert.equal(hasEntityReadScope(director), false);
    assert.equal(hasEntityReadScope(directora), true);
    assert.equal(hasEntityReadScope(orgWide), true);
    assert.equal(hasEntityReadScope(unassigned), false, "no assignments = nothing (Tanda 8a)");
    assert.equal(hasEntityReadScope({ permissions }), true, "a context assembled without a list keeps the organisation");
    assert.equal(hasEntityReadScope(platform), true);
  });

  it("a director of LT: 404 opaco without propertyId (ENTITY_SCOPE_REQUIRED) and with RA; passes with LT", () => {
    assert.throws(
      () => assertFinanceReadScope(director, null),
      (error: unknown) => {
        const e = error as { statusCode?: number; message: string; details?: { code?: string } };
        assert.equal(e.statusCode, 404);
        assert.equal(e.details?.code, "ENTITY_SCOPE_REQUIRED");
        assert.doesNotMatch(e.message, /prop_/, "never echoes a property id");
        return true;
      }
    );
    assert.throws(() => assertFinanceReadScope(director, "prop_ra"), (error: unknown) => (error as { statusCode?: number; message: string }).statusCode === 404 && (error as Error).message === "Propiedad no encontrada.");
    assert.doesNotThrow(() => assertFinanceReadScope(director, "prop_lt"));
  });

  it("the directora with accounting.entity.read, an organization-wide context and a platform admin read everything", () => {
    for (const context of [directora, orgWide, platform]) {
      assert.doesNotThrow(() => assertFinanceReadScope(context, null));
      assert.doesNotThrow(() => assertFinanceReadScope(context, "prop_lt"));
    }
    // A centre outside the assignments stays a 404 even with the entity key (the property hook rule is not widened)…
    assert.throws(() => assertFinanceReadScope(directora, "prop_ra"), /Propiedad no encontrada/);
    // …except for platform admins, who act in any centre.
    assert.doesNotThrow(() => assertFinanceReadScope(platform, "prop_ra"));
  });

  it("assertFinanceWriteScope (t6b#5, R4 + R11): a society-level asiento (no centre) needs the whole-sociedad scope; a centre's asiento, that centre", () => {
    const denied = (error: unknown): boolean => {
      const e = error as { statusCode?: number; details?: { code?: string; requiredPermission?: string }; message: string };
      return e.statusCode === 404 && e.details?.code === "ENTITY_SCOPE_REQUIRED" && e.details.requiredPermission === ENTITY_READ_PERMISSION && !/prop_/.test(e.message);
    };
    assert.throws(() => assertFinanceWriteScope(director, null), denied);
    assert.throws(() => assertFinanceWriteScope(director, undefined), denied);
    assert.throws(() => assertFinanceWriteScope(director, "prop_ra"), /Propiedad no encontrada/);
    assert.doesNotThrow(() => assertFinanceWriteScope(director, "prop_lt"));
    for (const context of [directora, orgWide, platform]) assert.doesNotThrow(() => assertFinanceWriteScope(context, null));
  });

  it("assertFinanceReadScopeMany: every centre within scope, or the whole sociedad when none is named", () => {
    assert.doesNotThrow(() => assertFinanceReadScopeMany(director, ["prop_lt"]));
    assert.throws(() => assertFinanceReadScopeMany(director, ["prop_lt", "prop_ra"]), /Propiedad no encontrada/);
    assert.throws(() => assertFinanceReadScopeMany(director, null), /Ámbito no disponible/);
    assert.doesNotThrow(() => assertFinanceReadScopeMany(directora, null));
  });
});

describe("aggregate390 · volumen de operaciones sin autofacturas ISP/AIB (FIX-1 · F2, B-1)", () => {
  const SETTINGS = { prorrataPct: null, regime: "general" as const, taxFigure: "IVA" as const };
  function row(input: { book: VatBookRow["book"]; date: string; base: string; rate: string; quota: string; regime?: VatBookRow["regime"]; nif?: string | null; sourceId: string }): VatBookRow {
    return {
      id: null,
      organizationId: "org_t",
      propertyId: null,
      book: input.book,
      date: input.date,
      series: null,
      number: input.sourceId,
      counterpartyNif: input.nif === undefined ? "B12345674" : input.nif,
      counterpartyName: null,
      base: D(input.base),
      rate: D(input.rate),
      quota: D(input.quota),
      total: D(input.base).plus(D(input.quota)),
      retention: ZERO,
      taxFigure: "IVA",
      surchargeRate: null,
      surchargeQuota: null,
      sourceType: "sage200",
      sourceId: input.sourceId,
      period: `${input.date.slice(0, 4)}-Q${Math.floor((Number(input.date.slice(5, 7)) - 1) / 3) + 1}`,
      deductible: true,
      regime: input.regime ?? null
    };
  }
  /** Ventas interiores 5.565.127,31 + autofacturas ISP 400.000,00 y AIB 186.855,53 (= 586.855,53) → libros 6.151.982,84 (el volumen del informe). */
  function yearRows(): VatBookRow[] {
    return [
      row({ book: "emitidas", date: "2025-02-10", base: "5000000.00", rate: "21", quota: "1050000.00", sourceId: "e1" }),
      row({ book: "emitidas", date: "2025-05-10", base: "565127.31", rate: "10", quota: "56512.73", sourceId: "e2" }),
      row({ book: "emitidas", date: "2025-08-10", base: "400000.00", rate: "21", quota: "84000.00", regime: "isp", nif: null, sourceId: "auto-isp" }),
      row({ book: "emitidas", date: "2025-08-11", base: "186855.53", rate: "21", quota: "39239.66", regime: "aib", nif: null, sourceId: "auto-aib" }),
      row({ book: "recibidas", date: "2025-08-10", base: "400000.00", rate: "21", quota: "84000.00", regime: "isp", nif: "DE123456789", sourceId: "r-isp" }),
      row({ book: "recibidas", date: "2025-08-11", base: "186855.53", rate: "21", quota: "39239.66", regime: "aib", nif: "FR12345678901", sourceId: "r-aib" }),
      row({ book: "recibidas", date: "2025-11-05", base: "1000.00", rate: "21", quota: "210.00", sourceId: "r-int" })
    ];
  }
  function periodsOf(rows: readonly VatBookRow[]): Modelo390PeriodResult[] {
    return [1, 2, 3, 4].map((quarter) => {
      const periodo = parseFiscalPeriod(`2025-Q${quarter}`);
      const periodRows = rows.filter((entry) => entry.date >= periodo.from && entry.date <= periodo.to);
      return { periodo, computation: compute303({ rows: periodRows, settings: SETTINGS, compensacionPendiente: ZERO }), liquidado: false };
    });
  }
  const general = { regimen: resolveFiscalRegime(identity(), "quarterly") };

  it("con régimen: volumen = 6.151.982,84 − 586.855,53 = 5.565.127,31 < umbral → la propuesta no cambia; la casilla informativa lleva lo excluido", () => {
    const rows = yearRows();
    const aggregated = aggregate390({ year: 2025, periods: periodsOf(rows), rows });
    assert.equal(aggregated.totales.volumenOperaciones, 5565127.31);
    assert.equal(aggregated.totales.autofacturasIspAibExcluidas, 586855.53);
    assert.equal(aggregated.casillas.find((box) => box.clave === "VOLUMEN_OPERACIONES")?.importe, 5565127.31);
    assert.equal(aggregated.casillas.find((box) => box.clave === "AUTOFACTURAS_ISP_AIB_EXCLUIDAS")?.importe, 586855.53);
    assert.ok(aggregated.casillas.find((box) => box.clave === "VOLUMEN_OPERACIONES")?.descripcion.includes("casilla 108"));
    assert.ok(aggregated.avisos.some((aviso) => /sin las autofacturas ISP\/AIB \(586855\.53 €/.test(aviso)));
    // Las cuotas siguen enteras: total devengado = 1.050.000 + 56.512,73 + 84.000 + 39.239,66; deducible = 84.000 + 39.239,66 + 210.
    assert.equal(aggregated.totales.cuotaDevengada, 1229752.39);
    assert.equal(aggregated.totales.cuotaDeducible, 123449.66);
    assert.equal(aggregated.casillas.find((box) => box.clave === "DEV_CUOTA_ISP")?.importe, 84000);
    assert.equal(aggregated.casillas.find((box) => box.clave === "DED_CUOTA_AIB")?.importe, 39239.66);
    assert.equal(aggregated.casillas.find((box) => box.clave === "DEV_BASE_21")?.importe, 5000000, "el régimen ordinario al 21 % no lleva las autofacturas");
    const proposal = proposeRegime({ year: 2025, volumen: D(aggregated.totales.volumenOperaciones!), sociedad: general });
    assert.deepEqual([proposal.regimen, proposal.cambia], ["general", false]);
    assert.match(proposal.motivo, /5\.565\.127,31 € ≤ 6\.010\.121,04 €/);
  });

  it("sin régimen (filas anteriores a F2): las autofacturas siguen en el volumen (6.151.982,84 > umbral) y el producto propone gran empresa — el falso positivo B-1", () => {
    const rows = yearRows().map((entry) => ({ ...entry, regime: null }));
    const aggregated = aggregate390({ year: 2025, periods: periodsOf(rows), rows });
    assert.equal(aggregated.totales.volumenOperaciones, 6151982.84);
    assert.equal(aggregated.totales.autofacturasIspAibExcluidas, 0);
    assert.ok(!aggregated.avisos.some((aviso) => /sin las autofacturas/.test(aviso)));
    const proposal = proposeRegime({ year: 2025, volumen: D(aggregated.totales.volumenOperaciones!), sociedad: general });
    assert.deepEqual([proposal.regimen, proposal.cambia], ["gran_empresa", true]);
  });
});
