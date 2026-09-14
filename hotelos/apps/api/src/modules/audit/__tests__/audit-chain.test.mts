// Unit tests for the hash-chain integrity check of the audit trail and the
// domain event stream (Tanda 4 · higiene H1). No database: the hydration
// sentinel is pushed into demoStore by hand (same factory the boot path uses)
// and events are sealed with the exported seal helpers, so nothing reaches
// Prisma, the accounting projections or the notification hooks. Run from apps/api:
//   node --import tsx --test src/modules/audit/__tests__/audit-chain.test.mts
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { demoStore } from "../../../lib/demo-store.js";
import {
  auditChainTipSentinel,
  CHAIN_TIP_MARKER,
  createIntegrityHash,
  eventChainTipSentinel,
  sealAuditEvent,
  sealDomainEvent,
  verifyAuditIntegrity,
  verifyDomainEventIntegrity
} from "../audit.service.js";

const TIP_HASH = createIntegrityHash({ genesis: "postgres-tail" });

function pushAudit(n: number, action = "RESERVATION_CREATED") {
  const event = sealAuditEvent({
    id: `aud_test_${n}`,
    organizationId: "org_123",
    propertyId: "prop_123",
    actorType: "user",
    action,
    entityType: "reservation",
    entityId: `res_${n}`,
    afterJson: { n },
    createdAt: `2026-09-14T10:00:0${n}.000Z`
  });
  demoStore.auditEvents.push(event);
  return event;
}

function pushEvent(n: number) {
  const event = sealDomainEvent({
    eventId: `evt_test_${n}`,
    organizationId: "org_123",
    propertyId: "prop_123",
    entityType: "reservation",
    entityId: `res_${n}`,
    eventType: "reservation.created",
    payload: { n },
    actorType: "user",
    correlationId: `corr_${n}`,
    createdAt: `2026-09-14T10:00:0${n}.000Z`
  });
  demoStore.events.push(event);
  return event;
}

describe("verifyAuditIntegrity with a hydrated chain tip", () => {
  beforeEach(() => {
    demoStore.auditEvents.length = 0;
    demoStore.events.length = 0;
  });

  it("treats the __CHAIN_TIP__ sentinel as the starting point: valid, not counted, anchored to its hash", () => {
    demoStore.auditEvents.push(auditChainTipSentinel("aud_pg_tail", TIP_HASH));
    const first = pushAudit(1);
    pushAudit(2);

    assert.equal(first.previousHash, TIP_HASH, "the first real event chains against the Postgres tip");
    const result = verifyAuditIntegrity();
    assert.deepEqual(result, { valid: true, count: 2, anchoredTo: TIP_HASH });
  });

  it("still validates a genesis chain (no sentinel, empty ring at boot)", () => {
    pushAudit(1);
    pushAudit(2);
    const result = verifyAuditIntegrity();
    assert.deepEqual(result, { valid: true, count: 2, anchoredTo: undefined });
    assert.equal(demoStore.auditEvents[0].previousHash, undefined);
  });

  it("reports a tampered event with brokenAt pointing at it", () => {
    demoStore.auditEvents.push(auditChainTipSentinel("aud_pg_tail", TIP_HASH));
    pushAudit(1);
    const second = pushAudit(2);
    pushAudit(3);

    // Mutate contents after sealing: the stored currentHash no longer matches.
    (second as { action: string }).action = "RESERVATION_DELETED";

    const result = verifyAuditIntegrity();
    assert.equal(result.valid, false);
    assert.equal(result.count, 3);
    if (result.valid) throw new Error("unreachable");
    assert.equal(result.brokenAt, "aud_test_2");
    assert.equal(result.reason, "Current hash does not match record contents.");
  });

  it("reports a broken link when a record's previousHash does not match the sentinel tip", () => {
    demoStore.auditEvents.push(auditChainTipSentinel("aud_pg_tail", TIP_HASH));
    const first = pushAudit(1);
    // Simulate a fork: the record was sealed against another instance's tail.
    (first as { previousHash?: string }).previousHash = createIntegrityHash({ other: "instance" });

    const result = verifyAuditIntegrity();
    assert.equal(result.valid, false);
    if (result.valid) throw new Error("unreachable");
    assert.equal(result.brokenAt, "aud_test_1");
    assert.equal(result.reason, "Previous hash does not match prior record.");
    assert.equal(result.anchoredTo, TIP_HASH);
  });

  it("does not accept a sentinel anywhere but at the head (its contents never hash)", () => {
    pushAudit(1);
    demoStore.auditEvents.push(auditChainTipSentinel("aud_fake", TIP_HASH));
    const result = verifyAuditIntegrity();
    assert.equal(result.valid, false);
    if (result.valid) throw new Error("unreachable");
    assert.equal(result.brokenAt, "aud_fake");
    assert.equal(demoStore.auditEvents[1].action, CHAIN_TIP_MARKER);
  });
});

describe("verifyDomainEventIntegrity with a hydrated chain tip", () => {
  beforeEach(() => {
    demoStore.auditEvents.length = 0;
    demoStore.events.length = 0;
  });

  it("anchors the event stream to the sentinel and validates two sealed events", () => {
    demoStore.events.push(eventChainTipSentinel("evt_pg_tail", TIP_HASH));
    const first = pushEvent(1);
    pushEvent(2);
    assert.equal(first.previousHash, TIP_HASH);
    assert.deepEqual(verifyDomainEventIntegrity(), { valid: true, count: 2, anchoredTo: TIP_HASH });
  });

  it("flags a tampered payload", () => {
    demoStore.events.push(eventChainTipSentinel("evt_pg_tail", TIP_HASH));
    const first = pushEvent(1);
    pushEvent(2);
    (first.payload as { n: number }).n = 99;
    const result = verifyDomainEventIntegrity();
    assert.equal(result.valid, false);
    if (result.valid) throw new Error("unreachable");
    assert.equal(result.brokenAt, "evt_test_1");
  });
});
