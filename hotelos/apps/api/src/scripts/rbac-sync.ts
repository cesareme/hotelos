// RBAC catalog sync CLI (Tanda 1).
//
// Runs the same two steps the API executes at boot (lib/rbac-catalog.ts):
//   1. syncPermissionCatalog  → `permissions` converges to PERMISSIONS
//   2. backfillTemplateRoles  → template-named roles with 0 grants get filled
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   pnpm --filter @hotelos/api rbac:sync              # sync + backfill
//   pnpm --filter @hotelos/api rbac:sync -- --dry-run # report only, no writes
//   pnpm --filter @hotelos/api rbac:sync -- --prune   # also delete stale keys
//                                                     # (and their role_permissions)
//   pnpm --filter @hotelos/api rbac:sync -- --json    # machine-readable output
//
// Exit codes: 0 ok · 1 failure (DB unreachable, template invariant broken) ·
// 2 unknown flag.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import { ORG_PERMISSION_KEYS, PERMISSIONS, PLATFORM_PERMISSION_KEYS, ROLE_PERMISSION_MAP, ROLE_TEMPLATE_KEYS } from "@hotelos/shared";
import {
  assertTemplatesExcludePlatformKeys,
  backfillTemplateRoles,
  syncPermissionCatalog,
  type BackfillTemplateRolesResult,
  type CatalogSyncResult
} from "../lib/rbac-catalog.js";

export type RbacSyncFlags = { prune: boolean; dryRun: boolean; json: boolean };

export type RbacSyncSummary = {
  dryRun: boolean;
  prune: boolean;
  catalogKeys: number;
  orgKeys: number;
  platformKeys: number;
  templates: Record<string, number>;
  sync: CatalogSyncResult;
  backfill: BackfillTemplateRolesResult;
  durationMs: number;
};

export function parseFlags(argv: readonly string[]): RbacSyncFlags {
  const flags: RbacSyncFlags = { prune: false, dryRun: false, json: false };
  for (const arg of argv) {
    if (arg === "--prune") flags.prune = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --prune, --dry-run, --json.`);
  }
  return flags;
}

export async function runRbacSync(flags: RbacSyncFlags): Promise<RbacSyncSummary> {
  const start = Date.now();
  assertTemplatesExcludePlatformKeys();
  const sync = await syncPermissionCatalog({ prune: flags.prune, dryRun: flags.dryRun });
  const backfill = await backfillTemplateRoles({ dryRun: flags.dryRun });
  const templates: Record<string, number> = {};
  for (const key of ROLE_TEMPLATE_KEYS) templates[key] = ROLE_PERMISSION_MAP[key].length;
  return {
    dryRun: flags.dryRun,
    prune: flags.prune,
    catalogKeys: Object.keys(PERMISSIONS).length,
    orgKeys: ORG_PERMISSION_KEYS.length,
    platformKeys: PLATFORM_PERMISSION_KEYS.length,
    templates,
    sync,
    backfill,
    durationMs: Date.now() - start
  };
}

function printHuman(summary: RbacSyncSummary): void {
  const mode = summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED";
  const lines = [
    `[rbac:sync] ${mode}${summary.prune ? " + prune" : ""} · ${summary.durationMs} ms`,
    `  catalog: ${summary.catalogKeys} keys (${summary.orgKeys} org + ${summary.platformKeys} platform)`,
    `  permissions: +${summary.sync.created} created · ${summary.sync.updated} descriptions updated · ${summary.sync.stale.length} stale${
      summary.sync.pruned ? ` · ${summary.sync.pruned} pruned` : ""
    }`
  ];
  if (summary.sync.stale.length > 0) {
    lines.push(`  stale keys: ${summary.sync.stale.join(", ")}${summary.prune ? "" : " (kept; use --prune to delete)"}`);
  }
  lines.push(`  roles filled: ${summary.backfill.rolesFilled}`);
  for (const role of summary.backfill.roles) lines.push(`    ${role}`);
  if (summary.backfill.unmatched && summary.backfill.unmatched.length > 0) {
    lines.push(`  empty roles with no template match (untouched): ${summary.backfill.unmatched.join(" · ")}`);
  }
  lines.push(`  templates: ${Object.entries(summary.templates).map(([key, size]) => `${key}=${size}`).join(" ")}`);
  console.log(lines.join("\n"));
}

// CLI entrypoint: only runs when invoked directly (same guard as jobs/pii-backfill.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: RbacSyncFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[rbac:sync] ${(error as Error).message}`);
    process.exit(2);
  }
  runRbacSync(flags)
    .then((summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      return prisma.$disconnect();
    })
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error("[rbac:sync] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
