// Permission manifest entries of channel-manager.routes.ts (rate grid v2).
//
// Merged into `routePermissionManifest` (security/route-permissions.ts,
// `...CHANNEL_MANAGER_ROUTE_PERMISSIONS`). The contract test
// tests/api-route-permissions-contract.test.mjs reads THIS file and requires
// one entry per route registered in channel-manager.routes.ts (a public route
// needs an entry too: `assertRoutePermission` answers 403 to any non-GET
// without one, in every environment — that is how the sandbox loopback lost
// its way for a day). Same format as the main manifest.
//
// Risk levels follow the manifest convention: reads medium, channel/mapping
// writes high, anything that sends ARI to a provider critical (the demo
// fallback without a real session cannot reach high/critical routes).
// Public (riskLevel "public", no permissions) routes must ALSO be listed in
// PUBLIC_PREFIXES (lib/auth-context.ts) so the auth hook lets them through.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const CHANNEL_MANAGER_ROUTE_PERMISSIONS: ApiRoutePermission[] = [
  // Editor (rate grid) — property scoped
  { method: "GET", path: "/properties/:propertyId/channels", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/channels/sync-status", permissions: ["channel_manager.read"], riskLevel: "medium" },
  // Channel lifecycle
  { method: "POST", path: "/channel-manager/channels", permissions: ["channel_manager.manage"], riskLevel: "high" },
  { method: "GET", path: "/channel-manager/channels/:channelId", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/channel-manager/channels/:channelId", permissions: ["channel_manager.manage"], riskLevel: "high" },
  { method: "DELETE", path: "/channel-manager/channels/:channelId", permissions: ["channel_manager.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/channel-manager/channels/:channelId/credentials", permissions: ["channel_manager.manage"], riskLevel: "critical" },
  { method: "POST", path: "/channel-manager/channels/:channelId/test", permissions: ["channel_manager.sync"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/channels/:channelId/pull-reservations", permissions: ["channel_manager.sync"], riskLevel: "high" },
  // Product mappings
  { method: "GET", path: "/channel-manager/channels/:channelId/product-mappings", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/channels/:channelId/product-mappings", permissions: ["channel_manager.mappings.manage"], riskLevel: "high" },
  { method: "DELETE", path: "/channel-manager/product-mappings/:id", permissions: ["channel_manager.mappings.manage"], riskLevel: "high" },
  { method: "POST", path: "/channel-manager/channels/:channelId/product-mappings/migrate-legacy", permissions: ["channel_manager.mappings.manage"], riskLevel: "high" },
  { method: "GET", path: "/channel-manager/channels/:channelId/product-coverage", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "GET", path: "/channel-manager/channels/:channelId/readiness-v2", permissions: ["channel_manager.read"], riskLevel: "medium" },
  // Outbox
  { method: "POST", path: "/channel-manager/deliveries/enqueue", permissions: ["channel_manager.sync"], riskLevel: "critical" },
  { method: "GET", path: "/channel-manager/deliveries", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "GET", path: "/channel-manager/deliveries/:id", permissions: ["channel_manager.read"], riskLevel: "medium" },
  { method: "POST", path: "/channel-manager/deliveries/:id/retry", permissions: ["channel_manager.sync"], riskLevel: "high" },
  { method: "POST", path: "/channel-manager/deliveries/drain", permissions: ["distribution.sync"], riskLevel: "critical" },
  // Public: provider webhook (secret-verified before any body parser, only triggers a pull)
  { method: "POST", path: "/channel-manager/webhooks/:provider/:channelId", permissions: [], riskLevel: "public" },
  // Public: loopback into the in-process simulator (validates an OTA XML / EQC XML / Channex JSON body, never touches data)
  { method: "POST", path: "/channel-manager/_sandbox/:provider", permissions: [], riskLevel: "public" }
];
