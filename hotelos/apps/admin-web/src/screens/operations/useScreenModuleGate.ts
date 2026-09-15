// React side of the module gate (Cocoa 22 · ola 4 · lote 4-C · qa#14): the
// pure decision lives in module-gate.ts; this hook feeds it from `useNavGate`
// (role tokens + enabled modules of the active property, shared session cache,
// refetched when ModuleManager enables a module) and exposes the «Activar
// módulo» action of §6.3 with the Sidebar's target (ModuleManager#modulo=code).

import { useCallback, useMemo } from "react";
import { navigateTo } from "../../lib/navigate";
import { forbiddenModuleLists, useNavGate } from "../../navigation/useEnabledModules";
import { getActivePropertyId } from "../../services/activeProperty";
import { enableModuleHash, gatingModulesFor, moduleGateStatus, type ModuleGateStatus } from "./module-gate";

export type ScreenModuleGate = {
  status: ModuleGateStatus;
  /** The screen may request its data (module enabled, or list not readable: the API decides). */
  ready: boolean;
  /** Module codes that would unlock the screen. */
  codes: readonly string[];
  /** The user holds `modules.enable`: paint «Activar módulo». */
  canEnable: boolean;
  /** Open Módulos e integraciones with the first missing module preselected. */
  enable: () => void;
};

/** Module gate of `screenKey` for the active property. */
export function useScreenModuleGate(screenKey: string, propertyId: string = getActivePropertyId()): ScreenModuleGate {
  const gate = useNavGate(propertyId);
  const codes = useMemo(() => gatingModulesFor(screenKey), [screenKey]);
  const status = moduleGateStatus({
    codes,
    enabledModules: gate.modules,
    loading: gate.loading,
    listUnavailable: forbiddenModuleLists.has(propertyId)
  });
  const enable = useCallback(() => navigateTo("ModuleManager", enableModuleHash(codes)), [codes]);
  return { status, ready: status === "enabled" || status === "unknown", codes, canEnable: gate.canEnableModules, enable };
}
