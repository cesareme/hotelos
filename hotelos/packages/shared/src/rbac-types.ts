// RBAC por departamento, nivel y ámbito (Tanda 8a · L0, 2026-09-18).
//
// Wire contract shared by the API (L1 rbac module, L2 services with
// separation of duties, L3 sync/backfill) and the admin-web (L4 users & roles,
// approvals inbox, supervisor PIN): levels, scopes, thresholds, approval
// kinds, static separation-of-duties pairs, error and audit codes and the
// DTOs the routes of docs/design/RBAC-DEPARTAMENTOS.md §6.3 serve. Design:
// §4.1 (levels × scope), §4.2 (templates), §4.7 (thresholds, SoD), §4.8
// (break glass), §6.1 (data model), §6.6 (audit). Every enum below is
// declared as an `as const` array + literal union so that contract tests
// without TypeScript (tests/rbac-sod-contract.test.mjs) can read the values
// and compare them with the Prisma enums of the same name.
//
// Security notes: nothing here grants anything. `ROLE_LEVEL_RANK` orders the
// levels for the «nivel ≤ propio» rule of role assignment; the thresholds are
// DEFAULTS the organisation overrides in `role_thresholds`; the SoD pairs are
// the static incompatibilities every template must respect (dynamic SoD —
// requester ≠ approver — is enforced by the services and by the CHECK
// constraints of approval_requests).

import type { PermissionKey, RoleKey } from "./types.js";

// ---------------------------------------------------------------------------
// Levels (§4.1) and scopes
// ---------------------------------------------------------------------------

/** Role levels N1-N7 (§4.1). Same values as the Prisma enum RoleLevel. */
export const ROLE_LEVELS = [
  "operative",
  "supervisor",
  "hotel_director",
  "operations_director",
  "general_management",
  "ownership",
  "central_admin"
] as const;
export type RoleLevel = (typeof ROLE_LEVELS)[number];

/**
 * Explicit order of the «nivel ≤ propio» rule: a template of rank r is only
 * assigned by someone holding rank ≥ r in the target scope. central_admin and
 * operations_director share rank 4 (neither outranks the other);
 * general_management (5) is only assigned by general_management, ownership or
 * the platform; ownership (6) only by ownership or the platform.
 */
export const ROLE_LEVEL_RANK: Record<RoleLevel, number> = {
  operative: 1,
  supervisor: 2,
  hotel_director: 3,
  central_admin: 4,
  operations_director: 4,
  general_management: 5,
  ownership: 6
};

/** True when a holder of `actorLevel` may assign / revoke a role of `targetLevel` (rank rule above). */
export function canAssignRoleLevel(actorLevel: RoleLevel, targetLevel: RoleLevel): boolean {
  return ROLE_LEVEL_RANK[actorLevel] >= ROLE_LEVEL_RANK[targetLevel];
}

/** Assignment scopes (§4.1). Same values as the Prisma enum ScopeType. */
export const SCOPE_TYPES = ["property", "property_group", "legal_entity", "organization"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Containment order of the scopes (a wider scope covers the narrower ones). */
export const SCOPE_TYPE_RANK: Record<ScopeType, number> = {
  property: 1,
  property_group: 2,
  legal_entity: 3,
  organization: 4
};

// ---------------------------------------------------------------------------
// Thresholds and approvals (§4.7)
// ---------------------------------------------------------------------------

/** Operations that carry an amount / percentage threshold. Same values as the Prisma enum ThresholdAction. */
export const THRESHOLD_ACTIONS = [
  "folio_adjust",
  "refund",
  "discount",
  "invoice_cancel",
  "day_reopen",
  "rate_change",
  "supplier_bill",
  "purchase_order",
  "payroll",
  "capex",
  "accounting_export"
] as const;
export type ThresholdAction = (typeof THRESHOLD_ACTIONS)[number];

/** Kinds of approval request (maker/checker). Same values as the Prisma enum ApprovalKind. */
export const APPROVAL_KINDS = [
  "refund",
  "folio_adjust",
  "discount",
  "rate_change",
  "supplier_bill",
  "purchase_order",
  "payroll",
  "capex",
  "invoice_cancel",
  "day_reopen"
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Lifecycle of an approval request. Same values as the Prisma enum ApprovalStatus. */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Amount tiers of §4.7 (T1 operative … T4 finance/operations; ABOVE_T4 = general management + ownership). */
export const THRESHOLD_TIERS = ["T1", "T2", "T3", "T4", "ABOVE_T4"] as const;
export type ThresholdTier = (typeof THRESHOLD_TIERS)[number];

export const THRESHOLD_TIER_RANK: Record<ThresholdTier, number> = { T1: 1, T2: 2, T3: 3, T4: 4, ABOVE_T4: 5 };

/**
 * Default amounts of §4.7 (decision D2 of the design: every figure is a
 * parameter per organisation and currency in `role_thresholds`; these are the
 * seed values). Amounts are integers in the organisation currency.
 */
export const DEFAULT_THRESHOLDS = {
  currency: "EUR",
  /** Operative executes with a reason code up to this amount. */
  T1: 50,
  /** Supervisor approves up to this amount. */
  T2: 300,
  /** Hotel director approves up to this amount. */
  T3: 3000,
  /** Finance / operations director approves up to this amount; above it general management. */
  T4: 15000,
  /** Supplier bills above this amount need a second approver of level ownership. */
  secondApprovalAmount: 60000,
  secondApprovalLevel: "ownership" as RoleLevel,
  secondApprovalAction: "supplier_bill" as ThresholdAction,
  /** Rate changes within ± this % of BAR are «dentro de banda» (hotel director, revenue). */
  rateBandPct: 15,
  /** Reservation discount an operative may apply with a reason code. */
  discountPctT1: 10,
  /** Reservation discount a supervisor may approve. */
  discountPctT2: 25
} as const;

/** Tier an amount falls into with the given limits (`amount ≤ T1 → T1`, … , `> T4 → ABOVE_T4`). */
export function thresholdTierForAmount(
  amount: number,
  limits: { T1: number; T2: number; T3: number; T4: number } = DEFAULT_THRESHOLDS
): ThresholdTier {
  if (!Number.isFinite(amount) || amount < 0) return "ABOVE_T4";
  if (amount <= limits.T1) return "T1";
  if (amount <= limits.T2) return "T2";
  if (amount <= limits.T3) return "T3";
  if (amount <= limits.T4) return "T4";
  return "ABOVE_T4";
}

/** Permission that APPROVES each approval kind (the checker). */
export const APPROVAL_KIND_PERMISSION: Record<ApprovalKind, PermissionKey> = {
  refund: "payments.refund_approve",
  folio_adjust: "folio.adjust_approve",
  discount: "pms.reservation.override",
  rate_change: "revenue.rates.approve",
  supplier_bill: "payables.approve",
  purchase_order: "purchase_orders.approve",
  payroll: "payroll.approve",
  capex: "asset.capex.approve",
  invoice_cancel: "invoice.cancel_approve",
  day_reopen: "night_audit.reopen"
};

/** Permission that REQUESTS each approval kind (the maker). */
export const APPROVAL_KIND_REQUEST_PERMISSION: Record<ApprovalKind, PermissionKey> = {
  refund: "payments.refund_request",
  folio_adjust: "folio.adjust",
  discount: "pms.reservation.discount",
  rate_change: "revenue.manage_rates",
  supplier_bill: "payables.create",
  purchase_order: "purchase_orders.create",
  payroll: "payroll.manage",
  capex: "capex.create",
  invoice_cancel: "invoice.cancel_request",
  day_reopen: "night_audit.review"
};

/**
 * Kinds whose request MUST carry an amount (the tier T1-T4 / ABOVE_T4 is
 * measured on it). A request of one of these kinds without `amount` is a 400:
 * a null amount is never «any amount» (corrector 8a · SEC-8A-01). `rate_change`
 * (band / percentage) and `day_reopen` carry no amount by nature.
 */
export const APPROVAL_KIND_REQUIRES_AMOUNT: Record<ApprovalKind, boolean> = {
  refund: true,
  folio_adjust: true,
  discount: true,
  rate_change: false,
  supplier_bill: true,
  purchase_order: true,
  payroll: true,
  capex: true,
  invoice_cancel: true,
  day_reopen: false
};

/** Threshold action each approval kind is measured against. */
export const APPROVAL_KIND_THRESHOLD_ACTION: Record<ApprovalKind, ThresholdAction> = {
  refund: "refund",
  folio_adjust: "folio_adjust",
  discount: "discount",
  rate_change: "rate_change",
  supplier_bill: "supplier_bill",
  purchase_order: "purchase_order",
  payroll: "payroll",
  capex: "capex",
  invoice_cancel: "invoice_cancel",
  day_reopen: "day_reopen"
};

// ---------------------------------------------------------------------------
// Templates → level, default scope, max tier, department (§4.2)
// ---------------------------------------------------------------------------

export const ROLE_TEMPLATE_LEVEL: Record<RoleKey, RoleLevel> = {
  receptionist: "operative",
  night_auditor: "operative",
  front_office_manager: "supervisor",
  housekeeper: "operative",
  housekeeping_manager: "supervisor",
  maintenance: "operative",
  maintenance_manager: "supervisor",
  fnb: "operative",
  fnb_manager: "supervisor",
  sales: "operative",
  admin_clerk: "operative",
  manager: "hotel_director",
  operations_director: "operations_director",
  revenue: "operations_director",
  accountant: "central_admin",
  controller: "general_management",
  payroll_hr: "central_admin",
  compliance: "central_admin",
  asset_manager: "central_admin",
  general_manager: "general_management",
  owner: "ownership",
  auditor: "central_admin",
  admin: "central_admin",
  break_glass: "general_management"
};

export const ROLE_TEMPLATE_DEFAULT_SCOPE: Record<RoleKey, ScopeType> = {
  receptionist: "property",
  night_auditor: "property",
  front_office_manager: "property",
  housekeeper: "property",
  housekeeping_manager: "property",
  maintenance: "property",
  maintenance_manager: "property",
  fnb: "property",
  fnb_manager: "property",
  sales: "property",
  admin_clerk: "property",
  manager: "property",
  operations_director: "property_group",
  revenue: "organization",
  accountant: "legal_entity",
  controller: "legal_entity",
  payroll_hr: "legal_entity",
  compliance: "legal_entity",
  asset_manager: "legal_entity",
  general_manager: "organization",
  owner: "organization",
  auditor: "organization",
  admin: "organization",
  break_glass: "organization"
};

/**
 * AUTHORITATIVE max approval tier per template (§4.7): operative and
 * central_admin templates T1 (they execute with a reason code and prepare),
 * supervisors T2, hotel director T3, operations director and controller T4,
 * general manager, owner and break glass above T4; admin and auditor never
 * approve amounts (T1 = reason code only). Custom roles without a template
 * fall back to LEVEL_MAX_TIER through their level.
 */
export const TEMPLATE_MAX_TIER: Record<RoleKey, ThresholdTier> = {
  receptionist: "T1",
  night_auditor: "T1",
  front_office_manager: "T2",
  housekeeper: "T1",
  housekeeping_manager: "T2",
  maintenance: "T1",
  maintenance_manager: "T2",
  fnb: "T1",
  fnb_manager: "T2",
  sales: "T1",
  admin_clerk: "T1",
  manager: "T3",
  operations_director: "T4",
  revenue: "T4",
  accountant: "T1",
  controller: "T4",
  payroll_hr: "T1",
  compliance: "T1",
  asset_manager: "T1",
  general_manager: "ABOVE_T4",
  owner: "ABOVE_T4",
  auditor: "T1",
  admin: "T1",
  break_glass: "ABOVE_T4"
};

/** Max approval tier by level, ONLY for custom roles (managed = false) that carry a level and no template. */
export const LEVEL_MAX_TIER: Record<RoleLevel, ThresholdTier> = {
  operative: "T1",
  supervisor: "T2",
  hotel_director: "T3",
  operations_director: "T4",
  general_management: "ABOVE_T4",
  ownership: "ABOVE_T4",
  central_admin: "T1"
};

/** Navigation token of each template (apps/admin-web role-tokens.ts, §4.2 / §5.1). */
export const ROLE_TEMPLATE_NAV_TOKEN: Record<RoleKey, string> = {
  receptionist: "recepcion",
  night_auditor: "recepcion",
  front_office_manager: "recepcion",
  housekeeper: "pisos",
  housekeeping_manager: "pisos",
  maintenance: "mantenimiento",
  maintenance_manager: "mantenimiento",
  fnb: "fnb",
  fnb_manager: "fnb",
  sales: "comercial",
  admin_clerk: "administracion",
  manager: "direccion",
  operations_director: "direccion",
  revenue: "revenue",
  accountant: "finanzas",
  controller: "finanzas",
  payroll_hr: "rrhh",
  compliance: "finanzas",
  asset_manager: "activos",
  general_manager: "direccion",
  owner: "propiedad",
  auditor: "auditoria",
  admin: "sistemas",
  /** An emergency session holds every hotel key: the broadest hotel token (the platform `admin` token is never derived). */
  break_glass: "direccion"
};

/** Spanish department of each template (Role.department; USALI-style departments of §2). */
export const ROLE_TEMPLATE_DEPARTMENT_ES: Record<RoleKey, string> = {
  receptionist: "Recepción",
  night_auditor: "Recepción",
  front_office_manager: "Recepción",
  housekeeper: "Pisos",
  housekeeping_manager: "Pisos",
  maintenance: "Mantenimiento",
  maintenance_manager: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  fnb_manager: "Alimentos y bebidas",
  sales: "Comercial",
  admin_clerk: "Administración",
  manager: "Dirección",
  operations_director: "Dirección de operaciones",
  revenue: "Revenue",
  accountant: "Finanzas",
  controller: "Finanzas",
  payroll_hr: "Recursos humanos",
  compliance: "Cumplimiento",
  asset_manager: "Gestión del activo",
  general_manager: "Dirección general",
  owner: "Propiedad",
  auditor: "Auditoría interna",
  admin: "Sistemas",
  break_glass: "Emergencia"
};

// ---------------------------------------------------------------------------
// Static separation of duties (§4.7)
// ---------------------------------------------------------------------------

export type SodStaticPair = {
  a: PermissionKey;
  b: PermissionKey;
  /** Templates allowed to hold both (dynamic SoD applies instead: pay only what someone else approved). */
  except?: RoleKey[];
};

/**
 * Pairs no template may hold at the same time (validated by
 * tests/rbac-sod-contract.test.mjs over ROLE_PERMISSION_MAP and by the
 * assignment service over the union of a user's assignments). The «sistema ≠
 * finanzas» rule (roles.manage / permissions.manage vs any money key) is
 * expanded to explicit pairs so the list is data, not code; `users.assign`
 * stays out of it on purpose (§4.7: hotel, operations and general directors
 * assign within their scope and level and do hold money keys).
 */
export const SOD_STATIC_PAIRS: readonly SodStaticPair[] = [
  { a: "invoice.issue", b: "invoice.cancel_approve" },
  { a: "payment.capture", b: "payments.refund_approve" },
  { a: "payables.create", b: "payables.approve" },
  { a: "payables.approve", b: "payables.pay", except: ["controller"] },
  { a: "accounting.journal.post", b: "payables.pay" },
  { a: "banking.reconcile", b: "payables.pay" },
  { a: "payroll.manage", b: "payroll.approve" },
  { a: "purchase_orders.create", b: "purchase_orders.approve" },
  { a: "purchase_orders.receive", b: "purchase_orders.approve" },
  { a: "night_audit.run", b: "night_audit.review" },
  // sistema ≠ finanzas: roles.manage
  { a: "roles.manage", b: "accounting.journal.post" },
  { a: "roles.manage", b: "payables.read" },
  { a: "roles.manage", b: "payables.create" },
  { a: "roles.manage", b: "payables.approve" },
  { a: "roles.manage", b: "payables.pay" },
  { a: "roles.manage", b: "payment.capture" },
  { a: "roles.manage", b: "payment.refund" },
  { a: "roles.manage", b: "payments.create_link" },
  { a: "roles.manage", b: "payments.capture" },
  { a: "roles.manage", b: "payments.refund_request" },
  { a: "roles.manage", b: "payments.refund_approve" },
  { a: "roles.manage", b: "payments.configure" },
  // sistema ≠ finanzas: permissions.manage
  { a: "permissions.manage", b: "accounting.journal.post" },
  { a: "permissions.manage", b: "payables.read" },
  { a: "permissions.manage", b: "payables.create" },
  { a: "permissions.manage", b: "payables.approve" },
  { a: "permissions.manage", b: "payables.pay" },
  { a: "permissions.manage", b: "payment.capture" },
  { a: "permissions.manage", b: "payment.refund" },
  { a: "permissions.manage", b: "payments.create_link" },
  { a: "permissions.manage", b: "payments.capture" },
  { a: "permissions.manage", b: "payments.refund_request" },
  { a: "permissions.manage", b: "payments.refund_approve" },
  { a: "permissions.manage", b: "payments.configure" }
];

/** Static SoD pairs violated by a set of permissions (empty = compatible); `templateKey` applies the `except` list. */
export function sodConflictsOf(permissions: readonly PermissionKey[], templateKey?: RoleKey | null): SodStaticPair[] {
  const held = new Set<string>(permissions);
  return SOD_STATIC_PAIRS.filter((pair) => held.has(pair.a) && held.has(pair.b) && !(templateKey && pair.except?.includes(templateKey)));
}

// ---------------------------------------------------------------------------
// Error and audit codes (§6.3, §6.6)
// ---------------------------------------------------------------------------

/** `details.code` of the 4xx answers of the rbac / approvals routes. */
export const RBAC_ERROR_CODES = [
  "RBAC_LEVEL_EXCEEDED",
  "RBAC_SCOPE_EXCEEDED",
  "RBAC_SOD_CONFLICT",
  "RBAC_SELF_ASSIGNMENT",
  "RBAC_BREAK_GLASS_FORBIDDEN",
  "APPROVAL_REQUIRED",
  "APPROVAL_SELF_DECISION",
  "APPROVAL_EXPIRED",
  "APPROVAL_MISMATCH",
  "SUPERVISOR_PIN_INVALID",
  "SUPERVISOR_PIN_LOCKED",
  "BREAK_GLASS_ACCOUNT_MISSING",
  "BREAK_GLASS_REAUTH_REQUIRED",
  "PAYROLL_NOT_APPROVED"
] as const;
export type RbacErrorCode = (typeof RBAC_ERROR_CODES)[number];

/** Spanish user-facing message per error code (the API answers Spanish; the front may reuse). */
export const RBAC_ERROR_MESSAGES_ES: Record<RbacErrorCode, string> = {
  RBAC_LEVEL_EXCEEDED: "No puedes asignar un rol de nivel superior al tuyo.",
  RBAC_SCOPE_EXCEEDED: "No puedes asignar roles fuera de tu ámbito.",
  RBAC_SOD_CONFLICT: "La combinación de roles viola la separación de funciones.",
  RBAC_SELF_ASSIGNMENT: "Nadie puede concederse permisos a sí mismo.",
  RBAC_BREAK_GLASS_FORBIDDEN: "La plantilla de emergencia no se asigna a personas.",
  APPROVAL_REQUIRED: "Esta operación necesita una aprobación previa.",
  APPROVAL_SELF_DECISION: "Nadie aprueba lo que ha solicitado.",
  APPROVAL_EXPIRED: "La aprobación ha caducado.",
  APPROVAL_MISMATCH: "La aprobación no corresponde a esta operación.",
  SUPERVISOR_PIN_INVALID: "PIN de supervisor incorrecto.",
  SUPERVISOR_PIN_LOCKED: "PIN de supervisor bloqueado temporalmente.",
  BREAK_GLASS_ACCOUNT_MISSING: "No existe una cuenta de emergencia disponible.",
  BREAK_GLASS_REAUTH_REQUIRED: "Abrir una sesión de emergencia exige volver a autenticarse.",
  PAYROLL_NOT_APPROVED: "El registro de nómina no está aprobado."
};

/** AuditEvent.action values written by the RBAC / approvals / break-glass flows. */
export const RBAC_AUDIT_ACTIONS = [
  "ACCESS_DENIED",
  "ROLE_ASSIGNED",
  "ROLE_REVOKED",
  "ROLE_TEMPLATE_UPGRADED",
  "ROLE_PERMISSIONS_EDITED",
  "USER_DISABLED",
  "USER_DEPARTMENT_ASSIGNED",
  "PROPERTY_SWITCHED",
  "APPROVAL_REQUESTED",
  "APPROVAL_DECIDED",
  "APPROVAL_EXPIRED",
  "SUPERVISOR_AUTHORIZED",
  "BREAK_GLASS_OPENED",
  "BREAK_GLASS_CLOSED",
  "BREAK_GLASS_DRILL",
  "LOGIN_FAILED",
  "ACCOUNTING_EXPORTED",
  "NIGHT_AUDIT_REVIEWED",
  "NIGHT_AUDIT_REOPENED",
  "POS_TICKET_VOIDED"
] as const;
export type RbacAuditAction = (typeof RBAC_AUDIT_ACTIONS)[number];

/** Maximum length of a break-glass session (§4.8). */
export const BREAK_GLASS_MAX_SESSION_HOURS = 4;
/** A break-glass session must be reviewed within this window (§4.8). */
export const BREAK_GLASS_REVIEW_HOURS = 24;
/** Supervisor PIN authorisations are bound to one action and expire after this many seconds (§5.6). */
export const SUPERVISOR_AUTHORIZATION_TTL_SECONDS = 60;
/** Invitations with scope expire after at most this many days (§5.5). */
export const INVITATION_MAX_DAYS = 7;

// ---------------------------------------------------------------------------
// Access decision (menu = router = API)
// ---------------------------------------------------------------------------

/** Single decision the API gate, the menu and the front router share (§5.2). */
export type AccessDecision = {
  allowed: boolean;
  /** Keys the caller lacks for the route / entry (empty when allowed). */
  missing: PermissionKey[];
  /** Scope the permissions were resolved for (null = not authenticated). */
  scopeType: ScopeType | null;
  /** Property the request acts on (null for organisation-level routes). */
  propertyId: string | null;
  reason?: "unmapped" | "missing_permission" | "not_authenticated" | "out_of_scope";
};

// ---------------------------------------------------------------------------
// Wire DTOs (served by L1, consumed by L4)
// ---------------------------------------------------------------------------

/** One row of user_role_assignments (§6.1). */
export type UserRoleAssignmentDto = {
  id: string;
  userId: string;
  roleId: string;
  roleName: string;
  templateKey: RoleKey | null;
  level: RoleLevel | null;
  scopeType: ScopeType;
  propertyId: string | null;
  propertyGroupId: string | null;
  legalEntityId: string | null;
  organizationId: string;
  validFrom: string;
  validTo: string | null;
  revokedAt: string | null;
  reason: string | null;
  grantedByUserId: string | null;
};

/** Effective scope of a user (assignments expanded to property ids). */
export type UserScopeDto = {
  scopeType: ScopeType;
  /** Id of the property / group / legal entity / organisation the scope points at. */
  ref: string;
  /** Properties the scope expands to (all of the group / sociedad / organisation). */
  propertyIds: string[];
};

/** One row of approval_requests (§6.1, §5.7). */
export type ApprovalRequestDto = {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  entityType: string;
  entityId: string;
  propertyId: string | null;
  /** Money amount as a decimal string (never a float), null for kinds without amount. */
  amount: string | null;
  currency: string;
  reasonCode: string;
  reasonText: string | null;
  requestedByUserId: string;
  requestedAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  secondApproverUserId: string | null;
  expiresAt: string;
  thresholdTier: ThresholdTier;
  requiresSecondApproval: boolean;
  /** Display names resolved by the inbox listing (GET /approvals); absent on the create / decide answers. */
  requestedByName?: string | null;
  decidedByName?: string | null;
  secondApproverName?: string | null;
  propertyName?: string | null;
};

/** One row of role_thresholds (per organisation; roleId or level, never both). */
export type RoleThresholdDto = {
  id: string;
  organizationId: string;
  roleId: string | null;
  level: RoleLevel | null;
  action: ThresholdAction;
  tier: ThresholdTier;
  maxAmount: string | null;
  maxPct: string | null;
  currency: string;
  requiresSecondApproval: boolean;
};

/** Property group (clúster de hoteles) with its members. */
export type PropertyGroupDto = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  propertyIds: string[];
};

/** One row of break_glass_sessions (§4.8). */
export type BreakGlassSessionDto = {
  id: string;
  organizationId: string;
  openedByUserId: string;
  accountUserId: string;
  reason: string;
  ticket: string | null;
  openedAt: string;
  closesAt: string;
  closedAt: string | null;
  closedByUserId: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
};

/** One row of supervisor_authorizations (§5.6). */
export type SupervisorAuthorizationDto = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  actorUserId: string;
  authorizerUserId: string;
  permissionKey: PermissionKey;
  entityType: string;
  entityId: string;
  amount: string | null;
  reasonCode: string;
  expiresAt: string;
  usedAt: string | null;
};

/** Row of the users & roles screen (§5.4). */
export type RbacUserRowDto = {
  userId: string;
  email: string;
  fullName: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  assignments: UserRoleAssignmentDto[];
};

/** GET /rbac/report — «roles y claves configurados» (OPERA «Configured Roles and Tasks», §6.3). */
export type RbacReportDto = {
  organizationId: string;
  generatedAt: string;
  templateVersion: number;
  roles: Array<{
    roleId: string;
    name: string;
    templateKey: RoleKey | null;
    level: RoleLevel | null;
    department: string | null;
    managed: boolean;
    templateVersion: number;
    permissionCount: number;
    permissions: PermissionKey[];
    /** Keys outside the template (custom roles) — empty for converged managed roles. */
    extraKeys: PermissionKey[];
    /** Template keys the role still lacks. */
    missingKeys: PermissionKey[];
    assignmentCount: number;
    sodConflicts: SodStaticPair[];
  }>;
  /** Roles whose permission sets are identical (quarterly review, §5.4). */
  identicalRoles: Array<{ roleIds: string[]; permissionCount: number }>;
  thresholds: RoleThresholdDto[];
};
