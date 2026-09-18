import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const repo = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");
const exists = (path) => existsSync(new URL(path, repo));
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const moduleCodes = read("packages/product/src/modules/module-codes.ts");
const manifest = read("packages/product/src/modules/module-manifest.ts");
const sharedTypes = read("packages/shared/src/types.ts");
const permissions = read("packages/shared/src/permissions.ts");
const schema = read("packages/database/prisma/schema.prisma");
const demoStore = read("apps/api/src/lib/demo-store.ts");
const server = read("apps/api/src/server.ts");
const routePermissions = read("apps/api/src/security/route-permissions.ts");
const complianceService = read("apps/api/src/modules/compliance/compliance.service.ts");
const aiToolNames = read("packages/ai-tools/src/tool-names.ts");
const aiRegistry = read("packages/ai-tools/src/registry.ts");
const worker = read("apps/worker/src/index.ts");
// Tanda L2 (L2-07 · worker honesto): the catalogue is the four pg-boss queues of scheduler.ts.
const workerScheduler = read("apps/worker/src/scheduler.ts");
const sesSubmissionService = read("apps/api/src/modules/compliance/ses-submission.service.ts");
const mobileNavigation = read("packages/product/src/navigation/mobile-navigation.ts");
const moduleRoutes = read("apps/mobile/src/navigation/ModuleRoutes.tsx");
// Tanda 5 · L1b: the sidebar renders nav-tree.generated.json, so the menu source is both files.
const sidebar = read("apps/admin-web/src/navigation/Sidebar.tsx") + read("apps/admin-web/src/navigation/nav-tree.generated.json");
const app = read("apps/admin-web/src/App.tsx");
const demoHtml = read("demo/public/index.html");

describe("Spain Guest Register and SES.HOSPEDAJES compliance module", () => {
  it("registers the module, permissions, mobile routes and admin routes", () => {
    assert.match(moduleCodes, /spain_guest_register_compliance/);
    assert.match(manifest, /Registro de viajeros \(España\)/);
    for (const permission of [
      "guest_register.read",
      "guest_register.create",
      "guest_register.edit",
      "guest_register.sign",
      "guest_register.submit",
      "guest_register.export",
      "guest_register.annul",
      "guest_register.correct",
      "guest_register.view_sensitive",
      "guest_register.configure",
      "compliance.ses.export",
      "compliance.ses.configure"
    ]) {
      assert.match(sharedTypes, new RegExp(escaped(permission)));
      assert.match(permissions, new RegExp(escaped(permission)));
      assert.match(demoStore, new RegExp(escaped(permission)));
    }
    for (const route of ["GuestRegisterInbox", "CheckInGuestRegister", "SesSubmissionQueue", "GuestRegisterDetail"]) {
      assert.match(manifest + mobileNavigation + moduleRoutes, new RegExp(route));
    }
    for (const screen of [
      "GuestRegisterSettings",
      "SesHospedajesSettings",
      "AuthorityRoutingSettings",
      "GuestRegisterRetentionSettings",
    ]) {
      assert.match(manifest + sidebar + app, new RegExp(screen));
    }
  });

  it("extends the database without duplicating guest register records", () => {
    for (const model of [
      "AuthorityReportingSetting",
      "LodgingLegalProfile",
      "GuestRegisterRecord",
      "AuthoritySubmissionBatch",
      "AuthoritySubmissionBatchRecord",
      "AuthoritySubmission",
      "IdentityDocumentProcessingEvent",
      "AuthorityRoutingRule"
    ]) {
      assert.match(schema, new RegExp(`model ${model}`));
    }
    for (const table of [
      "authority_reporting_settings",
      "lodging_legal_profiles",
      "guest_register_records",
      "authority_submission_batches",
      "authority_submission_batch_records",
      "authority_submissions",
      "identity_document_processing_events",
      "authority_routing_rules"
    ]) {
      assert.match(schema, new RegExp(escaped(`@@map("${table}")`)));
    }
    for (const field of [
      "documentSupportNumber",
      "providedByAdultGuestId",
      "kinshipRelationIfMinor",
      "paymentMethodIdentifier",
      "validationErrorsJson",
      "signatureRequired",
      "identityVerified",
      "idImageStored",
      "idImageDiscarded",
      "retentionUntil"
    ]) {
      assert.match(schema, new RegExp(field));
    }
  });

  it("implements legal validation, data minimisation and official schema placeholders", () => {
    const validator = read("packages/compliance/src/spain/guest-register-validator.ts");
    for (const marker of [
      "validateSpainGuestRegisterRecord",
      "firstName",
      "surname1",
      "documentSupportNumber",
      "providedByAdultGuestId",
      "kinshipRelationIfMinor",
      "signature_required",
      "id_image_stored_blocked",
      "id_image_discard_event_missing",
      "cvv_storage_blocked",
      "pan_storage_blocked",
      "ID_IMAGE_DISCARDED",
      "calculateSpainGuestRegisterRetentionUntil"
    ]) {
      assert.match(validator, new RegExp(escaped(marker)));
    }
    assert.equal(exists("packages/compliance/src/spain/ses-hospedajes/schemas/README.md"), true);
    assert.equal(exists("packages/compliance/src/spain/ses-hospedajes/schemas/official-xsd-placeholder.md"), true);
    assert.match(read("packages/compliance/src/spain/ses-hospedajes/schemas/README.md"), /Do not hardcode unofficial/);
  });

  it("adds authority adapters for SES, manual export and regional placeholders", () => {
    const adapterIndex = read("packages/integrations/src/adapters/government/ses-hospedajes/index.ts");
    const adapters = read("packages/integrations/src/adapters/government/ses-hospedajes/adapters.ts");
    const types = read("packages/integrations/src/adapters/government/ses-hospedajes/types.ts");
    assert.match(adapterIndex, /adapters\.js/);
    assert.match(types, /interface GuestAuthorityAdapter/);
    for (const adapter of [
      "ses_hospedajes_mock",
      "ses_hospedajes_file_export",
      "ses_hospedajes_web_service_placeholder",
      "mossos_placeholder",
      "ertzaintza_placeholder",
      "manual_authority_export"
    ]) {
      assert.match(adapters, new RegExp(adapter));
    }
    assert.match(read("packages/integrations/src/index.ts"), /adapters\/government\/ses-hospedajes/);
  });

  it("exposes protected compliance API endpoints and audit events", () => {
    for (const route of [
      "/compliance/spain/properties/:propertyId/guest-register/settings",
      "/compliance/spain/reservations/:reservationId/guest-register",
      "/compliance/spain/guest-register/:recordId/validate",
      "/compliance/spain/guest-register/:recordId/sign",
      "/compliance/spain/guest-register/:recordId/queue-submission",
      "/compliance/spain/identity-document/temporary-scan",
      "/compliance/spain/identity-document/discard-event",
      // Tanda L2 (L2-01): the F1 authority family (/compliance/authority/
      // properties/:propertyId/inbox, /compliance/authority/submissions/
      // :submissionId/retry) is retired by L2-02 (canonical inbox:
      // /properties/:propertyId/compliance/inbox); batches and test-connection stay.
      "/compliance/ses-hospedajes/properties/:propertyId/batches/generate",
      "/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/submit",
      "/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/mark-manually-uploaded",
      "/compliance/ses-hospedajes/properties/:propertyId/test-connection"
    ]) {
      assert.match(server, new RegExp(escaped(route)));
      assert.match(routePermissions, new RegExp(escaped(route)));
    }
    for (const event of [
      "GuestRegisterRecordCreated",
      "GuestRegisterRecordValidated",
      "GuestRegisterIdentityVerified",
      "TemporaryIdScanStarted",
      "ID_IMAGE_DISCARDED",
      "IdImageDiscarded",
      "GuestRegisterQueued",
      "AuthorityBatchGenerated",
      "AuthorityBatchDownloaded",
      "AuthorityBatchSubmitted",
      "AuthoritySubmissionAccepted",
      "AuthoritySubmissionRetried",
      "AuthorityCommunicationAnnulled",
      "GuestRegisterCorrected",
      "SensitiveGuestRegisterViewed"
    ]) {
      assert.match(complianceService, new RegExp(escaped(event)));
    }
  });

  it("adds workers, AI tools, UI screens and demo markers", () => {
    // Tanda L2 (L2-07 · worker honesto): the scaffolded guest-register job names
    // (generateDailyGuestRegisterBatch, submitQueuedGuestRegisterRecords…) that
    // answered «completed» without doing anything were retired from the worker.
    // The real SES scheduler runs in the API under the schedulers lease
    // (server.ts · runDueSesSubmissions: retries + overdue report, RD 933/2021).
    assert.match(server, /runDueSesSubmissions\(demoStore\.userContext\)/);
    assert.match(server, /SES_SCHEDULER_DISABLED/);
    assert.match(sesSubmissionService, /export async function runDueSesSubmissions/);
    for (const queue of ["notifications.scheduled", "notifications.retry", "notifications.sending-sweep", "webhooks.deliver"]) {
      assert.match(workerScheduler, new RegExp(`"${queue.replace(/\./g, "\\.")}"`));
    }
    assert.doesNotMatch(worker + workerScheduler, /generateDailyGuestRegisterBatch|submitQueuedGuestRegisterRecords/);
    for (const tool of [
      "extractGuestIdentityFieldsTemporary",
      "validateSpainGuestRegister",
      "prepareGuestRegisterRecord",
      "requestGuestRegisterSignature",
      "queueGuestAuthoritySubmission",
      "generateSesBatchFile",
      "summarizeGuestRegisterComplianceIssues",
      "explainSubmissionRejection"
    ]) {
      assert.match(aiToolNames, new RegExp(tool));
      assert.match(aiRegistry, new RegExp(tool));
    }
    for (const path of [
      "apps/mobile/src/screens/guest-register/GuestRegisterInboxScreen.tsx",
      "apps/mobile/src/screens/guest-register/CheckInGuestRegisterScreen.tsx",
      "apps/mobile/src/screens/guest-register/OcrReviewScreen.tsx",
      "apps/mobile/src/screens/guest-register/GuestRegisterSignatureScreen.tsx",
      "apps/mobile/src/screens/guest-register/GuestRegisterDetailScreen.tsx",
      "apps/mobile/src/screens/guest-register/SesSubmissionQueueScreen.tsx",
      "apps/mobile/src/screens/guest-register/AuthorityBatchDetailScreen.tsx",
      "apps/admin-web/src/screens/compliance/GuestRegisterSettingsScreen.tsx",
      "apps/admin-web/src/screens/compliance/SesHospedajesSettingsScreen.tsx",
      "apps/admin-web/src/screens/compliance/AuthorityRoutingSettingsScreen.tsx",
      "apps/admin-web/src/screens/compliance/GuestRegisterRetentionSettingsScreen.tsx",
    ]) {
      assert.equal(exists(path), true);
    }
    for (const marker of ["Spain Guest Register", "SES.HOSPEDAJES", "ID_IMAGE_DISCARDED", "Mossos", "3-year retention"]) {
      assert.match(demoHtml, new RegExp(escaped(marker)));
    }
  });
});
