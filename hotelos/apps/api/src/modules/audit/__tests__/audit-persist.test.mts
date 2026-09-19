// Persistidores de auditoría (fusión T8 · E1): un fallo de escritura en
// Postgres (P2002 por id duplicado, o cualquier otro) NUNCA se propaga al
// llamador de recordAuditEvent/recordDomainEvent, suma al contador que /health
// expone en `checks.audit` y deja un log JSON con eventId/action/code. Sin base
// de datos: los persistidores se sustituyen con setAuditPersistDepsForTests.
// Mismo estilo que audit-chain.test.mts. Run from apps/api:
//   node --import tsx --test src/modules/audit/__tests__/audit-persist.test.mts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { demoStore } from "../../../lib/demo-store.js";
import {
  flushAuditQueues,
  getAuditPersistStats,
  recordAuditEvent,
  recordDomainEvent,
  resetAuditPersistStatsForTests,
  setAuditLogger,
  setAuditPersistDepsForTests
} from "../audit.service.js";

/** Misma forma que PrismaClientKnownRequestError P2002 (violación de único). */
function uniqueViolation(field: string): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), {
    code: "P2002",
    meta: { target: [field] }
  });
}

function loggedJson(errorLog: ReturnType<typeof mock.method>): Array<Record<string, unknown>> {
  return errorLog.mock.calls
    .map((call) => call.arguments[0])
    .filter((line): line is string => typeof line === "string" && line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("queueAuditPersist / queueDomainEventPersist ante un fallo de Prisma", () => {
  beforeEach(() => {
    demoStore.auditEvents.length = 0;
    demoStore.events.length = 0;
    resetAuditPersistStatsForTests();
  });

  afterEach(() => {
    setAuditPersistDepsForTests(null);
    setAuditLogger(null);
    resetAuditPersistStatsForTests();
    demoStore.auditEvents.length = 0;
    demoStore.events.length = 0;
    mock.restoreAll();
  });

  it("recordAuditEvent no lanza con P2002: contador +1, lastError con el código y log JSON estructurado", async () => {
    const errorLog = mock.method(console, "error", () => undefined);
    setAuditPersistDepsForTests({
      auditCreate: async () => {
        throw uniqueViolation("id");
      }
    });

    const event = recordAuditEvent({
      organizationId: "org_123",
      propertyId: "prop_123",
      actorType: "system",
      action: "T8_TEST",
      entityType: "test"
    });
    assert.match(event.id, /^aud_[0-9a-f]{16}$/);
    assert.equal(demoStore.auditEvents.length, 1, "el anillo en memoria conserva el evento");

    await flushAuditQueues();

    const stats = getAuditPersistStats();
    assert.equal(stats.failures, 1);
    assert.equal(stats.lastError?.code, "P2002");
    assert.equal(stats.lastError?.action, "T8_TEST");
    assert.equal(stats.lastError?.eventId, event.id);
    assert.match(stats.lastError?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);

    const lines = loggedJson(errorLog);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "error");
    assert.equal(lines[0].eventId, event.id);
    assert.equal(lines[0].action, "T8_TEST");
    assert.equal(lines[0].code, "P2002");
    assert.match(String(lines[0].msg), /^\[audit\] persistencia fallida: id duplicado \(P2002\)/);
    assert.match(String(lines[0].error), /Unique constraint failed/);
  });

  it("recordDomainEvent no lanza con P2002 en event_stream: contador +1 y log `[event]` con eventType como action", async () => {
    const errorLog = mock.method(console, "error", () => undefined);
    setAuditPersistDepsForTests({
      eventCreate: async () => {
        throw uniqueViolation("event_id");
      }
    });

    const event = recordDomainEvent({
      organizationId: "org_123",
      propertyId: "prop_123",
      entityType: "test",
      entityId: "test_1",
      eventType: "T8TestEvent",
      payload: { n: 1 },
      actorType: "system",
      correlationId: "corr_t8_test"
    });
    assert.match(event.eventId, /^evt_[0-9a-f]{16}$/);

    await flushAuditQueues();

    const stats = getAuditPersistStats();
    assert.equal(stats.failures, 1);
    assert.deepEqual(
      { eventId: stats.lastError?.eventId, action: stats.lastError?.action, code: stats.lastError?.code },
      { eventId: event.eventId, action: "T8TestEvent", code: "P2002" }
    );

    const lines = loggedJson(errorLog);
    assert.equal(lines.length, 1);
    assert.match(String(lines[0].msg), /^\[event\] persistencia fallida: id duplicado \(P2002\)/);
    assert.equal(lines[0].eventId, event.eventId);
    assert.equal(lines[0].action, "T8TestEvent");
    assert.equal(lines[0].code, "P2002");
  });

  it("con setAuditLogger (app.log en server.ts) el fallo sale por el logger a nivel error, no por console.error", async () => {
    const errorLog = mock.method(console, "error", () => undefined);
    const logged: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    setAuditLogger({ error: (obj, msg) => logged.push({ obj, msg }) });
    setAuditPersistDepsForTests({
      auditCreate: async () => {
        throw uniqueViolation("id");
      }
    });
    const event = recordAuditEvent({ organizationId: "org_123", propertyId: "prop_123", actorType: "system", action: "AuditLoggerProbe", entityType: "test" });
    await flushAuditQueues();
    assert.equal(getAuditPersistStats().failures, 1);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.msg, "[audit] persistencia fallida: id duplicado (P2002); evento perdido y cadena hash rota");
    assert.equal(logged[0]!.obj.eventId, event.id);
    assert.equal(logged[0]!.obj.action, "AuditLoggerProbe");
    assert.equal(logged[0]!.obj.code, "P2002");
    assert.equal(loggedJson(errorLog).length, 0, "con logger inyectado no hay línea JSON por console.error");
  });

  it("un error sin código Prisma cuenta igual con code UNKNOWN y mensaje genérico; los fallos se acumulan", async () => {
    const errorLog = mock.method(console, "error", () => undefined);
    setAuditPersistDepsForTests({
      auditCreate: async () => {
        throw new Error("Engine is not yet connected");
      }
    });

    recordAuditEvent({ organizationId: "org_123", actorType: "system", action: "T8_TEST_A", entityType: "test" });
    recordAuditEvent({ organizationId: "org_123", actorType: "system", action: "T8_TEST_B", entityType: "test" });
    await flushAuditQueues();

    const stats = getAuditPersistStats();
    assert.equal(stats.failures, 2);
    assert.equal(stats.lastError?.code, "UNKNOWN");
    assert.equal(stats.lastError?.action, "T8_TEST_B");
    const lines = loggedJson(errorLog);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].msg, "[audit] persistencia fallida");
    assert.equal(lines[1].error, "Engine is not yet connected");
  });

  it("con persistencia correcta el contador queda a 0 y el persistidor recibe los datos sellados", async () => {
    const written: Array<{ id: string; currentHash: string; previousHash: string | null }> = [];
    setAuditPersistDepsForTests({
      auditCreate: async (data) => {
        written.push({ id: data.id as string, currentHash: data.currentHash, previousHash: (data.previousHash as string | null) ?? null });
      }
    });

    const first = recordAuditEvent({ organizationId: "org_123", actorType: "system", action: "T8_TEST_1", entityType: "test" });
    const second = recordAuditEvent({ organizationId: "org_123", actorType: "system", action: "T8_TEST_2", entityType: "test" });
    await flushAuditQueues();

    assert.deepEqual(getAuditPersistStats(), { failures: 0, lastError: null });
    assert.deepEqual(
      written,
      [
        { id: first.id, currentHash: first.currentHash, previousHash: null },
        { id: second.id, currentHash: second.currentHash, previousHash: first.currentHash }
      ],
      "orden de inserción determinista y cadena enlazada"
    );
  });
});
