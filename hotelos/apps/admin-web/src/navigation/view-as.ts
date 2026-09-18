// «Ver como…» (Tanda 5 · §8 · L1c; Tanda 8a · L4 «por ámbito»): whoever manages
// users in the active scope simulates the menu FILTER of one hotel role. The
// simulated token lives in memory for the tab (never localStorage, never the
// API permissions) and is applied by `useNavGate` (navigation/useEnabledModules.ts),
// so the Sidebar, ⌘K, the tab containers, the guide and the router gate of
// App.tsx all share it — before L1c only the Sidebar did.
//
// Who may simulate (design §5.3): the platform administrator, and any user
// whose real grants in the active property include `users.assign` or
// `roles.manage` (`canViewAs`, computed in useEnabledModules.ts — never here,
// never in role-tokens.ts). What they may simulate: the tokens whose templates
// they could assign, i.e. of rank ≤ their own (`maxViewAsRank`, the highest
// ROLE_LEVEL_RANK of the templates they hold in the property); the platform
// administrator may simulate every hotel token. A simulation replaces tokens
// and modules-derived state only — permissions stay the API's business.
// The simulation ends when the session ends or another user signs in.

import { useSyncExternalStore } from "react";
import { getUser, onAuthChange } from "../services/auth-storage";
import { ROLE_TEMPLATE_KEYS_MAPPED, ROLE_TEMPLATE_TO_TOKEN, ROLE_TOKEN_PRIORITY, isRoleToken, type RoleTemplateKey, type RoleToken } from "./role-tokens";

let current: RoleToken | null = null;
let ownerUserId: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Simulated token, or null when the user sees their own menu. */
export function getViewAs(): RoleToken | null {
  return current;
}

/** Start (token) or end (`""`/null) the simulation. Unknown values end it. */
export function setViewAs(token: RoleToken | "" | null): void {
  const next = token && isRoleToken(token) ? token : null;
  ownerUserId = next ? (getUser()?.userId ?? null) : null;
  if (next === current) return;
  current = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function serverSnapshot(): RoleToken | null {
  return null;
}

/** Reactive simulated token (null when not simulating). */
export function useViewAs(): RoleToken | null {
  return useSyncExternalStore(subscribe, getViewAs, serverSnapshot);
}

export type ViewAsGateInput = {
  tokens: RoleToken[];
  templateKey: string | null;
  isPlatformAdmin: boolean;
  canEnableModules: boolean;
  /** The user manages users in the active scope (platform admin, `users.assign` or `roles.manage`): may simulate. */
  canViewAs: boolean;
  /** Highest ROLE_LEVEL_RANK of the templates held in the property (null = unknown / platform admin): caps the tokens offered. */
  maxViewAsRank: number | null;
};

export type ViewAsGateResult = ViewAsGateInput & {
  /** The token being simulated, or null (real gate). */
  viewAs: RoleToken | null;
  /** The real tokens of the session (the Sidebar landing badge and the tests read them). */
  realTokens: RoleToken[];
};

/**
 * Pure: the gate the consumers must apply. Only a user who manages users in
 * the scope (`canViewAs`) can simulate; a simulation replaces the tokens with
 * the chosen one, drops the landing template and hides «Activar módulo» (the
 * simulated role would not have `modules.enable`). Never the permissions.
 */
export function applyViewAs(gate: ViewAsGateInput, viewAs: RoleToken | null): ViewAsGateResult {
  if (!gate.canViewAs || !viewAs) return { ...gate, viewAs: null, realTokens: gate.tokens };
  return {
    tokens: [viewAs],
    templateKey: null,
    isPlatformAdmin: gate.isPlatformAdmin,
    canEnableModules: false,
    canViewAs: gate.canViewAs,
    maxViewAsRank: gate.maxViewAsRank,
    viewAs,
    realTokens: gate.tokens
  };
}

/** Rank of a template (ROLE_LEVEL_RANK over ROLE_TEMPLATE_LEVEL), injected so this module stays free of @hotelos/shared. */
export type TemplateRankMap = Readonly<Record<string, number>>;

/** Tokens «Ver como…» never offers: the platform token and the public one. */
const NEVER_OFFERED: readonly RoleToken[] = ["admin", "publico"];

/** Lowest rank among the templates behind a token (the cheapest template someone must be able to assign to simulate it); Infinity when none is ranked. */
export function tokenMinRank(token: RoleToken, ranks: TemplateRankMap): number {
  let min = Number.POSITIVE_INFINITY;
  for (const template of ROLE_TEMPLATE_KEYS_MAPPED as readonly RoleTemplateKey[]) {
    if (template === "break_glass" || ROLE_TEMPLATE_TO_TOKEN[template] !== token) continue;
    const rank = ranks[template];
    if (typeof rank === "number" && rank < min) min = rank;
  }
  return min;
}

/**
 * Tokens offered by «Ver como…» for a gate (design §5.3 «limitado a las
 * plantillas de nivel ≤ el propio»): every hotel token for the platform
 * administrator; otherwise the tokens with at least one template of rank ≤
 * `maxViewAsRank`. Broadest first (ROLE_TOKEN_PRIORITY); never `admin` nor
 * `publico`; empty when the user may not simulate.
 */
export function viewAsTokensFor(gate: Pick<ViewAsGateInput, "canViewAs" | "isPlatformAdmin" | "maxViewAsRank">, ranks: TemplateRankMap): RoleToken[] {
  if (!gate.canViewAs) return [];
  const offered = ROLE_TOKEN_PRIORITY.filter((token) => !NEVER_OFFERED.includes(token));
  if (gate.isPlatformAdmin) return offered;
  const max = gate.maxViewAsRank;
  if (max === null) return [];
  return offered.filter((token) => tokenMinRank(token, ranks) <= max);
}

// Another session must never inherit the simulation (logout, or a different
// user signing in on the same tab).
if (typeof window !== "undefined") {
  onAuthChange(() => {
    if (current === null) return;
    const userId = getUser()?.userId ?? null;
    if (!userId || userId !== ownerUserId) setViewAs(null);
  });
}
