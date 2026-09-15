import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRAWER_WIDTH, drawerGeometry } from "../CocoaDrawer.tsx";
import { DIALOG_WIDTH, dialogInitialFocus } from "../CocoaDialog.tsx";
import { toastTone, toastViewportStyle } from "../CocoaToast.tsx";
import { actionBarPlacement, isPrimaryShortcut } from "../CocoaActionBar.tsx";
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
  it("fixed on phones, sticky or static on desktop", () => {
    assert.equal(actionBarPlacement({ isNarrow: true, sticky: false }), "fixed");
    assert.equal(actionBarPlacement({ isNarrow: false, sticky: true }), "sticky");
    assert.equal(actionBarPlacement({ isNarrow: false, sticky: false }), "static");
  });
});
