// Module gate of a module-gated screen (Cocoa 22 · ola 4 · lote 4-C · qa#14).
//
// Personal y turnos and Seguridad e incidentes are unlocked by a property
// module (`modulesAny` of their menu entry: workforce_labor and
// safety_incident_management). When the module is «available» but not
// enabled, their live endpoints answer 403 on every load and poll while the
// dashboard endpoints answer zeros, so the screen used to paint KPIs at 0 and
// empty lists without a word. These helpers are pure so the decision «paint
// the dashboard · paint «Módulo no activado» · wait for the module list» is
// unit-testable; `useScreenModuleGate` feeds them from `useNavGate` (the same
// source the Sidebar uses to dim an entry with «Activar módulo», §6.3).

import { ACTIONS, UI_STATES } from "../../content/actions";
import { findByScreen } from "../../navigation/nav-tree";

export type ModuleGateStatus =
  /** The enabled-module list is still unknown: no request yet, skeleton. */
  | "loading"
  /** Not module-gated, or one of its modules is enabled. */
  | "enabled"
  /** The list is readable and none of its modules is enabled. */
  | "disabled"
  /** The list is not readable for this user (403 on GET /modules): request as before. */
  | "unknown";

/** Module codes that unlock a screen key in the navigation tree (`[]` when the screen is not module-gated or unknown). */
export function gatingModulesFor(screenKey: string): readonly string[] {
  const match = findByScreen(screenKey);
  if (!match) return [];
  if (match.kind === "item") return match.item.modulesAny;
  if (match.kind === "tab") return match.tab.modulesAny.length > 0 ? match.tab.modulesAny : match.item.modulesAny;
  return [];
}

export type ModuleGateInput = {
  /** Codes that unlock the screen (`gatingModulesFor`). */
  codes: readonly string[];
  /** Enabled module codes of the property (`[]` while loading or unreadable). */
  enabledModules: readonly string[];
  /** The module list (or the role tokens) is still loading. */
  loading: boolean;
  /** GET /modules answered 403 for this user: the list is unknown, not empty. */
  listUnavailable: boolean;
};

/** Whether the screen may request its data, must wait, or must explain that its module is not active. */
export function moduleGateStatus(input: ModuleGateInput): ModuleGateStatus {
  if (input.codes.length === 0) return "enabled";
  if (input.loading) return "loading";
  if (input.codes.some((code) => input.enabledModules.includes(code))) return "enabled";
  return input.listUnavailable ? "unknown" : "disabled";
}

/** Hash of «Activar módulo» (§6.3, same target as the Sidebar): ModuleManager preselects the first missing module. */
export function enableModuleHash(codes: readonly string[]): string | undefined {
  const code = codes[0];
  return code ? `modulo=${encodeURIComponent(code)}` : undefined;
}

export type ModuleDisabledCopy = {
  title: string;
  message: string;
  /** Label of the call to action, only for users who may enable modules. */
  cta?: string;
};

/** Copy of the «Módulo no activado» state: the canonical UI_STATES entry, with the CTA only for users who may enable modules. */
export function moduleDisabledCopy(canEnable: boolean): ModuleDisabledCopy {
  const base = UI_STATES.moduleDisabled;
  if (canEnable) return { title: base.title, message: base.message, cta: ACTIONS.enableModule };
  return {
    title: base.title,
    message: `${base.message} Pide a dirección que lo active en Configuración › Módulos e integraciones.`
  };
}
