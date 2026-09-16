// Permission helpers of the treasury / banking / commissions / payroll lot.
//
// Route manifest entries are "all keys required"; the finance services used to
// demand `accounting.journal.post` while the routes demanded `payroll.manage` /
// `banking.reconcile`, so only the owner template passed both gates
// (hallazgo FIN-17). The services now accept ANY of the keys the screens'
// templates hold: the accountant (accounting.journal.post) and the manager
// (payroll.manage / banking.reconcile) can both calculate, export and
// reconcile. The error thrown is the shared PermissionDeniedError (403).

import type { PermissionKey } from "@hotelos/shared";
import { assertPermissions } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";

export const TREASURY_WRITE_KEYS: PermissionKey[] = ["banking.reconcile", "accounting.journal.post"];
export const TREASURY_READ_KEYS: PermissionKey[] = ["banking.read", "accounting.read", "accounting.journal.post", "banking.reconcile"];
export const PAYROLL_WRITE_KEYS: PermissionKey[] = ["payroll.manage", "accounting.journal.post"];
/** Lecturas del coste de personal importado (Tanda 6c): lotes, detalle e informe `GET /payroll/cost-report`. */
export const PAYROLL_READ_KEYS: PermissionKey[] = ["payroll.read", "payroll.manage", "accounting.journal.post"];
export const PAYROLL_EXPORT_KEYS: PermissionKey[] = ["payroll.manage", "accounting.journal.post", "workforce.payroll_export"];
export const COMMISSION_WRITE_KEYS: PermissionKey[] = ["accounting.journal.post", "banking.reconcile"];

/** Passes when the context holds at least one of `anyOf`; otherwise throws the standard 403 naming the first key. */
export function requireAnyPermission(context: UserContext, anyOf: PermissionKey[]): void {
  if (anyOf.length === 0) return;
  const held = new Set(context.permissions ?? []);
  if (anyOf.some((key) => held.has(key))) return;
  assertPermissions(context.permissions ?? [], [anyOf[0]!]);
}
