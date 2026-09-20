import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Cocoa 22 · shell contract (COCOA-22.md §2 tokens, §3.1 shell, §6
// prohibitions, §9 rule 14). Source-level checks — no DOM — over the files of
// the «shell» lot: layout, sidebar, provider, preferences sheet and the public
// auth screens. (The never-routed CocoaOnboardingWizard it also read was
// retired as a dead file in Cocoa 22 · ola 10 · lote 10-C, plan §2.5.)

const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const layout = src("layouts/BackOfficeLayout.tsx");
const sidebar = src("navigation/Sidebar.tsx");
const shellSheet = src("styles/cocoa-22-shell.css");
const provider = src("providers/CocoaGlobalProvider.tsx");
const sheet = src("components/cocoa-global/CocoaPreferencesSheet.tsx");
const login = src("screens/auth/LoginScreen.tsx");
const forgot = src("screens/auth/ForgotPasswordScreen.tsx");
const cocoaGlobal = [
  "CocoaCommandPalette",
  "CocoaAboutDialog",
  "CocoaKeyboardShortcutsHelp",
  "CocoaNotificationCenter",
  "CocoaThemeToggle",
  "CocoaQuickActionsBar"
].map((name) => [name, src(`components/cocoa-global/${name}.tsx`)] as const);

// Literal colours: #hex, rgb()/hsl(), and `var(--x, #…)` fallbacks (§1 rule 8).
const COLOUR_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/;
const NUMERIC_Z_INDEX = /zIndex:\s*\d/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Property names of an inline `style={{ … }}` object (commas inside parentheses do not split). */
function styleProps(inner: string): string[] {
  const props: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      props.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  props.push(current);
  return props.map((entry) => entry.trim().split(":")[0].trim()).filter(Boolean);
}

describe("§9 rule 14 · the accent is not a preference", () => {
  it("CocoaGlobalProvider never writes --cocoa-accent and has no accentColor default", () => {
    assert.doesNotMatch(provider, /setProperty\(\s*["']--cocoa-accent/);
    assert.doesNotMatch(provider, /accentColor:\s*["']#/);
    assert.match(provider, /from "\.\.\/components\/cocoa-global\/cocoa-preferences"/);
    assert.match(provider, /clearLegacyAccentOverride\(root\)/, "the migration runs at mount");
    assert.match(provider, /normalizePreferences\(data/);
    assert.match(provider, /sanitizePreferencePatch\(partial\)/);
  });

  it("CocoaPreferencesSheet has no colour well and no accent section; copy is Spanish", () => {
    assert.doesNotMatch(stripComments(sheet), /CocoaColorWell|accentColor|Color de acento/);
    assert.doesNotMatch(sheet, /setProperty\(\s*["']--cocoa-accent/);
    assert.match(sheet, /label: "Apariencia"/);
    assert.doesNotMatch(sheet, /"Appearance"|"Notifications"|"Privacy"|"Advanced"|Proximamente|Automatico/);
  });
});

describe("§2 tokens · no literal colours, no numeric z-index in the shell", () => {
  for (const [name, source] of [
    ["layouts/BackOfficeLayout.tsx", layout],
    ["navigation/Sidebar.tsx", sidebar],
    ["providers/CocoaGlobalProvider.tsx", provider],
    ["components/cocoa-global/CocoaPreferencesSheet.tsx", sheet],
    ["screens/auth/LoginScreen.tsx", login],
    ["screens/auth/ForgotPasswordScreen.tsx", forgot],
    ...cocoaGlobal.map(([n, s]) => [`components/cocoa-global/${n}.tsx`, s] as const)
  ] as const) {
    it(`${name} has no colour literal`, () => {
      assert.doesNotMatch(stripComments(source), COLOUR_LITERAL);
    });
    it(`${name} has no numeric zIndex (uses --cocoa-z-*)`, () => {
      // CocoaQuickActionsBar / the sheet's close button use a local stacking
      // index of 1 (not a layer of the app): allowed.
      assert.doesNotMatch(stripComments(source).replace(/zIndex:\s*1[,\s]/g, ""), NUMERIC_Z_INDEX);
    });
  }

  it("the layout uses the accent / warning washes of the tokens for its banners (no --cocoa-accent-soft fallback)", () => {
    assert.doesNotMatch(layout, /--cocoa-accent-soft|--cocoa-warning-soft/);
    assert.match(layout, /background: "var\(--cocoa-accent-bg\)"/);
    assert.match(layout, /background: "var\(--cocoa-warning-bg\)"/);
  });

  it("the shell sheet (sidebar skin + layout chrome) and the layout consume --cocoa-* tokens only (no Aurora --ink/--line/--surface/--accent)", () => {
    assert.doesNotMatch(shellSheet, /var\(--(?:ink|line|surface|accent|radius|space|shadow|duration|ease|sidebar-w|topbar-h)\b[^)]*\)/);
    assert.doesNotMatch(sidebar, /<style\b|SIDEBAR_CSS/, "R11: the sidebar injects no inline style element");
    assert.doesNotMatch(layout, /<style\b|LAYOUT_CSS/, "R11: the layout injects no inline style element");
    assert.doesNotMatch(layout, /var\(--(?:ink|line|surface|radius|space|shadow)\b/);
  });
});

describe("§3.1 shell · toolbar controls are CocoaButtons with tap targets", () => {
  it("no raw <button> is left in the toolbar chrome (menu / listbox rows excepted, they carry role + focus ring)", () => {
    const rawButtons = stripComments(layout).match(/<button\b[^>]*>/gs) ?? [];
    for (const tag of rawButtons) {
      assert.match(tag, /role="(?:menuitem|option)"/, `raw <button> without a menu role: ${tag.slice(0, 80)}`);
      assert.match(tag, /cocoa-focus-ring/, `menu row without the focus ring: ${tag.slice(0, 80)}`);
    }
    assert.match(layout, /function ToolbarIconButton\(/);
    assert.match(layout, /variant="bordered"\s+tone="neutral"\s+size="large"/);
    assert.match(layout, /minWidth: coarse \? TAP_TARGET_PX : TOOLBAR_ICON_PX/);
    assert.match(layout, /const TOOLBAR_ICON_PX = 32;/);
  });

  it("every icon-only control names itself and the guide hooks survive", () => {
    for (const label of ["Abrir el menú", "Abrir la búsqueda (⌘K)", "Centro de ayuda", "Cambiar tema (claro/oscuro)", "Menú de usuario", "Nueva reserva"]) {
      assert.match(layout, new RegExp(`aria-label=(?:"${label.replace(/[()]/g, "\\$&")}"|\\{label\\})`), `missing aria-label ${label}`);
    }
    for (const hook of ["property", "search", "notifications", "help", "theme-toggle", "new-reservation"]) {
      assert.match(layout, new RegExp(`data-tour="${hook}"`), `missing data-tour ${hook}`);
    }
  });

  it("the compact toolbar is a Cocoa toolbar (material, layer, safe-area) and the drawer/scrim use the layer tokens", () => {
    assert.match(layout, /data-cocoa="toolbar" data-variant="window"/);
    assert.match(layout, /zIndex: "var\(--cocoa-z-toolbar\)"/);
    assert.match(layout, /paddingTop: "env\(safe-area-inset-top\)"/);
    assert.match(shellSheet, /\.cocoa-shell > \.c22-sidebar \{ z-index: var\(--cocoa-z-sidebar\);/);
    assert.match(shellSheet, /\.cocoa-shell > \.c22-scrim \{ z-index: calc\(var\(--cocoa-z-sidebar\) - 1\); background: var\(--cocoa-scrim\);/);
    assert.match(layout, /boxShadow: "var\(--cocoa-shadow-popover\)"/, "dropdown menus use the popover shadow");
  });
});

describe("§3.8 auth screens · Cocoa primitives, no raw controls", () => {
  for (const [name, source] of [
    ["LoginScreen", login],
    ["ForgotPasswordScreen", forgot]
  ] as const) {
    it(`${name} has no raw <button>/<input>/<h1>, no .bo-* class, and layout-only style={}`, () => {
      assert.doesNotMatch(source, /<button\b|<input\b|<h1\b|<select\b|<textarea\b/);
      assert.doesNotMatch(source, /className="bo-|\bbo-card\b|bo-form-field|bo-button-link/);
      assert.match(source, /<CocoaField\b/);
      assert.match(source, /<CocoaInput\b/);
      assert.match(source, /<CocoaButton\b/);
      const props = [...source.matchAll(/style=\{\{([^}]*)\}\}/g)].flatMap((m) => styleProps(m[1]));
      const allowed = /^(display|flexDirection|gap|alignItems|justifyContent|width|maxWidth|minHeight|padding|paddingBottom|marginTop|boxSizing)$/;
      for (const prop of props) assert.match(prop, allowed, `${name}: non-layout style prop ${prop}`);
    });
  }

  it("LoginScreen keeps its auth logic and paints a CocoaPageHeader inside an elevated card", () => {
    assert.match(login, /fetch\(`\$\{apiBase\(\)\}\/auth\/login`/);
    assert.match(login, /Cuenta bloqueada temporalmente/);
    assert.match(login, /<CocoaCard\s+variant="elevated"/);
    assert.match(login, /<CocoaPageHeader eyebrow=\{AUTH_EYEBROW\} title="Inicia sesión"/);
    assert.match(login, /<CocoaState kind="error" inline role="alert"/);
  });
});
