// Activo inmobiliario · agregador de rutas (Tanda ACT · L1). Se llama `.register.ts` y no
// `.routes.ts` porque el contract test exige que todo `*.routes.ts` registre rutas propias.
//
// server.ts llama UNA vez a `registerRealEstateRoutes(app)`; aquí se registran,
// en este orden, las rutas de cada lote de la ola 3 para que ninguno tenga que
// tocar server.ts ni el manifiesto: core (L1), tributos (L2, taxes.routes.ts),
// documentos (L3, documents.routes.ts), obras (L4, works.routes.ts),
// inspecciones y pólizas (L5, inspections.routes.ts) y vista de grupo
// (L6, group.routes.ts). Cada lote crea su `<lote>.routes.ts` con al menos una
// ruta (el contract test tests/api-route-permissions-contract.test.mjs exige que
// todo `*.routes.ts` registre rutas, por eso no hay stubs vacíos) y añade aquí su
// import + llamada. Los permisos siguen la misma composición en
// route-permissions.partial.ts (los partials sí pueden tener 0 entradas).

import type { FastifyInstance } from "fastify";
import { registerRealEstateCoreRoutes } from "./core.routes.js";
import { registerRealEstateWorksRoutes } from "./works.routes.js";
import { registerRealEstateTaxRoutes } from "./taxes.routes.js";
import { registerRealEstateDocumentRoutes } from "./documents.routes.js";
import { registerRealEstateInspectionRoutes } from "./inspections.routes.js";
import { registerRealEstateGroupRoutes } from "./group.routes.js";

export function registerRealEstateRoutes(app: FastifyInstance): void {
  registerRealEstateCoreRoutes(app);
  registerRealEstateWorksRoutes(app);
  registerRealEstateTaxRoutes(app);
  registerRealEstateDocumentRoutes(app);
  registerRealEstateInspectionRoutes(app);
  registerRealEstateGroupRoutes(app);
}
