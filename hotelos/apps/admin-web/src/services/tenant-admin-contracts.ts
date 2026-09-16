// Tenant-admin contracts — Configuración › Sistema › Organizaciones.
//
// Pure helpers shared by services/tenantAdminApi.ts and its unit test: the
// wire shape of GET /admin/tenants and GET /admin/tenants/:orgId
// (apps/api/src/modules/admin-console/tenant-admin.service.ts) and the
// normalisation to the flat `propertiesCount` / `usersCount` the console
// table, its drawer, the platform KPIs and the detail screen read. No
// api-client import on purpose: import.meta.env is not available under
// node --test.
//
// qa#5 (fix:10-A): the API nests the figures under `counts`
// ({ properties, users, modulesEnabled }) while the client declared them
// flat, so the list painted «Centros 0 · Usuarios 0» and the platform KPIs
// summed 0 for every organization; the detail screen counted its arrays and
// showed the real values. The normaliser prefers `counts`, then the flat
// fields of older API builds, then the fallback the caller knows (0 for the
// list, the array lengths for the detail).

export type TenantStatus = "active" | "suspended" | "trial" | "archived" | string;

/** `counts` block of the API summary (tenant-admin.service TenantSummary.counts). */
export type TenantCounts = {
  properties?: number;
  users?: number;
  modulesEnabled?: number;
};

/** One row of GET /admin/tenants as the API sends it. */
export type TenantSummaryDto = {
  organizationId: string;
  name: string;
  legalName?: string;
  country: string;
  createdAt: string;
  status: TenantStatus;
  plan: string;
  counts?: TenantCounts | null;
  lastActivityAt?: string;
  /** Flat figures of older API builds; `counts` wins when both come. */
  propertiesCount?: number;
  usersCount?: number;
};

/** Row as the screens read it: the flat figures are always numbers. */
export type TenantSummary = TenantSummaryDto & {
  propertiesCount: number;
  usersCount: number;
};

/** Platform totals derived from the list (the only figures the admin API exposes). */
export type PlatformTotals = {
  organizations: number;
  activeOrganizations: number;
  properties: number;
  users: number;
};

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

/**
 * Flat figures of a tenant row: `counts.*` first, then the legacy flat fields,
 * then the caller's fallback (default 0). The rest of the row is kept as is.
 */
export function normalizeTenantSummary<T extends TenantSummaryDto>(row: T, fallback: { properties?: number; users?: number } = {}): T & TenantSummary {
  const counts = row.counts ?? undefined;
  return {
    ...row,
    propertiesCount: asCount(counts?.properties) ?? asCount(row.propertiesCount) ?? fallback.properties ?? 0,
    usersCount: asCount(counts?.users) ?? asCount(row.usersCount) ?? fallback.users ?? 0
  };
}

/** Totals of the Plataforma view: organizations, active ones, centres and users. */
export function platformTotals(rows: ReadonlyArray<Pick<TenantSummary, "status" | "propertiesCount" | "usersCount">>): PlatformTotals {
  return rows.reduce<PlatformTotals>(
    (acc, row) => ({
      organizations: acc.organizations + 1,
      activeOrganizations: acc.activeOrganizations + (row.status === "active" ? 1 : 0),
      properties: acc.properties + (asCount(row.propertiesCount) ?? 0),
      users: acc.users + (asCount(row.usersCount) ?? 0)
    }),
    { organizations: 0, activeOrganizations: 0, properties: 0, users: 0 }
  );
}
