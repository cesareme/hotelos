// Tiny persistence + event bus for the in-app guidance system.
// No external state library: localStorage for "have they seen it" and window
// CustomEvents so the top-bar "?" button (or anything else) can open the guide.

const STORAGE_KEY = "hotelos.guide.v1";

export type GuideState = {
  tourCompleted: boolean;
  welcomeDismissed: boolean;
  /** Roles whose first-time tour offer has already been shown/dismissed. */
  seenRoles: string[];
};

const DEFAULT_STATE: GuideState = { tourCompleted: false, welcomeDismissed: false, seenRoles: [] };

export function getGuideState(): GuideState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<GuideState>) };
  } catch {
    /* localStorage unavailable (private mode, etc.) — fall back to defaults */
  }
  return { ...DEFAULT_STATE };
}

export function setGuideState(patch: Partial<GuideState>): GuideState {
  const next = { ...getGuideState(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore write failures */
  }
  return next;
}

export function hasSeenRole(role: string): boolean {
  return getGuideState().seenRoles.includes(role);
}
export function markRoleSeen(role: string) {
  const state = getGuideState();
  if (!state.seenRoles.includes(role)) {
    setGuideState({ seenRoles: [...state.seenRoles, role] });
  }
}

export const GUIDE_EVENTS = {
  openHelp: "hotelos-open-help",
  startTour: "hotelos-start-tour",
  /** Fired by the sidebar role switcher (detail = role id). */
  roleChanged: "hotelos-role-changed"
} as const;

/** Open the Help center slide-over (the "?" panel). */
export function openHelpCenter() {
  window.dispatchEvent(new CustomEvent(GUIDE_EVENTS.openHelp));
}

/** Start (or restart) a guided tour. Defaults to the welcome tour. */
export function startGuidedTour(tourId?: string) {
  window.dispatchEvent(new CustomEvent(GUIDE_EVENTS.startTour, { detail: tourId }));
}
