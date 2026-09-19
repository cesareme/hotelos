import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { nextSegmentValue, segmentItemStyle, segmentedOverflows, tabSurfaceStyle } from "../CocoaSegmentedControl.tsx";
import { routeTabStyle } from "../CocoaRouteTabs.tsx";
import { computePosition } from "../CocoaPopover.tsx";
import { switchThumbOffset } from "../CocoaSwitch.tsx";
import { CONTROL_HEIGHT_BY_SIZE, controlChrome, inputPaddingY } from "../CocoaInput.tsx";
import { selectControlHeight } from "../CocoaSelect.tsx";
import { buttonForeground } from "../CocoaButton.tsx";
import { headerTitleStyle } from "../CocoaPageHeader.tsx";
import { cardRestingShadow } from "../CocoaCard.tsx";
import { clampStep } from "../CocoaStepper.tsx";
import { DONUT_PALETTE, MIN_LINE_WIDTH, SERIES_TONE_ORDER, donutShareLabel, donutSliceColor, gaugeToneLabel, lineViewBoxWidth, seriesStroke, seriesToneName } from "../CocoaChart.tsx";
import { calloutRole } from "../CocoaCallout.tsx";
import { arithmeticPreview, isArithmeticKey, parseDateArithmetic, shiftIsoDay } from "../CocoaDatePicker.tsx";
import { degradedBannerLabel } from "../../cocoa-extras/DegradedValue.tsx";
import { MIN_VIEWBOX_WIDTH, VIEWBOX_WIDTH, paceViewBoxWidth } from "../../cocoa-director/DirectorForwardPaceChart.tsx";

describe("CocoaSegmentedControl · keyboard", () => {
  const values = ["dia", "semana", "mes"];
  it("arrows wrap, Home/End jump, other keys are ignored", () => {
    assert.equal(nextSegmentValue("dia", values, "ArrowRight"), "semana");
    assert.equal(nextSegmentValue("mes", values, "ArrowRight"), "dia");
    assert.equal(nextSegmentValue("dia", values, "ArrowLeft"), "mes");
    assert.equal(nextSegmentValue("semana", values, "ArrowUp"), "dia");
    assert.equal(nextSegmentValue("semana", values, "ArrowDown"), "mes");
    assert.equal(nextSegmentValue("mes", values, "Home"), "dia");
    assert.equal(nextSegmentValue("dia", values, "End"), "mes");
    assert.equal(nextSegmentValue("dia", values, "Enter"), null);
    assert.equal(nextSegmentValue("dia", [], "ArrowRight"), null);
  });
  it("starts from the first option when the current value is unknown", () => {
    assert.equal(nextSegmentValue("nope", values, "ArrowRight"), "semana");
  });
});

describe("CocoaSegmentedControl · overflow fade (fix:2-A qa#5)", () => {
  it("fades only when the content is wider than the box (1 px tolerance)", () => {
    assert.equal(segmentedOverflows(420, 324), true); // /hoy/operaciones «Detalle» at 390
    assert.equal(segmentedOverflows(324, 324), false);
    assert.equal(segmentedOverflows(325, 324), false);
    assert.equal(segmentedOverflows(326, 324), true);
  });
});

describe("CocoaPopover · position", () => {
  const anchor = { top: 100, left: 200, right: 240, bottom: 130, width: 40, height: 30 };
  const box = { width: 120, height: 60 };
  it("offsets 8 px from the anchor edge and centres on the anchor", () => {
    assert.deepEqual(computePosition(anchor, box, "bottom"), { top: 138, left: 160 });
    assert.deepEqual(computePosition(anchor, box, "top"), { top: 32, left: 160 });
    assert.deepEqual(computePosition(anchor, box, "right"), { top: 85, left: 248 });
    assert.deepEqual(computePosition(anchor, box, "left"), { top: 85, left: 72 });
  });
});

describe("CocoaSwitch · thumb", () => {
  it("slides between the padding and the far edge", () => {
    const regular = { trackWidth: 52, trackHeight: 32, thumbSize: 28, padding: 2 };
    assert.equal(switchThumbOffset(false, regular), 2);
    assert.equal(switchThumbOffset(true, regular), 22);
    const small = { trackWidth: 36, trackHeight: 24, thumbSize: 20, padding: 2 };
    assert.equal(switchThumbOffset(true, small), 14);
    // L-07 (2.5.8): el switch `small` mide ≥ 24 px con ratón; el segmentado `small` también.
    const switchSource = readFileSync(new URL("../CocoaSwitch.tsx", import.meta.url), "utf8");
    assert.match(switchSource, /small: \{ trackWidth: 36, trackHeight: 24, thumbSize: 20, padding: 2 \}/);
    const segmented = readFileSync(new URL("../CocoaSegmentedControl.tsx", import.meta.url), "utf8");
    assert.match(segmented, /export const SEGMENT_MIN_HEIGHT_PX = 24;/);
    assert.doesNotMatch(segmented, /minHeight: SEGMENT_MIN_HEIGHT_PX/, "en la hoja, no en línea: la capa táctil (44) debe ganar");
    const cocoaCss = readFileSync(new URL("../../../styles/cocoa-22.css", import.meta.url), "utf8");
    assert.match(cocoaCss, /:where\(\[data-cocoa="segmented"\]\) \[role="tab"\] \{ min-height: 24px; \}/);
  });
});

describe("CocoaInput · control chrome (§3.8)", () => {
  it("separator at rest, accent + focus ring on focus, danger + danger halo on error", () => {
    assert.deepEqual(controlChrome({ focused: false, error: false }), { borderColor: "var(--cocoa-separator)", boxShadow: "none" });
    assert.deepEqual(controlChrome({ focused: true, error: false }), { borderColor: "var(--cocoa-accent)", boxShadow: "0 0 0 3px var(--cocoa-focus-ring)" });
    assert.equal(controlChrome({ focused: false, error: true }).borderColor, "var(--cocoa-danger)");
    assert.match(controlChrome({ focused: true, error: true }).boxShadow, /var\(--cocoa-danger\) 45%/);
  });
});

describe("CocoaInput · heights align with CocoaSelect (§3.8 control 28, review#10)", () => {
  it("22 / 28 / 34 px on both controls; the input derives its padding from the shared height", () => {
    assert.deepEqual(CONTROL_HEIGHT_BY_SIZE, { small: 22, regular: 28, large: 34 });
    for (const size of ["small", "regular", "large"] as const) {
      assert.equal(selectControlHeight(size), CONTROL_HEIGHT_BY_SIZE[size], size);
      assert.ok(Number.isInteger(inputPaddingY(size)), `${size}: whole-pixel padding`);
      assert.ok(inputPaddingY(size) >= 3, `${size}: at least 3 px of air`);
    }
    // 5 + 5 + line-height 16 + 2 × 1 px border = 28 (was 8 + 8 + 16 + 2 = 34).
    assert.equal(inputPaddingY("regular"), 5);
    assert.equal(inputPaddingY("small"), 3);
    assert.equal(inputPaddingY("large"), 6);
  });
});

describe("CocoaButton · foreground (§2.1: ghosts use the AA tone ink, review#7)", () => {
  it("filled accent/destructive use the ink ON the hue; neutral the label; ghosts the *-text ink", () => {
    assert.equal(buttonForeground("filled", "accent"), "var(--cocoa-accent-contrast)");
    assert.equal(buttonForeground("filled", "destructive"), "var(--cocoa-accent-contrast)");
    assert.equal(buttonForeground("filled", "neutral"), "var(--cocoa-label)");
    assert.equal(buttonForeground("bordered", "neutral"), "var(--cocoa-label)");
    assert.equal(buttonForeground("plain", "accent"), "var(--cocoa-tone-accent-text)");
    assert.equal(buttonForeground("bordered", "accent"), "var(--cocoa-tone-accent-text)");
    assert.equal(buttonForeground("tinted", "accent"), "var(--cocoa-tone-accent-text)");
    assert.equal(buttonForeground("tinted", "destructive"), "var(--cocoa-tone-danger-text)");
    assert.equal(buttonForeground("plain", "destructive"), "var(--cocoa-tone-danger-text)");
  });
  it("never paints the bare accent hue as text", () => {
    for (const variant of ["filled", "tinted", "bordered", "plain"] as const) {
      for (const tone of ["accent", "neutral", "destructive"] as const) {
        assert.notEqual(buttonForeground(variant, tone), "var(--cocoa-accent)", `${variant}/${tone}`);
        assert.notEqual(buttonForeground(variant, tone), "var(--cocoa-danger)", `${variant}/${tone}`);
      }
    }
  });
});

// The filled accent button carries white ink: the bare Esmeralda hue #0d8a5f
// only reaches 4.36:1 (< 4.5 AA at 11–15 px, qa#7), so it paints on the
// deeper --cocoa-accent-fill. Measured here from the stylesheets, WCAG 2.x.
describe("CocoaButton · filled accent surface (fix:primitives qa#7)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(here, "../../..");
  const tokens = readFileSync(resolve(srcDir, "styles/cocoa-tokens.css"), "utf8");
  const aurora = readFileSync(resolve(srcDir, "styles.css"), "utf8");
  const button = readFileSync(resolve(here, "../CocoaButton.tsx"), "utf8");
  const channel = (v: number): number => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const luminance = ([r = 0, g = 0, b = 0]: number[]): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (a: number[], b: number[]): number => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const WHITE = [255, 255, 255];

  it("light: --cocoa-accent-fill is a literal deeper than the hue and carries white ≥ 4.5:1, hover included", () => {
    const fills = [...tokens.matchAll(/--cocoa-accent-fill:\s*(#[0-9a-fA-F]{6}|var\(--accent\));/g)].map((m) => m[1] ?? "");
    assert.equal(fills.length, 3, "light literal + the two dark blocks ([data-theme=dark] and prefers-color-scheme)");
    const light = fills[0] ?? "";
    assert.match(light, /^#[0-9a-fA-F]{6}$/, "the light fill is a literal: the hue #0d8a5f only reaches 4.36:1 under white");
    assert.ok(contrast(hex("#0d8a5f"), WHITE) < 4.5, "the bare Esmeralda hue is the reason the fill exists");
    assert.ok(contrast(hex(light), WHITE) >= 4.5, `${light} under white ink`);
    const hovered = hex(light).map((v) => Math.min(255, v * 1.04)); // CocoaButton applyHover → filter: brightness(1.04)
    assert.ok(contrast(hovered, WHITE) >= 4.5, `${light} hovered (brightness 1.04) under white ink`);
    assert.deepEqual(fills.slice(1), ["var(--accent)", "var(--accent)"], "dark keeps the hue: --accent-ink is deep ink there");
  });

  it("dark: the hue under --accent-ink stays ≥ 4.5:1", () => {
    const accents = [...aurora.matchAll(/(?<![\w-])--accent:\s*(#[0-9a-fA-F]{6});/g)].map((m) => m[1] ?? "");
    const inks = [...aurora.matchAll(/(?<![\w-])--accent-ink:\s*(#[0-9a-fA-F]{6});/g)].map((m) => m[1] ?? "");
    assert.ok(accents.length >= 2 && inks.length >= 2, "Aurora defines light + dark --accent / --accent-ink");
    assert.ok(contrast(hex(accents[1] ?? ""), hex(inks[1] ?? "")) >= 4.5, `${inks[1]} on ${accents[1]}`);
  });

  it("CocoaButton paints the filled accent on the fill token, never on the bare hue", () => {
    assert.match(button, /accent: "var\(--cocoa-accent-fill\)"/);
    assert.doesNotMatch(button, /accent: "var\(--cocoa-accent\)"/);
  });
});

describe("Tabs · focus ring on the active tab (review#5)", () => {
  it("the tab buttons carry no inline box-shadow (the stylesheet ring must win) and isolate their surface", () => {
    for (const isActive of [true, false]) {
      const route = routeTabStyle(isActive, "regular");
      assert.equal(route.boxShadow, undefined, `route tab active=${isActive}`);
      assert.equal(route.background, "transparent");
      assert.equal(route.isolation, "isolate");
      assert.equal(route.position, "relative");
      const segment = segmentItemStyle({ isActive, size: "regular", fullWidth: false });
      assert.equal(segment.boxShadow, undefined, `segment active=${isActive}`);
      assert.equal(segment.background, "transparent");
      assert.equal(segment.isolation, "isolate");
    }
  });
  it("the decorative surface carries the inset control shadow and fades with the active state", () => {
    const on = tabSurfaceStyle(true);
    const off = tabSurfaceStyle(false);
    assert.equal(on.boxShadow, "inset var(--cocoa-shadow-control)");
    assert.equal(on.background, "var(--cocoa-background-content)");
    assert.equal(on.opacity, 1);
    assert.equal(off.opacity, 0);
    assert.equal(on.zIndex, -1);
    assert.equal(on.pointerEvents, "none");
  });
});

describe("CocoaPageHeader · title metrics (§3.2, §5.1)", () => {
  it("26 px nowrap on desktop, 22 px wrapping on phones", () => {
    const desktop = headerTitleStyle(false);
    assert.equal(desktop.fontSize, "var(--cocoa-fs-large-title)");
    assert.equal(desktop.whiteSpace, "nowrap");
    const phone = headerTitleStyle(true);
    assert.equal(phone.fontSize, "var(--cocoa-fs-title-1)");
    assert.equal(phone.whiteSpace, "normal");
    assert.equal(phone.fontWeight, "var(--cocoa-fw-bold)");
  });
});

describe("CocoaCard · resting shadow (§3.5)", () => {
  it("elevated → card, bordered → control, plain → none", () => {
    assert.equal(cardRestingShadow("elevated"), "var(--cocoa-shadow-card)");
    assert.equal(cardRestingShadow("bordered"), "var(--cocoa-shadow-control)");
    assert.equal(cardRestingShadow("plain"), "");
  });
});

describe("CocoaStepper · clamp", () => {
  it("clamps into [min, max]", () => {
    assert.equal(clampStep(5, 0, 10), 5);
    assert.equal(clampStep(-1, 0, 10), 0);
    assert.equal(clampStep(11, 0, 10), 10);
    assert.equal(clampStep(3, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY), 3);
  });
});

describe("CocoaChart · series and palettes (§3.12)", () => {
  it("series default to the canon order accent → warning → tertiary and cycle", () => {
    assert.deepEqual([...SERIES_TONE_ORDER], ["accent", "warning", "tertiary", "info", "success", "neutral"]);
    assert.equal(seriesToneName(undefined, 0), "accent");
    assert.equal(seriesToneName(undefined, 1), "warning");
    assert.equal(seriesToneName(undefined, 2), "tertiary");
    assert.equal(seriesToneName(undefined, 6), "accent");
    assert.equal(seriesToneName("danger", 0), "danger");
    assert.equal(seriesStroke(undefined, 0), "var(--cocoa-tone-accent)");
    assert.equal(seriesStroke("tertiary", 0), "var(--cocoa-chart-reference)");
    assert.equal(seriesStroke(undefined, 2), "var(--cocoa-chart-reference)");
  });
  it("donut slices: explicit tone, else accent + greys cycling", () => {
    assert.equal(DONUT_PALETTE.length, 5);
    assert.equal(donutSliceColor(undefined, 0), "var(--cocoa-chart-primary)");
    assert.equal(donutSliceColor(undefined, 5), "var(--cocoa-chart-primary)");
    assert.equal(donutSliceColor("warning", 3), "var(--cocoa-tone-warning)");
  });
  it("line viewBox: canon 640 until measured, never below 240", () => {
    assert.equal(MIN_LINE_WIDTH, 240);
    assert.equal(lineViewBoxWidth(null), 640);
    assert.equal(lineViewBoxWidth(100), 240);
    assert.equal(lineViewBoxWidth(736.4), 736);
  });
  it("gauge qualifiers in Spanish", () => {
    assert.equal(gaugeToneLabel("success"), "bajo");
    assert.equal(gaugeToneLabel("warning"), "moderado");
    assert.equal(gaugeToneLabel("danger"), "alto");
  });
  it("donut shares are es-ES percentages with at most one decimal (review#21)", () => {
    const nbsp = (s: string) => s.replace(/\u00a0/g, " ");
    assert.equal(nbsp(donutShareLabel(0.125)), "12,5 %");
    assert.equal(nbsp(donutShareLabel(0.5)), "50 %");
    assert.equal(nbsp(donutShareLabel(0.3333)), "33,3 %");
    assert.equal(nbsp(donutShareLabel(0)), "0 %");
  });
});

describe("CocoaCallout · role (§6 one live region per page, review#22)", () => {
  it("is a static note by default whatever the tone; a live role must be explicit", () => {
    assert.equal(calloutRole("danger"), "note");
    assert.equal(calloutRole("warning"), "note");
    assert.equal(calloutRole("neutral"), "note");
    assert.equal(calloutRole("danger", "alert"), "alert");
    assert.equal(calloutRole("success", "status"), "status");
  });
});

describe("DegradedBanner · copy", () => {
  it("singular and plural", () => {
    assert.equal(degradedBannerLabel(1), "1 indicador no disponible");
    assert.equal(degradedBannerLabel(3), "3 indicadores no disponibles");
  });
});

describe("DirectorForwardPaceChart · viewBox (Cocoa 22 fix)", () => {
  it("keeps the canon 640 until measured and clamps to 240 — no more stretched glyphs at 390 px", () => {
    assert.equal(VIEWBOX_WIDTH, 640);
    assert.equal(MIN_VIEWBOX_WIDTH, 240);
    assert.equal(paceViewBoxWidth(null), 640);
    assert.equal(paceViewBoxWidth(276), 276);
    assert.equal(paceViewBoxWidth(120), 240);
  });
});

// ---------------------------------------------------------------------------
// Tanda UX-1 · lote U5 · teclas de acceso y 2.5.8 (docs/design/UX-RECEPCION-FEEL.md
// §4 «Atajos por pantalla y teclas de acceso», §7.1 2.5.8, §10 D7 / R8).
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaButton, SMALL_TARGET_MIN_PX, buttonMinHeight } from "../CocoaButton.tsx";
import {
  accessKeyAriaShortcut,
  accessKeyOfEvent,
  accessKeysSuppressedFor,
  dispatchAccessKey,
  findAccessKeyTarget,
  getAltHeld,
  installAltHeldTracking,
  isElementActionable,
  normalizeAccessKey,
  registerAccessKey,
  resetAccessKeys
} from "../CocoaAccessKey.tsx";
import { RESERVED_ACCESS_LETTERS } from "../../../content/shortcuts-registry.ts";

describe("CocoaButton · WCAG 2.5.8 target size (UX-1 · U5)", () => {
  it("raises `small` from 22 to a 24 px box with a mouse and keeps 44 on touch", () => {
    assert.equal(SMALL_TARGET_MIN_PX, 24);
    assert.equal(buttonMinHeight("small", false), 24);
    assert.equal(buttonMinHeight("regular", false), 28);
    assert.equal(buttonMinHeight("large", false), 32);
    assert.equal(buttonMinHeight("small", true), 44);
    assert.equal(buttonMinHeight("large", true), 44);
  });
});

describe("CocoaButton · accessKey (UX-1 · U5, D7)", () => {
  it("normalizes the letter and rejects anything that is not one letter or digit", () => {
    assert.equal(normalizeAccessKey("c"), "C");
    assert.equal(normalizeAccessKey(" 1 "), "1");
    assert.equal(normalizeAccessKey("ch"), null);
    assert.equal(normalizeAccessKey(""), null);
    assert.equal(normalizeAccessKey(undefined), null);
    assert.equal(accessKeyAriaShortcut("C"), "Alt+C");
  });

  it("reads the physical key of ⌥+letter (R8: `code`, never `key`) and ignores ⌘/Ctrl/⇧ combos", () => {
    assert.equal(accessKeyOfEvent({ code: "KeyC", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), "C");
    assert.equal(accessKeyOfEvent({ code: "Digit2", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), "2");
    assert.equal(accessKeyOfEvent({ code: "KeyC", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false }), null);
    assert.equal(accessKeyOfEvent({ code: "KeyC", altKey: true, metaKey: true, ctrlKey: false, shiftKey: false }), null);
    assert.equal(accessKeyOfEvent({ code: "KeyC", altKey: true, metaKey: false, ctrlKey: false, shiftKey: true }), null);
    assert.equal(accessKeyOfEvent({ code: "Enter", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), null);
  });

  it("only runs a visible, enabled button; the deepest (latest) registration wins", () => {
    resetAccessKeys();
    const clicks: string[] = [];
    const button = (name: string, extra: Record<string, unknown> = {}) => ({
      disabled: false,
      hidden: false,
      getAttribute: (attr: string) => (attr in extra ? String(extra[attr]) : null),
      getClientRects: () => ({ length: 1 }),
      click: () => clicks.push(name),
      ...extra
    });
    const outer = button("outer");
    const inner = button("inner");
    const disabled = button("disabled", { disabled: true });
    const hidden = button("hidden", { getClientRects: () => ({ length: 0 }) });
    assert.equal(isElementActionable(outer as never), true);
    assert.equal(isElementActionable(disabled as never), false);
    assert.equal(isElementActionable(hidden as never), false);
    assert.equal(isElementActionable({ ...outer, getAttribute: () => "true" } as never), false, "aria-disabled");
    assert.equal(isElementActionable(null), false);

    registerAccessKey({ letter: "C", element: () => outer as never });
    const offInner = registerAccessKey({ letter: "C", element: () => inner as never });
    registerAccessKey({ letter: "C", element: () => disabled as never });
    registerAccessKey({ letter: "X", element: () => hidden as never });
    assert.equal(findAccessKeyTarget("C"), inner, "latest actionable registration wins over the disabled one");
    assert.equal(findAccessKeyTarget("X"), null, "hidden button never runs");
    assert.equal(findAccessKeyTarget("Z"), null);

    let prevented = 0;
    const event = (code: string, target?: unknown) => ({ code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, target, preventDefault: () => { prevented += 1; } });
    assert.equal(dispatchAccessKey(event("KeyC")), true);
    assert.deepEqual(clicks, ["inner"]);
    assert.equal(prevented, 1);
    offInner();
    assert.equal(dispatchAccessKey(event("KeyC")), true);
    assert.deepEqual(clicks, ["inner", "outer"]);
    assert.equal(dispatchAccessKey(event("KeyC", { tagName: "TEXTAREA" })), false, "never inside a textarea");
    assert.equal(dispatchAccessKey(event("KeyC", { tagName: "INPUT", type: "text" })), true, "a one-line field does not block (⌥1 in the amount)");
    assert.equal(dispatchAccessKey(event("KeyZ")), false, "no button → the event goes on to the ⌥ navigation");
    assert.equal(accessKeysSuppressedFor({ isContentEditable: true }), true);
    assert.equal(accessKeysSuppressedFor({ tagName: "input" }), false);
    resetAccessKeys();
  });

  it("tracks ⌥ held globally (keydown/keyup/blur) and resets on uninstall", () => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const target = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
      }
    };
    const fire = (type: string, event: unknown) => (listeners.get(type) ?? []).forEach((listener) => listener(event));
    const uninstall = installAltHeldTracking(target as never);
    assert.equal(getAltHeld(), false);
    fire("keydown", { key: "Alt", altKey: true });
    assert.equal(getAltHeld(), true);
    fire("keydown", { key: "c", altKey: true });
    assert.equal(getAltHeld(), true, "a letter with ⌥ keeps it held");
    fire("keyup", { key: "Alt", altKey: false });
    assert.equal(getAltHeld(), false);
    fire("keydown", { key: "Alt", altKey: true });
    fire("blur", {});
    assert.equal(getAltHeld(), false, "leaving the window releases ⌥");
    fire("keydown", { key: "Alt", altKey: true });
    uninstall();
    assert.equal(getAltHeld(), false);
    assert.equal((listeners.get("keydown") ?? []).length, 0);
  });

  it("announces the shortcut on the button and paints no chip while ⌥ is up (SSR)", () => {
    const html = renderToStaticMarkup(createElement(CocoaButton, { accessKey: "c", size: "small" }, "Cobrar"));
    assert.match(html, /aria-keyshortcuts="Alt\+C"/);
    assert.match(html, /data-access-key="C"/);
    assert.doesNotMatch(html, /<kbd/);
    const plain = renderToStaticMarkup(createElement(CocoaButton, {}, "Cobrar"));
    assert.doesNotMatch(plain, /aria-keyshortcuts/);
  });

  it("keeps the ⌥ navigation letters out of the access keys", () => {
    assert.deepEqual(RESERVED_ACCESS_LETTERS, ["H", "R", "N", "T", "B", "F", "W"]);
  });
});

describe("CocoaDatePicker · aritmética de fechas (UX-1 · U7, F8, patrón OPERA)", () => {
  const base = "2026-09-19";
  const today = "2026-09-19";

  it("«+7» / «-1» / «−1» mueven la fecha del campo (calendario, sin deriva horaria)", () => {
    assert.equal(parseDateArithmetic("+7", base, today), "2026-09-26");
    assert.equal(parseDateArithmetic("-1", base, today), "2026-09-18");
    assert.equal(parseDateArithmetic("−1", base, today), "2026-09-18");
    assert.equal(parseDateArithmetic(" + 30 ", base, today), "2026-10-19");
    assert.equal(parseDateArithmetic("+2s", base, today), "2026-10-03", "semanas");
    assert.equal(shiftIsoDay("2026-03-28", 2), "2026-03-30", "cambio de hora de marzo");
    assert.equal(shiftIsoDay("2026-12-31", 1), "2027-01-01");
  });

  it("«hoy» / «mañana» / «ayer» parten del día de referencia, no del valor del campo", () => {
    assert.equal(parseDateArithmetic("hoy", "2026-10-05", today), today);
    assert.equal(parseDateArithmetic("Mañana", "2026-10-05", today), "2026-09-20");
    assert.equal(parseDateArithmetic("manana", "2026-10-05", today), "2026-09-20");
    assert.equal(parseDateArithmetic("ayer", "2026-10-05", today), "2026-09-18");
    assert.equal(parseDateArithmetic("h", "", today), today, "atajo de una letra");
  });

  it("un campo vacío usa hoy como base del desplazamiento; sin referencia no resuelve", () => {
    assert.equal(parseDateArithmetic("+1", "", today), "2026-09-20");
    assert.equal(parseDateArithmetic("+1", "", ""), null);
    assert.equal(parseDateArithmetic("hoy", "", ""), null);
  });

  it("acepta un día del mes en curso, «dd/mm», «dd/mm/aaaa» y una ISO tal cual; rechaza fechas imposibles y texto suelto", () => {
    assert.equal(parseDateArithmetic("25", base, today), "2026-09-25");
    assert.equal(parseDateArithmetic("3/10", base, today), "2026-10-03");
    assert.equal(parseDateArithmetic("03/10/27", base, today), "2027-10-03");
    assert.equal(parseDateArithmetic("03/10/2027", base, today), "2027-10-03");
    assert.equal(parseDateArithmetic("2026-11-02", base, today), "2026-11-02");
    assert.equal(parseDateArithmetic("31/02", base, today), null);
    assert.equal(parseDateArithmetic("", base, today), null);
    assert.equal(parseDateArithmetic("xyz", base, today), null);
    assert.equal(parseDateArithmetic("+", base, today), null);
  });

  it("solo +, −, letras abren el búfer; los dígitos entran solo con el búfer abierto (el input nativo conserva sus segmentos)", () => {
    assert.equal(isArithmeticKey("+", false), true);
    assert.equal(isArithmeticKey("-", false), true);
    assert.equal(isArithmeticKey("h", false), true);
    assert.equal(isArithmeticKey("7", false), false);
    assert.equal(isArithmeticKey("7", true), true);
    assert.equal(isArithmeticKey("/", true), true);
    assert.equal(isArithmeticKey("Enter", true), false);
    assert.equal(isArithmeticKey("Backspace", true), false);
  });

  it("la vista previa dice a qué día resuelve el búfer, o «?» si no resuelve", () => {
    assert.equal(arithmeticPreview("+7", base, today), "26/09");
    assert.equal(arithmeticPreview("mañana", base, today), "20/09");
    assert.equal(arithmeticPreview("+", base, today), "?");
  });
});
