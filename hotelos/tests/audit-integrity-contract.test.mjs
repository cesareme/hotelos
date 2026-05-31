import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const auditService = readFileSync(new URL("../apps/api/src/modules/audit/audit.service.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const manifest = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const sharedTypes = readFileSync(new URL("../packages/shared/src/types.ts", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/api-contracts.md", import.meta.url), "utf8");

describe("Audit integrity contract", () => {
  it("seals audit and domain events with a SHA-256 hash chain", () => {
    assert.match(auditService, /createHash/);
    assert.match(auditService, /stableStringify/);
    assert.match(auditService, /previousHash/);
    assert.match(auditService, /currentHash/);
    assert.match(auditService, /hashAlgorithm: HASH_ALGORITHM/);
  });

  it("can verify audit and domain event chains", () => {
    assert.match(auditService, /verifyAuditIntegrity/);
    assert.match(auditService, /verifyDomainEventIntegrity/);
    assert.match(auditService, /Previous hash does not match prior record/);
    assert.match(auditService, /Current hash does not match record contents/);
  });

  it("persists integrity fields in audit and event tables", () => {
    assert.match(schema, /model AuditEvent[\s\S]*hashAlgorithm\s+String/);
    assert.match(schema, /model AuditEvent[\s\S]*previousHash\s+String\?/);
    assert.match(schema, /model AuditEvent[\s\S]*currentHash\s+String/);
    assert.match(schema, /model EventStream[\s\S]*hashAlgorithm\s+String/);
    assert.match(schema, /model EventStream[\s\S]*previousHash\s+String\?/);
    assert.match(schema, /model EventStream[\s\S]*currentHash\s+String/);
  });

  it("exposes protected integrity check endpoints", () => {
    assert.match(server, /\/audit-events\/integrity/);
    assert.match(server, /\/events\/integrity/);
    assert.match(manifest, /path: "\/audit-events\/integrity"/);
    assert.match(manifest, /path: "\/events\/integrity"/);
    assert.match(manifest, /"ai.high_risk.confirm"/);
  });

  it("shares integrity fields across app types", () => {
    assert.match(sharedTypes, /hashAlgorithm: "sha256"/);
    assert.match(sharedTypes, /previousHash\?: string/);
    assert.match(sharedTypes, /currentHash: string/);
  });

  it("documents append-only event integrity", () => {
    assert.match(docs, /Audit Integrity/);
    assert.match(docs, /append-only records sealed by a SHA-256 hash chain/);
    assert.match(docs, /no update or delete APIs for audit records/);
  });
});
