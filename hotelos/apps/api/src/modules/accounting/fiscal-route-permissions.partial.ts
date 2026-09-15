// Finanzas · lote «iva-modelos» — permission entries of the fiscal routes
// (fiscal.routes.ts).
//
// The integrator spreads `fiscalRoutePermissions` into routePermissionManifest
// (security/route-permissions.ts) and the contract test
// (tests/api-route-permissions-contract.test.mjs) reads the partial — note
// its partial discovery currently matches the exact name
// `route-permissions.partial.ts`; see the handoff of the lot report.
//
// Keys (all in packages/shared/src/permissions.ts): `accounting.read` for the
// reads (books, models, PDF, settlement preview) — the finance / manager /
// compliance templates hold it; `accounting.configure` for the VAT settings
// and the books rebuild (derived data, re-runnable); `accounting.journal.post`
// for posting / reversing the settlement entry (riskLevel critical: it writes
// the ledger, so the demo fallback without a session gets 401).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const fiscalRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/fiscal/vat-settings", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PUT", path: "/fiscal/vat-settings", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "GET", path: "/fiscal/vat-books", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/fiscal/vat-books/rebuild", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "GET", path: "/fiscal/models/:modelo", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/fiscal/models/:modelo/pdf", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/fiscal/vat-settlement", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/fiscal/vat-settlement", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "POST", path: "/fiscal/vat-settlement/reverse", permissions: ["accounting.journal.post"], riskLevel: "critical" }
];
