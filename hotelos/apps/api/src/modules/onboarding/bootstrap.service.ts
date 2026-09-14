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

import { normalizeTaxId, spanishTaxIdValidationMessage } from "@hotelos/compliance";
import { prisma, hashPassword } from "@hotelos/database";
import { ROLE_PERMISSION_MAP } from "@hotelos/shared";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, ForbiddenError } from "../../lib/http-error.js";
import { assertPasswordPolicy } from "../auth/auth-pilot.service.js";
import { applyRoleTemplate, syncPermissionCatalog } from "../../lib/rbac-catalog.js";
import { ensurePropertySettings, mirrorOrganization, mirrorProperty } from "../../lib/tenant-hydration.js";

// ───────────────────────────────────────────────── permisos del piloto
// Tanda 1: la lista copiada a mano (79 claves, 4 de ellas fuera del catálogo)
// se sustituye por la plantilla compartida "owner" = ORG_PERMISSION_KEYS
// (packages/shared/src/permissions.ts). Se conserva el nombre exportado para
// los lectores existentes; la fuente única es ROLE_PERMISSION_MAP.owner.
export const PILOT_CANONICAL_PERMISSIONS: readonly string[] = ROLE_PERMISSION_MAP.owner;

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
  // FISC-03: organization.taxId is the issuer NIF of every invoice; when given
  // it must be a checksum-valid DNI / NIE / CIF and is stored normalised.
  const rawTaxId = input.organization.taxId?.trim();
  const taxIdProblem = rawTaxId ? spanishTaxIdValidationMessage(rawTaxId) : null;
  if (taxIdProblem) {
    throw new BadRequestError(`organization.taxId no es un NIF/CIF válido («${rawTaxId}»): ${taxIdProblem}`);
  }
  const organizationTaxId = rawTaxId ? normalizeTaxId(rawTaxId) : undefined;

  const passwordHash = hashPassword(input.adminUser.password);

  // Transacción atómica · org + property + permisos + role + role-permissions + user + UPR
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.organization.name.trim(),
        legalName: input.organization.legalName?.trim(),
        taxId: organizationTaxId,
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

    // Catálogo completo (idempotente, con descripciones reales) + rol Owner con
    // la plantilla compartida "owner" en la misma transacción. Un piloto fresco
    // arranca con el mismo alcance que un tenant creado por createTenant.
    await syncPermissionCatalog({ db: tx });

    const ownerRole = await tx.role.create({
      data: {
        organizationId: org.id,
        name: "Owner"
      }
    });

    const ownerTemplate = await applyRoleTemplate(ownerRole.id, "owner", { db: tx });
    const permissionsSeeded = ownerTemplate.granted;

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
      organization: org,
      property,
      organizationId: org.id,
      propertyId: property.id,
      userId: user.id,
      ownerRoleId: ownerRole.id,
      permissionsSeeded
    };
  });

  // Settings por propiedad (PropertyAiSetting + PropertyComplianceSetting) y
  // espejos en memoria, igual que createTenant, para que el piloto sea usable
  // sin reiniciar. Idempotente.
  await ensurePropertySettings(result.property.id);
  mirrorOrganization(result.organization);
  mirrorProperty(result.property);

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
    organizationId: result.organizationId,
    propertyId: result.propertyId,
    userId: result.userId,
    ownerRoleId: result.ownerRoleId,
    permissionsSeeded: result.permissionsSeeded,
    message: "Piloto inicializado. El endpoint /onboarding/bootstrap queda deshabilitado a partir de ahora."
  };
}
