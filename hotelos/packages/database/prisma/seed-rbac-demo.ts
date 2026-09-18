// Demo users per role for Faranda (Tanda 8a · RBAC por departamento · L5;
// docs/design/RBAC-DEPARTAMENTOS.md §8.1). Seeds, for ONE real organisation
// (Faranda Hotels & Resorts / CELUISMA S.A.), everything the per-template smoke
// (scripts/check-role-smoke.mjs) needs to log in as each template and prove
// that its menu opens without a 403 and that the routes outside its scope
// answer 403/404:
//
//   · the 22 organisation templates of ORGANIZATION_TEMPLATE_ROLE_KEYS plus
//     «Administración de sistema» (admin, token `sistemas`) and the
//     «Emergencia» role (break_glass, §4.8), created when missing with their
//     level / department / templateVersion / managed metadata and the keys of
//     ROLE_PERMISSION_MAP; an existing template role is only TOPPED UP
//     (additive, like the boot backfill) and gets level / department when
//     null — revocations and templateVersion are rbac:sync --upgrade-templates
//     (L3), never this seed;
//   · two property groups (§4.1 / D5): galicia = Los Tilos + Rías Altas,
//     asturias-cantabria = Pathos Gijón + Marsol Candás + Alisas Santander;
//   · the default thresholds of §4.7 (DEFAULT_THRESHOLDS) in role_thresholds,
//     only when the organisation has no organisation-level rows yet;
//   · 30 fictitious users @faranda.test (28 people + 2 emergency accounts),
//     idempotent by email: status active, mustChangePassword true, mfaEnabled
//     for rank ≥ 2 (ROLE_LEVEL_RANK), ONE demo password (DEMO_PASSWORD,
//     overridable with RBAC_DEMO_PASSWORD; printed at the end); the emergency
//     accounts have status "emergency", no usable password and no fixed
//     assignment (the break-glass service assigns the role per session);
//   · one user_role_assignments row per person with the REAL scope (property /
//     property_group / legal_entity / organization) and, for the property
//     scope only, the mirror row in user_property_roles (dual-read until L6);
//     every created assignment is audited as ROLE_ASSIGNED (actorType system,
//     correlationId rbac_demo_seed_<run>) and organizations.rbac_version is
//     bumped once so live sessions reload their scope.
//
// Existing users are NEVER touched: recepcion.tilos@faranda.test (Recepción de
// Los Tilos) and Carmen (Owner) keep their rows and assignments (the backfill
// of their scope is rbac:migrate-assignments, L3).
//
// Guarded by assertDemoTarget (Tanda 4 · DATA-05): Faranda is outside the demo
// allowlist, so writing requires SEED_ALLOW_REAL=1 and
// SEED_CONFIRM=cmrhw9jy30002fyvb6tsdiugt. `--dry-run` prints the plan
// (reads only) and exits 0 without the guard, without writing anything.
//
// Run (from packages/database; tsx is not resolvable from the repo root):
//   node --env-file=../../.env --import tsx prisma/seed-rbac-demo.ts --dry-run
//   SEED_ALLOW_REAL=1 SEED_CONFIRM=cmrhw9jy30002fyvb6tsdiugt \
//     node --env-file=../../.env --import tsx prisma/seed-rbac-demo.ts
//   corepack pnpm --filter @hotelos/database db:seed:rbac-demo -- --dry-run
//
// The shared catalog is imported by relative path: packages/database has no
// dependency on @hotelos/shared and the package only resolves through the
// tsconfig paths, which tsx does not apply when the cwd has no tsconfig.
// This module never imports from apps/api (contract
// tests/rbac-demo-seed-contract.test.mjs).
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { assertDemoTarget, type PlannedWrite } from "./lib/demo-guard.js";
import { hashPassword } from "../src/password.js";
import {
  DEFAULT_THRESHOLDS,
  ORGANIZATION_TEMPLATE_ROLE_KEYS,
  ORG_PERMISSION_KEYS,
  PERMISSIONS,
  ROLE_LEVEL_RANK,
  ROLE_PERMISSION_MAP,
  ROLE_TEMPLATE_DEPARTMENT_ES,
  ROLE_TEMPLATE_LABELS_ES,
  ROLE_TEMPLATE_LEVEL,
  ROLE_TEMPLATE_VERSION,
  THRESHOLD_ACTIONS,
  type PermissionKey,
  type RoleKey,
  type ScopeType,
  type ThresholdAction
} from "../../shared/src/index.js";

// ---------------------------------------------------------------------------
// Fixed targets (Faranda, local demo DB; ids verified by SQL on 2026-09-18)
// ---------------------------------------------------------------------------

/** Faranda Hotels & Resorts (organisation outside the demo allowlist). */
export const ORG_ID = "cmrhw9jy30002fyvb6tsdiugt";
/** CELUISMA S.A. (the only legal entity of the organisation). */
export const LEGAL_ENTITY_ID = "le_5a1bd74b";
/** Work centres referenced by the demo users (code → property id). */
export const FARANDA_PROPERTIES = {
  LT: "cmu1mifcp0000fyo1wzvq7txo",
  RA: "cmrhw9jy40003fyvbuu2ec2w7",
  PG: "cmu4805uo000afyvlr44ufp8r",
  MC: "cmu4805w0002afyvl6kb1wtbf",
  AS: "cmu4805xd0053fyvl5z7swn6y",
  OC: "cmu4805tm0001fyvlwatrruq2"
} as const;
export type FarandaPropertyCode = keyof typeof FARANDA_PROPERTIES;

/** Property groups (§4.1, decision D5): code → members. */
export const PROPERTY_GROUPS: ReadonlyArray<{ code: string; name: string; members: readonly FarandaPropertyCode[] }> = [
  { code: "galicia", name: "Galicia", members: ["LT", "RA"] },
  { code: "asturias-cantabria", name: "Asturias-Cantabria", members: ["PG", "MC", "AS"] }
];

/** Every demo mailbox lives here: fictitious addresses, never a real person. */
export const EMAIL_DOMAIN = "faranda.test";
/** Prefix of the two emergency accounts (matches BREAK_GLASS_ACCOUNT_PREFIXES of the API). */
export const EMERGENCY_LOCAL_PREFIX = "emergencia-";
/** Environment variable that overrides the demo password. */
export const PASSWORD_ENV_VAR = "RBAC_DEMO_PASSWORD";
/** Single demo password (policy: ≥ 8, upper case, digit, special). Documented in the audit report, never mailed. */
export const DEMO_PASSWORD = "Faranda-Demo-2026!";
export const CORRELATION_PREFIX = "rbac_demo_seed_";
export const SEED_REASON = "seed rbac demo 2026-09-18";

// ---------------------------------------------------------------------------
// Users (§8.1): 28 people + 2 emergency accounts = 30
// ---------------------------------------------------------------------------

export type DemoScope =
  | { scopeType: "property"; property: FarandaPropertyCode }
  | { scopeType: "property_group"; groupCode: string }
  | { scopeType: "legal_entity" }
  | { scopeType: "organization" };

export type RbacDemoPerson = {
  /** Mailbox local part (`<local>@faranda.test`). */
  local: string;
  fullName: string;
  templateKey: RoleKey;
  scope: DemoScope;
  emergency?: false;
};

export type RbacDemoEmergencyAccount = {
  local: string;
  fullName: string;
  emergency: true;
};

export type RbacDemoUser = RbacDemoPerson | RbacDemoEmergencyAccount;

const property = (code: FarandaPropertyCode): DemoScope => ({ scopeType: "property", property: code });
const group = (groupCode: string): DemoScope => ({ scopeType: "property_group", groupCode });
const legalEntity: DemoScope = { scopeType: "legal_entity" };
const organization: DemoScope = { scopeType: "organization" };

export const RBAC_DEMO_USERS: readonly RbacDemoUser[] = [
  { local: "recepcion.pathos", fullName: "Noelia Castro Vilar", templateKey: "receptionist", scope: property("PG") },
  { local: "recepcion.rias", fullName: "Iago Ferreiro Souto", templateKey: "receptionist", scope: property("RA") },
  { local: "auditoria.noche.tilos", fullName: "Brais Otero Lema", templateKey: "night_auditor", scope: property("LT") },
  { local: "jefatura.recepcion.tilos", fullName: "Uxía Pardo Rial", templateKey: "front_office_manager", scope: property("LT") },
  { local: "jefatura.recepcion.rias", fullName: "Antía Seoane Varela", templateKey: "front_office_manager", scope: property("RA") },
  { local: "pisos.tilos", fullName: "Rosalía Míguez Castiñeira", templateKey: "housekeeper", scope: property("LT") },
  { local: "gobernanta.tilos", fullName: "Dolores Amado Piñeiro", templateKey: "housekeeping_manager", scope: property("LT") },
  { local: "mantenimiento.rias", fullName: "Xoán Barreiro Nogueira", templateKey: "maintenance", scope: property("RA") },
  { local: "encargado.mantenimiento.rias", fullName: "Ramiro Lestón Baña", templateKey: "maintenance_manager", scope: property("RA") },
  { local: "tpv.pathos", fullName: "Covadonga Suárez Menéndez", templateKey: "fnb", scope: property("PG") },
  { local: "jefatura.ab.pathos", fullName: "Pelayo Fernández Cueto", templateKey: "fnb_manager", scope: property("PG") },
  { local: "comercial.galicia", fullName: "Sabela Rey Docampo", templateKey: "sales", scope: group("galicia") },
  { local: "administracion.tilos", fullName: "Marcos Quintela Ares", templateKey: "admin_clerk", scope: property("LT") },
  { local: "administracion.central", fullName: "Nerea Villar Cobas", templateKey: "admin_clerk", scope: property("OC") },
  { local: "direccion.tilos", fullName: "Alfonso Trigo Salgado", templateKey: "manager", scope: property("LT") },
  { local: "direccion.rias", fullName: "Iria Montes Carballo", templateKey: "manager", scope: property("RA") },
  { local: "direccion.pathos", fullName: "Jaime Argüelles Prieto", templateKey: "manager", scope: property("PG") },
  { local: "operaciones.galicia", fullName: "Lucía Novo Freire", templateKey: "operations_director", scope: group("galicia") },
  { local: "operaciones.norte", fullName: "Gonzalo Riesgo Lavandera", templateKey: "operations_director", scope: group("asturias-cantabria") },
  { local: "revenue", fullName: "Aitana Ledo Brey", templateKey: "revenue", scope: organization },
  { local: "contabilidad", fullName: "Manuel Vidal Espiño", templateKey: "accountant", scope: legalEntity },
  { local: "direccion.financiera", fullName: "Clara Bouza Insua", templateKey: "controller", scope: legalEntity },
  { local: "rrhh", fullName: "Paula Cendán Rubido", templateKey: "payroll_hr", scope: legalEntity },
  { local: "cumplimiento", fullName: "Tomás Lago Vieites", templateKey: "compliance", scope: legalEntity },
  { local: "activos", fullName: "Helena Pazos Turnes", templateKey: "asset_manager", scope: legalEntity },
  { local: "direccion.general", fullName: "Andrés Camba Requeijo", templateKey: "general_manager", scope: organization },
  { local: "auditoria.interna", fullName: "Beatriz Loureiro Ameijeiras", templateKey: "auditor", scope: organization },
  { local: "sistemas", fullName: "Diego Soto Ínsua", templateKey: "admin", scope: organization },
  { local: `${EMERGENCY_LOCAL_PREFIX}1`, fullName: "Cuenta de emergencia 1", emergency: true },
  { local: `${EMERGENCY_LOCAL_PREFIX}2`, fullName: "Cuenta de emergencia 2", emergency: true }
];

export function emailOf(user: Pick<RbacDemoUser, "local">): string {
  return `${user.local}@${EMAIL_DOMAIN}`;
}

export function isEmergencyAccount(user: RbacDemoUser): user is RbacDemoEmergencyAccount {
  return user.emergency === true;
}

/** Rank of the template level (ROLE_LEVEL_RANK); MFA is mandatory from rank 2 (supervisor) upwards (decision D8). */
export function requiresMfa(user: RbacDemoUser): boolean {
  if (isEmergencyAccount(user)) return true;
  return ROLE_LEVEL_RANK[ROLE_TEMPLATE_LEVEL[user.templateKey]] >= 2;
}

/** Same rules as validatePasswordPolicy of the API (auth-pilot.service.ts): fail early, never seed an unusable password. */
export function passwordPolicyErrors(plain: string): string[] {
  const errors: string[] = [];
  if (plain.length < 8) errors.push("mínimo 8 caracteres");
  if (!/[A-Z]/.test(plain)) errors.push("al menos una mayúscula");
  if (!/[0-9]/.test(plain)) errors.push("al menos un número");
  if (!/[^A-Za-z0-9]/.test(plain)) errors.push("al menos un carácter especial");
  return errors;
}

/** Demo password: RBAC_DEMO_PASSWORD when set (validated), else DEMO_PASSWORD. */
export function resolveDemoPassword(override: string | undefined = process.env.RBAC_DEMO_PASSWORD): string {
  const candidate = (override ?? "").trim().length > 0 ? (override as string).trim() : DEMO_PASSWORD;
  const errors = passwordPolicyErrors(candidate);
  if (errors.length > 0) throw new Error(`La contraseña de demo (${PASSWORD_ENV_VAR}) no cumple la política: ${errors.join(", ")}.`);
  return candidate;
}

/** Templates this seed provisions: the 22 organisation templates + admin (token `sistemas`) + break_glass («Emergencia»). */
export const SEEDED_TEMPLATES: readonly RoleKey[] = [...ORGANIZATION_TEMPLATE_ROLE_KEYS, "admin", "break_glass"];

function templateKeys(templateKey: RoleKey): PermissionKey[] {
  const keys = templateKey === "break_glass" ? [...ORG_PERMISSION_KEYS] : ROLE_PERMISSION_MAP[templateKey];
  return [...new Set(keys)];
}

// ---------------------------------------------------------------------------
// Static self-checks (the user table is data: verify it before touching the DB)
// ---------------------------------------------------------------------------

export function validateDemoUsers(users: readonly RbacDemoUser[] = RBAC_DEMO_USERS): void {
  const seen = new Set<string>();
  for (const user of users) {
    if (!/^[a-z0-9.-]+$/.test(user.local)) throw new Error(`Local part inválida: ${user.local}`);
    if (seen.has(user.local)) throw new Error(`Usuario duplicado: ${user.local}`);
    seen.add(user.local);
    if (isEmergencyAccount(user)) {
      if (!user.local.startsWith(EMERGENCY_LOCAL_PREFIX)) throw new Error(`Cuenta de emergencia sin prefijo ${EMERGENCY_LOCAL_PREFIX}: ${user.local}`);
      continue;
    }
    if (user.local.startsWith(EMERGENCY_LOCAL_PREFIX)) throw new Error(`Una persona no puede usar el prefijo de emergencia: ${user.local}`);
    if (user.templateKey === "break_glass") throw new Error(`La plantilla de emergencia nunca se asigna a una persona: ${user.local}`);
    if (!SEEDED_TEMPLATES.includes(user.templateKey)) throw new Error(`Plantilla desconocida para ${user.local}: ${user.templateKey}`);
    const scope = user.scope;
    if (scope.scopeType === "property_group" && !PROPERTY_GROUPS.some((g) => g.code === scope.groupCode)) {
      throw new Error(`Grupo desconocido para ${user.local}: ${scope.groupCode}`);
    }
  }
  const emergency = users.filter(isEmergencyAccount).length;
  if (emergency !== 2) throw new Error(`Se esperaban 2 cuentas de emergencia, hay ${emergency}.`);
  if (users.length !== 30) throw new Error(`Se esperaban 30 usuarios (28 + 2 emergencia), hay ${users.length}.`);
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type SeedFlags = { dryRun: boolean; json: boolean; help: boolean };

export const USAGE = [
  "Uso (desde packages/database):",
  "  node --env-file=../../.env --import tsx prisma/seed-rbac-demo.ts [--dry-run] [--json] [--help]",
  "",
  "  --dry-run   imprime el plan (solo lecturas) y termina sin escribir; no exige SEED_ALLOW_REAL",
  "  --json      salida máquina del plan / resultado",
  "  --help, -h  esta ayuda",
  "",
  `Escribir exige SEED_ALLOW_REAL=1 y SEED_CONFIRM=${ORG_ID} (guard demo, Tanda 4 · DATA-05).`,
  `Contraseña de demo: ${PASSWORD_ENV_VAR} (por defecto la del seed; misma política que el API).`
].join("\n");

export function parseFlags(argv: readonly string[]): SeedFlags {
  const flags: SeedFlags = { dryRun: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`Flag desconocida "${arg}". Conocidas: --dry-run, --json, --help.`);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

type RoleRow = { id: string; name: string; templateKey: string | null; level: string | null; department: string | null };

type TemplatePlan = {
  templateKey: RoleKey;
  name: string;
  action: "create" | "top-up" | "conflict";
  roleId: string | null;
  /** Keys of the template the role lacks (all of them for a new role). */
  missingKeys: number;
  fillLevel: boolean;
  fillDepartment: boolean;
  note?: string;
};

type GroupPlan = { code: string; name: string; groupId: string | null; action: "create" | "exists"; members: string[]; missingMembers: string[] };

type UserPlan = {
  email: string;
  fullName: string;
  emergency: boolean;
  templateKey: RoleKey | null;
  userId: string | null;
  action: "create" | "update";
  mfaEnabled: boolean;
};

type AssignmentPlan = {
  email: string;
  templateKey: RoleKey;
  roleName: string;
  roleId: string | null;
  scopeType: ScopeType;
  propertyId: string | null;
  propertyGroupId: string | null;
  groupCode: string | null;
  legalEntityId: string | null;
  refLabel: string;
  action: "create" | "exists";
  existingAssignmentId: string | null;
  /** Property scope only: user_property_roles mirror row status. */
  legacyMirror: "create" | "exists" | null;
};

export type SeedPlan = {
  organizationId: string;
  organizationName: string;
  templates: TemplatePlan[];
  groups: GroupPlan[];
  thresholds: { action: "create" | "exists"; rows: number; existingRows: number };
  users: UserPlan[];
  assignments: AssignmentPlan[];
  counts: {
    templatesToCreate: number;
    templatesToTopUp: number;
    templateConflicts: number;
    groupsToCreate: number;
    thresholdRows: number;
    users: number;
    usersToCreate: number;
    usersToUpdate: number;
    emergencyAccounts: number;
    assignments: number;
    assignmentsToCreate: number;
    legacyMirrorRows: number;
    legacyMirrorToCreate: number;
    byScope: Record<ScopeType, number>;
  };
};

function thresholdRows(organizationId: string) {
  const tiers = ["T1", "T2", "T3", "T4"] as const;
  const rows: Array<{
    organizationId: string;
    roleId: null;
    level: null;
    action: ThresholdAction;
    tier: string;
    maxAmount: string | null;
    maxPct: string | null;
    currency: string;
    requiresSecondApproval: boolean;
  }> = [];
  for (const action of THRESHOLD_ACTIONS) {
    for (const tier of tiers) {
      rows.push({ organizationId, roleId: null, level: null, action, tier, maxAmount: DEFAULT_THRESHOLDS[tier].toFixed(2), maxPct: null, currency: DEFAULT_THRESHOLDS.currency, requiresSecondApproval: false });
    }
  }
  rows.push({
    organizationId,
    roleId: null,
    level: null,
    action: DEFAULT_THRESHOLDS.secondApprovalAction,
    tier: "ABOVE_T4",
    maxAmount: DEFAULT_THRESHOLDS.secondApprovalAmount.toFixed(2),
    maxPct: null,
    currency: DEFAULT_THRESHOLDS.currency,
    requiresSecondApproval: true
  });
  // Percentage limits share the (action, tier) row of the amount (same shape as PUT /rbac/thresholds).
  const pct: Array<[ThresholdAction, string, number]> = [
    ["discount", "T1", DEFAULT_THRESHOLDS.discountPctT1],
    ["discount", "T2", DEFAULT_THRESHOLDS.discountPctT2],
    ["rate_change", "T1", DEFAULT_THRESHOLDS.rateBandPct]
  ];
  for (const [action, tier, value] of pct) {
    const row = rows.find((candidate) => candidate.action === action && candidate.tier === tier);
    if (row) row.maxPct = value.toFixed(2);
  }
  return rows;
}

async function findTemplateRole(db: Db, organizationId: string, templateKey: RoleKey): Promise<RoleRow | null> {
  const select = { id: true, name: true, templateKey: true, level: true, department: true } as const;
  const stamped = await db.role.findFirst({ where: { organizationId, templateKey }, orderBy: { id: "asc" }, select });
  if (stamped) return stamped;
  return db.role.findUnique({ where: { organizationId_name: { organizationId, name: ROLE_TEMPLATE_LABELS_ES[templateKey] } }, select });
}

export async function buildPlan(db: PrismaClient, users: readonly RbacDemoUser[] = RBAC_DEMO_USERS): Promise<SeedPlan> {
  validateDemoUsers(users);
  const organizationRow = await db.organization.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } });
  if (!organizationRow) throw new Error(`La organización ${ORG_ID} no existe en esta base de datos. Nada escrito.`);
  const legalEntityRow = await db.legalEntity.findFirst({ where: { id: LEGAL_ENTITY_ID, organizationId: ORG_ID }, select: { id: true } });
  if (!legalEntityRow) throw new Error(`La sociedad ${LEGAL_ENTITY_ID} no pertenece a ${ORG_ID}. Nada escrito.`);
  const propertyRows = await db.property.findMany({ where: { organizationId: ORG_ID, id: { in: Object.values(FARANDA_PROPERTIES) } }, select: { id: true, name: true, code: true } });
  const propertyById = new Map(propertyRows.map((row) => [row.id, row]));
  for (const [code, id] of Object.entries(FARANDA_PROPERTIES)) {
    if (!propertyById.has(id)) throw new Error(`El centro ${code} (${id}) no pertenece a ${ORG_ID}. Nada escrito.`);
  }

  // Templates
  const templates: TemplatePlan[] = [];
  const roleIdByTemplate = new Map<RoleKey, string | null>();
  const permissionRows = await db.permission.findMany({ select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  for (const templateKey of SEEDED_TEMPLATES) {
    const name = ROLE_TEMPLATE_LABELS_ES[templateKey];
    const keys = templateKeys(templateKey);
    const existing = await findTemplateRole(db, ORG_ID, templateKey);
    if (existing && existing.templateKey !== null && existing.templateKey !== templateKey) {
      templates.push({ templateKey, name, action: "conflict", roleId: existing.id, missingKeys: 0, fillLevel: false, fillDepartment: false, note: `«${existing.name}» sigue la plantilla "${existing.templateKey}"` });
      roleIdByTemplate.set(templateKey, null);
      continue;
    }
    if (!existing) {
      templates.push({ templateKey, name, action: "create", roleId: null, missingKeys: keys.length, fillLevel: true, fillDepartment: true });
      roleIdByTemplate.set(templateKey, null);
      continue;
    }
    const granted = new Set((await db.rolePermission.findMany({ where: { roleId: existing.id }, select: { permissionId: true } })).map((row) => row.permissionId));
    const missing = keys.filter((key) => {
      const id = permissionIdByKey.get(key);
      return id === undefined || !granted.has(id);
    });
    templates.push({ templateKey, name: existing.name, action: "top-up", roleId: existing.id, missingKeys: missing.length, fillLevel: existing.level === null, fillDepartment: existing.department === null });
    roleIdByTemplate.set(templateKey, existing.id);
  }

  // Groups
  const groups: GroupPlan[] = [];
  const groupIdByCode = new Map<string, string | null>();
  for (const spec of PROPERTY_GROUPS) {
    const members = spec.members.map((code) => FARANDA_PROPERTIES[code]);
    const existing = await db.propertyGroup.findUnique({ where: { organizationId_code: { organizationId: ORG_ID, code: spec.code } }, select: { id: true } });
    if (!existing) {
      groups.push({ code: spec.code, name: spec.name, groupId: null, action: "create", members, missingMembers: members });
      groupIdByCode.set(spec.code, null);
      continue;
    }
    const present = new Set((await db.propertyGroupMember.findMany({ where: { propertyGroupId: existing.id }, select: { propertyId: true } })).map((row) => row.propertyId));
    groups.push({ code: spec.code, name: spec.name, groupId: existing.id, action: "exists", members, missingMembers: members.filter((id) => !present.has(id)) });
    groupIdByCode.set(spec.code, existing.id);
  }

  // Thresholds
  const existingThresholds = await db.roleThreshold.count({ where: { organizationId: ORG_ID, roleId: null, level: null } });
  const thresholds = existingThresholds > 0 ? { action: "exists" as const, rows: 0, existingRows: existingThresholds } : { action: "create" as const, rows: thresholdRows(ORG_ID).length, existingRows: 0 };

  // Users
  const emails = users.map((user) => emailOf(user));
  const userRows = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true, organizationId: true } });
  const userByEmail = new Map(userRows.map((row) => [row.email, row]));
  for (const row of userRows) {
    if (row.organizationId !== ORG_ID) throw new Error(`${row.email} ya existe en otra organización (${row.organizationId}). Nada escrito.`);
  }
  const userPlans: UserPlan[] = users.map((user) => {
    const existing = userByEmail.get(emailOf(user)) ?? null;
    return {
      email: emailOf(user),
      fullName: user.fullName,
      emergency: isEmergencyAccount(user),
      templateKey: isEmergencyAccount(user) ? null : user.templateKey,
      userId: existing?.id ?? null,
      action: existing ? "update" : "create",
      mfaEnabled: requiresMfa(user)
    };
  });

  // Assignments (people only)
  const now = new Date();
  const assignments: AssignmentPlan[] = [];
  for (const user of users) {
    if (isEmergencyAccount(user)) continue;
    const roleId = roleIdByTemplate.get(user.templateKey) ?? null;
    const userId = userByEmail.get(emailOf(user))?.id ?? null;
    const scope = user.scope;
    let propertyId: string | null = null;
    let propertyGroupId: string | null = null;
    let groupCode: string | null = null;
    let legalEntityId: string | null = null;
    let refLabel = "";
    switch (scope.scopeType) {
      case "property":
        propertyId = FARANDA_PROPERTIES[scope.property];
        refLabel = `${scope.property} · ${propertyById.get(propertyId)?.name ?? propertyId}`;
        break;
      case "property_group":
        groupCode = scope.groupCode;
        propertyGroupId = groupIdByCode.get(scope.groupCode) ?? null;
        refLabel = `grupo ${scope.groupCode}`;
        break;
      case "legal_entity":
        legalEntityId = LEGAL_ENTITY_ID;
        refLabel = `sociedad ${LEGAL_ENTITY_ID}`;
        break;
      case "organization":
        refLabel = "toda la organización";
        break;
    }
    let existingAssignmentId: string | null = null;
    if (roleId && userId) {
      const live = await db.userRoleAssignment.findFirst({
        where: {
          userId,
          roleId,
          organizationId: ORG_ID,
          scopeType: scope.scopeType,
          propertyId,
          propertyGroupId,
          legalEntityId,
          revokedAt: null,
          OR: [{ validTo: null }, { validTo: { gt: now } }]
        },
        select: { id: true }
      });
      existingAssignmentId = live?.id ?? null;
    }
    let legacyMirror: AssignmentPlan["legacyMirror"] = null;
    if (scope.scopeType === "property" && propertyId) {
      const mirror = roleId && userId ? await db.userPropertyRole.findFirst({ where: { userId, propertyId, roleId }, select: { id: true } }) : null;
      legacyMirror = mirror ? "exists" : "create";
    }
    assignments.push({
      email: emailOf(user),
      templateKey: user.templateKey,
      roleName: ROLE_TEMPLATE_LABELS_ES[user.templateKey],
      roleId,
      scopeType: scope.scopeType,
      propertyId,
      propertyGroupId,
      groupCode,
      legalEntityId,
      refLabel,
      action: existingAssignmentId ? "exists" : "create",
      existingAssignmentId,
      legacyMirror
    });
  }

  const byScope: Record<ScopeType, number> = { property: 0, property_group: 0, legal_entity: 0, organization: 0 };
  for (const row of assignments) byScope[row.scopeType] += 1;
  return {
    organizationId: ORG_ID,
    organizationName: organizationRow.name,
    templates,
    groups,
    thresholds,
    users: userPlans,
    assignments,
    counts: {
      templatesToCreate: templates.filter((row) => row.action === "create").length,
      templatesToTopUp: templates.filter((row) => row.action === "top-up" && (row.missingKeys > 0 || row.fillLevel || row.fillDepartment)).length,
      templateConflicts: templates.filter((row) => row.action === "conflict").length,
      groupsToCreate: groups.filter((row) => row.action === "create").length,
      thresholdRows: thresholds.rows,
      users: userPlans.length,
      usersToCreate: userPlans.filter((row) => row.action === "create").length,
      usersToUpdate: userPlans.filter((row) => row.action === "update").length,
      emergencyAccounts: userPlans.filter((row) => row.emergency).length,
      assignments: assignments.length,
      assignmentsToCreate: assignments.filter((row) => row.action === "create").length,
      legacyMirrorRows: assignments.filter((row) => row.legacyMirror !== null).length,
      legacyMirrorToCreate: assignments.filter((row) => row.legacyMirror === "create").length,
      byScope
    }
  };
}

function plannedWrites(plan: SeedPlan): PlannedWrite[] {
  const writes: PlannedWrite[] = [
    { table: "roles", op: "create", count: plan.counts.templatesToCreate, where: "plantillas que faltan (+ role_permissions de cada una)" },
    { table: "role_permissions", op: "createMany", where: `top-up aditivo de ${plan.counts.templatesToTopUp} rol(es) existente(s); nunca revoca` },
    { table: "property_groups", op: "upsert", count: plan.groups.length, where: PROPERTY_GROUPS.map((g) => g.code).join(", ") },
    { table: "role_thresholds", op: "createMany", count: plan.counts.thresholdRows, where: plan.thresholds.action === "exists" ? "ya existen filas de organización: no se tocan" : "umbrales por defecto §4.7" },
    { table: "users", op: "upsert", count: plan.counts.users, where: `@${EMAIL_DOMAIN} (${plan.counts.usersToCreate} nuevos · ${plan.counts.usersToUpdate} existentes)` },
    { table: "user_role_assignments", op: "create", count: plan.counts.assignmentsToCreate, where: "una por persona, ámbito real" },
    { table: "user_property_roles", op: "create", count: plan.counts.legacyMirrorToCreate, where: "espejo dual-read (solo ámbito property)" },
    { table: "audit_events", op: "create", where: "ROLE_ASSIGNED / USER_CREATED (actorType system)" },
    { table: "organizations", op: "update", count: 1, where: "rbac_version + 1" }
  ];
  return writes;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type SeedResult = {
  mode: "dry-run" | "apply";
  runId: string;
  correlationId: string;
  plan: SeedPlan;
  created: { roles: number; grants: number; groups: number; groupMembers: number; thresholds: number; users: number; usersUpdated: number; assignments: number; legacyMirrors: number };
  audited: number;
  password: string;
  durationMs: number;
};

async function ensurePermissionIds(tx: Db, keys: PermissionKey[]): Promise<Map<string, string>> {
  let rows = await tx.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
  const known = new Set(rows.map((row) => row.key));
  const missing = keys.filter((key) => !known.has(key));
  if (missing.length > 0) {
    await tx.permission.createMany({ data: missing.map((key) => ({ key, description: PERMISSIONS[key] })), skipDuplicates: true });
    rows = await tx.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
  }
  return new Map(rows.map((row) => [row.key, row.id]));
}

async function grantTemplate(tx: Db, roleId: string, templateKey: RoleKey): Promise<number> {
  const keys = templateKeys(templateKey);
  const idByKey = await ensurePermissionIds(tx, keys);
  const granted = new Set((await tx.rolePermission.findMany({ where: { roleId }, select: { permissionId: true } })).map((row) => row.permissionId));
  const toGrant = keys.map((key) => idByKey.get(key)).filter((id): id is string => id !== undefined && !granted.has(id));
  if (toGrant.length === 0) return 0;
  const result = await tx.rolePermission.createMany({ data: toGrant.map((permissionId) => ({ roleId, permissionId })), skipDuplicates: true });
  return result.count;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

type AuditInput = {
  organizationId: string;
  propertyId: string | null;
  actorType: "system";
  action: string;
  entityType: string;
  entityId: string;
  afterJson: Prisma.InputJsonValue;
  correlationId: string;
};

/**
 * Append audit rows to the GLOBAL hash chain of audit_events: each row links to
 * the current tip of the table and seals its own contents (sha256 over the
 * stable JSON of the record plus previousHash, like audit.service.ts). The API
 * keeps an in-memory tip per process (deuda 12(c)): restart the API after the
 * seed so it re-hydrates from Postgres.
 */
async function appendAuditEvents(db: PrismaClient, events: AuditInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const tip = await db.auditEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { currentHash: true } });
  let previousHash: string | null = tip?.currentHash ?? null;
  let written = 0;
  for (const event of events) {
    const createdAt = new Date();
    const hashable = { ...event, createdAt: createdAt.toISOString(), hashAlgorithm: "sha256", previousHash };
    const currentHash = createHash("sha256").update(stableStringify(hashable)).digest("hex");
    await db.auditEvent.create({
      data: {
        organizationId: event.organizationId,
        propertyId: event.propertyId,
        actorUserId: null,
        actorType: event.actorType,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        afterJson: event.afterJson,
        correlationId: event.correlationId,
        hashAlgorithm: "sha256",
        previousHash,
        currentHash,
        createdAt
      }
    });
    previousHash = currentHash;
    written += 1;
  }
  return written;
}

export async function applyPlan(db: PrismaClient, plan: SeedPlan, password: string, users: readonly RbacDemoUser[] = RBAC_DEMO_USERS): Promise<Omit<SeedResult, "mode" | "durationMs" | "password">> {
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const correlationId = `${CORRELATION_PREFIX}${runId}`;
  if (plan.counts.templateConflicts > 0) {
    const names = plan.templates.filter((row) => row.action === "conflict").map((row) => `${row.templateKey} (${row.note})`);
    throw new Error(`Conflicto de plantillas: ${names.join("; ")}. Resuélvelo antes de sembrar. Nada escrito.`);
  }
  const created = { roles: 0, grants: 0, groups: 0, groupMembers: 0, thresholds: 0, users: 0, usersUpdated: 0, assignments: 0, legacyMirrors: 0 };
  const audit: AuditInput[] = [];
  const now = new Date();
  const passwordHash = hashPassword(password);
  const byLocal = new Map(users.map((user) => [user.local, user]));

  await db.$transaction(
    async (tx) => {
      // 1. Templates (create or additive top-up; metadata only when null).
      const roleIdByTemplate = new Map<RoleKey, string>();
      for (const row of plan.templates) {
        let roleId = row.roleId;
        if (row.action === "create") {
          const role = await tx.role.create({
            data: {
              organizationId: ORG_ID,
              name: row.name,
              templateKey: row.templateKey,
              level: ROLE_TEMPLATE_LEVEL[row.templateKey],
              department: ROLE_TEMPLATE_DEPARTMENT_ES[row.templateKey],
              templateVersion: ROLE_TEMPLATE_VERSION,
              managed: true
            },
            select: { id: true }
          });
          roleId = role.id;
          created.roles += 1;
        } else if (roleId) {
          if (row.fillLevel) await tx.role.updateMany({ where: { id: roleId, level: null }, data: { level: ROLE_TEMPLATE_LEVEL[row.templateKey] } });
          if (row.fillDepartment) await tx.role.updateMany({ where: { id: roleId, department: null }, data: { department: ROLE_TEMPLATE_DEPARTMENT_ES[row.templateKey] } });
        }
        if (!roleId) throw new Error(`Sin rol para la plantilla ${row.templateKey}.`);
        created.grants += await grantTemplate(tx, roleId, row.templateKey);
        roleIdByTemplate.set(row.templateKey, roleId);
      }

      // 2. Property groups + members.
      const groupIdByCode = new Map<string, string>();
      for (const spec of PROPERTY_GROUPS) {
        const row = await tx.propertyGroup.upsert({
          where: { organizationId_code: { organizationId: ORG_ID, code: spec.code } },
          create: { organizationId: ORG_ID, code: spec.code, name: spec.name },
          update: { name: spec.name },
          select: { id: true }
        });
        const planned = plan.groups.find((g) => g.code === spec.code);
        if (planned?.action === "create") created.groups += 1;
        const members = await tx.propertyGroupMember.createMany({
          data: spec.members.map((code) => ({ propertyGroupId: row.id, propertyId: FARANDA_PROPERTIES[code] })),
          skipDuplicates: true
        });
        created.groupMembers += members.count;
        groupIdByCode.set(spec.code, row.id);
      }

      // 3. Thresholds (only when the organisation has none).
      if (plan.thresholds.action === "create") {
        const result = await tx.roleThreshold.createMany({ data: thresholdRows(ORG_ID) });
        created.thresholds = result.count;
      }

      // 4. Users (idempotent by email; existing rows converge to the demo state).
      const userIdByEmail = new Map<string, string>();
      for (const row of plan.users) {
        const spec = byLocal.get(row.email.slice(0, -(EMAIL_DOMAIN.length + 1)));
        if (!spec) throw new Error(`Usuario sin especificación: ${row.email}`);
        const emergency = isEmergencyAccount(spec);
        const data = emergency
          ? { fullName: spec.fullName, status: "emergency", mfaEnabled: true, passwordHash: null, mustChangePassword: false, passwordChangedAt: null }
          : { fullName: spec.fullName, status: "active", mfaEnabled: requiresMfa(spec), passwordHash, mustChangePassword: true, passwordChangedAt: null, failedLoginAttempts: 0, lockedUntil: null };
        const user = await tx.user.upsert({
          where: { email: row.email },
          create: { organizationId: ORG_ID, email: row.email, ...data },
          update: data,
          select: { id: true }
        });
        userIdByEmail.set(row.email, user.id);
        if (row.action === "create") {
          created.users += 1;
          audit.push({
            organizationId: ORG_ID,
            propertyId: null,
            actorType: "system",
            action: "USER_CREATED",
            entityType: "user",
            entityId: user.id,
            afterJson: { email: row.email, status: emergency ? "emergency" : "active", mfaEnabled: requiresMfa(spec), mustChangePassword: !emergency, templateKey: emergency ? null : spec.templateKey, reason: SEED_REASON },
            correlationId
          });
        } else {
          created.usersUpdated += 1;
        }
      }

      // 5. Assignments (+ user_property_roles mirror for the property scope).
      for (const row of plan.assignments) {
        const userId = userIdByEmail.get(row.email);
        const roleId = roleIdByTemplate.get(row.templateKey);
        if (!userId || !roleId) throw new Error(`Asignación sin usuario o rol: ${row.email} / ${row.templateKey}`);
        const propertyGroupId = row.scopeType === "property_group" && row.groupCode ? (groupIdByCode.get(row.groupCode) ?? null) : null;
        if (row.scopeType === "property_group" && !propertyGroupId) throw new Error(`Grupo sin id: ${row.groupCode}`);
        const live = await tx.userRoleAssignment.findFirst({
          where: {
            userId,
            roleId,
            organizationId: ORG_ID,
            scopeType: row.scopeType,
            propertyId: row.propertyId,
            propertyGroupId,
            legalEntityId: row.legalEntityId,
            revokedAt: null,
            OR: [{ validTo: null }, { validTo: { gt: now } }]
          },
          select: { id: true }
        });
        if (!live) {
          const inserted = await tx.userRoleAssignment.create({
            data: {
              userId,
              roleId,
              scopeType: row.scopeType,
              propertyId: row.propertyId,
              propertyGroupId,
              legalEntityId: row.legalEntityId,
              organizationId: ORG_ID,
              validFrom: now,
              validTo: null,
              grantedByUserId: null,
              reason: SEED_REASON
            },
            select: { id: true }
          });
          created.assignments += 1;
          audit.push({
            organizationId: ORG_ID,
            propertyId: row.propertyId,
            actorType: "system",
            action: "ROLE_ASSIGNED",
            entityType: "user_role_assignment",
            entityId: inserted.id,
            afterJson: {
              userId,
              email: row.email,
              roleId,
              roleName: row.roleName,
              templateKey: row.templateKey,
              scopeType: row.scopeType,
              ref: row.propertyId ?? propertyGroupId ?? row.legalEntityId ?? ORG_ID,
              propertyId: row.propertyId,
              propertyGroupId,
              legalEntityId: row.legalEntityId,
              reason: SEED_REASON,
              origin: "seed-rbac-demo"
            },
            correlationId
          });
        }
        if (row.scopeType === "property" && row.propertyId) {
          // Dual-read mirror (user_property_roles) until the L6 cut: one row per property assignment.
          const mirror = await tx.userPropertyRole.findFirst({ where: { userId, propertyId: row.propertyId, roleId }, select: { id: true } });
          if (!mirror) {
            await tx.userPropertyRole.create({ data: { userId, propertyId: row.propertyId, roleId } });
            created.legacyMirrors += 1;
          }
        }
      }

      // 6. One version bump: live sessions reload their scope on the next request.
      await tx.organization.update({ where: { id: ORG_ID }, data: { rbacVersion: { increment: 1 } } });
    },
    { maxWait: 15_000, timeout: 180_000 }
  );

  // Audit after the commit (append-only chain, never inside the transaction).
  const audited = await appendAuditEvents(db, audit);
  return { runId, correlationId, plan, created, audited };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

export function formatPlan(plan: SeedPlan, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(`[seed:rbac-demo] ${plan.organizationName} (${plan.organizationId}) · ${dryRun ? "dry-run (solo lecturas, nada escrito)" : "plan"}`);
  lines.push("");
  lines.push(`Plantillas (${plan.templates.length} = 22 de organización + admin + Emergencia): ${plan.counts.templatesToCreate} a crear · ${plan.counts.templatesToTopUp} existentes con top-up aditivo · ${plan.counts.templateConflicts} en conflicto`);
  for (const row of plan.templates) {
    const detail =
      row.action === "create"
        ? `crear (${row.missingKeys} claves, nivel ${ROLE_TEMPLATE_LEVEL[row.templateKey]}, v${ROLE_TEMPLATE_VERSION})`
        : row.action === "conflict"
          ? `CONFLICTO: ${row.note}`
          : `existe (${row.roleId}) · +${row.missingKeys} claves${row.fillLevel ? " · nivel" : ""}${row.fillDepartment ? " · departamento" : ""}`;
    lines.push(`  ${pad(row.templateKey, 22)} ${pad(row.name, 28)} ${detail}`);
  }
  lines.push("");
  lines.push(`Grupos de propiedades (${plan.groups.length}): ${plan.counts.groupsToCreate} a crear`);
  for (const row of plan.groups) lines.push(`  ${pad(row.code, 22)} ${pad(row.name, 20)} ${row.action === "create" ? "crear" : `existe (${row.groupId})`} · miembros ${row.members.length} (${row.missingMembers.length} por añadir)`);
  lines.push("");
  lines.push(`Umbrales (role_thresholds): ${plan.thresholds.action === "create" ? `crear ${plan.thresholds.rows} filas por defecto (T1 ${DEFAULT_THRESHOLDS.T1} · T2 ${DEFAULT_THRESHOLDS.T2} · T3 ${DEFAULT_THRESHOLDS.T3} · T4 ${DEFAULT_THRESHOLDS.T4} · doble aprobación > ${DEFAULT_THRESHOLDS.secondApprovalAmount} ${DEFAULT_THRESHOLDS.currency})` : `ya hay ${plan.thresholds.existingRows} filas de organización: no se tocan`}`);
  lines.push("");
  lines.push(`Usuarios @${EMAIL_DOMAIN} (${plan.counts.users} = ${plan.counts.users - plan.counts.emergencyAccounts} personas + ${plan.counts.emergencyAccounts} emergencia): ${plan.counts.usersToCreate} a crear · ${plan.counts.usersToUpdate} existentes (convergen al estado de demo)`);
  lines.push(`  ${pad("Correo", 42)} ${pad("Nombre", 30)} ${pad("Plantilla", 22)} ${pad("2FA", 4)} Acción`);
  for (const row of plan.users) lines.push(`  ${pad(row.email, 42)} ${pad(row.fullName, 30)} ${pad(row.emergency ? "(emergencia, sin contraseña)" : row.templateKey ?? "", 22)} ${pad(row.mfaEnabled ? "sí" : "no", 4)} ${row.action === "create" ? "crear" : "actualizar"}`);
  lines.push("");
  const scopes = plan.counts.byScope;
  lines.push(`Asignaciones (user_role_assignments): ${plan.counts.assignments} (property ${scopes.property} · property_group ${scopes.property_group} · legal_entity ${scopes.legal_entity} · organization ${scopes.organization}) · ${plan.counts.assignmentsToCreate} a crear · espejo user_property_roles ${plan.counts.legacyMirrorRows} (${plan.counts.legacyMirrorToCreate} a crear) → ${plan.counts.assignments + plan.counts.legacyMirrorRows} filas en total`);
  lines.push(`  ${pad("Correo", 42)} ${pad("Plantilla", 22)} ${pad("Ámbito", 15)} ${pad("Referencia", 48)} Estado`);
  for (const row of plan.assignments) lines.push(`  ${pad(row.email, 42)} ${pad(row.templateKey, 22)} ${pad(row.scopeType, 15)} ${pad(row.refLabel, 48)} ${row.action === "create" ? "crear" : `ya existe (${row.existingAssignmentId})`}${row.legacyMirror ? ` · espejo ${row.legacyMirror === "create" ? "crear" : "existe"}` : ""}`);
  lines.push("");
  lines.push("No se tocan: recepcion.tilos (Recepción de Los Tilos) ni la propietaria (Owner): su backfill es rbac:migrate-assignments (L3).");
  return lines.join("\n");
}

export function formatResult(result: SeedResult): string {
  const lines: string[] = [];
  if (result.mode === "apply") {
    const c = result.created;
    lines.push("");
    lines.push(`[seed:rbac-demo] APLICADO · correlación ${result.correlationId}`);
    lines.push(`  roles creados ${c.roles} · role_permissions añadidas ${c.grants} · grupos creados ${c.groups} (miembros añadidos ${c.groupMembers}) · umbrales creados ${c.thresholds}`);
    lines.push(`  usuarios creados ${c.users} · actualizados ${c.usersUpdated} · asignaciones creadas ${c.assignments} · espejos user_property_roles creados ${c.legacyMirrors} · audit_events ${result.audited} (ROLE_ASSIGNED / USER_CREATED, actorType system)`);
    lines.push("  organizations.rbac_version +1 · reinicia el API para que rehidrate la cadena de auditoría y los espejos in-memory.");
  }
  lines.push("");
  lines.push(`Contraseña de demo (${result.mode === "apply" ? "activa" : "la que se escribiría"} para los ${RBAC_DEMO_USERS.filter((u) => !isEmergencyAccount(u)).length} usuarios @${EMAIL_DOMAIN}; obligatorio cambiarla en el primer inicio de sesión; las cuentas de emergencia no tienen contraseña): ${result.password}`);
  lines.push(`Sobreescribible con ${PASSWORD_ENV_VAR}. ${result.mode === "dry-run" ? "Plan" : "Aplicado"} en ${result.durationMs} ms.`);
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

export async function run(flags: SeedFlags): Promise<SeedResult> {
  const startedAt = Date.now();
  const password = resolveDemoPassword();
  const prisma = new PrismaClient();
  try {
    const plan = await buildPlan(prisma);
    if (!flags.json) console.log(formatPlan(plan, flags.dryRun));
    if (flags.dryRun) {
      return { mode: "dry-run", runId: "", correlationId: "", plan, created: { roles: 0, grants: 0, groups: 0, groupMembers: 0, thresholds: 0, users: 0, usersUpdated: 0, assignments: 0, legacyMirrors: 0 }, audited: 0, password, durationMs: Date.now() - startedAt };
    }
    assertDemoTarget({ orgId: ORG_ID, action: "seed-rbac-demo (usuarios ficticios por rol, Faranda)", planned: plannedWrites(plan) });
    const applied = await applyPlan(prisma, plan, password);
    return { mode: "apply", ...applied, password, durationMs: Date.now() - startedAt };
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  let flags: SeedFlags;
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
    const result = await run(flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatResult(result));
    return 0;
  } catch (error) {
    console.error(`[seed:rbac-demo] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isMain()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
