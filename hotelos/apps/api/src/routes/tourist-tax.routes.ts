// Tourist tax bounded context — tercer plugin Fastify (P1-16).

import type { FastifyPluginAsync } from "fastify";
import { BadRequestError } from "../lib/http-error.js";
import { requireDateRange } from "../lib/query-dates.js";
import { assertEntityAccess } from "../lib/tenancy.js";
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
    if (typeof body.reservationId !== "string" || body.reservationId.length === 0) {
      throw new BadRequestError("reservationId es obligatorio.");
    }
    // The charge lands on the reservation's folio: same tenant rule as /reservations/:id.
    await assertEntityAccess(request, { entity: "reservation", id: body.reservationId });
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
    const q = (request.query ?? {}) as { fromDate?: string; toDate?: string };
    // Missing/invalid dates used to reach Prisma as `Invalid Date` → 500. A
    // same-day period is valid here (stayFrom between the two, inclusive).
    const { fromDate, toDate } = requireDateRange(q.fromDate, q.toDate, { strict: false });
    return listApplicationsForPeriod({
      context: request.userContext,
      propertyId: params.propertyId,
      fromDate,
      toDate
    });
  });
};
