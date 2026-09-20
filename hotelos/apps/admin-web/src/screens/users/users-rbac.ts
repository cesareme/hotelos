// Pure helpers of Configuración › Usuarios y roles (Tanda 8a · L4, design
// §4.3 / §4.7 / §5.4). No React, no window: covered by
// __tests__/users-rbac.test.mts.
//
//   - MODULE_OF_PREFIX / moduleOfPermission: the §4.3 dictionary «prefijo →
//     módulo» as a static table (the 81 prefixes of the catalogue plus the
//     handful of keys that live in another module than their prefix:
//     billing.configure / payments.configure / accounting.entity.read → M20,
//     compliance.configure … → M15b), for the template comparator;
//   - sodWarningsFor: the static SoD pairs (SOD_STATIC_PAIRS over
//     ROLE_PERMISSION_MAP) a COMBINATION of templates would violate — what the
//     assignment drawer paints in red before the API answers 409;
//   - rankOfTemplate / levelWarningFor / assignableTemplates: the «nivel ≤
//     propio» rule (ROLE_LEVEL_RANK) the drawer explains and the API enforces
//     (403 RBAC_LEVEL_EXCEEDED); `break_glass` is never offered (§4.8);
//   - compareTemplates / identicalRoles: the comparator by module and the
//     «roles con permisos idénticos» of the quarterly review (Mews pattern).

import {
  ROLE_LEVEL_RANK,
  ROLE_PERMISSION_MAP,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LABELS_ES,
  ROLE_TEMPLATE_LEVEL,
  SCOPE_TYPE_RANK,
  sodConflictsOf,
  type PermissionKey,
  type RoleKey,
  type RoleLevel,
  type ScopeType,
  type SodStaticPair,
  type UserRoleAssignmentDto
} from "@hotelos/shared";

// ----------------------------------------------------------------- labels

export const LEVEL_LABELS_ES: Record<RoleLevel, string> = {
  operative: "Operativo (N1)",
  supervisor: "Supervisión (N2)",
  hotel_director: "Dirección de hotel (N3)",
  operations_director: "Dirección de operaciones (N4)",
  general_management: "Dirección general (N5)",
  ownership: "Propiedad (N6)",
  central_admin: "Administración central (N7)"
};

export const SCOPE_LABELS_ES: Record<ScopeType, string> = {
  property: "Hotel",
  property_group: "Grupo de hoteles",
  legal_entity: "Sociedad",
  organization: "Organización"
};

export const STATUS_LABELS_ES: Record<string, string> = {
  active: "Activo",
  invited: "Invitado · pendiente",
  disabled: "Desactivado",
  emergency: "Cuenta de emergencia"
};

/** Spanish label of a template key; a custom role shows its own name. */
export function templateLabel(templateKey: string | null | undefined, roleName?: string | null): string {
  if (templateKey && templateKey in ROLE_TEMPLATE_LABELS_ES) return ROLE_TEMPLATE_LABELS_ES[templateKey as RoleKey];
  return roleName?.trim() || "Rol personalizado";
}

export function levelLabel(level: RoleLevel | null | undefined): string {
  return level ? LEVEL_LABELS_ES[level] : "—";
}

export function scopeLabel(scopeType: ScopeType | null | undefined): string {
  return scopeType ? SCOPE_LABELS_ES[scopeType] : "—";
}

export function statusLabel(status: string | null | undefined): string {
  return (status && STATUS_LABELS_ES[status]) || status || "—";
}

// ----------------------------------------------------------------- §4.3 · prefix → module

export type ModuleCode =
  | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9" | "M10" | "M11" | "M12" | "M13" | "M14"
  | "M15" | "M15b" | "M16" | "M17" | "M18" | "M18b" | "M19" | "M20" | "M21" | "M22" | "M22b" | "M23" | "M24" | "PLAT";

export const MODULE_LABELS_ES: Record<ModuleCode, string> = {
  M1: "Reservas y recepción",
  M2: "Folios y cobros",
  M3: "Facturación",
  M4: "Cierre del día",
  M5: "Pisos",
  M6: "Mantenimiento, energía y seguridad",
  M7: "TPV y A&B",
  M8: "Compras e inventario",
  M9: "Facturas de proveedor y pagos",
  M10: "Contabilidad",
  M11: "Tesorería y bancos",
  M12: "Nóminas y personal",
  M13: "Inmovilizado y CAPEX",
  M14: "Gestión del activo",
  M15: "Cumplimiento y registro de viajeros",
  M15b: "Configuración de cumplimiento y fiscal",
  M16: "Revenue y distribución",
  M17: "Comercial, grupos y CRM",
  M18: "Informes y analítica",
  M18b: "Cuadro del propietario",
  M19: "Configuración de la propiedad",
  M20: "Estructura societaria y fiscal",
  M21: "Usuarios, roles y auditoría",
  M22: "Módulos",
  M22b: "Integraciones y desarrollo",
  M23: "Inteligencia artificial",
  M24: "Puesta en marcha y migración",
  PLAT: "Plataforma y emergencia"
};

/** Order of the modules in the comparator (the §4.3 table order). */
export const MODULE_ORDER: readonly ModuleCode[] = [
  "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11", "M12", "M13", "M14",
  "M15", "M15b", "M16", "M17", "M18", "M18b", "M19", "M20", "M21", "M22", "M22b", "M23", "M24", "PLAT"
];

/** The 81 prefixes of the catalogue (design §4.3): first segment of the key → module. */
export const MODULE_OF_PREFIX: Readonly<Record<string, ModuleCode>> = {
  pms: "M1", guests: "M1", guest_experience: "M1",
  folio: "M2", payment: "M2", payments: "M2",
  invoice: "M3", billing: "M3",
  night_audit: "M4",
  housekeeping: "M5", rooms: "M5",
  maintenance: "M6", incidents: "M6", safety_checks: "M6", energy: "M6", sustainability: "M6", iot: "M6", insurance_cases: "M6",
  pos: "M7",
  procurement: "M8", inventory: "M8", purchase_orders: "M8",
  payables: "M9",
  accounting: "M10",
  banking: "M11",
  payroll: "M12", workforce: "M12",
  assets: "M13", capex: "M13", asset: "M13",
  real_estate: "M14", property_tax: "M14",
  compliance: "M15", guest_register: "M15", tourist_tax: "M15",
  tax: "M15b", compliance_setup: "M15b",
  revenue: "M16", channel_manager: "M16", distribution: "M16", revenue_setup: "M16",
  crm: "M17", groups: "M17", events: "M17", sales: "M17", reputation: "M17", surveys: "M17", quality_cases: "M17", guest_self_service: "M17", commissions: "M17", guest_portal: "M17",
  analytics: "M18", metrics: "M18",
  owner: "M18b",
  configuration: "M19", categories: "M19", custom_fields: "M19", property: "M19", templates: "M19", room_types: "M19", spaces: "M19", departments: "M19",
  operations_setup: "M19", ai_category_setup: "M19", property_profile: "M19", notifications: "M19", kiosk: "M19", digital_key: "M19",
  organization: "M20", backoffice: "M20",
  users: "M21", audit: "M21", roles: "M21", permissions: "M21",
  modules: "M22",
  integrations: "M22b", developer: "M22b",
  ai: "M23", ai_governance: "M23", ai_incidents: "M23", ai_evals: "M23", ai_prompts: "M23", ai_tool_registry: "M23",
  onboarding: "M24",
  security: "PLAT", admin: "PLAT", platform: "PLAT"
};

/** Keys whose module is not the one of their prefix (§4.3 rows M15b and M20). */
export const MODULE_OF_KEY: Readonly<Record<string, ModuleCode>> = {
  "billing.configure": "M20",
  "payments.configure": "M20",
  "accounting.entity.read": "M20",
  "compliance.configure": "M15b",
  "compliance.ses.configure": "M15b",
  "compliance.gdpr.manage": "M15b",
  "guest_register.configure": "M15b"
};

export function moduleOfPermission(key: string): ModuleCode {
  const exact = MODULE_OF_KEY[key];
  if (exact) return exact;
  const prefix = key.split(".")[0] ?? "";
  return MODULE_OF_PREFIX[prefix] ?? "PLAT";
}

// ----------------------------------------------------------------- templates, levels, ranks

/** Templates a hotel may hand out: every catalogue template but the emergency one (§4.8) — the API refuses it anyway (RBAC_BREAK_GLASS_FORBIDDEN). */
export const OFFERABLE_TEMPLATES: readonly RoleKey[] = ROLE_TEMPLATE_KEYS.filter((key) => key !== "break_glass");

export function isRoleKey(value: unknown): value is RoleKey {
  return typeof value === "string" && (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** ROLE_LEVEL_RANK of a template (null for an unknown / custom key). */
export function rankOfTemplate(templateKey: string | null | undefined): number | null {
  if (!isRoleKey(templateKey)) return null;
  return ROLE_LEVEL_RANK[ROLE_TEMPLATE_LEVEL[templateKey]];
}

/** ROLE_LEVEL_RANK of a level (null when unknown). */
export function rankOfLevel(level: RoleLevel | null | undefined): number | null {
  return level ? ROLE_LEVEL_RANK[level] : null;
}

/** Highest rank among the caller's templates in the property (null when none is a template). */
export function callerMaxRank(templateKeys: readonly (string | null | undefined)[]): number | null {
  let max: number | null = null;
  for (const key of templateKeys) {
    const rank = rankOfTemplate(key);
    if (rank !== null && (max === null || rank > max)) max = rank;
  }
  return max;
}

/**
 * «Nivel ≤ propio» (design §4.1 / §6.3): a role of rank r is assigned by a
 * caller of rank ≥ r (the platform administrator by anyone). Returns the
 * Spanish warning to paint, or null when the assignment is within reach.
 */
export function levelWarningFor(targetRank: number | null, callerRank: number | null, isPlatformAdmin: boolean): string | null {
  if (isPlatformAdmin || targetRank === null) return null;
  if (callerRank === null) return "No tienes un rol con nivel en este hotel: la API rechazará la asignación (403).";
  if (targetRank > callerRank) return "Este rol es de nivel superior al tuyo: la API lo rechazará (RBAC_LEVEL_EXCEEDED).";
  return null;
}

/** Templates the caller may hand out in the scope: rank ≤ own (all of them for the platform administrator); never break_glass. */
export function assignableTemplates(callerRank: number | null, isPlatformAdmin: boolean): RoleKey[] {
  if (isPlatformAdmin) return [...OFFERABLE_TEMPLATES];
  if (callerRank === null) return [];
  return OFFERABLE_TEMPLATES.filter((key) => ROLE_LEVEL_RANK[ROLE_TEMPLATE_LEVEL[key]] <= callerRank);
}

/** «Ámbito ⊆ propio»: the widest scope the caller may assign is the widest scope they hold (SCOPE_TYPE_RANK). */
export function scopeWithinReach(target: ScopeType, callerScopes: readonly ScopeType[], isPlatformAdmin: boolean): boolean {
  if (isPlatformAdmin) return true;
  const max = callerScopes.reduce((best, scope) => Math.max(best, SCOPE_TYPE_RANK[scope]), 0);
  return SCOPE_TYPE_RANK[target] <= max;
}

// ----------------------------------------------------------------- separation of duties

export type SodWarning = {
  pair: SodStaticPair;
  /** Templates (of the combination) that bring each key. */
  holdersA: RoleKey[];
  holdersB: RoleKey[];
};

/** Keys of a template (empty for a custom key). */
export function permissionsOfTemplate(templateKey: string | null | undefined): readonly PermissionKey[] {
  return isRoleKey(templateKey) ? ROLE_PERMISSION_MAP[templateKey] : [];
}

/**
 * Static SoD pairs (§4.7) a combination of templates would hold together:
 * the union of their keys against SOD_STATIC_PAIRS. A pair inside ONE
 * template that the catalogue allows through `except` (controller: approve +
 * pay) is not a warning; the same pair spread over two templates is.
 */
export function sodWarningsFor(templateKeys: readonly (string | null | undefined)[]): SodWarning[] {
  const templates = [...new Set(templateKeys.filter(isRoleKey))];
  const union = new Set<PermissionKey>();
  for (const key of templates) for (const permission of ROLE_PERMISSION_MAP[key]) union.add(permission);
  const only = templates.length === 1 ? templates[0] : null;
  return sodConflictsOf([...union], only).map((pair) => ({
    pair,
    holdersA: templates.filter((key) => ROLE_PERMISSION_MAP[key].includes(pair.a)),
    holdersB: templates.filter((key) => ROLE_PERMISSION_MAP[key].includes(pair.b))
  }));
}

/** Spanish sentence of a warning for the callout. */
export function describeSodWarning(warning: SodWarning): string {
  const name = (keys: RoleKey[]) => keys.map((key) => ROLE_TEMPLATE_LABELS_ES[key]).join(", ");
  return `«${warning.pair.a}» (${name(warning.holdersA)}) y «${warning.pair.b}» (${name(warning.holdersB)}) no pueden coincidir en la misma persona.`;
}

// ----------------------------------------------------------------- comparator (§5.4)

export type ModuleComparison = {
  module: ModuleCode;
  label: string;
  onlyA: PermissionKey[];
  onlyB: PermissionKey[];
  both: PermissionKey[];
};

/**
 * Keys of two templates grouped by module of §4.3: what only A has, only B,
 * both. Modules where neither has a key are dropped. A side without keys
 * (`undefined`: a template the served catalogue does not know) counts as
 * empty instead of throwing «b is not iterable» (FIX-1 · F6).
 */
export function compareTemplates(a: readonly PermissionKey[] | undefined, b: readonly PermissionKey[] | undefined): ModuleComparison[] {
  const listA = a ?? [];
  const listB = b ?? [];
  const setA = new Set(listA);
  const setB = new Set(listB);
  const byModule = new Map<ModuleCode, ModuleComparison>();
  const bucket = (module: ModuleCode) => {
    let entry = byModule.get(module);
    if (!entry) {
      entry = { module, label: MODULE_LABELS_ES[module], onlyA: [], onlyB: [], both: [] };
      byModule.set(module, entry);
    }
    return entry;
  };
  for (const key of [...new Set([...listA, ...listB])].sort()) {
    const entry = bucket(moduleOfPermission(key));
    if (setA.has(key) && setB.has(key)) entry.both.push(key);
    else if (setA.has(key)) entry.onlyA.push(key);
    else entry.onlyB.push(key);
  }
  return MODULE_ORDER.filter((module) => byModule.has(module)).map((module) => byModule.get(module)!);
}

/** A role with its keys; `permissions` missing or undefined counts as no keys (FIX-1 · F6). */
export type RoleLike = { id: string; name: string; permissions?: readonly PermissionKey[] };

/** Groups of roles whose permission sets are identical (quarterly review, §5.4); singletons are dropped. */
export function identicalRoles<T extends RoleLike>(roles: readonly T[]): Array<{ roles: T[]; permissionCount: number }> {
  const groups = new Map<string, T[]>();
  for (const role of roles) {
    const signature = [...new Set(role.permissions ?? [])].sort().join("|");
    const list = groups.get(signature) ?? [];
    list.push(role);
    groups.set(signature, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([signature, list]) => ({ roles: list, permissionCount: signature === "" ? 0 : signature.split("|").length }));
}

// ----------------------------------------------------------------- rows of the screen

/** Live assignments covering a property (scope property = that id; wider scopes cover every property they expand to — the API already filtered). */
export function assignmentsCovering(assignments: readonly UserRoleAssignmentDto[], propertyId: string): UserRoleAssignmentDto[] {
  return assignments.filter((row) => row.revokedAt === null && (row.scopeType !== "property" || row.propertyId === propertyId));
}

/** The assignment that decides the row's template: widest scope first, then highest rank. */
export function primaryAssignment(assignments: readonly UserRoleAssignmentDto[]): UserRoleAssignmentDto | null {
  const live = assignments.filter((row) => row.revokedAt === null);
  if (live.length === 0) return null;
  return [...live].sort((left, right) => {
    const scope = SCOPE_TYPE_RANK[right.scopeType] - SCOPE_TYPE_RANK[left.scopeType];
    if (scope !== 0) return scope;
    return (rankOfTemplate(right.templateKey) ?? 0) - (rankOfTemplate(left.templateKey) ?? 0);
  })[0];
}

/** Distinct property ids an assignment list names directly (wider scopes count as «todos los centros del ámbito»). */
export function hotelsOf(assignments: readonly UserRoleAssignmentDto[], propertyNames: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();
  for (const row of assignments) {
    if (row.revokedAt !== null) continue;
    if (row.scopeType === "property" && row.propertyId) names.add(propertyNames.get(row.propertyId) ?? row.propertyId);
    else names.add(SCOPE_LABELS_ES[row.scopeType]);
  }
  return [...names];
}

/** True when the caller may act on a row: never on themselves (§1: nobody grants themselves permissions). */
export function canManageRow(rowUserId: string, callerUserId: string | null): boolean {
  return callerUserId !== null && rowUserId !== callerUserId;
}
