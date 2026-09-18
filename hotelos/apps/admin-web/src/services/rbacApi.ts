// RBAC por departamento, nivel y ámbito (Tanda 8a · L4): the /rbac/* and the
// backoffice user routes consumed by Configuración › Usuarios y roles and by
// the supervisor PIN dialog. Every call goes through `apiRequest` (session,
// tenant, `x-property-id`, 401 handling); the wire DTOs come from
// packages/shared/src/rbac-types.ts and the 4xx codes are mapped to the
// Spanish messages of RBAC_ERROR_MESSAGES_ES (`rbacErrorMessage`).
//
// Routes (apps/api/src/modules/rbac/rbac.routes.ts, permissions in its
// route-permissions.partial.ts): GET /rbac/users (users.read), GET/POST/DELETE
// /rbac/assignments (users.read / users.assign), GET /rbac/roles (roles.manage),
// GET /rbac/property-groups (organization.structure.manage), POST /rbac/pin
// (own password), POST /rbac/supervisor-authorizations (the authorizer's key).
// The role catalogue a hotel director may pick from is the property roles of
// the backoffice (`GET /backoffice/properties/:id/roles`, users.invite): the
// /rbac/roles listing needs roles.manage, which only the system administrator holds.

import {
  RBAC_ERROR_MESSAGES_ES,
  type PermissionKey,
  type PropertyGroupDto,
  type RbacUserRowDto,
  type RoleKey,
  type RoleLevel,
  type ScopeType,
  type SupervisorAuthorizationDto,
  type UserRoleAssignmentDto
} from "@hotelos/shared";
import { ApiError, apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";

// ----------------------------------------------------------------- DTOs of the non-shared routes

/** Row of GET /backoffice/properties/:propertyId/roles (backoffice.service.ts PropertyRoleView). */
export type PropertyRoleDto = {
  id: string;
  name: string;
  templateKey: string | null;
  permissionsCount: number;
  level: RoleLevel | null;
  department: string | null;
  templateVersion: number;
  managed: boolean;
};

/** Row of GET /rbac/roles (assignments.service.ts RbacRoleSummary): the keys travel with the role. */
export type RbacRoleSummaryDto = {
  id: string;
  name: string;
  templateKey: RoleKey | null;
  level: RoleLevel | null;
  department: string | null;
  managed: boolean;
  templateVersion: number;
  permissionCount: number;
  permissions: PermissionKey[];
};

export type ListUsersInScopeInput = {
  scopeType?: ScopeType;
  /** Id of the property / group / sociedad the scope points at (omitted for organisation). */
  ref?: string;
};

export type ListAssignmentsInput = {
  userId?: string;
  propertyId?: string;
  scopeType?: ScopeType;
  includeRevoked?: boolean;
};

export type CreateAssignmentInput = {
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  /** Id of the property / group / sociedad (omitted for organisation). */
  scopeRef?: string;
  reason?: string;
  /** ISO date-time with offset. */
  validTo?: string;
};

export type InviteWithScopeInput = {
  email: string;
  fullName: string;
  phone?: string;
  roleId: string;
  mfaRequired?: boolean;
  scopeType?: ScopeType;
  scopeRef?: string;
};

/** Answer of POST …/users/invite (backoffice.service.ts inviteBackOfficeUser); the link only travels here. */
export type InviteWithScopeResult = {
  user: { id: string; email: string; fullName: string; status: string; roleId: string; roleName: string; scopeType: ScopeType; scopeRef: string; assignmentId: string };
  invitation: { inviteUrl: string; expiresAt: string; delivery?: { status: string; error?: string | null } };
};

export type SupervisorAuthorizeInput = {
  authorizerEmail: string;
  pin: string;
  permissionKey: string;
  entityType: string;
  entityId: string;
  propertyId: string;
  /** Decimal string with at most two decimals. */
  amount?: string;
  reasonCode: string;
};

// ----------------------------------------------------------------- reads

export async function listUsersInScope(input: ListUsersInScopeInput = {}): Promise<RbacUserRowDto[]> {
  const query: Record<string, string | undefined> = { scopeType: input.scopeType, ref: input.ref };
  const rows = await apiRequest<unknown>("/rbac/users", { query });
  return toArray<RbacUserRowDto>(rows);
}

export async function listAssignments(input: ListAssignmentsInput = {}): Promise<UserRoleAssignmentDto[]> {
  const query: Record<string, string | undefined> = {
    userId: input.userId,
    propertyId: input.propertyId,
    scopeType: input.scopeType,
    includeRevoked: input.includeRevoked === undefined ? undefined : input.includeRevoked ? "true" : "false"
  };
  const rows = await apiRequest<unknown>("/rbac/assignments", { query });
  return toArray<UserRoleAssignmentDto>(rows);
}

/** Roles of the property's organisation the caller may hand out (users.invite): the invite / change-role catalogue. */
export async function listAssignableRoles(propertyId: string): Promise<PropertyRoleDto[]> {
  const rows = await apiRequest<unknown>(`/backoffice/properties/${encodeURIComponent(propertyId)}/roles`);
  return toArray<PropertyRoleDto>(rows);
}

/** Roles with their keys (roles.manage): the comparator falls back to the shared templates when this answers 403. */
export async function listRbacRoles(): Promise<RbacRoleSummaryDto[]> {
  const rows = await apiRequest<unknown>("/rbac/roles");
  return toArray<RbacRoleSummaryDto>(rows);
}

/** Property groups of the organisation (organization.structure.manage); `[]` when the caller may not read them. */
export async function listPropertyGroupsIfAllowed(): Promise<PropertyGroupDto[]> {
  try {
    const rows = await apiRequest<unknown>("/rbac/property-groups");
    return toArray<PropertyGroupDto>(rows);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return [];
    throw error;
  }
}

// ----------------------------------------------------------------- writes

export function createAssignment(input: CreateAssignmentInput): Promise<UserRoleAssignmentDto> {
  return apiRequest<UserRoleAssignmentDto>("/rbac/assignments", { method: "POST", body: input });
}

export function revokeAssignment(id: string, reason?: string): Promise<UserRoleAssignmentDto> {
  return apiRequest<UserRoleAssignmentDto>(`/rbac/assignments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: reason ? { reason } : undefined,
    query: reason ? { reason } : undefined
  });
}

export function inviteUserWithScope(propertyId: string, input: InviteWithScopeInput): Promise<InviteWithScopeResult> {
  return apiRequest<InviteWithScopeResult>(`/backoffice/properties/${encodeURIComponent(propertyId)}/users/invite`, { method: "POST", body: input });
}

export function disableUser(propertyId: string, userId: string): Promise<unknown> {
  return apiRequest<unknown>(`/backoffice/properties/${encodeURIComponent(propertyId)}/users/${encodeURIComponent(userId)}/disable`, { method: "POST" });
}

/** The signed-in user sets their own supervisor PIN (re-authenticates with the password). */
export function setOwnPin(input: { password: string; pin: string }): Promise<{ userId: string; pinUpdatedAt: string }> {
  return apiRequest<{ userId: string; pinUpdatedAt: string }>("/rbac/pin", { method: "POST", body: input });
}

/** A present supervisor authorises ONE action with their PIN (design §5.6); the id travels as `supervisorAuthorizationId`. */
export function requestSupervisorAuthorization(input: SupervisorAuthorizeInput): Promise<SupervisorAuthorizationDto> {
  return apiRequest<SupervisorAuthorizationDto>("/rbac/supervisor-authorizations", { method: "POST", body: input });
}

// ----------------------------------------------------------------- errors

/** `details.code` of a typed 4xx answer, or null. */
export function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null) return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Spanish message for a failed RBAC call: the catalogue message of the
 * `details.code` (403 RBAC_LEVEL_EXCEEDED, 409 RBAC_SOD_CONFLICT…), then the
 * API message, then the fallback.
 */
export function rbacErrorMessage(error: unknown, fallback = "No se ha podido completar la operación."): string {
  const code = errorCodeOf(error);
  if (code && code in RBAC_ERROR_MESSAGES_ES) return RBAC_ERROR_MESSAGES_ES[code as keyof typeof RBAC_ERROR_MESSAGES_ES];
  if (error instanceof ApiError) {
    if (error.status === 403) return "No tienes permiso para esta operación.";
    if (error.status === 404) return "No encontrado en tu ámbito.";
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
