// Reservation lifecycle with cancellation policy (Tanda L3 · lote B; corrector
// L3 ronda 1: DS-01 / DS-02 / DS-07 / FC-1 / FC-2).
//
// Orchestrates «cancel» / «no-show» end to end: state guard (only a LIVE
// reservation — draft or confirmed — can be cancelled or marked no-show; a
// second call is a 409, never a second penalty) → preview of the penalty →
// separation-of-duties checks BEFORE any write → status transition
// (transitionReservation: conditional update on the live status, SES baja,
// audit, domain event) → penalty line on the folio (`cancellation_fee` /
// `no_show_fee`, not_subject; idempotent per reservation and mode) → folio
// closed when its balance is 0 AND every charge is documented by an issued
// invoice; a folio with a penalty nobody invoiced stays OPEN with
// `pendingInvoice: true` so the document (F1/F2 from the folio) is issued
// before the close — the invoice is the only mechanism that accrues the
// charge into the ledger (D 4300 / H 705.3); decision §6.6 (no sweep of
// historical cancellations) stands.
//
// WHY A SEPARATE FILE: pms.service.ts imports getCurrentBusinessDate from
// night-audit.service.ts, which imports processNoShows from this module. If
// cancellation-policy.service.ts imported transitionReservation statically the
// cycle pms → night-audit → cancellation-policy → pms would leave one of them
// in temporal dead zone at load. This file keeps the static imports on the
// pure engine, folio, rbac and auth services only, and takes
// transitionReservation through a DYNAMIC import at the point of use.
//
// SoD (T8a keys and kinds, none new):
//   · applying a penalty > 0 needs `folio.charge.post` (the /cancel route only
//     declares pms.reservation.modify; e.g. the `sales` template has modify
//     without charge.post) — checked here, before writing, so a refusal is a
//     403 with no side effect;
//   · waiving a penalty > 0 (`applyPolicy: false`) is a discount of 100 % of
//     the amount waived and goes through the SAME bands as the reservation
//     discount gate (pms.service assertReservationDiscountAuthorized, §4.7):
//     ≤ T1 (amount ≤ discount.T1 AND ≤ discountPctT1 of the stay) → the
//     `pms.reservation.discount` key + a mandatory reason; ≤ discountPctT2 →
//     the approvals engine (kind `discount`: an approved request of another
//     person, the actor's own `pms.reservation.override` within tier, or a
//     supervisor PIN through `supervisorAuthorizationId`); above → explicit
//     approval only (no PIN). 409 APPROVAL_REQUIRED before any write; the
//     outcome is audited with `policyWaived: true`, `waivedAmount` and the
//     authorisation (band, tier, mode).
//   · the night-audit step (`processNoShows`) acts with the authority of
//     `night_audit.run` already required by runNightAudit: the runner gets
//     `pms.reservation.modify` for that step only when the template lacks it
//     (night_auditor has night_audit.run and folio.charge.post but not modify —
//     decision §6.19, alternative: a `trusted` mode on transitionReservation).
//
// Audit: transitionReservation records RESERVATION_CANCELLED / RESERVATION_NO_SHOW
// (pms.service.ts, lote A). This module records the companion event
// RESERVATION_CANCELLATION_POLICY on the same correlationId with the structured
// outcome (policyWaived, waivedAmount, waiver, charge, folio, autoNoShow, source).
import { hasPermission } from "@hotelos/shared";
import type { ThresholdTier } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { FolioLineRecord, ReservationRecord, UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { closeFolio, folioUninvoicedCharges, getFolioBalance } from "../folio/folio.service.js";
import { assertApprovedOrAuthorized, type AuthorizationOutcome } from "../rbac/approvals.service.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { getThresholds, type OrganizationThresholds } from "../rbac/thresholds.service.js";
import { chargeToFolio, computeCancellationCharge, round2, type ChargeBreakdown, type ChargeMode } from "./cancellation-policy.service.js";

export type LifecycleFolioOutcome = {
  id: string;
  status: "open" | "closed";
  balanceDue: number;
  /**
   * Corrector L3 (FC-2): the folio is settled (balance 0) but still holds
   * charges no issued invoice documents (the penalty, typically): it stays
   * open until the invoice is issued, then it can be closed.
   */
  pendingInvoice: boolean;
};

/** Band of a waived penalty under the discount thresholds (§4.7); `above` = explicit approval only. */
export type PenaltyWaiverBand = "T1" | "T2" | "above";

export type PenaltyWaiverAuthorization = {
  band: PenaltyWaiverBand;
  /** Amount waived as a percentage of the stay (2 decimals; 100 when the stay has no amount). */
  pct: number;
  tier: ThresholdTier;
  /** null in band T1 (key + reason); the engine outcome otherwise. */
  authorization: { mode: AuthorizationOutcome["mode"]; requestId: string | null; supervisorAuthorizationId: string | null } | null;
};

export type ReservationCancellationOutcome = {
  mode: ChargeMode;
  /** The policy was applied (a penalty > 0 was posted, or there was nothing to charge). */
  applied: boolean;
  charge: ChargeBreakdown;
  line: FolioLineRecord | null;
  /** The folio the penalty landed on (or the reservation's open folio); null when the reservation has no open folio and no penalty. */
  folio: LifecycleFolioOutcome | null;
  policyWaived: boolean;
  waivedAmount: number;
  /** How the waiver was authorised (corrector L3 · DS-02); null when nothing was waived. */
  waiver: PenaltyWaiverAuthorization | null;
};

/** Additive response of POST /reservations/:id/cancel and /no-show: the reservation record plus `cancellation`. */
export type ReservationLifecycleResult = ReservationRecord & { cancellation: ReservationCancellationOutcome };

export type LifecycleInput = {
  context: UserContext;
  reservationId: string;
  reason?: string;
  /** Omitted = true. false waives the penalty (discount bands of §4.7 + reason). */
  applyPolicy?: boolean;
  /** Single-use supervisor authorisation (`pms.reservation.override` on this reservation) for a waiver in band T2. */
  supervisorAuthorizationId?: string | null;
  correlationId: string;
  /** Unit tests inject a fake rbac db / clock; the routes use the defaults. */
  rbac?: RbacDeps;
};

type AutoNoShow = { source: "night_audit"; businessDate: string };

const AUDIT_ACTION = "RESERVATION_CANCELLATION_POLICY";

/** Statuses a reservation can be cancelled / marked no-show from (everything else is a 409 RESERVATION_NOT_ACTIVE). */
export const LIFECYCLE_ACTIVE_STATUSES: readonly string[] = Object.freeze(["draft", "confirmed"]);

/** 409 for a reservation that is not live (already cancelled / no_show, or in house). Pure. */
export function reservationNotActiveError(reservation: { code: string; status: string }, mode: ChargeMode): ConflictError {
  const verb = mode === "no_show" ? "marcar como no-show" : "cancelar";
  const detail =
    reservation.status === "cancelled" || reservation.status === "no_show"
      ? "la penalización ya se aplicó o se renunció al cerrarla; una segunda llamada no vuelve a cargarla"
      : "solo una reserva pendiente o confirmada admite esta transición";
  return new ConflictError(`La reserva ${reservation.code} está ${reservation.status}: no se puede ${verb} (${detail}).`, {
    code: "RESERVATION_NOT_ACTIVE",
    status: reservation.status
  });
}

/**
 * Pure band of a penalty waiver: T1 needs BOTH the amount within the
 * organisation's `discount` T1 limit and the percentage of the stay within
 * `discountPctT1`; T2 up to `discountPctT2` of the stay; above = explicit
 * approval only (mirrors the reservation discount gate, which measures the
 * percentage, plus the amount tiers the approvals engine applies).
 */
export function penaltyWaiverBand(input: { waivedAmount: number; stayTotal: number; thresholds: Pick<OrganizationThresholds, "perAction" | "discountPctT1" | "discountPctT2"> }): { band: PenaltyWaiverBand; pct: number } {
  const waived = round2(Math.max(0, input.waivedAmount));
  const stay = round2(Math.max(0, input.stayTotal));
  const pct = stay > 0 ? round2(Math.min(100, (waived / stay) * 100)) : 100;
  const amountT1 = input.thresholds.perAction.discount.T1;
  if (waived <= amountT1 && pct <= input.thresholds.discountPctT1) return { band: "T1", pct };
  return { band: pct <= input.thresholds.discountPctT2 ? "T2" : "above", pct };
}

/**
 * Waiver gate (corrector L3 · DS-02), separated for the unit tests. Fail-secure:
 * without `pms.reservation.discount` (or the override key) any waiver is a 403;
 * band T1 executes with the key and the reason; above it the `discount`
 * approval of the engine decides (request of another person, own override
 * within tier, supervisor PIN in band T2, privileged session) — every path
 * audited by the engine; 409 APPROVAL_REQUIRED otherwise.
 */
export async function assertPenaltyWaiverAuthorized(
  input: { context: UserContext; propertyId: string; reservationId: string; waivedAmount: number; stayTotal: number; supervisorAuthorizationId?: string | null },
  deps: RbacDeps = defaultRbacDeps
): Promise<PenaltyWaiverAuthorization> {
  const held = new Set(input.context.permissions);
  if (!held.has("pms.reservation.discount") && !held.has("pms.reservation.override")) {
    requirePermissions(input.context, ["pms.reservation.discount"]);
  }
  const thresholds = await getThresholds(input.context.organizationId, deps);
  const { band, pct } = penaltyWaiverBand({ waivedAmount: input.waivedAmount, stayTotal: input.stayTotal, thresholds });
  if (band === "T1") return { band, pct, tier: "T1", authorization: null };
  const outcome = await assertApprovedOrAuthorized(
    {
      context: input.context,
      kind: "discount",
      entityType: "reservation",
      entityId: input.reservationId,
      propertyId: input.propertyId,
      amount: round2(input.waivedAmount).toFixed(2),
      baseAuthorUserId: null,
      // Above the supervisor band the approval is explicit: no PIN (same rule as the price gate).
      supervisorAuthorizationId: band === "T2" ? (input.supervisorAuthorizationId ?? null) : null
    },
    deps
  );
  return { band, pct, tier: outcome.tier, authorization: { mode: outcome.mode, requestId: outcome.requestId ?? null, supervisorAuthorizationId: outcome.supervisorAuthorizationId ?? null } };
}

/**
 * Closes every open folio of the reservation whose balance is 0 (|saldo| <
 * 0,005, the closeFolio tolerance) AND whose charges are all documented by an
 * issued invoice; a settled folio with uninvoiced charges stays open with
 * `pendingInvoice: true` (FC-2). Reports the folio of interest: the one the
 * penalty landed on, else the primary open folio. A folio with balance stays
 * open and is returned with its `balanceDue`.
 */
async function settleFolios(input: { context: UserContext; reservationId: string; lineFolioId: string | null; correlationId: string }): Promise<LifecycleFolioOutcome | null> {
  const open = await prisma.folio.findMany({
    where: { reservationId: input.reservationId, status: "open", deletedAt: null },
    orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
    select: { id: true },
    take: 50
  });
  let reported: LifecycleFolioOutcome | null = null;
  for (const folio of open) {
    const balance = await getFolioBalance(folio.id);
    let outcome: LifecycleFolioOutcome = { id: folio.id, status: "open", balanceDue: round2(balance.balanceDue), pendingInvoice: false };
    if (Math.abs(balance.balanceDue) < 0.005) {
      const pending = await folioUninvoicedCharges(folio.id);
      if (pending.lines > 0) {
        outcome = { id: folio.id, status: "open", balanceDue: 0, pendingInvoice: true };
      } else {
        await closeFolio({ context: input.context, folioId: folio.id, correlationId: input.correlationId, requireInvoiced: true });
        outcome = { id: folio.id, status: "closed", balanceDue: 0, pendingInvoice: false };
      }
    }
    if (input.lineFolioId ? folio.id === input.lineFolioId : reported === null) reported = outcome;
  }
  return reported;
}

async function runLifecycle(input: LifecycleInput & { status: "cancelled" | "no_show"; auto?: AutoNoShow }): Promise<ReservationLifecycleResult> {
  const mode: ChargeMode = input.status === "no_show" ? "no_show" : "cancellation";
  const applyPolicy = input.applyPolicy ?? true;
  const reason = input.reason?.trim() || undefined;

  // 0) State guard (read only): only a live reservation can be cancelled / no-showed.
  //    A repeated POST (retry, double click, API client) is a 409, never a second penalty.
  const current = await prisma.reservation.findUnique({ where: { id: input.reservationId }, select: { id: true, code: true, status: true, propertyId: true, totalAmount: true } });
  if (!current) throw new NotFoundError("Reserva no encontrada.");
  if (!LIFECYCLE_ACTIVE_STATUSES.includes(current.status)) throw reservationNotActiveError(current, mode);

  // 1) Preview (read only).
  const charge = await computeCancellationCharge({ reservationId: input.reservationId, mode });

  // 2) Separation of duties BEFORE any write.
  let waiver: PenaltyWaiverAuthorization | null = null;
  if (charge.amount > 0) {
    if (applyPolicy) {
      requirePermissions(input.context, ["folio.charge.post"]);
    } else {
      if (!reason) {
        throw new BadRequestError(`Para renunciar a la penalización de ${charge.amount.toFixed(2)} € (${charge.policyName ?? "política"}) indica el motivo.`);
      }
      waiver = await assertPenaltyWaiverAuthorized(
        {
          context: input.context,
          propertyId: current.propertyId,
          reservationId: current.id,
          waivedAmount: charge.amount,
          stayTotal: Number(current.totalAmount?.toString() ?? "0"),
          supervisorAuthorizationId: input.supervisorAuthorizationId ?? null
        },
        input.rbac ?? defaultRbacDeps
      );
    }
  }

  // 3) Status transition (conditional on the live status, SES baja, audit RESERVATION_CANCELLED / RESERVATION_NO_SHOW, domain event).
  // Dynamic import: pms.service → night-audit.service → this module (see header).
  const { transitionReservation } = await import("../pms/pms.service.js");
  const reservation = await transitionReservation({
    context: input.context,
    reservationId: input.reservationId,
    status: input.status,
    reason: input.auto ? `${reason ?? "No-show automático del cierre del día"} (${input.auto.businessDate})` : reason,
    correlationId: input.correlationId
  });

  // 4) Penalty on the folio (idempotent per reservation and mode).
  const policyWaived = !applyPolicy && charge.amount > 0;
  const line = applyPolicy && charge.amount > 0
    ? await chargeToFolio({ context: input.context, reservationId: input.reservationId, amount: charge.amount, description: charge.label, mode, correlationId: input.correlationId })
    : null;

  // 5) Folio close at balance 0 with every charge invoiced; otherwise open (balance or pendingInvoice).
  const folio = await settleFolios({ context: input.context, reservationId: input.reservationId, lineFolioId: line?.folioId ?? null, correlationId: input.correlationId });

  const cancellation: ReservationCancellationOutcome = {
    mode,
    applied: applyPolicy,
    charge,
    line,
    folio,
    policyWaived,
    waivedAmount: policyWaived ? charge.amount : 0,
    waiver: policyWaived ? waiver : null
  };

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: input.auto ? "system" : "user",
    action: AUDIT_ACTION,
    entityType: "reservation",
    entityId: reservation.id,
    afterJson: {
      status: input.status,
      mode,
      applied: applyPolicy,
      policyWaived,
      waivedAmount: cancellation.waivedAmount,
      waiver: cancellation.waiver,
      reason: reason ?? null,
      charge,
      lineId: line?.id ?? null,
      folio,
      ...(input.auto ? { autoNoShow: true, source: input.auto.source, businessDate: input.auto.businessDate } : {})
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  return { ...reservation, cancellation };
}

/** POST /reservations/:id/cancel — cancel with the reservation's policy (or waive it). */
export async function cancelReservationWithPolicy(input: LifecycleInput): Promise<ReservationLifecycleResult> {
  return runLifecycle({ ...input, status: "cancelled" });
}

/** POST /reservations/:id/no-show — mark no-show with the reservation's policy (or waive it). */
export async function markNoShowWithPolicy(input: LifecycleInput): Promise<ReservationLifecycleResult> {
  return runLifecycle({ ...input, status: "no_show" });
}

/**
 * The night-audit runner as the actor of the no-show step. transitionReservation
 * requires pms.reservation.modify; the night_auditor template holds
 * night_audit.run and folio.charge.post but not modify. runNightAudit has
 * already required night_audit.run, so the step derives modify from it — for
 * this step only, only when missing (decision §6.19).
 */
export function nightAuditActor(context: UserContext): UserContext {
  if (hasPermission(context.permissions, "pms.reservation.modify")) return context;
  return { ...context, permissions: [...context.permissions, "pms.reservation.modify"] };
}

export type ProcessNoShowsResult = {
  processedCount: number;
  totalChargedEur: number;
  results: Array<{ reservationId: string; code: string; charge: number; basis: string; folioStatus: LifecycleFolioOutcome["status"] | null }>;
};

// --- Bulk: night-audit step ------------------------------------------------
// Finds confirmed/draft reservations whose arrival date is before the business
// date and that never checked in. Each one goes through markNoShowWithPolicy
// (status no_show, SES baja, audit, event, no-show fee, folio closed at 0).
export async function processNoShows(input: { context: UserContext; propertyId: string; businessDate: Date; correlationId: string }): Promise<ProcessNoShowsResult> {
  const candidates = await prisma.reservation.findMany({
    where: {
      propertyId: input.propertyId,
      status: { in: ["draft", "confirmed"] },
      arrivalDate: { lt: input.businessDate }
    },
    select: { id: true, code: true },
    orderBy: [{ arrivalDate: "asc" }, { code: "asc" }],
    take: 500
  });
  const actor = nightAuditActor(input.context);
  const businessDate = input.businessDate.toISOString().slice(0, 10);
  const results: ProcessNoShowsResult["results"] = [];
  for (const r of candidates) {
    const outcome = await runLifecycle({
      context: actor,
      reservationId: r.id,
      status: "no_show",
      applyPolicy: true,
      correlationId: input.correlationId,
      auto: { source: "night_audit", businessDate }
    });
    results.push({
      reservationId: r.id,
      code: r.code,
      charge: outcome.cancellation.charge.amount,
      basis: outcome.cancellation.charge.basis,
      folioStatus: outcome.cancellation.folio?.status ?? null
    });
  }
  return { processedCount: results.length, totalChargedEur: round2(results.reduce((s, r) => s + r.charge, 0)), results };
}
