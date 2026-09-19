import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { nextTaskAction } from "../housekeeping-task-actions.ts";
import { ACTIONS } from "../../../content/actions.ts";

// FIX-1 · F9: the board composed the toast as `Tarea ${label.toLowerCase()}.` and
// said «Tarea empezar.» / «Tarea completar.» (manual 40 § tablero de pisos).
const source = readFileSync(new URL("../HousekeepingDashboard.tsx", import.meta.url), "utf8");

describe("Tablero de pisos · nextTaskAction (FIX-1 · F9)", () => {
  it("a task in progress completes: status done, button «Completar», toast «Tarea completada.»", () => {
    assert.deepEqual(nextTaskAction("in_progress"), { status: "done", label: ACTIONS.complete, done: "Tarea completada." });
    assert.equal(ACTIONS.complete, "Completar");
  });

  it("pending and assigned tasks start: status in_progress, button «Empezar», toast «Tarea empezada.»", () => {
    for (const status of ["pending", "assigned"]) {
      assert.deepEqual(nextTaskAction(status), { status: "in_progress", label: "Empezar", done: "Tarea empezada." });
    }
  });

  it("never produces the infinitive toasts", () => {
    for (const status of ["pending", "assigned", "in_progress", "done", "rejected", ""]) {
      const next = nextTaskAction(status);
      assert.doesNotMatch(next.done, /Tarea (empezar|completar)\./);
      assert.match(next.done, /^Tarea (empezada|completada)\.$/);
    }
  });
});

describe("HousekeepingDashboard.tsx · uses the pure rule", () => {
  it("imports nextTaskAction and shows next.done, with no inline «Tarea ${…}.» toast", () => {
    assert.match(source, /import \{ nextTaskAction \} from "\.\/housekeeping-task-actions";/);
    assert.match(source, /const next = nextTaskAction\(t\.status\);/);
    assert.match(source, /updateHousekeepingTask\(t\.id, \{ status: next\.status \}\), next\.done\)/);
    assert.doesNotMatch(source, /`Tarea \$\{/);
    assert.doesNotMatch(source, /label\.toLowerCase\(\)/);
  });
});
