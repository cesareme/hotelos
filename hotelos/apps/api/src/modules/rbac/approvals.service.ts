// RBAC por departamento (Tanda 8a · L1) · motor de aprobaciones maker/checker
// (design §4.7, §5.7, §6.1).
//
// Una solicitud (approval_requests) la abre quien tiene la clave *de
// solicitud* del `kind` en la propiedad (APPROVAL_KIND_REQUEST_PERMISSION), la
// decide quien tiene la clave *de aprobación* (APPROVAL_KIND_PERMISSION) en esa
// misma propiedad y un tramo (TEMPLATE_MAX_TIER) que alcanza el importe; nadie
// decide lo que solicitó (409 APPROVAL_SELF_DECISION, además del CHECK de la
// migración); por encima de T4 hace falta una segunda aprobación de un usuario
// distinto del solicitante y del primer decisor con rango ≥ general_management
// (ownership para facturas de proveedor por encima de secondApprovalAmount).
// Caducidad a los 7 días (APPROVAL_EXPIRED, perezosa: toda lectura trata
// `expiresAt < now` como caducada). Al aprobar se invoca el ejecutor
// registrado para el `kind` (registerApprovalExecutor; L2 registra
// rate_change). Un kind con importe (APPROVAL_KIND_REQUIRES_AMOUNT) exige el
// importe en la solicitud (400): una solicitud sin importe nunca es «cualquier
// importe» ni T1 (corrector 8a · SEC-8A-01). El tramo que un decisor alcanza es
// el de su plantilla RECORTADO por los límites por rol / nivel de
// role_thresholds (approvalCapFor; FSOD-04). Un kind puede registrar una
// política de decisión (registerApprovalDecisionPolicy; el cierre del día la
// usa para exigir dirección financiera / general en la reapertura > 7 días,
// FSOD-05): el rango mínimo del decisor se comprueba al decidir y al consumir.
//
// `assertApprovedOrAuthorized` es la puerta que los servicios de L2 llaman
// antes de una mutación sensible (reembolso, anulación, factura de proveedor,
// reapertura del día…): (1) solicitud aprobada, viva, sin consumir y que casa
// → se consume; (2) aprobación implícita: el actor tiene la clave de
// aprobación en la propiedad, tramo suficiente y no es el autor base; (3)
// plataforma / break glass, auditados; (4) autorización de supervisor por PIN
// (un solo uso) con el tramo del autorizador; (5) 409 APPROVAL_REQUIRED.

import {
  APPROVAL_KIND_PERMISSION,
  APPROVAL_KIND_REQUEST_PERMISSION,
  APPROVAL_KIND_REQUIRES_AMOUNT,
  APPROVAL_KIND_THRESHOLD_ACTION,
  ROLE_LEVEL_RANK,
  type ApprovalKind,
  type ApprovalRequestDto,
  type ApprovalStatus,
  type PermissionKey,
  type ThresholdTier
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { ApprovalRequiredError, BadRequestError, ConflictError, NotFoundError, RbacForbiddenError } from "../../lib/http-error.js";
import { coversProperty, loadUserScope, maxRankOf, permissionsFor } from "../../lib/rbac-scope.js";
import { callerRankFor, defaultRbacDeps, isBreakGlassContext, permissionsInProperty, requireInProperty, scopeOfContext, type RbacDeps } from "./assignments.service.js";
import { consumeSupervisorAuthorization } from "./supervisor.service.js";
import { amountWithin, approvalCapFor, approvalCapOfScope, getThresholds, tierFor, tierWithin, type OrganizationThresholds } from "./thresholds.service.js";

export const APPROVAL_TTL_DAYS = 7;
export const APPROVAL_NOT_FOUND = "Solicitud de aprobación no encontrada.";

type ApprovalRow = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  kind: ApprovalKind;
  entityType: string;
  entityId: string;
  amount: { toString(): string } | null;
  currency: string;
  reasonCode: string;
  reasonText: string | null;
  payloadJson: unknown;
  requestedByUserId: string;
  status: ApprovalStatus;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  secondApproverUserId: string | null;
  secondDecidedAt: Date | null;
  consumedAt: Date | null;
  consumedByUserId: string | null;
  expiresAt: Date;
  createdAt: Date;
};

export type ApprovalExecutor = (request: ApprovalRequestDto, context: UserContext) => Promise<void>;
const executors = new Map<ApprovalKind, ApprovalExecutor>();

/** L2 registers the executor of a kind (e.g. rate_change applies the change once approved). */
export function registerApprovalExecutor(kind: ApprovalKind, executor: ApprovalExecutor): void {
  executors.set(kind, executor);
}

export function resetApprovalExecutorsForTests(): void {
  executors.clear();
}

/**
 * Extra rule a kind imposes on WHO may decide a request (evaluated after the
 * key and the tier): `minDeciderRank` = ROLE_LEVEL_RANK the decider needs in
 * the property of the request. L2 registers it (night audit: a reopen past
 * NIGHT_AUDIT_REOPEN_WINDOW_DAYS is decided by general management, §4.7).
 */
export type ApprovalDecisionRequirement = { minDeciderRank?: number; reason?: string };
export type ApprovalDecisionPolicy = (request: ApprovalRequestDto, context: UserContext, deps: RbacDeps) => Promise<ApprovalDecisionRequirement | null>;
const decisionPolicies = new Map<ApprovalKind, ApprovalDecisionPolicy>();

export function registerApprovalDecisionPolicy(kind: ApprovalKind, policy: ApprovalDecisionPolicy): void {
  decisionPolicies.set(kind, policy);
}

export function resetApprovalDecisionPoliciesForTests(): void {
  decisionPolicies.clear();
}

/** Spanish message of the rank a decider lacks. */
function rankMessage(minRank: number): string {
  return minRank >= ROLE_LEVEL_RANK.general_management ? "Esta solicitud la decide dirección financiera o dirección general." : "Esta solicitud exige un decisor de mayor rango.";
}

/** Money check shared by request and gate: a kind with amount never travels without it (400, never «cualquier importe»). */
function requireAmountForKind(kind: ApprovalKind, amount: number | null): void {
  if (APPROVAL_KIND_REQUIRES_AMOUNT[kind] && amount === null) {
    throw new BadRequestError(`El tipo «${kind}» exige un importe (amount): sin importe no hay tramo que aprobar.`);
  }
}

function amountOf(row: Pick<ApprovalRow, "amount">): number | null {
  if (row.amount === null || row.amount === undefined) return null;
  const parsed = Number(row.amount.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

function tierOfRow(row: Pick<ApprovalRow, "amount" | "kind">, thresholds: OrganizationThresholds): ThresholdTier {
  const amount = amountOf(row);
  // A kind that carries an amount but stores none (a row written before the
  // rule) is the top tier: nobody below general management approves it.
  if (amount === null) return APPROVAL_KIND_REQUIRES_AMOUNT[row.kind] ? "ABOVE_T4" : "T1";
  return tierFor(amount, thresholds, APPROVAL_KIND_THRESHOLD_ACTION[row.kind]);
}

function needsSecondApproval(row: Pick<ApprovalRow, "amount" | "kind">, thresholds: OrganizationThresholds): boolean {
  return tierOfRow(row, thresholds) === "ABOVE_T4";
}

/** Rank the second approver needs: ownership for supplier bills above secondApprovalAmount, general_management otherwise. */
function secondApproverRank(row: Pick<ApprovalRow, "amount" | "kind">, thresholds: OrganizationThresholds): number {
  const amount = amountOf(row) ?? 0;
  if (row.kind === "supplier_bill" && amount > thresholds.secondApprovalAmount) return ROLE_LEVEL_RANK[thresholds.secondApprovalLevel];
  return ROLE_LEVEL_RANK.general_management;
}

function isExpired(row: Pick<ApprovalRow, "status" | "expiresAt">, now: Date): boolean {
  return row.status === "expired" || row.expiresAt.getTime() < now.getTime();
}

function toDto(row: ApprovalRow, thresholds: OrganizationThresholds, now: Date): ApprovalRequestDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status === "pending" && isExpired(row, now) ? "expired" : row.status,
    entityType: row.entityType,
    entityId: row.entityId,
    propertyId: row.propertyId,
    amount: row.amount === null ? null : row.amount.toString(),
    currency: row.currency,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.createdAt.toISOString(),
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    secondApproverUserId: row.secondApproverUserId,
    expiresAt: row.expiresAt.toISOString(),
    thresholdTier: tierOfRow(row, thresholds),
    requiresSecondApproval: needsSecondApproval(row, thresholds)
  };
}

// ---------------------------------------------------------------------------
// expireApprovals (idempotent, lazy)
// ---------------------------------------------------------------------------

export async function expireApprovals(deps: RbacDeps = defaultRbacDeps, organizationId?: string): Promise<number> {
  const now = deps.now();
  const rows = (await deps.db.approvalRequest.findMany({
    where: { status: "pending", expiresAt: { lt: now }, ...(organizationId ? { organizationId } : {}) },
    select: { id: true, organizationId: true, propertyId: true, kind: true, requestedByUserId: true, expiresAt: true }
  })) as Array<Pick<ApprovalRow, "id" | "organizationId" | "propertyId" | "kind" | "requestedByUserId" | "expiresAt">>;
  if (rows.length === 0) return 0;
  const result = await deps.db.approvalRequest.updateMany({ where: { id: { in: rows.map((row) => row.id) }, status: "pending" }, data: { status: "expired" } });
  for (const row of rows) {
    deps.audit({
      organizationId: row.organizationId,
      propertyId: row.propertyId ?? undefined,
      actorType: "system",
      action: "APPROVAL_EXPIRED",
      entityType: "approval_request",
      entityId: row.id,
      afterJson: { kind: row.kind, requestedByUserId: row.requestedByUserId, expiresAt: row.expiresAt.toISOString() }
    });
  }
  return result.count;
}

// ---------------------------------------------------------------------------
// requestApproval
// ---------------------------------------------------------------------------

export type RequestApprovalInput = {
  context: UserContext;
  kind: ApprovalKind;
  entityType: string;
  entityId: string;
  propertyId: string | null;
  amount: string | number | null;
  currency?: string;
  reasonCode: string;
  reasonText?: string;
  payload?: Record<string, unknown>;
};

export async function requestApproval(input: RequestApprovalInput, deps: RbacDeps = defaultRbacDeps): Promise<ApprovalRequestDto> {
  const { context } = input;
  if (!(input.kind in APPROVAL_KIND_REQUEST_PERMISSION)) throw new BadRequestError("Tipo de aprobación desconocido.");
  await requireInProperty(context, input.propertyId, [APPROVAL_KIND_REQUEST_PERMISSION[input.kind]], deps);
  if (input.propertyId) {
    const scope = await scopeOfContext(context, deps);
    if (!coversProperty(scope, input.propertyId) && context.isPlatformAdmin !== true) throw new NotFoundError("Propiedad no encontrada.");
    const property = await deps.db.property.findFirst({ where: { id: input.propertyId, organizationId: context.organizationId }, select: { id: true } });
    if (!property) throw new NotFoundError("Propiedad no encontrada.");
  }
  const amount = input.amount === null || input.amount === undefined ? null : Number(input.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new BadRequestError("El importe debe ser ≥ 0.");
  requireAmountForKind(input.kind, amount);
  const now = deps.now();
  await expireApprovals(deps, context.organizationId);
  const thresholds = await getThresholds(context.organizationId, deps);
  // Idempotent: one live pending request per (kind, entity, requester).
  const existing = (await deps.db.approvalRequest.findFirst({
    where: { organizationId: context.organizationId, kind: input.kind, entityType: input.entityType, entityId: input.entityId, requestedByUserId: context.userId, status: "pending", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" }
  })) as ApprovalRow | null;
  if (existing) return toDto(existing, thresholds, now);
  const created = (await deps.db.approvalRequest.create({
    data: {
      organizationId: context.organizationId,
      propertyId: input.propertyId,
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      amount: amount === null ? null : amount.toFixed(2),
      currency: input.currency ?? thresholds.currency,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? null,
      payloadJson: input.payload === undefined ? undefined : (input.payload as object),
      requestedByUserId: context.userId,
      status: "pending",
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_DAYS * 24 * 60 * 60 * 1000)
    }
  })) as ApprovalRow;
  const dto = toDto(created, thresholds, now);
  deps.audit({
    organizationId: context.organizationId,
    propertyId: input.propertyId ?? undefined,
    actorUserId: context.userId,
    actorType: "user",
    action: "APPROVAL_REQUESTED",
    entityType: "approval_request",
    entityId: created.id,
    afterJson: { kind: dto.kind, entityType: dto.entityType, entityId: dto.entityId, amount: dto.amount, tier: dto.thresholdTier, requiresSecondApproval: dto.requiresSecondApproval, reasonCode: dto.reasonCode, expiresAt: dto.expiresAt },
    deviceId: context.deviceId
  });
  return dto;
}

// ---------------------------------------------------------------------------
// decideApproval
// ---------------------------------------------------------------------------

export async function decideApproval(input: { context: UserContext; id: string; decision: "approve" | "reject"; note?: string }, deps: RbacDeps = defaultRbacDeps): Promise<ApprovalRequestDto> {
  const { context } = input;
  await expireApprovals(deps, context.organizationId);
  const now = deps.now();
  const row = (await deps.db.approvalRequest.findFirst({ where: { id: input.id, organizationId: context.organizationId } })) as ApprovalRow | null;
  if (!row) throw new NotFoundError(APPROVAL_NOT_FOUND);
  const thresholds = await getThresholds(context.organizationId, deps);
  if (isExpired(row, now)) throw new ConflictError("La aprobación ha caducado.", { code: "APPROVAL_EXPIRED", expiresAt: row.expiresAt.toISOString() });
  if (row.status !== "pending") throw new ConflictError("La solicitud ya está decidida.", { code: "APPROVAL_ALREADY_DECIDED", status: row.status });
  if (row.requestedByUserId === context.userId) throw new ConflictError("Nadie aprueba lo que ha solicitado.", { code: "APPROVAL_SELF_DECISION" });
  await requireInProperty(context, row.propertyId, [APPROVAL_KIND_PERMISSION[row.kind]], deps);
  const tier = tierOfRow(row, thresholds);
  const action = APPROVAL_KIND_THRESHOLD_ACTION[row.kind];
  const cap = await approvalCapFor(context, row.propertyId, deps, { action, thresholds });
  const maxTier = cap.maxTier;
  // The SECOND approver above T4 (§4.7: DG + dirección financiera / propiedad)
  // is bound by RANK, not by its own tier (a controller tops at T4 and still
  // co-signs above it); every other decision needs a tier that reaches the
  // amount AND stays within the amount cap of its role limit (FSOD-04).
  const secondStage = input.decision === "approve" && needsSecondApproval(row, thresholds) && (row.decidedByUserId ?? null) !== null;
  if (!secondStage && !(tierWithin(tier, maxTier) && amountWithin(amountOf(row), cap.maxAmount))) {
    throw new RbacForbiddenError("El importe supera el tramo que puedes aprobar.", "RBAC_LEVEL_EXCEEDED", { tier, maxTier, ...(cap.maxAmount !== null ? { maxAmount: cap.maxAmount.toFixed(2) } : {}) });
  }
  // Kind-specific policy (registered by L2): the minimum rank of the decider in the property.
  const policy = decisionPolicies.get(row.kind);
  const requirement = policy && input.decision === "approve" ? await policy(toDto(row, thresholds, now), context, deps) : null;
  if (requirement?.minDeciderRank !== undefined) {
    const rank = await callerRankFor(context, row.propertyId ? [row.propertyId] : null, deps);
    if (rank < requirement.minDeciderRank) {
      throw new RbacForbiddenError(requirement.reason ?? rankMessage(requirement.minDeciderRank), "RBAC_LEVEL_EXCEEDED", { requiredRank: requirement.minDeciderRank, callerRank: Number.isFinite(rank) ? rank : null });
    }
  }
  let updated: ApprovalRow;
  let stage: "decided" | "first" | "second" = "decided";
  if (input.decision === "reject") {
    updated = (await deps.db.approvalRequest.update({ where: { id: row.id }, data: { status: "rejected", decidedByUserId: context.userId, decidedAt: now, decisionNote: input.note ?? null } })) as ApprovalRow;
  } else if (needsSecondApproval(row, thresholds)) {
    if ((row.decidedByUserId ?? null) === null) {
      stage = "first";
      updated = (await deps.db.approvalRequest.update({ where: { id: row.id }, data: { decidedByUserId: context.userId, decidedAt: now, decisionNote: input.note ?? null } })) as ApprovalRow;
    } else {
      stage = "second";
      if (row.decidedByUserId === context.userId) throw new ConflictError("La segunda aprobación debe darla otra persona.", { code: "APPROVAL_SELF_DECISION" });
      const required = secondApproverRank(row, thresholds);
      const rank = await callerRankFor(context, row.propertyId ? [row.propertyId] : null, deps);
      if (rank < required) throw new RbacForbiddenError("La segunda aprobación exige dirección general (o propiedad).", "RBAC_LEVEL_EXCEEDED", { requiredRank: required, callerRank: Number.isFinite(rank) ? rank : null });
      updated = (await deps.db.approvalRequest.update({ where: { id: row.id }, data: { status: "approved", secondApproverUserId: context.userId, secondDecidedAt: now } })) as ApprovalRow;
    }
  } else {
    updated = (await deps.db.approvalRequest.update({ where: { id: row.id }, data: { status: "approved", decidedByUserId: context.userId, decidedAt: now, decisionNote: input.note ?? null } })) as ApprovalRow;
  }
  const dto = toDto(updated, thresholds, now);
  deps.audit({
    organizationId: context.organizationId,
    propertyId: row.propertyId ?? undefined,
    actorUserId: context.userId,
    actorType: "user",
    action: "APPROVAL_DECIDED",
    entityType: "approval_request",
    entityId: row.id,
    beforeJson: { status: row.status, decidedByUserId: row.decidedByUserId },
    afterJson: { decision: input.decision, stage, status: dto.status, kind: dto.kind, amount: dto.amount, tier, maxTier, note: input.note ?? null, requestedByUserId: row.requestedByUserId },
    deviceId: context.deviceId
  });
  if (dto.status === "approved") {
    const executor = executors.get(dto.kind);
    if (executor) await executor(dto, context);
  }
  return dto;
}

// ---------------------------------------------------------------------------
// assertApprovedOrAuthorized (the gate L2 services call)
// ---------------------------------------------------------------------------

export type AuthorizationOutcome = {
  mode: "approved" | "implicit" | "privileged" | "supervisor";
  tier: ThresholdTier;
  requestId?: string;
  supervisorAuthorizationId?: string;
};

export type AssertApprovedInput = {
  context: UserContext;
  kind: ApprovalKind;
  entityType: string;
  entityId: string;
  propertyId: string | null;
  amount: string | number | null;
  /** Author of the base operation (cashier of the payment, issuer of the invoice…): never approves its own. */
  baseAuthorUserId?: string | null;
  supervisorAuthorizationId?: string | null;
  /** ROLE_LEVEL_RANK the decider of the consumed request (or the PIN authoriser) must hold in the property (e.g. a late day reopen: general management). */
  minDeciderRank?: number;
};

export async function assertApprovedOrAuthorized(input: AssertApprovedInput, deps: RbacDeps = defaultRbacDeps): Promise<AuthorizationOutcome> {
  const { context } = input;
  const now = deps.now();
  await expireApprovals(deps, context.organizationId);
  const thresholds = await getThresholds(context.organizationId, deps);
  const amount = input.amount === null || input.amount === undefined ? null : Number(input.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new BadRequestError("El importe debe ser ≥ 0.");
  requireAmountForKind(input.kind, amount);
  const action = APPROVAL_KIND_THRESHOLD_ACTION[input.kind];
  const tier: ThresholdTier = amount === null ? "T1" : tierFor(amount, thresholds, action);
  const approveKey: PermissionKey = APPROVAL_KIND_PERMISSION[input.kind];
  const minDeciderRank = input.minDeciderRank ?? null;
  /** Rank a user holds in the property of the operation (wide assignments for organisation-level operations). */
  const rankOfUser = async (userId: string): Promise<number> => maxRankOf(await loadUserScope(userId, context.organizationId, deps.db), input.propertyId);
  const audit = (action: string, afterJson: Record<string, unknown>) =>
    deps.audit({ organizationId: context.organizationId, propertyId: input.propertyId ?? undefined, actorUserId: context.userId, actorType: "user", action, entityType: input.entityType, entityId: input.entityId, afterJson: { kind: input.kind, amount: amount === null ? null : amount.toFixed(2), tier, ...afterJson }, deviceId: context.deviceId });

  // (1) an approved, live, unconsumed request that matches.
  const candidates = (await deps.db.approvalRequest.findMany({
    where: { organizationId: context.organizationId, kind: input.kind, entityType: input.entityType, entityId: input.entityId, status: { in: ["approved", "pending"] } },
    orderBy: { createdAt: "desc" }
  })) as ApprovalRow[];
  const approved = candidates.filter((row) => row.status === "approved" && (row.consumedAt ?? null) === null && !isExpired(row, now));
  const pending = candidates.find((row) => row.status === "pending" && !isExpired(row, now));
  for (const request of approved) {
    const requestAmount = amountOf(request);
    // The approved amount is a CEILING, never a blank cheque: an operation with
    // an amount needs a request with an amount ≥ it; an operation without one
    // (day reopen, rate change) needs a request without one.
    const amountCovered = amount === null ? requestAmount === null : requestAmount !== null && amount <= requestAmount;
    const matches =
      request.propertyId === input.propertyId &&
      amountCovered &&
      request.requestedByUserId !== context.userId &&
      !(input.kind === "refund" && request.decidedByUserId === context.userId);
    if (!matches) {
      throw new ConflictError("La aprobación no corresponde a esta operación.", { code: "APPROVAL_MISMATCH", requestId: request.id });
    }
    if (minDeciderRank !== null && request.decidedByUserId && (await rankOfUser(request.decidedByUserId)) < minDeciderRank) {
      throw new ConflictError(rankMessage(minDeciderRank), { code: "APPROVAL_MISMATCH", requestId: request.id, requiredRank: minDeciderRank });
    }
    await deps.db.approvalRequest.update({ where: { id: request.id }, data: { consumedAt: now, consumedByUserId: context.userId } });
    audit("APPROVAL_CONSUMED", { requestId: request.id, decidedByUserId: request.decidedByUserId, secondApproverUserId: request.secondApproverUserId });
    return { mode: "approved", tier, requestId: request.id };
  }

  // (2) implicit approval: the actor holds the approve key in the property with enough tier (and amount cap) and is not the base author.
  if (tier !== "ABOVE_T4") {
    const held = await permissionsInProperty(context, input.propertyId, deps);
    const cap = await approvalCapFor(context, input.propertyId, deps, { action, thresholds });
    const rankOk = minDeciderRank === null || (await callerRankFor(context, input.propertyId ? [input.propertyId] : null, deps)) >= minDeciderRank;
    if (held.includes(approveKey) && tierWithin(tier, cap.maxTier) && amountWithin(amount, cap.maxAmount) && rankOk && (input.baseAuthorUserId ?? null) !== context.userId) {
      audit("APPROVAL_DECIDED", { implicit: true, maxTier: cap.maxTier, ...(cap.maxAmount !== null ? { maxAmount: cap.maxAmount.toFixed(2) } : {}) });
      return { mode: "implicit", tier };
    }
  }

  // (3) platform admin / break glass: no threshold, always audited.
  if (context.isPlatformAdmin === true || isBreakGlassContext(context)) {
    audit("APPROVAL_DECIDED", { implicit: true, privileged: context.isPlatformAdmin === true ? "platform_admin" : "break_glass", breakGlassSessionId: context.breakGlassSessionId ?? null });
    return { mode: "privileged", tier };
  }

  // (4) supervisor PIN authorisation (single use) with the authoriser's tier.
  if (input.supervisorAuthorizationId) {
    const authorization = await consumeSupervisorAuthorization(input.supervisorAuthorizationId, { actorUserId: context.userId, permissionKey: approveKey, entityType: input.entityType, entityId: input.entityId }, deps);
    if (authorization && tier !== "ABOVE_T4") {
      const authorizerScope = await loadUserScope(authorization.authorizerUserId, context.organizationId, deps.db);
      const authorizerCap = approvalCapOfScope(authorizerScope, input.propertyId, thresholds, action);
      const authorizerTier = authorizerCap.maxTier;
      const authorizerRankOk = minDeciderRank === null || maxRankOf(authorizerScope, input.propertyId) >= minDeciderRank;
      if (tierWithin(tier, authorizerTier) && amountWithin(amount, authorizerCap.maxAmount) && authorizerRankOk && (input.baseAuthorUserId ?? null) !== authorization.authorizerUserId) {
        audit("APPROVAL_DECIDED", { implicit: true, supervisorAuthorizationId: authorization.id, authorizerUserId: authorization.authorizerUserId, authorizerTier });
        return { mode: "supervisor", tier, supervisorAuthorizationId: authorization.id };
      }
    }
  }

  // (5) nothing authorises the operation.
  throw new ApprovalRequiredError("Esta operación necesita una aprobación previa.", { kind: input.kind, tier, ...(pending ? { requestId: pending.id } : {}) });
}

// ---------------------------------------------------------------------------
// listApprovals
// ---------------------------------------------------------------------------

export async function listApprovals(input: { context: UserContext; status?: ApprovalStatus; kind?: ApprovalKind; limit?: number }, deps: RbacDeps = defaultRbacDeps): Promise<ApprovalRequestDto[]> {
  const { context } = input;
  // Reads are allowed inside a break-glass session (it operates; only permanent grants are refused).
  await expireApprovals(deps, context.organizationId);
  const now = deps.now();
  const thresholds = await getThresholds(context.organizationId, deps);
  const scope = await scopeOfContext(context, deps);
  const platformAdmin = context.isPlatformAdmin === true;
  const approveKinds = new Set<ApprovalKind>();
  for (const [kind, key] of Object.entries(APPROVAL_KIND_PERMISSION) as Array<[ApprovalKind, PermissionKey]>) {
    if (platformAdmin || isBreakGlassContext(context) || scope.allPermissions.includes(key)) approveKinds.add(kind);
  }
  const rows = (await deps.db.approvalRequest.findMany({
    where: { organizationId: context.organizationId, ...(input.status ? { status: input.status } : {}), ...(input.kind ? { kind: input.kind } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(500, Math.max(1, input.limit ?? 200))
  })) as ApprovalRow[];
  const privileged = platformAdmin || isBreakGlassContext(context);
  /** The approve key must be held IN THE PROPERTY of the request (a supervisor of A never lists the refunds of B where it is only reception; FSOD-11). */
  const decidesInProperty = (row: ApprovalRow): boolean => {
    if (!approveKinds.has(row.kind)) return false;
    if (privileged) return true;
    return permissionsFor(scope, row.propertyId).includes(APPROVAL_KIND_PERMISSION[row.kind]);
  };
  const visible = rows.filter((row) => {
    const inScope = row.propertyId === null ? platformAdmin || scope.orgScope : platformAdmin || coversProperty(scope, row.propertyId);
    if (!inScope) return false;
    return row.requestedByUserId === context.userId || decidesInProperty(row);
  });
  // Display names of the people and hotels involved (the drawer of the inbox shows names, never cuids).
  const userIds = [...new Set(visible.flatMap((row) => [row.requestedByUserId, row.decidedByUserId, row.secondApproverUserId].filter((id): id is string => typeof id === "string")))];
  const propertyIds = [...new Set(visible.map((row) => row.propertyId).filter((id): id is string => typeof id === "string"))];
  const users = userIds.length === 0 ? [] : await deps.db.user.findMany({ where: { id: { in: userIds }, organizationId: context.organizationId }, select: { id: true, fullName: true } });
  const properties = propertyIds.length === 0 ? [] : await deps.db.property.findMany({ where: { id: { in: propertyIds }, organizationId: context.organizationId }, select: { id: true, name: true } });
  const userName = new Map(users.map((user) => [user.id, user.fullName]));
  const propertyName = new Map(properties.map((property) => [property.id, property.name]));
  const nameOf = (id: string | null): string | null => (id ? (userName.get(id) ?? null) : null);
  return visible.map((row) => ({
    ...toDto(row, thresholds, now),
    requestedByName: nameOf(row.requestedByUserId),
    decidedByName: nameOf(row.decidedByUserId),
    secondApproverName: nameOf(row.secondApproverUserId),
    propertyName: row.propertyId ? (propertyName.get(row.propertyId) ?? null) : null
  }));
}
