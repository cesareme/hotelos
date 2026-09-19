import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LAUNCH_STATE_LOADING, launchBadge, launchSectionView, launchStateFromResults, setupStepLabel, setupStepTone } from "../launch-readiness.ts";
import type { PropertySetupProgress } from "../../../services/backofficeApi.ts";
import type { PropertyReadiness, ReadinessCheck } from "../../../services/billingApi.ts";

// Corrector L5 (L5F-02 / L5F-05 / L5F-06): the launch section of the Setup Center had no test.
const src = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const check = (checkCode: string, status: ReadinessCheck["status"], severity: ReadinessCheck["severity"] = "blocking"): ReadinessCheck => ({ checkCode, status, severity, message: `msg ${checkCode}` });
const readiness = (over: Partial<PropertyReadiness> = {}): PropertyReadiness => ({
  propertyId: "prop_x",
  status: "blocked",
  blockingCount: 2,
  checks: [check("a", "pass"), check("b", "fail"), check("c", "fail"), check("w", "warning", "warning")],
  computedAt: "2026-09-19T08:00:00.000Z",
  goLiveAt: null,
  ...over
});
const step = (stepCode: string, status: PropertySetupProgress["steps"][number]["status"], label?: string) => ({ id: `s_${stepCode}`, propertyId: "prop_x", stepCode, status, metadataJson: {}, ...(label ? { label } : {}) });
const progress = (over: Partial<PropertySetupProgress> = {}): PropertySetupProgress => ({
  propertyId: "prop_x",
  steps: [step("organization_details", "completed", "Datos de la organización"), step("rooms", "not_started", "Habitaciones"), step("go_live", "not_started")],
  completed: 1,
  total: 3,
  progressPercent: 33,
  goLiveAt: null,
  ...over
});
const ok = <T,>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });
const ko = <T,>(reason: unknown): PromiseSettledResult<T> => ({ status: "rejected", reason });

describe("launchStateFromResults (SetupCenter · Tanda L5 lote C)", () => {
  it("keeps each GET's error apart: readiness failed / steps failed / both", () => {
    const onlyReadiness = launchStateFromResults(ko(new Error("403 readiness")), ok(progress()));
    assert.equal(onlyReadiness.readiness, null);
    assert.ok(onlyReadiness.progress);
    assert.equal(onlyReadiness.readinessError, "403 readiness");
    assert.equal(onlyReadiness.progressError, null);
    const onlySteps = launchStateFromResults(ok(readiness()), ko("boom"));
    assert.equal(onlySteps.readinessError, null);
    assert.equal(onlySteps.progressError, "No se pudieron leer los pasos de la puesta en marcha.");
    const both = launchStateFromResults(ko(new Error("x")), ko(new Error("y")));
    assert.deepEqual([both.readiness, both.progress, both.readinessError, both.progressError, both.loading], [null, null, "x", "y", false]);
    assert.equal(LAUNCH_STATE_LOADING.loading, true);
  });
});

describe("launchSectionView", () => {
  it("ready: KPIs, blockers, pending steps with the API labels (fallback to the code) and the last computation", () => {
    const view = launchSectionView({ ...launchStateFromResults(ok(readiness()), ok(progress())) });
    assert.equal(view.kind, "ready");
    assert.equal(view.warning, null);
    assert.equal(view.readinessUnavailable, false);
    assert.deepEqual([view.stepsDone, view.stepsTotal, view.stepsPct, view.checksPassed, view.checksTotal, view.blockingCount], [1, 3, 33, 1, 4, 2]);
    assert.deepEqual(view.blockers.map((b) => b.checkCode), ["b", "c"], "only blocking checks not passing");
    assert.deepEqual(view.pendingSteps.map(setupStepLabel), ["Habitaciones", "go_live"]);
    assert.equal(view.badge.label, "2 comprobaciones bloqueantes");
    assert.equal(view.badge.tone, "danger");
    assert.notEqual(view.lastComputed, "Sin calcular");
  });

  it("corrector L5 (L5F-05): readiness unreadable but steps loaded → warning, no invented «0» blockers", () => {
    const view = launchSectionView(launchStateFromResults(ko(new Error("No tienes permiso (backoffice.access)")), ok(progress())));
    assert.equal(view.kind, "ready");
    assert.equal(view.readinessUnavailable, true);
    assert.equal(view.blockingCount, null);
    assert.equal(view.checksTotal, 0);
    assert.match(view.warning ?? "", /No se ha podido leer la preparación de la propiedad: No tienes permiso \(backoffice\.access\)/);
    assert.equal(view.badge.label, "Preparación sin datos");
    assert.equal(view.lastComputed, "Sin calcular");
    assert.equal(view.stepsDone, 1, "the steps still show");
  });

  it("steps unreadable but readiness loaded → warning about the steps, readiness figures intact", () => {
    const view = launchSectionView(launchStateFromResults(ok(readiness()), ko(new Error("500"))));
    assert.equal(view.progressUnavailable, true);
    assert.equal(view.readinessUnavailable, false);
    assert.match(view.warning ?? "", /pasos de la puesta en marcha: 500/);
    assert.equal(view.blockingCount, 2);
  });

  it("both unreadable → unavailable with the readiness error; loading → loading", () => {
    assert.equal(launchSectionView(launchStateFromResults(ko(new Error("a")), ko(new Error("b")))).kind, "unavailable");
    assert.equal(launchSectionView(launchStateFromResults(ko(new Error("a")), ko(new Error("b")))).warning, "a");
    assert.equal(launchSectionView(LAUNCH_STATE_LOADING).kind, "loading");
  });

  it("live property: «En vivo desde …» badge (from readiness or from the steps), no pending steps shown", () => {
    const live = launchSectionView(launchStateFromResults(ok(readiness({ goLiveAt: "2026-06-01T00:00:00.000Z", status: "ready", blockingCount: 0 })), ok(progress())));
    assert.match(live.badge.label, /^En vivo desde /);
    assert.equal(live.badge.tone, "success");
    assert.ok(live.goLiveAt);
    assert.match(launchBadge(null, progress({ goLiveAt: "2026-06-01T00:00:00.000Z" })).label, /^En vivo desde /);
    assert.deepEqual(launchBadge(readiness({ status: "ready", blockingCount: 0 }), null), { label: "Lista para salir en vivo", tone: "success" });
  });

  it("step tones and labels", () => {
    assert.deepEqual(["completed", "blocked", "in_progress", "needs_review", "not_started"].map((s) => setupStepTone(s as never)), ["success", "danger", "warning", "warning", "neutral"]);
    assert.equal(setupStepLabel({ stepCode: "rooms", label: "  " }), "rooms");
  });
});

describe("SetupCenterScreen.tsx · launch section wired to the pure view (L5F-06: no label catalogue in the front)", () => {
  const screen = src("screens/backoffice/SetupCenterScreen.tsx");
  it("renders LaunchReadinessSection from launchSectionView, opens the checklist and shows no hand-written step catalogue", () => {
    assert.match(screen, /import \{ LAUNCH_STATE_LOADING, SETUP_STEP_STATUS_LABELS, launchSectionView, launchStateFromResults, setupStepLabel, setupStepTone, type LaunchState \} from "\.\/launch-readiness";/);
    assert.match(screen, /const view = launchSectionView\(launch\);/);
    assert.match(screen, /setLaunch\(launchStateFromResults\(readinessResult, progressResult\)\);/);
    assert.match(screen, /title="Preparación y salida en vivo"/);
    assert.match(screen, /Abrir la lista de comprobación/);
    assert.match(screen, /<CocoaKpi label="Bloqueantes" value=\{view\.blockingCount === null \? "—" : view\.blockingCount\}/);
    assert.doesNotMatch(screen, /SETUP_STEP_LABELS/, "the step labels come from the API (backoffice.service.ts SETUP_STEP_LABELS)");
    assert.doesNotMatch(screen, /"Datos legales del establecimiento"/);
  });
});
