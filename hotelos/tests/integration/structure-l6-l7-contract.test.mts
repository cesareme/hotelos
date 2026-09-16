/**
 * Estructura societaria · L9 · contract of the API surface the front consumes in
 * L6 («Configuración › Estructura societaria») and L7 (selector «Ámbito», badge
 * de declarante, vistas por centro). Postgres required; REAL HTTP via app.inject
 * with the demo session (reception@example.com, org_123) — READ ONLY: nothing is
 * written anywhere (no fixture, no cleanup). The suite pins the SHAPES of design
 * §5.4 / runbook §17.8 that the screens read (field names, enumerations, string
 * money, ISO dates), never demo figures: org_123 is a legitimate write target of
 * the sister suites, so the assertions are structural and self-consistent
 * (e.g. `clashCount` = rows with `clash`), not numeric snapshots.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/structure-l6-l7-contract.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
delete process.env.STRUCTURE_ENABLED;

const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const shared = await import("@hotelos/shared");
type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const ORG = "org_123";
const ORG_PROPERTIES = ["prop_123", "prop_canary"];
const MONEY = /^-?\d+\.\d{2}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const STRUCTURE_MODES = ["single_hotel", "multi_center", "group"];
const READ_SCOPES = ["entity", "assigned_properties"];
const CHAIN_SCOPES = [...shared.VERIFACTU_CHAIN_SCOPES];
const PROPERTY_KINDS = [...shared.PROPERTY_KINDS];
/** Exact key set of LegalEntityDto (packages/shared/src/legal-structure-types.ts). */
const LEGAL_ENTITY_DTO_KEYS = [
  "id", "organizationId", "code", "legalName", "taxId", "taxIdValid", "legalForm",
  "fiscalAddress", "fiscalPostalCode", "fiscalMunicipality", "fiscalIneCode", "fiscalProvince",
  "registeredOfficeAddress", "registeredOfficePostalCode", "registeredOfficeMunicipality", "registeredOfficeProvince",
  "mercantileRegistry", "cnae", "pgcVariant", "fiscalYearStartMonth", "largeCompany", "siiEnabled",
  "verifactuChainScope", "cccPrincipal", "isDefault", "status", "createdAt", "updatedAt"
].sort();
/** Fields of the DTO the redaction blanks for a centre-scoped reader (t6b#9). */
const REDACTED_FIELDS = ["taxId", "fiscalAddress", "fiscalPostalCode", "fiscalMunicipality", "fiscalIneCode", "fiscalProvince", "registeredOfficeAddress", "registeredOfficePostalCode", "registeredOfficeMunicipality", "registeredOfficeProvince", "mercantileRegistry", "cnae", "cccPrincipal"];

let app: ApiApp;
let demo: Headers = {};
let entityId = "";

async function get<T>(url: string): Promise<{ status: number; body: T; text: string }> {
  const res = await app.inject({ method: "GET", url, headers: demo });
  let body: T;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null as T;
  }
  return { status: res.statusCode, body, text: res.body };
}
async function ok<T>(url: string): Promise<T> {
  const res = await get<T>(url);
  assert.equal(res.status, 200, `${url} → ${res.text.slice(0, 300)}`);
  return res.body;
}
const keysOf = (value: unknown): string[] => Object.keys(value as Record<string, unknown>).sort();
const hasKeys = (value: unknown, keys: readonly string[], label: string): void => {
  const present = new Set(Object.keys(value as Record<string, unknown>));
  const missing = keys.filter((key) => !present.has(key));
  assert.deepEqual(missing, [], `${label}: missing keys ${missing.join(", ")}`);
};

before(async () => {
  app = await buildApiServer();
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-structure-l6-l7" }
  });
  demo = login.statusCode === 200 ? { authorization: `Bearer ${(JSON.parse(login.body) as { token: string }).token}` } : {};
  entityId = (await prisma.legalEntity.findFirstOrThrow({ where: { organizationId: ORG, isDefault: true }, select: { id: true } })).id;
});

after(async () => {
  try {
    await app?.close();
  } finally {
    await prisma.$disconnect();
  }
});

const ready = (t: { skip: (reason?: string) => void }): boolean => {
  if (!demo.authorization) {
    t.skip("demo login unavailable (/auth/login refused reception@example.com)");
    return false;
  }
  return true;
};

type Structure = {
  organization: { id: string; name: string; country: string };
  legalEntity: Record<string, unknown> & {
    vatSettings: { periodicity: string; regime: string; prorrataPct: string | null; taxFigure: string } | null;
    properties: Array<Record<string, unknown> & { id: string; code: string | null; kind: string; series: Array<Record<string, unknown>>; installation: Record<string, unknown> | null }>;
  };
  mode: string;
  counts: Record<string, number>;
  warnings: string[];
  scope: string;
};

describe("L6 · Configuración › Estructura societaria: lo que lee la pantalla", () => {
  it("GET /organizations/me/structure: organization, legalEntity (DTO + vatSettings + properties[]), mode, counts, warnings, scope — con los nombres y enumeraciones del contrato", async (t) => {
    if (!ready(t)) return;
    const body = await ok<Structure>("/organizations/me/structure");
    assert.deepEqual(keysOf(body), ["counts", "legalEntity", "mode", "organization", "scope", "warnings"]);
    hasKeys(body.organization, ["id", "name", "country"], "organization");
    assert.equal(body.organization.id, ORG);
    assert.ok(STRUCTURE_MODES.includes(body.mode), `mode ${body.mode}`);
    assert.ok(READ_SCOPES.includes(body.scope), `scope ${body.scope}`);
    assert.deepEqual(keysOf(body.counts), ["hotels", "legalEntities", "offices", "others", "properties"]);
    assert.equal(body.counts.properties, body.counts.hotels + body.counts.offices + body.counts.others, "counts add up");
    assert.equal(body.mode, body.counts.legalEntities >= 2 ? "group" : body.counts.properties >= 2 ? "multi_center" : "single_hotel", "mode is derived from the counts (deriveStructureMode)");
    assert.ok(body.warnings.every((w) => ["LEGAL_ENTITY_PENDING", "TAX_ID_PENDING", "PROPERTIES_UNLINKED"].includes(w)), body.warnings.join(","));
    assert.ok(body.legalEntity, "the demo tenant has its sociedad (backfill)");
    const { vatSettings, properties, ...dto } = body.legalEntity;
    assert.deepEqual(keysOf(dto), LEGAL_ENTITY_DTO_KEYS, "legalEntity = LegalEntityDto + vatSettings + properties");
    assert.equal(dto.id, entityId);
    assert.match(String(dto.code), shared.STRUCTURE_CODE_PATTERN);
    assert.ok(shared.PGC_VARIANTS.includes(dto.pgcVariant as never), `pgcVariant ${String(dto.pgcVariant)}`);
    assert.ok(CHAIN_SCOPES.includes(dto.verifactuChainScope as never));
    assert.match(String(dto.createdAt), ISO_TS);
    assert.equal(typeof dto.taxIdValid, "boolean");
    if (body.scope === "entity") {
      assert.ok(vatSettings === null || ["periodicity", "regime", "prorrataPct", "taxFigure"].every((k) => k in vatSettings), "vatSettings shape");
    } else {
      assert.equal(vatSettings, null, "redacted: no VAT settings");
      for (const field of REDACTED_FIELDS) assert.equal(dto[field], null, `redacted ${field}`);
    }
    assert.equal(properties.length, body.scope === "entity" ? body.counts.properties : properties.length);
    for (const property of properties) {
      hasKeys(property, ["id", "code", "name", "tradeName", "kind", "municipality", "province", "status", "legalEntityId", "verifactuEnabled", "sesHospedajesEnabled", "series", "installation"], `property ${property.id}`);
      assert.ok(PROPERTY_KINDS.includes(property.kind as never), `kind ${property.kind}`);
      if (property.code !== null) assert.match(property.code, shared.STRUCTURE_CODE_PATTERN);
      for (const series of property.series) {
        hasKeys(series, ["id", "propertyId", "sequenceCode", "prefix", "year", "nextNumber", "padding", "invoiceType", "active"], "series row");
        assert.equal(series.active, true, "the structure lists only active series");
        assert.notEqual(series.prefix, null, "never a NULL prefix (R3)");
      }
      if (property.installation) {
        hasKeys(property.installation, ["id", "legalEntityId", "propertyId", "numeroInstalacion", "route", "territory", "active", "createdAt", "retiredAt"], "installation");
        assert.equal(property.installation.active, true);
      }
    }
  });

  it("GET /legal-entities/:id devuelve exactamente LegalEntityDto; un id ajeno o inexistente es 404 opaco; PATCH con clave desconocida es 400 VALIDATION_ERROR sin escribir", async (t) => {
    if (!ready(t)) return;
    const dto = await ok<Record<string, unknown>>(`/legal-entities/${entityId}`);
    assert.deepEqual(keysOf(dto), LEGAL_ENTITY_DTO_KEYS);
    assert.equal(dto.isDefault, true);
    assert.equal(dto.organizationId, ORG);
    const missing = await get<{ message: string }>("/legal-entities/le_does_not_exist_l6");
    assert.equal(missing.status, 404, missing.text.slice(0, 200));
    const faranda = await prisma.legalEntity.findFirst({ where: { organizationId: "cmrhw9jy30002fyvb6tsdiugt", isDefault: true }, select: { id: true } });
    if (faranda) {
      // assertEntityAccess re-points a PLATFORM admin to the entity's organization (console use); a hotel session gets the opaque 404.
      const me = await ok<{ isPlatformAdmin: boolean }>("/users/me");
      const foreign = await get<{ organizationId?: string; message?: string }>(`/legal-entities/${faranda.id}`);
      if (me.isPlatformAdmin) {
        assert.equal(foreign.status, 200, foreign.text.slice(0, 200));
        assert.equal(foreign.body.organizationId, "cmrhw9jy30002fyvb6tsdiugt", "the platform admin reads the other tenant's sociedad as that tenant");
      } else {
        assert.equal(foreign.status, 404, foreign.text.slice(0, 200));
        assert.doesNotMatch(foreign.text, /Faranda|B99999997/, "no oracle of the other tenant");
      }
    }
    const before = await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } });
    const strict = await app.inject({ method: "PATCH", url: `/legal-entities/${entityId}`, headers: demo, payload: { legalName: before.legalName, unknownKey: 1 } });
    assert.equal(strict.statusCode, 400, strict.body.slice(0, 200));
    assert.equal((JSON.parse(strict.body) as { details: { code: string } }).details.code, "VALIDATION_ERROR");
    const after = await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } });
    assert.equal(after.updatedAt.toISOString(), before.updatedAt.toISOString(), "nothing written");
  });

  it("GET /legal-entities/:id/series (pestaña Series y VeriFactu): filas con centro, prefijo y clash; clashCount coherente con las filas", async (t) => {
    if (!ready(t)) return;
    type Series = { legalEntityId: string; clashCount: number; series: Array<Record<string, unknown> & { propertyId: string; propertyCode: string | null; propertyKind: string; prefix: string | null; year: number | null; clash: { propertyId: string; sequenceId: string } | null }> };
    const body = await ok<Series>(`/legal-entities/${entityId}/series`);
    assert.deepEqual(keysOf(body), ["clashCount", "legalEntityId", "series"]);
    assert.equal(body.legalEntityId, entityId);
    for (const row of body.series) {
      hasKeys(row, ["id", "propertyId", "sequenceCode", "prefix", "year", "nextNumber", "padding", "invoiceType", "active", "propertyCode", "propertyName", "propertyKind", "clash"], "series row");
      assert.ok(PROPERTY_KINDS.includes(row.propertyKind as never));
      if (row.clash) {
        hasKeys(row.clash, ["propertyId", "sequenceId"], "clash");
        assert.notEqual(row.clash.propertyId, row.propertyId, "a clash always names the sister centre");
        const sister = body.series.find((s) => s.propertyId === row.clash!.propertyId && s.prefix?.toUpperCase() === row.prefix?.toUpperCase() && s.year === row.year);
        assert.ok(sister, "the sister row is in the same list and flagged too");
        assert.ok(sister!.clash, "clash is symmetric");
      }
    }
    assert.equal(body.clashCount, body.series.filter((row) => row.clash !== null).length, "clashCount = rows flagged");
  });

  it("GET /legal-entities/:id/verifactu/installations: chainScope y filas con centro, envíos y última factura; el número es inmutable y único por sociedad", async (t) => {
    if (!ready(t)) return;
    type Installations = { legalEntityId: string; chainScope: string; installations: Array<Record<string, unknown> & { numeroInstalacion: string; propertyId: string | null; propertyCode: string | null; submissions: number; lastInvoice: unknown }> };
    const body = await ok<Installations>(`/legal-entities/${entityId}/verifactu/installations`);
    assert.deepEqual(keysOf(body), ["chainScope", "installations", "legalEntityId"]);
    assert.ok(CHAIN_SCOPES.includes(body.chainScope as never));
    for (const row of body.installations) {
      hasKeys(row, ["id", "legalEntityId", "propertyId", "numeroInstalacion", "route", "territory", "active", "createdAt", "retiredAt", "propertyCode", "propertyName", "submissions", "lastInvoice"], "installation row");
      assert.equal(typeof row.submissions, "number");
      assert.ok(["verifactu", "tbai", "igic"].includes(String(row.route)));
    }
    const numbers = body.installations.map((row) => row.numeroInstalacion);
    assert.equal(new Set(numbers).size, numbers.length, "numeroInstalacion unique inside the sociedad");
  });

  it("GET /users/me/properties (switcher agrupado): kind, code, legalEntityId, legalEntityName en cada fila", async (t) => {
    if (!ready(t)) return;
    const rows = await ok<Array<Record<string, unknown> & { id: string; kind: string; code: string | null; legalEntityId: string | null; legalEntityName: string | null }>>("/users/me/properties");
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      hasKeys(row, ["id", "name", "organizationId", "organizationName", "municipality", "province", "status", "kind", "code", "legalEntityId", "legalEntityName"], "switcher row");
      assert.ok(PROPERTY_KINDS.includes(row.kind as never), `kind ${row.kind}`);
      if (row.legalEntityId) assert.equal(typeof row.legalEntityName, "string", "legalEntityName travels with legalEntityId");
    }
    const demoRows = rows.filter((row) => ORG_PROPERTIES.includes(row.id));
    assert.ok(demoRows.every((row) => row.legalEntityId === entityId), "the demo centres hang from the demo sociedad");
  });

  it("GET|PUT /accounting/allocation (pestaña Reparto): method, weights, hotels, corporateCentres, persisted", async (t) => {
    if (!ready(t)) return;
    type Allocation = { organizationId: string; legalEntityId: string | null; method: string; weights: unknown[]; hotels: Array<Record<string, unknown>>; corporateCentres: unknown[]; persisted: boolean };
    const body = await ok<Allocation>("/accounting/allocation");
    assert.deepEqual(keysOf(body), ["corporateCentres", "hotels", "legalEntityId", "method", "organizationId", "persisted", "weights"]);
    assert.ok(["none", "revenue", "rooms_available", "headcount", "manual"].includes(body.method), body.method);
    assert.equal(body.legalEntityId, entityId);
    for (const hotel of body.hotels) hasKeys(hotel, ["propertyId", "code", "name", "tradeName", "kind"], "FinanceWorkCentre");
    assert.ok(body.hotels.every((h) => h.kind === "hotel"), "allocation targets are hotels");
    const invalid = await app.inject({ method: "PUT", url: "/accounting/allocation", headers: demo, payload: { method: "manual", weights: [{ propertyId: "prop_123", weight: 60 }] } });
    assert.equal(invalid.statusCode, 400, invalid.body.slice(0, 200));
    assert.match((JSON.parse(invalid.body) as { details: { code: string } }).details.code, /^ALLOCATION_/, "manual weights must add up to 100");
  });
});

describe("L7 · Ámbito único, badge de declarante y vistas por centro: lo que leen Finanzas y Cumplimiento", () => {
  type Badge = { legalEntityId: string | null; code: string | null; legalName: string; taxId: string | null; taxIdValid: boolean; source: string; regimen: Record<string, unknown> };
  const checkBadge = (badge: Badge, label: string): void => {
    assert.deepEqual(keysOf(badge), ["code", "legalEntityId", "legalName", "regimen", "source", "taxId", "taxIdValid"], label);
    assert.ok(["legal_entity", "organization_fallback"].includes(badge.source), `${label}.source`);
    assert.deepEqual(keysOf(badge.regimen), ["largeCompany", "modelosNoPresentados", "periodicity", "periodicityForcedBy", "persistedPeriodicity", "siiEnabled", "verifactu"], `${label}.regimen`);
    assert.deepEqual(keysOf(badge.regimen.verifactu), ["aplica", "motivo"]);
    assert.ok(["quarterly", "monthly"].includes(String(badge.regimen.periodicity)));
    assert.ok([null, "sii", "large_company"].includes(badge.regimen.periodicityForcedBy as never));
  };

  it("GET /fiscal/vat-settings y GET /fiscal/regime: FiscalDeclaranteBadge (sociedad) con el régimen; regime lleva umbral 6.010.121,04 y propuesta", async (t) => {
    if (!ready(t)) return;
    const settings = await ok<{ periodicity: string; persisted: boolean; sociedad: Badge }>("/fiscal/vat-settings");
    hasKeys(settings, ["organizationId", "periodicity", "regime", "prorrataPct", "taxFigure", "persisted", "sociedad"], "vat-settings");
    checkBadge(settings.sociedad, "vat-settings.sociedad");
    assert.equal(settings.sociedad.legalEntityId, entityId);
    assert.equal(settings.periodicity, settings.sociedad.regimen.periodicity, "the effective periodicity is the badge's");
    const regime = await ok<{ sociedad: Badge; umbralGranEmpresa: number; propuesta: { regimen: string; cambia: boolean; motivo: string }; volumenOperaciones: number | null; avisos: string[]; year: number }>("/fiscal/regime?year=2026");
    hasKeys(regime, ["organizationId", "year", "sociedad", "vatSettings", "volumenOperaciones", "umbralGranEmpresa", "propuesta", "avisos", "generatedAt"], "regime");
    checkBadge(regime.sociedad, "regime.sociedad");
    assert.equal(regime.umbralGranEmpresa, 6010121.04);
    assert.ok(["general", "gran_empresa"].includes(regime.propuesta.regimen));
    assert.equal(typeof regime.propuesta.cambia, "boolean");
    const badYear = await get<unknown>("/fiscal/regime?year=26");
    assert.equal(badYear.status, 400);
  });

  it("GET /fiscal/models/303: declarante (legacy) + sociedad (badge), casillas, avisos, presentacion; con propertyId la vista parcial avisa «no liquidable»", async (t) => {
    if (!ready(t)) return;
    type Model = { modelo: string; propertyId: string | null; declarante: { nif: string | null; nombre: string | null }; sociedad: Badge; casillas: Array<{ casilla: string | null; importe: number }>; avisos: string[]; presentacion: { modo: string; ficheroOficial: boolean; nota: string; noSePresenta?: { motivo: string } }; periodo: { code: string } };
    const period = "2026-Q3";
    const whole = await get<Model>(`/fiscal/models/303?period=${period}`);
    if (whole.status === 400 && /PERIOD_MISMATCH/.test(whole.text)) return t.skip("the demo sociedad settles monthly right now (a sister suite may have flipped its regime)");
    assert.equal(whole.status, 200, whole.text.slice(0, 300));
    hasKeys(whole.body, ["modelo", "titulo", "organizationId", "propertyId", "periodo", "declarante", "sociedad", "casillas", "totales", "avisos", "fuentes", "detalle", "presentacion", "generatedAt"], "303");
    checkBadge(whole.body.sociedad, "303.sociedad");
    assert.deepEqual([whole.body.declarante.nif, whole.body.declarante.nombre], [whole.body.sociedad.taxId, whole.body.sociedad.legalName], "legacy pair = badge");
    assert.equal(whole.body.propertyId, null);
    assert.deepEqual([whole.body.presentacion.modo, whole.body.presentacion.ficheroOficial], ["manual", false]);
    if (whole.body.sociedad.regimen.siiEnabled) assert.ok(whole.body.presentacion.noSePresenta === undefined, "the 303 is always filed");
    const partial = await ok<Model>(`/fiscal/models/303?period=${period}&propertyId=prop_123`);
    assert.equal(partial.propertyId, "prop_123");
    assert.ok(partial.avisos.some((aviso) => /no liquidable/i.test(aviso)), `partial view warns: ${partial.avisos.join(" | ")}`);
    assert.deepEqual(partial.sociedad.legalEntityId, whole.body.sociedad.legalEntityId, "the declarante never changes with the centre");
    for (const modelo of ["347", "390"]) {
      const annual = await ok<Model>(`/fiscal/models/${modelo}?year=2026`);
      checkBadge(annual.sociedad, `${modelo}.sociedad`);
      if (annual.sociedad.regimen.siiEnabled) assert.match(annual.presentacion.noSePresenta?.motivo ?? "", /SII/, `${modelo} no se presenta under the SII`);
      else assert.equal(annual.presentacion.noSePresenta, undefined, `${modelo} is filed outside the SII`);
    }
  });

  it("GET /accounting/usali/compare?includeCorporate=1: entity, corporate (null sin oficina), unassigned, rollup[] con ok; allocation solo con &allocation=; propertyKind/propertyCode por columna", async (t) => {
    if (!ready(t)) return;
    type Compare = { kind: string; entity?: Record<string, unknown>; properties: Array<{ propertyId: string; propertyKind?: string; propertyCode?: string | null; pnl: Record<string, unknown>; allocation?: unknown }>; consolidated: Record<string, unknown>; corporate?: { centres: unknown[]; pnl: unknown } | null; unassigned?: Record<string, unknown>; rollup?: Array<{ metric: string; label: string; hotels: string; corporate: string; unassigned: string; total: string; ok: boolean }>; allocation?: Record<string, unknown> | null };
    const range = "from=2026-07-01&to=2026-09-30";
    const body = await ok<Compare>(`/accounting/usali/compare?${range}&includeCorporate=1`);
    assert.equal(body.kind, "usali_compare_properties");
    hasKeys(body, ["entity", "corporate", "unassigned", "rollup"], "includeCorporate adds the L7 blocks");
    checkEntityBadge(body.entity as Record<string, unknown>, "compare.entity");
    assert.ok(body.properties.every((p) => p.propertyKind === "hotel"), "with includeCorporate the columns are the hotels");
    assert.ok(body.properties.every((p) => "propertyCode" in p));
    const offices = await prisma.property.count({ where: { organizationId: ORG, kind: { in: ["office", "other"] } } });
    if (offices === 0) assert.equal(body.corporate, null, "no office → corporate column null");
    else assert.ok(body.corporate && Array.isArray(body.corporate.centres));
    assert.ok(Array.isArray(body.rollup) && body.rollup.length >= 1);
    for (const line of body.rollup!) {
      assert.deepEqual(keysOf(line), ["corporate", "hotels", "label", "metric", "ok", "total", "unassigned"]);
      for (const key of ["hotels", "corporate", "unassigned", "total"] as const) assert.match(line[key], MONEY, `rollup ${line.metric}.${key} is MoneyString`);
      assert.equal(line.ok, true, `rollup ${line.metric}: Total sociedad = Σ hoteles + Oficina + sin asignar`);
    }
    assert.ok(body.allocation === undefined || body.allocation === null, "no allocation row without &allocation=");
    const allocated = await ok<Compare>(`/accounting/usali/compare?${range}&includeCorporate=1&allocation=revenue`);
    assert.ok("allocation" in allocated, "allocation row present with &allocation=");
    if (allocated.allocation) {
      hasKeys(allocated.allocation, ["method", "corporateCost", "allocated", "shares", "applied", "label", "basis", "basisLabel", "posted", "warnings"], "CorporateAllocationResult");
      assert.deepEqual([allocated.allocation.label, allocated.allocation.posted, allocated.allocation.basis], ["Reparto corporativo (informativo · no contabilizado)", false, "usali_corporate_gop"]);
      assert.match(String(allocated.allocation.corporateCost), MONEY);
    }
    const plain = await ok<Compare>(`/accounting/usali/compare?${range}`);
    assert.ok(!("rollup" in plain) && !("corporate" in plain), "without the flag the legacy response is intact");
    const strict = await get<unknown>(`/accounting/usali/compare?${range}&allocation=banana`);
    assert.equal(strict.status, 400);
  });

  /** FinanceEntityBadge (financial-statements-types.ts): the sociedad as the statements label it (no regime block). */
  const checkEntityBadge = (badge: Record<string, unknown>, label: string): void => {
    assert.deepEqual(keysOf(badge), ["code", "largeCompany", "legalEntityId", "legalForm", "legalName", "pgcVariant", "siiEnabled", "source", "taxId", "taxIdValid"], label);
    assert.ok(["legal_entity", "organization_fallback"].includes(String(badge.source)), `${label}.source`);
    assert.equal(badge.legalEntityId, entityId, `${label}.legalEntityId`);
  };

  it("GET /accounting/pnl/by-property (vista «Por centro»): entity (FinanceEntityBadge), properties (FinanceWorkCentre), rows con byProperty / unassigned / total y reconciliation", async (t) => {
    if (!ready(t)) return;
    type Pnl = { kind: string; entity: Record<string, unknown>; properties: Array<Record<string, unknown>>; rows: Array<{ accountCode: string; label: string; kind: string; byProperty: Record<string, string>; unassigned: string; total: string }>; revenue: Record<string, unknown>; expense: Record<string, unknown>; reconciliation: { ok: boolean }; period: { from: string; to: string } };
    const body = await ok<Pnl>("/accounting/pnl/by-property?from=2026-07-01&to=2026-09-30");
    assert.equal(body.kind, "pnl_by_property");
    checkEntityBadge(body.entity, "pnl.entity");
    assert.match(body.period.from, ISO_DAY);
    for (const property of body.properties) hasKeys(property, ["propertyId", "code", "name", "tradeName", "kind"], "FinanceWorkCentre");
    const ids = body.properties.map((p) => p.propertyId as string);
    for (const row of body.rows) {
      assert.ok(["income", "expense"].includes(row.kind));
      assert.deepEqual(Object.keys(row.byProperty).sort(), [...ids].sort(), `row ${row.accountCode} has a column per centre (zeros included)`);
      for (const value of Object.values(row.byProperty)) assert.match(value, MONEY);
      assert.match(row.unassigned, MONEY);
      assert.match(row.total, MONEY);
    }
    assert.equal(body.reconciliation.ok, true);
    const strict = await get<unknown>("/accounting/pnl/by-property?from=2026-07-01");
    assert.equal(strict.status, 400, "to is required");
  });

  it("GET /accounting/annual-accounts y /memoria: entityLabel, entity, format { depositable, reason }, memoria.entity.properties[] con code y kind", async (t) => {
    if (!ready(t)) return;
    type Annual = { entityLabel?: string; entity?: Record<string, unknown>; format?: { template: string; pgcVariant: string; depositable: boolean; reason: string | null }; warnings?: string[] };
    const range = "from=2026-01-01&to=2026-12-31";
    const annual = await ok<Annual>(`/accounting/annual-accounts?${range}`);
    assert.equal(typeof annual.entityLabel, "string", "entityLabel = razón social · NIF");
    assert.ok(annual.format, "format block");
    assert.deepEqual(keysOf(annual.format), ["depositable", "pgcVariant", "reason", "template"]);
    assert.equal(annual.format!.template, "pgc_pymes_hotelero_v1");
    assert.equal(annual.format!.depositable, annual.format!.reason === null, "reason only when not depositable");
    type Memoria = { kind: string; entity: { name: string; legalName: string | null; taxId: string | null; legalEntityId?: string | null; code?: string | null; properties: Array<{ id: string; code: string | null; name: string; kind: string; address: string | null }> }; format?: unknown; notes: unknown[] };
    const memoria = await ok<Memoria>(`/accounting/annual-accounts/memoria?${range}`);
    assert.equal(memoria.kind, "memoria");
    hasKeys(memoria.entity, ["name", "legalName", "taxId", "properties"], "memoria.entity");
    assert.equal(memoria.entity.legalEntityId, entityId);
    assert.ok(memoria.entity.properties.length >= 1, "the memoria lists the establishments");
    for (const establishment of memoria.entity.properties) {
      hasKeys(establishment, ["id", "code", "name", "kind", "address"], "MemoriaEstablishment");
      assert.ok(PROPERTY_KINDS.includes(establishment.kind as never));
    }
  });

  it("GET /treasury/position?scope=entity (ámbito Sociedad): scope, propertyId null, legalEntityId, entityLabel, banks[].propertyId; sin scope → un centro", async (t) => {
    if (!ready(t)) return;
    type Position = { scope: string; propertyId: string | null; legalEntityId: string | null; entityLabel: string; banks: Array<Record<string, unknown>> };
    const entity = await ok<Position>("/treasury/position?scope=entity");
    hasKeys(entity, ["scope", "propertyId", "legalEntityId", "entityLabel", "banks"], "position (entity)");
    assert.deepEqual([entity.scope, entity.propertyId, entity.legalEntityId], ["entity", null, entityId]);
    assert.equal(typeof entity.entityLabel, "string");
    for (const bank of entity.banks) assert.ok("propertyId" in bank, "every bank names its centre (or null = sociedad)");
    const centre = await ok<Position>("/treasury/position?propertyId=prop_123");
    assert.deepEqual([centre.scope, centre.propertyId], ["property", "prop_123"]);
    const strict = await get<unknown>("/treasury/position?scope=banana");
    assert.equal(strict.status, 400);
  });

  it("GET /invoices/:id (Facturación y cobros): issuer { legalEntityId, taxId, legalName, fiscalAddress, establishment { code, tradeName, addressLine }, verifactuExclusion }", async (t) => {
    if (!ready(t)) return;
    const issued = await prisma.invoice.findFirst({ where: { propertyId: { in: ORG_PROPERTIES }, status: "issued" }, orderBy: { issuedAt: "desc" }, select: { id: true, propertyId: true } });
    if (!issued) return t.skip("org_123 has no issued invoice right now");
    type Invoice = { id: string; issuer?: Record<string, unknown> & { establishment: Record<string, unknown> | null } };
    const body = await ok<Invoice>(`/invoices/${issued.id}`);
    assert.ok(body.issuer, "issuer block");
    hasKeys(body.issuer, ["legalEntityId", "taxId", "legalName", "establishment", "verifactuExclusion"], "issuer");
    const sociedad = await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId }, select: { fiscalAddress: true } });
    assert.equal("fiscalAddress" in body.issuer!, sociedad.fiscalAddress !== null, "fiscalAddress travels when the sociedad has a domicilio fiscal (omitted otherwise)");
    assert.equal(body.issuer!.legalEntityId, entityId, "the issuer is the sociedad of the demo tenant");
    assert.ok(body.issuer!.establishment, "establishment block (RD 1619/2012 art. 6.1)");
    hasKeys(body.issuer!.establishment, ["code", "tradeName", "addressLine"], "issuer.establishment");
    assert.ok(body.issuer!.verifactuExclusion === null || typeof (body.issuer!.verifactuExclusion as { code?: string }).code === "string");
  });

  it("errores tipados del ámbito: propertyId ajeno → 404 opaco «Propiedad no encontrada.» (o el informe del otro tenant para el admin de plataforma); los códigos de la capa viven en LEDGER_ERROR_CODES", async (t) => {
    if (!ready(t)) return;
    const settings = await ok<{ periodicity: string }>("/fiscal/vat-settings");
    const period = settings.periodicity === "monthly" ? "2026-07" : "2026-Q3";
    const me = await ok<{ isPlatformAdmin: boolean }>("/users/me");
    const foreign = await get<{ organizationId?: string; propertyId?: string | null; message?: string; details?: { code?: string } }>(`/fiscal/models/303?period=${period}&propertyId=cmrhw9jy40003fyvbuu2ec2w7`);
    if (me.isPlatformAdmin) {
      // The global tenant hook re-points a PLATFORM admin to the property's organization (console use): the report is Faranda's, never a mix.
      assert.equal(foreign.status, 200, foreign.text.slice(0, 200));
      assert.deepEqual([foreign.body.organizationId, foreign.body.propertyId], ["cmrhw9jy30002fyvb6tsdiugt", "cmrhw9jy40003fyvbuu2ec2w7"]);
    } else {
      assert.equal(foreign.status, 404, foreign.text.slice(0, 200));
      assert.equal(foreign.body.message, "Propiedad no encontrada.");
      assert.doesNotMatch(foreign.text, /Faranda|Rías Altas/, "no oracle of the other tenant");
    }
    // The ledger codes the front maps (FINANCE_ERROR_MESSAGES) are exported from @hotelos/shared.
    for (const code of ["PROPERTY_NOT_FOUND", "JOURNAL_ENTRY_NOT_FOUND", "WORK_CENTER_REQUIRED", "FISCAL_YEAR_CLOSED"]) {
      assert.ok((shared.LEDGER_ERROR_CODES as readonly string[]).includes(code), `LEDGER_ERROR_CODES has ${code}`);
    }
  });
});
