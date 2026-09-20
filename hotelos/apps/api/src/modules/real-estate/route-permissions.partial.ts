// Activo inmobiliario · agregador de permisos (Tanda ACT · L1).
//
// Solo spreads: cada lote declara sus entradas en su propio
// `<lote>-route-permissions.partial.ts` (el contract test
// tests/api-route-permissions-contract.test.mjs lee todos los ficheros
// `*route-permissions.partial.ts`, incluidos los que aún tienen 0 entradas).
// security/route-permissions.ts hace `...realEstateRoutePermissions` una sola vez.

import type { ApiRoutePermission } from "../../security/route-permissions.js";
import { realEstateCoreRoutePermissions } from "./core-route-permissions.partial.js";
import { realEstateTaxRoutePermissions } from "./taxes-route-permissions.partial.js";
import { realEstateDocumentRoutePermissions } from "./documents-route-permissions.partial.js";
import { realEstateWorksRoutePermissions } from "./works-route-permissions.partial.js";
import { realEstateInspectionRoutePermissions } from "./inspections-route-permissions.partial.js";
import { realEstateGroupRoutePermissions } from "./group-route-permissions.partial.js";

export const realEstateRoutePermissions: ApiRoutePermission[] = [
  ...realEstateCoreRoutePermissions,
  ...realEstateTaxRoutePermissions,
  ...realEstateDocumentRoutePermissions,
  ...realEstateWorksRoutePermissions,
  ...realEstateInspectionRoutePermissions,
  ...realEstateGroupRoutePermissions
];
