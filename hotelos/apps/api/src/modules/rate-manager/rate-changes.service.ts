// Rate Manager · Tanda 8a (RBAC · L2, design §4.6 / §4.7 «Cambio de tarifa»):
// maker/checker of rate changes.
//
//   · requestRateChange — POST /properties/:propertyId/rate-changes: whoever
//     holds `revenue.manage_rates` in the property opens an approval request
//     of kind `rate_change` with the cells to change (payloadJson) and a
//     reason code of RATE_OVERRIDE_REASON_CODES. The request is keyed by a
//     deterministic entityId (`rateChangeEntityId`: sha-256 of the property
//     and the normalised cells), the SAME key the bulk-update gate computes
//     from its patches, so an approved request matches exactly the change it
//     approved and nothing else (APPROVAL_MISMATCH otherwise).
//   · registerRateChangeExecutor — registers the executor of the kind in the
//     L1 engine: when the request is approved (revenue.rates.approve, a tier
//     that reaches it), the change is applied through bulkUpdateRateGrid as
//     a SYSTEM actor (a synthetic context with the two rate keys, the
//     decider's identity for the journal's `updatedBy`) with the
//     correlationId of the request; the gate of bulkUpdateRateGrid finds the
//     approved request by entityId and consumes it (engine mode 1).
//   · assertRateChangeAuthorized — the band gate bulkUpdateRateGrid calls:
//     every price patch within ± rateBandPct of the current base price and at
//     most MAX_RATE_CHANGE_CELLS_WITHOUT_APPROVAL patches → passes (the
//     bulk-update body already carries a mandatory reason); otherwise the
//     actor needs `revenue.rates.approve` (engine implicit mode), an approved
//     request of another person, a supervisor PIN or a privileged session —
//     every path audited (RATE_CHANGE_AUTHORIZED).

import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import type { ApprovalRequestDto, RateGridCellPatch, ThresholdTier } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { assertApprovedOrAuthorized, registerApprovalExecutor, requestApproval, type AuthorizationOutcome } from "../rbac/approvals.service.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { getThresholds } from "../rbac/thresholds.service.js";
import { cellKey } from "./bulk-ops.js";
import { MAX_CELLS, bulkUpdateSchema, parseOr400 } from "./rate-grid.schemas.js";

/** Above this many patches in one bulk-update the change needs revenue.rates.approve (design §4.7 «masivo»). */
export const MAX_RATE_CHANGE_CELLS_WITHOUT_APPROVAL = 50;

/** Catálogo de motivos de cambio de tarifa fuera de banda / masivo (rate_override_reason). */
export const RATE_OVERRIDE_REASON_CODES = {
  demand_spike: "Pico de demanda",
  low_demand: "Baja demanda / estimulación",
  competitor_move: "Movimiento de la competencia",
  event: "Evento en la ciudad",
  group_block: "Bloqueo de grupo",
  error_fix: "Corrección de error de carga",
  strategy: "Cambio de estrategia comercial",
  other: "Otro motivo (indicar en el texto)"
} as const;
export type RateOverrideReasonCode = keyof typeof RATE_OVERRIDE_REASON_CODES;

/** Price-bearing subset of a patch used for the deterministic key (channel / expected / flags are irrelevant to the approval). */
type NormalisedCell = { ratePlanId: string; roomTypeId: string; date: string; price: number | null; minPrice: number | null; maxPrice: number | null; available: number | null; restrictions: string | null; occupancyPrices: string | null };

function normaliseCell(cell: RateGridCellPatch): NormalisedCell {
  return {
    ratePlanId: cell.ratePlanId,
    roomTypeId: cell.roomTypeId,
    date: cell.date,
    price: typeof cell.price === "number" ? Math.round(cell.price * 100) / 100 : null,
    minPrice: typeof cell.minPrice === "number" ? Math.round(cell.minPrice * 100) / 100 : null,
    maxPrice: typeof cell.maxPrice === "number" ? Math.round(cell.maxPrice * 100) / 100 : null,
    available: typeof cell.available === "number" ? cell.available : null,
    restrictions: cell.restrictions ? JSON.stringify(cell.restrictions, Object.keys(cell.restrictions).sort()) : null,
    occupancyPrices: cell.occupancyPrices ? JSON.stringify(cell.occupancyPrices, Object.keys(cell.occupancyPrices).sort()) : null
  };
}

/** Deterministic entity id of a rate change (property + normalised, sorted cells). Pure. */
export function rateChangeEntityId(propertyId: string, cells: ReadonlyArray<RateGridCellPatch>): string {
  const normalised = cells.map(normaliseCell).sort((a, b) => cellKey(a.ratePlanId, a.roomTypeId, a.date).localeCompare(cellKey(b.ratePlanId, b.roomTypeId, b.date)));
  const digest = createHash("sha256").update(`${propertyId}\n${JSON.stringify(normalised)}`, "utf8").digest("hex");
  return `rc_${digest.slice(0, 32)}`;
}

/** Percentage distance of `next` from `current` (null when there is no reference price). Pure. */
export function priceChangePct(current: number | null | undefined, next: number | null | undefined): number | null {
  if (typeof next !== "number" || !Number.isFinite(next)) return null;
  if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) return null;
  return Math.round((Math.abs(next - current) / current) * 10000) / 100;
}

export type RateBandEvaluation = {
  patches: number;
  priced: number;
  /** Patches whose price moves more than the band (key → pct). */
  outOfBand: Array<{ key: string; current: number; next: number; pct: number }>;
  /** Patches without a current price (new cells): counted, never out of band. */
  withoutReference: number;
  bandPct: number;
  bulk: boolean;
  needsApproval: boolean;
};

/** Pure band evaluation of a set of patches against the current base prices. */
export function evaluateRateBand(
  patches: ReadonlyArray<RateGridCellPatch>,
  currentPrices: ReadonlyMap<string, number | null>,
  limits: { bandPct: number; maxCellsWithoutApproval: number }
): RateBandEvaluation {
  const outOfBand: RateBandEvaluation["outOfBand"] = [];
  let priced = 0;
  let withoutReference = 0;
  for (const patch of patches) {
    if (typeof patch.price !== "number") continue;
    priced += 1;
    const key = cellKey(patch.ratePlanId, patch.roomTypeId, patch.date);
    const current = currentPrices.get(key) ?? null;
    const pct = priceChangePct(current, patch.price);
    if (pct === null) {
      withoutReference += 1;
      continue;
    }
    if (pct > limits.bandPct) outOfBand.push({ key, current: current as number, next: patch.price, pct });
  }
  const bulk = patches.length > limits.maxCellsWithoutApproval;
  return { patches: patches.length, priced, outOfBand, withoutReference, bandPct: limits.bandPct, bulk, needsApproval: bulk || outOfBand.length > 0 };
}

export type RateChangeGateResult = {
  evaluation: RateBandEvaluation;
  /** null when the change is within band and not bulk. */
  authorization: AuthorizationOutcome | null;
  tier: ThresholdTier;
};

/**
 * The gate bulkUpdateRateGrid calls once its patches are known (see the
 * module header). `currentPrices` = base price per cellKey as loaded by the
 * caller (null for cells without a row).
 */
export async function assertRateChangeAuthorized(
  input: {
    context: UserContext;
    propertyId: string;
    patches: ReadonlyArray<RateGridCellPatch>;
    currentPrices: ReadonlyMap<string, number | null>;
    supervisorAuthorizationId?: string | null;
    correlationId?: string;
  },
  deps: RbacDeps = defaultRbacDeps
): Promise<RateChangeGateResult> {
  const thresholds = await getThresholds(input.context.organizationId, deps);
  const evaluation = evaluateRateBand(input.patches, input.currentPrices, { bandPct: thresholds.rateBandPct, maxCellsWithoutApproval: MAX_RATE_CHANGE_CELLS_WITHOUT_APPROVAL });
  if (!evaluation.needsApproval) return { evaluation, authorization: null, tier: "T1" };
  const entityId = rateChangeEntityId(input.propertyId, input.patches);
  const authorization = await assertApprovedOrAuthorized(
    {
      context: input.context,
      kind: "rate_change",
      entityType: "rate_grid",
      entityId,
      propertyId: input.propertyId,
      amount: null,
      baseAuthorUserId: null,
      supervisorAuthorizationId: input.supervisorAuthorizationId ?? null
    },
    deps
  );
  deps.audit({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "RATE_CHANGE_AUTHORIZED",
    entityType: "rate_grid",
    entityId,
    afterJson: {
      patches: evaluation.patches,
      priced: evaluation.priced,
      bulk: evaluation.bulk,
      bandPct: evaluation.bandPct,
      outOfBand: evaluation.outOfBand.slice(0, 50),
      outOfBandCount: evaluation.outOfBand.length,
      withoutReference: evaluation.withoutReference,
      authorization: { mode: authorization.mode, tier: authorization.tier, requestId: authorization.requestId ?? null, supervisorAuthorizationId: authorization.supervisorAuthorizationId ?? null }
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return { evaluation, authorization, tier: authorization.tier };
}

// ---------------------------------------------------------------------------
// requestRateChange (maker)
// ---------------------------------------------------------------------------

export type RequestRateChangeInput = {
  context: UserContext;
  propertyId: string;
  cells: unknown;
  reasonCode: string;
  reasonText?: string;
  correlationId: string;
  rbac?: RbacDeps;
};

export async function requestRateChange(input: RequestRateChangeInput): Promise<ApprovalRequestDto> {
  if (!(input.reasonCode in RATE_OVERRIDE_REASON_CODES)) {
    throw new BadRequestError(`reasonCode no válido: usa uno de ${Object.keys(RATE_OVERRIDE_REASON_CODES).join(", ")}.`);
  }
  const reasonText = input.reasonText?.trim();
  const body = parseOr400(
    bulkUpdateSchema,
    { cells: input.cells, reason: `${RATE_OVERRIDE_REASON_CODES[input.reasonCode as RateOverrideReasonCode]}${reasonText ? ` · ${reasonText}` : ""}` },
    "rate-change"
  );
  const cells = (body.cells ?? []) as RateGridCellPatch[];
  if (cells.length === 0) throw new BadRequestError("Una solicitud de cambio de tarifa necesita al menos una celda.");
  if (cells.length > MAX_CELLS) throw new BadRequestError(`Una solicitud admite como máximo ${MAX_CELLS} celdas.`);
  return requestApproval(
    {
      context: input.context,
      kind: "rate_change",
      entityType: "rate_grid",
      entityId: rateChangeEntityId(input.propertyId, cells),
      propertyId: input.propertyId,
      amount: null,
      reasonCode: input.reasonCode,
      reasonText,
      payload: { propertyId: input.propertyId, cells, reasonCode: input.reasonCode, reasonText: reasonText ?? null, correlationId: input.correlationId, cellCount: cells.length }
    },
    input.rbac ?? defaultRbacDeps
  );
}

// ---------------------------------------------------------------------------
// Executor (checker side): apply the approved change as a system actor
// ---------------------------------------------------------------------------

type RateChangePayload = { propertyId?: unknown; cells?: unknown; reasonCode?: unknown; reasonText?: unknown; correlationId?: unknown };

/** Synthetic context of the executor: the decider's identity, only the two rate keys, never platform. */
export function systemContextForRateChange(decider: UserContext, propertyId: string, requestId: string): UserContext {
  return {
    organizationId: decider.organizationId,
    propertyId,
    userId: decider.userId,
    fullName: `${decider.fullName} (aprobación ${requestId})`,
    deviceId: decider.deviceId,
    permissions: ["revenue.manage_rates", "revenue.manage_restrictions"],
    isPlatformAdmin: false,
    orgScope: decider.orgScope,
    assignedPropertyIds: decider.assignedPropertyIds,
    assignments: decider.assignments,
    scopes: decider.scopes
  };
}

let executorRegistered = false;

/** Registers the rate_change executor once (called from registerRateGridRoutes at boot; idempotent). */
export function registerRateChangeExecutor(apply: (input: { context: UserContext; propertyId: string; cells: RateGridCellPatch[]; reason: string; clientRequestId: string; correlationId: string }) => Promise<unknown>): void {
  if (executorRegistered) return;
  executorRegistered = true;
  registerApprovalExecutor("rate_change", async (request, decider) => {
    const row = await prisma.approvalRequest.findUnique({ where: { id: request.id }, select: { payloadJson: true } });
    const payload = (row?.payloadJson ?? {}) as RateChangePayload;
    const propertyId = typeof payload.propertyId === "string" ? payload.propertyId : request.propertyId;
    const cells = Array.isArray(payload.cells) ? (payload.cells as RateGridCellPatch[]) : [];
    if (!propertyId || cells.length === 0) {
      recordAuditEvent({
        organizationId: decider.organizationId,
        propertyId: request.propertyId ?? undefined,
        actorType: "system",
        action: "RATE_CHANGE_EXECUTION_SKIPPED",
        entityType: "approval_request",
        entityId: request.id,
        afterJson: { reason: "payload sin propiedad o sin celdas", cellCount: cells.length },
        correlationId: typeof payload.correlationId === "string" ? payload.correlationId : request.id
      });
      return;
    }
    const reasonCode = typeof payload.reasonCode === "string" && payload.reasonCode in RATE_OVERRIDE_REASON_CODES ? (payload.reasonCode as RateOverrideReasonCode) : "other";
    const reasonText = typeof payload.reasonText === "string" ? payload.reasonText : "";
    const correlationId = typeof payload.correlationId === "string" ? payload.correlationId : request.id;
    await apply({
      context: systemContextForRateChange(decider, propertyId, request.id),
      propertyId,
      cells,
      reason: `Aprobación ${request.id} · ${RATE_OVERRIDE_REASON_CODES[reasonCode]}${reasonText ? ` · ${reasonText}` : ""}`.slice(0, 500),
      clientRequestId: `approval:${request.id}`,
      correlationId
    });
  });
}

/** Test hook: allows a second registration after resetApprovalExecutorsForTests(). */
export function resetRateChangeExecutorForTests(): void {
  executorRegistered = false;
}
