// Integrations — connection state and sync events persisted in Prisma
// (IntegrationConnection + IntegrationEvent) so they survive restarts.
//
// Persistence notes (persistencia tanda 2, patrón assets.service.ts):
//  - The provider/category CATALOG stays static in memory (it is reference
//    data, not state); connections keep pointing at the fixture provider ids.
//  - Writes are DUAL-WRITE: Prisma first (source of truth), then the demo
//    store mirror with the SAME id, because legacy readers (server.ts inline
//    PATCH, dashboards) still consume demoStore.integrationConnections.
//  - Demo fixture connections/events are copied once per process into Prisma
//    (createMany + skipDuplicates, same ids) before the first read so fixture
//    connections stay updatable after a restart.
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { NotFoundError } from "../../lib/http-error.js";
import {
  demoStore,
  type IntegrationConnectionRecord,
  type IntegrationEventRecord,
  type UserContext
} from "../../lib/demo-store.js";

type IntegrationConnectionRow = NonNullable<Awaited<ReturnType<typeof prisma.integrationConnection.findUnique>>>;
type IntegrationEventRow = NonNullable<Awaited<ReturnType<typeof prisma.integrationEvent.findUnique>>>;

const asJson = (value: Record<string, unknown> | undefined): Prisma.InputJsonValue => (value ?? {}) as Prisma.InputJsonValue;

function toDbDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toConnectionRecord(row: IntegrationConnectionRow): IntegrationConnectionRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    providerId: row.providerId,
    status: row.status as IntegrationConnectionRecord["status"],
    credentialsSecretRef: row.credentialsSecretRef ?? undefined,
    configJson: (row.configJson as Record<string, unknown> | null) ?? {},
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString()
  };
}

function connectionToDbRow(record: IntegrationConnectionRecord) {
  return {
    id: record.id,
    propertyId: record.propertyId,
    providerId: record.providerId,
    status: record.status,
    credentialsSecretRef: record.credentialsSecretRef ?? null,
    configJson: asJson(record.configJson),
    lastSyncAt: toDbDate(record.lastSyncAt),
    createdAt: new Date(record.createdAt)
  };
}

function toEventRecord(row: IntegrationEventRow): IntegrationEventRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    direction: row.direction as IntegrationEventRecord["direction"],
    eventType: row.eventType,
    payloadJson: (row.payloadJson as Record<string, unknown> | null) ?? {},
    status: row.status as IntegrationEventRecord["status"],
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString()
  };
}

function eventToDbRow(record: IntegrationEventRecord) {
  return {
    id: record.id,
    connectionId: record.connectionId,
    direction: record.direction,
    eventType: record.eventType,
    payloadJson: asJson(record.payloadJson),
    status: record.status,
    errorMessage: record.errorMessage ?? null,
    createdAt: new Date(record.createdAt)
  };
}

/** Insert-or-update a mirror record in a demo-store collection (keeps object identity). */
function mirrorRecord<T extends { id: string }>(collection: T[], record: T): T {
  const existing = collection.find((candidate) => candidate.id === record.id);
  if (existing) {
    Object.assign(existing, record);
    return existing;
  }
  collection.push(record);
  return record;
}

// ---------------------------------------------------------------------------
// One-shot sync of legacy demo fixtures into Prisma (same ids, idempotent)
// ---------------------------------------------------------------------------

let fixtureSyncPromise: Promise<void> | null = null;

function ensureLegacyFixturesPersisted(): Promise<void> {
  if (!fixtureSyncPromise) {
    fixtureSyncPromise = persistLegacyFixtures().catch((error) => {
      fixtureSyncPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return fixtureSyncPromise;
}

async function persistLegacyFixtures(): Promise<void> {
  if (demoStore.integrationConnections.length > 0) {
    await prisma.integrationConnection.createMany({
      data: demoStore.integrationConnections.map(connectionToDbRow),
      skipDuplicates: true
    });
  }
  if (demoStore.integrationEvents.length > 0) {
    await prisma.integrationEvent.createMany({
      data: demoStore.integrationEvents.map(eventToDbRow),
      skipDuplicates: true
    });
  }
}

// ---------------------------------------------------------------------------
// Catalog (static, in-memory by design)
// ---------------------------------------------------------------------------

export function listIntegrationCategories() {
  return demoStore.integrationCategories;
}

export function listIntegrationProviders() {
  return demoStore.integrationProviders.map((provider) => ({
    ...provider,
    category: demoStore.integrationCategories.find((category) => category.id === provider.categoryId)
  }));
}

// ---------------------------------------------------------------------------
// Connections (persisted)
// ---------------------------------------------------------------------------

export async function listPropertyIntegrations(propertyId: string) {
  await ensureLegacyFixturesPersisted();
  const rows = await prisma.integrationConnection.findMany({ where: { propertyId }, orderBy: { createdAt: "asc" } });
  for (const row of rows) {
    mirrorRecord(demoStore.integrationConnections, toConnectionRecord(row));
  }
  return demoStore.integrationConnections
    .filter((connection) => connection.propertyId === propertyId)
    .map((connection) => ({
      ...connection,
      provider: demoStore.integrationProviders.find((provider) => provider.id === connection.providerId)
    }));
}

/** Prisma-first lookup; memory-only records are materialised so they stay updatable. */
async function findConnection(propertyId: string, connectionId: string): Promise<IntegrationConnectionRecord> {
  await ensureLegacyFixturesPersisted();
  const row = await prisma.integrationConnection.findFirst({ where: { id: connectionId, propertyId } });
  if (row) {
    return mirrorRecord(demoStore.integrationConnections, toConnectionRecord(row));
  }

  const legacy = demoStore.integrationConnections.find(
    (candidate) => candidate.propertyId === propertyId && candidate.id === connectionId
  );
  if (legacy) {
    await prisma.integrationConnection.createMany({ data: [connectionToDbRow(legacy)], skipDuplicates: true });
    return legacy;
  }

  throw new NotFoundError("Integration connection was not found.");
}

export async function connectIntegration(input: {
  context: UserContext;
  propertyId: string;
  providerCode: string;
  credentialsSecretRef?: string;
  configJson?: Record<string, unknown>;
  correlationId: string;
}): Promise<IntegrationConnectionRecord> {
  requirePermissions(input.context, ["integrations.connect"]);
  if ((input.configJson as Record<string, unknown> | undefined)?.credentials) {
    throw new Error("Integration credentials must be stored in a secret manager reference, not config_json.");
  }

  const provider = demoStore.integrationProviders.find((candidate) => candidate.code === input.providerCode);
  if (!provider) {
    throw new NotFoundError("Integration provider was not found.");
  }

  const connection: IntegrationConnectionRecord = {
    id: createId("iconn"),
    propertyId: input.propertyId,
    providerId: provider.id,
    status: "connected",
    credentialsSecretRef: input.credentialsSecretRef,
    configJson: input.configJson ?? {},
    lastSyncAt: undefined,
    createdAt: nowIso()
  };
  // Prisma first (source of truth), then the demoStore mirror (same id).
  await ensureLegacyFixturesPersisted();
  await prisma.integrationConnection.create({ data: connectionToDbRow(connection) });
  demoStore.integrationConnections.push(connection);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "IntegrationConnected",
    entityType: "integration_connection",
    entityId: connection.id,
    afterJson: { ...connection, credentialsSecretRef: connection.credentialsSecretRef ? "secret_ref_present" : undefined },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: "integration_connection",
    entityId: connection.id,
    eventType: "IntegrationConnected",
    payload: { providerCode: provider.code },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return connection;
}

export async function disconnectIntegration(input: {
  context: UserContext;
  propertyId: string;
  connectionId: string;
  correlationId: string;
}) {
  requirePermissions(input.context, ["integrations.disconnect"]);
  const connection = await findConnection(input.propertyId, input.connectionId);

  const before = { ...connection };
  // Prisma first, then the demoStore mirror.
  const row = await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: { status: "disconnected" }
  });
  Object.assign(connection, toConnectionRecord(row));

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "IntegrationDisconnected",
    entityType: "integration_connection",
    entityId: connection.id,
    beforeJson: before,
    afterJson: connection,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: "integration_connection",
    entityId: connection.id,
    eventType: "IntegrationDisconnected",
    payload: {},
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return connection;
}

export async function testIntegrationConnection(input: {
  context: UserContext;
  propertyId: string;
  connectionId: string;
  correlationId: string;
}) {
  requirePermissions(input.context, ["integrations.test"]);
  const connection = await findConnection(input.propertyId, input.connectionId);

  const event: IntegrationEventRecord = {
    id: createId("ievt"),
    connectionId: connection.id,
    direction: "outbound",
    eventType: "IntegrationSyncStarted",
    payloadJson: { test: true },
    status: "accepted",
    createdAt: nowIso()
  };
  // Prisma first (event + lastSyncAt), then the demoStore mirror.
  await prisma.integrationEvent.create({ data: eventToDbRow(event) });
  const row = await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: { lastSyncAt: new Date(event.createdAt) }
  });
  demoStore.integrationEvents.push(event);
  Object.assign(connection, toConnectionRecord(row));

  return {
    status: "ok" as const,
    connectionId: connection.id,
    event
  };
}

export async function listIntegrationEvents(connectionId: string) {
  await ensureLegacyFixturesPersisted();
  const rows = await prisma.integrationEvent.findMany({ where: { connectionId }, orderBy: { createdAt: "asc" } });
  for (const row of rows) {
    mirrorRecord(demoStore.integrationEvents, toEventRecord(row));
  }
  return demoStore.integrationEvents.filter((event) => event.connectionId === connectionId);
}
