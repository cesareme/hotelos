import assert from "node:assert/strict";
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
    const small = { trackWidth: 32, trackHeight: 20, thumbSize: 16, padding: 2 };
    assert.equal(switchThumbOffset(true, small), 14);
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
