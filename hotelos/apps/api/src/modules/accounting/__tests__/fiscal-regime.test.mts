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
import { resolveSettlementPeriod } from "../modelo-303.service.js";
import { proposeRegime } from "../modelo-390.service.js";
import { LARGE_COMPANY_THRESHOLD, VERIFACTU_EXCLUDED_BY_SII_MOTIVO, declaranteBadge, declarantePair, regimeAvisos, resolveFiscalRegime, siiModelNotFiledMotivo } from "../vat-books.service.js";

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
  const orgWide = { permissions, assignedPropertyIds: [] as string[] };
  const platform = { permissions, assignedPropertyIds: ["prop_x"], isPlatformAdmin: true };

  it("hasEntityReadScope: permission, platform admin or no assignments open the whole sociedad", () => {
    assert.equal(ENTITY_READ_PERMISSION, "accounting.entity.read");
    assert.equal(hasEntityReadScope(director), false);
    assert.equal(hasEntityReadScope(directora), true);
    assert.equal(hasEntityReadScope(orgWide), true);
    assert.equal(hasEntityReadScope({ permissions }), true);
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
