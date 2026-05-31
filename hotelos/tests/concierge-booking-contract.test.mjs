import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("Concierge and booking contracts", () => {
  it("exposes concierge and service request routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    for (const route of [
      "/properties/:propertyId/conversations",
      "/conversations/:id/messages",
      "/conversations/:id/ai-draft",
      "/service-requests",
      "/service-requests/:id"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });

  it("exposes backend availability quote route", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    assert.match(server, /\/properties\/:propertyId\/availability\/quote/);
    const service = readFileSync(new URL("../apps/api/src/modules/pms/pms.service.ts", import.meta.url), "utf8");
    assert.match(service, /quoteAvailability/);
    assert.match(service, /cancellationPolicy/);
  });

  it("requires AI disclosure in guest-facing draft behavior", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/messaging/messaging.service.ts", import.meta.url), "utf8");
    assert.match(service, /GUEST_AI_DISCLOSURE/);
    assert.match(service, /AI_GUEST_REPLY_DRAFTED/);
    assert.match(service, /requiresHumanReview/);
  });

  it("supports typed chat attachments with audit metadata", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/messaging/messaging.service.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
    const mobile = readFileSync(new URL("../apps/mobile/src/screens/ConciergeScreen.tsx", import.meta.url), "utf8");

    for (const marker of ["photo", "camera_photo", "file", "voice_note", "MAX_CHAT_ATTACHMENTS_PER_MESSAGE"]) {
      assert.match(service, new RegExp(marker));
    }
    assert.match(service, /attachmentCount/);
    assert.match(service, /attachmentTypes/);
    assert.match(server, /attachments\?: ChatAttachmentDraft\[\]/);
    assert.match(schema, /model MessageAttachment/);
    assert.match(schema, /privacyReviewRequired/);
    for (const marker of ["pickChatPhotoAttachment", "captureChatCameraPhoto", "pickChatFileAttachment", "startVoiceNote", "sendConciergeMessage"]) {
      assert.match(mobile, new RegExp(marker));
    }
  });

  it("does not let the booking agent invent quotes in the gateway", () => {
    const gateway = readFileSync(new URL("../apps/ai-gateway/src/server.ts", import.meta.url), "utf8");
    assert.match(gateway, /needs_more_information/);
    assert.match(gateway, /\/availability\/quote/);
    assert.match(gateway, /Availability and prices come from the PMS availability tool/);
  });
});
