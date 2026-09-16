// Estructura societaria · L2 · HTTP surface (design §5.4).
//
// Registered from server.ts with `registerStructureRoutes(app)` right after
// registerFinancialStatementsRoutes(app) (handoff to the integrator) and
// `listSwitchableProperties` of GET /users/me/properties and GET /properties
// delegates to legal-entity.service.listSwitchableProperties (same handoff).
// Permissions: route-permissions.partial.ts (spread into routePermissionManifest;
// the contract test reads that file). Every body is a `.strict()` zod schema
// (structure.schemas.ts) parsed with parseOr400 → 400 VALIDATION_ERROR in Spanish.
//
// Tenancy: `:legalEntityId` goes through assertEntityAccess("legalEntity")
// (opaque 404 outside the caller's organization; a platform admin is
// re-pointed to the entity's organization for the request), `:propertyId`
// through the global preHandler of server.ts plus assertEntityAccess("property").
// With STRUCTURE_ENABLED=false every route answers 404 STRUCTURE_DISABLED.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  assertStructureEnabled,
  createLegalEntity,
  getLegalEntity,
  getStructure,
  listInstallations,
  listLegalEntitySeries,
  patchLegalEntity,
  setVerifactuChainScope
} from "./legal-entity.service.js";
import { patchEstablishment, provisionCentre } from "./property-provisioning.service.js";
import { establishmentPatchSchema, legalEntityCreateSchema, legalEntityPatchSchema, propertyCreateBodySchema, verifactuScopeBodySchema } from "./structure.schemas.js";

type LegalEntityParams = { legalEntityId: string };
type PropertyParams = { propertyId: string };

async function grantLegalEntity(request: FastifyRequest): Promise<string> {
  const { legalEntityId } = request.params as LegalEntityParams;
  await assertEntityAccess(request, { entity: "legalEntity", id: legalEntityId });
  return legalEntityId;
}

export function registerStructureRoutes(app: FastifyInstance): void {
  // Único punto de verdad del front: sociedad + centros + series + instalaciones + modo.
  app.get("/organizations/me/structure", async (request) => {
    assertStructureEnabled();
    return getStructure(request.userContext);
  });

  // Sociedad (una por organización; la segunda → 409 MULTI_ENTITY_NOT_ENABLED).
  app.post("/legal-entities", async (request) => {
    assertStructureEnabled();
    const body = parseOr400(legalEntityCreateSchema, request.body ?? {}, "Sociedad");
    return createLegalEntity({ context: request.userContext, body, correlationId: createId("corr") });
  });

  app.get("/legal-entities/:legalEntityId", async (request) => {
    assertStructureEnabled();
    const legalEntityId = await grantLegalEntity(request);
    return getLegalEntity(request.userContext, legalEntityId);
  });

  app.patch("/legal-entities/:legalEntityId", async (request) => {
    assertStructureEnabled();
    const legalEntityId = await grantLegalEntity(request);
    const body = parseOr400(legalEntityPatchSchema, request.body ?? {}, "Sociedad");
    return patchLegalEntity({ context: request.userContext, legalEntityId, body, correlationId: createId("corr") });
  });

  // Alta de centro (hotel · oficina · otro); `dryRun: true` valida en vivo desde el asistente.
  app.post("/legal-entities/:legalEntityId/properties", async (request) => {
    assertStructureEnabled();
    const legalEntityId = await grantLegalEntity(request);
    const body = parseOr400(propertyCreateBodySchema, request.body ?? {}, "Centro de trabajo");
    return provisionCentre({ context: request.userContext, legalEntityId, body, correlationId: createId("corr") });
  });

  // Series de toda la sociedad con sus colisiones (R3).
  app.get("/legal-entities/:legalEntityId/series", async (request) => {
    assertStructureEnabled();
    const legalEntityId = await grantLegalEntity(request);
    return listLegalEntitySeries(request.userContext, legalEntityId);
  });

  // Instalaciones VeriFactu (número inmutable, centro, envíos, último eslabón).
  app.get("/legal-entities/:legalEntityId/verifactu/installations", async (request) => {
    assertStructureEnabled();
    const legalEntityId = await grantLegalEntity(request);
    return listInstallations(request.userContext, legalEntityId);
  });

  // Ficha del centro: kind, código, nombre comercial y datos censales — nunca NIF ni razón social.
  app.patch("/properties/:propertyId/establishment", async (request) => {
    assertStructureEnabled();
    const { propertyId } = request.params as PropertyParams;
    await assertEntityAccess(request, { entity: "property", id: propertyId });
    const patch = parseOr400(establishmentPatchSchema, request.body ?? {}, "Centro de trabajo");
    return patchEstablishment({ context: request.userContext, propertyId, patch, correlationId: createId("corr") });
  });

  // Consola de plataforma: política de cadena por sociedad (inmutable tras la primera emisión real).
  app.post("/admin/legal-entities/:legalEntityId/verifactu-scope", async (request) => {
    assertStructureEnabled();
    const legalEntityId = await grantLegalEntity(request);
    const body = parseOr400(verifactuScopeBodySchema, request.body ?? {}, "Política de cadena");
    return setVerifactuChainScope({ context: request.userContext, legalEntityId, scope: body.scope, correlationId: createId("corr") });
  });
}
