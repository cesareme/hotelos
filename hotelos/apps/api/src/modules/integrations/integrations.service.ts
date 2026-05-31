import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import {
  demoStore,
  type IntegrationConnectionRecord,
  type IntegrationEventRecord,
  type UserContext
} from "../../lib/demo-store.js";

export function listIntegrationCategories() {
  return demoStore.integrationCategories;
}

export function listIntegrationProviders() {
  return demoStore.integrationProviders.map((provider) => ({
    ...provider,
    category: demoStore.integrationCategories.find((category) => category.id === provider.categoryId)
  }));
}

export function listPropertyIntegrations(propertyId: string) {
  return demoStore.integrationConnections
    .filter((connection) => connection.propertyId === propertyId)
    .map((connection) => ({
      ...connection,
      provider: demoStore.integrationProviders.find((provider) => provider.id === connection.providerId)
    }));
}

export function connectIntegration(input: {
  context: UserContext;
  propertyId: string;
  providerCode: string;
  credentialsSecretRef?: string;
  configJson?: Record<string, unknown>;
  correlationId: string;
}): IntegrationConnectionRecord {
  requirePermissions(input.context, ["integrations.connect"]);
  if ((input.configJson as Record<string, unknown> | undefined)?.credentials) {
    throw new Error("Integration credentials must be stored in a secret manager reference, not config_json.");
  }

  const provider = demoStore.integrationProviders.find((candidate) => candidate.code === input.providerCode);
  if (!provider) {
    throw new Error("Integration provider was not found.");
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

export function disconnectIntegration(input: {
  context: UserContext;
  propertyId: string;
  connectionId: string;
  correlationId: string;
}) {
  requirePermissions(input.context, ["integrations.disconnect"]);
  const connection = demoStore.integrationConnections.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.id === input.connectionId
  );
  if (!connection) {
    throw new Error("Integration connection was not found.");
  }

  const before = { ...connection };
  connection.status = "disconnected";

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

export function testIntegrationConnection(input: {
  context: UserContext;
  propertyId: string;
  connectionId: string;
  correlationId: string;
}) {
  requirePermissions(input.context, ["integrations.test"]);
  const connection = demoStore.integrationConnections.find(
    (candidate) => candidate.propertyId === input.propertyId && candidate.id === input.connectionId
  );
  if (!connection) {
    throw new Error("Integration connection was not found.");
  }

  const event: IntegrationEventRecord = {
    id: createId("ievt"),
    connectionId: connection.id,
    direction: "outbound",
    eventType: "IntegrationSyncStarted",
    payloadJson: { test: true },
    status: "accepted",
    createdAt: nowIso()
  };
  demoStore.integrationEvents.push(event);
  connection.lastSyncAt = event.createdAt;

  return {
    status: "ok" as const,
    connectionId: connection.id,
    event
  };
}

export function listIntegrationEvents(connectionId: string) {
  return demoStore.integrationEvents.filter((event) => event.connectionId === connectionId);
}
