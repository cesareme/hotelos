// Persona-based navigation roles. Grounded in hospitality role research:
// two operational personas (real-time → broad) and two capital personas
// (analytical oversight → final authority).
//
//   reception  → front desk, real-time guest ops (narrowest)
//   operations → runs the whole physical hotel & teams (broad ops)
//   asset      → owner's representative: revenue, P&L, capex, benchmarking
//   owner      → final authority: results, returns, approvals (hands-off)
//   all        → admin: full access to everything (safety net + power users)

export type Role = "reception" | "operations" | "asset" | "owner" | "all";

/** The four real personas (excludes the "all" admin meta-view). */
export const PERSONA_ROLES: Exclude<Role, "all">[] = ["reception", "operations", "asset", "owner"];

export type RoleMeta = {
  id: Role;
  label: string;
  description: string;
  /** Screen to land on when this persona is selected. */
  home?: string;
};

export const ROLES: RoleMeta[] = [
  {
    id: "reception",
    label: "Recepción",
    description: "Cola de acciones, check-in/out 90s, tablero de habitaciones.",
    // FrontDeskDashboard ahora incluye el FrontDeskActionQueue como hero — es el cockpit.
    home: "FrontDeskDashboard"
  },
  {
    id: "operations",
    label: "Operaciones",
    description: "Vista consolidada cross-departamento: pisos, mantenimiento, equipo, F&B.",
    // OperationsDirectorScreen es estrictamente mejor que OperationsHome (card grid pasiva).
    home: "OperationsDirectorScreen"
  },
  {
    id: "asset",
    label: "Revenue y activos",
    description: "Ingresos, P&L, previsión y valor del activo.",
    home: "RevenueHomeDashboard"
  },
  {
    id: "owner",
    label: "Propietario",
    description: "Resultados, rentabilidad y aprobaciones.",
    home: "OwnerHome"
  },
  {
    id: "all",
    label: "Todo (admin)",
    description: "Acceso completo a toda la aplicación."
  }
];

const STORAGE_KEY = "hotelos.role.v1";

export function getActiveRole(): Role {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r && ROLES.some((x) => x.id === r)) return r as Role;
  } catch {
    /* localStorage unavailable */
  }
  return "reception";
}

export function setActiveRole(role: Role) {
  try {
    localStorage.setItem(STORAGE_KEY, role);
  } catch {
    /* ignore */
  }
  // Let the guidance layer react (e.g. offer this persona's tour first time).
  try {
    window.dispatchEvent(new CustomEvent("hotelos-role-changed", { detail: role }));
  } catch {
    /* SSR / no window */
  }
}

export function roleHome(role: Role): string | undefined {
  return ROLES.find((r) => r.id === role)?.home;
}
