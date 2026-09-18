import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("Spain compliance hub contract", () => {
  it("exposes guest register and SES queue routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    // Tanda L2 (L2-01): the F2 family (/properties/:propertyId/ses-hospedajes/
    // submissions, /ses-hospedajes/submissions/:id/status) is retired by L2-02 in
    // favour of the canonical /properties/:propertyId/ses/submissions +
    // /ses/submissions/:id, so it is no longer pinned here.
    for (const route of [
      "/properties/:propertyId/compliance/inbox",
      "/properties/:propertyId/guest-register-records",
      "/guest-register-records/:id/sign",
      "/guest-register-records/:id/correct",
      "/guest-register-records/:id/queue-ses"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });

  it("supports correction and status audit events", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/compliance/compliance.service.ts", import.meta.url), "utf8");
    assert.match(service, /GUEST_REGISTER_CORRECTED/);
    assert.match(service, /SES_HOSPEDAJES_SUBMISSION_STATUS_UPDATED/);
    assert.match(service, /retentionUntil/);
  });

  it("keeps ID-image deletion policy separate from guest register payloads", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/compliance/compliance.service.ts", import.meta.url), "utf8");
    assert.doesNotMatch(service, /documentImageStored/);
    assert.doesNotMatch(service, /imageObjectKey/);
  });
});

