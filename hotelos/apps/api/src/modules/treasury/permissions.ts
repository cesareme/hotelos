// Permission helpers of the treasury / banking / commissions / payroll lot.
//
// Route manifest entries are "all keys required"; the finance services used to
// demand `accounting.journal.post` while the routes demanded `payroll.manage` /
// `banking.reconcile`, so only the owner template passed both gates
// (hallazgo FIN-17). The services accept ANY of the keys the screens'
// templates hold: the accountant (accounting.journal.post) and the manager
// (banking.reconcile) can both reconcile. The error thrown is the shared
// PermissionDeniedError (403).
//
// Tanda 8a (RBAC · L2, design §4.7 / H5): payroll leaves `accountant`.
// Preparing (`payroll.manage`) is the RRHH key alone; approving is
// `payroll.approve` (general management); paying is `payables.pay`
// (dirección financiera). `accounting.journal.post` no longer opens the
// payroll writers: contabilidad posts the entries the calculation produces,
// it never prepares or pays a payroll (static SoD pairs of
// packages/shared/src/rbac-types.ts).
//
// This file also hosts the DYNAMIC separation-of-duties helper every L2
// service uses over the author columns of L0 (capturedByUserId,
// issuedByUserId, createdByUserId, startedBy, calculatedByUserId,
// approvedByUserId…): see `assertSeparationOfDuties`.

import type { PermissionKey } from "@hotelos/shared";
import { assertPermissions } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError } from "../../lib/http-error.js";

export const TREASURY_WRITE_KEYS: PermissionKey[] = ["banking.reconcile", "accounting.journal.post"];
/**
 * Tanda 8a (corrector · FSOD-01): ordering a supplier remittance (Norma 34) is
 * a PAYMENT — `POST /treasury/sepa/supplier-payments` is gated by payables.pay
 * (dirección financiera) and the SoD pairs forbid holding it together with
 * banking.reconcile / accounting.journal.post, so the remittance builder and
 * writer accept payables.pay as well as the treasury keys of the bank routes
 * (the route manifest decides which key each route demands).
 */
export const REMITTANCE_WRITE_KEYS: PermissionKey[] = [...TREASURY_WRITE_KEYS, "payables.pay"];
export const TREASURY_READ_KEYS: PermissionKey[] = ["banking.read", "accounting.read", "accounting.journal.post", "banking.reconcile"];
/** Tanda 8a: preparing a payroll (periods, contracts, recalculation) is the RRHH key only. */
export const PAYROLL_WRITE_KEYS: PermissionKey[] = ["payroll.manage"];
/** Lecturas del coste de personal importado (Tanda 6c): lotes, detalle e informe `GET /payroll/cost-report`. */
export const PAYROLL_READ_KEYS: PermissionKey[] = ["payroll.read", "payroll.manage"];
export const PAYROLL_EXPORT_KEYS: PermissionKey[] = ["payroll.manage", "workforce.payroll_export"];
export const COMMISSION_WRITE_KEYS: PermissionKey[] = ["accounting.journal.post", "banking.reconcile"];

/** Passes when the context holds at least one of `anyOf`; otherwise throws the standard 403 naming the first key. */
export function requireAnyPermission(context: UserContext, anyOf: PermissionKey[]): void {
  if (anyOf.length === 0) return;
  const held = new Set(context.permissions ?? []);
  if (anyOf.some((key) => held.has(key))) return;
  assertPermissions(context.permissions ?? [], [anyOf[0]!]);
}

// ---------------------------------------------------------------------------
// Dynamic separation of duties (Tanda 8a · L2, design §4.7)
// ---------------------------------------------------------------------------

/** Rules evaluated over the author columns (the `rule` travels in the 409 body and in the audit). */
export type SodRule =
  | "requester_ne_executor"
  | "issuer_ne_canceller"
  | "creator_ne_approver"
  | "creator_ne_payer"
  | "approver_ne_payer"
  | "runner_ne_reviewer"
  | "calculator_ne_approver"
  | "requester_ne_receiver"
  | "proposer_ne_approver";

export type SodCheckOutcome = {
  rule: SodRule;
  /** Author of the base operation as stored (null = row written before the migration). */
  authorUserId: string | null;
  /** True when the row carries no author: «autor desconocido», never blocks, always annotated. */
  authorUnknown: boolean;
  /** Set when the actor IS the author but the session is privileged (audited exception of the L1 engine). */
  privileged: "platform_admin" | "break_glass" | null;
};

export const SOD_CONFLICT_CODE = "RBAC_SOD_CONFLICT";

const SOD_MESSAGES_ES: Record<SodRule, string> = {
  requester_ne_executor: "Quien solicita una operación no puede ejecutarla.",
  issuer_ne_canceller: "Quien emitió la factura no puede anularla: la anulación la registra otra persona.",
  creator_ne_approver: "Quien registró el documento no puede aprobarlo.",
  creator_ne_payer: "Quien registró la factura no puede pagarla.",
  approver_ne_payer: "Quien aprobó la factura no puede pagarla.",
  runner_ne_reviewer: "Quien ejecutó el cierre del día no puede revisarlo.",
  calculator_ne_approver: "Quien calculó la nómina no puede aprobarla.",
  requester_ne_receiver: "Quien solicitó el pedido no puede recepcionarlo.",
  proposer_ne_approver: "Quien propuso el proyecto no puede aprobarlo."
};

/**
 * Dynamic SoD over the author columns: the actor may not be the author of the
 * base operation (solicita ≠ aprueba ≠ ejecuta). Contract:
 *   · author null (row before the migration, legacy writer) → «autor
 *     desconocido»: it never blocks; the caller writes `authorUnknown` in its
 *     audit event so the review sees it;
 *   · actor = author → 409 RBAC_SOD_CONFLICT { rule, authorUserId } — except a
 *     platform admin or a break-glass session, the two audited exceptions the
 *     L1 engine already grants (assertApprovedOrAuthorized mode 3): the check
 *     passes and returns `privileged`, which the caller MUST audit;
 *   · anything else → passes.
 * Pure (no I/O): unit-testable with a fake context.
 */
export function assertSeparationOfDuties(
  context: Pick<UserContext, "userId" | "isPlatformAdmin" | "breakGlassSessionId">,
  authorUserId: string | null | undefined,
  rule: SodRule,
  details: Record<string, unknown> = {}
): SodCheckOutcome {
  const author = authorUserId ?? null;
  const outcome: SodCheckOutcome = { rule, authorUserId: author, authorUnknown: author === null, privileged: null };
  if (author === null || author !== context.userId) return outcome;
  if (context.isPlatformAdmin === true) return { ...outcome, privileged: "platform_admin" };
  if (typeof context.breakGlassSessionId === "string" && context.breakGlassSessionId.length > 0) return { ...outcome, privileged: "break_glass" };
  throw new ConflictError(SOD_MESSAGES_ES[rule], { code: SOD_CONFLICT_CODE, rule, authorUserId: author, ...details });
}

/** Audit fragment of a SoD check (spread into `afterJson`). */
export function sodAuditFields(outcome: SodCheckOutcome): Record<string, unknown> {
  return { sod: { rule: outcome.rule, authorUserId: outcome.authorUserId, authorUnknown: outcome.authorUnknown, privileged: outcome.privileged } };
}
