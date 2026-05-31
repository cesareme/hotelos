import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const retention = readFileSync(new URL("../packages/compliance/src/retention-policy.ts", import.meta.url), "utf8");
const complianceIndex = readFileSync(new URL("../packages/compliance/src/index.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
const workerPackage = JSON.parse(readFileSync(new URL("../apps/worker/package.json", import.meta.url), "utf8"));
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/compliance-spec.md", import.meta.url), "utf8");

describe("Retention policy contract", () => {
  it("declares default retention policy modes", () => {
    assert.match(retention, /temporary_only/);
    assert.match(retention, /scheduled_delete/);
    assert.match(retention, /manual_review/);
    assert.match(retention, /append_only/);
    assert.match(complianceIndex, /retention-policy\.js/);
  });

  it("keeps ID images temporary and guest registers retained for 36 months", () => {
    assert.match(retention, /entityType: "id_document_image"[\s\S]*mode: "temporary_only"/);
    assert.match(retention, /auditAction: "ID_IMAGE_DISCARDED"/);
    assert.match(retention, /entityType: "guest_register_record"[\s\S]*retentionMonths: 36/);
    assert.match(retention, /entityType: "ses_hospedajes_submission"[\s\S]*retentionMonths: 36/);
  });

  it("prevents retention jobs from deleting append-only audit records", () => {
    assert.match(retention, /entityType: "audit_event"[\s\S]*mode: "append_only"/);
    assert.match(retention, /entityType: "event_stream"[\s\S]*mode: "append_only"/);
    assert.match(retention, /Append-only records are not deleted by retention jobs/);
  });

  it("uses compliance retention decisions in the worker", () => {
    assert.equal(workerPackage.dependencies["@hotelos/compliance"], "workspace:*");
    assert.match(worker, /shouldDeleteRetentionCandidate/);
    assert.match(worker, /decision\.deleteNow/);
    assert.match(worker, /retainedCount/);
  });

  it("adds configurable retention policies to the schema", () => {
    assert.match(schema, /model RetentionPolicy/);
    assert.match(schema, /@@map\("retention_policies"\)/);
    assert.match(schema, /retentionMonths\s+Int\?/);
    assert.match(schema, /legalHoldAllowed\s+Boolean/);
  });

  it("documents retention behavior", () => {
    assert.match(docs, /Retention Policy Rule/);
    assert.match(docs, /id_document_image/);
    assert.match(docs, /append_only/);
    assert.match(docs, /retention_policies/);
  });
});
