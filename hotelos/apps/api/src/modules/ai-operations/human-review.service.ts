import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";

// ---- Sprint 50 — AI Human Review Queue (Human-in-the-loop) ----
//
// The human-review queue is where high-risk or low-confidence AI actions land
// before a human approves/rejects them. Other modules call `enqueueReview` to
// push an item; reviewers triage via the queue and decide. Decisions emit
// domain events so the originating flow can resume (approved) or abort
// (rejected), and so the notification engine can alert reviewers.
//
// Sharp edge: the AiHumanReviewItem schema is intentionally minimal — there is
// NO updatedAt, NO assignedAt, NO decidedAt/decidedBy column, and NO escalation
// columns. We therefore stash all decision/lifecycle metadata inside
// `payloadJson` under a reserved `_review` envelope. The Prisma row stores the
// authoritative `status` + `assignedTo`; everything else (decidedBy, decidedAt,
// notes, reason, escalation target, history) lives in payloadJson._review so we
// don't lose audit fidelity without touching schema.prisma.

/** SLA threshold in minutes. A pending item older than this is "breached". */
export const SLA_THRESHOLD_MINUTES = 60;

export type ReviewStatus = "pending" | "approved" | "rejected" | "escalated";

type ReviewEnvelope = {
  decidedBy?: string;
  decidedAt?: string;
  notes?: string;
  reason?: string;
  escalatedTo?: string;
  assignedAt?: string;
  history?: Array<{ action: string; userId: string; at: string; detail?: string }>;
};

export type ReviewItemRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  reviewType: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  payloadJson: Record<string, unknown>;
  status: ReviewStatus;
  assignedTo?: string;
  createdAt: string;
  ageMinutes: number;
  slaBreached: boolean;
};

type ReviewRow = NonNullable<Awaited<ReturnType<typeof prisma.aiHumanReviewItem.findUnique>>>;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function envelopeOf(payload: Record<string, unknown>): ReviewEnvelope {
  return asObject(payload._review) as ReviewEnvelope;
}

function ageMinutesOf(createdAt: Date): number {
  return Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 60000));
}

function mapRow(row: ReviewRow): ReviewItemRecord {
  const payload = asObject(row.payloadJson);
  const ageMinutes = ageMinutesOf(row.createdAt);
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    reviewType: row.reviewType,
    relatedEntityType: row.relatedEntityType ?? undefined,
    relatedEntityId: row.relatedEntityId ?? undefined,
    payloadJson: payload,
    status: (row.status as ReviewStatus) ?? "pending",
    assignedTo: row.assignedTo ?? undefined,
    createdAt: row.createdAt.toISOString(),
    // Only pending items can breach SLA — once decided, the clock stops.
    ageMinutes,
    slaBreached: row.status === "pending" && ageMinutes > SLA_THRESHOLD_MINUTES
  };
}

function appendHistory(
  envelope: ReviewEnvelope,
  entry: { action: string; userId: string; detail?: string }
): ReviewEnvelope {
  const history = Array.isArray(envelope.history) ? [...envelope.history] : [];
  history.push({ ...entry, at: new Date().toISOString() });
  return { ...envelope, history };
}

async function loadRowOrThrow(id: string): Promise<ReviewRow> {
  const row = await prisma.aiHumanReviewItem.findUnique({ where: { id } });
  if (!row) throw new Error("Review item was not found.");
  return row;
}

// ---------------------------------------------------------------------------
// Enqueue — called by other modules to push a review item into the queue.
// ---------------------------------------------------------------------------
export async function enqueueReview(input: {
  organizationId: string;
  propertyId?: string;
  reviewType: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  payloadJson?: Record<string, unknown>;
  correlationId?: string;
  actorUserId?: string;
}): Promise<ReviewItemRecord> {
  if (!input.organizationId) throw new Error("organizationId is required.");
  if (!input.reviewType) throw new Error("reviewType is required.");

  const created = await prisma.aiHumanReviewItem.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      reviewType: input.reviewType,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      payloadJson: (input.payloadJson ?? {}) as object,
      status: "pending"
    }
  });

  const record = mapRow(created);
  const correlationId = input.correlationId ?? `corr_review_${record.id}`;

  recordAuditEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.actorUserId,
    actorType: input.actorUserId ? "user" : "system",
    action: "AI_HUMAN_REVIEW_ENQUEUED",
    entityType: "ai_human_review_item",
    entityId: record.id,
    afterJson: record,
    correlationId
  });

  // Domain event so the notification engine can alert eligible reviewers.
  recordDomainEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId ?? "",
    entityType: "ai_human_review_item",
    entityId: record.id,
    eventType: "AiHumanReviewRequested",
    payload: {
      reviewType: record.reviewType,
      relatedEntityType: record.relatedEntityType ?? null,
      relatedEntityId: record.relatedEntityId ?? null
    } as Record<string, unknown>,
    actorType: input.actorUserId ? "user" : "system",
    actorUserId: input.actorUserId,
    correlationId
  });

  return record;
}

// ---------------------------------------------------------------------------
// Queue listing — oldest first (SLA priority).
// ---------------------------------------------------------------------------
export async function listReviewQueue(input: {
  organizationId: string;
  status?: ReviewStatus;
  reviewType?: string;
  assignedTo?: string;
}): Promise<ReviewItemRecord[]> {
  if (!input.organizationId) throw new Error("organizationId is required.");
  const rows = await prisma.aiHumanReviewItem.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.reviewType ? { reviewType: input.reviewType } : {}),
      ...(input.assignedTo ? { assignedTo: input.assignedTo } : {})
    },
    orderBy: { createdAt: "asc" }
  });
  return rows.map(mapRow);
}

export async function getReviewItem(id: string): Promise<ReviewItemRecord> {
  const row = await loadRowOrThrow(id);
  return mapRow(row);
}

// ---------------------------------------------------------------------------
// Assign.
// ---------------------------------------------------------------------------
export async function assignReview(input: {
  context: UserContext;
  id: string;
  userId: string;
  correlationId?: string;
}): Promise<ReviewItemRecord> {
  if (!input.userId) throw new Error("userId is required.");
  const row = await loadRowOrThrow(input.id);
  const payload = asObject(row.payloadJson);
  const envelope = appendHistory(envelopeOf(payload), {
    action: "assigned",
    userId: input.context.userId,
    detail: input.userId
  });
  envelope.assignedAt = new Date().toISOString();

  const updated = await prisma.aiHumanReviewItem.update({
    where: { id: row.id },
    data: {
      assignedTo: input.userId,
      payloadJson: { ...payload, _review: envelope } as object
    }
  });

  const record = mapRow(updated);
  recordAuditEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "AI_HUMAN_REVIEW_ASSIGNED",
    entityType: "ai_human_review_item",
    entityId: record.id,
    afterJson: { assignedTo: input.userId },
    correlationId: input.correlationId ?? `corr_review_${record.id}`
  });
  return record;
}

// ---------------------------------------------------------------------------
// Approve — decision metadata appended to payloadJson; emits approved event.
// ---------------------------------------------------------------------------
export async function approveReview(input: {
  context: UserContext;
  id: string;
  userId?: string;
  notes?: string;
  correlationId?: string;
}): Promise<ReviewItemRecord> {
  const row = await loadRowOrThrow(input.id);
  if (row.status !== "pending" && row.status !== "escalated") {
    throw new Error(`Cannot approve a review item with status "${row.status}".`);
  }
  const decidedBy = input.userId ?? input.context.userId;
  const decidedAt = new Date().toISOString();
  const payload = asObject(row.payloadJson);
  const envelope = appendHistory(envelopeOf(payload), {
    action: "approved",
    userId: decidedBy,
    detail: input.notes
  });
  envelope.decidedBy = decidedBy;
  envelope.decidedAt = decidedAt;
  if (input.notes !== undefined) envelope.notes = input.notes;

  const updated = await prisma.aiHumanReviewItem.update({
    where: { id: row.id },
    data: { status: "approved", payloadJson: { ...payload, _review: envelope } as object }
  });
  const record = mapRow(updated);
  const correlationId = input.correlationId ?? `corr_review_${record.id}`;

  recordAuditEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId,
    actorUserId: decidedBy,
    actorType: "user",
    action: "AI_HUMAN_REVIEW_APPROVED",
    entityType: "ai_human_review_item",
    entityId: record.id,
    afterJson: { status: "approved", decidedBy, notes: input.notes ?? null },
    correlationId
  });

  // Approved event carries the related entity so the originating flow proceeds.
  recordDomainEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId ?? "",
    entityType: "ai_human_review_item",
    entityId: record.id,
    eventType: "AiHumanReviewApproved",
    payload: {
      reviewType: record.reviewType,
      relatedEntityType: record.relatedEntityType ?? null,
      relatedEntityId: record.relatedEntityId ?? null,
      decidedBy,
      decidedAt,
      notes: input.notes ?? null
    } as Record<string, unknown>,
    actorType: "user",
    actorUserId: decidedBy,
    correlationId
  });
  return record;
}

// ---------------------------------------------------------------------------
// Reject — requires a reason; emits rejected event.
// ---------------------------------------------------------------------------
export async function rejectReview(input: {
  context: UserContext;
  id: string;
  userId?: string;
  reason: string;
  correlationId?: string;
}): Promise<ReviewItemRecord> {
  if (!input.reason || !input.reason.trim()) throw new Error("A rejection reason is required.");
  const row = await loadRowOrThrow(input.id);
  if (row.status !== "pending" && row.status !== "escalated") {
    throw new Error(`Cannot reject a review item with status "${row.status}".`);
  }
  const decidedBy = input.userId ?? input.context.userId;
  const decidedAt = new Date().toISOString();
  const payload = asObject(row.payloadJson);
  const envelope = appendHistory(envelopeOf(payload), {
    action: "rejected",
    userId: decidedBy,
    detail: input.reason
  });
  envelope.decidedBy = decidedBy;
  envelope.decidedAt = decidedAt;
  envelope.reason = input.reason;

  const updated = await prisma.aiHumanReviewItem.update({
    where: { id: row.id },
    data: { status: "rejected", payloadJson: { ...payload, _review: envelope } as object }
  });
  const record = mapRow(updated);
  const correlationId = input.correlationId ?? `corr_review_${record.id}`;

  recordAuditEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId,
    actorUserId: decidedBy,
    actorType: "user",
    action: "AI_HUMAN_REVIEW_REJECTED",
    entityType: "ai_human_review_item",
    entityId: record.id,
    afterJson: { status: "rejected", decidedBy, reason: input.reason },
    correlationId
  });

  recordDomainEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId ?? "",
    entityType: "ai_human_review_item",
    entityId: record.id,
    eventType: "AiHumanReviewRejected",
    payload: {
      reviewType: record.reviewType,
      relatedEntityType: record.relatedEntityType ?? null,
      relatedEntityId: record.relatedEntityId ?? null,
      decidedBy,
      decidedAt,
      reason: input.reason
    } as Record<string, unknown>,
    actorType: "user",
    actorUserId: decidedBy,
    correlationId
  });
  return record;
}

// ---------------------------------------------------------------------------
// Escalate — bumps to a higher tier; status=escalated.
// ---------------------------------------------------------------------------
export async function escalateReview(input: {
  context: UserContext;
  id: string;
  userId?: string;
  toRole?: string;
  correlationId?: string;
}): Promise<ReviewItemRecord> {
  const row = await loadRowOrThrow(input.id);
  if (row.status !== "pending" && row.status !== "escalated") {
    throw new Error(`Cannot escalate a review item with status "${row.status}".`);
  }
  const actor = input.userId ?? input.context.userId;
  const payload = asObject(row.payloadJson);
  const envelope = appendHistory(envelopeOf(payload), {
    action: "escalated",
    userId: actor,
    detail: input.toRole
  });
  if (input.toRole) envelope.escalatedTo = input.toRole;

  const updated = await prisma.aiHumanReviewItem.update({
    where: { id: row.id },
    data: { status: "escalated", payloadJson: { ...payload, _review: envelope } as object }
  });
  const record = mapRow(updated);
  const correlationId = input.correlationId ?? `corr_review_${record.id}`;

  recordAuditEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId,
    actorUserId: actor,
    actorType: "user",
    action: "AI_HUMAN_REVIEW_ESCALATED",
    entityType: "ai_human_review_item",
    entityId: record.id,
    afterJson: { status: "escalated", toRole: input.toRole ?? null },
    correlationId
  });

  recordDomainEvent({
    organizationId: record.organizationId,
    propertyId: record.propertyId ?? "",
    entityType: "ai_human_review_item",
    entityId: record.id,
    eventType: "AiHumanReviewEscalated",
    payload: {
      reviewType: record.reviewType,
      relatedEntityType: record.relatedEntityType ?? null,
      relatedEntityId: record.relatedEntityId ?? null,
      toRole: input.toRole ?? null
    } as Record<string, unknown>,
    actorType: "user",
    actorUserId: actor,
    correlationId
  });
  return record;
}

// ---------------------------------------------------------------------------
// Stats — KPI aggregation for the dashboard.
// ---------------------------------------------------------------------------
export type ReviewQueueStats = {
  pending: number;
  approved24h: number;
  rejected24h: number;
  escalated: number;
  slaBreached: number;
  avgResolutionMinutes: number;
  byReviewType: Array<{ reviewType: string; pending: number }>;
};

export async function reviewQueueStats(input: { organizationId: string }): Promise<ReviewQueueStats> {
  if (!input.organizationId) throw new Error("organizationId is required.");
  const rows = await prisma.aiHumanReviewItem.findMany({
    where: { organizationId: input.organizationId }
  });

  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  let pending = 0;
  let approved24h = 0;
  let rejected24h = 0;
  let escalated = 0;
  let slaBreached = 0;
  const byType = new Map<string, number>();
  const resolutionMinutes: number[] = [];

  for (const row of rows) {
    const envelope = envelopeOf(asObject(row.payloadJson));
    const decidedAtMs = envelope.decidedAt ? new Date(envelope.decidedAt).getTime() : undefined;

    if (row.status === "pending") {
      pending += 1;
      byType.set(row.reviewType, (byType.get(row.reviewType) ?? 0) + 1);
      if (ageMinutesOf(row.createdAt) > SLA_THRESHOLD_MINUTES) slaBreached += 1;
    } else if (row.status === "escalated") {
      escalated += 1;
    }

    if (row.status === "approved" && decidedAtMs !== undefined && decidedAtMs >= since24h) approved24h += 1;
    if (row.status === "rejected" && decidedAtMs !== undefined && decidedAtMs >= since24h) rejected24h += 1;

    // Resolution time for decided items (approved/rejected) with a timestamp.
    if ((row.status === "approved" || row.status === "rejected") && decidedAtMs !== undefined) {
      resolutionMinutes.push(Math.max(0, Math.round((decidedAtMs - row.createdAt.getTime()) / 60000)));
    }
  }

  const avgResolutionMinutes =
    resolutionMinutes.length === 0
      ? 0
      : Math.round(resolutionMinutes.reduce((sum, m) => sum + m, 0) / resolutionMinutes.length);

  const byReviewType = [...byType.entries()]
    .map(([reviewType, count]) => ({ reviewType, pending: count }))
    .sort((a, b) => b.pending - a.pending);

  return { pending, approved24h, rejected24h, escalated, slaBreached, avgResolutionMinutes, byReviewType };
}
