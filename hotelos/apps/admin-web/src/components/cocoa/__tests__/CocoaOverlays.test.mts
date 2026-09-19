import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DRAWER_WIDTH, drawerGeometry } from "../CocoaDrawer.tsx";
import { DIALOG_WIDTH, dialogInitialFocus } from "../CocoaDialog.tsx";
import { toastTone, toastViewportStyle } from "../CocoaToast.tsx";
import { actionBarPlacement, isPrimaryShortcut, shortcutInsideOverlay } from "../CocoaActionBar.tsx";
import { SHEET_MAX_WIDTH } from "../CocoaSheet.tsx";

describe("CocoaDrawer · geometry (§3.9)", () => {
  it("sizes 360 / 480 / 640 and a right panel by default", () => {
    assert.deepEqual(DRAWER_WIDTH, { sm: 360, md: 480, lg: 640 });
    const g = drawerGeometry({ side: "right", size: "md", isNarrow: false });
    assert.equal(g.side, "right");
    assert.equal(g.width, "min(480px, 100vw)");
    assert.equal(g.hiddenTransform, "translateX(100%)");
    assert.equal(g.anchor.right, 0);
    assert.equal(g.anchor.left, "auto");
    assert.equal(g.radius.borderTopLeftRadius, "var(--cocoa-radius-lg)");
  });
  it("left panels slide from the left with the radius on the inner edge", () => {
    const g = drawerGeometry({ side: "left", size: "sm", isNarrow: false });
    assert.equal(g.width, "min(360px, 100vw)");
    assert.equal(g.hiddenTransform, "translateX(-100%)");
    assert.equal(g.anchor.left, 0);
    assert.equal(g.radius.borderTopRightRadius, "var(--cocoa-radius-lg)");
  });
  it("phones always get a bottom sheet (90 dvh, translateY)", () => {
    for (const side of ["right", "left", "bottom"] as const) {
      const g = drawerGeometry({ side, size: "lg", isNarrow: true });
      assert.equal(g.side, "bottom");
      assert.equal(g.width, "100%");
      assert.equal(g.maxHeight, "90dvh");
      assert.equal(g.hiddenTransform, "translateY(100%)");
      assert.equal(g.anchor.bottom, 0);
    }
  });
});

describe("CocoaDialog · initial focus and widths", () => {
  it("focuses Cancel on destructive dialogs (Enter must not discard) and Confirm otherwise", () => {
    assert.equal(dialogInitialFocus("destructive"), "cancel");
    assert.equal(dialogInitialFocus("primary"), "confirm");
    assert.equal(dialogInitialFocus("destructive", true), "confirm");
  });
  it("max 440 / 560; sheets 480 / 640 / 880", () => {
    assert.deepEqual(DIALOG_WIDTH, { sm: 440, md: 560 });
    assert.deepEqual(SHEET_MAX_WIDTH, { sm: 480, md: 640, lg: 880 });
  });
});

describe("CocoaToast · tone and stack", () => {
  it("maps variants to tones (error → danger)", () => {
    assert.equal(toastTone("success"), "success");
    assert.equal(toastTone("error"), "danger");
    assert.equal(toastTone("warning"), "warning");
    assert.equal(toastTone("info"), "info");
  });
  it("desktop: bottom-right above the action bars (absolute offset contract, default 120 px)", () => {
    const style = toastViewportStyle(false);
    assert.equal(style.position, "fixed");
    assert.equal(style.right, "var(--cocoa-space-5)");
    assert.equal(style.bottom, "var(--hotelos-toast-offset, 120px)");
    assert.equal(style.zIndex, "var(--cocoa-z-toast)");
    assert.equal(style.pointerEvents, "none");
  });
  it("phone: under the toolbar, full width minus 16", () => {
    const style = toastViewportStyle(true);
    assert.match(String(style.top), /toolbar-height, 48px/);
    assert.equal(style.left, "var(--cocoa-space-4)");
    assert.equal(style.right, "var(--cocoa-space-4)");
    assert.equal(style.bottom, "auto");
  });
});

describe("CocoaActionBar · shortcut and placement", () => {
  it("Ctrl/⌘ + Enter is the primary shortcut; Alt or a bare Enter is not", () => {
    assert.equal(isPrimaryShortcut({ key: "Enter", metaKey: true, ctrlKey: false }), true);
    assert.equal(isPrimaryShortcut({ key: "Enter", metaKey: false, ctrlKey: true }), true);
    assert.equal(isPrimaryShortcut({ key: "Enter", metaKey: false, ctrlKey: false }), false);
    assert.equal(isPrimaryShortcut({ key: "Enter", metaKey: true, ctrlKey: false, altKey: true }), false);
    assert.equal(isPrimaryShortcut({ key: "a", metaKey: true, ctrlKey: false }), false);
  });
  it("ignores the shortcut while its target sits inside an open dialog / drawer / sheet", () => {
    const inside = { closest: (selector: string) => (selector.includes('[role="dialog"]') ? {} : null) };
    const outside = { closest: () => null };
    assert.equal(shortcutInsideOverlay(inside), true);
    assert.equal(shortcutInsideOverlay(outside), false);
    assert.equal(shortcutInsideOverlay(null), false);
    assert.equal(shortcutInsideOverlay(undefined), false);
    assert.equal(shortcutInsideOverlay({}), false); // a window / document target has no closest()
  });
  it("fixed on phones, sticky or static on desktop", () => {
    assert.equal(actionBarPlacement({ isNarrow: true, sticky: false }), "fixed");
    assert.equal(actionBarPlacement({ isNarrow: false, sticky: true }), "sticky");
    assert.equal(actionBarPlacement({ isNarrow: false, sticky: false }), "static");
  });
});

// ---------------------------------------------------------------------------
// Tanda UX-1 · lote U5 · Enter envía (docs/design/UX-RECEPCION-FEEL.md §4
// «Enter envía», F6, §7.1 2.1.1): CocoaDialog / CocoaDrawer `submitOnEnter`.
// ---------------------------------------------------------------------------
import { isOneLineTextField, shouldSubmitOnEnter } from "../CocoaDialog.tsx";
import { drawerPrimaryButton } from "../CocoaDrawer.tsx";

describe("CocoaDialog · submitOnEnter (UX-1 · U5, F6)", () => {
  const input = (extra: Record<string, unknown> = {}) => ({ tagName: "INPUT", type: "text", closest: () => null, ...extra });
  const ctx = { enabled: true, tone: "primary" as const, busy: false, confirmDisabled: false, hasInitialFocus: false };
  const enter = (target: unknown, extra: Record<string, unknown> = {}) => ({ key: "Enter", target, ...extra });

  it("recognises one-line text fields only", () => {
    assert.equal(isOneLineTextField(input()), true);
    assert.equal(isOneLineTextField(input({ type: "search" })), true);
    assert.equal(isOneLineTextField(input({ type: undefined })), true);
    assert.equal(isOneLineTextField({ tagName: "TEXTAREA" }), false);
    assert.equal(isOneLineTextField({ tagName: "SELECT" }), false);
    assert.equal(isOneLineTextField({ tagName: "BUTTON" }), false);
    assert.equal(isOneLineTextField(input({ type: "checkbox" })), false);
    assert.equal(isOneLineTextField(input({ type: "file" })), false);
    assert.equal(isOneLineTextField({ tagName: "DIV", isContentEditable: true }), false);
    assert.equal(isOneLineTextField(null), false);
  });

  it("plain Enter in a one-line field confirms; modifiers, IME composition and other keys do not", () => {
    assert.equal(shouldSubmitOnEnter(enter(input()), ctx), true);
    assert.equal(shouldSubmitOnEnter(enter(input(), { shiftKey: true }), ctx), false);
    assert.equal(shouldSubmitOnEnter(enter(input(), { metaKey: true }), ctx), false, "⌘Enter belongs to CocoaActionBar");
    assert.equal(shouldSubmitOnEnter(enter(input(), { ctrlKey: true }), ctx), false);
    assert.equal(shouldSubmitOnEnter(enter(input(), { altKey: true }), ctx), false);
    assert.equal(shouldSubmitOnEnter(enter(input(), { isComposing: true }), ctx), false);
    assert.equal(shouldSubmitOnEnter({ key: "Tab", target: input() }, ctx), false);
  });

  it("never in a textarea, never while busy or with Confirm disabled, never when the overlay opted out", () => {
    assert.equal(shouldSubmitOnEnter(enter({ tagName: "TEXTAREA", closest: () => null }), ctx), false);
    assert.equal(shouldSubmitOnEnter(enter(input()), { ...ctx, busy: true }), false);
    assert.equal(shouldSubmitOnEnter(enter(input()), { ...ctx, confirmDisabled: true }), false);
    assert.equal(shouldSubmitOnEnter(enter(input()), { ...ctx, enabled: false }), false);
    assert.equal(shouldSubmitOnEnter(enter({ tagName: "BUTTON" }), ctx), false, "Enter on a button is the button's own click");
  });

  it("a destructive dialog submits on Enter only when `initialFocus` put the caret in its reason field", () => {
    assert.equal(shouldSubmitOnEnter(enter(input()), { ...ctx, tone: "destructive" }), false);
    assert.equal(shouldSubmitOnEnter(enter(input()), { ...ctx, tone: "destructive", hasInitialFocus: true }), true);
  });

  it("opt-in (UX1-REV-05): los primitivos nacen con submitOnEnter=false y solo los overlays de recepción lo declaran", () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(read("../CocoaDialog.tsx"), /submitOnEnter = false,/);
    assert.match(read("../CocoaDrawer.tsx"), /submitOnEnter = false \}: CocoaDrawerProps/);
    for (const consumer of ["../../reservations/LifecycleDialog.tsx", "../../billing/RefundDialog.tsx", "../../timeline/TimelineActionDialog.tsx"]) {
      assert.match(read(consumer), /<CocoaDialog\s+[^>]*?\bsubmitOnEnter\b/, `${consumer} declara submitOnEnter`);
    }
    assert.match(read("../../billing/PaymentDialog.tsx"), /confirmForm=\{/, "PaymentDialog va por el <form> (Intro es el envío implícito)");
  });

  it("inside a <form> the form owns Enter (PaymentDialog: confirmForm)", () => {
    assert.equal(shouldSubmitOnEnter(enter(input({ closest: (selector: string) => (selector === "form" ? {} : null) })), ctx), false);
  });
});

describe("CocoaDrawer · primary action for Enter (UX-1 · U5, F6)", () => {
  type FakeButton = { disabled?: boolean; attrs: Record<string, string>; getAttribute: (name: string) => string | null };
  const button = (attrs: Record<string, string>, disabled = false): FakeButton => ({ disabled, attrs, getAttribute: (name) => attrs[name] ?? null });
  const footer = (buttons: FakeButton[]) => ({
    querySelectorAll: (selector: string) => {
      assert.equal(selector, '[data-cocoa="button"][data-variant="filled"]');
      return buttons.filter((candidate) => candidate.attrs["data-variant"] === "filled");
    }
  });

  it("returns the single filled, non-destructive, enabled button and nothing when ambiguous or absent", () => {
    const primary = button({ "data-variant": "filled", "data-tone": "accent" });
    const cancel = button({ "data-variant": "bordered", "data-tone": "neutral" });
    assert.equal(drawerPrimaryButton(footer([cancel, primary])), primary);
    assert.equal(drawerPrimaryButton(footer([cancel])), null);
    assert.equal(drawerPrimaryButton(footer([primary, button({ "data-variant": "filled", "data-tone": "accent" })])), null, "two filled buttons = ambiguous");
    assert.equal(drawerPrimaryButton(footer([button({ "data-variant": "filled", "data-tone": "destructive" })])), null, "a destructive primary never fires on Enter");
    assert.equal(drawerPrimaryButton(footer([button({ "data-variant": "filled", "data-tone": "accent" }, true)])), null, "disabled");
    assert.equal(drawerPrimaryButton(footer([button({ "data-variant": "filled", "data-tone": "accent", "aria-busy": "true" })])), null, "busy");
    assert.equal(drawerPrimaryButton(null), null);
  });

  it("ignores a destructive filled button next to the primary one", () => {
    const primary = button({ "data-variant": "filled", "data-tone": "accent" });
    const danger = button({ "data-variant": "filled", "data-tone": "destructive" });
    assert.equal(drawerPrimaryButton(footer([danger, primary])), primary);
  });
});
