import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const nativeCapabilities = readFileSync(new URL("../apps/mobile/src/services/nativeCapabilities.ts", import.meta.url), "utf8");
const productSpec = readFileSync(new URL("../docs/product-spec.md", import.meta.url), "utf8");

describe("Mobile native capability contract", () => {
  it("names the required iOS and Android providers", () => {
    assert.match(nativeCapabilities, /Apple Speech framework/);
    assert.match(nativeCapabilities, /Android SpeechRecognizer/);
    assert.match(nativeCapabilities, /VisionKit/);
    assert.match(nativeCapabilities, /Google ML Kit Text Recognition v2/);
  });

  it("allows native bridge injection for dev-client modules", () => {
    assert.match(nativeCapabilities, /NativeCapabilityBridge/);
    assert.match(nativeCapabilities, /setNativeCapabilityBridge/);
    assert.match(nativeCapabilities, /nativeBridge\?\.voice/);
    assert.match(nativeCapabilities, /nativeBridge\?\.documentScanner/);
    assert.match(nativeCapabilities, /nativeBridge\?\.maintenanceCamera/);
    assert.match(nativeCapabilities, /nativeBridge\?\.chatMedia/);
  });

  it("guards the Spain ID scan minimisation rule on-device", () => {
    assert.match(nativeCapabilities, /assertGuestDocumentImageDiscarded/);
    assert.match(nativeCapabilities, /imageStored !== false/);
    assert.match(nativeCapabilities, /imageDiscarded !== true/);
    assert.match(nativeCapabilities, /"imageUri" in result/);
    assert.match(nativeCapabilities, /"documentObjectKey" in result/);
  });

  it("keeps maintenance photos separate from guest ID scans", () => {
    assert.match(nativeCapabilities, /captureMaintenancePhoto/);
    assert.match(nativeCapabilities, /privacyReviewRequired: true/);
  });

  it("exposes chat photo, file, camera, and voice-note media capabilities", () => {
    for (const marker of [
      "pickChatPhotoAttachment",
      "captureChatCameraPhoto",
      "pickChatFileAttachment",
      "startVoiceNote",
      "stopVoiceNote",
      "voice_note",
      "READ_MEDIA_IMAGES",
      "NSPhotoLibraryUsageDescription"
    ]) {
      assert.match(nativeCapabilities + readFileSync(new URL("../apps/mobile/app.json", import.meta.url), "utf8"), new RegExp(marker));
    }
  });

  it("documents the native capability boundary", () => {
    assert.match(productSpec, /Native Capability Boundary/);
    assert.match(productSpec, /extracted fields only/);
    assert.match(productSpec, /reject `imageUri`/);
    assert.match(productSpec, /privacy review/);
    assert.match(productSpec, /Chat attachments/);
  });
});
