// Activo inmobiliario · rutas de inspecciones obligatorias, pólizas y alertas
// (Tanda ACT · L5) bajo /properties/:propertyId/real-estate/*.
//
// Registradas desde real-estate.register.ts (`registerRealEstateRoutes`, que
// llama server.ts); permisos en inspections-route-permissions.partial.ts
// (real_estate.read para GET, real_estate.manage para escrituras). La guardia
// global de tenencia de server.ts (pickPropertyId → grantPropertyAccess) cubre
// el :propertyId; los servicios buscan cada fila a través del activo del
// centro y responden 404 opaco. Patrón: core.routes.ts (L1).

import type { FastifyInstance } from "fastify";
import { createId } from "../../lib/ids.js";
import { getRealEstateAlerts } from "./alerts.service.js";
import { createRealEstateInspection, listRealEstateInspections, updateRealEstateInspection } from "./inspections.service.js";
import { createRealEstateInsurance, listRealEstateInsurances, updateRealEstateInsurance } from "./insurances.service.js";

type PropertyParams = { propertyId: string };
type InspectionParams = PropertyParams & { inspectionId: string };
type InsuranceParams = PropertyParams & { insuranceId: string };

export function registerRealEstateInspectionRoutes(app: FastifyInstance): void {
  // ── Inspecciones obligatorias ─────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/inspections", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listRealEstateInspections(propertyId, request.query ?? {});
  });

  app.post("/properties/:propertyId/real-estate/inspections", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const inspection = await createRealEstateInspection({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(inspection);
  });

  app.patch("/properties/:propertyId/real-estate/inspections/:inspectionId", async (request) => {
    const params = request.params as InspectionParams;
    return updateRealEstateInspection({ context: request.userContext, propertyId: params.propertyId, inspectionId: params.inspectionId, body: request.body, correlationId: createId("corr") });
  });

  // ── Pólizas ───────────────────────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/insurances", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listRealEstateInsurances(propertyId);
  });

  app.post("/properties/:propertyId/real-estate/insurances", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const insurance = await createRealEstateInsurance({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(insurance);
  });

  app.patch("/properties/:propertyId/real-estate/insurances/:insuranceId", async (request) => {
    const params = request.params as InsuranceParams;
    return updateRealEstateInsurance({ context: request.userContext, propertyId: params.propertyId, insuranceId: params.insuranceId, body: request.body, correlationId: createId("corr") });
  });

  // ── Alertas (calculadas en cada lectura) ──────────────────────────────────
  app.get("/properties/:propertyId/real-estate/alerts", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return getRealEstateAlerts(propertyId);
  });
}
