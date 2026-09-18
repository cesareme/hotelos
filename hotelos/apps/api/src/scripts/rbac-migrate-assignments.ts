// Backfill de asignaciones · user_property_roles → user_role_assignments
// (Tanda 8a · L3 · RBAC por departamento; docs/design/RBAC-DEPARTAMENTOS.md
// §6.5 y §9, docs/runbooks/rbac-sync.md §8).
//
// Hasta la Tanda 8a la única asignación era «rol × propiedad» (una fila de
// user_property_roles por hotel). La tabla nueva user_role_assignments lleva
// el ámbito real (property / property_group / legal_entity / organization),
// vigencia y revocación, y el lector único (lib/rbac-scope.ts) une las dos
// tablas hasta el corte de L6. Este CLI convierte, para UNA organización,
// cada fila legacy en una asignación de la tabla nueva:
//
//   · fila (usuario, rol, propiedad)  → asignación de ámbito `property`
//     {validFrom = ahora, reason = "backfill 2026-09-18", grantedByUserId NULL};
//   · consolidación: un usuario con el MISMO rol en TODAS las propiedades de
//     la organización → UNA asignación de ámbito `organization` (Carmen:
//     Owner ×8 → owner / organization);
//   · rol personalizado (template_key NULL, p. ej. «Local Super Admin») →
//     UNA asignación de ámbito `organization`;
//   · `--general-manager <userId>` → además, a ese usuario, `general_manager`
//     de ámbito organization (decisión D1: Carmen = owner + general_manager);
//     exige que el rol de esa plantilla exista (§7 del runbook antes);
//   · usuarios de la organización sin ninguna fila → informe «sin asignación»;
//   · una fila cuyo rol, usuario o propiedad no pertenece a la organización,
//     o cuyo rol es la plantilla de emergencia, queda BLOQUEADA: se informa y
//     `--apply` se detiene con exit 1 (nunca se migra a ciegas).
//
// Idempotente: una asignación ya viva en la tabla nueva (misma tupla, sin
// revocar ni caducada) se reporta `ya existe` y no se duplica (el índice
// único trata los NULL como distintos, así que decide el plan, no el índice).
// NUNCA borra user_property_roles (la migración de borrado es un lote
// posterior), nunca toca roles ni permisos, nunca crea usuarios. Una sola
// transacción; auditoría ROLE_ASSIGNED por fila creada (actorType system,
// correlationId `rbac_backfill_<run>`) tras el commit; organizations.rbac_version
// sube una vez para que las sesiones vivas relean su ámbito.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   corepack pnpm --filter @hotelos/api rbac:migrate-assignments -- --org <organizationId> --dry-run
//   corepack pnpm --filter @hotelos/api rbac:migrate-assignments -- --org <organizationId> --apply --confirm <organizationId> [--general-manager <userId>]
//
// Exit codes: 0 ok · 1 failure (org missing, blocked rows, --general-manager
// outside the organisation or without its template role, post-condition, DB) ·
// 2 unknown flag / usage.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { prisma } from "@hotelos/database";
import { ROLE_TEMPLATE_KEYS, ROLE_TEMPLATE_LABELS_ES, type RoleKey, type ScopeType } from "@hotelos/shared";
import type { RbacDb } from "../lib/rbac-catalog.js";
import { bumpRbacVersion } from "../lib/rbac-scope.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { defaultAuditChainCli, withAuditChain, type AuditChainCli } from "../lib/audit-chain-cli.js";

export const BACKFILL_REASON = "backfill 2026-09-18";
export const CORRELATION_PREFIX = "rbac_backfill_";
export const GENERAL_MANAGER_TEMPLATE: RoleKey = "general_manager";

export const USAGE = [
  "Usage:",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/rbac-migrate-assignments.ts \\",
  "    --org <organizationId> [--dry-run | --apply --confirm <organizationId>] [--general-manager <userId>] [--json] [--help]",
  "",
  "  --org <id>                 organización cuyas filas de user_property_roles se migran (obligatorio)",
  "  --dry-run                  (por defecto) imprime el plan, no escribe nada",
  "  --apply                    escribe, en una sola transacción; exige --confirm",
  "  --confirm <orgId>          debe coincidir con --org (guarda contra aplicar a otra organización)",
  `  --general-manager <userId> además, asigna a ese usuario «${ROLE_TEMPLATE_LABELS_ES[GENERAL_MANAGER_TEMPLATE]}» (${GENERAL_MANAGER_TEMPLATE}) de ámbito organization (D1)`,
  "  --json                     salida máquina",
  "  --help, -h                 esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 fallo (org inexistente, filas bloqueadas, post-condición) · 2 flag desconocido"
].join("\n");

export type MigrateFlags = {
  org: string | null;
  apply: boolean;
  confirm: string | null;
  generalManager: string | null;
  json: boolean;
  help: boolean;
};

export function parseFlags(argv: readonly string[]): MigrateFlags {
  const flags: MigrateFlags = { org: null, apply: false, confirm: null, generalManager: null, json: false, help: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--org" || arg === "--confirm" || arg === "--general-manager") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      i += 1;
      if (arg === "--org") {
        if (flags.org !== null) throw new Error("--org may be given only once.");
        flags.org = value.trim();
      } else if (arg === "--confirm") {
        if (flags.confirm !== null) throw new Error("--confirm may be given only once.");
        flags.confirm = value.trim();
      } else {
        if (flags.generalManager !== null) throw new Error("--general-manager may be given only once.");
        flags.generalManager = value.trim();
      }
    } else {
      throw new Error(`Unknown flag "${arg}". Known: --org <id>, --dry-run, --apply, --confirm <orgId>, --general-manager <userId>, --json, --help.`);
    }
  }
  if (flags.help) return flags;
  if (!flags.org) throw new Error("--org <organizationId> is required.");
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (flags.apply && flags.confirm === null) throw new Error("--apply requires --confirm <organizationId> (the same id as --org).");
  if (!flags.apply && flags.confirm !== null) throw new Error("--confirm only makes sense with --apply.");
  return flags;
}

/** --confirm must name exactly the organisation of --org (typo / wrong DB guard). */
export function assertConfirmMatches(flags: Pick<MigrateFlags, "apply" | "confirm" | "org">): void {
  if (!flags.apply) return;
  if (flags.confirm !== flags.org) {
    throw new Error(`--confirm "${flags.confirm}" does not match --org "${flags.org}". Nothing written.`);
  }
}

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

export type PlanRoleRow = { id: string; organizationId: string; name: string; templateKey: string | null };
export type PlanUserRow = { id: string; organizationId: string; email: string; status: string };
export type PlanPropertyRow = { id: string; organizationId: string; name: string };
export type LegacyRow = { id: string; userId: string; propertyId: string; roleId: string };
export type LiveAssignmentRow = {
  id: string;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  propertyId: string | null;
  organizationId: string;
  revokedAt: Date | null;
  validTo: Date | null;
};

export type PlannedOrigin = "consolidated" | "custom-role" | "property" | "general-manager";

export type PlannedAssignment = {
  userId: string;
  email: string;
  roleId: string;
  roleName: string;
  templateKey: RoleKey | null;
  scopeType: "property" | "organization";
  propertyId: string | null;
  propertyName: string | null;
  /** user_property_roles rows folded into this assignment (empty for --general-manager). */
  legacyRowIds: string[];
  origin: PlannedOrigin;
  /** Live user_role_assignments row that already covers this tuple (nothing to write). */
  existingAssignmentId: string | null;
};

export type BlockedRow = { legacyRowId: string | null; userId: string | null; reason: string };

export type MigrationPlan = {
  organizationId: string;
  properties: number;
  legacyRows: number;
  planned: PlannedAssignment[];
  blocked: BlockedRow[];
  usersWithoutAssignment: Array<{ userId: string; email: string; status: string }>;
  counts: {
    organization: number;
    property: number;
    toCreate: number;
    skipped: number;
    blocked: number;
    usersWithoutAssignment: number;
  };
};

export type PlanInput = {
  organizationId: string;
  properties: readonly PlanPropertyRow[];
  users: readonly PlanUserRow[];
  roles: readonly PlanRoleRow[];
  legacyRows: readonly LegacyRow[];
  liveAssignments: readonly LiveAssignmentRow[];
  generalManagerUserId?: string | null;
  now: Date;
};

function toTemplateKey(value: string | null): RoleKey | null {
  if (!value) return null;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

function isLive(row: LiveAssignmentRow, now: Date): boolean {
  // `?? null`: a row without the column (fake stores in tests) reads like Prisma's NULL.
  const revokedAt = row.revokedAt ?? null;
  const validTo = row.validTo ?? null;
  return revokedAt === null && (validTo === null || validTo.getTime() > now.getTime());
}

/**
 * Decide, for one organisation, which user_role_assignments rows the legacy
 * table implies. Pure: the caller feeds the rows. See the module comment for
 * the rules (property → property; same role in every property → organization;
 * custom role → organization; --general-manager → general_manager /
 * organization; foreign or emergency rows → blocked).
 */
export function planMigration(input: PlanInput): MigrationPlan {
  const organizationId = input.organizationId;
  const properties = input.properties.filter((row) => row.organizationId === organizationId);
  const propertyById = new Map(properties.map((row) => [row.id, row]));
  const users = input.users.filter((row) => row.organizationId === organizationId);
  const userById = new Map(users.map((row) => [row.id, row]));
  const roles = input.roles.filter((row) => row.organizationId === organizationId);
  const roleById = new Map(roles.map((row) => [row.id, row]));
  const live = input.liveAssignments.filter((row) => row.organizationId === organizationId && isLive(row, input.now));

  const blocked: BlockedRow[] = [];
  const groups = new Map<string, { user: PlanUserRow; role: PlanRoleRow; rows: LegacyRow[] }>();
  for (const row of input.legacyRows) {
    const user = userById.get(row.userId);
    if (!user) {
      blocked.push({ legacyRowId: row.id, userId: row.userId, reason: "usuario inexistente o de otra organización" });
      continue;
    }
    const role = roleById.get(row.roleId);
    if (!role) {
      blocked.push({ legacyRowId: row.id, userId: row.userId, reason: `rol ${row.roleId} inexistente o de otra organización` });
      continue;
    }
    if (role.templateKey === "break_glass") {
      blocked.push({ legacyRowId: row.id, userId: row.userId, reason: `«${role.name}» es la plantilla de emergencia: nunca se migra` });
      continue;
    }
    if (!propertyById.has(row.propertyId)) {
      blocked.push({ legacyRowId: row.id, userId: row.userId, reason: `propiedad ${row.propertyId} inexistente o de otra organización` });
      continue;
    }
    if (user.status === "emergency") {
      blocked.push({ legacyRowId: row.id, userId: row.userId, reason: "cuenta de emergencia: nunca se migra" });
      continue;
    }
    const key = `${user.id}|${role.id}`;
    const group = groups.get(key) ?? { user, role, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const findLive = (userId: string, roleId: string, scopeType: "property" | "organization", propertyId: string | null): string | null =>
    live.find((row) => row.userId === userId && row.roleId === roleId && row.scopeType === scopeType && (scopeType === "organization" || row.propertyId === propertyId))?.id ?? null;

  const planned: PlannedAssignment[] = [];
  const sortedGroups = [...groups.values()].sort((a, b) => a.user.email.localeCompare(b.user.email) || a.role.name.localeCompare(b.role.name));
  for (const group of sortedGroups) {
    const templateKey = toTemplateKey(group.role.templateKey);
    const coveredProperties = new Set(group.rows.map((row) => row.propertyId));
    const coversAll = properties.length > 0 && properties.every((property) => coveredProperties.has(property.id));
    const customRole = group.role.templateKey === null;
    if (customRole || coversAll) {
      planned.push({
        userId: group.user.id,
        email: group.user.email,
        roleId: group.role.id,
        roleName: group.role.name,
        templateKey,
        scopeType: "organization",
        propertyId: null,
        propertyName: null,
        legacyRowIds: group.rows.map((row) => row.id),
        origin: customRole ? "custom-role" : "consolidated",
        existingAssignmentId: findLive(group.user.id, group.role.id, "organization", null)
      });
      continue;
    }
    const seen = new Set<string>();
    for (const row of group.rows) {
      if (seen.has(row.propertyId)) continue;
      seen.add(row.propertyId);
      planned.push({
        userId: group.user.id,
        email: group.user.email,
        roleId: group.role.id,
        roleName: group.role.name,
        templateKey,
        scopeType: "property",
        propertyId: row.propertyId,
        propertyName: propertyById.get(row.propertyId)?.name ?? null,
        legacyRowIds: group.rows.filter((candidate) => candidate.propertyId === row.propertyId).map((candidate) => candidate.id),
        origin: "property",
        existingAssignmentId: findLive(group.user.id, group.role.id, "property", row.propertyId)
      });
    }
  }

  if (input.generalManagerUserId) {
    const user = userById.get(input.generalManagerUserId);
    if (!user) {
      throw new Error(`--general-manager "${input.generalManagerUserId}" no es un usuario de la organización ${organizationId}. Nada escrito.`);
    }
    const role = roles.find((candidate) => candidate.templateKey === GENERAL_MANAGER_TEMPLATE);
    if (!role) {
      blocked.push({
        legacyRowId: null,
        userId: user.id,
        reason: `no existe el rol de plantilla ${GENERAL_MANAGER_TEMPLATE} («${ROLE_TEMPLATE_LABELS_ES[GENERAL_MANAGER_TEMPLATE]}») en la organización: ejecuta reseed-property-roles --org ${organizationId} antes (runbook rbac-sync.md §7)`
      });
    } else if (user.status === "emergency") {
      blocked.push({ legacyRowId: null, userId: user.id, reason: "cuenta de emergencia: nunca recibe general_manager" });
    } else {
      planned.push({
        userId: user.id,
        email: user.email,
        roleId: role.id,
        roleName: role.name,
        templateKey: GENERAL_MANAGER_TEMPLATE,
        scopeType: "organization",
        propertyId: null,
        propertyName: null,
        legacyRowIds: [],
        origin: "general-manager",
        existingAssignmentId: findLive(user.id, role.id, "organization", null)
      });
    }
  }

  const usersWithRows = new Set([...input.legacyRows.map((row) => row.userId), ...live.map((row) => row.userId), ...planned.map((row) => row.userId)]);
  const usersWithoutAssignment = users
    .filter((user) => user.status !== "emergency" && !usersWithRows.has(user.id))
    .map((user) => ({ userId: user.id, email: user.email, status: user.status }))
    .sort((a, b) => a.email.localeCompare(b.email));

  const toCreate = planned.filter((row) => row.existingAssignmentId === null).length;
  return {
    organizationId,
    properties: properties.length,
    legacyRows: input.legacyRows.length,
    planned,
    blocked,
    usersWithoutAssignment,
    counts: {
      organization: planned.filter((row) => row.scopeType === "organization").length,
      property: planned.filter((row) => row.scopeType === "property").length,
      toCreate,
      skipped: planned.length - toCreate,
      blocked: blocked.length,
      usersWithoutAssignment: usersWithoutAssignment.length
    }
  };
}

export function planIsBlocked(plan: MigrationPlan): boolean {
  return plan.blocked.length > 0;
}

// ---------------------------------------------------------------------------
// Runner (DB)
// ---------------------------------------------------------------------------

export type MigrateDeps = {
  db?: RbacDb;
  audit?: typeof recordAuditEvent;
  /** Cadena hash de auditoría (integrador 8a): hidratada antes de escribir, vaciada antes de devolver. */
  auditChain?: AuditChainCli;
  now?: () => Date;
  /** Suffix of the correlation id (`rbac_backfill_<runId>`); random by default. */
  runId?: string;
};

export type CreatedAssignment = {
  assignmentId: string;
  userId: string;
  email: string;
  roleId: string;
  roleName: string;
  templateKey: RoleKey | null;
  scopeType: "property" | "organization";
  propertyId: string | null;
  origin: PlannedOrigin;
  legacyRowIds: string[];
};

export type MigrationResult = {
  mode: "dry-run" | "apply";
  organizationId: string;
  organizationName: string;
  runId: string;
  correlationId: string;
  plan: MigrationPlan;
  /** Rows written by this run (empty in dry-run). */
  created: CreatedAssignment[];
  /** Audit rows written (ROLE_ASSIGNED, actorType system). */
  audited: number;
  /** After --apply: the plan recomputed over the post-state (toCreate must be 0). */
  postCondition?: { toCreate: number; skipped: number; ok: boolean };
  durationMs: number;
};

async function loadPlanInput(db: RbacDb, organizationId: string, generalManagerUserId: string | null, now: Date): Promise<PlanInput> {
  const [properties, users, roles] = await Promise.all([
    db.property.findMany({ where: { organizationId }, select: { id: true, organizationId: true, name: true }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { organizationId }, select: { id: true, organizationId: true, email: true, status: true }, orderBy: { email: "asc" } }),
    db.role.findMany({ where: { organizationId }, select: { id: true, organizationId: true, name: true, templateKey: true }, orderBy: { name: "asc" } })
  ]);
  const legacyRows =
    users.length === 0
      ? []
      : await db.userPropertyRole.findMany({ where: { userId: { in: users.map((user) => user.id) } }, select: { id: true, userId: true, propertyId: true, roleId: true }, orderBy: { id: "asc" } });
  const liveAssignments = await db.userRoleAssignment.findMany({
    where: { organizationId, revokedAt: null },
    select: { id: true, userId: true, roleId: true, scopeType: true, propertyId: true, organizationId: true, revokedAt: true, validTo: true }
  });
  return { organizationId, properties, users, roles, legacyRows, liveAssignments, generalManagerUserId, now };
}

export async function runMigration(flags: MigrateFlags, deps: MigrateDeps = {}): Promise<MigrationResult> {
  // Integrador 8a: hidratar la punta de la cadena antes de escribir y vaciar la
  // cola de auditoría antes de devolver (el CLI desconecta prisma justo después).
  return withAuditChain(deps.auditChain ?? defaultAuditChainCli, flags.apply, () => executeMigration(flags, deps));
}

async function executeMigration(flags: MigrateFlags, deps: MigrateDeps): Promise<MigrationResult> {
  const startedAt = Date.now();
  const db = deps.db ?? prisma;
  const audit = deps.audit ?? recordAuditEvent;
  const now = deps.now ? deps.now() : new Date();
  const runId = deps.runId ?? `${now.getTime().toString(36)}${randomBytes(3).toString("hex")}`;
  const correlationId = `${CORRELATION_PREFIX}${runId}`;
  assertConfirmMatches(flags);
  const organizationId = flags.org!;
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  if (!organization) throw new Error(`Organización "${organizationId}" no existe. Nada escrito.`);

  const plan = planMigration(await loadPlanInput(db, organizationId, flags.generalManager, now));
  const base = { organizationId, organizationName: organization.name, runId, correlationId };

  if (!flags.apply) {
    return { mode: "dry-run", ...base, plan, created: [], audited: 0, durationMs: Date.now() - startedAt };
  }
  if (planIsBlocked(plan)) {
    throw new Error(`El plan tiene ${plan.blocked.length} fila(s) bloqueada(s): resuélvelas antes de --apply (ver «Bloqueadas»). Nada escrito.`);
  }

  const created: CreatedAssignment[] = [];
  const work = async (tx: RbacDb): Promise<void> => {
    for (const row of plan.planned) {
      if (row.existingAssignmentId !== null) continue;
      const inserted = await tx.userRoleAssignment.create({
        data: {
          userId: row.userId,
          roleId: row.roleId,
          scopeType: row.scopeType,
          propertyId: row.scopeType === "property" ? row.propertyId : null,
          propertyGroupId: null,
          legalEntityId: null,
          organizationId,
          validFrom: now,
          validTo: null,
          grantedByUserId: null,
          reason: BACKFILL_REASON
        },
        select: { id: true }
      });
      created.push({
        assignmentId: inserted.id,
        userId: row.userId,
        email: row.email,
        roleId: row.roleId,
        roleName: row.roleName,
        templateKey: row.templateKey,
        scopeType: row.scopeType,
        propertyId: row.scopeType === "property" ? row.propertyId : null,
        origin: row.origin,
        legacyRowIds: row.legacyRowIds
      });
    }
    if (created.length > 0) await bumpRbacVersion(organizationId, tx);
  };
  const client = db as { $transaction?: (fn: (tx: RbacDb) => Promise<void>) => Promise<void> };
  if (typeof client.$transaction === "function") await client.$transaction(work);
  else await work(db);

  // Audit after the commit: one ROLE_ASSIGNED per row, system actor.
  let audited = 0;
  for (const row of created) {
    audit({
      organizationId,
      propertyId: row.propertyId ?? undefined,
      actorType: "system",
      action: "ROLE_ASSIGNED",
      entityType: "user_role_assignment",
      entityId: row.assignmentId,
      afterJson: {
        userId: row.userId,
        roleId: row.roleId,
        roleName: row.roleName,
        templateKey: row.templateKey,
        scopeType: row.scopeType,
        ref: row.propertyId ?? organizationId,
        propertyId: row.propertyId,
        reason: BACKFILL_REASON,
        origin: row.origin,
        legacyRowIds: row.legacyRowIds
      },
      correlationId
    });
    audited += 1;
  }

  // Post-condition: planning again over the post-state yields nothing to create.
  const after = planMigration(await loadPlanInput(db, organizationId, flags.generalManager, now));
  const postCondition = { toCreate: after.counts.toCreate, skipped: after.counts.skipped, ok: after.counts.toCreate === 0 };
  if (!postCondition.ok) {
    throw new Error(`Post-condición: tras aplicar quedan ${after.counts.toCreate} asignación(es) por crear.`);
  }
  return { mode: "apply", ...base, plan, created, audited, postCondition, durationMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

export function formatHuman(result: MigrationResult): string {
  const { plan } = result;
  const lines: string[] = [];
  lines.push(`Organización ${result.organizationName} (${result.organizationId}) · ${result.mode === "apply" ? "APLICADO" : "dry-run (sin escrituras)"} · correlación ${result.correlationId}`);
  lines.push(`user_property_roles: ${plan.legacyRows} fila(s) · propiedades: ${plan.properties} · user_role_assignments planificadas: ${plan.planned.length} (organization ${plan.counts.organization} · property ${plan.counts.property}) · a crear ${plan.counts.toCreate} · ya existen ${plan.counts.skipped} · bloqueadas ${plan.counts.blocked}`);
  lines.push("");
  lines.push(`${pad("Usuario", 34)} ${pad("Rol", 22)} ${pad("Plantilla", 20)} ${pad("Ámbito", 13)} ${pad("Propiedad", 30)} ${pad("Origen", 16)} Estado`);
  for (const row of plan.planned) {
    const state = row.existingAssignmentId ? `ya existe (${row.existingAssignmentId})` : "crear";
    lines.push(`${pad(row.email, 34)} ${pad(row.roleName, 22)} ${pad(row.templateKey ?? "(personalizado)", 20)} ${pad(row.scopeType, 13)} ${pad(row.propertyName ?? "— toda la organización", 30)} ${pad(`${row.origin}${row.legacyRowIds.length > 0 ? ` ×${row.legacyRowIds.length}` : ""}`, 16)} ${state}`);
  }
  if (plan.planned.length === 0) lines.push("  (ninguna asignación que migrar)");
  if (plan.blocked.length > 0) {
    lines.push("");
    lines.push("Bloqueadas (no se migran; --apply se detiene con exit 1):");
    for (const row of plan.blocked) lines.push(`  - fila ${row.legacyRowId ?? "—"} · usuario ${row.userId ?? "—"}: ${row.reason}`);
  }
  if (plan.usersWithoutAssignment.length > 0) {
    lines.push("");
    lines.push(`Usuarios sin asignación (${plan.usersWithoutAssignment.length}; no reciben nada, revisar a mano):`);
    for (const user of plan.usersWithoutAssignment) lines.push(`  - ${user.email} (${user.userId}, ${user.status})`);
  }
  if (result.mode === "apply") {
    lines.push("");
    lines.push(`Creadas: ${result.created.length} asignación(es) · auditoría ROLE_ASSIGNED: ${result.audited} · post-condición: ${result.postCondition?.ok ? "ok" : "FALLO"} (por crear ${result.postCondition?.toCreate ?? "?"}, ya existen ${result.postCondition?.skipped ?? "?"})`);
    for (const row of result.created) lines.push(`  + ${row.assignmentId}: ${row.email} ← ${row.roleName} / ${row.scopeType}${row.propertyId ? ` / ${row.propertyId}` : ""}`);
    lines.push("user_property_roles: intacta (dual-read hasta el corte de L6).");
  }
  lines.push("");
  lines.push(`${result.mode === "apply" ? "Aplicado" : "Plan"} en ${result.durationMs} ms.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(entry) === fileURLToPath(import.meta.url);
}

async function main(): Promise<number> {
  let flags: MigrateFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await runMigration(flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatHuman(result));
    return result.mode === "dry-run" && planIsBlocked(result.plan) ? 1 : 0;
  } catch (error) {
    console.error(`[rbac:migrate-assignments] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (isMain()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
