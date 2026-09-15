import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIONS, UI_STATES } from "../../../content/actions.ts";
import { enableModuleHash, gatingModulesFor, moduleDisabledCopy, moduleGateStatus } from "../module-gate.ts";

// qa#14 (Cocoa 22 · ola 4 · lote 4-C): Personal y turnos and Seguridad e
// incidentes must not request their live endpoints (403 on every poll) when
// their module is not enabled; instead they paint «Módulo no activado».
describe("Operaciones · module gate of Personal y Seguridad", () => {
  it("reads the gating modules of the screens from the navigation tree", () => {
    assert.deepEqual([...gatingModulesFor("WorkforceDashboard")], ["workforce_labor"]);
    assert.deepEqual([...gatingModulesFor("SafetyDashboard")], ["safety_incident_management"]);
    // A screen without module gate, and an unknown key, never block.
    assert.deepEqual([...gatingModulesFor("ShiftManagerScreen")], []);
    assert.deepEqual([...gatingModulesFor("NoSuchScreen")], []);
  });

  it("waits for the module list, then enables or disables the screen", () => {
    const codes = ["workforce_labor"];
    assert.equal(moduleGateStatus({ codes: [], enabledModules: [], loading: true, listUnavailable: false }), "enabled");
    assert.equal(moduleGateStatus({ codes, enabledModules: [], loading: true, listUnavailable: false }), "loading");
    assert.equal(moduleGateStatus({ codes, enabledModules: ["pms_core", "workforce_labor"], loading: false, listUnavailable: false }), "enabled");
    // Rías Altas today: workforce_labor «available», not enabled.
    assert.equal(moduleGateStatus({ codes, enabledModules: ["pms_core"], loading: false, listUnavailable: false }), "disabled");
  });

  it("treats an unreadable module list (403 on GET /modules) as unknown, never as disabled", () => {
    assert.equal(moduleGateStatus({ codes: ["safety_incident_management"], enabledModules: [], loading: false, listUnavailable: true }), "unknown");
  });

  it("builds the Sidebar's «Activar módulo» target (ModuleManager#modulo=<code>)", () => {
    assert.equal(enableModuleHash(["workforce_labor"]), "modulo=workforce_labor");
    assert.equal(enableModuleHash(["a b", "other"]), "modulo=a%20b");
    assert.equal(enableModuleHash([]), undefined);
  });

  it("uses the canonical UI_STATES copy, with the CTA only for users who may enable modules", () => {
    const withCta = moduleDisabledCopy(true);
    assert.equal(withCta.title, UI_STATES.moduleDisabled.title);
    assert.equal(withCta.message, UI_STATES.moduleDisabled.message);
    assert.equal(withCta.cta, ACTIONS.enableModule);
    const withoutCta = moduleDisabledCopy(false);
    assert.equal(withoutCta.title, UI_STATES.moduleDisabled.title);
    assert.ok(withoutCta.message.startsWith(UI_STATES.moduleDisabled.message));
    assert.match(withoutCta.message, /Módulos e integraciones/);
    assert.equal(withoutCta.cta, undefined);
  });
});
