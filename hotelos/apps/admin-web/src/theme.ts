// Theme controller for the Back Office (light / dark / system).
//
// The actual colors live in styles.css as CSS custom properties. This module
// only flips the `data-theme` attribute on <html> and persists the choice:
//   - "light"  → force the light token set (ignore OS preference)
//   - "dark"   → force the dark token set (ignore OS preference)
//   - "system" → follow the OS via `@media (prefers-color-scheme: dark)`
//
// CSS contract (see styles.css):
//   :root[data-theme="dark"] { …dark tokens… }
//   @media (prefers-color-scheme: dark) {
//     :root:not([data-theme="light"]) { …dark tokens… }
//   }
// So "system" is represented by REMOVING the attribute.

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

/** Reflect the preference onto <html data-theme> and color-scheme. */
function reflect(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
  // Keep native form controls / scrollbars in sync.
  root.style.colorScheme = resolveTheme(pref);
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

/** Call once on boot (before first paint) to avoid a flash of the wrong theme. */
export function initTheme(): void {
  const pref = getThemePreference();
  reflect(pref);
  // React to OS changes while in "system" mode.
  if (typeof matchMedia !== "undefined") {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (getThemePreference() === "system") reflect("system");
    };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else if (typeof mq.addListener === "function") mq.addListener(onChange);
  }
}
