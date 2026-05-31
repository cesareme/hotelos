// Tourist tax bounded context — tercer plugin Fastify (P1-16).

import type { FastifyPluginAsync } from "fastify";
import {
  computeTouristTax,
  applyTouristTaxToFolio,
  listApplicationsForPeriod,
  listRates,
  createRate
} from "../modules/tourist-tax/tourist-tax.service.js";
import { seedTouristTaxRates } from "../modules/tourist-tax/tourist-tax.seed.js";

export const touristTaxRoutes: FastifyPluginAsync = async (app) => {
  app.get("/tourist-tax/rates", async (request) => {
    const q = (request.query ?? {}) as { ccaaCode?: string };
    return { items: await listRates({ context: request.userContext, ccaaCode: q.ccaaCode }) };
  });

  app.post("/tourist-tax/rates", async (request) => {
    return createRate({ context: request.userContext, payload: request.body as never });
  });

  app.post("/tourist-tax/seed", async () => seedTouristTaxRates());

  app.post("/tourist-tax/compute", async (request) => computeTouristTax(request.body as never));

  app.post("/tourist-tax/apply", async (request) => {
    const body = (request.body ?? {}) as {
      reservationId: string;
      ccaaCode?: string;
      municipality?: string | null;
      establishmentClass?: string;
    };
    return applyTouristTaxToFolio({
      context: request.userContext,
      reservationId: body.reservationId,
      ccaaCode: body.ccaaCode,
      municipality: body.municipality,
      establishmentClass: body.establishmentClass
    });
  });

  app.get("/properties/:propertyId/tourist-tax/applications", async (request) => {
    const params = request.params as { propertyId: string };
    const q = (request.query ?? {}) as { fromDate: string; toDate: string };
    return listApplicationsForPeriod({
      context: request.userContext,
      propertyId: params.propertyId,
      fromDate: q.fromDate,
      toDate: q.toDate
    });
  });
};
