// RBAC por departamento (Tanda 8a · L1) · request schemas of the rbac routes.
//
// Every body / query is `.strict()` (an unknown key is a 400 in Spanish through
// parseOr400 of rate-manager/rate-grid.schemas.ts) and every amount travels as a
// decimal STRING (never a float), like the finance modules.

import { z } from "zod";
import { APPROVAL_KINDS, APPROVAL_STATUSES, ROLE_LEVELS, SCOPE_TYPES, THRESHOLD_ACTIONS, THRESHOLD_TIERS } from "@hotelos/shared";

const id = z.string().trim().min(1).max(64);
const reason = z.string().trim().min(1).max(500);
const isoDateTime = z.string().datetime({ offset: true });
/** Money as a decimal string with at most 2 decimals, ≥ 0 (never a float). */
export const moneyString = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "importe decimal con hasta 2 decimales");
const pctString = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "porcentaje con hasta 2 decimales");
/** `true|false|1|0` query flags. */
const boolQuery = z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1");
const limitQuery = z.coerce.number().int().min(1).max(500).optional();
const offsetQuery = z.coerce.number().int().min(0).optional();

// ── Assignments ─────────────────────────────────────────────────────────────

export const AssignmentListQuerySchema = z
  .object({ userId: id.optional(), propertyId: id.optional(), scopeType: z.enum(SCOPE_TYPES).optional(), includeRevoked: boolQuery.optional() })
  .strict();

/**
 * `scopeRef` is the id of the property / group / legal entity of the scope
 * (omitted for `organization`). The field is NOT called `propertyId` on
 * purpose: the global scope hook / tenant guard read `body.propertyId`, and
 * an assignment to a property outside the caller's scope must answer
 * 403 RBAC_SCOPE_EXCEEDED from the service, not the opaque 404 of the guard.
 */
export const AssignmentCreateSchema = z
  .object({
    userId: id,
    roleId: id,
    scopeType: z.enum(SCOPE_TYPES),
    scopeRef: id.optional(),
    reason: reason.optional(),
    validTo: isoDateTime.optional()
  })
  .strict();

export const AssignmentRevokeBodySchema = z.object({ reason: reason.optional() }).strict();
export const AssignmentRevokeQuerySchema = z.object({ reason: reason.optional() }).strict();

export const UsersInScopeQuerySchema = z.object({ scopeType: z.enum(SCOPE_TYPES).optional(), ref: id.optional() }).strict();

// ── Roles ───────────────────────────────────────────────────────────────────

export const RoleCreateSchema = z.object({ name: z.string().trim().min(2).max(80), templateKey: z.string().trim().min(1).max(40) }).strict();
export const RolePermissionsPatchSchema = z.object({ remove: z.array(z.string().trim().min(1).max(80)).min(1).max(300) }).strict();

// ── Property groups ─────────────────────────────────────────────────────────

const groupCode = z.string().trim().regex(/^[A-Z0-9_-]{2,16}$/, "código de 2 a 16 caracteres A-Z, 0-9, _ o -");
export const PropertyGroupCreateSchema = z.object({ code: groupCode, name: z.string().trim().min(2).max(80), propertyIds: z.array(id).max(200).default([]) }).strict();
export const PropertyGroupPatchSchema = z
  .object({ code: groupCode.optional(), name: z.string().trim().min(2).max(80).optional(), propertyIds: z.array(id).max(200).optional() })
  .strict()
  .refine((value) => value.code !== undefined || value.name !== undefined || value.propertyIds !== undefined, { message: "Sin cambios que aplicar." });

// ── Thresholds ──────────────────────────────────────────────────────────────

export const ThresholdRoleLimitSchema = z
  .object({
    roleId: id.optional(),
    level: z.enum(ROLE_LEVELS).optional(),
    action: z.enum(THRESHOLD_ACTIONS),
    tier: z.enum(THRESHOLD_TIERS),
    maxAmount: moneyString.optional(),
    maxPct: pctString.optional(),
    requiresSecondApproval: z.boolean().optional()
  })
  .strict()
  .refine((value) => (value.roleId ? !value.level : Boolean(value.level)), { message: "Indica roleId o level, nunca ambos." });

export const ThresholdsPutSchema = z
  .object({
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    T1: moneyString,
    T2: moneyString,
    T3: moneyString,
    T4: moneyString,
    secondApprovalAmount: moneyString.optional(),
    rateBandPct: pctString.optional(),
    discountPctT1: pctString.optional(),
    discountPctT2: pctString.optional(),
    roleLimits: z.array(ThresholdRoleLimitSchema).max(200).optional(),
    confirmHighRisk: z.literal(true, { errorMap: () => ({ message: "confirmHighRisk debe ser true." }) })
  })
  .strict();

// ── Approvals ───────────────────────────────────────────────────────────────

export const ApprovalsListQuerySchema = z
  .object({ status: z.enum(APPROVAL_STATUSES).optional(), kind: z.enum(APPROVAL_KINDS).optional(), limit: limitQuery })
  .strict();

export const ApprovalRequestSchema = z
  .object({
    kind: z.enum(APPROVAL_KINDS),
    entityType: z.string().trim().min(1).max(64),
    entityId: id,
    propertyId: id.nullable(),
    amount: moneyString.nullable().optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    reasonCode: z.string().trim().min(1).max(64),
    reasonText: z.string().trim().max(1000).optional(),
    payload: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const ApprovalDecisionSchema = z.object({ note: z.string().trim().max(1000).optional() }).strict();

// ── Supervisor PIN ──────────────────────────────────────────────────────────

const pin = z.string().regex(/^\d{4,8}$/, "PIN de 4 a 8 dígitos");
export const PinSetSchema = z.object({ password: z.string().min(1).max(200), pin }).strict();
export const SupervisorAuthorizeSchema = z
  .object({
    authorizerEmail: z.string().trim().email().max(200),
    pin,
    permissionKey: z.string().trim().min(1).max(80),
    entityType: z.string().trim().min(1).max(64),
    entityId: id,
    propertyId: id,
    amount: moneyString.optional(),
    reasonCode: z.string().trim().min(1).max(64)
  })
  .strict();

// ── Break glass ─────────────────────────────────────────────────────────────

export const BreakGlassOpenSchema = z
  .object({
    reason: reason,
    ticket: z.string().trim().max(120).optional(),
    password: z.string().min(1).max(200).optional(),
    confirmHighRisk: z.boolean().optional(),
    mfaChallengeId: id.optional(),
    code: z.string().trim().regex(/^\d{6}$/).optional()
  })
  .strict();

// ── Reports ─────────────────────────────────────────────────────────────────

export const AccessLogQuerySchema = z
  .object({ from: isoDateTime.optional(), to: isoDateTime.optional(), userId: id.optional(), action: z.string().trim().min(1).max(64).optional(), limit: limitQuery, offset: offsetQuery })
  .strict();
