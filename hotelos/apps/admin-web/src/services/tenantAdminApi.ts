// Frontend client for Tenant Admin endpoints (superadmin / multi-tenant ops).
//
// All requests go through the shared apiRequest helper so they inherit auth,
// breadcrumbs, and the 401 -> session-clear behavior. List responses are
// defensively normalized with toArray so the UI never crashes if the backend
// returns either a raw array or an enveloped { items: [...] } shape.

import { apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";

export type TenantStatus = "active" | "suspended" | "trial" | "archived" | string;

export type TenantSummary = {
  organizationId: string;
  name: string;
  country: string;
  propertiesCount: number;
  usersCount: number;
  status: TenantStatus;
  plan: string;
  createdAt: string;
};

export type TenantDetail = TenantSummary & {
  properties: any[];
  users: any[];
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
  tempPassword: string;
  inviteLink: string;
};

export type ResetTempPasswordResponse = { newPassword: string };

export type ToggleModuleResponse = { ok: boolean };

/** List all tenants (organizations) visible to the current superadmin. */
export async function fetchTenants(): Promise<TenantSummary[]> {
  const res = await apiRequest<unknown>("/admin/tenants");
  return toArray<TenantSummary>(res);
}

/** Full detail for a single tenant: properties, users, modules, activity. */
export function fetchTenantDetail(orgId: string): Promise<TenantDetail> {
  return apiRequest<TenantDetail>(`/admin/tenants/${orgId}`);
}

/** Provision a brand-new tenant org + first property + owner user. */
export function createTenant(payload: CreateTenantPayload): Promise<CreateTenantResponse> {
  return apiRequest<CreateTenantResponse>("/admin/tenants", {
    method: "POST",
    body: payload
  });
}

/** Reset (re-issue) the one-time temp password for a tenant user. */
export function resetTempPassword(orgId: string, userId: string): Promise<ResetTempPasswordResponse> {
  return apiRequest<ResetTempPasswordResponse>(
    `/admin/tenants/${orgId}/users/${userId}/reset-temp-password`,
    { method: "POST" }
  );
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
