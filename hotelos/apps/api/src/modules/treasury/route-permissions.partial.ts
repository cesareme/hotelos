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
// payroll.manage (exportación de nóminas).
//
// Tanda 8a (RBAC · L2, design §4.7 «Nómina» / «Facturas de proveedor»):
// `POST /payroll/periods/:id/approve` (nueva) exige payroll.approve (dirección
// general aprueba el registro mensual; aprobador ≠ calculador);
// `POST /payroll/periods/:id/pay` pasa de payroll.manage a payables.pay
// (dirección financiera paga lo aprobado; pagador ≠ aprobador; sin aprobación
// → 409 PAYROLL_NOT_APPROVED); `POST /treasury/sepa/supplier-payments` pasa de
// banking.reconcile a payables.pay (ordenar la remesa de proveedores es un
// pago, no una conciliación). Corrector 8a (FSOD-01): sepa-remittance.service
// admite payables.pay (REMITTANCE_WRITE_KEYS de permissions.ts) en
// buildSupplierPaymentRemittance / createRemittance / updateRemittanceStatus,
// así que la ruta es usable por dirección financiera (controller).
//
// Corrector CIERRE-1 (REV-02 / FUN-02): `POST /treasury/sepa/remittances` sigue
// bajo banking.reconcile porque persiste adeudos Norma 19 (cobros); un cuerpo
// `kind: "norma34"` sin procedencia de buildSupplierPaymentRemittance lo rechaza
// el servicio con 403 SUPPLIER_PAYMENT_ROUTE_REQUIRED (la puerta SoD por factura
// de supplier-payments no se sortea reenviando el cuerpo construido).

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
  { method: "POST", path: "/treasury/sepa/supplier-payments", permissions: ["payables.pay"], riskLevel: "high" },
  { method: "GET", path: "/commissions/accruals/:id", permissions: ["commissions.read"], riskLevel: "medium" },
  { method: "POST", path: "/commissions/accrue", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/commissions/accruals/:id/settle", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/commissions/accruals/:id/reverse", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/payroll/periods/:id", permissions: ["payroll.read"], riskLevel: "medium" },
  { method: "POST", path: "/payroll/periods/:id/export", permissions: ["payroll.manage"], riskLevel: "high" },
  { method: "POST", path: "/payroll/periods/:id/approve", permissions: ["payroll.approve"], riskLevel: "high" },
  { method: "POST", path: "/payroll/periods/:id/pay", permissions: ["payables.pay"], riskLevel: "critical" }
];
