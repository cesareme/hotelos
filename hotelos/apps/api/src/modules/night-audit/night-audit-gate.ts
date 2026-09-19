// Cierre del día · puerta de preflight (Tanda L5 · lote L5-D). PURE: no
// Prisma, no clock — runNightAudit feeds it the preflight it just built and
// the body of POST …/night-audit/run; __tests__/night-audit-gate.test.mts runs
// it under `node --test`.
//
// Until L5-D the preflight only guarded the UI: a POST …/run skipped every
// blocker. Now the service decides here:
//   · no blocker                     → allow (a `force` with nothing to force
//                                      records no override: nothing was skipped);
//   · blockers, no force             → blocked → 409 NIGHT_AUDIT_PREFLIGHT_BLOCKED
//                                      with the blocker list;
//   · blockers + force + reasonText  → forced → the run proceeds, the override is
//     (≥ FORCE_REASON_MIN_LENGTH)      audited (NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN)
//                                      and lands in report.preflightOverride;
//   · blockers + force, no reason    → 400 «Indica el motivo para cerrar con bloqueos.»
// The route schema already bounds reasonText (10..1000, trimmed); the gate
// repeats the minimum so a service caller (tests, scripts) gets the same rule.

import { BadRequestError } from "../../lib/http-error.js";

export const FORCE_REASON_MIN_LENGTH = 10;
export const FORCE_REASON_REQUIRED_MESSAGE = "Indica el motivo para cerrar con bloqueos.";

/** One blocking check of the preflight as the API returns it (details.blockers, report.preflightOverride.blockers). */
export type RunGateBlocker = { id: string; title: string; count: number | null; detail: string };

export type RunGatePreflight = {
  canClose: boolean;
  blockingMessage?: string;
  checks: ReadonlyArray<{ id: string; title: string; status: string; count: number | null; detail: string }>;
};

export type RunGateBody = { force?: boolean; reasonText?: string };

export type RunGateDecision =
  | { kind: "allow" }
  | { kind: "blocked"; blockers: RunGateBlocker[]; blockingMessage: string }
  | { kind: "forced"; blockers: RunGateBlocker[]; reasonText: string };

/** The blocking checks of a preflight, in checklist order (pure). */
export function preflightBlockers(preflight: Pick<RunGatePreflight, "checks">): RunGateBlocker[] {
  return preflight.checks
    .filter((check) => check.status === "blocker")
    .map((check) => ({ id: check.id, title: check.title, count: check.count, detail: check.detail }));
}

/** «2 no-shows sin resolver, 13 folios abiertos con saldo» — the blockers by lowercase title (pure). */
export function summarizeBlockers(blockers: ReadonlyArray<Pick<RunGateBlocker, "count" | "title">>): string {
  return blockers.map((blocker) => `${blocker.count ?? "—"} ${blocker.title.toLowerCase()}`).join(", ");
}

/** Message of the 409 NIGHT_AUDIT_PREFLIGHT_BLOCKED (pure). */
export function blockedRunMessage(blockers: ReadonlyArray<Pick<RunGateBlocker, "count" | "title">>): string {
  return `No se puede ejecutar el cierre: ${summarizeBlockers(blockers)}. Resuelve los bloqueos o fuerza el cierre indicando el motivo.`;
}

export function decideRunGate(preflight: RunGatePreflight, body: RunGateBody): RunGateDecision {
  const blockers = preflightBlockers(preflight);
  // A preflight that says canClose=false without a single blocker check is
  // inconsistent; fail closed with the message it carries.
  if (blockers.length === 0 && preflight.canClose) return { kind: "allow" };
  const blockingMessage = blockers.length > 0 ? blockedRunMessage(blockers) : `No se puede ejecutar el cierre: ${preflight.blockingMessage ?? "el preflight no permite cerrar."}`;
  if (!body.force) return { kind: "blocked", blockers, blockingMessage };
  const reasonText = (body.reasonText ?? "").trim();
  if (reasonText.length < FORCE_REASON_MIN_LENGTH) throw new BadRequestError(FORCE_REASON_REQUIRED_MESSAGE);
  return { kind: "forced", blockers, reasonText };
}
