import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cycleThemePreference, getThemePreference, initTheme, resolveTheme, setThemePreference } from "../theme.ts";

// Cocoa 22 · qa#22 (COCOA-22-MIGRACION.md §4.3 V4 and the §5.4 probe
// `htmlInlineCocoa`): theme.ts only flips <html data-theme>; `color-scheme`
// is declared by styles/cocoa-tokens.css from that attribute, so the root
// never receives an inline `style` from the theme controller.

interface FakeRoot {
  attrs: Map<string, string>;
  styleWrites: string[];
  style: Record<string, unknown>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function fakeRoot(): FakeRoot {
  const attrs = new Map<string, string>();
  const styleWrites: string[] = [];
  const style = new Proxy({} as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop === "setProperty") return (name: string) => { styleWrites.push(name); };
      if (prop === "removeProperty") return () => "";
      if (prop === "getPropertyValue") return () => "";
      return target[String(prop)];
    },
    set: (_target, prop) => {
      styleWrites.push(String(prop));
      return true;
    }
  });
  return {
    attrs,
    styleWrites,
    style,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => { attrs.set(name, value); },
    removeAttribute: (name) => { attrs.delete(name); }
  };
}

const globals = globalThis as Record<string, unknown>;
let root: FakeRoot;
let storage: Map<string, string>;
let osDark = false;
let mediaListeners = 0;

beforeEach(() => {
  root = fakeRoot();
  storage = new Map();
  osDark = false;
  mediaListeners = 0;
  globals.document = { documentElement: root };
  globals.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); }
  };
  globals.matchMedia = () => ({
    get matches() { return osDark; },
    addEventListener: () => { mediaListeners += 1; },
    addListener: () => { mediaListeners += 1; }
  });
});

afterEach(() => {
  delete globals.document;
  delete globals.localStorage;
  delete globals.matchMedia;
});

describe("theme · <html> carries data-theme only (V4)", () => {
  it("boots without touching <html style> and registers no OS listener (CSS follows prefers-color-scheme)", () => {
    initTheme();
    assert.equal(root.getAttribute("data-theme"), null, "system → attribute removed");
    assert.deepEqual(root.styleWrites, []);
    assert.equal(mediaListeners, 0);
  });

  it("forced light / dark set the attribute, persist the choice and write nothing inline", () => {
    setThemePreference("dark");
    assert.equal(root.getAttribute("data-theme"), "dark");
    assert.equal(storage.get("hotelos.theme"), "dark");
    setThemePreference("light");
    assert.equal(root.getAttribute("data-theme"), "light");
    assert.equal(storage.get("hotelos.theme"), "light");
    assert.deepEqual(root.styleWrites, []);
  });

  it("system removes the attribute and the stored key; resolveTheme still follows the OS", () => {
    setThemePreference("dark");
    setThemePreference("system");
    assert.equal(root.getAttribute("data-theme"), null);
    assert.equal(storage.has("hotelos.theme"), false);
    assert.equal(getThemePreference(), "system");
    assert.equal(resolveTheme(), "light");
    osDark = true;
    assert.equal(resolveTheme(), "dark");
    assert.deepEqual(root.styleWrites, []);
  });

  it("cycles light → dark → system → light", () => {
    setThemePreference("light");
    assert.equal(cycleThemePreference(), "dark");
    assert.equal(cycleThemePreference(), "system");
    assert.equal(cycleThemePreference(), "light");
    assert.deepEqual(root.styleWrites, []);
  });

  it("source contract: theme.ts has no inline style write on the root", () => {
    const source = readFileSync(new URL("../theme.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.style\.(colorScheme|cssText|setProperty)/, "color-scheme is owned by styles/cocoa-tokens.css");
    assert.doesNotMatch(source, /setAttribute\(\s*["']style["']/);
  });
});
