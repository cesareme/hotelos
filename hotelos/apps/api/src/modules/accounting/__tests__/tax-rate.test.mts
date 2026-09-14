// Unit tests for the per-property indirect-tax resolver (Tanda 3 · contract C).
// Pure-core only: the service runs on an in-memory TaxRateStore, no database.
// Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/tax-rate.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CATALOG_VALID_FROM,
  TAX_CACHE_TTL_MS,
  createTaxRateService,
  buildTaxCode,
  dayUtc,
  pickRateRow,
  planCatalogProvisioning,
  resolvePropertyRegion,
  type AuditSink,
  type NewTaxRateRow,
  type TaxPropertyRow,
  type TaxRateRow,
  type TaxRateStore,
  type TaxRow,
  type TaxSettingsRow
} from "../tax-rate.service.js";
import { inferCategoryFromCode, parseFlags } from "../../../scripts/backfill-taxes.js";
import { BadRequestError, NotFoundError } from "../../../lib/http-error.js";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

type MemoryStore = TaxRateStore & {
  properties: TaxPropertyRow[];
  taxes: TaxRow[];
  rates: TaxRateRow[];
  settings: Map<string, TaxSettingsRow>;
  calls: Record<string, number>;
};

function memoryStore(seed: { properties?: TaxPropertyRow[]; taxes?: TaxRow[]; rates?: TaxRateRow[]; settings?: Record<string, TaxSettingsRow> } = {}): MemoryStore {
  let nextId = 1;
  const store: MemoryStore = {
    properties: seed.properties ?? [],
    taxes: seed.taxes ?? [],
    rates: seed.rates ?? [],
    settings: new Map(Object.entries(seed.settings ?? {})),
    calls: {},
    async findProperty(propertyId) {
      store.calls.findProperty = (store.calls.findProperty ?? 0) + 1;
      return store.properties.find((p) => p.id === propertyId) ?? null;
    },
    async findTax(organizationId, taxRegion) {
      store.calls.findTax = (store.calls.findTax ?? 0) + 1;
      return store.taxes.find((t) => t.organizationId === organizationId && t.taxRegion === taxRegion) ?? null;
    },
    async createTax(data) {
      const row: TaxRow = { id: `tax_${nextId++}`, organizationId: data.organizationId, code: data.code, taxRegion: data.taxRegion, verifactuImpuesto: data.verifactuImpuesto, source: data.source };
      store.taxes.push(row);
      return row;
    },
    async findRates(taxId, date) {
      store.calls.findRates = (store.calls.findRates ?? 0) + 1;
      const day = dayUtc(date).getTime();
      return store.rates
        .filter((r) => r.taxId === taxId && r.active && r.validFrom.getTime() <= day && (r.validTo === null || r.validTo.getTime() >= day))
        .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime() || a.id.localeCompare(b.id));
    },
    async findCategoryRates(taxId, category) {
      return store.rates.filter((r) => r.taxId === taxId && r.active && r.category === category && (r.appliesTo === category || r.appliesTo === "*"));
    },
    async findRateByKey(key) {
      return (
        store.rates.find((r) => r.taxId === key.taxId && r.rateCode === key.rateCode && r.appliesTo === key.appliesTo && r.validFrom.getTime() === key.validFrom.getTime()) ??
        null
      );
    },
    async createRate(data: NewTaxRateRow) {
      const row: TaxRateRow = { id: `rate_${nextId++}`, ...data };
      store.rates.push(row);
      return row;
    },
    async updateRate(id, data) {
      const row = store.rates.find((r) => r.id === id);
      if (!row) throw new Error(`rate ${id} not found`);
      Object.assign(row, data);
    },
    async findSettings(propertyId) {
      return store.settings.get(propertyId) ?? null;
    }
  };
  return store;
}

function catalogRate(taxId: string, category: TaxRateRow["category"], percent: number, calificacion: "S1" | "N1" = "S1", extra: Partial<TaxRateRow> = {}): TaxRateRow {
  return {
    id: `${taxId}_${category}`,
    taxId,
    rateCode: "catalog",
    ratePercent: percent,
    appliesTo: category as string,
    validFrom: CATALOG_VALID_FROM,
    validTo: null,
    active: true,
    category,
    calificacion,
    verifyAgainstOrdinance: false,
    source: "catalog",
    legalBasis: "test",
    ...extra
  };
}

const FARANDA: TaxPropertyRow = { id: "prop_faranda", organizationId: "org_faranda", taxRegion: "", province: "A Coruña", country: "ES" };
const DEMO_MADRID: TaxPropertyRow = { id: "prop_123", organizationId: "org_123", taxRegion: "Madrid", province: null, country: "ES" };
const DEMO_CANARY: TaxPropertyRow = { id: "prop_canary", organizationId: "org_123", taxRegion: "ES_CANARIAS", province: null, country: "ES" };
const CEUTA: TaxPropertyRow = { id: "prop_ceuta", organizationId: "org_ceuta", taxRegion: null, province: "Ceuta", country: "ES" };
const NOWHERE: TaxPropertyRow = { id: "prop_nowhere", organizationId: "org_x", taxRegion: null, province: null, country: "ES" };

const TODAY = new Date("2026-09-14T10:00:00.000Z");

function service(store: TaxRateStore, options: { now?: () => Date; ttlMs?: number; audit?: AuditSink } = {}) {
  return createTaxRateService(store, { now: options.now ?? (() => TODAY), ttlMs: options.ttlMs, audit: options.audit ?? (() => undefined) });
}

// ---------------------------------------------------------------------------
// Region resolution
// ---------------------------------------------------------------------------

describe("resolvePropertyRegion — '' / legacy values / province", () => {
  it("'' with a province derives the region from the province (Faranda → IVA)", () => {
    assert.deepEqual(resolvePropertyRegion(FARANDA), { region: "ES_PENINSULA_BALEARES", configured: "ES_PENINSULA_BALEARES", regionSource: "province" });
  });
  it("legacy 'Madrid' is a mainland label → ES_PENINSULA_BALEARES from the stored value", () => {
    assert.deepEqual(resolvePropertyRegion(DEMO_MADRID), { region: "ES_PENINSULA_BALEARES", configured: "ES_PENINSULA_BALEARES", regionSource: "property" });
  });
  it("null with province Ceuta → ES_CEUTA", () => {
    assert.deepEqual(resolvePropertyRegion(CEUTA), { region: "ES_CEUTA", configured: "ES_CEUTA", regionSource: "province" });
  });
  it("nothing configured → default ES_PENINSULA_BALEARES, configured null", () => {
    assert.deepEqual(resolvePropertyRegion(NOWHERE), { region: "ES_PENINSULA_BALEARES", configured: null, regionSource: "default" });
  });
});

// ---------------------------------------------------------------------------
// resolveTaxRate
// ---------------------------------------------------------------------------

describe("resolveTaxRate — catalogue fallback (never UNKNOWN)", () => {
  it("a tenant without Tax rows resolves every line type from the statutory catalogue", async () => {
    const svc = service(memoryStore({ properties: [FARANDA] }));
    const room = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    assert.equal(room.taxRegion, "ES_PENINSULA_BALEARES");
    assert.equal(room.figure, "IVA");
    assert.equal(room.impuesto, "01");
    assert.equal(room.taxCode, "IVA"); // legacy field = figure
    assert.equal(room.category, "accommodation");
    assert.equal(room.ratePercent, 10);
    assert.equal(room.calificacion, "S1");
    assert.equal(room.source, "catalog");
    assert.equal(room.canonicalTaxCode, "ES_IVA_10");
    assert.equal(room.rateCode, "reducido");

    const parking = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "parking" });
    assert.deepEqual([parking.category, parking.ratePercent, parking.canonicalTaxCode], ["general_services", 21, "ES_IVA_21"]);

    const extra = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "extra" });
    assert.deepEqual([extra.category, extra.ratePercent], ["general_services", 21]);

    const unknown = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "something_new" });
    assert.deepEqual([unknown.category, unknown.ratePercent, unknown.source], ["general_services", 21, "catalog"]);

    const noShow = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "no_show_fee" });
    assert.deepEqual([noShow.category, noShow.ratePercent, noShow.calificacion, noShow.canonicalTaxCode, noShow.rateCode], ["not_subject", 0, "N1", "ES_IVA_N1", "no_sujeto"]);
  });

  it("Canary property → IGIC 7 / transport 3 / Impuesto 03; Ceuta → IPSI 2/4 with ordinance flag", async () => {
    const svc = service(memoryStore({ properties: [DEMO_CANARY, CEUTA] }));
    const room = await svc.resolveTaxRate({ propertyId: "prop_canary", lineType: "room" });
    assert.deepEqual([room.figure, room.impuesto, room.ratePercent, room.canonicalTaxCode], ["IGIC", "03", 7, "ES_IGIC_7"]);
    const transfer = await svc.resolveTaxRate({ propertyId: "prop_canary", lineType: "transfer" });
    assert.deepEqual([transfer.category, transfer.ratePercent], ["transport", 3]);
    const minibar = await svc.resolveTaxRate({ propertyId: "prop_canary", lineType: "minibar" });
    assert.deepEqual([minibar.category, minibar.ratePercent], ["food_beverage", 7]);

    const ceutaRoom = await svc.resolveTaxRate({ propertyId: "prop_ceuta", lineType: "room" });
    assert.deepEqual([ceutaRoom.figure, ceutaRoom.impuesto, ceutaRoom.ratePercent, ceutaRoom.verifyAgainstOrdinance], ["IPSI", "02", 2, true]);
    const ceutaSpa = await svc.resolveTaxRate({ propertyId: "prop_ceuta", lineType: "spa" });
    assert.deepEqual([ceutaSpa.ratePercent, ceutaSpa.canonicalTaxCode], [4, "ES_IPSI_4"]);
  });

  it("no region and no province → default IVA (reported by the profile as a warning)", async () => {
    const svc = service(memoryStore({ properties: [NOWHERE] }));
    const room = await svc.resolveTaxRate({ propertyId: "prop_nowhere", lineType: "room" });
    assert.deepEqual([room.taxRegion, room.ratePercent, room.source], ["ES_PENINSULA_BALEARES", 10, "catalog"]);
    const profile = await svc.getPropertyTaxProfile("prop_nowhere");
    assert.equal(profile.taxRegion, null);
    assert.equal(profile.regionSource, "default");
    assert.equal(profile.effectiveTaxRegion, "ES_PENINSULA_BALEARES");
    assert.ok(profile.warnings.some((w) => /no tiene región fiscal/.test(w)));
  });

  it("unknown property → NotFoundError", async () => {
    const svc = service(memoryStore());
    await assert.rejects(svc.resolveTaxRate({ propertyId: "ghost", lineType: "room" }), NotFoundError);
  });

  it("taxCategory override wins over the line-type map", async () => {
    const svc = service(memoryStore({ properties: [FARANDA] }));
    const r = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room", taxCategory: "not_subject" });
    assert.deepEqual([r.category, r.calificacion, r.ratePercent], ["not_subject", "N1", 0]);
    const bogus = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room", taxCategory: "bogus" });
    assert.equal(bogus.category, "accommodation");
  });
});

describe("resolveTaxRate — organization filter and DB rows", () => {
  it("does NOT use another organization's Tax rows (Faranda never sees org_123's catalogue)", async () => {
    const store = memoryStore({
      properties: [FARANDA, DEMO_MADRID],
      taxes: [{ id: "tax_demo", organizationId: "org_123", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "manual" }],
      rates: [catalogRate("tax_demo", "accommodation", 4, "S1", { source: "manual" })] // deliberately odd tier
    });
    const svc = service(store);
    const demo = await svc.resolveTaxRate({ propertyId: "prop_123", lineType: "room" });
    assert.deepEqual([demo.source, demo.ratePercent], ["db", 4]);
    const faranda = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    assert.deepEqual([faranda.source, faranda.ratePercent], ["catalog", 10]);
  });

  it("legacy '' region: the Tax row is matched by the CANONICAL region derived from the province", async () => {
    const store = memoryStore({
      properties: [FARANDA],
      taxes: [{ id: "tax_far", organizationId: "org_faranda", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "catalog" }],
      rates: [catalogRate("tax_far", "accommodation", 10), catalogRate("tax_far", "general_services", 21)]
    });
    const svc = service(store);
    const room = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    assert.deepEqual([room.source, room.ratePercent, room.appliesTo], ["db", 10, "accommodation"]);
    // Category without a row → catalogue, same tenant.
    const transfer = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "transfer" });
    assert.deepEqual([transfer.source, transfer.ratePercent], ["catalog", 10]);
  });

  it("a line-type row (manual override / legacy seed) beats the category row, honouring validity dates", async () => {
    const store = memoryStore({
      properties: [DEMO_MADRID],
      taxes: [{ id: "tax_demo", organizationId: "org_123", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "catalog" }],
      rates: [
        catalogRate("tax_demo", "food_beverage", 10),
        // Legacy seed row: minibar at 21 %, closed yesterday by the backfill.
        catalogRate("tax_demo", null, 21, "S1", { id: "legacy_minibar", appliesTo: "minibar", rateCode: "general", validTo: dayUtc("2026-09-13") })
      ]
    });
    const svc = service(store);
    const old = await svc.resolveTaxRate({ propertyId: "prop_123", lineType: "minibar", postingDate: new Date("2026-09-01T12:00:00Z") });
    assert.deepEqual([old.ratePercent, old.appliesTo, old.category], [21, "minibar", "food_beverage"]);
    const today = await svc.resolveTaxRate({ propertyId: "prop_123", lineType: "minibar", postingDate: TODAY });
    assert.deepEqual([today.ratePercent, today.appliesTo], [10, "food_beverage"]);
  });

  it("tourist tax: catalogue includes it at 10 % under IVA; property setting 'not_subject' turns it into N1", async () => {
    const store = memoryStore({ properties: [FARANDA, DEMO_MADRID], settings: { prop_123: { touristTaxTreatment: "not_subject", ipsiOrdinanceConfirmedAt: null } } });
    const svc = service(store);
    const faranda = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "city_tax" });
    assert.deepEqual([faranda.category, faranda.ratePercent, faranda.calificacion], ["tourist_tax", 10, "S1"]);
    const madrid = await svc.resolveTaxRate({ propertyId: "prop_123", lineType: "city_tax" });
    assert.deepEqual([madrid.ratePercent, madrid.calificacion, madrid.canonicalTaxCode], [0, "N1", "ES_IVA_N1"]);
  });
});

describe("cache — TTL and invalidation", () => {
  it("caches the property context and the rate; invalidateTaxCache(propertyId) forces a reload", async () => {
    const store = memoryStore({ properties: [FARANDA] });
    const svc = service(store);
    await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    assert.equal(store.calls.findProperty, 1);

    // A Tax row appears (provisioning) — the cached answer still says catalogue…
    store.taxes.push({ id: "tax_far", organizationId: "org_faranda", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "catalog" });
    store.rates.push(catalogRate("tax_far", "accommodation", 10));
    assert.equal((await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" })).source, "catalog");
    // …until invalidated.
    svc.invalidateTaxCache("prop_faranda");
    assert.equal((await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" })).source, "db");
    assert.equal(store.calls.findProperty, 2);
  });

  it("invalidateTaxCache() without argument clears every property", async () => {
    const store = memoryStore({ properties: [FARANDA, DEMO_MADRID] });
    const svc = service(store);
    await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    await svc.resolveTaxRate({ propertyId: "prop_123", lineType: "room" });
    svc.invalidateTaxCache();
    await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    await svc.resolveTaxRate({ propertyId: "prop_123", lineType: "room" });
    assert.equal(store.calls.findProperty, 4);
  });

  it("entries expire after the TTL (60 seconds by default: invalidation is per process, replicas converge within the TTL)", async () => {
    assert.equal(TAX_CACHE_TTL_MS, 60_000);
    let clock = TODAY.getTime();
    const store = memoryStore({ properties: [FARANDA] });
    const svc = createTaxRateService(store, { now: () => new Date(clock), audit: () => undefined });
    await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    clock += 40 * 1000;
    await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    assert.equal(store.calls.findProperty, 1);
    clock += 30 * 1000; // 70 s after the first call
    await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" });
    assert.equal(store.calls.findProperty, 2);
  });
});

// ---------------------------------------------------------------------------
// Profile + manual override
// ---------------------------------------------------------------------------

describe("getPropertyTaxProfile", () => {
  it("lists one rate per category with its source, and warns when not provisioned / region derived", async () => {
    const svc = service(memoryStore({ properties: [FARANDA] }));
    const profile = await svc.getPropertyTaxProfile("prop_faranda");
    assert.equal(profile.taxRegion, "ES_PENINSULA_BALEARES");
    assert.equal(profile.regionSource, "province");
    assert.equal(profile.rawTaxRegion, "");
    assert.deepEqual([profile.figure, profile.impuesto], ["IVA", "01"]);
    assert.equal(profile.touristTaxTreatment, "included_10");
    assert.deepEqual(profile.rates.map((r) => r.category), ["accommodation", "food_beverage", "general_services", "transport", "tourist_tax", "not_subject"]);
    assert.deepEqual(profile.rates.map((r) => r.ratePercent), [10, 10, 21, 10, 10, 0]);
    assert.ok(profile.rates.every((r) => r.source === "catalog" && r.overridden === false && r.validFrom === null));
    assert.equal(profile.provisioned, false);
    assert.ok(profile.warnings.some((w) => /no están provisionados/.test(w)));
    assert.ok(profile.warnings.some((w) => /derivado de la provincia/.test(w)));
  });

  it("source is 'db' for a provisioned statutory row, 'manual' (overridden) for a manual row, 'catalog' without a row", async () => {
    const store = memoryStore({
      properties: [FARANDA],
      taxes: [{ id: "tax_far", organizationId: "org_faranda", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "catalog" }],
      rates: [
        catalogRate("tax_far", "accommodation", 10),
        catalogRate("tax_far", "general_services", 10, "S1", { id: "manual_gs", rateCode: "reducido", source: "manual", validFrom: dayUtc("2026-09-01") })
      ]
    });
    const profile = await service(store).getPropertyTaxProfile("prop_faranda");
    const byCategory = Object.fromEntries(profile.rates.map((r) => [r.category, r]));
    assert.deepEqual([byCategory.accommodation.source, byCategory.accommodation.overridden, byCategory.accommodation.validFrom], ["db", false, "2000-01-01"]);
    assert.deepEqual([byCategory.general_services.source, byCategory.general_services.overridden, byCategory.general_services.ratePercent, byCategory.general_services.validFrom], ["manual", true, 10, "2026-09-01"]);
    assert.deepEqual([byCategory.transport.source, byCategory.transport.overridden, byCategory.transport.validFrom], ["catalog", false, null]);
    assert.equal(profile.provisioned, true);
  });

  it("IPSI without ordinance confirmation warns; Canary defaults tourist tax to not_subject", async () => {
    const svc = service(memoryStore({ properties: [CEUTA, DEMO_CANARY] }));
    const ceuta = await svc.getPropertyTaxProfile("prop_ceuta");
    assert.ok(ceuta.warnings.some((w) => /IPSI/.test(w)));
    assert.ok(ceuta.rates.filter((r) => r.calificacion === "S1").every((r) => r.verifyAgainstOrdinance));
    const canary = await svc.getPropertyTaxProfile("prop_canary");
    assert.equal(canary.regionSource, "property");
    assert.equal(canary.touristTaxTreatment, "not_subject");
    assert.deepEqual(canary.warnings.filter((w) => /región/.test(w)), []);
  });
});

describe("upsertPropertyTaxRate — manual override", () => {
  it("creates the Tax row when missing, writes a manual category row valid from today, invalidates the cache and audits", async () => {
    const store = memoryStore({ properties: [FARANDA] });
    const events: Parameters<AuditSink>[0][] = [];
    const svc = service(store, { audit: (e) => events.push(e) });
    assert.equal((await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "spa" })).ratePercent, 21);

    const result = await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, actorUserId: "usr_1" });
    assert.deepEqual([result.unchanged, result.validFrom], [false, "2026-09-14"]);
    assert.ok(result.rateId);

    assert.equal(store.taxes.length, 1);
    assert.deepEqual([store.taxes[0].organizationId, store.taxes[0].code, store.taxes[0].taxRegion, store.taxes[0].verifactuImpuesto, store.taxes[0].source], ["org_faranda", "IVA", "ES_PENINSULA_BALEARES", "01", "manual"]);
    const row = store.rates.find((r) => r.category === "general_services");
    assert.ok(row);
    assert.deepEqual([row.ratePercent, row.appliesTo, row.source, row.calificacion, row.validFrom.toISOString().slice(0, 10)], [10, "general_services", "manual", "S1", "2026-09-14"]);

    const spa = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "spa" });
    assert.deepEqual([spa.source, spa.ratePercent, spa.canonicalTaxCode], ["db", 10, "ES_IVA_10"]);
    // Other categories keep the catalogue.
    assert.equal((await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "room" })).source, "catalog");

    assert.equal(events.length, 1);
    assert.equal(events[0].action, "TAX_RATE_UPDATED");
    assert.equal(events[0].actorUserId, "usr_1");
    assert.deepEqual((events[0].beforeJson as { source: string }).source, "catalog");
    assert.deepEqual((events[0].afterJson as { ratePercent: number; source: string }), { ...(events[0].afterJson as object), ratePercent: 10, source: "manual" });
  });

  it("closes the previous category row the day before the new validFrom and supersedes future rows", async () => {
    const store = memoryStore({
      properties: [FARANDA],
      taxes: [{ id: "tax_far", organizationId: "org_faranda", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "catalog" }],
      rates: [
        catalogRate("tax_far", "general_services", 21),
        catalogRate("tax_far", "general_services", 10, "S1", { id: "future", validFrom: dayUtc("2026-12-01"), source: "manual", rateCode: "reducido" })
      ]
    });
    const svc = service(store);
    await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, validFrom: "2026-10-01", actorUserId: "usr_1" });
    const catalog = store.rates.find((r) => r.id === "tax_far_general_services")!;
    assert.equal(catalog.validTo?.toISOString().slice(0, 10), "2026-09-30");
    assert.equal(catalog.source, "catalog", "the statutory row is closed, not rewritten");
    assert.equal(store.rates.find((r) => r.id === "future")!.active, false);
    const before = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "spa", postingDate: new Date("2026-09-20T00:00:00Z") });
    const after = await svc.resolveTaxRate({ propertyId: "prop_faranda", lineType: "spa", postingDate: new Date("2026-10-01T00:00:00Z") });
    assert.deepEqual([before.ratePercent, after.ratePercent], [21, 10]);
  });

  it("is idempotent on the same (category, rate, validFrom): one row, one audit event, the second call reports unchanged", async () => {
    const store = memoryStore({ properties: [FARANDA] });
    const events: Parameters<AuditSink>[0][] = [];
    const svc = service(store, { audit: (e) => events.push(e) });
    const first = await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, actorUserId: "usr_1" });
    const second = await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, actorUserId: "usr_1" });
    assert.equal(first.unchanged, false);
    assert.deepEqual(second, { unchanged: true, rateId: first.rateId, validFrom: "2026-09-14" });
    const rows = store.rates.filter((r) => r.category === "general_services");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].active, true);
    assert.equal(rows[0].validTo, null);
    assert.equal(events.length, 1);
  });

  it("PUT of the rate already in force never converts a statutory row into a manual one nor audits (Faranda general_services 21 %)", async () => {
    const store = memoryStore({
      properties: [FARANDA],
      taxes: [{ id: "tax_far", organizationId: "org_faranda", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "catalog" }],
      rates: [catalogRate("tax_far", "accommodation", 10), catalogRate("tax_far", "general_services", 21, "S1", { rateCode: "general" })]
    });
    const events: Parameters<AuditSink>[0][] = [];
    const svc = service(store, { audit: (e) => events.push(e) });
    const result = await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 21, calificacion: "S1", actorUserId: "usr_1" });
    assert.deepEqual(result, { unchanged: true, rateId: "tax_far_general_services", validFrom: "2026-09-14" });
    assert.equal(store.rates.length, 2, "no row written");
    const statutory = store.rates.find((r) => r.id === "tax_far_general_services")!;
    assert.deepEqual([statutory.source, statutory.active, statutory.validTo, statutory.validFrom], ["catalog", true, null, CATALOG_VALID_FROM]);
    assert.equal(events.length, 0, "nothing audited");
    const profile = await svc.getPropertyTaxProfile("prop_faranda");
    const gs = profile.rates.find((r) => r.category === "general_services")!;
    assert.deepEqual([gs.source, gs.overridden, gs.ratePercent, gs.validFrom], ["db", false, 21, "2000-01-01"]);

    // A different rate is a real change: the statutory row is closed yesterday, the manual row starts today.
    const changed = await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, actorUserId: "usr_1" });
    assert.equal(changed.unchanged, false);
    assert.equal(statutory.validTo?.toISOString().slice(0, 10), "2026-09-13");
    assert.equal(statutory.source, "catalog");
    const manual = store.rates.find((r) => r.id === changed.rateId)!;
    assert.deepEqual([manual.source, manual.ratePercent, manual.validFrom.toISOString().slice(0, 10), manual.validTo], ["manual", 10, "2026-09-14", null]);
    assert.equal(events.length, 1);
    assert.deepEqual((events[0].beforeJson as { source: string; ratePercent: number }).source, "catalog");
  });

  it("a request matching the catalogue on an unprovisioned property is a no-op too (no Tax row, no audit)", async () => {
    const store = memoryStore({ properties: [FARANDA] });
    const events: Parameters<AuditSink>[0][] = [];
    const svc = service(store, { audit: (e) => events.push(e) });
    const result = await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "accommodation", ratePercent: 10, actorUserId: "usr_1" });
    assert.deepEqual(result, { unchanged: true, rateId: null, validFrom: "2026-09-14" });
    assert.deepEqual([store.taxes.length, store.rates.length, events.length], [0, 0, 0]);
  });

  it("rejects the catalogue sentinel 2000-01-01 as validFrom (reserved to provisioning)", async () => {
    const store = memoryStore({
      properties: [FARANDA],
      taxes: [{ id: "tax_far", organizationId: "org_faranda", code: "IVA", taxRegion: "ES_PENINSULA_BALEARES", verifactuImpuesto: "01", source: "catalog" }],
      rates: [catalogRate("tax_far", "general_services", 21, "S1", { rateCode: "general" })]
    });
    const svc = service(store);
    await assert.rejects(
      svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, validFrom: "2000-01-01", actorUserId: "u" }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestError);
        assert.match(error.message, /reservada a la provisión del catálogo/);
        assert.deepEqual((error.details as { code: string }).code, "TAX_VALID_FROM_RESERVED");
        return true;
      }
    );
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, validFrom: "1999-12-31", actorUserId: "u" }), /reservada/);
    assert.equal(store.rates.find((r) => r.id === "tax_far_general_services")!.source, "catalog");
    // A backdated override after the sentinel is legitimate.
    const result = await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, validFrom: "2026-01-01", actorUserId: "u" });
    assert.deepEqual([result.unchanged, result.validFrom], [false, "2026-01-01"]);
  });

  it("legality by category: only the tiers of ALLOWED_PERCENTS_BY_CATEGORY pass, per figure", async () => {
    const svc = service(memoryStore({ properties: [FARANDA, DEMO_CANARY, CEUTA] }));
    const rejected = (category: string, ratePercent: number, propertyId = "prop_faranda", calificacion?: "S1" | "N1") =>
      assert.rejects(svc.upsertPropertyTaxRate({ propertyId, category: category as never, ratePercent, calificacion, actorUserId: "u" }), (error: unknown) => {
        assert.ok(error instanceof BadRequestError);
        assert.match(error.message, /no es (un tipo )?aplicable a «.+» \(\w+\) en (IVA|IGIC|IPSI) \(admitidos: .+\)/);
        assert.deepEqual((error.details as { code: string }).code, "TAX_RATE_NOT_ALLOWED");
        return true;
      });
    // IVA
    await rejected("accommodation", 21);
    await rejected("accommodation", 4);
    await rejected("food_beverage", 21);
    await rejected("general_services", 4);
    await rejected("tourist_tax", 21);
    await rejected("tourist_tax", 0, "prop_faranda", "N1");
    await rejected("not_subject", 10, "prop_faranda", "S1");
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "accommodation", ratePercent: 21, actorUserId: "u" }), /El 21 % no es un tipo aplicable a «Alojamiento» \(accommodation\) en IVA \(admitidos: 10 %\)/);
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "tourist_tax", ratePercent: 0, calificacion: "N1", actorUserId: "u" }), /N1 \(no sujeta\) no es aplicable/);
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "general_services", ratePercent: 10, actorUserId: "u" })).unchanged, false);
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "transport", ratePercent: 21, actorUserId: "u" })).unchanged, false);
    // IGIC
    await rejected("accommodation", 3, "prop_canary");
    await rejected("accommodation", 9.5, "prop_canary");
    await rejected("general_services", 15, "prop_canary");
    await rejected("transport", 10, "prop_canary");
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_canary", category: "transport", ratePercent: 7, actorUserId: "u" })).unchanged, false);
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_canary", category: "tourist_tax", ratePercent: 0, calificacion: "N1", actorUserId: "u" })).unchanged, true);
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_canary", category: "tourist_tax", ratePercent: 7, actorUserId: "u" })).unchanged, false);
    // IPSI (no longer an open list: 1 / 2 / 4 per the ordinances)
    await rejected("accommodation", 3, "prop_ceuta");
    await rejected("general_services", 10, "prop_ceuta");
    await rejected("tourist_tax", 2, "prop_ceuta");
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_ceuta", category: "accommodation", ratePercent: 1, actorUserId: "u" })).unchanged, false);
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_ceuta", category: "general_services", ratePercent: 2, actorUserId: "u" })).unchanged, false);
    assert.equal((await svc.upsertPropertyTaxRate({ propertyId: "prop_ceuta", category: "tourist_tax", ratePercent: 4, actorUserId: "u" })).unchanged, false);
  });

  it("validates category, calificación, percent tier and region", async () => {
    const svc = service(memoryStore({ properties: [FARANDA, NOWHERE] }));
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "bogus" as never, ratePercent: 10, actorUserId: "u" }), BadRequestError);
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "accommodation", ratePercent: 13, actorUserId: "u" }), /El 13 % no es un tipo aplicable a «Alojamiento» \(accommodation\) en IVA/);
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "accommodation", ratePercent: 0, actorUserId: "u" }), /no sujeto \(N1\)/);
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "not_subject", ratePercent: 10, calificacion: "N1", actorUserId: "u" }), /N1/);
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_faranda", category: "accommodation", ratePercent: 10, validFrom: "14/09/2026", actorUserId: "u" }), /YYYY-MM-DD/);
    await assert.rejects(svc.upsertPropertyTaxRate({ propertyId: "prop_nowhere", category: "accommodation", ratePercent: 10, actorUserId: "u" }), (error: unknown) => {
      assert.ok(error instanceof BadRequestError);
      assert.deepEqual((error.details as { code: string }).code, "TAX_REGION_MISSING");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("pickRateRow: line-type row first, then category row (appliesTo = category or '*')", () => {
    const rows: TaxRateRow[] = [
      catalogRate("t", "general_services", 21, "S1", { id: "cat", appliesTo: "*" }),
      catalogRate("t", "general_services", 10, "S1", { id: "spa", appliesTo: "spa", validFrom: dayUtc("2026-01-01") })
    ];
    assert.equal(pickRateRow(rows, "spa", "general_services")?.id, "spa");
    assert.equal(pickRateRow(rows, "parking", "general_services")?.id, "cat");
    assert.equal(pickRateRow(rows, "room", "accommodation"), null);
    // A category row is not mistaken for a line-type override of another category.
    const transport = [catalogRate("t", "transport", 10, "S1", { id: "transport" })];
    assert.equal(pickRateRow(transport, "transport", "general_services"), null);
    assert.equal(pickRateRow(transport, "transport", "transport")?.id, "transport");
  });

  it("planCatalogProvisioning: coverage is the validity window, a closed statutory row is repaired from today", () => {
    const today = dayUtc("2026-09-14");
    const open = (category: TaxRateRow["category"], extra: Partial<TaxRateRow> = {}) => catalogRate("t", category, 10, "S1", extra);

    // Fresh tenant: every category from the legacy sentinel.
    const fresh = planCatalogProvisioning([], today);
    assert.deepEqual(fresh.covered, []);
    assert.deepEqual(fresh.missing.map((m) => m.category), ["accommodation", "food_beverage", "general_services", "transport", "tourist_tax", "not_subject"]);
    assert.ok(fresh.missing.every((m) => m.validFrom.getTime() === CATALOG_VALID_FROM.getTime() && m.validTo === null && m.repair === false));

    // Faranda after the verification run: general_services closed on 2026-09-13, no successor.
    const faranda = [
      open("accommodation"),
      open("food_beverage"),
      open("general_services", { validTo: dayUtc("2026-09-13") }),
      open("transport"),
      open("tourist_tax"),
      open("not_subject")
    ];
    const repair = planCatalogProvisioning(faranda, today);
    assert.deepEqual(repair.covered, ["accommodation", "food_beverage", "transport", "tourist_tax", "not_subject"]);
    assert.equal(repair.missing.length, 1);
    assert.deepEqual([repair.missing[0].category, repair.missing[0].validFrom.toISOString().slice(0, 10), repair.missing[0].validTo, repair.missing[0].repair], ["general_services", "2026-09-14", null, true]);

    // Idempotent: once the repaired row exists nothing is missing.
    const repaired = [...faranda, open("general_services", { id: "gs_today", validFrom: today })];
    assert.deepEqual(planCatalogProvisioning(repaired, today).missing, []);

    // A row that ends today is still in force today; one ending yesterday is not.
    assert.deepEqual(planCatalogProvisioning([open("accommodation", { validTo: today })], today).covered, ["accommodation"]);
    assert.ok(planCatalogProvisioning([open("accommodation", { validTo: dayUtc("2026-09-13") })], today).missing.some((m) => m.category === "accommodation" && m.repair));

    // Future-only history: the repaired row stops the day before the future row starts.
    const future = planCatalogProvisioning([open("accommodation", { validFrom: dayUtc("2026-12-01"), source: "manual" })], today);
    const acc = future.missing.find((m) => m.category === "accommodation")!;
    assert.deepEqual([acc.validFrom.toISOString().slice(0, 10), acc.validTo?.toISOString().slice(0, 10), acc.repair], ["2026-09-14", "2026-11-30", true]);

    // Line-type rows do not cover a category; '*' rows do.
    const lineType = planCatalogProvisioning([open("food_beverage", { appliesTo: "minibar" })], today);
    assert.ok(lineType.missing.some((m) => m.category === "food_beverage" && m.repair === false));
    assert.deepEqual(planCatalogProvisioning([open("food_beverage", { appliesTo: "*" })], today).covered, ["food_beverage"]);
  });

  it("legacy buildTaxCode wrapper keeps the old two-argument behaviour and accepts UNKNOWN", () => {
    assert.equal(buildTaxCode("IVA", 10), "ES_IVA_10");
    assert.equal(buildTaxCode("IGIC", 9.5), "ES_IGIC_9.5");
    assert.equal(buildTaxCode("IVA", 0, "N1"), "ES_IVA_N1");
    assert.equal(buildTaxCode("UNKNOWN", 0), "ES_UNKNOWN_0");
  });

  it("backfill: inferCategoryFromCode and flags", () => {
    assert.equal(inferCategoryFromCode("ES_PENINSULA_BALEARES", "ES_IVA_21", 21), "general_services");
    assert.equal(inferCategoryFromCode("ES_PENINSULA_BALEARES", "ES_IVA_10", 10), "accommodation");
    assert.equal(inferCategoryFromCode("ES_PENINSULA_BALEARES", "ES_UNKNOWN_0", 0), "accommodation");
    assert.equal(inferCategoryFromCode("ES_PENINSULA_BALEARES", "X", 0), "accommodation");
    assert.equal(inferCategoryFromCode("ES_PENINSULA_BALEARES", "ES_IVA_N1", 0), "not_subject");
    assert.equal(inferCategoryFromCode("ES_CANARIAS", "ES_IGIC_10", 9.5), "accommodation");
    assert.equal(inferCategoryFromCode("ES_CANARIAS", "ES_IGIC_3", 3), "transport");
    assert.deepEqual(parseFlags([]), { propertyId: null, apply: false, json: false });
    assert.deepEqual(parseFlags(["--apply", "--property", "prop_1", "--json"]), { propertyId: "prop_1", apply: true, json: true });
    assert.throws(() => parseFlags(["--bogus"]), /Unknown flag/);
    assert.throws(() => parseFlags(["--property"]), /requires a value/);
  });
});
