// Importación contable desde Sage 200 · Tanda 7c · L3 · entradas de permisos de las
// rutas `/accounting/ledger-imports*` y `/accounting/ledger-imports/reconciliation*`
// (ledger-import.routes.ts).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts,
// `...ledgerImportRoutePermissions`, envueltas con `requireAccountingReportsKey`:
// toda lectura escrita aquí con `accounting.read` exige `accounting.reports.read`
// en el manifiesto en vigor, la plantilla incluida — diseño §10.4.2 nº 2 y
// security/__tests__/finance-report-keys.test.mts); el contrato
// tests/api-route-permissions-contract.test.mjs lee este fichero por su sufijo
// `*route-permissions.partial.ts` a profundidad 1 de modules/accounting/: una ruta
// nueva en ledger-import.routes.ts va con su entrada aquí, una por línea, con la
// forma { method, path, permissions, riskLevel }.
//
// Claves (diseño §7.1 y §10.4.1; sin claves nuevas, sin rbac:sync): previsualizar y
// reconciliar `accounting.journal.post` (medium: la preview nunca escribe y la
// reconciliación solo escribe su informe); crear y contabilizar un lote
// `accounting.journal.post` (high); lecturas de lotes, mapas y reconciliaciones
// `accounting.read` (medium; plantilla low) → remapeadas a `accounting.reports.read`;
// mapas de cuentas y analítico `accounting.configure` (high: `create` da de alta
// subcuentas); reverso de un lote `accounting.journal.post` + `ai.high_risk.confirm`
// (critical, espejo de POST /accounting/journal/:id/reverse). Las high / critical
// rechazan el fallback demo sin token (401).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const ledgerImportRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/accounting/ledger-imports/preview", permissions: ["accounting.journal.post"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/ledger-imports", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/accounting/ledger-imports", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/ledger-imports/template", permissions: ["accounting.read"], riskLevel: "low" },
  { method: "GET", path: "/accounting/ledger-imports/account-map", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PUT", path: "/accounting/ledger-imports/account-map", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "GET", path: "/accounting/ledger-imports/analytics-map", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PUT", path: "/accounting/ledger-imports/analytics-map", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "POST", path: "/accounting/ledger-imports/reconciliation", permissions: ["accounting.journal.post"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/ledger-imports/reconciliation", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/ledger-imports/reconciliation/:id", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/ledger-imports/reconciliation/:id/csv", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/ledger-imports/:id", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/ledger-imports/:id/post", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/accounting/ledger-imports/:id/reverse", permissions: ["accounting.journal.post", "ai.high_risk.confirm"], riskLevel: "critical" }
];
