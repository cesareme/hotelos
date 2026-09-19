import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { goLiveHeadState } from "../go-live-state.ts";
import type { PropertyReadiness, ReadinessCheck } from "../../services/billingApi.ts";

// Corrector L5 (L5F-02): the approval flow of «Salida en vivo» (Tanda L5 · lote C)
// had no test — neither the head state nor the button / dialog / «En vivo desde».
const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const stripComments = (source: string) => source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const check = (checkCode: string, status: ReadinessCheck["status"], severity: ReadinessCheck["severity"] = "blocking"): ReadinessCheck => ({ checkCode, status, severity, message: checkCode });
const readiness = (over: Partial<PropertyReadiness> = {}): PropertyReadiness => ({
  propertyId: "prop_x",
  status: "blocked",
  blockingCount: 1,
  checks: [check("a", "pass"), check("b", "fail")],
  computedAt: "2026-09-19T00:00:00.000Z",
  goLiveAt: null,
  ...over
});

describe("goLiveHeadState (GoLiveChecklist · Tanda L5 lote C)", () => {
  it("blocked property: danger badge with the blocker count, no approval button, danger progress", () => {
    const r = readiness();
    const head = goLiveHeadState(r, r.checks, true);
    assert.equal(head.uncalculated, false);
    assert.equal(head.showApprove, false);
    assert.equal(head.tone, "danger");
    assert.equal(head.label, "1 bloqueante");
    assert.equal(head.progressTone, "danger");
    assert.equal(head.blocking.length, 1);
    assert.equal(head.passed, 1);
  });

  it("ready and not live: «Lista para salir en vivo» and the approval button only for a session with property.go_live", () => {
    const r = readiness({ status: "ready", blockingCount: 0, checks: [check("a", "pass"), check("b", "pass")] });
    assert.deepEqual([goLiveHeadState(r, r.checks, true).showApprove, goLiveHeadState(r, r.checks, false).showApprove], [true, false]);
    assert.equal(goLiveHeadState(r, r.checks, true).label, "Lista para salir en vivo");
    assert.equal(goLiveHeadState(r, r.checks, true).tone, "success");
    assert.equal(goLiveHeadState(r, r.checks, true).progressTone, "success");
  });

  it("already live: «En vivo desde …», never the approval button, even if a later check fails", () => {
    const r = readiness({ status: "blocked", blockingCount: 1, goLiveAt: "2026-06-01T00:00:00.000Z" });
    const head = goLiveHeadState(r, r.checks, true);
    assert.equal(head.showApprove, false);
    assert.equal(head.tone, "success");
    assert.match(head.label, /^En vivo desde /);
  });

  it("unreadable checks (403 / network): «Sin calcular», info badge, no approval", () => {
    assert.deepEqual(
      [goLiveHeadState(null, [], true), goLiveHeadState(readiness({ checks: [] }), [], true)].map((h) => [h.uncalculated, h.label, h.tone, h.showApprove]),
      [
        [true, "Sin calcular", "info", false],
        [true, "Sin calcular", "info", false]
      ]
    );
  });

  it("warning-only pending checks: warning progress, blocked badge still counts only blocking ones", () => {
    const r = readiness({ status: "blocked", blockingCount: 0, checks: [check("a", "pass"), check("w", "warning", "warning")] });
    const head = goLiveHeadState(r, r.checks, true);
    assert.equal(head.blocking.length, 0);
    assert.equal(head.progressTone, "warning");
    assert.equal(head.label, "0 bloqueantes");
  });
});

describe("GoLiveChecklist.tsx · approval flow wired to the pure head state", () => {
  const screen = stripComments(src("screens/GoLiveChecklist.tsx"));

  it("reads the head from goLiveHeadState and shows «Aprobar salida en vivo» only with showApprove", () => {
    assert.match(screen, /import \{ goLiveHeadState \} from "\.\/go-live-state";/);
    assert.match(screen, /const head = goLiveHeadState\(readiness, checks, canApprove\);/);
    assert.match(screen, /\{showApprove \? \(\s*<CocoaButton[^>]*onClick=\{\(\) => setApproveOpen\(true\)\}[^>]*>\s*Aprobar salida en vivo/);
    assert.match(screen, /sessionMayApproveGoLive/);
    assert.match(screen, /user\.permissions\.includes\("property\.go_live"\)/);
  });

  it("confirms through a CocoaDialog and calls approvePropertyGoLive; blocked / alreadyLive / 403 have their own messages", () => {
    assert.match(screen, /<CocoaDialog\s+open=\{approveOpen\}[\s\S]*?title="Aprobar la salida en vivo"[\s\S]*?confirmLabel="Aprobar salida en vivo"[\s\S]*?onConfirm=\{handleApprove\}/);
    assert.match(screen, /await approvePropertyGoLive\(PROPERTY_ID\)/);
    assert.match(screen, /result\.alreadyLive/);
    assert.match(screen, /No se puede aprobar la salida en vivo:/);
    assert.match(screen, /No tienes permiso para aprobar la salida en vivo \(property\.go_live\)\./);
    assert.match(screen, /await load\(\);/, "the checklist reloads after the approval");
  });

  it("corrector L5 (L5F-08): the empty state has no action that needs property.configure — it reloads", () => {
    assert.match(screen, /title="Comprobaciones sin calcular"/);
    assert.match(screen, /primaryAction=\{\{ label: "Volver a cargar", onClick: \(\) => void load\(\)/);
    assert.doesNotMatch(screen, /Recalcular ahora/);
  });
});
