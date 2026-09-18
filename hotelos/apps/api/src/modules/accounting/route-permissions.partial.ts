// Permission manifest entries of ledger.routes.ts (Finanzas · lote ledger).
//
// Merged into `routePermissionManifest` (security/route-permissions.ts,
// `...ledgerRoutePermissions`) by the integrator; the contract test
// tests/api-route-permissions-contract.test.mjs reads THIS file and requires
// one entry per route registered in ledger.routes.ts. Same format as the
// main manifest.
//
// Keys: accounting.read for every GET (diario, mayor, plan, ajustes, estado
// de la proyección); accounting.journal.post for the writes to the diario
// (manual entry: high; reversal: critical — it also needs the high-risk
// confirmation like the legacy POST /journal-entries/:id/post);
// accounting.configure for the chart and settings; the replay is an
// administrative write to the whole diario of an organisation: critical.
//
// Tanda 8a (RBAC · L2, design §4.3 M10 «P», brief §3): the diario export
// (`GET /accounting/journal/export`) is gated by analytics.export (the export
// key of contabilidad / dirección financiera), not by the calendar read key;
// `requireAccountingReportsKey` in security/route-permissions.ts only remaps
// accounting.read, so this entry reaches the manifest as written. The handler
// audits every export (ACCOUNTING_EXPORTED: actor, range, format, open
// periods, provisional) and never blocks: the hard rule «only closed periods»
// is the integrator's decision (ThresholdAction accounting_export reserved).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const ledgerRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/accounting/journal", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/journal/export", permissions: ["analytics.export"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/journal", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/accounting/journal/:id", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/journal/:id/reverse", permissions: ["accounting.journal.post", "ai.high_risk.confirm"], riskLevel: "critical" },
  { method: "GET", path: "/accounting/ledger/:accountCode", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/accounting/chart", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/accounting/chart", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "PATCH", path: "/accounting/chart/:code", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "GET", path: "/accounting/settings", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/accounting/settings", permissions: ["accounting.configure"], riskLevel: "high" },
  { method: "POST", path: "/accounting/replay", permissions: ["accounting.journal.post", "ai.high_risk.confirm"], riskLevel: "critical" },
  { method: "GET", path: "/accounting/projection/status", permissions: ["accounting.read"], riskLevel: "medium" }
];
