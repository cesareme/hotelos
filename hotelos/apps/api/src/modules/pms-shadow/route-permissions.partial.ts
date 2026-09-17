// OPERA Cloud · modo sombra · Tanda 7b · L3 · entradas de permisos de las rutas
// `POST /integrations/pms-shadow/ingest` (pública, clave de API de DeveloperApp
// verificada en el handler) y `/properties/:propertyId/pms-shadow/*`
// (pms-shadow.routes.ts).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts,
// `...pmsShadowRoutePermissions`); los contratos (tests/api-route-permissions-
// contract.test.mjs y tests/rbac-nav-contract.test.mjs) leen este fichero por su
// nombre exacto: una ruta nueva en pms-shadow.routes.ts va con su entrada aquí,
// una por línea, con la forma { method, path, permissions, riskLevel }.
//
// Claves (diseño §10 nº 17: sin claves nuevas, sin rbac:sync): lecturas del panel,
// perfil, cortes y alertas `integrations.read` (low); escrituras `integrations.connect`
// (high: crear / editar el perfil, subir un corte a mano, resolver una alerta);
// reconciliación y lotes de ingresos `accounting.read` (low); previsualizar
// `accounting.journal.post` (medium: nunca escribe), contabilizar `accounting.journal.post`
// (high), revertir `accounting.journal.post` (critical: reverso de un asiento). La
// pública es la única con riskLevel public (contrato a′: ruta bajo PUBLIC_PREFIXES ⇔
// public). Las high / critical rechazan el fallback demo sin token (401).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const pmsShadowRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/integrations/pms-shadow/ingest", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/overview", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/profile", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "PUT", path: "/properties/:propertyId/pms-shadow/profile", permissions: ["integrations.connect"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/runs", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pms-shadow/runs", permissions: ["integrations.connect"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/runs/:id", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/alerts", permissions: ["integrations.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pms-shadow/alerts/:id/resolve", permissions: ["integrations.connect"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/reconciliation", permissions: ["accounting.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pms-shadow/revenue/preview", permissions: ["accounting.journal.post"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/pms-shadow/revenue", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/revenue", permissions: ["accounting.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/pms-shadow/revenue/:id", permissions: ["accounting.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pms-shadow/revenue/:id/reverse", permissions: ["accounting.journal.post"], riskLevel: "critical" }
];
