// PILOT-D3 · Clean-slate bootstrap para piloto.
//
// Permite arrancar una instancia desde DB vacía sin recurrir a scripts manuales:
//   POST /onboarding/bootstrap → crea Organization + Property + Admin User
//   + Role "Owner" con TODOS los permisos canónicos + UserPropertyRole.
//
// Defensa contra abuso (defensa en profundidad):
//   1. Requiere header `x-bootstrap-token` que coincida con BOOTSTRAP_TOKEN env.
//   2. Sólo funciona mientras `Organization.count() === 0` (auto-desactivación).
//
// El segundo cerrojo es el más fuerte: una vez creada la primera organización,
// el endpoint deja de funcionar aunque el token siga válido en env.

import { prisma, hashPassword } from "@hotelos/database";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, ForbiddenError } from "../../lib/http-error.js";
import { assertPasswordPolicy } from "../auth/auth-pilot.service.js";

// ───────────────────────────────────────────────── lista canónica de permisos
// Espejo de packages/database/prisma/seed.ts DEMO_PERMISSIONS para garantizar
// que un piloto fresco tiene exactamente las mismas capacidades que el demo.
export const PILOT_CANONICAL_PERMISSIONS: readonly string[] = [
  "backoffice.access",
  "configuration.read",
  "configuration.manage",
  "categories.read",
  "categories.manage",
  "custom_fields.read",
  "custom_fields.manage",
  "property_profile.edit",
  "property.configure",
  "property.map.read",
  "room_types.manage",
  "rooms.manage",
  "spaces.manage",
  "departments.manage",
  "operations_setup.manage",
  "revenue_setup.manage",
  "compliance_setup.manage",
  "ai_category_setup.use",
  "pms.reservation.read",
  "pms.reservation.create",
  "pms.reservation.update",
  "pms.reservation.cancel",
  "pms.reservation.check_in",
  "pms.reservation.check_out",
  "guests.read",
  "guests.manage",
  "housekeeping.task.manage",
  "maintenance.workorder.manage",
  "billing.compliance.view",
  "invoice.issue",
  "accounting.journal.post",
  "compliance.ses.submit",
  "compliance.ses.export",
  "compliance.ses.configure",
  "compliance.gdpr.manage",
  "guest_register.read",
  "guest_register.create",
  "guest_register.edit",
  "guest_register.sign",
  "guest_register.submit",
  "guest_register.configure",
  "guest_register.export",
  "modules.read",
  "modules.enable",
  "modules.configure",
  "integrations.read",
  "integrations.connect",
  "assets.read",
  "owner.dashboard.read",
  "revenue.read",
  "revenue.forecast.read",
  "revenue.recommend",
  "revenue.manage_rates",
  "revenue.manage_restrictions",
  "revenue.apply_recommendations",
  "revenue.history_forecast.read",
  "revenue.history_forecast.export",
  "channel_manager.read",
  "channel_manager.manage",
  "channel_manager.sync",
  "channel_manager.mappings.manage",
  "channel_manager.parity.read",
  "payroll.manage",
  "banking.reconcile",
  "notifications.manage",
  "guest_experience.inbox.read",
  "ai.tool.execute",
  "ai_governance.read",
  "onboarding.read",
  "onboarding.create",
  "onboarding.upload",
  "onboarding.ai_extract",
  "onboarding.ai_map",
  "onboarding.review",
  "onboarding.apply",
  "onboarding.go_live",
  "audit.read",
  "users.read",
  "users.invite"
] as const;

// ───────────────────────────────────────────────── tipos

export type BootstrapInput = {
  bootstrapToken: string;
  organization: {
    name: string;
    legalName?: string;
    taxId?: string;
    country?: string;
  };
  property: {
    name: string;
    legalName?: string;
    address?: string;
    municipality?: string;
    province?: string;
    country?: string;
    taxRegion?: string;
    timezone?: string;
    sesHospedajesEnabled?: boolean;
    verifactuEnabled?: boolean;
  };
  adminUser: {
    email: string;
    password: string;
    fullName: string;
    phone?: string;
  };
};

export type BootstrapResult = {
  organizationId: string;
  propertyId: string;
  userId: string;
  ownerRoleId: string;
  permissionsSeeded: number;
  message: string;
};

// ───────────────────────────────────────────────── guard

export async function isBootstrapAllowed(): Promise<{ allowed: boolean; reason?: string }> {
  const envToken = process.env.BOOTSTRAP_TOKEN;
  if (!envToken || envToken === "change-me" || envToken === "") {
    return { allowed: false, reason: "BOOTSTRAP_TOKEN no está configurado en el servidor." };
  }
  const orgCount = await prisma.organization.count();
  if (orgCount > 0) {
    return { allowed: false, reason: "Ya existe al menos una organización. El bootstrap está deshabilitado." };
  }
  return { allowed: true };
}

// ───────────────────────────────────────────────── bootstrap

export async function bootstrapPilot(input: BootstrapInput): Promise<BootstrapResult> {
  // Cerrojo 1 · token
  const envToken = process.env.BOOTSTRAP_TOKEN;
  if (!envToken || envToken === "change-me" || envToken === "") {
    throw new ForbiddenError("Bootstrap deshabilitado: BOOTSTRAP_TOKEN no configurado.");
  }
  if (!input.bootstrapToken || input.bootstrapToken !== envToken) {
    throw new ForbiddenError("Token de bootstrap inválido.");
  }

  // Cerrojo 2 · single-use
  const orgCount = await prisma.organization.count();
  if (orgCount > 0) {
    throw new ForbiddenError("Bootstrap ya ejecutado: existen organizaciones en la base de datos.");
  }

  // Validaciones básicas
  if (!input.organization.name?.trim()) {
    throw new BadRequestError("organization.name es requerido.");
  }
  if (!input.property.name?.trim()) {
    throw new BadRequestError("property.name es requerido.");
  }
  if (!input.adminUser.email?.trim() || !input.adminUser.email.includes("@")) {
    throw new BadRequestError("adminUser.email es requerido y debe ser válido.");
  }
  if (!input.adminUser.fullName?.trim()) {
    throw new BadRequestError("adminUser.fullName es requerido.");
  }
  assertPasswordPolicy(input.adminUser.password);

  const passwordHash = hashPassword(input.adminUser.password);

  // Transacción atómica · org + property + permisos + role + role-permissions + user + UPR
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.organization.name.trim(),
        legalName: input.organization.legalName?.trim(),
        taxId: input.organization.taxId?.trim(),
        country: input.organization.country?.trim() || "ES"
      }
    });

    const property = await tx.property.create({
      data: {
        organizationId: org.id,
        name: input.property.name.trim(),
        legalName: input.property.legalName?.trim(),
        address: input.property.address?.trim(),
        municipality: input.property.municipality?.trim(),
        province: input.property.province?.trim(),
        country: input.property.country?.trim() || "ES",
        taxRegion: input.property.taxRegion?.trim(),
        timezone: input.property.timezone?.trim() || "Europe/Madrid",
        sesHospedajesEnabled: input.property.sesHospedajesEnabled ?? false,
        verifactuEnabled: input.property.verifactuEnabled ?? false
      }
    });

    // Permisos canónicos: upsert para tolerar ejecuciones parciales previas
    // (aunque la guard del count() lo evita, defendemos por si acaso).
    let permissionsSeeded = 0;
    for (const key of PILOT_CANONICAL_PERMISSIONS) {
      await tx.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key }
      });
      permissionsSeeded += 1;
    }

    const ownerRole = await tx.role.create({
      data: {
        organizationId: org.id,
        name: "Owner"
      }
    });

    const allPerms = await tx.permission.findMany({
      where: { key: { in: [...PILOT_CANONICAL_PERMISSIONS] } },
      select: { id: true }
    });

    for (const perm of allPerms) {
      await tx.rolePermission.create({
        data: { roleId: ownerRole.id, permissionId: perm.id }
      });
    }

    const user = await tx.user.create({
      data: {
        organizationId: org.id,
        email: input.adminUser.email.toLowerCase().trim(),
        fullName: input.adminUser.fullName.trim(),
        phone: input.adminUser.phone?.trim(),
        passwordHash,
        passwordChangedAt: new Date(),
        status: "active"
      }
    });

    await tx.userPropertyRole.create({
      data: {
        userId: user.id,
        propertyId: property.id,
        roleId: ownerRole.id
      }
    });

    return {
      organizationId: org.id,
      propertyId: property.id,
      userId: user.id,
      ownerRoleId: ownerRole.id,
      permissionsSeeded
    };
  });

  recordAuditEvent({
    organizationId: result.organizationId,
    propertyId: result.propertyId,
    actorUserId: result.userId,
    actorType: "system",
    action: "PILOT_BOOTSTRAPPED",
    entityType: "organization",
    entityId: result.organizationId,
    afterJson: {
      organizationName: input.organization.name,
      propertyName: input.property.name,
      adminEmail: input.adminUser.email,
      permissionsSeeded: result.permissionsSeeded
    },
    correlationId: "bootstrap"
  });

  return {
    ...result,
    message: "Piloto inicializado. El endpoint /onboarding/bootstrap queda deshabilitado a partir de ahora."
  };
}
