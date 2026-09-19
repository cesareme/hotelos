// Role tokens of the Tanda 5 navigation tree (Tanda 5 · L1a).
//
// The tree (`nav-tree.generated.json`, built from pilots/tanda5-nav-tree.csv)
// gates every item and tab with the fifteen authenticated role tokens of the
// CSV `roles` column plus `publico` for the two screens outside the menu.
// Tokens are NOT RBAC roles: they are derived from the `templateKey` of the
// roles a user holds in the active property (`GET /users/me`), see
// `roleTokenFromTemplate`. A user with several roles sees the union; a custom
// role without template maps to no token (the caller then filters by
// permissions and modules only).
//
// Tanda 8a (RBAC por departamento y nivel, design §4.2 / §5.1): six tokens
// join the nine of Tanda 5 — `administracion` (admin_clerk), `rrhh`
// (payroll_hr), `propiedad` (owner, no longer «dirección»), `activos`
// (asset_manager), `auditoria` (auditor, read-only) and `sistemas` (the
// organisation `admin` template, without money keys). The `admin` token is
// the PLATFORM administrator only (`isPlatformAdmin`, never a template).
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
  | "administracion"
  | "rrhh"
  | "propiedad"
  | "activos"
  | "auditoria"
  | "sistemas"
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
  "administracion",
  "rrhh",
  "propiedad",
  "activos",
  "auditoria",
  "sistemas",
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
  administracion: "Administración de hotel",
  rrhh: "RRHH y nóminas",
  propiedad: "Propiedad",
  activos: "Gestión del activo",
  auditoria: "Auditoría interna",
  sistemas: "Administración de sistema",
  admin: "Administrador de plataforma",
  publico: "Público"
};

/**
 * RBAC template keys (`ROLE_TEMPLATE_KEYS` in packages/shared/src/permissions.ts):
 * the 24 templates of Tanda 8a (design §4.2), `break_glass` included. Kept as
 * a local union so this module has no runtime dependency on @hotelos/shared;
 * tests/nav-tree-contract.test.mjs checks the shared list stays covered and
 * tests/rbac-nav-contract.test.mjs that both sets are identical.
 */
export type RoleTemplateKey =
  | "receptionist"
  | "night_auditor"
  | "front_office_manager"
  | "housekeeper"
  | "housekeeping_manager"
  | "maintenance"
  | "maintenance_manager"
  | "fnb"
  | "fnb_manager"
  | "sales"
  | "admin_clerk"
  | "manager"
  | "operations_director"
  | "general_manager"
  | "break_glass"
  | "revenue"
  | "accountant"
  | "controller"
  | "compliance"
  | "payroll_hr"
  | "asset_manager"
  | "owner"
  | "auditor"
  | "admin";

/**
 * Template → token (design §4.2). The organisation `admin` template maps to
 * `sistemas`: the `admin` token stays the platform administrator's only
 * (H11). `break_glass` holds every hotel key, so it takes the broadest hotel
 * token; it never yields `admin`.
 */
export const ROLE_TEMPLATE_TO_TOKEN: Record<RoleTemplateKey, RoleToken> = {
  receptionist: "recepcion",
  night_auditor: "recepcion",
  front_office_manager: "recepcion",
  housekeeper: "pisos",
  housekeeping_manager: "pisos",
  maintenance: "mantenimiento",
  maintenance_manager: "mantenimiento",
  fnb: "fnb",
  fnb_manager: "fnb",
  sales: "comercial",
  admin_clerk: "administracion",
  manager: "direccion",
  operations_director: "direccion",
  general_manager: "direccion",
  break_glass: "direccion",
  revenue: "revenue",
  accountant: "finanzas",
  controller: "finanzas",
  compliance: "finanzas",
  payroll_hr: "rrhh",
  asset_manager: "activos",
  owner: "propiedad",
  auditor: "auditoria",
  admin: "sistemas"
};

export const ROLE_TEMPLATE_KEYS_MAPPED: readonly RoleTemplateKey[] = Object.keys(ROLE_TEMPLATE_TO_TOKEN) as RoleTemplateKey[];

/**
 * When a user holds several tokens, the first one in this order decides the
 * landing page and the default tab (broadest first; `publico` never wins over
 * an authenticated token).
 */
export const ROLE_TOKEN_PRIORITY: readonly RoleToken[] = [
  "admin",
  "sistemas",
  "direccion",
  "propiedad",
  "auditoria",
  "finanzas",
  "rrhh",
  "activos",
  "revenue",
  "comercial",
  "administracion",
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
  /** Kept for callers of Tanda 5: `owner` used to live inside `direccion` and land on `/hoy/propietario`; since Tanda 8a it is the `propiedad` token. */
  templateKey?: string | null;
};

/** Landing page when the user has no token in the property (with a notice, §8). */
export const NO_ROLE_HOME = "/hoy";

/**
 * Landing URL per role (pilots/tanda5-nav-tree.md §3; Tanda 8a design §4.9 /
 * §10.2 for the six new tokens). URLs are the ones of the tree;
 * tests/nav-tree-contract.test.mjs checks every home exists there.
 *   - `administracion` → the supplier-bill inbox of Facturación y cobros;
 *   - `rrhh` → Nóminas; `activos` → Cumplimiento › Centro de cumplimiento
 *     (obligaciones, licencias e inspecciones del inmueble) until Finanzas ›
 *     Activo inmobiliario exists (§10.2 named Proveedores y gastos ›
 *     Inmovilizado, but `asset_manager` holds no `payables.read` and the base
 *     screen of that item would answer 403, so the token is not on that row);
 *     `auditoria` → Sistema (Auditoría); `sistemas` → Usuarios y roles: none of
 *     the last four sees Mi día, so they land on their own screen;
 *   - `propiedad` → the owner tab of Mi día (`/hoy/propietario`).
 */
export function roleHome(token: RoleToken | null | undefined, options: RoleHomeOptions = {}): string {
  const mobile = options.mobile === true;
  switch (token) {
    case "direccion":
      return options.templateKey?.trim().toLowerCase() === "owner" ? "/hoy/propietario" : "/hoy/direccion";
    case "propiedad":
      return "/hoy/propietario";
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
    case "administracion":
      return "/finanzas/facturacion";
    case "rrhh":
      return "/finanzas/nominas";
    case "activos":
      return "/cumplimiento/centro";
    case "auditoria":
      return "/configuracion/sistema";
    case "sistemas":
      return "/configuracion/usuarios";
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

/**
 * Order used to pick `templateKey` among several: `owner` first (its landing
 * tab is Propietario), then the ROLE_TEMPLATE_KEYS order of packages/shared
 * (most specific first: general_manager before manager…), `admin` last.
 */
const TEMPLATE_PRIORITY: readonly RoleTemplateKey[] = [
  "owner",
  "general_manager",
  "operations_director",
  "front_office_manager",
  "housekeeping_manager",
  "maintenance_manager",
  "fnb_manager",
  "night_auditor",
  "admin_clerk",
  "controller",
  "payroll_hr",
  "asset_manager",
  "auditor",
  "break_glass",
  "manager",
  "receptionist",
  "housekeeper",
  "maintenance",
  "accountant",
  "compliance",
  "revenue",
  "sales",
  "fnb",
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

/**
 * The fifteen authenticated tokens (every token but `publico`). An entry whose
 * `roles` cover all of them is visible even without a role (§8); since Tanda
 * 8a no menu entry listed the fifteen (`rrhh`, `activos` and `sistemas` do not
 * see Mi día), so a custom role without template saw the no-role notice only.
 * Fusión TL (2026-09-19): Hoy › Live Timeline lists the fifteen on purpose
 * ("todos los perfiles"), so a custom role without template sees that single
 * entry; the screen itself degrades honestly when `pms.reservation.read` is
 * missing (the tree carries tokens, never permission keys).
 */
export const AUTHENTICATED_ROLE_TOKENS: readonly RoleToken[] = ROLE_TOKENS.filter((token) => token !== "publico");

export function roleAllowsEveryone(gate: NavGate): boolean {
  const roles = gate.roles ?? [];
  if (roles.length === 0 || roles.includes("publico")) return true;
  return AUTHENTICATED_ROLE_TOKENS.every((token) => roles.includes(token));
}
