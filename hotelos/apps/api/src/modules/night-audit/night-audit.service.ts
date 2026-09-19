// Night audit (cierre del día) — Finanzas (2026-09-15, lote «pos-noche»).
//
// What a run does for the property's CURRENT business date (business_dates):
//   1. validate_open_folios   · in-house folios inspected (informational);
//   2. snapshot_room_status   · rooms by status;
//   3. post_room_charges      · ONE room charge per in-house reservation for
//                               the business date, priced from the rate grid
//                               (pms/room-charge.service: reservation plan →
//                               BAR → lowest published → reservation total
//                               split across nights); a reservation nothing
//                               prices is a WARNING item («reserva sin
//                               tarifa»), never a 0 € line; idempotent per
//                               (folio, business date, reservation code) so a
//                               re-run of the same day posts nothing twice;
//                               each reservation in its own transaction, with
//                               the folio engine's side effects (routing,
//                               FOLIO_CHARGE_POSTED audit, ChargePosted event);
//   4. process_no_shows       · reservation-lifecycle service (Tanda L3): every
//                               confirmed / draft reservation with arrival <
//                               business date → no_show with its policy, the
//                               penalty on the folio and the folio closed at 0;
//   5. close_settled_folios   · Tanda L5 (L5-D): every OPEN folio of a
//                               cancelled / no-show / checked-out reservation
//                               of the property is closed when its balance is
//                               0 and every charge is documented by an issued
//                               invoice (closeFolio requireInvoiced, actor
//                               nightAuditActor); one settled but not invoiced
//                               is counted `pendingInvoice`, one with a balance
//                               `withBalance` (+ amount) — both as warnings of
//                               the report, never a failure; idempotent (a
//                               second run finds nothing open);
//   6. revenue_snapshot       · folio lines posted inside the property-local
//                               business day, by type;
//   7. payments_summary       · captured payments of the business day by
//                               method (a summary, not a reconciliation: the
//                               cash closure is the count);
//   8. cash_closures          · cash closures of the business date;
//   9. advance_business_date  · business_dates → next day.
// The run row keeps `stepResultsJson = { steps, report }`: `report` is the
// closing report (NightAuditReportWire) the front renders. A completed date
// answers 409 NIGHT_AUDIT_ALREADY_COMPLETED; an in-progress one 409
// NIGHT_AUDIT_IN_PROGRESS; a failed run can be re-executed (idempotent steps).
// Texts are Spanish (they reach the operator and the folio).
//
// Tanda L5 (lote L5-D) · preflight gate: before the run row is written the
// service builds the SAME preflight the screen shows (measured against the
// business date) and decides through night-audit-gate.ts: a blocker without
// `force` → 409 NIGHT_AUDIT_PREFLIGHT_BLOCKED { blockers }; `force: true` +
// `reasonText` (≥ 10) → the run proceeds, NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN is
// audited { blockers, reasonText, businessDate } and the report carries
// `preflightOverride`; `force` without a reason → 400. A preflight without
// blockers ignores `force` (nothing to override). The office 409 and the
// ALREADY_COMPLETED / IN_PROGRESS 409 come first.
//
// Tanda 8a (RBAC · L2, design §4.7 «Cierre del día», H7): running needs
// `night_audit.run` (auditor nocturno; startedBy is the runner); the income
// audit of the next morning is `reviewNightAuditRun` (`night_audit.review`,
// reviewer ≠ runner → 409 RBAC_SOD_CONFLICT runner_ne_reviewer); reopening a
// closed day is `reopenNightAuditRun` (`night_audit.reopen`, a reason code of
// REOPEN_REASON_CODES): within 7 days of the business date the key suffices,
// later the day_reopen approval of the L1 engine by ANOTHER person (the actor
// is treated as the base author, so its own key never approves a late reopen:
// an approved request, a supervisor PIN of someone else, or a privileged
// session). Reopening NEVER reverses entries or charges: it records
// reopenedBy / reopenedAt / reopenReasonCode and status `reopened`; the
// engine only runs the CURRENT business date, so a reopened past day cannot
// be re-run today — it stays recorded for the review (documented limit).
import { ROLE_LEVEL_RANK } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { Prisma as PrismaRuntime } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
// Tanda L3 (lote B): the no-show step lives in reservation-lifecycle.service.ts
// (transitionReservation + policy + folio close); the pure engine stays in
// cancellation-policy.service.ts. No cycle: that file imports pms.service dynamically.
import { nightAuditActor, processNoShows } from "../cancellation-policy/reservation-lifecycle.service.js";
// Tanda L5 (lote L5-D): the settled folios of closed reservations are closed
// with the folio engine itself (same rule as the cancellation engine: balance
// 0 + every charge invoiced). folio.service is already in this module's static
// graph through reservation-lifecycle.service, so no new cycle.
import { closeFolio, folioUninvoicedCharges, getFolioBalance } from "../folio/folio.service.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { isOperationalKind } from "../../lib/tenancy.js";
import { postNightlyRoomChargeTx, quoteNightlyRate, type NightlyPriceSource } from "../pms/room-charge.service.js";
import { formatCalendarDay, resolvePropertyTimeZone, zonedMidnight, zonedParts } from "../pos/pos.service.js";
import { assertApprovedOrAuthorized, registerApprovalDecisionPolicy, type AuthorizationOutcome } from "../rbac/approvals.service.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { assertSeparationOfDuties, sodAuditFields } from "../treasury/permissions.js";
import { foldRoomStateCounts } from "../housekeeping/room-state.service.js";
import { decideRunGate, type RunGateBlocker } from "./night-audit-gate.js";
import { isInHouseOnNight, notYetInHouseDetail, type NightlyPresence } from "./night-audit-in-house.js";
import { buildPreflight } from "./night-audit-preflight.service.js";
import { formatEur, settledFoliosStepDetail, settledFoliosWarnings } from "./night-audit-preflight.texts.js";

const Decimal = PrismaRuntime.Decimal;

export type NightAuditStatus = "not_started" | "in_progress" | "completed" | "failed" | "reopened";

/** Días desde la fecha de negocio dentro de los cuales la clave night_audit.reopen basta (ventana Mews, design §4.7). */
export const NIGHT_AUDIT_REOPEN_WINDOW_DAYS = 7;

/** Catálogo de motivos de reapertura (reopen_reason). */
export const REOPEN_REASON_CODES = {
  missing_charge: "Cargo no contabilizado",
  wrong_charge: "Cargo erróneo",
  no_show_error: "No-show mal procesado",
  payment_correction: "Corrección de cobro",
  audit_finding: "Hallazgo de la revisión (income audit)",
  other: "Otro motivo (indicar en el texto)"
} as const;
export type ReopenReasonCode = keyof typeof REOPEN_REASON_CODES;

export type NightAuditStepResult = {
  step: string;
  status: "ok" | "warning" | "skipped" | "failed";
  detail?: string;
  metrics?: Record<string, number>;
  items?: Array<{ ref: string; label: string; detail?: string }>;
};

export type NightAuditRoomChargeItem = {
  reservationId: string;
  reservationCode: string;
  folioId: string | null;
  outcome: "posted" | "already_posted" | "no_rate" | "no_open_folio";
  amount: string | null;
  priceSource: NightlyPriceSource;
  detail?: string;
};

/** Tanda L5 (L5-D): outcome of the close_settled_folios step (folios of cancelled / no-show / checked-out reservations). */
export type NightAuditSettledFolios = {
  /** Closed tonight (balance 0, every charge invoiced). */
  closed: number;
  /** Settled but with charges no issued invoice documents: left open (warning). */
  pendingInvoice: number;
  /** With a balance (owed or credit): left open (warning). */
  withBalance: number;
  /** Σ |balance| of `withBalance`, as "445.00". */
  totalWithBalance: string;
};

/** Tanda L5 (L5-D): the preflight blockers the runner skipped with `force` + reason (audited NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN). */
export type NightAuditPreflightOverride = { reasonText: string; blockers: RunGateBlocker[] };

export type NightAuditReport = {
  businessDate: string;
  nextBusinessDate: string;
  timeZone: string;
  inHouseReservations: number;
  roomCharges: { posted: number; alreadyPosted: number; withoutRate: number; withoutFolio: number; totalPosted: string; items: NightAuditRoomChargeItem[] };
  noShows: { processed: number; totalCharged: string };
  settledFolios: NightAuditSettledFolios;
  revenue: { total: string; lines: number; byType: Record<string, string> };
  payments: { total: string; count: number; byMethod: Record<string, string> };
  cashClosures: Array<{ outletId: string; status: "open" | "closed" | "approved"; difference: string | null }>;
  warnings: string[];
  /** Present only when the run was forced over preflight blockers. */
  preflightOverride?: NightAuditPreflightOverride;
};

export type NightAuditRunRecord = {
  id: string;
  propertyId: string;
  businessDate: string;
  status: NightAuditStatus;
  startedAt?: string;
  completedAt?: string;
  startedBy?: string;
  stepResults: NightAuditStepResult[];
  report: NightAuditReport | null;
  errorMessage?: string;
  createdAt: string;
  // Tanda 8a: income audit (review) and reopening trace.
  reviewedByUserId?: string | null;
  reviewedAt?: string | null;
  reopenedByUserId?: string | null;
  reopenedAt?: string | null;
  reopenReasonCode?: string | null;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function nextDay(iso: string): string {
  const next = new Date(`${iso}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return isoDate(next);
}

function formatDayEs(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

type StepResultsJson = { steps?: NightAuditStepResult[]; report?: NightAuditReport | null };

function mapRun(row: NonNullable<Awaited<ReturnType<typeof prisma.nightAuditRun.findUnique>>>): NightAuditRunRecord {
  const json = (row.stepResultsJson ?? {}) as StepResultsJson;
  return {
    id: row.id,
    propertyId: row.propertyId,
    businessDate: isoDate(row.businessDate),
    status: row.status as NightAuditStatus,
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    startedBy: row.startedBy ?? undefined,
    stepResults: json.steps ?? [],
    report: json.report ?? null,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    reviewedByUserId: row.reviewedByUserId ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reopenedByUserId: row.reopenedByUserId ?? null,
    reopenedAt: row.reopenedAt?.toISOString() ?? null,
    reopenReasonCode: row.reopenReasonCode ?? null
  };
}

/** `YYYY-MM-DD` of "today" in the property's IANA timezone (UTC when the name is invalid). */
function todayInTimezone(timezone: string): string {
  try {
    // en-CA renders as YYYY-MM-DD; the timeZone option does the offset math.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  } catch {
    return isoDate(new Date());
  }
}

/**
 * Current business date of a property, lazily initialised to the property's
 * local "today" on first use. Nothing else creates the `business_dates` row
 * (no seed, no onboarding step), so before this every property — prop_123
 * included — answered 500 to GET /night-audit/business-date and could never
 * run its first night audit (stepAdvanceBusinessDate updates the row). An
 * unknown property is a 404; a concurrent first call on another replica is
 * absorbed through the unique(propertyId) constraint.
 */
export async function getCurrentBusinessDate(propertyId: string): Promise<string> {
  const row = await prisma.businessDate.findUnique({ where: { propertyId } });
  if (row) return isoDate(row.currentDate);

  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, timezone: true } });
  if (!property) {
    throw new NotFoundError("Propiedad no encontrada.");
  }
  const today = todayInTimezone(property.timezone);
  try {
    const created = await prisma.businessDate.create({ data: { propertyId, currentDate: dateOnly(today) } });
    return isoDate(created.currentDate);
  } catch (error) {
    // P2002: another replica initialised the row between our read and write.
    if ((error as { code?: string }).code === "P2002") {
      const existing = await prisma.businessDate.findUnique({ where: { propertyId } });
      if (existing) return isoDate(existing.currentDate);
    }
    throw error;
  }
}

export async function listNightAuditRuns(propertyId: string): Promise<NightAuditRunRecord[]> {
  const rows = await prisma.nightAuditRun.findMany({
    where: { propertyId },
    orderBy: { businessDate: "desc" },
    take: 30
  });
  return rows.map(mapRun);
}

/** One run (its steps and closing report); 404 when it is not a run of this property. */
export async function getNightAuditRun(propertyId: string, runId: string): Promise<NightAuditRunRecord> {
  const row = await prisma.nightAuditRun.findUnique({ where: { id: runId } });
  if (!row || row.propertyId !== propertyId) throw new NotFoundError("Ejecución del cierre del día no encontrada.");
  return mapRun(row);
}

// ---------------------------------------------------------------------------
// Tanda 8a · income audit (review) and reopening of a closed day
// ---------------------------------------------------------------------------

async function requireRunInProperty(propertyId: string, runId: string) {
  const row = await prisma.nightAuditRun.findUnique({ where: { id: runId } });
  if (!row || row.propertyId !== propertyId) throw new NotFoundError("Ejecución del cierre del día no encontrada.");
  return row;
}

/**
 * POST …/night-audit/runs/:runId/review — the income audit of the next
 * morning: `night_audit.review`, on a completed run, by someone other than
 * the runner (startedBy; a legacy run without runner is «autor desconocido»,
 * annotated). Writes reviewedByUserId / reviewedAt; audit NIGHT_AUDIT_REVIEWED.
 */
export async function reviewNightAuditRun(input: { context: UserContext; propertyId: string; runId: string; note?: string; correlationId: string }): Promise<NightAuditRunRecord> {
  requirePermissions(input.context, ["night_audit.review"]);
  const row = await requireRunInProperty(input.propertyId, input.runId);
  // Corrector L5 (OP-04): un día reabierto que ya no es el último cerrado no se
  // vuelve a ejecutar (la fecha de negocio no retrocede sobre días cerrados
  // después): sus correcciones se revisan sobre el run `reopened`, que así
  // tiene camino de salida en vez de quedar reabierto para siempre.
  if (row.status !== "completed" && row.status !== "reopened") {
    throw new ConflictError("Solo se revisa un cierre del día completado.", { code: "NIGHT_AUDIT_NOT_COMPLETED", status: row.status });
  }
  if (row.reviewedByUserId) {
    throw new ConflictError("Este cierre del día ya está revisado.", { code: "NIGHT_AUDIT_ALREADY_REVIEWED", reviewedByUserId: row.reviewedByUserId, reviewedAt: row.reviewedAt?.toISOString() ?? null });
  }
  const sod = assertSeparationOfDuties(input.context, row.startedBy ?? null, "runner_ne_reviewer", { runId: row.id, businessDate: isoDate(row.businessDate) });
  const reviewedAt = new Date();
  const updated = await prisma.nightAuditRun.update({ where: { id: row.id }, data: { reviewedByUserId: input.context.userId, reviewedAt } });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "NIGHT_AUDIT_REVIEWED",
    entityType: "night_audit_run",
    entityId: row.id,
    beforeJson: { status: row.status, startedBy: row.startedBy ?? null, reviewedByUserId: null },
    afterJson: { businessDate: isoDate(row.businessDate), reviewedByUserId: input.context.userId, reviewedAt: reviewedAt.toISOString(), note: input.note ?? null, ...sodAuditFields(sod) },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return mapRun(updated);
}

/** Calendar days between the business date and «today» in the property's time zone (negative never happens: a future day is 0). Pure. */
export function daysSinceBusinessDate(businessDate: string, todayIso: string): number {
  const from = new Date(`${businessDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${todayIso}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * POST …/night-audit/runs/:runId/reopen — reopens a completed day with a
 * reason code: `night_audit.reopen`; ≤ NIGHT_AUDIT_REOPEN_WINDOW_DAYS since
 * the business date the key suffices; later, the day_reopen approval of the
 * engine by ANOTHER person (see the module header). Nothing is reversed: the
 * run keeps its entries and report; status → `reopened` with the trace.
 */
/** Rank the decider of a late reopen (> NIGHT_AUDIT_REOPEN_WINDOW_DAYS) needs: dirección financiera / general (§4.7). */
export const LATE_REOPEN_MIN_DECIDER_RANK = ROLE_LEVEL_RANK.general_management;

/**
 * Decision policy of `day_reopen` (registered in the approvals engine, §4.7):
 * a request over a run whose business date is past the window can only be
 * APPROVED by dirección financiera / general (rank ≥ general_management);
 * within the window the hotel director decides. Pure over the run row; a
 * missing run leaves the default rule (the executor answers 404 later).
 */
export async function lateReopenDecisionPolicy(request: { entityType: string; entityId: string; propertyId: string | null }): Promise<{ minDeciderRank?: number; reason?: string } | null> {
  if (request.entityType !== "night_audit_run" || !request.propertyId) return null;
  const run = await prisma.nightAuditRun.findFirst({ where: { id: request.entityId, propertyId: request.propertyId }, select: { businessDate: true } });
  if (!run) return null;
  const { timeZone } = await resolvePropertyTimeZone(request.propertyId);
  const days = daysSinceBusinessDate(isoDate(run.businessDate), todayInTimezone(timeZone));
  if (days <= NIGHT_AUDIT_REOPEN_WINDOW_DAYS) return null;
  return { minDeciderRank: LATE_REOPEN_MIN_DECIDER_RANK, reason: `La reapertura de un día cerrado hace más de ${NIGHT_AUDIT_REOPEN_WINDOW_DAYS} días la decide dirección financiera o dirección general.` };
}

registerApprovalDecisionPolicy("day_reopen", (request) => lateReopenDecisionPolicy(request));

export async function reopenNightAuditRun(input: {
  context: UserContext;
  propertyId: string;
  runId: string;
  reasonCode: string;
  reasonText?: string;
  supervisorAuthorizationId?: string | null;
  correlationId: string;
  rbac?: RbacDeps;
}): Promise<NightAuditRunRecord & { daysSinceBusinessDate: number; authorization: AuthorizationOutcome | null; businessDateRewound: boolean; currentBusinessDate: string | null }> {
  requirePermissions(input.context, ["night_audit.reopen"]);
  if (!(input.reasonCode in REOPEN_REASON_CODES)) {
    throw new BadRequestError(`reasonCode no válido: usa uno de ${Object.keys(REOPEN_REASON_CODES).join(", ")}.`);
  }
  const row = await requireRunInProperty(input.propertyId, input.runId);
  if (row.status !== "completed") {
    throw new ConflictError("Solo se reabre un cierre del día completado.", { code: "NIGHT_AUDIT_NOT_COMPLETED", status: row.status });
  }
  const { timeZone } = await resolvePropertyTimeZone(input.propertyId);
  const businessDate = isoDate(row.businessDate);
  const days = daysSinceBusinessDate(businessDate, todayInTimezone(timeZone));
  let authorization: AuthorizationOutcome | null = null;
  if (days > NIGHT_AUDIT_REOPEN_WINDOW_DAYS) {
    // The actor is the base author on purpose: its own key never approves a
    // late reopen (mode 2 refused) — another person must have approved, and
    // that person is dirección financiera / general (§4.7 «DirFin reabre > 7
    // días»): the decider of the consumed request (or the PIN authoriser)
    // needs rank ≥ general_management (corrector 8a · FSOD-05).
    authorization = await assertApprovedOrAuthorized(
      {
        context: input.context,
        kind: "day_reopen",
        entityType: "night_audit_run",
        entityId: row.id,
        propertyId: input.propertyId,
        amount: null,
        baseAuthorUserId: input.context.userId,
        supervisorAuthorizationId: input.supervisorAuthorizationId ?? null,
        minDeciderRank: LATE_REOPEN_MIN_DECIDER_RANK
      },
      input.rbac ?? defaultRbacDeps
    );
  }
  const reopenedAt = new Date();
  // Corrector L5 (OP-04): si el día reabierto es el ÚLTIMO cerrado (la fecha de
  // negocio es justo el día siguiente y no hay ningún run posterior), la fecha de
  // negocio RETROCEDE a ese día: el preflight y POST …/run vuelven a medir y a
  // cerrar ESE día (un run `reopened` se re-ejecuta y queda `completed`). Un día
  // anterior no rebobina nada — la fecha nunca salta hacia atrás sobre días ya
  // cerrados — y sus correcciones se dejan constancia en la revisión.
  const [businessDateRow, laterRun] = await Promise.all([
    prisma.businessDate.findUnique({ where: { propertyId: input.propertyId } }),
    prisma.nightAuditRun.findFirst({ where: { propertyId: input.propertyId, businessDate: { gt: row.businessDate } }, select: { id: true } })
  ]);
  const businessDateRewound = Boolean(businessDateRow) && isoDate(businessDateRow!.currentDate) === nextDay(businessDate) && !laterRun;
  const updated = await prisma.$transaction(async (tx) => {
    const run = await tx.nightAuditRun.update({
      where: { id: row.id },
      data: { status: "reopened", reopenedByUserId: input.context.userId, reopenedAt, reopenReasonCode: input.reasonCode }
    });
    if (businessDateRewound) {
      await tx.businessDate.update({ where: { propertyId: input.propertyId }, data: { currentDate: dateOnly(businessDate), closedAt: null, closedBy: null } });
    }
    return run;
  });
  const currentBusinessDate = businessDateRewound ? businessDate : businessDateRow ? isoDate(businessDateRow.currentDate) : null;
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "NIGHT_AUDIT_REOPENED",
    entityType: "night_audit_run",
    entityId: row.id,
    beforeJson: { status: row.status, startedBy: row.startedBy ?? null, reviewedByUserId: row.reviewedByUserId ?? null },
    afterJson: {
      businessDate,
      daysSinceBusinessDate: days,
      withinWindow: days <= NIGHT_AUDIT_REOPEN_WINDOW_DAYS,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? null,
      reopenedByUserId: input.context.userId,
      reopenedAt: reopenedAt.toISOString(),
      entriesReversed: false,
      businessDateRewound,
      currentBusinessDate,
      authorization: authorization ? { mode: authorization.mode, tier: authorization.tier, requestId: authorization.requestId ?? null, supervisorAuthorizationId: authorization.supervisorAuthorizationId ?? null } : null
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return { ...mapRun(updated), daysSinceBusinessDate: days, authorization, businessDateRewound, currentBusinessDate };
}

type RunContext = { context: UserContext; propertyId: string; correlationId: string; businessDate: string; timeZone: string };

export async function runNightAudit(input: {
  context: UserContext;
  propertyId: string;
  correlationId: string;
  /** Tanda L5 (L5-D): close over preflight blockers — needs `reasonText` (≥ 10 characters). */
  force?: boolean;
  reasonText?: string;
}): Promise<NightAuditRunRecord> {
  // Tanda 8a (H7): the night audit has its own key (night_audit.run); startedBy = the runner.
  requirePermissions(input.context, ["night_audit.run"]);

  // Tanda 6b (R6): the night audit is a lodging routine. The head office and
  // other non-lodging centres have no rooms, no business date to close and no
  // nightly charges: refuse with a typed 409 instead of writing an empty run.
  const centre = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { name: true, kind: true } });
  if (centre && !isOperationalKind(centre.kind)) {
    throw new ConflictError(`«${centre.name}» es un centro de tipo ${centre.kind === "office" ? "oficina" : "otro"}: no tiene habitaciones ni cierre del día.`, {
      code: "WORK_CENTER_NOT_OPERATIONAL",
      kind: centre.kind
    });
  }

  const businessDate = await getCurrentBusinessDate(input.propertyId);
  const businessDateOnly = dateOnly(businessDate);
  const { timeZone } = await resolvePropertyTimeZone(input.propertyId);

  const existing = await prisma.nightAuditRun.findUnique({
    where: { propertyId_businessDate: { propertyId: input.propertyId, businessDate: businessDateOnly } }
  });
  if (existing && existing.status === "completed") {
    throw new ConflictError(`El cierre del día ${formatDayEs(businessDate)} ya está completado.`, { code: "NIGHT_AUDIT_ALREADY_COMPLETED", runId: existing.id, businessDate });
  }
  if (existing && existing.status === "in_progress") {
    throw new ConflictError(`El cierre del día ${formatDayEs(businessDate)} ya está en curso (ejecución ${existing.id}).`, { code: "NIGHT_AUDIT_IN_PROGRESS", runId: existing.id, businessDate });
  }
  // Corrector L5 (OP-04): un run `reopened` (o `failed`) del día en curso se vuelve a
  // ejecutar sobre la misma fila: conserva la traza de reapertura y exige una
  // revisión nueva (reviewedBy se limpia al re-cerrar).

  // Tanda L5 (L5-D): the preflight is a gate, not only a screen. Built AFTER
  // getCurrentBusinessDate (the row exists, so the checks measure this very
  // business date) and BEFORE the run row: a blocked close writes nothing.
  const preflight = await buildPreflight({ propertyId: input.propertyId });
  const gate = decideRunGate(preflight, { force: input.force, reasonText: input.reasonText });
  if (gate.kind === "blocked") {
    throw new ConflictError(gate.blockingMessage, { code: "NIGHT_AUDIT_PREFLIGHT_BLOCKED", businessDate, blockers: gate.blockers });
  }

  const run = await prisma.nightAuditRun.upsert({
    where: { propertyId_businessDate: { propertyId: input.propertyId, businessDate: businessDateOnly } },
    update: {
      status: "in_progress",
      startedAt: new Date(),
      startedBy: input.context.userId,
      errorMessage: null,
      correlationId: input.correlationId,
      stepResultsJson: {},
      reviewedByUserId: null,
      reviewedAt: null
    },
    create: {
      propertyId: input.propertyId,
      businessDate: businessDateOnly,
      status: "in_progress",
      startedAt: new Date(),
      startedBy: input.context.userId,
      correlationId: input.correlationId
    }
  });

  if (gate.kind === "forced") {
    // The override is its own audit row (before NIGHT_AUDIT_STARTED, same
    // correlation): who skipped which blockers, why, for which business date.
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN",
      entityType: "night_audit_run",
      entityId: run.id,
      afterJson: { businessDate, runId: run.id, blockers: gate.blockers, reasonText: gate.reasonText },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "NIGHT_AUDIT_STARTED",
    entityType: "night_audit_run",
    entityId: run.id,
    afterJson: { businessDate, runId: run.id, timeZone, forced: gate.kind === "forced" },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  const ctx: RunContext = { context: input.context, propertyId: input.propertyId, correlationId: input.correlationId, businessDate, timeZone };
  const steps: NightAuditStepResult[] = [];
  const report: NightAuditReport = {
    businessDate,
    nextBusinessDate: nextDay(businessDate),
    timeZone,
    inHouseReservations: 0,
    roomCharges: { posted: 0, alreadyPosted: 0, withoutRate: 0, withoutFolio: 0, totalPosted: "0.00", items: [] },
    noShows: { processed: 0, totalCharged: "0.00" },
    settledFolios: { closed: 0, pendingInvoice: 0, withBalance: 0, totalWithBalance: "0.00" },
    revenue: { total: "0.00", lines: 0, byType: {} },
    payments: { total: "0.00", count: 0, byMethod: {} },
    cashClosures: [],
    warnings: [],
    ...(gate.kind === "forced" ? { preflightOverride: { reasonText: gate.reasonText, blockers: gate.blockers } } : {})
  };

  try {
    steps.push(await stepValidateOpenFolios(ctx, report));
    steps.push(await stepSnapshotRoomStatus(ctx));
    steps.push(await stepPostRoomChargesForInHouse(ctx, report));
    steps.push(await stepProcessNoShows(ctx, report));
    steps.push(await stepCloseSettledFolios(ctx, report));
    steps.push(await stepRevenueSnapshot(ctx, report));
    steps.push(await stepPaymentsSummary(ctx, report));
    steps.push(await stepCashClosures(ctx, report));
    steps.push(await stepAdvanceBusinessDate(ctx));

    const completed = await prisma.nightAuditRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        stepResultsJson: { steps, report } as unknown as Prisma.InputJsonValue
      }
    });

    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "NIGHT_AUDIT_COMPLETED",
      entityType: "night_audit_run",
      entityId: completed.id,
      afterJson: { businessDate, nextBusinessDate: nextDay(businessDate), steps, report },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });

    recordDomainEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      entityType: "night_audit_run",
      entityId: completed.id,
      eventType: "NightAuditCompleted",
      payload: { businessDate, nextBusinessDate: nextDay(businessDate), stepCount: steps.length, roomChargesPosted: report.roomCharges.posted, warnings: report.warnings.length },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });

    return mapRun(completed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[night-audit] corr=${input.correlationId} property=${input.propertyId} businessDate=${businessDate} run=${run.id} failed: ${message}`);
    const failed = await prisma.nightAuditRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
        stepResultsJson: { steps, report } as unknown as Prisma.InputJsonValue
      }
    });

    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "NIGHT_AUDIT_FAILED",
      entityType: "night_audit_run",
      entityId: failed.id,
      afterJson: { businessDate, errorMessage: message, steps, report },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });

    return mapRun(failed);
  }
}

type InHouseReservation = {
  id: string;
  code: string;
  totalAmount: Prisma.Decimal;
  currency: string;
  arrivalDate: Date;
  departureDate: Date;
  roomTypeId: string | null;
  ratePlanId: string | null;
  assignedRoomId: string | null;
};

async function loadInHouse(propertyId: string): Promise<InHouseReservation[]> {
  return prisma.reservation.findMany({
    where: { propertyId, status: "checked_in", deletedAt: null },
    select: { id: true, code: true, totalAmount: true, currency: true, arrivalDate: true, departureDate: true, roomTypeId: true, ratePlanId: true, assignedRoomId: true },
    orderBy: { code: "asc" }
  });
}

async function stepValidateOpenFolios(ctx: RunContext, report: NightAuditReport): Promise<NightAuditStepResult> {
  const inHouse = await loadInHouse(ctx.propertyId);
  const reservationIds = inHouse.map((r) => r.id);
  const openFolios =
    reservationIds.length === 0
      ? []
      : await prisma.folio.findMany({
          where: { status: "open", deletedAt: null, reservationId: { in: reservationIds } },
          select: { id: true, reservationId: true }
        });
  report.inHouseReservations = inHouse.length;
  return {
    step: "validate_open_folios",
    status: "ok",
    detail: `${openFolios.length} folios abiertos de ${inHouse.length} reservas alojadas revisados para el día ${formatDayEs(ctx.businessDate)}.`,
    metrics: { inHouseFolios: openFolios.length, inHouseReservations: inHouse.length }
  };
}

async function stepSnapshotRoomStatus(ctx: RunContext): Promise<NightAuditStepResult> {
  // Corrector L5 (OP-06): misma clasificación que /dashboards/housekeeping y el Room
  // Rack (foldRoomStateCounts): limpieza por housekeepingStatus en TODAS las
  // ocupaciones; ocupadas y fuera de orden / servicio por `status`.
  // Integrador L5 (INT-L5-07): active rooms only, the same set as the dashboards.
  const rows = await prisma.room.groupBy({
    by: ["status", "housekeepingStatus"],
    where: { propertyId: ctx.propertyId, active: true },
    _count: { _all: true }
  });
  const counts = foldRoomStateCounts(rows.map((row) => ({ status: String(row.status), housekeepingStatus: row.housekeepingStatus, count: row._count._all })));
  const metrics: Record<string, number> = {
    clean: counts.clean,
    dirty: counts.dirty,
    inspected: counts.inspected,
    occupied: counts.occupied,
    out_of_order: counts.outOfOrder,
    total: counts.total
  };
  return {
    step: "snapshot_room_status",
    status: "ok",
    detail: `Instantánea de ${counts.total} habitaciones por estado.`,
    metrics
  };
}

/**
 * Room charge of the business date for every in-house reservation (see the
 * header). One transaction per reservation: a failure on one folio (closed
 * folio, lost lock…) is reported as an item and the others still post.
 */
async function stepPostRoomChargesForInHouse(ctx: RunContext, report: NightAuditReport): Promise<NightAuditStepResult> {
  const inHouse = await loadInHouse(ctx.propertyId);
  if (inHouse.length === 0) {
    return { step: "post_room_charges", status: "skipped", detail: "No hay reservas alojadas: sin cargos de alojamiento." };
  }
  // Tanda L5 · integrador (INT-L5-01): only the reservations in house THAT
  // night are charged — min(booked arrival, physical check-in day in the
  // property's time zone) ≤ business date (night-audit-in-house.ts). A lagging
  // business date (pilot: 13/09 → 19/09 closed in one go) must not bill a
  // guest for the nights before they arrived.
  const stays = await prisma.stay.findMany({
    where: { reservationId: { in: inHouse.map((r) => r.id) }, status: "in_house", checkinAt: { not: null } },
    select: { reservationId: true, checkinAt: true }
  });
  const checkInDayByReservation = new Map<string, string>();
  for (const stay of stays) {
    if (!stay.checkinAt) continue;
    const day = formatCalendarDay(zonedParts(stay.checkinAt, ctx.timeZone));
    const known = checkInDayByReservation.get(stay.reservationId);
    if (!known || day < known) checkInDayByReservation.set(stay.reservationId, day);
  }
  const presenceOf = (reservation: InHouseReservation): NightlyPresence => ({
    arrivalDay: isoDate(reservation.arrivalDate),
    checkInDay: checkInDayByReservation.get(reservation.id) ?? null
  });
  const notYetInHouse = inHouse.filter((reservation) => !isInHouseOnNight(presenceOf(reservation), ctx.businessDate));
  const notYetInHouseIds = new Set(notYetInHouse.map((reservation) => reservation.id));
  const roomTypeIds = Array.from(new Set(inHouse.map((r) => r.roomTypeId).filter((id): id is string => Boolean(id))));
  const roomTypes = roomTypeIds.length ? await prisma.roomType.findMany({ where: { id: { in: roomTypeIds } }, select: { id: true, name: true } }) : [];
  const roomTypeName = new Map(roomTypes.map((rt) => [rt.id, rt.name]));

  const items: NightAuditRoomChargeItem[] = [];
  let totalPosted = new Decimal(0);
  const postedLines: Array<{ lineId: string; folioId: string; total: string; description: string; reservationId: string }> = [];

  // Tanda L2 (L2-06): the open folios of every in-house reservation in ONE
  // query (was one findFirst per reservation). Same selection rule as before:
  // primary first, then lowest id — the first row per reservation wins.
  const openFolios = await prisma.folio.findMany({
    where: { reservationId: { in: inHouse.map((r) => r.id) }, status: "open", deletedAt: null },
    orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
    select: { id: true, reservationId: true }
  });
  const folioByReservation = new Map<string, { id: string }>();
  for (const row of openFolios) {
    if (!folioByReservation.has(row.reservationId)) folioByReservation.set(row.reservationId, { id: row.id });
  }

  for (const reservation of inHouse) {
    if (notYetInHouseIds.has(reservation.id)) continue;
    const folio = folioByReservation.get(reservation.id) ?? null;
    if (!folio) {
      items.push({ reservationId: reservation.id, reservationCode: reservation.code, folioId: null, outcome: "no_open_folio", amount: null, priceSource: "none", detail: "Sin folio abierto: no se ha cargado el alojamiento." });
      continue;
    }
    const quote = await quoteNightlyRate(prisma, {
      propertyId: ctx.propertyId,
      date: ctx.businessDate,
      reservation: {
        roomTypeId: reservation.roomTypeId,
        ratePlanId: reservation.ratePlanId,
        assignedRoomId: reservation.assignedRoomId,
        totalAmount: reservation.totalAmount,
        arrivalDate: reservation.arrivalDate,
        departureDate: reservation.departureDate,
        currency: reservation.currency
      }
    });
    if (quote.price === null) {
      items.push({ reservationId: reservation.id, reservationCode: reservation.code, folioId: folio.id, outcome: "no_rate", amount: null, priceSource: quote.source, detail: quote.warning ?? "Reserva sin tarifa." });
      continue;
    }
    try {
      const posted = await prisma.$transaction(
        (tx) =>
          postNightlyRoomChargeTx(tx, {
            folioId: folio.id,
            reservationCode: reservation.code,
            businessDate: ctx.businessDate,
            unitPrice: quote.price as string,
            postedBy: ctx.context.userId,
            roomTypeName: reservation.roomTypeId ? roomTypeName.get(reservation.roomTypeId) ?? null : null
          }),
        { maxWait: 10_000, timeout: 20_000 }
      );
      if (posted.created) {
        totalPosted = totalPosted.plus(posted.total);
        postedLines.push({ lineId: posted.lineId, folioId: posted.folioId, total: posted.total, description: posted.description, reservationId: reservation.id });
        items.push({ reservationId: reservation.id, reservationCode: reservation.code, folioId: folio.id, outcome: "posted", amount: posted.total, priceSource: quote.source, detail: quote.warning ?? undefined });
      } else {
        items.push({ reservationId: reservation.id, reservationCode: reservation.code, folioId: folio.id, outcome: "already_posted", amount: posted.total, priceSource: quote.source, detail: "El cargo de esta noche ya estaba en el folio." });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[night-audit] corr=${ctx.correlationId} room charge failed for ${reservation.code} (folio ${folio.id}): ${message}`);
      items.push({ reservationId: reservation.id, reservationCode: reservation.code, folioId: folio.id, outcome: "no_open_folio", amount: null, priceSource: quote.source, detail: message });
    }
  }

  // Folio-engine side effects, after the commits (same as folio.service.postFolioLine).
  // DP-08 (corrector L2): one dynamic import for the whole batch and ONE
  // folio_lines read after routing (a routed line may have moved folio), instead
  // of an import + a findUnique per posted line.
  const { routeLine } = await import("../folio/folio-routing.service.js");
  for (const line of postedLines) {
    try {
      await routeLine({ lineId: line.lineId, context: ctx.context, correlationId: ctx.correlationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[night-audit] corr=${ctx.correlationId} routing failed for line ${line.lineId}: ${message}`);
      recordAuditEvent({
        organizationId: ctx.context.organizationId,
        propertyId: ctx.propertyId,
        actorUserId: ctx.context.userId,
        actorType: "system",
        action: "FOLIO_ROUTING_FAILED",
        entityType: "folio_line",
        entityId: line.lineId,
        afterJson: { lineId: line.lineId, folioId: line.folioId, lineType: "room", error: message },
        correlationId: ctx.correlationId
      });
    }
  }
  const finalRows = postedLines.length > 0
    ? await prisma.folioLine.findMany({ where: { id: { in: postedLines.map((line) => line.lineId) } }, select: { id: true, folioId: true, postedAt: true } })
    : [];
  const finalLines = new Map(finalRows.map((row) => [row.id, row]));
  for (const line of postedLines) {
    const finalLine = finalLines.get(line.lineId);
    recordAuditEvent({
      organizationId: ctx.context.organizationId,
      propertyId: ctx.propertyId,
      actorUserId: ctx.context.userId,
      actorType: "user",
      action: "FOLIO_CHARGE_POSTED",
      entityType: "folio_line",
      entityId: line.lineId,
      afterJson: {
        id: line.lineId,
        folioId: finalLine?.folioId ?? line.folioId,
        type: "room",
        taxCategory: "accommodation",
        description: line.description,
        quantity: 1,
        unitPrice: Number(line.total),
        total: Number(line.total),
        postedAt: (finalLine?.postedAt ?? new Date()).toISOString(),
        postedBy: ctx.context.userId,
        source: "night_audit",
        businessDate: ctx.businessDate,
        reservationId: line.reservationId
      },
      correlationId: ctx.correlationId
    });
    recordDomainEvent({
      organizationId: ctx.context.organizationId,
      propertyId: ctx.propertyId,
      entityType: "folio",
      entityId: finalLine?.folioId ?? line.folioId,
      eventType: "ChargePosted",
      payload: { lineId: line.lineId, total: Number(line.total), type: "room", source: "night_audit", businessDate: ctx.businessDate },
      actorType: "user",
      actorUserId: ctx.context.userId,
      correlationId: ctx.correlationId
    });
  }

  const posted = items.filter((i) => i.outcome === "posted").length;
  const alreadyPosted = items.filter((i) => i.outcome === "already_posted").length;
  const withoutRate = items.filter((i) => i.outcome === "no_rate").length;
  const withoutFolio = items.filter((i) => i.outcome === "no_open_folio").length;
  report.roomCharges = { posted, alreadyPosted, withoutRate, withoutFolio, totalPosted: totalPosted.toFixed(2), items };
  for (const item of items) {
    if (item.outcome === "no_rate") report.warnings.push(`Reserva ${item.reservationCode} sin tarifa para la noche del ${formatDayEs(ctx.businessDate)}: no se ha cargado el alojamiento.`);
    if (item.outcome === "no_open_folio") report.warnings.push(`Reserva ${item.reservationCode}: ${item.detail ?? "sin folio abierto"}.`);
  }
  const warnings = withoutRate + withoutFolio;
  return {
    step: "post_room_charges",
    status: warnings > 0 ? "warning" : "ok",
    detail:
      `Cargos de alojamiento del ${formatDayEs(ctx.businessDate)}: ${posted} nuevos (${totalPosted.toFixed(2)} €), ${alreadyPosted} ya existentes` +
      (withoutRate > 0 ? `, ${withoutRate} reservas sin tarifa` : "") +
      (withoutFolio > 0 ? `, ${withoutFolio} sin folio abierto` : "") +
      (notYetInHouse.length > 0 ? `, ${notYetInHouse.length} aún no alojadas esa noche` : "") +
      ".",
    metrics: { postedCharges: posted, alreadyPosted, withoutRate, withoutFolio, notYetInHouse: notYetInHouse.length, inHouseReservations: inHouse.length, totalPosted: Number(totalPosted.toFixed(2)) },
    items: [
      ...items.filter((i) => i.outcome !== "posted").map((i) => ({ ref: i.reservationId, label: i.reservationCode, detail: i.detail })),
      ...notYetInHouse.map((reservation) => ({ ref: reservation.id, label: reservation.code, detail: notYetInHouseDetail(presenceOf(reservation)) }))
    ]
  };
}

// Process no-shows: any confirmed/draft reservation whose arrival is in the
// past and that never checked in becomes status="no_show" and its
// CancellationPolicy auto-posts the no-show fee to the folio.
async function stepProcessNoShows(ctx: RunContext, report: NightAuditReport): Promise<NightAuditStepResult> {
  const result = await processNoShows({
    context: ctx.context,
    propertyId: ctx.propertyId,
    businessDate: dateOnly(ctx.businessDate),
    correlationId: ctx.correlationId
  });
  const totalCharged = new Decimal(result.totalChargedEur).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  report.noShows = { processed: result.processedCount, totalCharged: totalCharged.toFixed(2) };
  return {
    step: "process_no_shows",
    status: "ok",
    detail:
      result.processedCount > 0
        ? `${result.processedCount} reserva(s) marcadas como no-show con ${totalCharged.toFixed(2)} € de penalización.`
        : "Sin no-shows pendientes.",
    metrics: { processedCount: result.processedCount, totalChargedEur: Number(totalCharged.toFixed(2)) }
  };
}

/**
 * Tanda L5 (L5-D): reservation statuses whose stay is over. Their open folios
 * are closed by close_settled_folios when settled; the same set drives the
 * «se cerrarán en el cierre» hint of the preflight (SETTLED_FOLIO_RESERVATION_STATUSES).
 */
export const SETTLED_RESERVATION_STATUSES = ["cancelled", "no_show", "checked_out"] as const;

/** Upper bound of folios one run inspects (a property with more keeps the rest for the next night). */
const SETTLED_FOLIOS_PER_RUN = 500;

/**
 * close_settled_folios — every OPEN folio (deletedAt null) of a cancelled /
 * no-show / checked-out reservation of the property:
 *   · |balance| < 0,005 (closeFolio tolerance) and every charge invoiced →
 *     closeFolio (requireInvoiced, actor nightAuditActor: the runner already
 *     holds night_audit.run; FOLIO_CLOSED audited by the folio engine);
 *   · settled but with charges no issued invoice documents → `pendingInvoice`
 *     (the invoice is the only mechanism that accrues them into the ledger);
 *   · with a balance (owed or credit) → `withBalance` + amount.
 * The last two are report warnings (settledFoliosWarnings), never a failure:
 * the four checked-out folios of the pilot with a balance stay a business
 * decision. A folio the engine refuses unexpectedly is an item + warning and
 * the step ends «warning». Idempotent: a second run finds nothing open.
 */
async function stepCloseSettledFolios(ctx: RunContext, report: NightAuditReport): Promise<NightAuditStepResult> {
  const folios = await prisma.folio.findMany({
    where: { status: "open", deletedAt: null, reservation: { propertyId: ctx.propertyId, status: { in: [...SETTLED_RESERVATION_STATUSES] } } },
    select: { id: true, reservationId: true, reservation: { select: { code: true, status: true } } },
    orderBy: { id: "asc" },
    take: SETTLED_FOLIOS_PER_RUN
  });
  const actor = nightAuditActor(ctx.context);
  const items: NonNullable<NightAuditStepResult["items"]> = [];
  let closed = 0;
  let pendingInvoice = 0;
  let withBalance = 0;
  let failed = 0;
  let totalWithBalance = new Decimal(0);
  for (const folio of folios) {
    const label = folio.reservation.code;
    try {
      const balance = await getFolioBalance(folio.id);
      if (Math.abs(balance.balanceDue) >= 0.005) {
        withBalance += 1;
        totalWithBalance = totalWithBalance.plus(new Decimal(Math.abs(balance.balanceDue)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
        items.push({ ref: folio.id, label, detail: `Saldo ${formatEur(balance.balanceDue)}: el folio sigue abierto.` });
        continue;
      }
      const pending = await folioUninvoicedCharges(folio.id);
      if (pending.lines > 0) {
        pendingInvoice += 1;
        items.push({ ref: folio.id, label, detail: `${pending.lines === 1 ? "1 cargo" : `${pending.lines} cargos`} por ${formatEur(pending.total)} sin facturar: emite la factura para cerrarlo.` });
        continue;
      }
      await closeFolio({ context: actor, folioId: folio.id, correlationId: ctx.correlationId, requireInvoiced: true });
      closed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      console.error(`[night-audit] corr=${ctx.correlationId} close_settled_folios failed for ${label} (folio ${folio.id}): ${message}`);
      items.push({ ref: folio.id, label, detail: message });
      report.warnings.push(`Folio de la reserva ${label} (${folio.reservation.status === "checked_out" ? "con salida hecha" : folio.reservation.status === "no_show" ? "no presentada" : "cancelada"}): ${message}`);
    }
  }
  const figures = { closed, pendingInvoice, withBalance, totalWithBalance: Number(totalWithBalance.toFixed(2)) };
  report.settledFolios = { closed, pendingInvoice, withBalance, totalWithBalance: totalWithBalance.toFixed(2) };
  report.warnings.push(...settledFoliosWarnings(figures));
  return {
    step: "close_settled_folios",
    status: failed > 0 ? "warning" : "ok",
    detail:
      folios.length === 0
        ? "Sin folios abiertos de reservas canceladas, no presentadas o con salida hecha."
        : settledFoliosStepDetail(figures) + (failed > 0 ? ` ${failed} no se ${failed === 1 ? "pudo" : "pudieron"} revisar.` : ""),
    metrics: { candidates: folios.length, closed, pendingInvoice, withBalance, totalWithBalance: figures.totalWithBalance, failed },
    items
  };
}

/** [local midnight of the business date, local midnight of the next day) in the property's time zone. */
function businessDayWindow(ctx: RunContext): { from: Date; to: Date } {
  const [y, m, d] = ctx.businessDate.split("-").map(Number) as [number, number, number];
  const next = nextDay(ctx.businessDate).split("-").map(Number) as [number, number, number];
  return { from: zonedMidnight(y, m, d, ctx.timeZone), to: zonedMidnight(next[0], next[1], next[2], ctx.timeZone) };
}

async function stepRevenueSnapshot(ctx: RunContext, report: NightAuditReport): Promise<NightAuditStepResult> {
  const window = businessDayWindow(ctx);
  // Resolve property's folios first (no @relation declared on Folio → property).
  const reservations = await prisma.reservation.findMany({ where: { propertyId: ctx.propertyId }, select: { id: true } });
  const reservationIds = reservations.map((r) => r.id);
  const folios = reservationIds.length === 0 ? [] : await prisma.folio.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } });
  const folioIds = folios.map((f) => f.id);
  const lines =
    folioIds.length === 0
      ? []
      : await prisma.folioLine.findMany({
          where: { folioId: { in: folioIds }, deletedAt: null, postedAt: { gte: window.from, lt: window.to } },
          select: { total: true, type: true }
        });

  const totalsByType = new Map<string, PrismaRuntime.Decimal>();
  let total = new Decimal(0);
  for (const line of lines) {
    const amount = new Decimal(line.total);
    totalsByType.set(line.type, (totalsByType.get(line.type) ?? new Decimal(0)).plus(amount));
    total = total.plus(amount);
  }
  const byType: Record<string, string> = {};
  const metrics: Record<string, number> = { totalRevenue: Number(total.toFixed(2)), lineCount: lines.length };
  for (const [type, amount] of totalsByType) {
    byType[type] = amount.toFixed(2);
    metrics[`revenue_${type}`] = Number(amount.toFixed(2));
  }
  report.revenue = { total: total.toFixed(2), lines: lines.length, byType };
  return {
    step: "revenue_snapshot",
    status: "ok",
    detail: `Producción del ${formatDayEs(ctx.businessDate)}: ${total.toFixed(2)} € en ${lines.length} cargos.`,
    metrics
  };
}

async function stepPaymentsSummary(ctx: RunContext, report: NightAuditReport): Promise<NightAuditStepResult> {
  const window = businessDayWindow(ctx);
  const captured = await prisma.payment.findMany({
    where: { propertyId: ctx.propertyId, deletedAt: null, status: { in: ["captured", "refunded"] }, reversalOfId: null, createdAt: { gte: window.from, lt: window.to } },
    select: { amount: true, method: true, methodCode: true }
  });
  const totalsByMethod = new Map<string, PrismaRuntime.Decimal>();
  let total = new Decimal(0);
  for (const p of captured) {
    const method = p.methodCode ?? p.method;
    const amount = new Decimal(p.amount);
    totalsByMethod.set(method, (totalsByMethod.get(method) ?? new Decimal(0)).plus(amount));
    total = total.plus(amount);
  }
  const byMethod: Record<string, string> = {};
  const metrics: Record<string, number> = { totalCaptured: Number(total.toFixed(2)), paymentCount: captured.length };
  for (const [method, amount] of totalsByMethod) {
    byMethod[method] = amount.toFixed(2);
    metrics[`captured_${method}`] = Number(amount.toFixed(2));
  }
  report.payments = { total: total.toFixed(2), count: captured.length, byMethod };
  return {
    step: "payments_summary",
    status: "ok",
    detail: `Cobros del ${formatDayEs(ctx.businessDate)}: ${total.toFixed(2)} € en ${captured.length} cobros (el arqueo de caja es el recuento).`,
    metrics
  };
}

/** Cash closures of the business date (informational: an open count is a warning for the operator). */
async function stepCashClosures(ctx: RunContext, report: NightAuditReport): Promise<NightAuditStepResult> {
  const rows = await prisma.cashClosure.findMany({
    where: { propertyId: ctx.propertyId, businessDate: dateOnly(ctx.businessDate) },
    select: { outletId: true, status: true, difference: true },
    orderBy: { outletId: "asc" }
  });
  report.cashClosures = rows.map((row) => ({ outletId: row.outletId, status: row.status, difference: row.difference === null ? null : new Decimal(row.difference).toFixed(2) }));
  const open = rows.filter((row) => row.status === "open").length;
  if (open > 0) report.warnings.push(`${open} cierre(s) de caja del ${formatDayEs(ctx.businessDate)} siguen abiertos.`);
  return {
    step: "cash_closures",
    status: open > 0 ? "warning" : "ok",
    detail: rows.length === 0 ? `Sin cierres de caja registrados para el ${formatDayEs(ctx.businessDate)}.` : `${rows.length} cierre(s) de caja: ${rows.length - open} cerrados/aprobados, ${open} abiertos.`,
    metrics: { closures: rows.length, open }
  };
}

async function stepAdvanceBusinessDate(ctx: RunContext): Promise<NightAuditStepResult> {
  const next = nextDay(ctx.businessDate);
  await prisma.businessDate.update({
    where: { propertyId: ctx.propertyId },
    data: {
      currentDate: dateOnly(next),
      closedAt: new Date(),
      closedBy: ctx.context.userId
    }
  });
  return {
    step: "advance_business_date",
    status: "ok",
    detail: `Fecha de negocio avanzada de ${formatDayEs(ctx.businessDate)} a ${formatDayEs(next)}.`,
    metrics: {}
  };
}
