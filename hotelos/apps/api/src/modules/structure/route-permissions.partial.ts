// Estructura societaria · L2 · permission entries of the structure routes.
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts,
// handoff al integrador: `...structureRoutePermissions`); el contract test
// (tests/api-route-permissions-contract.test.mjs) lee este fichero: una ruta
// nueva en structure.routes.ts va con su entrada aquí.
//
// Claves (design §5.2 R11 · §5.4): lectura de la estructura con accounting.read
// (owner, dirección, finanzas y recepción la tienen; el servicio admite además
// organization.structure.manage) — fix t6b#9: sin accounting.entity.read ∨
// organization.structure.manage el servicio la REDACTA a los centros asignados
// (sin series, instalaciones, IVA ni datos fiscales de la sociedad; `scope:
// "assigned_properties"`), y GET /legal-entities/:id (DTO completo con NIF y
// domicilios) exige accounting.entity.read; escritura de sociedad y centros con
// organization.structure.manage (riesgo high: rechaza el contexto demo sin
// token), series con billing.configure, instalaciones con accounting.configure,
// y la política de cadena VeriFactu SOLO con la clave de plataforma
// admin.tenants.manage (riesgo critical). En el servicio (no en la ruta: el
// resto del PATCH no es de alto riesgo) los campos que recalifican el NIF entero
// — NIF, razón social, SII, gran empresa, variante PGC, inicio de ejercicio —
// exigen además ai.high_risk.confirm + confirmHighRisk, y los de régimen
// («IVA y ejercicio») accounting.configure.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const structureRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/organizations/me/structure", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/legal-entities", permissions: ["organization.structure.manage"], riskLevel: "high" },
  { method: "GET", path: "/legal-entities/:legalEntityId", permissions: ["accounting.entity.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/legal-entities/:legalEntityId", permissions: ["organization.structure.manage"], riskLevel: "high" },
  { method: "POST", path: "/legal-entities/:legalEntityId/properties", permissions: ["organization.structure.manage"], riskLevel: "high" },
  { method: "GET", path: "/legal-entities/:legalEntityId/series", permissions: ["billing.configure"], riskLevel: "medium" },
  { method: "GET", path: "/legal-entities/:legalEntityId/verifactu/installations", permissions: ["accounting.configure"], riskLevel: "medium" },
  { method: "PATCH", path: "/properties/:propertyId/establishment", permissions: ["organization.structure.manage"], riskLevel: "high" },
  { method: "POST", path: "/admin/legal-entities/:legalEntityId/verifactu-scope", permissions: ["admin.tenants.manage"], riskLevel: "critical" }
];
