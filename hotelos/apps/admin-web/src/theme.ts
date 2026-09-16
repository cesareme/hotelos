// Theme controller for the Back Office (light / dark / system).
//
// The actual colours live in `styles/cocoa-tokens.css` (Cocoa 22 tokens; the
// legacy Aurora set in `styles.css` mirrors the same scopes). This module only
// flips the `data-theme` attribute on <html> and persists the choice:
//   - "light"  → force the light token set (ignore OS preference)
//   - "dark"   → force the dark token set (ignore OS preference)
//   - "system" → follow the OS via `@media (prefers-color-scheme: dark)`
//
// CSS contract (see styles/cocoa-tokens.css):
//   :root                    { color-scheme: light; …light tokens… }
//   :root[data-theme="dark"] { color-scheme: dark;  …dark tokens… }
//   @media (prefers-color-scheme: dark) {
//     :root:not([data-theme="light"]) { color-scheme: dark; …dark tokens… }
//   }
// So "system" is represented by REMOVING the attribute, and `color-scheme`
// (native form controls, scrollbars) is derived by the stylesheet from that
// attribute: nothing here writes to `<html style>`. The migration plan's V4
// criterion and §5.4 probe (COCOA-22-MIGRACION.md) expect the root without
// any inline `--cocoa-*`; the only inline the root may carry is
// `--hotelos-toast-offset`, published by `CocoaActionBar publishToastOffset`.

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "hotelos.theme";

export function getThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function prefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  if (pref === "system") return prefersDark() ? "dark" : "light";
  return pref;
}

/** Reflect the preference onto <html data-theme>; the stylesheet derives `color-scheme` from it. */
function reflect(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
}

export function setThemePreference(pref: ThemePreference): void {
  if (typeof localStorage !== "undefined") {
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  }
  reflect(pref);
}

/** Cycle light → dark → system → light. Returns the new preference. */
export function cycleThemePreference(): ThemePreference {
  const order: ThemePreference[] = ["light", "dark", "system"];
  const next = order[(order.indexOf(getThemePreference()) + 1) % order.length];
  setThemePreference(next);
  return next;
}

/**
 * Call once on boot (before first paint) to avoid a flash of the wrong theme.
 * No OS listener is needed: in "system" mode the attribute is absent and the
 * `prefers-color-scheme` media query of the stylesheet follows the OS live.
 */
export function initTheme(): void {
  reflect(getThemePreference());
}
