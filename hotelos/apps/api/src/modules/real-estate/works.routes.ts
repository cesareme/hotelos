// Activo inmobiliario · rutas de obras y capitalización (Tanda ACT · L4).
//
// Registradas desde real-estate.register.ts (`registerRealEstateRoutes`, que a
// su vez llama server.ts); permisos en works-route-permissions.partial.ts:
//   GET   /properties/:propertyId/real-estate/works  real_estate.read     (guardia global de tenencia)
//   POST  /capex-projects/:id/approve                asset.capex.approve  (assertEntityAccess capexProject; ACT-REV-05)
//   PATCH /capex-projects/:id/work                   capex.create         (assertEntityAccess capexProject, como server.ts PATCH /capex-projects/:id)
//   POST  /capex-projects/:id/capitalize             assets.manage        (assertEntityAccess capexProject)
// La aprobación (proposed → approved) es del motor existente
// (modules/assets/assets.service.ts updateCapexProject: asset.capex.approve +
// separación de funciones sobre quien lo propuso, con `supervisorAuthorizationId`
// opcional); la ruta propia existe porque ninguna plantilla reúne `capex.create`
// (manifiesto de PATCH /capex-projects/:id) y `asset.capex.approve`.

import type { FastifyInstance } from "fastify";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { updateCapexProject } from "../assets/assets.service.js";
import { capitalizeCapexProject, listRealEstateWorks, updateCapexWork } from "./works.service.js";

type PropertyParams = { propertyId: string };
type IdParams = { id: string };

export function registerRealEstateWorksRoutes(app: FastifyInstance): void {
  app.get("/properties/:propertyId/real-estate/works", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listRealEstateWorks(propertyId);
  });

  app.post("/capex-projects/:id/approve", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "capexProject", id });
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as { supervisorAuthorizationId?: unknown };
    return updateCapexProject({
      context: request.userContext,
      capexProjectId: id,
      patch: { status: "approved" },
      supervisorAuthorizationId: typeof body.supervisorAuthorizationId === "string" ? body.supervisorAuthorizationId : null,
      correlationId: createId("corr")
    });
  });

  app.patch("/capex-projects/:id/work", async (request) => {
    const { id } = request.params as IdParams;
    const owner = await assertEntityAccess(request, { entity: "capexProject", id });
    return updateCapexWork({ context: request.userContext, capexProjectId: id, propertyId: owner.propertyId ?? "", body: request.body, correlationId: createId("corr") });
  });

  app.post("/capex-projects/:id/capitalize", async (request, reply) => {
    const { id } = request.params as IdParams;
    const owner = await assertEntityAccess(request, { entity: "capexProject", id });
    const result = await capitalizeCapexProject({ context: request.userContext, capexProjectId: id, propertyId: owner.propertyId ?? "", body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(result);
  });
}
