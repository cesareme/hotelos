// Tenant scoping for routes addressed by an ENTITY id instead of a propertyId
// (Tanda 1 · "Tenencia por id de entidad", audit AUTH-02 / SEC-2 / FISC-02).
//
// The global preHandler in server.ts only sees requests that carry a
// `propertyId`. Everything addressed by `/reservations/:id`, `/invoices/:id`,
// `/groups/:id`, `/banking/statements/:id`… bypassed it, so a receptionist of
// one hotel could read or mutate another tenant's rows by primary key.
//
// `assertEntityAccess(request, { entity, id })` closes that gap with ONE
// semantics for every entity:
//
//   1. The RESOLVERS table maps the entity to its OWNER: either a `propertyId`
//      (most operational rows) or an `organizationId` (accounting, payroll,
//      CRM, AI governance…), walking parent relations when the row has no
//      owner column of its own (folio → reservation → property, allotmentDay →
//      allotment → property, loyaltyMembership → loyaltyProgram → org…).
//   2. Missing row → opaque 404 with a NEUTRAL message per entity (never the
//      id, never a hint that the row exists elsewhere — no existence oracle).
//   3. Owner resolved to a propertyId → `grantPropertyAccess` (same semantics
//      as the global hook): same org passes; another org is an opaque 404
//      unless the caller is a platform admin, whose `userContext.organizationId`
//      is RE-POINTED to the row's org so every downstream org check stays
//      consistent for the rest of the request. Tanda 5 (L1c · api): inside
//      the organization the caller must also hold a role in THAT property
//      (`userContext.assignedPropertyIds`, from user_property_roles): a
//      receptionist of Los Tilos got 200 on reservations, folios and guests
//      of Rías Altas (same organization Faranda). Same opaque 404. Platform
//      admins and contexts without assignments (demo fallback, users with no
//      property role) keep the organization-wide scope.
//   4. Owner resolved to an organizationId → `grantOrganizationAccess`, same
//      escape (compare / re-point).
//   5. Optional `propertyId` (routes that carry BOTH `:propertyId` and an
//      entity id — the "confused deputy" family): the row must hang from THAT
//      property (or, for org-owned rows, from that property's organization),
//      otherwise 404. The path property itself was already validated by the
//      global hook.
//   6. The granted owner is RETURNED (`EntityOwner`): handlers whose service
//      keys on a propertyId (legacy advanced-module legs, in-memory boards)
//      act in the ROW's property instead of the caller's active one, so a
//      row of another property of the same org — or, for a platform admin,
//      of another org — is found instead of failing with a 500 downstream.
//      `assertPropertyEntityAccess` is the shorthand for those handlers.
//
// In-memory rows (demoStore / module-private arrays): the resolver reads the
// in-memory collection and the owner check is STRICT — same organization only,
// platform admins included, and no re-pointing. Rationale: the in-memory
// services key on the record's propertyId and on the caller's context for the
// audit trail, so re-pointing `organizationId` would attribute the mutation to
// the wrong tenant without making the service any more coherent. Hybrid
// entities (guest register, authority submissions, onboarding projects,
// integration connections) try the in-memory mirror first and fall back to
// Prisma, where the normal re-pointing semantics apply.

import { prisma } from "@hotelos/database";
import { BadRequestError, NotFoundError } from "./http-error.js";
import { demoStore, type UserContext } from "./demo-store.js";
import { isPlatformAdmin } from "../modules/auth/auth.service.js";
import {
  getOnboardingProject,
  listMappingSuggestions,
  listOnboardingProjects
} from "../modules/onboarding/onboarding.service.js";

export type TenantRequest = { userContext: UserContext };

// Tanda 6b (L2 · estructura societaria, design §5.2 R6): the ONLY `kind = hotel`
// filter for night audit, portfolio, occupancy, tourist tax, SES and per-room
// KPIs lives in lib/finance-scope.ts (no import cycle: finance-scope never
// imports tenancy) and is re-exported from here as the design names this file.
export { filterOperationalProperties, isOperationalKind, listOperationalProperties } from "./finance-scope.js";
export type { OperationalProperty } from "./finance-scope.js";

/** Where a row hangs from. `inMemory` rows get the strict (no re-pointing) check. */
type Owner =
  | { propertyId: string; inMemory?: boolean }
  | { organizationId: string; inMemory?: boolean };

type Resolver = {
  /** Neutral message reused for missing AND foreign rows. */
  notFound: string;
  resolve: (id: string, request: TenantRequest) => Promise<Owner | null>;
};

const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
const ORGANIZATION_NOT_FOUND = "Organización no encontrada.";

/**
 * Property scope inside the organization (L1c): true when the context has no
 * property assignments (organization-wide by construction) or holds a role in
 * `propertyId`. Platform admins are handled by the callers (they may act in
 * any property of any organization).
 */
export function isPropertyAssigned(context: Pick<UserContext, "assignedPropertyIds">, propertyId: string): boolean {
  const assigned = context.assignedPropertyIds;
  if (!assigned || assigned.length === 0) return true;
  return assigned.includes(propertyId);
}

// ── Property / organization grants (shared with the global hook) ────────────

/**
 * Resolves `propertyId` and grants the request access to it or throws 404
 * (`notFoundMessage` is reused for unknown AND foreign properties so the
 * response is never an oracle). Same org AND a role in the property → no-op.
 * Same org without a role there (L1c, `assignedPropertyIds`) → opaque 404.
 * Other org → platform admins get `userContext.organizationId` re-pointed to
 * the property's org; everyone else gets the opaque 404. Returns the
 * property's organizationId.
 */
export async function grantPropertyAccess(
  request: TenantRequest,
  propertyId: string,
  notFoundMessage = PROPERTY_NOT_FOUND
): Promise<string> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true }
  });
  if (!property) throw new NotFoundError(notFoundMessage);
  await grantOrganizationAccess(request, property.organizationId, notFoundMessage);
  if (!isPropertyAssigned(request.userContext, propertyId) && !(await isPlatformAdmin(request.userContext))) {
    throw new NotFoundError(notFoundMessage);
  }
  return property.organizationId;
}

/**
 * Same escape as `grantPropertyAccess` for rows owned directly by an
 * organization: same org → no-op; other org → 404 unless platform admin, who
 * is re-pointed to `organizationId` for the rest of the request.
 */
export async function grantOrganizationAccess(
  request: TenantRequest,
  organizationId: string,
  notFoundMessage = ORGANIZATION_NOT_FOUND
): Promise<void> {
  if (organizationId === request.userContext.organizationId) return;
  if (!(await isPlatformAdmin(request.userContext))) throw new NotFoundError(notFoundMessage);
  // Platform admins act inside the target organization for this request so
  // every downstream org check stays consistent (propertyId is left as-is).
  request.userContext.organizationId = organizationId;
}

/**
 * For list/create routes that accept an optional `organizationId` in the
 * query string or body: returns the organization the request may act in.
 * Without a requested id (or with the caller's own) → the caller's org. With
 * another org → 404 unless platform admin (re-pointed, then returned). The
 * returned value is ALWAYS `userContext.organizationId` after the check, so a
 * query-string org can never widen a tenant's view.
 */
export async function resolveOrganizationScope(
  request: TenantRequest,
  requestedOrganizationId?: string | null
): Promise<string> {
  if (typeof requestedOrganizationId === "string" && requestedOrganizationId.length > 0) {
    await assertEntityAccess(request, { entity: "organization", id: requestedOrganizationId });
  }
  return request.userContext.organizationId;
}

/** Organization of a property: Prisma first, then the in-memory mirror (demo-only properties). */
async function resolvePropertyOrganization(propertyId: string): Promise<string | null> {
  const row = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (row) return row.organizationId;
  const mirror = demoStore.properties.find((candidate) => candidate.id === propertyId);
  return mirror?.organizationId ?? null;
}

// ── Resolver builders ───────────────────────────────────────────────────────

function byProperty(
  notFound: string,
  load: (id: string) => Promise<{ propertyId: string } | null>
): Resolver {
  return {
    notFound,
    resolve: async (id) => {
      const row = await load(id);
      return row ? { propertyId: row.propertyId } : null;
    }
  };
}

function byOrganization(
  notFound: string,
  load: (id: string) => Promise<{ organizationId: string } | null>
): Resolver {
  return {
    notFound,
    resolve: async (id) => {
      const row = await load(id);
      return row ? { organizationId: row.organizationId } : null;
    }
  };
}

/** Rows with BOTH columns nullable (AI governance): property wins, then org; neither → not found (fail-closed). */
function byPropertyOrOrganization(
  notFound: string,
  load: (id: string) => Promise<{ propertyId: string | null; organizationId: string | null } | null>
): Resolver {
  return {
    notFound,
    resolve: async (id) => {
      const row = await load(id);
      if (!row) return null;
      if (row.propertyId) return { propertyId: row.propertyId };
      if (row.organizationId) return { organizationId: row.organizationId };
      return null;
    }
  };
}

/**
 * Dual-written entities (advanced modules, CRM, revenue, groups): Prisma is
 * the source of truth, but seeded demo rows — and rows created before the
 * dual-write — may only exist in the in-memory collections. Prisma is tried
 * first (re-pointing applies); the in-memory fallback is strict.
 */
function withMemoryFallback(
  primary: Resolver,
  fallback: (id: string, request: TenantRequest) => Owner | null
): Resolver {
  return {
    notFound: primary.notFound,
    resolve: async (id, request) => (await primary.resolve(id, request)) ?? fallback(id, request)
  };
}

/** Generic advanced-module rows created through createAdvancedRecord live in demoStore.advancedRecords. */
function advancedRecordFallback(id: string): Owner | null {
  const row = demoStore.advancedRecords.find((candidate) => candidate.id === id);
  return row ? { propertyId: row.propertyId, inMemory: true } : null;
}

function propertyMirrorFallback(collection: Array<{ id: string; propertyId: string }>): (id: string) => Owner | null {
  return (id) => {
    const row = collection.find((candidate) => candidate.id === id);
    return row ? { propertyId: row.propertyId, inMemory: true } : null;
  };
}

function organizationMirrorFallback(
  collection: Array<{ id: string; organizationId: string }>
): (id: string) => Owner | null {
  return (id) => {
    const row = collection.find((candidate) => candidate.id === id);
    return row ? { organizationId: row.organizationId, inMemory: true } : null;
  };
}

/**
 * Rows without an owner column and without a Prisma relation field (only the
 * FK column): load the parent's id, then resolve through the parent's own
 * resolver — lazily, because the table is self-referential.
 */
function viaParent(
  notFound: string,
  loadParentId: (id: string) => Promise<string | null | undefined>,
  parent: () => Resolver
): Resolver {
  return {
    notFound,
    resolve: async (id, request): Promise<Owner | null> => {
      const parentId = await loadParentId(id);
      if (!parentId) return null;
      return parent().resolve(parentId, request);
    }
  };
}

const selectProperty = { propertyId: true } as const;
const selectOrganization = { organizationId: true } as const;

/** Onboarding projects visible to the caller's organization (in-memory service). */
function onboardingProjectsForCaller(request: TenantRequest) {
  return listOnboardingProjects(request.userContext).items.filter(
    (project) => project.organizationId === request.userContext.organizationId
  );
}

// ── Resolver table ──────────────────────────────────────────────────────────

const RESOLVERS = {
  // ─ Property-owned rows (Prisma, direct column) ─
  reservation: byProperty("Reserva no encontrada.", (id) =>
    prisma.reservation.findUnique({ where: { id }, select: selectProperty })
  ),
  invoice: byProperty("Factura no encontrada.", (id) =>
    prisma.invoice.findUnique({ where: { id }, select: selectProperty })
  ),
  payment: byProperty("Pago no encontrado.", (id) =>
    prisma.payment.findUnique({ where: { id }, select: selectProperty })
  ),
  verifactuSubmission: byProperty("Envío VeriFactu no encontrado.", (id) =>
    prisma.verifactuSubmission.findUnique({ where: { id }, select: selectProperty })
  ),
  tbaiSubmission: byProperty("Envío TicketBAI no encontrado.", (id) =>
    prisma.tbaiSubmission.findUnique({ where: { id }, select: selectProperty })
  ),
  igicSubmission: byProperty("Envío IGIC no encontrado.", (id) =>
    prisma.igicSubmission.findUnique({ where: { id }, select: selectProperty })
  ),
  sesHospedajesSubmission: byProperty("Envío SES Hospedajes no encontrado.", (id) =>
    prisma.sesHospedajesSubmission.findUnique({ where: { id }, select: selectProperty })
  ),
  groupBooking: withMemoryFallback(
    byProperty("Grupo no encontrado.", (id) => prisma.groupBooking.findUnique({ where: { id }, select: selectProperty })),
    propertyMirrorFallback(demoStore.groupBookings)
  ),
  event: withMemoryFallback(
    byProperty("Evento no encontrado.", (id) => prisma.event.findUnique({ where: { id }, select: selectProperty })),
    propertyMirrorFallback(demoStore.hotelEvents)
  ),
  salesOpportunity: byProperty("Oportunidad no encontrada.", (id) =>
    prisma.salesOpportunity.findUnique({ where: { id }, select: selectProperty })
  ),
  shift: withMemoryFallback(
    byProperty("Turno no encontrado.", (id) => prisma.shift.findUnique({ where: { id }, select: selectProperty })),
    advancedRecordFallback
  ),
  absenceRequest: withMemoryFallback(
    byProperty("Solicitud de ausencia no encontrada.", (id) =>
      prisma.absenceRequest.findUnique({ where: { id }, select: selectProperty })
    ),
    advancedRecordFallback
  ),
  safetyIncident: withMemoryFallback(
    byProperty("Incidencia no encontrada.", (id) =>
      prisma.safetyIncident.findUnique({ where: { id }, select: selectProperty })
    ),
    advancedRecordFallback
  ),
  safetyCheck: withMemoryFallback(
    byProperty("Control de seguridad no encontrado.", (id) =>
      prisma.safetyCheck.findUnique({ where: { id }, select: selectProperty })
    ),
    advancedRecordFallback
  ),
  qualityCase: withMemoryFallback(
    byProperty("Caso de calidad no encontrado.", (id) =>
      prisma.qualityCase.findUnique({ where: { id }, select: selectProperty })
    ),
    advancedRecordFallback
  ),
  survey: withMemoryFallback(
    byProperty("Encuesta no encontrada.", (id) => prisma.survey.findUnique({ where: { id }, select: selectProperty })),
    advancedRecordFallback
  ),
  channel: byProperty("Canal no encontrado.", (id) =>
    prisma.channel.findUnique({ where: { id }, select: selectProperty })
  ),
  rateParityAlert: byProperty("Alerta de paridad no encontrada.", (id) =>
    prisma.rateParityAlert.findUnique({ where: { id }, select: selectProperty })
  ),
  revenueRecommendation: withMemoryFallback(
    byProperty("Recomendación no encontrada.", (id) =>
      prisma.revenueRecommendation.findUnique({ where: { id }, select: selectProperty })
    ),
    propertyMirrorFallback(demoStore.revenueRecommendations)
  ),
  pricingRule: byProperty("Regla de precios no encontrada.", (id) =>
    prisma.pricingRule.findUnique({ where: { id }, select: selectProperty })
  ),
  ratePlan: byProperty("Plan de tarifas no encontrado.", (id) =>
    prisma.ratePlan.findUnique({ where: { id }, select: selectProperty })
  ),
  cancellationPolicy: byProperty("Política de cancelación no encontrada.", (id) =>
    prisma.cancellationPolicy.findUnique({ where: { id }, select: selectProperty })
  ),
  allotment: byProperty("Cupo no encontrado.", (id) =>
    prisma.allotment.findUnique({ where: { id }, select: selectProperty })
  ),
  commissionRule: byProperty("Regla de comisión no encontrada.", (id) =>
    prisma.commissionRule.findUnique({ where: { id }, select: selectProperty })
  ),
  asset: byProperty("Activo no encontrado.", (id) =>
    prisma.asset.findUnique({ where: { id }, select: selectProperty })
  ),
  capexProject: byProperty("Proyecto CAPEX no encontrado.", (id) =>
    prisma.capexProject.findUnique({ where: { id }, select: selectProperty })
  ),
  menuItem: byProperty("Plato no encontrado.", (id) =>
    prisma.menuItem.findUnique({ where: { id }, select: selectProperty })
  ),
  // Tanda 3 (CF-02): staff upsell catalogue — `PATCH /upsell-offers/:id` is
  // addressed by entity id only, so the row's property is the tenant owner.
  upsellOffer: byProperty("Oferta de upsell no encontrada.", (id) =>
    prisma.upsellOffer.findUnique({ where: { id }, select: selectProperty })
  ),
  conversation: byProperty("Conversación no encontrada.", (id) =>
    prisma.conversation.findUnique({ where: { id }, select: selectProperty })
  ),
  serviceRequest: byProperty("Solicitud de servicio no encontrada.", (id) =>
    prisma.serviceRequest.findUnique({ where: { id }, select: selectProperty })
  ),
  complianceTask: byProperty("Tarea de cumplimiento no encontrada.", (id) =>
    prisma.complianceTask.findUnique({ where: { id }, select: selectProperty })
  ),
  complianceDocument: byProperty("Documento de cumplimiento no encontrado.", (id) =>
    prisma.complianceDocument.findUnique({ where: { id }, select: selectProperty })
  ),
  emailConnection: byProperty("Conexión de correo no encontrada.", (id) =>
    prisma.emailConnection.findUnique({ where: { id }, select: selectProperty })
  ),
  inboundEmail: byProperty("Correo entrante no encontrado.", (id) =>
    prisma.inboundEmail.findUnique({ where: { id }, select: selectProperty })
  ),
  room: byProperty("Habitación no encontrada.", (id) =>
    prisma.room.findUnique({ where: { id }, select: selectProperty })
  ),
  roomType: byProperty("Tipo de habitación no encontrado.", (id) =>
    prisma.roomType.findUnique({ where: { id }, select: selectProperty })
  ),
  bankStatement: byProperty("Extracto bancario no encontrado.", (id) =>
    prisma.bankStatement.findUnique({ where: { id }, select: selectProperty })
  ),
  externalReservation: byProperty("Reserva externa no encontrada.", (id) =>
    prisma.externalReservation.findUnique({ where: { id }, select: selectProperty })
  ),
  authoritySubmissionBatch: byProperty("Lote de envío no encontrado.", (id) =>
    prisma.authoritySubmissionBatch.findUnique({ where: { id }, select: selectProperty })
  ),
  department: byProperty("Departamento no encontrado.", (id) =>
    prisma.department.findUnique({ where: { id }, select: selectProperty })
  ),
  propertyImport: byProperty("Importación no encontrada.", (id) =>
    prisma.propertyImport.findUnique({ where: { id }, select: selectProperty })
  ),
  housekeepingSection: byProperty("Sección de housekeeping no encontrada.", (id) =>
    prisma.housekeepingSection.findUnique({ where: { id }, select: selectProperty })
  ),
  maintenanceArea: byProperty("Área de mantenimiento no encontrada.", (id) =>
    prisma.maintenanceArea.findUnique({ where: { id }, select: selectProperty })
  ),
  propertyAiToolSetting: byProperty("Configuración de herramienta no encontrada.", (id) =>
    prisma.propertyAiToolSetting.findUnique({ where: { id }, select: selectProperty })
  ),

  // ─ Property-owned through a parent (Prisma) ─
  folio: byProperty("Folio no encontrado.", async (id) => {
    const row = await prisma.folio.findUnique({
      where: { id },
      select: { reservation: { select: selectProperty } }
    });
    return row ? { propertyId: row.reservation.propertyId } : null;
  }),
  folioLine: byProperty("Línea de folio no encontrada.", async (id) => {
    const row = await prisma.folioLine.findUnique({
      where: { id },
      select: { folio: { select: { reservation: { select: selectProperty } } } }
    });
    return row ? { propertyId: row.folio.reservation.propertyId } : null;
  }),
  folioRoutingRule: viaParent(
    "Regla de enrutamiento no encontrada.",
    async (id) =>
      (await prisma.folioRoutingRule.findUnique({ where: { id }, select: { reservationId: true } }))?.reservationId,
    (): Resolver => RESOLVERS.reservation
  ),
  groupRoomBlock: viaParent(
    "Bloqueo de grupo no encontrado.",
    async (id) =>
      (await prisma.groupRoomBlock.findUnique({ where: { id }, select: { groupBookingId: true } }))?.groupBookingId,
    (): Resolver => RESOLVERS.groupBooking
  ),
  eventOrder: viaParent(
    "Orden de evento no encontrada.",
    async (id) => (await prisma.eventOrder.findUnique({ where: { id }, select: { eventId: true } }))?.eventId,
    (): Resolver => RESOLVERS.event
  ),
  incidentEvidence: viaParent(
    "Evidencia no encontrada.",
    async (id) => (await prisma.incidentEvidence.findUnique({ where: { id }, select: { incidentId: true } }))?.incidentId,
    (): Resolver => RESOLVERS.safetyIncident
  ),
  safetyCheckResult: viaParent(
    "Resultado de control no encontrado.",
    async (id) =>
      (await prisma.safetyCheckResult.findUnique({ where: { id }, select: { safetyCheckId: true } }))?.safetyCheckId,
    (): Resolver => RESOLVERS.safetyCheck
  ),
  surveyResponse: viaParent(
    "Respuesta de encuesta no encontrada.",
    async (id) => (await prisma.surveyResponse.findUnique({ where: { id }, select: { surveyId: true } }))?.surveyId,
    (): Resolver => RESOLVERS.survey
  ),
  channelRoomMapping: viaParent(
    "Mapeo de habitación no encontrado.",
    async (id) => (await prisma.channelRoomMapping.findUnique({ where: { id }, select: { channelId: true } }))?.channelId,
    (): Resolver => RESOLVERS.channel
  ),
  channelRateMapping: viaParent(
    "Mapeo de tarifa no encontrado.",
    async (id) => (await prisma.channelRateMapping.findUnique({ where: { id }, select: { channelId: true } }))?.channelId,
    (): Resolver => RESOLVERS.channel
  ),
  allotmentDay: viaParent(
    "Día de cupo no encontrado.",
    async (id) => (await prisma.allotmentDay.findUnique({ where: { id }, select: { allotmentId: true } }))?.allotmentId,
    (): Resolver => RESOLVERS.allotment
  ),
  menuRecipe: viaParent(
    "Receta no encontrada.",
    async (id) => (await prisma.menuRecipe.findUnique({ where: { id }, select: { menuItemId: true } }))?.menuItemId,
    (): Resolver => RESOLVERS.menuItem
  ),
  // Subscriptions hang from a property when they have one, otherwise from the
  // developer app's organization (platform-level apps).
  webhookSubscription: {
    notFound: "Suscripción de webhook no encontrada.",
    resolve: async (id, request): Promise<Owner | null> => {
      const row = await prisma.webhookSubscription.findUnique({
        where: { id },
        select: { propertyId: true, developerAppId: true }
      });
      if (!row) return null;
      if (row.propertyId) return { propertyId: row.propertyId };
      return RESOLVERS.developerApp.resolve(row.developerAppId, request);
    }
  } satisfies Resolver,
  webhookDelivery: viaParent(
    "Entrega de webhook no encontrada.",
    async (id) =>
      (await prisma.webhookDelivery.findUnique({ where: { id }, select: { webhookSubscriptionId: true } }))
        ?.webhookSubscriptionId,
    (): Resolver => RESOLVERS.webhookSubscription
  ),
  // Wallet passes live in the raw `advanced_records` table (no Prisma model).
  mobileKey: byProperty("Llave móvil no encontrada.", async (serialNumber) => {
    const rows = await prisma.$queryRawUnsafe<Array<{ property_id: string }>>(
      `SELECT property_id FROM advanced_records
       WHERE module_code = 'guest_self_service' AND entity_type = 'mobile_key' AND entity_id = $1
       LIMIT 1`,
      serialNumber
    );
    return rows[0] ? { propertyId: rows[0].property_id } : null;
  }),

  // Tanda 6b (L2): a Property addressed by its own id (PATCH /properties/:propertyId/establishment).
  // Owner = itself → grantPropertyAccess (same org + a role in the property; platform admins re-pointed).
  property: {
    notFound: PROPERTY_NOT_FOUND,
    resolve: async (id) => {
      const row = await prisma.property.findUnique({ where: { id }, select: { id: true } });
      if (row) return { propertyId: row.id };
      const mirror = demoStore.properties.find((candidate) => candidate.id === id);
      return mirror ? { propertyId: mirror.id, inMemory: true } : null;
    }
  } satisfies Resolver,

  // ─ Organization-owned rows (Prisma, direct column) ─
  // Tanda 6b (L2): the legal entity (sociedad) hangs from its organization.
  legalEntity: byOrganization("Sociedad no encontrada.", (id) =>
    prisma.legalEntity.findUnique({ where: { id }, select: selectOrganization })
  ),
  organization: {
    notFound: ORGANIZATION_NOT_FOUND,
    resolve: async (id) => {
      const row = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
      if (row) return { organizationId: row.id };
      return demoStore.organization.id === id ? { organizationId: id, inMemory: true } : null;
    }
  } satisfies Resolver,
  user: {
    notFound: "Usuario no encontrado.",
    resolve: async (id) => {
      const row = await prisma.user.findUnique({ where: { id }, select: selectOrganization });
      if (row) return { organizationId: row.organizationId };
      const mirror = demoStore.users.find((candidate) => candidate.id === id);
      return mirror ? { organizationId: mirror.organizationId, inMemory: true } : null;
    }
  } satisfies Resolver,
  // Tanda 3 (CFG-P1-6): persisted staff invitations hang from the organization
  // of the invited user (the token itself is never an entity id on a route).
  userInvitation: byOrganization("Invitación no encontrada.", (id) =>
    prisma.userInvitation.findUnique({ where: { id }, select: selectOrganization })
  ),
  guest: byOrganization("Huésped no encontrado.", (id) =>
    prisma.guest.findUnique({ where: { id }, select: selectOrganization })
  ),
  guestProfile: withMemoryFallback(
    byOrganization("Perfil no encontrado.", (id) =>
      prisma.guestProfile.findUnique({ where: { id }, select: selectOrganization })
    ),
    organizationMirrorFallback(demoStore.guestProfiles)
  ),
  gdprRequest: byOrganization("Solicitud RGPD no encontrada.", (id) =>
    prisma.gdprRequest.findUnique({ where: { id }, select: selectOrganization })
  ),
  crmSegment: withMemoryFallback(
    byOrganization("Segmento no encontrado.", (id) =>
      prisma.crmSegment.findUnique({ where: { id }, select: selectOrganization })
    ),
    organizationMirrorFallback(demoStore.crmSegments)
  ),
  crmCampaign: withMemoryFallback(
    byOrganization("Campaña no encontrada.", (id) =>
      prisma.crmCampaign.findUnique({ where: { id }, select: selectOrganization })
    ),
    organizationMirrorFallback(demoStore.crmCampaigns)
  ),
  loyaltyProgram: byOrganization("Programa de fidelización no encontrado.", (id) =>
    prisma.loyaltyProgram.findUnique({ where: { id }, select: selectOrganization })
  ),
  loyaltyMembership: withMemoryFallback(
    viaParent(
      "Membresía no encontrada.",
      async (id) =>
        (await prisma.loyaltyMembership.findUnique({ where: { id }, select: { loyaltyProgramId: true } }))
          ?.loyaltyProgramId,
      (): Resolver => RESOLVERS.loyaltyProgram
    ),
    (id) => {
      const membership = demoStore.loyaltyMemberships.find((candidate) => candidate.id === id);
      if (!membership) return null;
      const program = demoStore.loyaltyPrograms.find((candidate) => candidate.id === membership.loyaltyProgramId);
      return program ? { organizationId: program.organizationId, inMemory: true } : null;
    }
  ),
  tourOperator: byOrganization("Turoperador no encontrado.", (id) =>
    prisma.tourOperator.findUnique({ where: { id }, select: selectOrganization })
  ),
  account: byOrganization("Cuenta contable no encontrada.", (id) =>
    prisma.account.findUnique({ where: { id }, select: selectOrganization })
  ),
  journalEntry: byOrganization("Asiento no encontrado.", (id) =>
    prisma.journalEntry.findUnique({ where: { id }, select: selectOrganization })
  ),
  fiscalPeriod: byOrganization("Periodo fiscal no encontrado.", (id) =>
    prisma.fiscalPeriod.findUnique({ where: { id }, select: selectOrganization })
  ),
  fiscalYear: byOrganization("Ejercicio fiscal no encontrado.", (id) =>
    prisma.fiscalYear.findUnique({ where: { id }, select: selectOrganization })
  ),
  bankAccount: byOrganization("Cuenta bancaria no encontrada.", (id) =>
    prisma.bankAccount.findUnique({ where: { id }, select: selectOrganization })
  ),
  bankStatementLine: viaParent(
    "Línea bancaria no encontrada.",
    async (id) =>
      (await prisma.bankStatementLine.findUnique({ where: { id }, select: { bankAccountId: true } }))?.bankAccountId,
    (): Resolver => RESOLVERS.bankAccount
  ),
  employmentContract: byOrganization("Contrato no encontrado.", (id) =>
    prisma.employmentContract.findUnique({ where: { id }, select: selectOrganization })
  ),
  payrollPeriod: byOrganization("Periodo de nómina no encontrado.", (id) =>
    prisma.payrollPeriod.findUnique({ where: { id }, select: selectOrganization })
  ),
  // Coste de personal importado (Tanda 6c · L3): lote agregado por organización
  // (GET /payroll/cost-imports/:id, POST …/:id/post, POST …/:id/reverse); el
  // ámbito por centro (R11) lo aplica el servicio con assertFinanceReadScopeMany.
  payrollCostImport: byOrganization("Importación de coste de personal no encontrada.", (id) =>
    prisma.payrollCostImport.findUnique({ where: { id }, select: selectOrganization })
  ),
  developerApp: byOrganization("Aplicación no encontrada.", (id) =>
    prisma.developerApp.findUnique({ where: { id }, select: selectOrganization })
  ),
  notificationTemplate: byOrganization("Plantilla no encontrada.", (id) =>
    prisma.notificationTemplate.findUnique({ where: { id }, select: selectOrganization })
  ),
  notificationDelivery: byOrganization("Envío no encontrado.", (id) =>
    prisma.notificationDelivery.findUnique({ where: { id }, select: selectOrganization })
  ),
  aiToolCall: byOrganization("Llamada de herramienta no encontrada.", (id) =>
    prisma.aiToolCall.findUnique({ where: { id }, select: selectOrganization })
  ),
  aiHumanReviewItem: byOrganization("Elemento de revisión no encontrado.", (id) =>
    prisma.aiHumanReviewItem.findUnique({ where: { id }, select: selectOrganization })
  ),
  aiPolicy: byOrganization("Política no encontrada.", (id) =>
    prisma.aiPolicy.findUnique({ where: { id }, select: selectOrganization })
  ),
  aiIncident: byOrganization("Incidente no encontrado.", (id) =>
    prisma.aiIncident.findUnique({ where: { id }, select: selectOrganization })
  ),
  aiEvaluation: byPropertyOrOrganization("Evaluación no encontrada.", (id) =>
    prisma.aiEvaluation.findUnique({ where: { id }, select: { propertyId: true, organizationId: true } })
  ),

  // ─ Legacy revenue_profit_engine legs: the `/revenue/*` and `/channel-manager/*`
  //   by-id routes mutate the in-memory boards (demoStore.channels,
  //   demandCalendarEvents, revenueAutomationRules, revenueScenarios), which
  //   are seeded in code and never dual-written. Prisma is still tried first
  //   (re-pointing applies for migrated rows); the mirror fallback is strict.
  //   `revenueChannel` deliberately differs from `channel` (Prisma-only, used
  //   by the aggregator routes) so a mirror-only demo channel keeps working on
  //   the legacy legs without widening the aggregator guard. ─
  revenueChannel: withMemoryFallback(
    byProperty("Canal no encontrado.", (id) => prisma.channel.findUnique({ where: { id }, select: selectProperty })),
    propertyMirrorFallback(demoStore.channels)
  ),
  demandCalendarEvent: withMemoryFallback(
    byProperty("Evento de demanda no encontrado.", (id) =>
      prisma.demandCalendarEvent.findUnique({ where: { id }, select: selectProperty })
    ),
    propertyMirrorFallback(demoStore.demandCalendarEvents)
  ),
  revenueAutomationRule: withMemoryFallback(
    byProperty("Regla de automatización no encontrada.", (id) =>
      prisma.revenueAutomationRule.findUnique({ where: { id }, select: selectProperty })
    ),
    propertyMirrorFallback(demoStore.revenueAutomationRules)
  ),
  revenueScenario: withMemoryFallback(
    byProperty("Escenario no encontrado.", (id) =>
      prisma.revenueScenario.findUnique({ where: { id }, select: selectProperty })
    ),
    propertyMirrorFallback(demoStore.revenueScenarios)
  ),

  // ─ Hybrid rows: in-memory mirror first (strict), Prisma fallback (re-pointing) ─
  guestRegisterRecord: {
    notFound: "Registro de viajero no encontrado.",
    resolve: async (id) => {
      const mirror = demoStore.guestRegisterRecords.find((candidate) => candidate.id === id);
      if (mirror) return { propertyId: mirror.propertyId, inMemory: true };
      const row = await prisma.guestRegisterRecord.findUnique({ where: { id }, select: selectProperty });
      return row ? { propertyId: row.propertyId } : null;
    }
  } satisfies Resolver,
  authoritySubmission: {
    notFound: "Envío a la autoridad no encontrado.",
    resolve: async (id) => {
      const mirror = demoStore.authoritySubmissions.find((candidate) => candidate.id === id);
      if (mirror) return { propertyId: mirror.propertyId, inMemory: true };
      const row = await prisma.authoritySubmission.findUnique({ where: { id }, select: selectProperty });
      return row ? { propertyId: row.propertyId } : null;
    }
  } satisfies Resolver,
  integrationConnection: {
    notFound: "Conexión de integración no encontrada.",
    resolve: async (id) => {
      const row = await prisma.integrationConnection.findUnique({ where: { id }, select: selectProperty });
      if (row) return { propertyId: row.propertyId };
      const mirror = demoStore.integrationConnections.find((candidate) => candidate.id === id);
      return mirror ? { propertyId: mirror.propertyId, inMemory: true } : null;
    }
  } satisfies Resolver,
  onboardingProject: {
    notFound: "Proyecto de onboarding no encontrado.",
    resolve: async (id, request) => {
      const mirror = listOnboardingProjects(request.userContext).items.find((candidate) => candidate.id === id);
      if (mirror) return { organizationId: mirror.organizationId, inMemory: true };
      const row = await prisma.onboardingProject.findUnique({ where: { id }, select: selectOrganization });
      return row ? { organizationId: row.organizationId } : null;
    }
  } satisfies Resolver,

  // ─ In-memory only (strict: same organization, no re-pointing) ─
  sesSubmission: {
    notFound: "Envío SES no encontrado.",
    resolve: async (id) => {
      // Tanda 3: SES submissions live in Prisma (ids are cuids); the in-memory
      // list is gone, so an unknown id is simply not found.
      const row = await prisma.sesHospedajesSubmission.findUnique({ where: { id }, select: { propertyId: true } });
      return row ? { propertyId: row.propertyId } : null;
    }
  } satisfies Resolver,
  pendingConfirmation: {
    notFound: "Confirmación no encontrada.",
    resolve: async (id) => {
      const row = demoStore.pendingConfirmations.find((candidate) => candidate.id === id);
      return row ? { propertyId: row.propertyId, inMemory: true } : null;
    }
  } satisfies Resolver,
  advancedRecord: {
    notFound: "Recurso no encontrado.",
    resolve: async (id) => {
      const row = demoStore.advancedRecords.find((candidate) => candidate.id === id);
      return row ? { propertyId: row.propertyId, inMemory: true } : null;
    }
  } satisfies Resolver,
  // POS tickets are Prisma-first (Tanda 2 · FISC-05): a ticket IS a PosOrder
  // row, so its owner is pos_orders.property_id with the normal re-pointing
  // semantics. Finanzas (2026-09-16): the synthetic in-memory board of
  // prop_123 / prop_456 no longer exists, so there is no fallback.
  posTicket: {
    notFound: "Ticket no encontrado.",
    resolve: async (id) => {
      const row = await prisma.posOrder.findUnique({ where: { id }, select: selectProperty });
      return row ? { propertyId: row.propertyId } : null;
    }
  } satisfies Resolver,
  // Onboarding sub-entities only exist in the in-memory service and are only
  // reachable through their project, so they are searched within the caller's
  // organization: a foreign id is indistinguishable from a missing one.
  onboardingSourceConnection: {
    notFound: "Conexión de origen no encontrada.",
    resolve: async (id, request) => {
      for (const project of onboardingProjectsForCaller(request)) {
        const detail = getOnboardingProject({ context: request.userContext, projectId: project.id });
        if (detail.sourceConnections.some((connection) => connection.id === id)) {
          return { organizationId: project.organizationId, inMemory: true };
        }
      }
      return null;
    }
  } satisfies Resolver,
  onboardingFile: {
    notFound: "Fichero de onboarding no encontrado.",
    resolve: async (id, request) => {
      for (const project of onboardingProjectsForCaller(request)) {
        const detail = getOnboardingProject({ context: request.userContext, projectId: project.id });
        if (detail.files.some((file) => file.id === id)) {
          return { organizationId: project.organizationId, inMemory: true };
        }
      }
      return null;
    }
  } satisfies Resolver,
  onboardingMappingSuggestion: {
    notFound: "Sugerencia de mapeo no encontrada.",
    resolve: async (id, request) => {
      for (const project of onboardingProjectsForCaller(request)) {
        const { items } = listMappingSuggestions({ context: request.userContext, projectId: project.id });
        if (items.some((suggestion) => suggestion.id === id)) {
          return { organizationId: project.organizationId, inMemory: true };
        }
      }
      return null;
    }
  } satisfies Resolver
} satisfies Record<string, Resolver>;

export type TenantEntity = keyof typeof RESOLVERS;

export type EntityAccessInput = {
  entity: TenantEntity;
  /** Primary key (or serial / natural key) taken from the path, query or body. */
  id: string;
  /**
   * Confused-deputy cross-check for routes that also carry `:propertyId`:
   * the row must belong to this property (org-owned rows: to its org).
   */
  propertyId?: string;
  /** Override the entity's neutral message (still never echo the id). */
  notFound?: string;
};

/** Owner of the row `assertEntityAccess` granted: its organization and, for property-owned rows, the property. */
export type EntityOwner = { organizationId: string; propertyId?: string };

/**
 * Tenant guard for routes addressed by an entity id. See the module comment
 * for the full semantics. Throws:
 *   · 400 when `id` is not a non-empty string (malformed request, not an oracle);
 *   · 404 (neutral message) when the row is missing, belongs to another tenant
 *     the caller may not act in, or does not hang from `propertyId`.
 * Resolves to the granted owner (see point 6 of the module comment).
 */
export async function assertEntityAccess(request: TenantRequest, input: EntityAccessInput): Promise<EntityOwner> {
  const resolver: Resolver = RESOLVERS[input.entity];
  const notFound = input.notFound ?? resolver.notFound;
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new BadRequestError("Identificador inválido.");
  }
  const owner = await resolver.resolve(input.id, request);
  if (!owner) throw new NotFoundError(notFound);

  if (input.propertyId) {
    if ("propertyId" in owner) {
      if (owner.propertyId !== input.propertyId) throw new NotFoundError(notFound);
    } else {
      const propertyOrganization = await resolvePropertyOrganization(input.propertyId);
      if (propertyOrganization !== owner.organizationId) throw new NotFoundError(notFound);
    }
  }

  if (owner.inMemory) {
    const organizationId =
      "propertyId" in owner ? await resolvePropertyOrganization(owner.propertyId) : owner.organizationId;
    if (!organizationId || organizationId !== request.userContext.organizationId) throw new NotFoundError(notFound);
    // Same property scope as the Prisma branch (L1c); platform admins are not
    // re-pointed here by design (see the module comment) but keep their reach.
    if ("propertyId" in owner && !isPropertyAssigned(request.userContext, owner.propertyId) && !(await isPlatformAdmin(request.userContext))) {
      throw new NotFoundError(notFound);
    }
    return "propertyId" in owner ? { organizationId, propertyId: owner.propertyId } : { organizationId };
  }

  if ("propertyId" in owner) {
    const organizationId = await grantPropertyAccess(request, owner.propertyId, notFound);
    return { organizationId, propertyId: owner.propertyId };
  }
  await grantOrganizationAccess(request, owner.organizationId, notFound);
  return { organizationId: owner.organizationId };
}

/**
 * `assertEntityAccess` for rows that hang from a property: returns that
 * propertyId so the handler acts in the ROW's property (module gating, audit
 * trail, in-memory lookups) instead of the caller's active one. Only for
 * property-owned entities — an org-owned entity here is a programming error
 * and is reported as the entity's neutral 404 rather than a 500.
 */
export async function assertPropertyEntityAccess(request: TenantRequest, input: EntityAccessInput): Promise<string> {
  const owner = await assertEntityAccess(request, input);
  if (!owner.propertyId) throw new NotFoundError(input.notFound ?? RESOLVERS[input.entity].notFound);
  return owner.propertyId;
}
