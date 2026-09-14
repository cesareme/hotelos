import type { ActorType, AuditEvent, EventEnvelope } from "@hotelos/shared";
import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore } from "../../lib/demo-store.js";
import { queueAccountingProjection } from "../accounting/projection.js";
import { queueExtraProjections } from "../accounting/posting-rules/index.js";
import { queueVerifactuSubmission } from "../invoicing/verifactu-submission.service.js";
import { queueNotificationsForEvent } from "../notifications/event-hooks.service.js";

// Audit trail + domain event stream, each a SHA-256 hash chain: every record
// hashes its own contents plus the previousHash of the record sealed before it.
//
// Known limitation (CLAUDE.md §Deuda 12(c), NOT solved here): the chain tip
// lives in memory, per process. `hydrateAuditChainFromPostgres` reads the
// latest hash once at boot and seeds the ring with a sentinel (see
// CHAIN_TIP_MARKER); from then on each instance chains against its own tail.
// Two processes writing to the same database (:3000 and :3400 on the demo Mac)
// therefore fork the chain — production runs a single writer, and sealing
// inside the business transaction is future work.
const HASH_ALGORITHM = "sha256" as const;

/**
 * `action` / `eventType` of the sentinel that anchors the in-memory ring to the
 * Postgres tip. Its contents are fabricated (empty org, boot timestamp), so it is
 * never hashed: integrity checks use its currentHash as the expected previousHash
 * of the first real record and exclude it from the count.
 */
export const CHAIN_TIP_MARKER = "__CHAIN_TIP__";

export function auditChainTipSentinel(id: string, currentHash: string): AuditEvent {
  return {
    id,
    organizationId: "",
    actorType: "system",
    action: CHAIN_TIP_MARKER,
    entityType: "chain_tip",
    hashAlgorithm: HASH_ALGORITHM,
    currentHash,
    createdAt: new Date().toISOString()
  } as AuditEvent;
}

export function eventChainTipSentinel(eventId: string, currentHash: string): EventEnvelope {
  return {
    eventId,
    organizationId: "",
    propertyId: "",
    entityType: "chain_tip",
    entityId: "",
    eventType: CHAIN_TIP_MARKER,
    payload: {},
    actorType: "system",
    correlationId: "",
    hashAlgorithm: HASH_ALGORITHM,
    currentHash,
    createdAt: new Date().toISOString()
  } as EventEnvelope;
}

function isChainTip(record: { action?: string; eventType?: string }): boolean {
  return record.action === CHAIN_TIP_MARKER || record.eventType === CHAIN_TIP_MARKER;
}

// Serialized Prisma write queue. Audit events are sealed synchronously into
// demoStore (preserving the in-memory chain); Postgres mirroring happens via
// this queue so concurrent recordAuditEvent calls produce a deterministic
// insert order. Failures are logged but do not block the caller. Atomicity
// (audit + business write in one tx) is a Week 4 hardening task.
let auditWriteChain: Promise<void> = Promise.resolve();
let domainWriteChain: Promise<void> = Promise.resolve();

function queueAuditPersist(event: AuditEvent): void {
  auditWriteChain = auditWriteChain.then(async () => {
    try {
      await prisma.auditEvent.create({
        data: {
          id: event.id,
          organizationId: event.organizationId,
          propertyId: event.propertyId ?? null,
          actorUserId: event.actorUserId ?? null,
          actorType: event.actorType,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId ?? null,
          beforeJson: event.beforeJson === undefined ? undefined : (event.beforeJson as object),
          afterJson: event.afterJson === undefined ? undefined : (event.afterJson as object),
          ipAddress: event.ipAddress ?? null,
          deviceId: event.deviceId ?? null,
          correlationId: event.correlationId ?? null,
          hashAlgorithm: event.hashAlgorithm,
          previousHash: event.previousHash ?? null,
          currentHash: event.currentHash,
          createdAt: new Date(event.createdAt)
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[audit] failed to persist event ${event.id} (${event.action}): ${message}`);
    }
  });
}

function queueDomainEventPersist(event: EventEnvelope): void {
  domainWriteChain = domainWriteChain.then(async () => {
    try {
      await prisma.eventStream.create({
        data: {
          eventId: event.eventId,
          organizationId: event.organizationId,
          propertyId: event.propertyId,
          eventType: event.eventType,
          entityType: event.entityType,
          entityId: event.entityId,
          payload: (event.payload ?? {}) as object,
          actorUserId: event.actorUserId ?? null,
          actorType: event.actorType,
          correlationId: event.correlationId,
          hashAlgorithm: event.hashAlgorithm,
          previousHash: event.previousHash ?? null,
          currentHash: event.currentHash,
          createdAt: new Date(event.createdAt)
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[event] failed to persist ${event.eventId} (${event.eventType}): ${message}`);
    }
  });
}

export async function flushAuditQueues(): Promise<void> {
  await auditWriteChain;
  await domainWriteChain;
}

// Reads the most recent hash chain tip from Postgres and seeds demoStore with
// a sentinel record so the next `sealAuditEvent`/`sealDomainEvent` call picks
// up the correct previousHash. Should be called once at server startup.
export async function hydrateAuditChainFromPostgres(): Promise<{
  auditTail: string | undefined;
  eventTail: string | undefined;
}> {
  const [latestAudit, latestEvent] = await Promise.all([
    prisma.auditEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { currentHash: true, id: true } }),
    prisma.eventStream.findFirst({ orderBy: { createdAt: "desc" }, select: { currentHash: true, eventId: true } })
  ]);

  if (latestAudit && demoStore.auditEvents.length === 0) {
    demoStore.auditEvents.push(auditChainTipSentinel(latestAudit.id, latestAudit.currentHash));
  }

  if (latestEvent && demoStore.events.length === 0) {
    demoStore.events.push(eventChainTipSentinel(latestEvent.eventId, latestEvent.currentHash));
  }

  return {
    auditTail: latestAudit?.currentHash,
    eventTail: latestEvent?.currentHash
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function createIntegrityHash(value: unknown): string {
  return createHash(HASH_ALGORITHM).update(stableStringify(value)).digest("hex");
}

export function sealAuditEvent(event: Omit<AuditEvent, "hashAlgorithm" | "previousHash" | "currentHash">): AuditEvent {
  const previousHash = demoStore.auditEvents.at(-1)?.currentHash;
  const hashable = {
    ...event,
    hashAlgorithm: HASH_ALGORITHM,
    previousHash
  };

  return {
    ...hashable,
    currentHash: createIntegrityHash(hashable)
  };
}

export function sealDomainEvent(event: Omit<EventEnvelope, "hashAlgorithm" | "previousHash" | "currentHash">): EventEnvelope {
  const previousHash = demoStore.events.at(-1)?.currentHash;
  const hashable = {
    ...event,
    hashAlgorithm: HASH_ALGORITHM,
    previousHash
  };

  return {
    ...hashable,
    currentHash: createIntegrityHash(hashable)
  };
}

export type ChainVerification =
  | { valid: true; count: number; anchoredTo?: string }
  | { valid: false; count: number; anchoredTo?: string; brokenAt: string; reason: string };

// Walks the in-memory ring. A hydration sentinel at the head is the starting
// point, not a record: its fabricated contents are never re-hashed, its
// currentHash is the previousHash the first real record must carry, and it is
// left out of `count`. A sentinel anywhere else is verified like any record
// and fails honestly (its contents never hash to its currentHash).
function verifyChain<T extends { id?: string; eventId?: string; action?: string; eventType?: string; previousHash?: string; currentHash: string; hashAlgorithm: "sha256" }>(
  records: T[]
): ChainVerification {
  const head = records[0];
  const anchoredTo = head && isChainTip(head) ? head.currentHash : undefined;
  const chain = anchoredTo ? records.slice(1) : records;
  let previousHash: string | undefined = anchoredTo;

  for (const record of chain) {
    const { currentHash, ...hashable } = record;
    if (record.previousHash !== previousHash) {
      return {
        valid: false,
        count: chain.length,
        anchoredTo,
        brokenAt: record.id ?? record.eventId ?? "unknown",
        reason: "Previous hash does not match prior record."
      };
    }

    const expectedHash = createIntegrityHash(hashable);
    if (currentHash !== expectedHash) {
      return {
        valid: false,
        count: chain.length,
        anchoredTo,
        brokenAt: record.id ?? record.eventId ?? "unknown",
        reason: "Current hash does not match record contents."
      };
    }

    previousHash = currentHash;
  }

  return { valid: true, count: chain.length, anchoredTo };
}

export function recordAuditEvent(input: {
  organizationId: string;
  propertyId?: string;
  actorUserId?: string;
  actorType: ActorType;
  action: string;
  entityType: string;
  entityId?: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  ipAddress?: string;
  deviceId?: string;
  correlationId?: string;
}): AuditEvent {
  const event = sealAuditEvent({
    id: createId("aud"),
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.actorUserId,
    actorType: input.actorType,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson: input.beforeJson,
    afterJson: input.afterJson,
    ipAddress: input.ipAddress,
    deviceId: input.deviceId,
    correlationId: input.correlationId,
    createdAt: nowIso()
  });

  demoStore.auditEvents.push(event);
  queueAuditPersist(event);
  return event;
}

export function recordDomainEvent(input: Omit<EventEnvelope, "eventId" | "createdAt" | "hashAlgorithm" | "previousHash" | "currentHash">): EventEnvelope {
  const event = sealDomainEvent({
    ...input,
    eventId: createId("evt"),
    createdAt: nowIso()
  });

  demoStore.events.push(event);
  queueDomainEventPersist(event);
  queueAccountingProjection(event);
  queueExtraProjections(event);
  queueVerifactuSubmission(event);
  queueNotificationsForEvent(event);
  return event;
}

export function verifyAuditIntegrity(): ChainVerification {
  return verifyChain(demoStore.auditEvents);
}

export function verifyDomainEventIntegrity(): ChainVerification {
  return verifyChain(demoStore.events);
}
