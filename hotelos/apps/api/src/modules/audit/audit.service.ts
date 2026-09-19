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

// Persistidores inyectables (fusión T8 · E1): los tests sustituyen la escritura
// en Prisma por una función que lanza (P2002) sin tocar la base de datos.
type AuditPersistDeps = {
  auditCreate: (data: Parameters<typeof prisma.auditEvent.create>[0]["data"]) => Promise<unknown>;
  eventCreate: (data: Parameters<typeof prisma.eventStream.create>[0]["data"]) => Promise<unknown>;
};

const defaultPersistDeps: AuditPersistDeps = {
  auditCreate: (data) => prisma.auditEvent.create({ data }),
  eventCreate: (data) => prisma.eventStream.create({ data })
};

let persistDeps: AuditPersistDeps = defaultPersistDeps;

/** Sustituye (total o parcialmente) los persistidores; `null` restaura los de Prisma. */
export function setAuditPersistDepsForTests(deps: Partial<AuditPersistDeps> | null): void {
  persistDeps = deps ? { ...defaultPersistDeps, ...deps } : defaultPersistDeps;
}

// Contador de fallos de persistencia desde el arranque (E1). El 2026-09-19 la
// carga OPERA perdió 4 eventos por colisión de id (P2002) y solo quedó un
// console.error suelto: ahora cada fallo suma aquí, deja un log JSON con
// eventId/action/code y /health lo expone en `checks.audit` (ok=false si
// failures > 0). Nunca se relanza: la cadena de escritura debe seguir.
type AuditPersistError = { eventId: string; action: string; code: string; at: string };
let auditPersistFailures = 0;
let lastAuditPersistError: AuditPersistError | null = null;

export function getAuditPersistStats(): { failures: number; lastError: AuditPersistError | null } {
  return { failures: auditPersistFailures, lastError: lastAuditPersistError };
}

export function resetAuditPersistStatsForTests(): void {
  auditPersistFailures = 0;
  lastAuditPersistError = null;
}

/** Logger a nivel error con la forma de pino (`app.log`): `error(obj, msg)`. */
export type AuditPersistLogger = { error(obj: Record<string, unknown>, msg: string): void };
let auditLogger: AuditPersistLogger | null = null;

/**
 * Inyecta el logger del API (server.ts pasa `app.log` al construir Fastify) para
 * que el fallo de persistencia salga por pino (nivel, transport, Sentry). Sin
 * logger (CLI de scripts/, tests unitarios) se escribe la misma línea JSON por
 * console.error. `null` retira el logger.
 */
export function setAuditLogger(log: AuditPersistLogger | null): void {
  auditLogger = log;
}

function registerPersistFailure(stream: "audit" | "event", eventId: string, action: string, error: unknown): void {
  // P2002 = violación de único (mismo criterio que describePrismaError en lib/http-error.ts).
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  auditPersistFailures += 1;
  lastAuditPersistError = { eventId, action, code, at: nowIso() };
  const msg =
    code === "P2002"
      ? `[${stream}] persistencia fallida: id duplicado (P2002); evento perdido y cadena hash rota`
      : `[${stream}] persistencia fallida`;
  if (auditLogger) {
    auditLogger.error({ eventId, action, code, error: message }, msg);
    return;
  }
  console.error(JSON.stringify({ level: "error", msg, eventId, action, code, error: message }));
}

function queueAuditPersist(event: AuditEvent): void {
  auditWriteChain = auditWriteChain.then(async () => {
    try {
      await persistDeps.auditCreate({
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
      });
    } catch (error) {
      registerPersistFailure("audit", event.id, event.action, error);
    }
  });
}

function queueDomainEventPersist(event: EventEnvelope): void {
  domainWriteChain = domainWriteChain.then(async () => {
    try {
      await persistDeps.eventCreate({
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
      });
    } catch (error) {
      registerPersistFailure("event", event.eventId, event.eventType, error);
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
