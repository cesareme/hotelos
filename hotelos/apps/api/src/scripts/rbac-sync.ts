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
//   pnpm --filter @hotelos/api rbac:sync -- --upgrade-templates
//                                                     # Tanda 8a (L3): converge every
//                                                     # managed template role to
//                                                     # ROLE_TEMPLATE_VERSION, applying
//                                                     # ROLE_TEMPLATE_REVOCATIONS (the
//                                                     # ONLY operation that revokes keys
//                                                     # of a role); combine with
//                                                     # --dry-run to list, per role, the
//                                                     # keys it would lose.
//
// Without --upgrade-templates the behaviour is the boot one: additive top-up
// only; the report still lists, per managed role behind the version, the keys
// an upgrade would revoke (`revocationsByRole`) and their total.
//
// --prune is DESTRUCTIVE (it deletes the stale permission rows AND every
// role_permissions row pointing at them) and is never part of deploy.sh. The
// mandatory order — remove the keys from the seed → --dry-run → DB backup →
// --prune → verify the catalog count — lives in docs/runbooks/rbac-sync.md.
// Until the seed stops recreating the stale keys, a re-seed undoes the prune.
// Tanda 8a: `capex.approve` is NOT pruned (packages/product/src/modules/
// module-manifest.ts still references it; rule: never prune a live reference).
//
// Exit codes: 0 ok · 1 failure (DB unreachable, template invariant broken) ·
// 2 unknown flag.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import { defaultAuditChainCli, withAuditChain, type AuditChainCli } from "../lib/audit-chain-cli.js";
import { ORG_PERMISSION_KEYS, PERMISSIONS, PLATFORM_PERMISSION_KEYS, ROLE_PERMISSION_MAP, ROLE_TEMPLATE_KEYS, ROLE_TEMPLATE_VERSION, type PermissionKey } from "@hotelos/shared";
import {
  assertTemplatesExcludePlatformKeys,
  backfillTemplateRoles,
  syncPermissionCatalog,
  type BackfillTemplateRolesResult,
  type CatalogSyncResult,
  type RbacDb
} from "../lib/rbac-catalog.js";

/** `upgradeTemplates` is only present when `--upgrade-templates` was given (the pre-Tanda-8a shape is pinned by lib/__tests__/rbac-catalog.test.mts). */
export type RbacSyncFlags = { prune: boolean; dryRun: boolean; json: boolean; upgradeTemplates?: boolean };

/** One managed template role behind ROLE_TEMPLATE_VERSION that still holds keys the version revokes (Tanda 8a). */
export type RevocationReport = {
  roleId: string;
  roleName: string;
  organizationId: string;
  templateKey: string | null;
  keys: PermissionKey[];
};

export type RbacSyncSummary = {
  dryRun: boolean;
  prune: boolean;
  /** Tanda 8a: true when the run applied (or, in dry-run, planned) the version upgrade with revocations. */
  upgradeTemplates?: boolean;
  templateVersion?: number;
  catalogKeys: number;
  orgKeys: number;
  platformKeys: number;
  templates: Record<string, number>;
  sync: CatalogSyncResult;
  backfill: BackfillTemplateRolesResult;
  /** Tanda 8a: `backfill.revocationsByRole` resolved to role names, sorted by organisation and name. */
  revocations?: RevocationReport[];
  /** Sum of the keys over `revocations`. */
  revokedKeysTotal?: number;
  durationMs: number;
};

export const KNOWN_FLAGS = ["--prune", "--dry-run", "--json", "--upgrade-templates"] as const;

export function parseFlags(argv: readonly string[]): RbacSyncFlags {
  const flags: RbacSyncFlags = { prune: false, dryRun: false, json: false };
  for (const arg of argv) {
    if (arg === "--prune") flags.prune = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--upgrade-templates") flags.upgradeTemplates = true;
    else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: ${KNOWN_FLAGS.join(", ")}.`);
  }
  return flags;
}

/**
 * Resolve `revocationsByRole` (role id → keys) to a sorted, human report with
 * the role names (pure given the rows; exported for tests).
 */
export function revocationReport(
  revocationsByRole: Record<string, PermissionKey[]> | undefined,
  roles: ReadonlyArray<{ id: string; name: string; organizationId: string; templateKey: string | null }>
): RevocationReport[] {
  const byId = new Map(roles.map((role) => [role.id, role]));
  return Object.entries(revocationsByRole ?? {})
    .map(([roleId, keys]) => {
      const role = byId.get(roleId);
      return { roleId, roleName: role?.name ?? roleId, organizationId: role?.organizationId ?? "?", templateKey: role?.templateKey ?? null, keys: [...keys].sort() };
    })
    .sort((a, b) => a.organizationId.localeCompare(b.organizationId) || a.roleName.localeCompare(b.roleName) || a.roleId.localeCompare(b.roleId));
}

export async function runRbacSync(flags: RbacSyncFlags, db: RbacDb = prisma, auditChain: AuditChainCli = defaultAuditChainCli): Promise<RbacSyncSummary> {
  // Integrador 8a: --upgrade-templates audita ROLE_TEMPLATE_UPGRADED por cola;
  // hidratar la cadena antes de escribir (nunca en dry-run) y vaciar la cola
  // antes de devolver (el CLI desconecta prisma justo después).
  return withAuditChain(auditChain, !flags.dryRun, () => executeRbacSync(flags, db));
}

async function executeRbacSync(flags: RbacSyncFlags, db: RbacDb): Promise<RbacSyncSummary> {
  const start = Date.now();
  assertTemplatesExcludePlatformKeys();
  const sync = await syncPermissionCatalog({ prune: flags.prune, dryRun: flags.dryRun, db });
  // Tanda 8a: `upgrade` is the ONLY way a key leaves a role; without the flag the
  // backfill stays additive and merely reports what an upgrade would revoke.
  const backfill = await backfillTemplateRoles({ dryRun: flags.dryRun, upgrade: flags.upgradeTemplates === true, db });
  const templates: Record<string, number> = {};
  for (const key of ROLE_TEMPLATE_KEYS) templates[key] = ROLE_PERMISSION_MAP[key].length;
  const revokedIds = Object.keys(backfill.revocationsByRole ?? {});
  const roleRows = revokedIds.length === 0 ? [] : await db.role.findMany({ where: { id: { in: revokedIds } }, select: { id: true, name: true, organizationId: true, templateKey: true } });
  const revocations = revocationReport(backfill.revocationsByRole, roleRows);
  return {
    dryRun: flags.dryRun,
    prune: flags.prune,
    upgradeTemplates: flags.upgradeTemplates === true,
    templateVersion: ROLE_TEMPLATE_VERSION,
    catalogKeys: Object.keys(PERMISSIONS).length,
    orgKeys: ORG_PERMISSION_KEYS.length,
    platformKeys: PLATFORM_PERMISSION_KEYS.length,
    templates,
    sync,
    backfill,
    revocations,
    revokedKeysTotal: revocations.reduce((sum, entry) => sum + entry.keys.length, 0),
    durationMs: Date.now() - start
  };
}

/** Human-readable report (exported for tests; `--json` prints the summary instead). */
export function formatHuman(summary: RbacSyncSummary): string {
  const mode = summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED";
  const { sync, backfill } = summary;
  const staleGrants = sync.staleGrants ?? 0;
  const staleGrantRoles = sync.staleGrantRoles ?? 0;
  const suffixes = [summary.prune ? " + prune" : "", summary.upgradeTemplates ? " + upgrade-templates" : ""].join("");
  const lines = [
    `[rbac:sync] ${mode}${suffixes} · ${summary.durationMs} ms`,
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

  // Tanda 8a: template version, roles behind it and — per role — the keys the
  // version revokes (would revoke without --upgrade-templates or in dry-run;
  // revoked with it). The boot top-up never revokes: only this flag does.
  const version = summary.templateVersion ?? ROLE_TEMPLATE_VERSION;
  const revocations = summary.revocations ?? revocationReport(backfill.revocationsByRole, []);
  const total = summary.revokedKeysTotal ?? revocations.reduce((sum, entry) => sum + entry.keys.length, 0);
  // In a dry-run upgrade the catalog reports the roles it WOULD upgrade instead of counting them as behind.
  const behind =
    summary.upgradeTemplates === true && summary.dryRun
      ? Math.max(backfill.templateRolesBehindVersion ?? 0, backfill.upgraded?.length ?? 0)
      : (backfill.templateRolesBehindVersion ?? 0);
  const applied = summary.upgradeTemplates === true && !summary.dryRun;
  const verb = applied ? "revoked" : "would revoke";
  lines.push(
    `  template version: ${version} · ${behind} role(s) behind` +
      (summary.upgradeTemplates ? (summary.dryRun ? " [dry-run: nothing written]" : " after the upgrade") : "") +
      ` · ${revocations.length} role(s) ${applied ? "lost" : "hold"} key(s) the version ${applied ? "revoked" : "revokes"} (${total} key(s) in total)`
  );
  for (const entry of revocations) {
    lines.push(`    ${verb}: ${entry.roleName} (${entry.organizationId}) ← ${entry.templateKey ?? "sin plantilla"}: −${entry.keys.length} · ${entry.keys.join(", ")}`);
  }
  for (const role of backfill.upgraded ?? []) lines.push(`    ${summary.dryRun ? "would upgrade" : "upgraded"}: ${role}`);
  if (!summary.upgradeTemplates && (behind > 0 || revocations.length > 0)) {
    lines.push(`    kept — the boot top-up never revokes; run \`rbac:sync -- --dry-run --upgrade-templates\`, back up, then \`--upgrade-templates\` (docs/runbooks/rbac-sync.md §2)`);
  }
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
