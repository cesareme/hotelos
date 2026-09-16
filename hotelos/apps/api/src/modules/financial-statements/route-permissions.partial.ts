// Permission manifest entries of financial-statements.routes.ts (Finanzas ·
// lote usali-cuentas). Merged into routePermissionManifest
// (security/route-permissions.ts, `...FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS`)
// by the INTEGRADOR; the contract test tests/api-route-permissions-contract
// reads THIS file and requires one entry per registered route.
//
// Keys: reads → accounting.read (fiscal statements are accounting's domain,
// like /accounting/fiscal-years); USALI mapping edits and snapshots →
// accounting.configure; gestoría exports → analytics.export (they leave the
// system). Risk: reads medium, writes high.
//
// Tanda 6b · L5 (estructura societaria): PyG por centro and the informative
// allocation key (GET read · PUT accounting.configure). The whole-sociedad
// scope of every read with amounts is enforced at runtime by
// `assertFinanceReadScope` (lib/finance-scope.ts): without
// `accounting.entity.read` a centre-scoped user needs an assigned `propertyId`.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS: ApiRoutePermission[] = [
  // PyG por centro de trabajo y reparto informativo de la oficina central (Tanda 6b)
  { method: "GET", path: "/accounting/pnl/by-property", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/allocation", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PUT", path: "/accounting/allocation", permissions: ["accounting.configure"], riskLevel: "high" },
  // USALI mapping editor
  { method: "GET", path: "/accounting/usali/mappings", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/accounting/usali/mappings", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "DELETE", path: "/accounting/usali/mappings/:mappingId", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "GET", path: "/accounting/usali/coverage", permissions: ["accounting.read"], riskLevel: "medium" },
  // USALI statement and comparisons
  { method: "GET", path: "/accounting/usali/pnl", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/usali/compare", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/usali/periods", permissions: ["accounting.read"], riskLevel: "medium" },
  // Cuentas anuales PGC Pymes
  { method: "GET", path: "/accounting/annual-accounts", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/annual-accounts/balance", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/annual-accounts/pyg", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/annual-accounts/ecpn", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/annual-accounts/memoria", permissions: ["accounting.read"], riskLevel: "medium" },
  // Snapshots
  { method: "GET", path: "/accounting/annual-accounts/snapshots", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/annual-accounts/snapshots", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "GET", path: "/accounting/annual-accounts/snapshots/:snapshotId", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/annual-accounts/snapshots/:snapshotId/download", permissions: ["accounting.read"], riskLevel: "medium" },
  // Exportación a gestoría
  { method: "GET", path: "/accounting/gestoria-exports/formats", permissions: ["analytics.export"], riskLevel: "low" },
  { method: "GET", path: "/accounting/gestoria-exports", permissions: ["analytics.export"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/gestoria-exports", permissions: ["analytics.export"], riskLevel: "high" },
  { method: "GET", path: "/accounting/gestoria-exports/:exportId", permissions: ["analytics.export"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/gestoria-exports/:exportId/download", permissions: ["analytics.export"], riskLevel: "medium" }
];
