// RBAC catalog sync CLI (Tanda 1, extended in Tanda 4).
//
// Runs the same two steps the API executes at boot (lib/rbac-catalog.ts):
//   1. syncPermissionCatalog  → `permissions` converges to PERMISSIONS
//   2. backfillTemplateRoles  → roles with Role.templateKey are topped up to
//                               their template (additive, +0 once converged);
//                               roles without templateKey whose name matches a
//                               template and that hold nothing outside it are
//                               adopted (template_key stamped); platform roles
//                               get the full catalog; custom roles are never
//                               touched; EMPTY roles with no template are
//                               listed (a user assigned to one is 403 everywhere).
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   pnpm --filter @hotelos/api rbac:sync              # sync + backfill
//   pnpm --filter @hotelos/api rbac:sync -- --dry-run # report only, no writes
//   pnpm --filter @hotelos/api rbac:sync -- --prune   # also delete stale keys
//                                                     # (and their role_permissions)
//   pnpm --filter @hotelos/api rbac:sync -- --json    # machine-readable output
//
// --prune is DESTRUCTIVE (it deletes the stale permission rows AND every
// role_permissions row pointing at them) and is never part of deploy.sh. The
// mandatory order — remove the keys from the seed → --dry-run → DB backup →
// --prune → verify the catalog count — lives in docs/runbooks/rbac-sync.md.
// Until the seed stops recreating the stale keys, a re-seed undoes the prune.
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

/** Human-readable report (exported for tests; `--json` prints the summary instead). */
export function formatHuman(summary: RbacSyncSummary): string {
  const mode = summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED";
  const { sync, backfill } = summary;
  const staleGrants = sync.staleGrants ?? 0;
  const staleGrantRoles = sync.staleGrantRoles ?? 0;
  const lines = [
    `[rbac:sync] ${mode}${summary.prune ? " + prune" : ""} · ${summary.durationMs} ms`,
    `  catalog: ${summary.catalogKeys} keys (${summary.orgKeys} org + ${summary.platformKeys} platform)`,
    `  permissions: +${sync.created} created · ${sync.updated} descriptions updated · ${sync.stale.length} stale`
  ];
  if (sync.stale.length > 0) {
    lines.push(`  stale keys (${sync.stale.length}): ${sync.stale.join(", ")}`);
    lines.push(`    grants on stale keys: ${staleGrants} role_permissions row(s) on ${staleGrantRoles} role(s)`);
    if (summary.prune) {
      lines.push(
        summary.dryRun
          ? `    --prune WOULD delete ${sync.pruned ?? 0} key(s) and ${sync.prunedGrants ?? 0} role_permissions row(s) on ${staleGrantRoles} role(s)`
          : `    pruned: ${sync.pruned ?? 0} key(s) · ${sync.prunedGrants ?? 0} role_permissions row(s) on ${staleGrantRoles} role(s) deleted`
      );
    } else {
      lines.push(
        `    kept — \`--prune\` deletes the keys AND those grants (backup first; procedure: docs/runbooks/rbac-sync.md)`
      );
    }
  }
  lines.push(
    `  template roles: ${backfill.templateRoles ?? 0} following a template · ${backfill.templateRolesToppedUp ?? 0} topped up · ` +
      `${backfill.templateKeysAssigned ?? 0} template_key stamped by name · ${(backfill.customRoles ?? []).length} custom (untouched) · ` +
      `${(backfill.unmatched ?? []).length} EMPTY without template`
  );
  for (const role of backfill.templateKeysAssignedRoles ?? []) lines.push(`    stamped: ${role}`);
  for (const role of backfill.roles) lines.push(`    topped up: ${role}`);
  for (const role of backfill.customRoles ?? []) lines.push(`    custom: ${role}`);
  if (backfill.unmatched && backfill.unmatched.length > 0) {
    lines.push(`    EMPTY without template (assign a template before inviting; 0 permissions): ${backfill.unmatched.join(" · ")}`);
  }
  const platformRoles = backfill.platformRoles ?? [];
  lines.push(`  platform roles: ${platformRoles.length} (${backfill.platformRolesToppedUp ?? 0} topped up)`);
  for (const role of platformRoles) lines.push(`    ${role}`);
  lines.push(`  templates: ${Object.entries(summary.templates).map(([key, size]) => `${key}=${size}`).join(" ")}`);
  return lines.join("\n");
}

function printHuman(summary: RbacSyncSummary): void {
  console.log(formatHuman(summary));
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
      await prisma.$disconnect().catch((disconnectError: unknown) => {
        console.error("[rbac:sync] disconnect after failure also failed:", disconnectError);
      });
      process.exit(1);
    });
}
