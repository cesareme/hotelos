import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { normalizeTenantSummary, platformTotals, type TenantSummaryDto } from "../tenant-admin-contracts.ts";

// Pure tests: no network, no api-client (import.meta.env is not available
// under node --test). The fixture mirrors GET /admin/tenants of the local
// demo on 2026-09-16 (qa#5, fix:10-A): the API nests the figures under
// `counts`, the screens read them flat.

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const code = (source: string) => source.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const FARANDA: TenantSummaryDto = {
  organizationId: "cmrhw9jy30002fyvb6tsdiugt",
  name: "Faranda Hotels & Resorts",
  legalName: "CELUISMA S.A.",
  country: "ES",
  createdAt: "2026-07-12T14:34:11.643Z",
  status: "active",
  plan: "starter",
  counts: { properties: 8, users: 2, modulesEnabled: 0 },
  lastActivityAt: "2026-09-16T15:04:05.406Z"
};

const DEMO: TenantSummaryDto = {
  organizationId: "org_123",
  name: "Grupo Hotelero Demo",
  legalName: "Grupo Hotelero Demo SL",
  country: "ES",
  createdAt: "2026-07-12T02:28:16.755Z",
  status: "active",
  plan: "starter",
  counts: { properties: 2, users: 1, modulesEnabled: 0 },
  lastActivityAt: "2026-09-16T13:18:58.616Z"
};

describe("tenant-admin-contracts · normalizeTenantSummary", () => {
  it("flattens the API `counts` block into propertiesCount / usersCount (qa#5)", () => {
    const row = normalizeTenantSummary(FARANDA);
    assert.equal(row.propertiesCount, 8);
    assert.equal(row.usersCount, 2);
    // The rest of the row is untouched (the raw block stays for fidelity).
    assert.equal(row.name, "Faranda Hotels & Resorts");
    assert.deepEqual(row.counts, { properties: 8, users: 2, modulesEnabled: 0 });
  });

  it("keeps the flat figures of older API builds when `counts` is absent", () => {
    const row = normalizeTenantSummary({ ...DEMO, counts: undefined, propertiesCount: 3, usersCount: 4 });
    assert.equal(row.propertiesCount, 3);
    assert.equal(row.usersCount, 4);
  });

  it("prefers `counts` over the legacy flat fields when both come", () => {
    const row = normalizeTenantSummary({ ...DEMO, propertiesCount: 99, usersCount: 99 });
    assert.equal(row.propertiesCount, 2);
    assert.equal(row.usersCount, 1);
  });

  it("falls back to 0 for the list and to the caller's fallback for the detail", () => {
    const bare = { ...DEMO, counts: null };
    assert.deepEqual([normalizeTenantSummary(bare).propertiesCount, normalizeTenantSummary(bare).usersCount], [0, 0]);
    const detail = normalizeTenantSummary(bare, { properties: 2, users: 1 });
    assert.deepEqual([detail.propertiesCount, detail.usersCount], [2, 1]);
  });

  it("ignores figures that are not non-negative numbers", () => {
    const row = normalizeTenantSummary({ ...DEMO, counts: { properties: Number.NaN, users: -1 } as unknown as TenantSummaryDto["counts"], propertiesCount: 5 });
    assert.equal(row.propertiesCount, 5);
    assert.equal(row.usersCount, 0);
  });
});

describe("tenant-admin-contracts · platformTotals", () => {
  it("sums the flattened rows for the Plataforma KPIs", () => {
    const rows = [FARANDA, DEMO, { ...DEMO, organizationId: "org_trial", status: "trial", counts: { properties: 1, users: 1 } }].map((row) => normalizeTenantSummary(row));
    assert.deepEqual(platformTotals(rows), { organizations: 3, activeOrganizations: 2, properties: 11, users: 4 });
  });

  it("is zero for an empty list", () => {
    assert.deepEqual(platformTotals([]), { organizations: 0, activeOrganizations: 0, properties: 0, users: 0 });
  });
});

describe("tenant-admin-contracts · wiring", () => {
  it("tenantAdminApi normalises the list and the detail through normalizeTenantSummary", () => {
    const api = code(read("tenantAdminApi.ts"));
    assert.match(api, /export async function fetchTenants\(\)[\s\S]*?normalizeTenantSummary\(row\)/, "fetchTenants must flatten each row");
    assert.match(api, /export async function fetchTenantDetail\([\s\S]*?normalizeTenantSummary\(detail, \{ properties: properties\.length, users: users\.length \}\)/, "fetchTenantDetail must fall back to the arrays");
    assert.doesNotMatch(api, /^export type TenantSummary = \{/m, "the summary type lives in tenant-admin-contracts.ts");
  });

  it("the console reads the flat figures and derives the KPIs with platformTotals", () => {
    const screen = code(readFileSync(new URL("../../screens/admin/TenantAdminConsoleScreen.tsx", import.meta.url), "utf8"));
    assert.match(screen, /platformTotals\(tenants\)/);
    assert.match(screen, /row\.propertiesCount/);
    assert.match(screen, /row\.usersCount/);
    assert.doesNotMatch(screen, /\.counts\b/, "the screen never reaches into the raw counts block");
  });
});
