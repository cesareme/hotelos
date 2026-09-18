// RBAC por departamento (Tanda 8a · L1) · permission entries of the rbac routes.
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts:
// `...rbacRoutePermissions,`); el contract test (tests/api-route-permissions-
// contract.test.mjs) lee este fichero y tests/rbac-engine-contract.test.mjs pina
// la tabla exacta. Una ruta nueva en rbac.routes.ts va con su entrada aquí.
//
// Claves (design §6.3): lectura de asignaciones y usuarios con users.read;
// asignar / retirar con users.assign (el servicio además exige ámbito ⊆ propio y
// nivel ≤ propio); roles con roles.manage y permissions.manage; grupos con
// organization.structure.manage; umbrales con accounting.read (lectura) y
// accounting.configure + ai.high_risk.confirm (escritura, critical). Las rutas
// con `permissions: []` NO son públicas: exigen sesión y su clave DINÁMICA se
// comprueba en el servicio — la clave *_approve del `kind` (aprobaciones), la
// clave solicitada del autorizador (PIN de supervisor) y la contraseña del propio
// usuario (PIN); por eso son high / critical y el fallback demo sin token las
// recibe con 401. Break glass con security.break_glass (critical); informes y
// registro de accesos con audit.read.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const rbacRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/rbac/assignments", permissions: ["users.read"], riskLevel: "medium" },
  { method: "POST", path: "/rbac/assignments", permissions: ["users.assign"], riskLevel: "high" },
  { method: "DELETE", path: "/rbac/assignments/:id", permissions: ["users.assign"], riskLevel: "high" },
  { method: "GET", path: "/rbac/users", permissions: ["users.read"], riskLevel: "medium" },
  { method: "GET", path: "/rbac/roles", permissions: ["roles.manage"], riskLevel: "medium" },
  { method: "POST", path: "/rbac/roles", permissions: ["roles.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/rbac/roles/:id/permissions", permissions: ["permissions.manage"], riskLevel: "high" },
  { method: "GET", path: "/rbac/property-groups", permissions: ["organization.structure.manage"], riskLevel: "medium" },
  { method: "POST", path: "/rbac/property-groups", permissions: ["organization.structure.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/rbac/property-groups/:id", permissions: ["organization.structure.manage"], riskLevel: "high" },
  { method: "GET", path: "/rbac/thresholds", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PUT", path: "/rbac/thresholds", permissions: ["accounting.configure", "ai.high_risk.confirm"], riskLevel: "critical" },
  { method: "GET", path: "/approvals", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/approvals", permissions: [], riskLevel: "high" },
  { method: "POST", path: "/approvals/:id/approve", permissions: [], riskLevel: "critical" },
  { method: "POST", path: "/approvals/:id/reject", permissions: [], riskLevel: "critical" },
  { method: "POST", path: "/rbac/supervisor-authorizations", permissions: [], riskLevel: "high" },
  { method: "POST", path: "/rbac/pin", permissions: [], riskLevel: "high" },
  { method: "POST", path: "/rbac/break-glass", permissions: ["security.break_glass"], riskLevel: "critical" },
  { method: "POST", path: "/rbac/break-glass/:id/close", permissions: ["security.break_glass"], riskLevel: "critical" },
  { method: "POST", path: "/rbac/break-glass/:id/review", permissions: ["audit.read"], riskLevel: "high" },
  { method: "GET", path: "/rbac/break-glass", permissions: ["audit.read"], riskLevel: "medium" },
  { method: "GET", path: "/rbac/report", permissions: ["audit.read"], riskLevel: "medium" },
  { method: "GET", path: "/rbac/access-log", permissions: ["audit.read"], riskLevel: "medium" }
];
