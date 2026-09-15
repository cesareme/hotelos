// Role tokens of the Tanda 5 navigation tree (Tanda 5 · L1a).
//
// The tree (`nav-tree.generated.json`, built from pilots/tanda5-nav-tree.csv)
// gates every item and tab with the nine role tokens of the CSV `roles`
// column plus `publico` for the two screens outside the menu. Tokens are NOT
// RBAC roles: they are derived from the `templateKey` of the roles a user
// holds in the active property (`GET /users/me`), see `roleTokenFromTemplate`.
// A user with several roles sees the union; a custom role without template
// maps to no token (the caller then filters by permissions and modules only).
//
// L1b replaces `navigation/roles.ts` (persona views in localStorage) with this
// module; until then both coexist and nothing here reads localStorage.

export type RoleToken =
  | "direccion"
  | "recepcion"
  | "pisos"
  | "mantenimiento"
  | "revenue"
  | "finanzas"
  | "comercial"
  | "fnb"
  | "admin"
  | "publico";

export const ROLE_TOKENS: readonly RoleToken[] = [
  "direccion",
  "recepcion",
  "pisos",
  "mantenimiento",
  "revenue",
  "finanzas",
  "comercial",
  "fnb",
  "admin",
  "publico"
];

/** Spanish labels for the "Ver como…" switcher and the role badge (§8). */
export const ROLE_TOKEN_LABELS: Record<RoleToken, string> = {
  direccion: "Dirección",
  recepcion: "Recepción",
  pisos: "Pisos",
  mantenimiento: "Mantenimiento",
  revenue: "Revenue",
  finanzas: "Finanzas",
  comercial: "Comercial",
  fnb: "Punto de venta y F&B",
  admin: "Administrador de plataforma",
  publico: "Público"
};

/**
 * RBAC template keys (`ROLE_TEMPLATE_KEYS` in packages/shared/src/permissions.ts)
 * plus the two templates the tree needs and L1 creates: `sales` (comercial)
 * and `fnb`. Kept as a local union so this module has no runtime dependency
 * on @hotelos/shared; tests/nav-tree-contract.test.mjs checks the shared list
 * stays covered.
 */
export type RoleTemplateKey =
  | "owner"
  | "admin"
  | "manager"
  | "receptionist"
  | "housekeeper"
  | "maintenance"
  | "accountant"
  | "compliance"
  | "revenue"
  | "sales"
  | "fnb";

export const ROLE_TEMPLATE_TO_TOKEN: Record<RoleTemplateKey, RoleToken> = {
  owner: "direccion",
  admin: "admin",
  manager: "direccion",
  receptionist: "recepcion",
  housekeeper: "pisos",
  maintenance: "mantenimiento",
  accountant: "finanzas",
  compliance: "finanzas",
  revenue: "revenue",
  sales: "comercial",
  fnb: "fnb"
};

export const ROLE_TEMPLATE_KEYS_MAPPED: readonly RoleTemplateKey[] = Object.keys(ROLE_TEMPLATE_TO_TOKEN) as RoleTemplateKey[];

/**
 * When a user holds several tokens, the first one in this order decides the
 * landing page and the default tab (broadest first; `publico` never wins over
 * an authenticated token).
 */
export const ROLE_TOKEN_PRIORITY: readonly RoleToken[] = [
  "admin",
  "direccion",
  "finanzas",
  "revenue",
  "comercial",
  "recepcion",
  "fnb",
  "mantenimiento",
  "pisos",
  "publico"
];

/** Viewports narrower than this land housekeeping/maintenance on their mobile tab (§3). */
export const MOBILE_BREAKPOINT_PX = 700;

export function isRoleToken(value: unknown): value is RoleToken {
  return typeof value === "string" && (ROLE_TOKENS as readonly string[]).includes(value);
}

export function isRoleTemplateKey(value: unknown): value is RoleTemplateKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ROLE_TEMPLATE_TO_TOKEN, value);
}

/** `templateKey` of a property role → tree token; null for custom roles without template. */
export function roleTokenFromTemplate(templateKey: string | null | undefined): RoleToken | null {
  if (!templateKey) return null;
  const normalized = templateKey.trim().toLowerCase();
  return isRoleTemplateKey(normalized) ? ROLE_TEMPLATE_TO_TOKEN[normalized] : null;
}

/** Union of tokens for every template a user holds, deduplicated and sorted by priority. */
export function roleTokensFromTemplates(templateKeys: Iterable<string | null | undefined>): RoleToken[] {
  const found = new Set<RoleToken>();
  for (const key of templateKeys) {
    const token = roleTokenFromTemplate(key);
    if (token) found.add(token);
  }
  return ROLE_TOKEN_PRIORITY.filter((token) => found.has(token));
}

export function primaryRoleToken(tokens: readonly RoleToken[]): RoleToken | null {
  return ROLE_TOKEN_PRIORITY.find((token) => tokens.includes(token)) ?? null;
}

export type RoleHomeOptions = {
  /** Viewport narrower than MOBILE_BREAKPOINT_PX: pisos/mantenimiento land on their mobile tab. */
  mobile?: boolean;
  /** Distinguishes owner (`/hoy/propietario`) from manager inside `direccion`. */
  templateKey?: string | null;
};

/** Landing page when the user has no token in the property (with a notice, §8). */
export const NO_ROLE_HOME = "/hoy";

/**
 * Landing URL per role (pilots/tanda5-nav-tree.md §3). URLs are the ones of
 * the tree; tests/nav-tree-contract.test.mjs checks every home exists there.
 */
export function roleHome(token: RoleToken | null | undefined, options: RoleHomeOptions = {}): string {
  const mobile = options.mobile === true;
  switch (token) {
    case "direccion":
      return options.templateKey?.trim().toLowerCase() === "owner" ? "/hoy/propietario" : "/hoy/direccion";
    case "recepcion":
      return "/hoy";
    case "pisos":
      return mobile ? "/operaciones/pisos/mi-turno" : "/hoy/operaciones";
    case "mantenimiento":
      return mobile ? "/operaciones/mantenimiento/mis-averias" : "/hoy/operaciones";
    case "fnb":
      return "/hoy/operaciones";
    case "revenue":
    case "finanzas":
    case "comercial":
    case "admin":
      return "/hoy/direccion";
    case "publico":
      return "/acceso";
    default:
      return NO_ROLE_HOME;
  }
}

/** Landing for a multi-role user: the highest-priority token decides. */
export function roleHomeForTokens(tokens: readonly RoleToken[], options: RoleHomeOptions = {}): string {
  return roleHome(primaryRoleToken(tokens), options);
}

/** Minimal shape of a gated menu entry (item, tab or dev-only screen). */
export type NavGate = {
  roles?: readonly string[];
  modulesAny?: readonly string[];
};

/** Empty `roles` or `publico` → everyone; otherwise at least one token must match. */
export function roleAllows(gate: NavGate, roleTokens: readonly RoleToken[]): boolean {
  const roles = gate.roles ?? [];
  if (roles.length === 0 || roles.includes("publico")) return true;
  return roleTokens.some((token) => roles.includes(token));
}

/**
 * Empty `modulesAny` → core, always allowed; otherwise one of the codes must be
 * enabled in the active property. Pass `[]` while the module list is loading:
 * a gated entry is hidden until the answer arrives, so it never opens a 403.
 */
export function moduleAllows(gate: NavGate, enabledModules: readonly string[]): boolean {
  const codes = gate.modulesAny ?? [];
  if (codes.length === 0) return true;
  return codes.some((code) => enabledModules.includes(code));
}

/** Item/tab visible for these tokens and enabled modules (§3 + §6). */
export function canSee(item: NavGate, roleTokens: readonly RoleToken[], enabledModules: readonly string[]): boolean {
  return roleAllows(item, roleTokens) && moduleAllows(item, enabledModules);
}

export type NavVisibility = "visible" | "locked" | "hidden";

/**
 * §6.3 «descubrimiento sin 403»: an entry hidden only by its module is shown
 * dimmed with the action «Activar módulo» to users who can enable modules
 * (`modules.enable`); for everyone else it is simply hidden.
 */
export function navVisibility(
  item: NavGate,
  roleTokens: readonly RoleToken[],
  enabledModules: readonly string[],
  options: { canEnableModules?: boolean } = {}
): NavVisibility {
  if (!roleAllows(item, roleTokens)) return "hidden";
  if (moduleAllows(item, enabledModules)) return "visible";
  return options.canEnableModules ? "locked" : "hidden";
}

// ----------------------------------------------------------------- L1b · tokens of a session

/** `ROLE_PERMISSION_MAP` shape (template → permission keys), injected so this module stays free of @hotelos/shared. */
export type TemplatePermissionMap = Readonly<Record<string, readonly string[]>>;

/**
 * Templates FULLY covered by a set of granted permissions. Only used as the
 * fallback of `resolveRoleTokens` for custom roles without template (§8: «se
 * filtran solo por permisos y módulos»): a template counts when every one of
 * its permissions is held, so nothing shown through it can answer 403. The
 * platform `admin` template is never derived here (it is a server flag).
 */
export function templatesCoveredByPermissions(
  permissions: readonly string[] | null | undefined,
  templates: TemplatePermissionMap
): RoleTemplateKey[] {
  if (!permissions || permissions.length === 0) return [];
  const held = new Set(permissions);
  const covered: RoleTemplateKey[] = [];
  for (const key of ROLE_TEMPLATE_KEYS_MAPPED) {
    if (key === "admin") continue;
    const required = templates[key];
    if (!required || required.length === 0) continue;
    if (required.every((permission) => held.has(permission))) covered.push(key);
  }
  return covered;
}

export type RoleTokenSource = {
  /** Template keys of the roles held in the active property (GET /users/me → properties[].templateKeys). */
  templateKeys: readonly (string | null | undefined)[];
  /** Real DB grant (never the demo union): adds the `admin` token. */
  isPlatformAdmin?: boolean;
  /** Real grants of the property; only consulted when no template applies (custom roles). */
  grantedPermissions?: readonly string[] | null;
  /** Needed for that fallback; without it a custom role yields no token. */
  templatePermissions?: TemplatePermissionMap;
};

export type ResolvedRoleTokens = {
  tokens: RoleToken[];
  /** Most privileged template held (`owner` before `manager`), for `roleHome`; null for admin-only or custom roles. */
  templateKey: RoleTemplateKey | null;
  /** True when the tokens came from the permission fallback instead of templates. */
  fromPermissions: boolean;
};

/** Order used to pick `templateKey` among several: owner wins over manager, then catalogue order. */
const TEMPLATE_PRIORITY: readonly RoleTemplateKey[] = [
  "owner",
  "manager",
  "accountant",
  "compliance",
  "revenue",
  "sales",
  "receptionist",
  "fnb",
  "maintenance",
  "housekeeper",
  "admin"
];

function pickTemplateKey(keys: readonly RoleTemplateKey[]): RoleTemplateKey | null {
  return TEMPLATE_PRIORITY.find((key) => keys.includes(key)) ?? null;
}

/**
 * Role tokens of a session for the navigation tree (L1b):
 *   templates of the active property → tokens, plus `admin` for the platform
 *   administrator (template_key null: never comes from a template);
 *   no template at all → templates fully covered by the granted permissions;
 *   nothing → [] (the menu shows the no-role state, UI_STATES.noRole).
 */
export function resolveRoleTokens(source: RoleTokenSource): ResolvedRoleTokens {
  const templates = [...source.templateKeys]
    .map((key) => (typeof key === "string" ? key.trim().toLowerCase() : ""))
    .filter((key): key is RoleTemplateKey => isRoleTemplateKey(key));
  const found = new Set<RoleToken>(roleTokensFromTemplates(templates));
  if (source.isPlatformAdmin) found.add("admin");
  let fromPermissions = false;
  let templateKey = pickTemplateKey(templates);
  if (templates.length === 0 && source.templatePermissions) {
    const covered = templatesCoveredByPermissions(source.grantedPermissions, source.templatePermissions);
    if (covered.length > 0) {
      fromPermissions = true;
      for (const token of roleTokensFromTemplates(covered)) found.add(token);
      templateKey = pickTemplateKey(covered);
    }
  }
  return { tokens: ROLE_TOKEN_PRIORITY.filter((token) => found.has(token)), templateKey, fromPermissions };
}

/** Screen keys with `roles` covering every authenticated token are visible even without a role (§8: Mi día y el asistente). */
export const AUTHENTICATED_ROLE_TOKENS: readonly RoleToken[] = ROLE_TOKENS.filter((token) => token !== "publico");

export function roleAllowsEveryone(gate: NavGate): boolean {
  const roles = gate.roles ?? [];
  if (roles.length === 0 || roles.includes("publico")) return true;
  return AUTHENTICATED_ROLE_TOKENS.every((token) => roles.includes(token));
}
