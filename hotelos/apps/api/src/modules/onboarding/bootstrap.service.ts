// PILOT-D3 · Clean-slate bootstrap para piloto.
//
// Permite arrancar una instancia desde DB vacía sin recurrir a scripts manuales:
//   POST /onboarding/bootstrap → crea Organization + Property + Admin User
//   + Role "Owner" con la plantilla compartida + la asignación en AMBAS
//   tablas (Tanda 8a · L3: user_property_roles del primer centro y
//   user_role_assignments de ámbito organization; auditoría ROLE_ASSIGNED
//   de sistema tras el commit).
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
import { assertPasswordPolicy, recordRoleAssigned, writeRoleAssignment } from "../auth/auth-pilot.service.js";
import { applyRoleTemplate, syncPermissionCatalog } from "../../lib/rbac-catalog.js";
import { ensurePropertySettings, ensurePropertyTaxes, mirrorOrganization, mirrorProperty } from "../../lib/tenant-hydration.js";
import { resolveFiscalLocation } from "../backoffice/backoffice.service.js";
// Tanda 6b (L2, integración): the pilot bootstrap creates the implicit sociedad
// like createTenant does (one LegalEntity per organization, the first Property
// coded and linked to it); the deprecated Organization.legalName / taxId and
// Property.legalName columns are no longer written (design §5.1 · R2).
import { createImplicitLegalEntity, planPropertyCode } from "../structure/legal-entity.service.js";

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
    /** Tanda 3: canonical tax region (ES_PENINSULA_BALEARES · ES_CANARIAS · ES_CEUTA · ES_MELILLA); derived from the province when omitted. */
    taxRegion?: string;
    /** 5-digit Spanish postal code (validated). */
    postalCode?: string;
    /** 5-digit INE municipality code, same province as the postal code (validated). */
    ineMunicipalityCode?: string;
    /** Reporting territory: common (VeriFactu) · bizkaia · gipuzkoa · araba · navarra. */
    fiscalTerritory?: string;
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
  /** Tanda 8a: user_role_assignments row of the first owner (scope organization). */
  ownerAssignmentId: string;
  permissionsSeeded: number;
  /** Tanda 3: statutory tax catalogue provisioned for the property's region (contract C). */
  taxProvisioning: { ok: boolean; taxRegion: string | null; provisioned?: number; skipped?: number; error?: string };
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
  // Tanda 3: fiscal location validated before any write — canonical region (400 when
  // unrecognised; derived from the province when omitted), 5-digit CP / INE coherent by
  // province, reporting territory. Never persists "" or a free-text region.
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

  const passwordHash = hashPassword(input.adminUser.password);

  // Transacción atómica · org + property + permisos + role + role-permissions + user + UPR
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.organization.name.trim(),
        country: input.organization.country?.trim() || "ES"
      }
    });

    // Tanda 6b (R2 · R10.7): the razón social and the NIF live in the implicit
    // sociedad (validated NIF: 400 TAX_ID_INVALID · 409 TAX_ID_IN_USE), never
    // in the deprecated Organization columns. `property.legalName` of the
    // pilot payload was the hotel's trade name: kept as Property.tradeName
    // only when it differs from the razón social.
    const legalEntity = await createImplicitLegalEntity(tx, {
      organizationId: org.id,
      organizationName: org.name,
      legalName: input.organization.legalName?.trim() || null,
      taxId: organizationTaxId ?? null
    });
    const propertyName = input.property.name.trim();
    const propertyTradeName = input.property.legalName?.trim() || null;

    const property = await tx.property.create({
      data: {
        organizationId: org.id,
        legalEntityId: legalEntity.id,
        kind: "hotel",
        code: planPropertyCode(propertyName, { name: org.name, legalName: legalEntity.legalName }, new Set()),
        name: propertyName,
        tradeName: propertyTradeName && propertyTradeName !== legalEntity.legalName ? propertyTradeName : null,
        address: input.property.address?.trim(),
        municipality: input.property.municipality?.trim(),
        province: province ?? undefined,
        country: input.property.country?.trim() || "ES",
        taxRegion: fiscal.taxRegionToPersist,
        postalCode: fiscal.postalCode,
        ineMunicipalityCode: fiscal.ineMunicipalityCode,
        fiscalTerritory: fiscal.fiscalTerritory,
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
        name: "Owner",
        templateKey: "owner"
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

    // Legacy per-property row (dual-read until the cut of L6)…
    await tx.userPropertyRole.create({
      data: {
        userId: user.id,
        propertyId: property.id,
        roleId: ownerRole.id
      }
    });
    // …and the real scope (Tanda 8a): the first owner covers the whole
    // organisation, in user_role_assignments, same transaction.
    const ownerAssignment = await writeRoleAssignment(tx, {
      userId: user.id,
      organizationId: org.id,
      roleId: ownerRole.id,
      scopeType: "organization",
      grantedByUserId: null,
      reason: "bootstrap del piloto"
    });

    return {
      organization: org,
      property,
      organizationId: org.id,
      propertyId: property.id,
      userId: user.id,
      ownerRoleId: ownerRole.id,
      ownerAssignment,
      permissionsSeeded
    };
  });

  // Audit of the grant after the commit (system actor: nobody is logged in yet).
  recordRoleAssigned(result.ownerAssignment, { actorUserId: null, correlationId: "bootstrap" });

  // Settings por propiedad (PropertyAiSetting + PropertyComplianceSetting) y
  // espejos en memoria, igual que createTenant, para que el piloto sea usable
  // sin reiniciar. Idempotente.
  await ensurePropertySettings(result.property.id);
  mirrorOrganization(result.organization);
  mirrorProperty(result.property);

  // Catálogo estatutario de impuestos para la región (contrato C). Idempotente; un
  // fallo se devuelve en el resultado y queda en auditoría (el readiness lo señala)
  // en vez de dejar el piloto a medias tras un 500.
  let taxProvisioning: BootstrapResult["taxProvisioning"];
  try {
    const provisioned = await ensurePropertyTaxes({
      propertyId: result.property.id,
      organizationId: result.organizationId,
      taxRegion: fiscal.taxRegionToPersist
    });
    taxProvisioning = { ok: true, ...provisioned };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[bootstrap] ensurePropertyTaxes failed", {
      propertyId: result.property.id,
      taxRegion: fiscal.taxRegionToPersist,
      correlationId: "bootstrap",
      error: message
    });
    taxProvisioning = { ok: false, taxRegion: fiscal.taxRegion, error: message };
  }

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
      permissionsSeeded: result.permissionsSeeded,
      ownerAssignmentId: result.ownerAssignment.assignmentId,
      fiscal: {
        taxRegion: fiscal.taxRegion,
        taxRegionSource: fiscal.taxRegionSource,
        fiscalTerritory: fiscal.fiscalTerritory,
        postalCode: fiscal.postalCode,
        ineMunicipalityCode: fiscal.ineMunicipalityCode
      },
      taxProvisioning
    },
    correlationId: "bootstrap"
  });

  return {
    organizationId: result.organizationId,
    propertyId: result.propertyId,
    userId: result.userId,
    ownerRoleId: result.ownerRoleId,
    ownerAssignmentId: result.ownerAssignment.assignmentId,
    permissionsSeeded: result.permissionsSeeded,
    taxProvisioning,
    message: "Piloto inicializado. El endpoint /onboarding/bootstrap queda deshabilitado a partir de ahora."
  };
}
