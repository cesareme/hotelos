// Lote tesoreria-banca · permission entries of the treasury routes.
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts,
// handoff al integrador: `...treasuryRoutePermissions`); el contract test
// (tests/api-route-permissions-contract.test.mjs) lee este fichero: una ruta
// nueva en treasury.routes.ts va con su entrada aquí.
//
// Claves: lectura banking.read / commissions.read / payroll.read (las claves de
// lectura que ya tienen las plantillas de finanzas y dirección); escritura
// banking.reconcile (banca, remesas), accounting.journal.post (comisiones) y
// payroll.manage (nóminas). Los servicios aceptan además la clave hermana
// (accounting.journal.post ↔ banking.reconcile / payroll.manage), ver
// treasury/permissions.ts; el handoff pide añadir banking.reconcile y
// payroll.manage a la plantilla accountant para que contable y dirección
// superen también la puerta de ruta.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const treasuryRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/treasury/position", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "GET", path: "/treasury/receivables", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "GET", path: "/treasury/payables", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "GET", path: "/treasury/forecast", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "POST", path: "/treasury/bank-accounts/:id/statements/import", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "GET", path: "/treasury/bank-lines/:bankLineId/suggestions", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "POST", path: "/treasury/bank-lines/:bankLineId/reconcile", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "DELETE", path: "/treasury/bank-lines/:bankLineId/reconcile", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "POST", path: "/treasury/statements/:id/auto-reconcile", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "POST", path: "/treasury/sepa/remittances", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "GET", path: "/treasury/sepa/remittances", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "GET", path: "/treasury/sepa/remittances/:id", permissions: ["banking.read"], riskLevel: "medium" },
  { method: "POST", path: "/treasury/sepa/remittances/:id/status", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "POST", path: "/treasury/sepa/supplier-payments", permissions: ["banking.reconcile"], riskLevel: "high" },
  { method: "GET", path: "/commissions/accruals/:id", permissions: ["commissions.read"], riskLevel: "medium" },
  { method: "POST", path: "/commissions/accrue", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/commissions/accruals/:id/settle", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/commissions/accruals/:id/reverse", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/payroll/periods/:id", permissions: ["payroll.read"], riskLevel: "medium" },
  { method: "POST", path: "/payroll/periods/:id/export", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "POST", path: "/payroll/periods/:id/pay", permissions: ["payroll.manage"], riskLevel: "critical" }
];
