import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GAUGE,
  LINE_PADDING,
  barHeight,
  barTone,
  buildPathD,
  clampPercent,
  describeArcPath,
  donutSegments,
  formatChartValue,
  formatYTick,
  gaugeAngle,
  gaugeGeometry,
  gaugePoint,
  lineGeometry,
  round3,
  niceCeil,
  pickXStep,
  sparklinePath,
  thresholdTone
} from "../cocoa-chart-math.ts";

describe("cocoa-chart-math · sparkline", () => {
  it("fits the values to the 60×20 box with a 1 px pad (canon)", () => {
    const d = sparklinePath([0, 10, 5], 60, 20, 1);
    assert.equal(d, "M 0.00 19.00 L 30.00 1.00 L 60.00 10.00");
  });
  it("draws a flat mid line for a single value and nothing for none", () => {
    assert.equal(sparklinePath([7]), "M 0 10 L 60 10");
    assert.equal(sparklinePath([]), "");
  });
  it("does not divide by zero on a flat series", () => {
    assert.equal(sparklinePath([3, 3]), "M 0.00 19.00 L 60.00 19.00");
  });
});

describe("cocoa-chart-math · axis helpers", () => {
  it("niceCeil rounds up to 1 / 2 / 5 × 10ⁿ", () => {
    assert.equal(niceCeil(0), 1);
    assert.equal(niceCeil(1), 1);
    assert.equal(niceCeil(1.2), 2);
    assert.equal(niceCeil(37), 50);
    assert.equal(niceCeil(50), 50);
    assert.equal(niceCeil(51), 100);
    assert.equal(niceCeil(0.3), 0.5);
  });
  it("pickXStep keeps at most ~8 labels", () => {
    assert.equal(pickXStep(5), 1);
    assert.equal(pickXStep(8), 1);
    assert.equal(pickXStep(30), 4);
    assert.equal(pickXStep(31), 4);
  });
  it("formatYTick shows one decimal on small ranges only (es-ES comma, dot grouping from 10.000)", () => {
    assert.equal(formatYTick(2.5, 10), "2,5");
    assert.equal(formatYTick(2, 10), "2");
    assert.equal(formatYTick(37.6, 100), "38");
    assert.equal(formatYTick(1500, 6000), "1500");
    assert.equal(formatYTick(15000, 60000), "15.000");
  });
  it("formatChartValue picks precision by magnitude, formats es-ES and never prints NaN", () => {
    assert.equal(formatChartValue(123.4), "123");
    assert.equal(formatChartValue(12.34), "12,3");
    assert.equal(formatChartValue(12), "12");
    assert.equal(formatChartValue(1.234), "1,23");
    assert.equal(formatChartValue(1), "1");
    assert.equal(formatChartValue(Number.NaN), "—");
  });
  it("buildPathD emits M/L with two decimals", () => {
    assert.equal(buildPathD([]), "");
    assert.equal(buildPathD([{ x: 1, y: 2 }, { x: 3.456, y: 4 }]), "M1.00,2.00 L3.46,4.00");
  });
});

describe("cocoa-chart-math · line geometry", () => {
  const otb = { id: "otb", points: [{ x: "01", y: 10 }, { x: "02", y: 20 }, { x: "03", y: 30 }] };
  const ly = { id: "ly", points: [{ x: "01", y: 5 }, { x: "02", y: 15 }] };

  it("returns null with no points", () => {
    assert.equal(lineGeometry([{ id: "a", points: [] }]), null);
    assert.equal(lineGeometry([]), null);
  });
  it("uses the canon padding 16/16/32/44 and a nice ceiling", () => {
    const g = lineGeometry([otb, ly], 640, 200, 4)!;
    assert.equal(g.innerWidth, 640 - LINE_PADDING.left - LINE_PADDING.right);
    assert.equal(g.innerHeight, 200 - LINE_PADDING.top - LINE_PADDING.bottom);
    assert.equal(g.yMax, 50);
    assert.equal(g.yTicks.length, 5);
    assert.equal(g.yTicks[0].value, 0);
    assert.equal(g.yTicks[4].value, 50);
    assert.equal(g.yTicks[0].y, LINE_PADDING.top + g.innerHeight);
    assert.equal(g.yTicks[4].y, LINE_PADDING.top);
  });
  it("spreads the X axis over the longest series and keeps the last tick", () => {
    const g = lineGeometry([otb, ly], 640, 200)!;
    assert.equal(g.xOf(0), LINE_PADDING.left);
    assert.equal(g.xOf(2), 640 - LINE_PADDING.right);
    assert.deepEqual(g.xTicks.map((t) => t.label), ["01", "02", "03"]);
    assert.equal(g.series[1].length, 2);
    const many = { id: "m", points: Array.from({ length: 30 }, (_, i) => ({ x: String(i), y: i })) };
    const gm = lineGeometry([many])!;
    assert.equal(gm.xTicks[gm.xTicks.length - 1].i, 29);
    assert.ok(gm.xTicks.length <= 9);
  });
  it("centres a single point and maps hover X to the nearest index", () => {
    const one = lineGeometry([{ id: "a", points: [{ x: "01", y: 1 }] }], 640, 200)!;
    assert.equal(one.xOf(0), LINE_PADDING.left + one.innerWidth / 2);
    assert.equal(one.indexAt(0), 0);
    const g = lineGeometry([otb], 640, 200)!;
    assert.equal(g.indexAt(-100), 0);
    assert.equal(g.indexAt(g.xOf(1) + 3), 1);
    assert.equal(g.indexAt(10_000), 2);
  });
  it("scales to a measured width without deforming the padding", () => {
    const g = lineGeometry([otb], 320, 200)!;
    assert.equal(g.innerWidth, 320 - 60);
    assert.equal(g.xOf(2), 320 - LINE_PADDING.right);
  });
});

describe("cocoa-chart-math · gauge", () => {
  it("maps the range onto the 180° arc (left = min, right = max) and clamps", () => {
    assert.equal(gaugeAngle(0), 180);
    assert.equal(gaugeAngle(50), 90);
    assert.equal(gaugeAngle(100), 0);
    assert.equal(gaugeAngle(-10), 180);
    assert.equal(gaugeAngle(500), 0);
    assert.equal(gaugeAngle(5, 0, 10), 90);
  });
  it("uses the canon 220×130 box with r 90 and stroke 16", () => {
    assert.deepEqual(GAUGE, { width: 220, height: 130, cx: 110, cy: 110, radius: 90, stroke: 16 });
    const left = gaugePoint(GAUGE.radius, 180);
    assert.ok(Math.abs(left.x - 20) < 1e-9);
    assert.ok(Math.abs(left.y - 110) < 1e-9);
    const top = gaugePoint(GAUGE.radius, 90);
    assert.ok(Math.abs(top.x - 110) < 1e-9);
    assert.ok(Math.abs(top.y - 20) < 1e-9);
  });
  it("builds track, progress and needle paths", () => {
    const g = gaugeGeometry(50);
    assert.equal(g.angle, 90);
    assert.equal(g.trackPath, "M 20 110 A 90 90 0 0 1 200 110");
    assert.equal(g.progressPath, "M 20 110 A 90 90 0 0 1 110 20");
    assert.match(g.needlePath, /^M .* L .* L .* Z$/);
  });
  it("round3 rounds to three decimals and normalises -0", () => {
    assert.equal(round3(109.99999999999999), 110);
    assert.equal(round3(1.23456), 1.235);
    assert.equal(Object.is(round3(-0.0001), -0), false);
  });
  it("thresholdTone: success < warnAt ≤ warning < dangerAt ≤ danger, inverted when higher is better", () => {
    assert.equal(thresholdTone(10), "success");
    assert.equal(thresholdTone(30), "warning");
    assert.equal(thresholdTone(60), "danger");
    assert.equal(thresholdTone(10, [30, 60], true), "danger");
    assert.equal(thresholdTone(45, [30, 60], true), "warning");
    assert.equal(thresholdTone(60, [30, 60], true), "success");
  });
});

describe("cocoa-chart-math · donut", () => {
  it("shares the total, skips non-positive slices and keeps the input order", () => {
    const { segments, total } = donutSegments([{ value: 50 }, { value: 0 }, { value: 50 }, { value: -3 }], 160);
    assert.equal(total, 100);
    assert.equal(segments.length, 4);
    assert.equal(segments[0].share, 0.5);
    assert.equal(segments[0].startAngle, 0);
    assert.equal(segments[0].endAngle, 180);
    assert.equal(segments[1].share, 0);
    assert.equal(segments[1].path, "");
    assert.equal(segments[2].startAngle, 180);
    assert.equal(segments[2].endAngle, 360);
  });
  it("returns no segments for an empty total", () => {
    assert.deepEqual(donutSegments([{ value: 0 }]), { segments: [], total: 0 });
    assert.deepEqual(donutSegments([]), { segments: [], total: 0 });
  });
  it("describeArcPath never closes a full circle on itself", () => {
    const full = describeArcPath(80, 80, 80, 49.6, 0, 360);
    assert.match(full, /^M .* A 80 80 0 1 1 .* L .* A 49.6 49.6 0 1 0 .* Z$/);
    const half = describeArcPath(80, 80, 80, 49.6, 0, 180);
    assert.match(half, / A 80 80 0 0 1 /);
  });
});

describe("cocoa-chart-math · bars & progress", () => {
  it("barTone follows the sign and the polarity; zero and NaN are neutral", () => {
    assert.equal(barTone(3), "success");
    assert.equal(barTone(-3), "danger");
    assert.equal(barTone(3, "negative-good"), "danger");
    assert.equal(barTone(-3, "negative-good"), "success");
    assert.equal(barTone(0), "neutral");
    assert.equal(barTone(Number.NaN), "neutral");
  });
  it("barHeight scales by the max magnitude with a 2 px floor", () => {
    assert.equal(barHeight(50, 100, 80), 40);
    assert.equal(barHeight(-50, 100, 80), 40);
    assert.equal(barHeight(0, 100, 80), 2);
    assert.equal(barHeight(0, 0, 80), 2);
    assert.equal(barHeight(1, 0, 80), 80);
  });
  it("clampPercent stays in [0, 100] and maps NaN to 0", () => {
    assert.equal(clampPercent(-5), 0);
    assert.equal(clampPercent(42.5), 42.5);
    assert.equal(clampPercent(140), 100);
    assert.equal(clampPercent(Number.NaN), 0);
  });
});
