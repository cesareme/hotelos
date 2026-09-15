// Tenant administration service for the platform admin console.
//
// Multi-tenant management surface used by HotelOS staff (NOT individual hotel
// users) to provision new tenants (Organization + Property + owner User), list
// existing tenants with usage/health counts, inspect tenant detail and audit
// trail, regenerate temporary credentials, and toggle module entitlements.
//
// All mutating operations are gated by the `admin.tenants.manage` permission
// (platform scope: part of PLATFORM_PERMISSION_KEYS in @hotelos/shared, never
// included in an organization role template — see lib/rbac-catalog.ts).
// Every successful action emits an AuditEvent so the platform admin console
// keeps a tamper-evident trail.

import { randomInt } from "node:crypto";
import { prisma, hashPassword } from "@hotelos/database";
import { HOTEL_MODULES } from "@hotelos/product";
import type { PermissionKey } from "@hotelos/shared";
import { requirePermissions } from "../auth/auth.service.js";
import { createInvitation, reissueInvitation } from "../auth/invitations.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { resolveFiscalLocation } from "../backoffice/backoffice.service.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { applyRoleTemplate, provisionDefaultTemplateRoles, type ProvisionedTemplateRole } from "../../lib/rbac-catalog.js";
import { ensurePropertySettings, ensurePropertyTaxes, mirrorOrganization, mirrorProperty } from "../../lib/tenant-hydration.js";
import { listPropertyModules } from "../product-modules/product-modules.service.js";

// ────────────────────────────────────────────────────────────── permissions

// Platform-admin permission (HotelOS staff): the only key that turns a user
// into a platform admin, so it is evaluated against REAL grants only.
const TENANTS_MANAGE: readonly PermissionKey[] = ["admin.tenants.manage"];

function guard(context: UserContext): void {
  requirePermissions(context, [...TENANTS_MANAGE]);
}

// ────────────────────────────────────────────────────────────── types

export type TenantPlan = "starter" | "pro" | "enterprise";

export type TenantStatus = "active" | "suspended" | "trial" | "archived";

export type TenantSummary = {
  organizationId: string;
  name: string;
  legalName?: string;
  country: string;
  createdAt: string;
  status: TenantStatus;
  plan: TenantPlan;
  counts: {
    properties: number;
    users: number;
    modulesEnabled: number;
  };
  lastActivityAt?: string;
};

export type TenantPropertySummary = {
  id: string;
  name: string;
  legalName?: string;
  municipality?: string;
  province?: string;
  country: string;
  status: string;
  createdAt: string;
  modulesEnabled: number;
};

export type TenantUserSummary = {
  id: string;
  email: string;
  fullName: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt?: string;
  createdAt: string;
  roles: string[];
};

export type TenantDetail = {
  organizationId: string;
  name: string;
  legalName?: string;
  taxId?: string;
  country: string;
  createdAt: string;
  status: TenantStatus;
  plan: TenantPlan;
  properties: TenantPropertySummary[];
  users: TenantUserSummary[];
  modulesEnabled: string[];
  lastActivityAt?: string;
};

export type AuditEntry = {
  id: string;
  organizationId: string;
  propertyId?: string;
  actorUserId?: string;
  actorType: string;
  action: string;
  entityType: string;
  entityId?: string;
  correlationId?: string;
  createdAt: string;
};

export type CreateTenantInput = {
  context: UserContext;
  organizationName: string;
  organizationCountry: string;
  property: {
    name: string;
    type: string;
    municipality?: string;
    province?: string;
    /** Tanda 3: canonical tax region (ES_PENINSULA_BALEARES · ES_CANARIAS · ES_CEUTA · ES_MELILLA); derived from the province when omitted. */
    taxRegion?: string;
    /** 5-digit Spanish postal code (validated). */
    postalCode?: string;
    /** 5-digit INE municipality code, same province as the postal code (validated). */
    ineMunicipalityCode?: string;
    /** Reporting territory: common (VeriFactu) · bizkaia · gipuzkoa · araba · navarra. */
    fiscalTerritory?: string;
  };
  ownerUser: {
    email: string;
    fullName: string;
    phone?: string;
  };
  modulesEnabled: string[];
  plan: TenantPlan;
};

export type InvitationDelivery = {
  status: "sent" | "simulated" | "failed" | "disabled";
  provider?: string;
  errorMessage?: string;
};

export type TenantInvitationResult = {
  /** Single-use accept-invite link; null only when the invitation could not be minted (see `error`). */
  inviteLink: string | null;
  invitation: {
    expiresAt: string | null;
    delivery: InvitationDelivery;
    /** Set when invitations.service threw: the user exists, reissue from the tenant detail. */
    error?: string;
  };
};

export type CreateTenantResult = TenantInvitationResult & {
  organizationId: string;
  propertyId: string;
  ownerUserId: string;
  /** role_permissions rows granted to the Owner role from the shared "owner" template. */
  ownerPermissionsGranted: number;
  /** Tanda 4: template roles provisioned besides Owner (Manager / Recepción / Housekeeping), no users attached. */
  templateRoles: ProvisionedTemplateRole[];
  /** Only when ADMIN_EXPOSE_TEMP_PASSWORD=true (never by default: the owner sets the password on accept-invite). */
  tempPassword?: string;
  /** Statutory tax catalogue provisioned for the property's region (contract C). */
  taxProvisioning: { ok: boolean; taxRegion: string | null; provisioned?: number; skipped?: number; error?: string };
};

/** Temp passwords in clear text are opt-in for break-glass scenarios only. */
function exposeTempPassword(): boolean {
  return process.env.ADMIN_EXPOSE_TEMP_PASSWORD === "true";
}

// ─────────────────────────────────────────────── tenant metadata side-store
//
// The Organization model in the canonical schema has no `status`, `plan`, or
// `lastActivityAt` columns yet. Until a migration adds them, we keep a small
// in-memory side-store keyed by organizationId. This is intentional: the
// service has a stable shape today and the side-store is a clear seam to
// replace with real columns later without changing callers.

type TenantMetadata = {
  status: TenantStatus;
  plan: TenantPlan;
  modulesEnabled: Set<string>;
  lastActivityAt?: string;
};

const tenantMetadata = new Map<string, TenantMetadata>();

type TenantMetadataDefaults = {
  status?: TenantStatus;
  plan?: TenantPlan;
  modulesEnabled?: Iterable<string>;
  lastActivityAt?: string;
};

function ensureMetadata(organizationId: string, defaults?: TenantMetadataDefaults): TenantMetadata {
  let meta = tenantMetadata.get(organizationId);
  if (!meta) {
    meta = {
      status: defaults?.status ?? "active",
      plan: defaults?.plan ?? "starter",
      modulesEnabled: defaults?.modulesEnabled ? new Set<string>(defaults.modulesEnabled) : new Set<string>(),
      lastActivityAt: defaults?.lastActivityAt
    };
    tenantMetadata.set(organizationId, meta);
  }
  return meta;
}

// ──────────────────────────────────────────── invitations
//
// Tanda 3 (CFG-P1-6): the in-process invite-token array is gone. Invitations are
// persisted (user_invitations, hashed single-use token, 72 h TTL) and delivered by
// modules/auth/invitations.service (contract G); this service only reports what
// happened (delivery status + link) and never fails a tenant creation because an
// email could not be sent.

async function mintInvitation(input: {
  userId: string;
  organizationId: string;
  propertyId: string | null;
  roleId: string | null;
  actorUserId: string | null;
  correlationId?: string;
}): Promise<TenantInvitationResult> {
  try {
    const created = await createInvitation({
      userId: input.userId,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      roleId: input.roleId,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId
    });
    return { inviteLink: created.inviteUrl, invitation: { expiresAt: created.expiresAt, delivery: created.delivery } };
  } catch (err) {
    // Honest failure: the user row exists, the console can reissue; never a fake link.
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[tenant-admin] createInvitation failed", {
      userId: input.userId,
      organizationId: input.organizationId,
      correlationId: input.correlationId,
      error: message
    });
    return { inviteLink: null, invitation: { expiresAt: null, delivery: { status: "failed", errorMessage: message }, error: message } };
  }
}

// ─────────────────────────────────────────────────────────── password gen

const PASSWORD_LENGTH = 16;
const PWD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit I, O to avoid confusion
const PWD_LOWER = "abcdefghijkmnpqrstuvwxyz"; // omit l, o
const PWD_DIGIT = "23456789"; // omit 0, 1
const PWD_SPECIAL = "!@#$%^&*-_=+";

function pickChar(alphabet: string): string {
  return alphabet[randomInt(0, alphabet.length)] ?? alphabet[0]!;
}

function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// Generates a 16-character temporary password with at least one upper, lower,
// digit and special character — satisfies assertPasswordPolicy without relying
// on the caller to provide one.
function generateTempPassword(): string {
  const required = [pickChar(PWD_UPPER), pickChar(PWD_LOWER), pickChar(PWD_DIGIT), pickChar(PWD_SPECIAL)];
  const pool = PWD_UPPER + PWD_LOWER + PWD_DIGIT + PWD_SPECIAL;
  const rest: string[] = [];
  for (let i = required.length; i < PASSWORD_LENGTH; i += 1) {
    rest.push(pickChar(pool));
  }
  return shuffle([...required, ...rest]).join("");
}

// ───────────────────────────────────────────────────────────── helpers

function mapTenantSummary(input: {
  organization: { id: string; name: string; legalName: string | null; country: string; createdAt: Date };
  propertyCount: number;
  userCount: number;
  meta: TenantMetadata;
}): TenantSummary {
  return {
    organizationId: input.organization.id,
    name: input.organization.name,
    legalName: input.organization.legalName ?? undefined,
    country: input.organization.country,
    createdAt: input.organization.createdAt.toISOString(),
    status: input.meta.status,
    plan: input.meta.plan,
    counts: {
      properties: input.propertyCount,
      users: input.userCount,
      modulesEnabled: input.meta.modulesEnabled.size
    },
    lastActivityAt: input.meta.lastActivityAt
  };
}

async function computeLastActivity(organizationId: string): Promise<string | undefined> {
  // Prefer the most recent audit event for the organization; fall back to the
  // most recent user login if no audit rows exist yet.
  const lastAudit = await prisma.auditEvent.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true }
  });
  if (lastAudit) {
    return lastAudit.createdAt.toISOString();
  }
  const lastLogin = await prisma.user.findFirst({
    where: { organizationId, lastLoginAt: { not: null } },
    orderBy: { lastLoginAt: "desc" },
    select: { lastLoginAt: true }
  });
  return lastLogin?.lastLoginAt?.toISOString();
}

// ──────────────────────────────────────────────────────────── listTenants

export async function listTenants(input: { context: UserContext }): Promise<TenantSummary[]> {
  const { context } = input;
  if (context) {
    guard(context);
  }
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: "desc" }
  });
  if (organizations.length === 0) return [];

  const orgIds = organizations.map((org) => org.id);
  const [propertyGroups, userGroups] = await Promise.all([
    prisma.property.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds } },
      _count: { _all: true }
    }),
    prisma.user.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds } },
      _count: { _all: true }
    })
  ]);

  const propertyCountById = new Map<string, number>();
  for (const row of propertyGroups) {
    propertyCountById.set(row.organizationId, row._count._all);
  }
  const userCountById = new Map<string, number>();
  for (const row of userGroups) {
    userCountById.set(row.organizationId, row._count._all);
  }

  // Hydrate lastActivityAt in parallel so the list view shows freshness data.
  const lastActivities = await Promise.all(organizations.map((org) => computeLastActivity(org.id)));

  return organizations.map((org, index) => {
    const meta = ensureMetadata(org.id);
    if (lastActivities[index]) {
      meta.lastActivityAt = lastActivities[index];
    }
    return mapTenantSummary({
      organization: org,
      propertyCount: propertyCountById.get(org.id) ?? 0,
      userCount: userCountById.get(org.id) ?? 0,
      meta
    });
  });
}

// ────────────────────────────────────────────────────────── getTenantDetail

export async function getTenantDetail(input: { context: UserContext; orgId: string }): Promise<TenantDetail> {
  const { context, orgId } = input;
  if (context) {
    guard(context);
  }
  const organization = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!organization) {
    throw new NotFoundError(`Tenant not found: ${orgId}`);
  }

  const [properties, users] = await Promise.all([
    prisma.property.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } }),
    prisma.user.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } })
  ]);

  // The Prisma schema doesn't declare explicit relations on the join models
  // (PropertyModule, UserPropertyRole), so we issue scoped follow-up queries
  // using the property ids we already loaded.
  const propertyIds = properties.map((p) => p.id);
  const [propertyModules, userPropertyRoles] = await Promise.all([
    propertyIds.length === 0
      ? Promise.resolve([] as Array<{ propertyId: string; moduleId: string; status: string }>)
      : prisma.propertyModule.findMany({
          where: { propertyId: { in: propertyIds }, status: "enabled" },
          select: { propertyId: true, moduleId: true, status: true }
        }),
    propertyIds.length === 0
      ? Promise.resolve([] as Array<{ userId: string; roleId: string; propertyId: string }>)
      : prisma.userPropertyRole.findMany({
          where: { propertyId: { in: propertyIds } },
          select: { userId: true, roleId: true, propertyId: true }
        })
  ]);

  const moduleIds = Array.from(new Set(propertyModules.map((pm) => pm.moduleId)));
  const roleIds = Array.from(new Set(userPropertyRoles.map((upr) => upr.roleId)));
  const [moduleRows, roleRows] = await Promise.all([
    moduleIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; code: string }>)
      : prisma.module.findMany({ where: { id: { in: moduleIds } }, select: { id: true, code: true } }),
    roleIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; name: string }>)
      : prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } })
  ]);
  const moduleCodeById = new Map(moduleRows.map((m) => [m.id, m.code]));
  const roleNameById = new Map(roleRows.map((r) => [r.id, r.name]));

  const modulesByProperty = new Map<string, number>();
  const enabledModuleCodes = new Set<string>();
  for (const pm of propertyModules) {
    modulesByProperty.set(pm.propertyId, (modulesByProperty.get(pm.propertyId) ?? 0) + 1);
    const code = moduleCodeById.get(pm.moduleId);
    if (code) enabledModuleCodes.add(code);
  }

  const rolesByUser = new Map<string, Set<string>>();
  for (const upr of userPropertyRoles) {
    const set = rolesByUser.get(upr.userId) ?? new Set<string>();
    const name = roleNameById.get(upr.roleId);
    if (name) set.add(name);
    rolesByUser.set(upr.userId, set);
  }

  const meta = ensureMetadata(orgId);
  // Side-store modules win if present (set explicitly via toggleTenantModule),
  // otherwise hydrate from the persisted PropertyModule rows so the detail is
  // accurate even when the in-memory state is fresh.
  if (meta.modulesEnabled.size === 0 && enabledModuleCodes.size > 0) {
    for (const code of enabledModuleCodes) meta.modulesEnabled.add(code);
  }
  const lastActivityAt = await computeLastActivity(orgId);
  if (lastActivityAt) meta.lastActivityAt = lastActivityAt;

  return {
    organizationId: organization.id,
    name: organization.name,
    legalName: organization.legalName ?? undefined,
    taxId: organization.taxId ?? undefined,
    country: organization.country,
    createdAt: organization.createdAt.toISOString(),
    status: meta.status,
    plan: meta.plan,
    properties: properties.map((property) => ({
      id: property.id,
      name: property.name,
      legalName: property.legalName ?? undefined,
      municipality: property.municipality ?? undefined,
      province: property.province ?? undefined,
      country: property.country,
      status: property.status,
      createdAt: property.createdAt.toISOString(),
      modulesEnabled: modulesByProperty.get(property.id) ?? 0
    })),
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      lastLoginAt: user.lastLoginAt?.toISOString(),
      createdAt: user.createdAt.toISOString(),
      roles: Array.from(rolesByUser.get(user.id) ?? new Set<string>())
    })),
    modulesEnabled: Array.from(meta.modulesEnabled),
    lastActivityAt: meta.lastActivityAt
  };
}

// ──────────────────────────────────────────────────────────── createTenant

export async function createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
  guard(input.context);

  const organizationName = input.organizationName?.trim();
  if (!organizationName) {
    throw new BadRequestError("organizationName is required.");
  }
  const propertyName = input.property?.name?.trim();
  if (!propertyName) {
    throw new BadRequestError("property.name is required.");
  }
  const ownerEmail = input.ownerUser?.email?.toLowerCase().trim();
  if (!ownerEmail || !ownerEmail.includes("@")) {
    throw new BadRequestError("ownerUser.email is required and must be valid.");
  }
  const ownerFullName = input.ownerUser?.fullName?.trim();
  if (!ownerFullName) {
    throw new BadRequestError("ownerUser.fullName is required.");
  }

  const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (existingUser) {
    throw new ConflictError(`Ya existe un usuario con el email ${ownerEmail}.`);
  }

  // Tanda 3: fiscal location validated BEFORE any write (canonical region or 400,
  // 5-digit CP / INE coherent by province, reporting territory); the region is derived
  // from the province when the console did not send one.
  const province = input.property.province?.trim() || null;
  const fiscal = resolveFiscalLocation({
    current: {},
    patch: {
      taxRegion: input.property.taxRegion,
      postalCode: input.property.postalCode,
      ineMunicipalityCode: input.property.ineMunicipalityCode,
      fiscalTerritory: input.property.fiscalTerritory
    },
    province
  });

  // The owner is created as `invited` without a password: they choose it on
  // accept-invite. Only ADMIN_EXPOSE_TEMP_PASSWORD=true keeps the legacy clear-text
  // temporary password (active user forced to rotate on first login).
  const expose = exposeTempPassword();
  const tempPassword = expose ? generateTempPassword() : null;
  const passwordHash = tempPassword ? hashPassword(tempPassword) : null;
  const country = input.organizationCountry?.trim() || "ES";

  const persisted = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: organizationName,
        country
      }
    });

    const property = await tx.property.create({
      data: {
        organizationId: organization.id,
        name: propertyName,
        municipality: input.property.municipality?.trim() || null,
        province,
        country,
        taxRegion: fiscal.taxRegionToPersist,
        postalCode: fiscal.postalCode,
        ineMunicipalityCode: fiscal.ineMunicipalityCode,
        fiscalTerritory: fiscal.fiscalTerritory
      }
    });

    // Owner role per organization with the shared "owner" template applied in
    // the same transaction (AUTH-07: before Tanda 1 the role was created with
    // ZERO role_permissions, so in production — no demo permission union — the
    // owner got 403 on every route). Additive + idempotent; the template never
    // carries platform keys, so a hotel owner is never a platform admin.
    // Tanda 4: the row carries templateKey "owner" so the boot-time backfill
    // keeps topping it up as PERMISSIONS grows (applyRoleTemplate would stamp
    // a null key anyway; set it explicitly at creation).
    const ownerRole = await tx.role.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: "Owner" } },
      update: {},
      create: { organizationId: organization.id, name: "Owner", templateKey: "owner" }
    });
    const ownerTemplate = await applyRoleTemplate(ownerRole.id, "owner", { db: tx });

    // Tanda 5: the 10 organization templates of ORGANIZATION_TEMPLATE_ROLE_KEYS
    // (provisionDefaultTemplateRoles, Spanish names; no users attached) so the
    // invite role selector offers real options from day one instead of "Owner"
    // for every employee. The Owner created above is recognised by its
    // template_key and topped up, never duplicated as «Propietario»; a role of
    // another template already using a name is reported as `conflict`. Same
    // transaction: a failure rolls the whole tenant back rather than leaving a
    // half-provisioned org.
    const templateRoles = await provisionDefaultTemplateRoles(organization.id, { db: tx });

    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: ownerEmail,
        fullName: ownerFullName,
        phone: input.ownerUser.phone?.trim() || null,
        passwordHash,
        passwordChangedAt: null,
        // Default: invited (no credential until accept-invite). Break-glass mode: active
        // with a temporary password that the PASSWORD_CHANGE_REQUIRED guard forces to rotate.
        status: expose ? "active" : "invited",
        mustChangePassword: expose
      }
    });

    await tx.userPropertyRole.create({
      data: {
        userId: user.id,
        propertyId: property.id,
        roleId: ownerRole.id
      }
    });

    // Default department + assignment so the owner is on the org chart.
    const department = await tx.department.upsert({
      where: { propertyId_code: { propertyId: property.id, code: "MGMT" } },
      update: {},
      create: { propertyId: property.id, code: "MGMT", name: "Management" }
    });
    await tx.userDepartment.upsert({
      where: { userId_departmentId: { userId: user.id, departmentId: department.id } },
      update: { roleLabel: "owner", active: true },
      create: { userId: user.id, departmentId: department.id, roleLabel: "owner", active: true }
    });

    return { organization, property, user, ownerRole, ownerPermissionsGranted: ownerTemplate.granted, templateRoles };
  });

  // Seed module entitlements (best-effort: any unknown moduleCode is skipped
  // rather than failing the entire creation flow).
  for (const moduleCode of input.modulesEnabled) {
    let moduleRow = await prisma.module.findUnique({ where: { code: moduleCode } });
    // Auditoría 2026-07: la tabla `modules` puede estar vacía (el catálogo vive
    // en @hotelos/product y el seed base no lo puebla) — antes el `continue`
    // descartaba TODOS los módulos del alta en silencio. Materializar la fila
    // desde el manifest canónico cuando el código exista allí.
    if (!moduleRow) {
      const manifest = HOTEL_MODULES.find((m) => m.code === moduleCode);
      if (!manifest) continue; // código desconocido: no inventar filas
      moduleRow = await prisma.module.upsert({
        where: { code: moduleCode },
        update: {},
        create: {
          code: manifest.code,
          name: manifest.name,
          description: manifest.description,
          category: manifest.category,
          isCore: manifest.isCore
        }
      });
    }
    await prisma.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId: persisted.property.id, moduleId: moduleRow.id } },
      update: { status: "enabled", enabledAt: new Date(), disabledAt: null },
      create: {
        propertyId: persisted.property.id,
        moduleId: moduleRow.id,
        status: "enabled",
        enabledAt: new Date()
      }
    });
  }

  // Per-property settings (PropertyAiSetting + PropertyComplianceSetting,
  // CFG-P1-4) and in-memory mirrors (organization, property, module state) so
  // the new tenant is usable by the synchronous demoStore-backed guards without
  // restarting the API. Idempotent: a retry after a crash here converges.
  await ensurePropertySettings(persisted.property.id);
  mirrorOrganization(persisted.organization);
  mirrorProperty(persisted.property);
  await listPropertyModules(persisted.property.id);

  // Statutory tax catalogue for the region (contract C). Idempotent; a failure is
  // reported in the result and the audit trail (readiness flags the missing rates)
  // instead of leaving a half-created tenant behind a 500.
  let taxProvisioning: CreateTenantResult["taxProvisioning"];
  try {
    const provisioned = await ensurePropertyTaxes({
      propertyId: persisted.property.id,
      organizationId: persisted.organization.id,
      taxRegion: fiscal.taxRegionToPersist
    });
    taxProvisioning = { ok: true, ...provisioned };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[tenant-admin.createTenant] ensurePropertyTaxes failed", {
      propertyId: persisted.property.id,
      organizationId: persisted.organization.id,
      taxRegion: fiscal.taxRegionToPersist,
      error: message
    });
    taxProvisioning = { ok: false, taxRegion: fiscal.taxRegion, error: message };
  }

  // Seed tenant metadata.
  const meta = ensureMetadata(persisted.organization.id, {
    status: "active",
    plan: input.plan,
    modulesEnabled: input.modulesEnabled
  });
  meta.plan = input.plan;
  for (const code of input.modulesEnabled) meta.modulesEnabled.add(code);
  meta.lastActivityAt = new Date().toISOString();

  // Persisted single-use invitation (72 h TTL) + best-effort email (contract G).
  const invitation = await mintInvitation({
    userId: persisted.user.id,
    organizationId: persisted.organization.id,
    propertyId: persisted.property.id,
    roleId: persisted.ownerRole.id,
    actorUserId: input.context.userId ?? null
  });

  recordAuditEvent({
    organizationId: persisted.organization.id,
    propertyId: persisted.property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "TENANT_CREATED",
    entityType: "organization",
    entityId: persisted.organization.id,
    afterJson: {
      organizationName,
      propertyName,
      propertyType: input.property.type,
      ownerEmail,
      ownerStatus: expose ? "active" : "invited",
      tempPasswordExposed: expose,
      plan: input.plan,
      modulesEnabled: input.modulesEnabled,
      ownerRoleTemplate: "owner",
      ownerPermissionsGranted: persisted.ownerPermissionsGranted,
      templateRoles: persisted.templateRoles.map((role) => ({ name: role.name, templateKey: role.templateKey, permissionsCount: role.permissionsCount })),
      fiscal: {
        taxRegion: fiscal.taxRegion,
        taxRegionSource: fiscal.taxRegionSource,
        fiscalTerritory: fiscal.fiscalTerritory,
        postalCode: fiscal.postalCode,
        ineMunicipalityCode: fiscal.ineMunicipalityCode
      },
      taxProvisioning,
      // Never the link itself (it carries the token).
      inviteExpiresAt: invitation.invitation.expiresAt,
      inviteDelivery: invitation.invitation.delivery,
      inviteError: invitation.invitation.error
    }
  });

  return {
    organizationId: persisted.organization.id,
    propertyId: persisted.property.id,
    ownerUserId: persisted.user.id,
    ownerPermissionsGranted: persisted.ownerPermissionsGranted,
    templateRoles: persisted.templateRoles,
    ...(tempPassword ? { tempPassword } : {}),
    inviteLink: invitation.inviteLink,
    invitation: invitation.invitation,
    taxProvisioning
  };
}

// ───────────────────────────────────────────── reissueTenantUserInvitation

export type ReissueTenantInviteResult = TenantInvitationResult & {
  userId: string;
  organizationId: string;
  /** Only when ADMIN_EXPOSE_TEMP_PASSWORD=true (break-glass): a fresh temporary password, forced to rotate on login. */
  newPassword?: string;
};

/**
 * Tanda 3: replaces the clear-text "regenerate temp password". Revokes the user's
 * live invitations and mints a new persisted one (contract G), so both an owner who
 * never accepted and one who lost access get a working accept-invite link. When
 * `orgId` is given the user must belong to it (opaque 404 otherwise: the console
 * route is /admin/tenants/:orgId/users/:userId/reissue-invite).
 */
export async function reissueTenantUserInvitation(input: {
  context: UserContext;
  userId: string;
  orgId?: string;
}): Promise<ReissueTenantInviteResult> {
  const { context, userId } = input;
  if (context) {
    guard(context);
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || (input.orgId !== undefined && user.organizationId !== input.orgId)) {
    throw new NotFoundError(`Usuario no encontrado: ${userId}`);
  }
  if (user.status === "disabled") {
    throw new ConflictError("No se puede reenviar la invitación de un usuario desactivado.");
  }

  let newPassword: string | undefined;
  if (exposeTempPassword()) {
    // Break-glass: keep the legacy temporary credential, forced to rotate on next login.
    newPassword = generateTempPassword();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashPassword(newPassword),
        passwordChangedAt: null,
        mustChangePassword: true,
        status: user.status === "invited" ? "active" : user.status,
        failedLoginAttempts: 0,
        lockedUntil: null
      }
    });
  }

  let result: TenantInvitationResult;
  try {
    const reissued = await reissueInvitation({ userId: user.id, organizationId: user.organizationId, actorUserId: context?.userId ?? null });
    result = { inviteLink: reissued.inviteUrl, invitation: { expiresAt: reissued.expiresAt, delivery: reissued.delivery } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[tenant-admin.reissueTenantUserInvitation] reissueInvitation failed", {
      userId: user.id,
      organizationId: user.organizationId,
      error: message
    });
    result = { inviteLink: null, invitation: { expiresAt: null, delivery: { status: "failed", errorMessage: message }, error: message } };
  }

  recordAuditEvent({
    organizationId: user.organizationId,
    actorUserId: context?.userId,
    actorType: context ? "user" : "system",
    action: "TENANT_USER_INVITATION_REISSUED",
    entityType: "user",
    entityId: user.id,
    afterJson: {
      tempPasswordExposed: Boolean(newPassword),
      inviteExpiresAt: result.invitation.expiresAt,
      inviteDelivery: result.invitation.delivery,
      inviteError: result.invitation.error
    }
  });

  return {
    userId: user.id,
    organizationId: user.organizationId,
    ...(newPassword ? { newPassword } : {}),
    ...result
  };
}

/**
 * Legacy name kept for the existing route (POST …/users/:userId/reset-password):
 * same behaviour as reissueTenantUserInvitation — no clear-text password unless
 * ADMIN_EXPOSE_TEMP_PASSWORD=true.
 */
export async function regenerateTempPassword(input: { context: UserContext; userId: string; orgId?: string }): Promise<ReissueTenantInviteResult> {
  return reissueTenantUserInvitation(input);
}

// ──────────────────────────────────────────────────────── toggleTenantModule

export async function toggleTenantModule(input: {
  context: UserContext;
  orgId: string;
  moduleCode: string;
  enabled: boolean;
}): Promise<{ ok: true }> {
  const { context, orgId, moduleCode, enabled } = input;
  if (context) {
    guard(context);
  }
  const organization = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!organization) {
    throw new NotFoundError(`Tenant not found: ${orgId}`);
  }
  const moduleRow = await prisma.module.findUnique({ where: { code: moduleCode } });
  if (!moduleRow) {
    throw new NotFoundError(`Module not found: ${moduleCode}`);
  }
  const properties = await prisma.property.findMany({
    where: { organizationId: orgId },
    select: { id: true }
  });

  // Apply the toggle to every property under the tenant. Module enablement at
  // the organization level is the platform-admin view; per-property overrides
  // are reserved for the in-tenant module management UI.
  const now = new Date();
  for (const property of properties) {
    await prisma.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId: property.id, moduleId: moduleRow.id } },
      update: enabled
        ? { status: "enabled", enabledAt: now, disabledAt: null }
        : { status: "disabled", disabledAt: now },
      create: {
        propertyId: property.id,
        moduleId: moduleRow.id,
        status: enabled ? "enabled" : "disabled",
        enabledAt: enabled ? now : null,
        disabledAt: enabled ? null : now
      }
    });
  }

  const meta = ensureMetadata(orgId);
  if (enabled) {
    meta.modulesEnabled.add(moduleCode);
  } else {
    meta.modulesEnabled.delete(moduleCode);
  }
  meta.lastActivityAt = now.toISOString();

  recordAuditEvent({
    organizationId: orgId,
    actorUserId: context?.userId,
    actorType: context ? "user" : "system",
    action: enabled ? "TENANT_MODULE_ENABLED" : "TENANT_MODULE_DISABLED",
    entityType: "organization",
    entityId: orgId,
    afterJson: { moduleCode, enabled, propertiesAffected: properties.length }
  });

  return { ok: true };
}

// ────────────────────────────────────────────────────────── getTenantAuditLog

export async function getTenantAuditLog(input: {
  context: UserContext;
  orgId: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const { context, orgId } = input;
  const limit = input.limit ?? 50;
  if (context) {
    guard(context);
  }
  const organization = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!organization) {
    throw new NotFoundError(`Tenant not found: ${orgId}`);
  }
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rows = await prisma.auditEvent.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: safeLimit
  });
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    actorUserId: row.actorUserId ?? undefined,
    actorType: row.actorType,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    createdAt: row.createdAt.toISOString()
  }));
}
