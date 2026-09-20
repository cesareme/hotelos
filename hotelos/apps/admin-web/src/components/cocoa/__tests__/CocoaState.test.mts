import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CocoaIllustrations, CocoaSkeleton, SKELETON_HEIGHT, resolveStateDefaults, skeletonLineWidth, skeletonLineWidthHint } from "../CocoaState.tsx";
import { DEGRADED_HINT } from "../../cocoa-extras/DegradedValue.tsx";

describe("CocoaState · defaults (§3.10)", () => {
  it("empty is a polite status with the box illustration", () => {
    const s = resolveStateDefaults("empty", {});
    assert.equal(s.title, "Sin datos");
    assert.equal(s.role, "status");
    assert.equal(s.illustration, "box");
    assert.equal(s.message, undefined);
  });
  it("error is an alert with a retry-friendly message", () => {
    const s = resolveStateDefaults("error", {});
    assert.equal(s.role, "alert");
    assert.equal(s.illustration, "error");
    assert.equal(s.title, "Algo salió mal");
    assert.equal(s.message, "No se pudo cargar la información.");
  });
  it("degraded carries the shared DEGRADED_HINT (never a fake green 0)", () => {
    const s = resolveStateDefaults("degraded", {});
    assert.equal(s.title, "Indicador no disponible");
    assert.equal(s.message, DEGRADED_HINT);
    assert.equal(s.illustration, "connection");
  });
  it("overrides win field by field", () => {
    const s = resolveStateDefaults("error", { title: "Sin conexión", role: "status", illustration: "search" });
    assert.equal(s.title, "Sin conexión");
    assert.equal(s.role, "status");
    assert.equal(s.illustration, "search");
    assert.equal(s.message, "No se pudo cargar la información.");
  });
  it("role=\"none\" survives the defaults and renders no live region (UX-2 · UX2-REV-07: one live region per page)", () => {
    const s = resolveStateDefaults("empty", { role: "none" });
    assert.equal(s.role, "none");
    assert.equal(s.title, "Sin datos");
    const source = readFileSync(new URL("../CocoaState.tsx", import.meta.url), "utf8");
    assert.equal((source.match(/role=\{resolved\.role === "none" \? undefined : resolved\.role\}/g) ?? []).length, 2, "inline and full states drop the role");
    assert.match(source, /role\?: "status" \| "alert" \| "none";/);
  });
  it("exposes the five illustrations of cocoa-illustrations", () => {
    assert.deepEqual(Object.keys(CocoaIllustrations), ["box", "search", "error", "connection", "success"]);
  });
});

describe("CocoaSkeleton · geometry", () => {
  it("heights: text 12 · title 18 · row 36 · kpi 110 · chart 200 · card 240 · avatar 32 · button 28", () => {
    assert.deepEqual(SKELETON_HEIGHT, { text: 12, title: 18, row: 36, kpi: 110, chart: 200, card: 240, avatar: 32, button: 28 });
  });
  it("text lines alternate 100 / 85 % and the last one is 60 %", () => {
    assert.equal(skeletonLineWidth(0, 3), "100%");
    assert.equal(skeletonLineWidth(1, 3), "85%");
    assert.equal(skeletonLineWidth(2, 3), "60%");
    assert.equal(skeletonLineWidth(0, 1), "100%");
    assert.equal(skeletonLineWidth(3, 5), "85%");
    assert.equal(skeletonLineWidthHint(0, 3), undefined);
    assert.equal(skeletonLineWidthHint(1, 3), "medium");
    assert.equal(skeletonLineWidthHint(2, 3), "short");
  });
  it("ships the mirror helpers for grids and KPI strips", () => {
    assert.equal(typeof CocoaSkeleton.Grid, "function");
    assert.equal(typeof CocoaSkeleton.Strip, "function");
  });
});
