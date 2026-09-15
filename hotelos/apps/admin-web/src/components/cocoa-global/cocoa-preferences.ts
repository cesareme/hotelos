// cocoa-preferences — the user preferences that reach <html> (COCOA-22.md
// §2.1 «Hallazgo bloqueante», §6 prohibiciones: «preferencia de acento de
// usuario»).
//
// One pure module shared by CocoaGlobalProvider (applies the stored prefs at
// mount and on every update) and CocoaPreferencesSheet (applies them live) so
// both converge on the same attributes of the document root.
//
// The accent is NOT a preference any more: the single chromatic accent is
// Esmeralda (`--accent` → `--cocoa-accent` in styles/cocoa-tokens.css). The
// legacy `accentColor` the API still stores and returns ("#007aff") is
// ignored on read, never sent on write, and the inline `--cocoa-accent`
// (and `--cocoa-background-selection`) that previous bundles wrote on <html>
// is removed on every apply — measured: the blue Apple accent painted
// «Nueva reserva», the avatar, the OTB line and every accent surface while
// the focus ring and the active menu item stayed Esmeralda.
//
// Everything here takes a `PreferenceRoot` (the subset of HTMLElement it
// touches) so the migration is unit-tested without a DOM.

export type CocoaThemePreference = "light" | "dark" | "auto";

export interface CocoaPreferences {
  themePreference: CocoaThemePreference;
  reducedMotion: boolean;
  highContrast: boolean;
}

export const DEFAULT_COCOA_PREFERENCES: Readonly<CocoaPreferences> = Object.freeze({
  themePreference: "auto",
  reducedMotion: false,
  highContrast: false
});

/** Keys the API may still return (or older callers still send); dropped. */
export const RETIRED_PREFERENCE_KEYS: readonly string[] = Object.freeze(["accentColor"]);

/** Inline custom properties older bundles wrote on <html>; removed on apply. */
export const LEGACY_ACCENT_INLINE_PROPERTIES: readonly string[] = Object.freeze(["--cocoa-accent", "--cocoa-background-selection"]);

const THEME_VALUES: ReadonlySet<string> = new Set<CocoaThemePreference>(["light", "dark", "auto"]);

export function isThemePreference(value: unknown): value is CocoaThemePreference {
  return typeof value === "string" && THEME_VALUES.has(value);
}

/**
 * Server payload (or anything) → preferences: only the known keys survive,
 * an invalid theme falls back to the default, retired keys (`accentColor`)
 * and unknown keys are dropped.
 */
export function normalizePreferences(raw: unknown, defaults: Readonly<CocoaPreferences> = DEFAULT_COCOA_PREFERENCES): CocoaPreferences {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    themePreference: isThemePreference(source.themePreference) ? source.themePreference : defaults.themePreference,
    reducedMotion: typeof source.reducedMotion === "boolean" ? source.reducedMotion : defaults.reducedMotion,
    highContrast: typeof source.highContrast === "boolean" ? source.highContrast : defaults.highContrast
  };
}

/** Patch → what goes on the wire: known keys with valid values, nothing else. */
export function sanitizePreferencePatch(patch: Record<string, unknown> | Partial<CocoaPreferences>): Partial<CocoaPreferences> {
  const source = patch as Record<string, unknown>;
  const out: Partial<CocoaPreferences> = {};
  if (isThemePreference(source.themePreference)) out.themePreference = source.themePreference;
  if (typeof source.reducedMotion === "boolean") out.reducedMotion = source.reducedMotion;
  if (typeof source.highContrast === "boolean") out.highContrast = source.highContrast;
  return out;
}

/** The slice of HTMLElement the appliers touch (testable without a DOM). */
export interface PreferenceRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: {
    getPropertyValue(name: string): string;
    removeProperty(name: string): string;
  };
}

export function documentRoot(): PreferenceRoot | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

/** True while an old bundle's inline accent still overrides the tokens. */
export function hasLegacyAccentOverride(root: PreferenceRoot): boolean {
  return LEGACY_ACCENT_INLINE_PROPERTIES.some((name) => root.style.getPropertyValue(name) !== "");
}

/** Migration: drop the inline accent overrides; returns whether any was there. */
export function clearLegacyAccentOverride(root: PreferenceRoot): boolean {
  let removed = false;
  for (const name of LEGACY_ACCENT_INLINE_PROPERTIES) {
    if (root.style.getPropertyValue(name) !== "") removed = true;
    root.style.removeProperty(name);
  }
  return removed;
}

// `data-theme`: "light" / "dark" force a token set; "auto" leaves the OS
// media query in charge (cocoa-tokens.css: `:root:not([data-theme="light"])`).
export function applyThemePreference(root: PreferenceRoot, value: CocoaThemePreference): void {
  root.setAttribute("data-theme", value);
}

export function applyReducedMotion(root: PreferenceRoot, enabled: boolean): void {
  if (enabled) root.setAttribute("data-reduced-motion", "true");
  else root.removeAttribute("data-reduced-motion");
}

export function applyHighContrast(root: PreferenceRoot, enabled: boolean): void {
  if (enabled) root.setAttribute("data-high-contrast", "true");
  else root.removeAttribute("data-high-contrast");
}

/** Apply every preference and run the accent migration (idempotent). */
export function applyPreferencesToRoot(root: PreferenceRoot, prefs: CocoaPreferences): void {
  clearLegacyAccentOverride(root);
  applyThemePreference(root, prefs.themePreference);
  applyReducedMotion(root, prefs.reducedMotion);
  applyHighContrast(root, prefs.highContrast);
}
