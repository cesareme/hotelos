// Coste de personal importado · Tanda 6c · L3 · entradas de permisos de las
// rutas /payroll/cost-imports* y /payroll/cost-report (cost-import.routes.ts).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts,
// `...payrollRoutePermissions`); los contratos (tests/api-route-permissions-
// contract.test.mjs y tests/rbac-nav-contract.test.mjs) leen este fichero: una
// ruta nueva en cost-import.routes.ts va con su entrada aquí, una por línea.
//
// Claves (diseño docs/design/FINANZAS-COSTE-PERSONAL.md §5): lectura con
// payroll.read (lotes, detalle e informe; la tienen dirección, contabilidad y
// propietario — nunca accounting.read ni analytics.read: invariantes
// finance-report-keys / route-read-keys) y escritura con payroll.manage. El
// manifiesto exige TODAS las claves de la entrada; el servicio
// (treasury/permissions.ts requireAnyPermission) acepta payroll.manage «o
// accounting.journal.post» (PAYROLL_WRITE_KEYS). Por eso la ruta pide solo
// payroll.manage: con ["payroll.manage", "accounting.journal.post"] la plantilla
// de Dirección (payroll.manage sin accounting.journal.post) recibiría 403 en la
// pestaña «Coste de personal». Riesgo: preview y lecturas medium; crear y
// contabilizar high; reverso critical (espejo de POST /payroll/periods/:id/pay);
// high / critical rechazan el contexto demo sin token.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const payrollRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/payroll/cost-imports/preview", permissions: ["payroll.manage"], riskLevel: "medium" },
  { method: "POST", path: "/payroll/cost-imports", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "GET", path: "/payroll/cost-imports", permissions: ["payroll.read"], riskLevel: "medium" },
  { method: "GET", path: "/payroll/cost-imports/:id", permissions: ["payroll.read"], riskLevel: "medium" },
  { method: "POST", path: "/payroll/cost-imports/:id/post", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "POST", path: "/payroll/cost-imports/:id/reverse", permissions: ["payroll.manage"], riskLevel: "critical" },
  { method: "GET", path: "/payroll/cost-report", permissions: ["payroll.read"], riskLevel: "medium" }
];
