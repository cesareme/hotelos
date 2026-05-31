import type { ActorType, AuditEvent, EventEnvelope } from "@hotelos/shared";
import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore } from "../../lib/demo-store.js";
import { queueAccountingProjection } from "../accounting/projection.js";
import { queueExtraProjections } from "../accounting/posting-rules/index.js";
import { queueVerifactuSubmission } from "../invoicing/verifactu-submission.service.js";
import { queueNotificationsForEvent } from "../notifications/event-hooks.service.js";

const HASH_ALGORITHM = "sha256" as const;

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
    demoStore.auditEvents.push({
      id: latestAudit.id,
      organizationId: "",
      actorType: "system",
      action: "__CHAIN_TIP__",
      entityType: "chain_tip",
      hashAlgorithm: HASH_ALGORITHM,
      currentHash: latestAudit.currentHash,
      createdAt: new Date().toISOString()
    } as AuditEvent);
  }

  if (latestEvent && demoStore.events.length === 0) {
    demoStore.events.push({
      eventId: latestEvent.eventId,
      organizationId: "",
      propertyId: "",
      entityType: "chain_tip",
      entityId: "",
      eventType: "__CHAIN_TIP__",
      payload: {},
      actorType: "system",
      correlationId: "",
      hashAlgorithm: HASH_ALGORITHM,
      currentHash: latestEvent.currentHash,
      createdAt: new Date().toISOString()
    } as EventEnvelope);
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

function sealAuditEvent(event: Omit<AuditEvent, "hashAlgorithm" | "previousHash" | "currentHash">): AuditEvent {
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

function sealDomainEvent(event: Omit<EventEnvelope, "hashAlgorithm" | "previousHash" | "currentHash">): EventEnvelope {
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

function verifyChain<T extends { id?: string; eventId?: string; previousHash?: string; currentHash: string; hashAlgorithm: "sha256" }>(
  records: T[]
): { valid: true; count: number } | { valid: false; count: number; brokenAt: string; reason: string } {
  let previousHash: string | undefined;

  for (const record of records) {
    const { currentHash, ...hashable } = record;
    if (record.previousHash !== previousHash) {
      return {
        valid: false,
        count: records.length,
        brokenAt: record.id ?? record.eventId ?? "unknown",
        reason: "Previous hash does not match prior record."
      };
    }

    const expectedHash = createIntegrityHash(hashable);
    if (currentHash !== expectedHash) {
      return {
        valid: false,
        count: records.length,
        brokenAt: record.id ?? record.eventId ?? "unknown",
        reason: "Current hash does not match record contents."
      };
    }

    previousHash = currentHash;
  }

  return { valid: true, count: records.length };
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

export function verifyAuditIntegrity() {
  return verifyChain(demoStore.auditEvents);
}

export function verifyDomainEventIntegrity() {
  return verifyChain(demoStore.events);
}
