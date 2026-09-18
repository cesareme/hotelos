// Re-seed the template roles of ONE organisation from the shared templates
// (Tanda 5 · L1a · rbac; Tanda 8a · L3: the 22 templates of design §4.2).
// Deuda L5: the demo tenants (Faranda, org_123) only had "Owner" / "Local
// Super Admin", so the invite selector offered nothing else and the
// navigation tree of Tanda 5 (one token per template) had no role to bind
// Recepción, Pisos, Contabilidad… to. This CLI materialises, per
// organisation, one Role row for every template of
// ORGANIZATION_TEMPLATE_ROLE_KEYS (packages/shared/src/permissions.ts: 22
// since Tanda 8a — never `admin`, the platform token, nor `break_glass`, the
// emergency role only ensureBreakGlassRole creates) and tops it up to the
// template — idempotent, additive, never destructive:
//
//   top-up   a role already stamped with the template (Role.templateKey)
//            receives the keys it is missing (+0 once converged); rows that
//            predate Tanda 8a get their `level` / `department` filled (never
//            the version: that is `rbac:sync --upgrade-templates`);
//   adopt    a role WITHOUT templateKey whose name resolves to the template
//            (resolveTemplateKeyForRoleName, e.g. the Faranda "Owner" created
//            before the column existed) and that holds nothing outside the
//            template ∪ its revocations (a v1 role is still recognised) is
//            stamped and topped up;
//   create   when no role follows the template, a new one is created with the
//            Spanish name of ROLE_TEMPLATE_LABELS_ES (createRoleFromTemplate:
//            same audit event as POST /backoffice/properties/:id/roles, with
//            `level`, `department`, `templateVersion` = current and
//            `managed` = true);
//   conflict a role carries the template's name but is custom (keys beyond
//            the template, or `managed = false`) or follows another template:
//            reported, never touched, and it blocks --apply (exit 1) so a
//            hand-made role is not silently shadowed by a second one with a
//            different name.
//
// Platform roles (admin.* grants, or a platform role name inside the HotelOS
// organisation) and roles with `managed = false` (edited by hand through
// PATCH /rbac/roles/:id/permissions) are skipped: the full catalog is the
// platform's (backfillTemplateRoles) and a custom role is the hotel's.
// Roles are organisation scoped (Role.organizationId) and assignable in every
// property of the organisation; the "per property" report lists, for each
// property, how many user_property_roles hang from each template role so the
// operator sees who would be affected. Users are never created nor assigned
// (that is `rbac:migrate-assignments` and the users & roles screen).
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/reseed-property-roles.ts \
//     --org <organizationId> [--dry-run | --apply --confirm <organizationId>] \
//     [--templates owner,manager,...] [--json] [--help]
//
//   --org <id>           organisation to re-seed (required)
//   --dry-run            (default) print the plan, write nothing
//   --apply              write, inside one transaction; requires --confirm
//   --confirm <orgId>    must equal --org (guards against the wrong DB/org)
//   --templates <a,b>    subset of ORGANIZATION_TEMPLATE_ROLE_KEYS (default: all)
//   --json               machine-readable output
//
// Exit codes: 0 ok · 1 failure (org missing, conflicts, post-condition, DB
// error) · 2 unknown flag / usage. Restarting the API is not needed: roles
// and grants are read from Postgres on every request.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import { defaultAuditChainCli, withAuditChain, type AuditChainCli } from "../lib/audit-chain-cli.js";
import {
  ORGANIZATION_TEMPLATE_ROLE_KEYS,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LABELS_ES,
  isPlatformPermission,
  type RoleKey
} from "@hotelos/shared";
import {
  applyRoleTemplate,
  createRoleFromTemplate,
  isPlatformRoleName,
  isRoleTemplateKey,
  resolveTemplateKeyForRoleName,
  templatePermissionKeys,
  templateRevocationKeys,
  templateRoleMetadata,
  type RbacDb
} from "../lib/rbac-catalog.js";

export const USAGE = [
  "Usage:",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/reseed-property-roles.ts \\",
  "    --org <organizationId> [--dry-run | --apply --confirm <organizationId>] [--templates a,b] [--json] [--help]",
  "",
  "  --org <id>           organización a resembrar (obligatorio)",
  "  --dry-run            (por defecto) imprime el plan, no escribe nada",
  "  --apply              escribe, en una sola transacción; exige --confirm",
  "  --confirm <orgId>    debe coincidir con --org (guarda contra aplicar a otra organización)",
  `  --templates <a,b>    subconjunto de plantillas (por defecto: ${ORGANIZATION_TEMPLATE_ROLE_KEYS.join(",")})`,
  "  --json               salida máquina",
  "  --help, -h           esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 fallo (org inexistente, conflictos, post-condición) · 2 flag desconocido"
].join("\n");

export type ReseedFlags = {
  org: string | null;
  apply: boolean;
  confirm: string | null;
  templates: RoleKey[];
  json: boolean;
  help: boolean;
};

export function parseFlags(argv: readonly string[]): ReseedFlags {
  const flags: ReseedFlags = {
    org: null,
    apply: false,
    confirm: null,
    templates: [...ORGANIZATION_TEMPLATE_ROLE_KEYS],
    json: false,
    help: false
  };
  let sawDryRun = false;
  let sawTemplates = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--org" || arg === "--confirm" || arg === "--templates") {
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
        if (sawTemplates) throw new Error("--templates may be given only once.");
        sawTemplates = true;
        const keys = value
          .split(",")
          .map((key) => key.trim())
          .filter((key) => key.length > 0);
        if (keys.length === 0) throw new Error("--templates requires at least one template key.");
        for (const key of keys) {
          if (!(ORGANIZATION_TEMPLATE_ROLE_KEYS as readonly string[]).includes(key)) {
            throw new Error(`Unknown template "${key}". Known: ${ORGANIZATION_TEMPLATE_ROLE_KEYS.join(", ")}.`);
          }
        }
        flags.templates = ORGANIZATION_TEMPLATE_ROLE_KEYS.filter((key) => keys.includes(key));
      }
    } else {
      throw new Error(`Unknown flag "${arg}". Known: --org <id>, --dry-run, --apply, --confirm <orgId>, --templates <a,b>, --json, --help.`);
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
export function assertConfirmMatches(flags: ReseedFlags): void {
  if (!flags.apply) return;
  if (flags.confirm !== flags.org) {
    throw new Error(`--confirm "${flags.confirm}" does not match --org "${flags.org}". Nothing written.`);
  }
}

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

export type RoleRow = {
  id: string;
  organizationId: string;
  name: string;
  templateKey: string | null;
  /** Tanda 8a: false = custom role edited by hand (PATCH /rbac/roles/:id/permissions); never touched. Absent = managed. */
  managed?: boolean;
  level?: string | null;
  department?: string | null;
};

export type PlanAction = "top-up" | "adopt" | "create" | "conflict";

export type TemplatePlan = {
  templateKey: RoleKey;
  action: PlanAction;
  /** Existing role (top-up / adopt / conflict) or the name to create. */
  roleId: string | null;
  roleName: string;
  /** role_permissions rows the run would add (top-up / adopt / create). */
  missing: number;
  /** Template size (org-scoped keys). */
  templateSize: number;
  /** Why the template cannot be materialised (conflict only). */
  reason?: string;
};

export type PlanInput = {
  organizationId: string;
  templates: readonly RoleKey[];
  roles: readonly RoleRow[];
  /** Permission keys each role holds (role id → keys). */
  keysByRole: ReadonlyMap<string, ReadonlySet<string>>;
  /** Organisations that already own a platform-granted role (HotelOS org); platform names there are skipped. */
  platformOrganizations?: ReadonlySet<string>;
};

export type ReseedPlan = {
  organizationId: string;
  templates: TemplatePlan[];
  /** Roles of the organisation left untouched, with the reason. */
  skipped: { roleId: string; roleName: string; reason: string }[];
};

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isPlatformRoleRow(role: RoleRow, keys: ReadonlySet<string>, platformOrganizations: ReadonlySet<string>): boolean {
  for (const key of keys) if (isPlatformPermission(key)) return true;
  return isPlatformRoleName(role.name) && platformOrganizations.has(role.organizationId);
}

/**
 * Decide, per requested template, which role of the organisation follows it
 * (stored templateKey first, then adoption by name) or whether one must be
 * created. Pure: the caller feeds the rows and their keys.
 */
export function planTemplateRoles(input: PlanInput): ReseedPlan {
  const platformOrganizations = input.platformOrganizations ?? new Set<string>();
  const orgRoles = input.roles.filter((role) => role.organizationId === input.organizationId);
  const skipped: ReseedPlan["skipped"] = [];
  const claimed = new Set<string>();
  const keysOf = (role: RoleRow): ReadonlySet<string> => input.keysByRole.get(role.id) ?? new Set<string>();

  const candidates = orgRoles.filter((role) => {
    if (isPlatformRoleRow(role, keysOf(role), platformOrganizations)) {
      skipped.push({ roleId: role.id, roleName: role.name, reason: "rol de plataforma (catálogo completo por backfillTemplateRoles)" });
      return false;
    }
    if (role.managed === false) {
      // Tanda 8a: edited by hand → custom whatever its name or template_key; it may still block a `create` (name taken).
      skipped.push({ roleId: role.id, roleName: role.name, reason: "rol personalizado (managed = false): nunca se toca" });
      return false;
    }
    if (role.templateKey !== null && !isRoleTemplateKey(role.templateKey)) {
      skipped.push({ roleId: role.id, roleName: role.name, reason: `template_key desconocido "${role.templateKey}"` });
      return false;
    }
    return true;
  });

  const templates: TemplatePlan[] = [];
  for (const templateKey of input.templates) {
    const templateKeys = templatePermissionKeys(templateKey);
    // Tanda 8a: a role converged to the PREVIOUS template version still holds
    // the keys the current version revokes; adoption tolerates them (the boot
    // backfill applies the same envelope) and `rbac:sync --upgrade-templates`
    // removes them later. Never `admin` nor `break_glass` here.
    const templateSet = new Set<string>([...templateKeys, ...templateRevocationKeys(templateKey)]);
    const missingFor = (role: RoleRow): number => templateKeys.filter((key) => !keysOf(role).has(key)).length;

    // 1) stamped with the template (first by id for determinism).
    const stamped = candidates.filter((role) => role.templateKey === templateKey && !claimed.has(role.id)).sort((a, b) => a.id.localeCompare(b.id));
    if (stamped.length > 0) {
      const role = stamped[0]!;
      claimed.add(role.id);
      templates.push({ templateKey, action: "top-up", roleId: role.id, roleName: role.name, missing: missingFor(role), templateSize: templateKeys.length });
      for (const extra of stamped.slice(1)) {
        claimed.add(extra.id);
        skipped.push({ roleId: extra.id, roleName: extra.name, reason: `segundo rol con plantilla "${templateKey}" (se conserva; el top-up del arranque lo mantiene)` });
      }
      continue;
    }

    // 2) adoption by name: templateKey null, name resolves, nothing outside the template.
    const byName = candidates.filter((role) => role.templateKey === null && !claimed.has(role.id) && resolveTemplateKeyForRoleName(role.name) === templateKey);
    const adoptable = byName.find((role) => Array.from(keysOf(role)).every((key) => templateSet.has(key)));
    if (adoptable) {
      claimed.add(adoptable.id);
      templates.push({ templateKey, action: "adopt", roleId: adoptable.id, roleName: adoptable.name, missing: missingFor(adoptable), templateSize: templateKeys.length });
      continue;
    }

    // 3) create — unless the label is already taken by a role we cannot adopt.
    const label = ROLE_TEMPLATE_LABELS_ES[templateKey];
    const collision = orgRoles.find((role) => normalizeName(role.name) === normalizeName(label));
    if (collision || byName.length > 0) {
      const blocker = collision ?? byName[0]!;
      const held = keysOf(blocker);
      const extra = Array.from(held).filter((key) => !templateSet.has(key)).length;
      const reason =
        blocker.managed === false
          ? `«${blocker.name}» es un rol personalizado (managed = false)`
          : blocker.templateKey !== null
            ? `«${blocker.name}» sigue la plantilla "${blocker.templateKey}"`
            : extra > 0
              ? `«${blocker.name}» es un rol personalizado (${extra} clave(s) fuera de "${templateKey}")`
              : `«${blocker.name}» ya está reclamado por otra plantilla`;
      templates.push({ templateKey, action: "conflict", roleId: blocker.id, roleName: blocker.name, missing: 0, templateSize: templateKeys.length, reason });
      continue;
    }
    templates.push({ templateKey, action: "create", roleId: null, roleName: label, missing: templateKeys.length, templateSize: templateKeys.length });
  }

  for (const role of candidates) {
    if (claimed.has(role.id)) continue;
    if (templates.some((plan) => plan.roleId === role.id)) continue;
    const reason =
      role.templateKey !== null
        ? `plantilla "${role.templateKey}" fuera de --templates`
        : resolveTemplateKeyForRoleName(role.name)
          ? "rol con nombre de plantilla y claves propias (personalizado)"
          : "rol personalizado sin plantilla";
    skipped.push({ roleId: role.id, roleName: role.name, reason });
  }

  return { organizationId: input.organizationId, templates, skipped };
}

export function planHasConflicts(plan: ReseedPlan): boolean {
  return plan.templates.some((template) => template.action === "conflict");
}

export type PropertyReport = {
  propertyId: string;
  propertyName: string;
  /** user_property_roles per template role of the plan (template key → users). */
  assignments: Record<string, number>;
  /** Users assigned in this property to a role that follows no template. */
  usersOnCustomRoles: number;
};

export function summarizePlan(plan: ReseedPlan, properties: readonly PropertyReport[], mode: "dry-run" | "apply"): string {
  const lines: string[] = [];
  lines.push(`Organización ${plan.organizationId} · ${mode === "apply" ? "APLICAR" : "dry-run (sin escrituras)"}`);
  lines.push("");
  lines.push("Plantilla      Acción    Rol                         Faltan  Tamaño");
  for (const template of plan.templates) {
    const action = template.action.padEnd(9);
    const name = template.roleName.length > 26 ? `${template.roleName.slice(0, 25)}…` : template.roleName.padEnd(26);
    const missing = template.action === "conflict" ? "—" : `+${template.missing}`;
    lines.push(`${template.templateKey.padEnd(14)} ${action} ${name} ${missing.padStart(6)}  ${String(template.templateSize).padStart(6)}${template.reason ? `  ← ${template.reason}` : ""}`);
  }
  const creates = plan.templates.filter((t) => t.action === "create").length;
  const adopts = plan.templates.filter((t) => t.action === "adopt").length;
  const topUps = plan.templates.filter((t) => t.action === "top-up");
  const grants = plan.templates.filter((t) => t.action !== "conflict").reduce((sum, t) => sum + t.missing, 0);
  lines.push("");
  lines.push(`Resumen: ${creates} rol(es) a crear · ${adopts} a adoptar · ${topUps.length} con plantilla (${topUps.filter((t) => t.missing > 0).length} con claves que faltan) · ${grants} role_permissions a añadir`);
  if (planHasConflicts(plan)) {
    lines.push("CONFLICTOS: hay plantillas que no se pueden materializar (ver «conflict»); --apply se detiene con exit 1.");
  }
  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push("Roles no tocados:");
    for (const entry of plan.skipped) lines.push(`  - ${entry.roleName} (${entry.roleId}): ${entry.reason}`);
  }
  if (properties.length > 0) {
    lines.push("");
    lines.push("Por propiedad (usuarios asignados a cada rol plantilla):");
    for (const property of properties) {
      const pairs = Object.entries(property.assignments)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => `${key}=${count}`);
      lines.push(`  - ${property.propertyName} (${property.propertyId}): ${pairs.length > 0 ? pairs.join(" · ") : "sin usuarios en roles plantilla"}${property.usersOnCustomRoles > 0 ? ` · ${property.usersOnCustomRoles} en roles personalizados` : ""}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runner (DB)
// ---------------------------------------------------------------------------

export type ReseedResult = {
  mode: "dry-run" | "apply";
  plan: ReseedPlan;
  properties: PropertyReport[];
  /** Filled after --apply: what each template role looks like now. */
  after?: { templateKey: RoleKey; roleId: string; roleName: string; permissions: number; templateSize: number }[];
  durationMs: number;
};

async function loadOrganisationRoles(db: RbacDb, organizationId: string) {
  const roles: RoleRow[] = await db.role.findMany({
    select: { id: true, organizationId: true, name: true, templateKey: true, managed: true, level: true, department: true },
    orderBy: { id: "asc" }
  });
  const permissions = await db.permission.findMany({ select: { id: true, key: true } });
  const keyById = new Map(permissions.map((row) => [row.id, row.key]));
  const grants = await db.rolePermission.findMany({ where: { roleId: { in: roles.map((role) => role.id) } }, select: { roleId: true, permissionId: true } });
  const keysByRole = new Map<string, Set<string>>();
  const rolesWithPlatformGrant = new Set<string>();
  for (const grant of grants) {
    const key = keyById.get(grant.permissionId);
    let set = keysByRole.get(grant.roleId);
    if (!set) {
      set = new Set<string>();
      keysByRole.set(grant.roleId, set);
    }
    if (key !== undefined) {
      set.add(key);
      if (isPlatformPermission(key)) rolesWithPlatformGrant.add(grant.roleId);
    }
  }
  const platformOrganizations = new Set(roles.filter((role) => rolesWithPlatformGrant.has(role.id)).map((role) => role.organizationId));
  return { roles: roles.filter((role) => role.organizationId === organizationId), keysByRole, platformOrganizations };
}

async function loadPropertyReports(db: RbacDb, organizationId: string, plan: ReseedPlan, allOrgRoles: readonly RoleRow[]): Promise<PropertyReport[]> {
  const properties = await db.property.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  if (properties.length === 0) return [];
  const assignments = await db.userPropertyRole.findMany({
    where: { propertyId: { in: properties.map((property) => property.id) } },
    select: { propertyId: true, roleId: true, userId: true }
  });
  const templateByRole = new Map<string, RoleKey>();
  for (const template of plan.templates) if (template.roleId && template.action !== "conflict") templateByRole.set(template.roleId, template.templateKey);
  for (const role of allOrgRoles) {
    if (!templateByRole.has(role.id) && role.templateKey && isRoleTemplateKey(role.templateKey)) templateByRole.set(role.id, role.templateKey);
  }
  return properties.map((property) => {
    const counts: Record<string, number> = {};
    for (const key of plan.templates.map((template) => template.templateKey)) counts[key] = 0;
    const customUsers = new Set<string>();
    for (const assignment of assignments) {
      if (assignment.propertyId !== property.id) continue;
      const templateKey = templateByRole.get(assignment.roleId);
      if (templateKey) counts[templateKey] = (counts[templateKey] ?? 0) + 1;
      else customUsers.add(assignment.userId);
    }
    return { propertyId: property.id, propertyName: property.name, assignments: counts, usersOnCustomRoles: customUsers.size };
  });
}

export async function runReseed(flags: ReseedFlags, db: RbacDb = prisma, auditChain: AuditChainCli = defaultAuditChainCli): Promise<ReseedResult> {
  // Integrador 8a: createRoleFromTemplate audita ROLE_CREATED_FROM_TEMPLATE por
  // cola; hidratar la cadena antes de --apply y vaciar la cola antes de devolver.
  return withAuditChain(auditChain, flags.apply, () => executeReseed(flags, db));
}

async function executeReseed(flags: ReseedFlags, db: RbacDb): Promise<ReseedResult> {
  const startedAt = Date.now();
  assertConfirmMatches(flags);
  const organizationId = flags.org!;
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  if (!organization) throw new Error(`Organización "${organizationId}" no existe. Nada escrito.`);

  const loaded = await loadOrganisationRoles(db, organizationId);
  const plan = planTemplateRoles({
    organizationId,
    templates: flags.templates,
    roles: loaded.roles,
    keysByRole: loaded.keysByRole,
    platformOrganizations: loaded.platformOrganizations
  });
  const properties = await loadPropertyReports(db, organizationId, plan, loaded.roles);

  if (!flags.apply) {
    return { mode: "dry-run", plan, properties, durationMs: Date.now() - startedAt };
  }
  if (planHasConflicts(plan)) {
    throw new Error("El plan tiene conflictos: resuélvelos (renombra o adopta el rol) antes de --apply. Nada escrito.");
  }

  const client = db as { $transaction?: (fn: (tx: RbacDb) => Promise<void>) => Promise<void> };
  const work = async (tx: RbacDb): Promise<void> => {
    for (const template of plan.templates) {
      if (template.action === "create") {
        // createRoleFromTemplate stamps level / department / templateVersion / managed (Tanda 8a).
        await createRoleFromTemplate(
          { organizationId, name: template.roleName, templateKey: template.templateKey, actorUserId: null },
          { db: tx }
        );
      } else if (template.action === "top-up" || template.action === "adopt") {
        await applyRoleTemplate(template.roleId!, template.templateKey, { db: tx });
        // Rows that predate Tanda 8a carry no level / department: fill them —
        // never the version (that is `rbac:sync --upgrade-templates`, with the
        // revocations) nor `managed` (a hand-edited role stays custom).
        const metadata = templateRoleMetadata(template.templateKey);
        await tx.role.updateMany({ where: { id: template.roleId!, level: null }, data: { level: metadata.level } });
        await tx.role.updateMany({ where: { id: template.roleId!, department: null }, data: { department: metadata.department } });
      }
    }
  };
  if (typeof client.$transaction === "function") await client.$transaction(work);
  else await work(db);

  // Post-condition: every requested template is followed by a role holding
  // at least the template (custom extras are allowed, never removed).
  const reloaded = await loadOrganisationRoles(db, organizationId);
  const after: NonNullable<ReseedResult["after"]> = [];
  for (const template of plan.templates) {
    const size = templatePermissionKeys(template.templateKey).length;
    const role = reloaded.roles.find((row) => (template.roleId ? row.id === template.roleId : row.name === template.roleName && row.templateKey === template.templateKey));
    if (!role) throw new Error(`Post-condición: no existe el rol de la plantilla "${template.templateKey}" tras aplicar.`);
    const held = reloaded.keysByRole.get(role.id) ?? new Set<string>();
    const missing = templatePermissionKeys(template.templateKey).filter((key) => !held.has(key));
    if (role.templateKey !== template.templateKey || missing.length > 0) {
      throw new Error(`Post-condición: «${role.name}» sigue sin ${missing.length} clave(s) de "${template.templateKey}" (template_key=${role.templateKey ?? "null"}).`);
    }
    after.push({ templateKey: template.templateKey, roleId: role.id, roleName: role.name, permissions: held.size, templateSize: size });
  }
  const propertiesAfter = await loadPropertyReports(db, organizationId, plan, reloaded.roles);
  return { mode: "apply", plan, properties: propertiesAfter, after, durationMs: Date.now() - startedAt };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolvePath(entry) === fileURLToPath(import.meta.url);
}

async function main(): Promise<number> {
  let flags: ReseedFlags;
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
    const result = await runReseed(flags);
    if (flags.json) {
      console.log(JSON.stringify({ ...result, templateKeys: ROLE_TEMPLATE_KEYS }, null, 2));
    } else {
      console.log(summarizePlan(result.plan, result.properties, result.mode));
      if (result.after) {
        console.log("");
        console.log("Tras aplicar:");
        for (const row of result.after) console.log(`  - ${row.templateKey.padEnd(14)} ${row.roleName} (${row.roleId}): ${row.permissions} permisos (plantilla ${row.templateSize})`);
      }
      console.log("");
      console.log(`${result.mode === "apply" ? "Aplicado" : "Plan"} en ${result.durationMs} ms.`);
    }
    return result.mode === "dry-run" && planHasConflicts(result.plan) ? 1 : 0;
  } catch (error) {
    console.error(`[reseed-property-roles] ${error instanceof Error ? error.message : String(error)}`);
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
