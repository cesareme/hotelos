// «Ver como…» (Tanda 5 · §8 · L1c): the platform administrator simulates the
// menu FILTER of one hotel role. The simulated token lives in memory for the
// tab (never localStorage, never the API permissions) and is applied by
// `useNavGate` (navigation/useEnabledModules.ts), so the Sidebar, ⌘K, the tab
// containers and the guide all share it — before L1c only the Sidebar did.
// The simulation ends when the session ends or another user signs in.

import { useSyncExternalStore } from "react";
import { getUser, onAuthChange } from "../services/auth-storage";
import { isRoleToken, type RoleToken } from "./role-tokens";

let current: RoleToken | null = null;
let ownerUserId: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Simulated token, or null when the administrator sees their own menu. */
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
};

export type ViewAsGateResult = ViewAsGateInput & {
  /** The token being simulated, or null (real gate). */
  viewAs: RoleToken | null;
  /** The real tokens of the session (the Sidebar landing badge and the tests read them). */
  realTokens: RoleToken[];
};

/**
 * Pure: the gate the consumers must apply. Only the platform administrator
 * can simulate; a simulation replaces the tokens with the chosen one, drops
 * the landing template and hides «Activar módulo» (the simulated role would
 * not have `modules.enable`).
 */
export function applyViewAs(gate: ViewAsGateInput, viewAs: RoleToken | null): ViewAsGateResult {
  if (!gate.isPlatformAdmin || !viewAs) return { ...gate, viewAs: null, realTokens: gate.tokens };
  return {
    tokens: [viewAs],
    templateKey: null,
    isPlatformAdmin: gate.isPlatformAdmin,
    canEnableModules: false,
    viewAs,
    realTokens: gate.tokens
  };
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
