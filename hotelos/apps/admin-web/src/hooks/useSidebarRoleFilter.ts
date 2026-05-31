import { useMemo } from "react";

/**
 * Generic sidebar item gated by an optional `rolesAllowed` allowlist.
 * - `rolesAllowed` undefined / empty → visible to everyone.
 * - Otherwise visible only if `userRole` is in the list.
 *
 * The constraint is intentionally minimal so callers can pass richer item
 * shapes (with `id`/`label`/etc.) without conforming to a wider contract.
 */
export type RoleGatedItem = {
  rolesAllowed?: string[];
};

/**
 * Generic sidebar group containing role-gated items. Groups themselves can
 * also carry a `rolesAllowed` allowlist that gates the entire group.
 *
 * `items` is typed as `unknown[]` because individual sidebar configurations
 * may or may not expose `rolesAllowed` on their items; we read it via a safe
 * runtime check inside `itemVisible` rather than forcing every item shape to
 * extend `RoleGatedItem`.
 */
export type RoleGatedGroup = {
  items?: unknown[];
  rolesAllowed?: string[];
};

function readRolesAllowed(value: unknown): string[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as { rolesAllowed?: unknown }).rolesAllowed;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function itemVisible(item: unknown, userRole: string): boolean {
  const roles = readRolesAllowed(item);
  if (!roles || roles.length === 0) return true;
  return roles.includes(userRole);
}

function groupGateAllows(group: RoleGatedGroup, userRole: string): boolean {
  if (!group.rolesAllowed || group.rolesAllowed.length === 0) return true;
  return group.rolesAllowed.includes(userRole);
}

/**
 * Filters sidebar groups and their items by a user's role.
 *
 * Rules:
 * - If `userRole` is missing/empty or is "admin", the original groups are
 *   returned untouched (no filtering applied).
 * - A group whose own `rolesAllowed` excludes the role is dropped entirely.
 * - Items within a group are filtered by their own `rolesAllowed`.
 * - Groups that end up with zero items after filtering are omitted from the
 *   result so the sidebar never renders an empty section header.
 */
export function useSidebarRoleFilter<G extends RoleGatedGroup>(
  allGroups: G[],
  userRole?: string
): G[] {
  return useMemo(() => {
    if (!userRole || userRole === "admin") return allGroups;

    // Defensive fall-through: if the user's role is not present in ANY group's
    // or item's `rolesAllowed`, treat it as an unrecognised role and return
    // the full sidebar instead of hiding everything. Role names occasionally
    // drift between backend and config (e.g. "general_manager" vs "manager"),
    // and silently filtering to an empty sidebar is worse than over-showing.
    const knownRoles = new Set<string>();
    for (const group of allGroups) {
      if (group.rolesAllowed) {
        for (const role of group.rolesAllowed) knownRoles.add(role);
      }
      for (const item of group.items ?? []) {
        const itemRoles = readRolesAllowed(item);
        if (itemRoles) {
          for (const role of itemRoles) knownRoles.add(role);
        }
      }
    }
    if (!knownRoles.has(userRole)) return allGroups;

    const filtered: G[] = [];
    for (const group of allGroups) {
      if (!groupGateAllows(group, userRole)) continue;
      const items = (group.items ?? []).filter((item) => itemVisible(item, userRole));
      if (items.length === 0) continue;
      filtered.push({ ...group, items } as G);
    }
    return filtered;
  }, [allGroups, userRole]);
}
