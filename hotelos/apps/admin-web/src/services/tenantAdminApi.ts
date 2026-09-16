// Frontend client for Tenant Admin endpoints (superadmin / multi-tenant ops).
//
// All requests go through the shared apiRequest helper so they inherit auth,
// breadcrumbs, and the 401 -> session-clear behavior. List responses are
// defensively normalized with toArray so the UI never crashes if the backend
// returns either a raw array or an enveloped { items: [...] } shape.
//
// Tanda 3 (CFG-P1-6): the owner is onboarded through a persisted invitation
// (POST /admin/tenants returns `invitation` with the real email delivery
// state + copyable link; POST …/reissue-invite mints a new one). The former
// clear-text temp-password flow (`resetTempPassword` → newPassword in a
// toast) is gone from the client on purpose.
//
// qa#5 (fix:10-A): the API nests the figures under `counts`; the list and the
// detail go through normalizeTenantSummary (tenant-admin-contracts.ts) so the
// screens always read flat `propertiesCount` / `usersCount` numbers.

import { apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";
import type { InvitationResult } from "./authApi";
import { normalizeTenantSummary, type TenantSummary, type TenantSummaryDto } from "./tenant-admin-contracts";

export type { TenantCounts, TenantStatus, TenantSummary, TenantSummaryDto, PlatformTotals } from "./tenant-admin-contracts";
export { normalizeTenantSummary, platformTotals } from "./tenant-admin-contracts";

/** Row of `TenantDetail.users` (mirror of tenant-admin.service TenantUserSummary). */
export type TenantUserSummary = {
  id: string;
  email: string;
  fullName: string;
  status: "active" | "invited" | "disabled" | string;
  mfaEnabled?: boolean;
  lastLoginAt?: string;
  createdAt?: string;
  roles: string[];
};

export type TenantDetail = TenantSummary & {
  properties: any[];
  users: TenantUserSummary[];
  modulesEnabled: string[];
  lastActivityAt?: string;
};

export type CreateTenantPayload = {
  name: string;
  country: string;
  plan?: string;
  ownerEmail: string;
  ownerFullName?: string;
  propertyName?: string;
  [key: string]: unknown;
};

export type CreateTenantResponse = {
  organizationId: string;
  propertyId: string;
  ownerUserId: string;
  ownerPermissionsGranted?: number;
  /**
   * Owner invitation: single-use link + how the email actually went out.
   * `inviteLink` is the legacy top-level copy of `invitation.inviteUrl`.
   */
  invitation?: InvitationResult;
  inviteLink?: string;
};

export type ToggleModuleResponse = { ok: boolean };

/** List all tenants (organizations) visible to the current superadmin, with the flat counts normalised. */
export async function fetchTenants(): Promise<TenantSummary[]> {
  const res = await apiRequest<unknown>("/admin/tenants");
  return toArray<TenantSummaryDto>(res).map((row) => normalizeTenantSummary(row));
}

/** Full detail for a single tenant: properties, users, modules, activity (counts fall back to the arrays). */
export async function fetchTenantDetail(orgId: string): Promise<TenantDetail> {
  const detail = await apiRequest<Omit<TenantDetail, "propertiesCount" | "usersCount"> & TenantSummaryDto>(`/admin/tenants/${orgId}`);
  const properties = toArray<any>(detail.properties);
  const users = toArray<TenantUserSummary>(detail.users).map((user) => ({
    ...user,
    roles: toArray<string>(user.roles)
  }));
  return {
    ...normalizeTenantSummary(detail, { properties: properties.length, users: users.length }),
    properties,
    users
  };
}

/** Provision a brand-new tenant org + first property + owner user (invited). */
export function createTenant(payload: CreateTenantPayload): Promise<CreateTenantResponse> {
  return apiRequest<CreateTenantResponse>("/admin/tenants", {
    method: "POST",
    body: payload
  });
}

/**
 * Re-issue the invitation of a tenant user (owner included): revokes previous
 * tokens, mints a new single-use link and re-sends the email. The response
 * says whether the email really went out (`delivery.status === "sent"`) —
 * otherwise the UI must hand over `inviteUrl` by another channel.
 */
export function reissueTenantInvitation(orgId: string, userId: string): Promise<InvitationResult> {
  return apiRequest<InvitationResult>(`/admin/tenants/${orgId}/users/${userId}/reissue-invite`, { method: "POST" });
}

/** Enable or disable a specific module for the tenant. */
export function toggleModule(
  orgId: string,
  moduleCode: string,
  enabled: boolean
): Promise<ToggleModuleResponse> {
  return apiRequest<ToggleModuleResponse>(
    `/admin/tenants/${orgId}/modules/${moduleCode}`,
    { method: "PATCH", body: { enabled } }
  );
}

/** Recent audit-log entries for the tenant (defaults to backend's page size). */
export async function fetchTenantAuditLog(orgId: string, limit?: number): Promise<any[]> {
  const res = await apiRequest<unknown>(`/admin/tenants/${orgId}/audit-log`, {
    query: limit !== undefined ? { limit } : undefined
  });
  return toArray<any>(res);
}

/** Pick the tenant's owner from the detail payload (role name "Owner"), else the first user. */
export function findTenantOwner(users: TenantUserSummary[]): TenantUserSummary | null {
  const byRole = users.find((user) => user.roles.some((role) => /^(owner|propietari[oa])$/i.test(role.trim())));
  return byRole ?? users[0] ?? null;
}
