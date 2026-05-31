import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
const integrationsIndex = readFileSync(new URL("../packages/integrations/src/index.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
const deploymentDoc = readFileSync(new URL("../docs/deployment.md", import.meta.url), "utf8");

describe("Worker integration contract", () => {
  it("defines the production background job names", () => {
    for (const jobName of [
      "ses_hospedajes.submit",
      "invoice.compliance.check",
      "messaging.send",
      "ota.channel_sync",
      "bank.reconciliation.match",
      "retention.delete_expired",
      "reports.daily_briefing"
    ]) {
      assert.match(worker, new RegExp(jobName.replaceAll(".", "\\.")));
    }
  });

  it("uses adapters instead of inline provider logic", () => {
    assert.match(worker, /submitSesHospedajesRecord/);
    assert.match(worker, /createB2bEinvoiceEnvelope/);
    assert.match(worker, /sendGuestMessageViaAdapter/);
    assert.match(worker, /syncOtaChannelAvailability/);
    assert.match(worker, /suggestBankTransactionMatches/);
  });

  it("returns retry, failed, and completed outcomes with domain events", () => {
    assert.match(worker, /"retry"/);
    assert.match(worker, /"failed"/);
    assert.match(worker, /"completed"/);
    assert.match(worker, /SesHospedajesSubmissionAccepted/);
    assert.match(worker, /InvoiceComplianceFailed/);
    assert.match(worker, /RetentionDeletionCompleted/);
    assert.match(worker, /DailyBriefingGenerated/);
  });

  it("exports integration adapters for messaging, channels, and bank reconciliation", () => {
    assert.match(integrationsIndex, /messaging\.js/);
    assert.match(integrationsIndex, /channel-manager\.js/);
    assert.match(integrationsIndex, /bank-reconciliation\.js/);
  });

  it("has a durable worker job run table", () => {
    assert.match(schema, /model WorkerJobRun/);
    assert.match(schema, /@@map\("worker_job_runs"\)/);
    assert.match(schema, /payloadJson\s+Json/);
    assert.match(schema, /resultJson\s+Json\?/);
    assert.match(schema, /lastError\s+String\?/);
  });

  it("documents each scheduled worker responsibility", () => {
    for (const jobName of [
      "ses_hospedajes.submit",
      "invoice.compliance.check",
      "messaging.send",
      "ota.channel_sync",
      "bank.reconciliation.match",
      "retention.delete_expired",
      "reports.daily_briefing"
    ]) {
      assert.match(deploymentDoc, new RegExp(jobName.replaceAll(".", "\\.")));
    }
  });
});
