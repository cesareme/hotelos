// Sidebar group preferences (Tanda 5 · L1c).
//
// Every category starts EXPANDED (the Cocoa sidebar idiom: Finder, Mail and
// Notes show their sections open and remember what the user collapses), so
// the twenty frequent tasks of pilots/tanda5-nav-tree.md §11 stay at ≤ 2
// clicks from Mi día (an item is one click, a tab two). A group the user
// collapses stays collapsed in this browser (localStorage) until they open it
// again — except when they navigate INTO it: the group that holds the active
// screen opens on arrival so the user always sees where they are.
//
// «Ver como…» is NOT stored here (in memory only, navigation/view-as.ts).

export const NAV_GROUPS_STORAGE_KEY = "anfitorio.nav.groups";

/** Explicit toggles by category key: `false` = collapsed by the user, `true` = opened by the user. */
export type GroupToggles = Readonly<Record<string, boolean>>;

export function readGroupToggles(): GroupToggles {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NAV_GROUPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeGroupToggles(next: GroupToggles): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the toggles live for the tab only */
  }
}

export type GroupOpenInput = {
  key: string;
  toggled: GroupToggles;
  /** The user is searching the menu: every matching group is open. */
  searching: boolean;
};

/** Pure: open while searching, else the explicit toggle, else expanded by default. */
export function isGroupOpen(input: GroupOpenInput): boolean {
  if (input.searching) return true;
  const explicit = input.toggled[input.key];
  return explicit === undefined ? true : explicit;
}

/** Pure: the toggles after arriving at `activeCategoryKey` (a collapsed group opens when the user navigates into it). */
export function togglesOnArrival(toggled: GroupToggles, activeCategoryKey: string | null | undefined): GroupToggles {
  if (!activeCategoryKey || toggled[activeCategoryKey] !== false) return toggled;
  const next: Record<string, boolean> = { ...toggled };
  delete next[activeCategoryKey];
  return next;
}

/** Pure: the toggles after the user clicks the head of `key` (the new state is the opposite of what they saw). */
export function toggleGroup(toggled: GroupToggles, key: string, wasOpen: boolean): GroupToggles {
  return { ...toggled, [key]: !wasOpen };
}
