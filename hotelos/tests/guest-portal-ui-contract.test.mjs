import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

// Sprint 37b rewrote the guest portal into a focused self-service app
// (sign-in -> stay overview -> pre-check-in / service request) and Sprint 45
// wired magic-link token auto-detection. This contract validates that
// current architecture (the pre-Sprint-37b scaffold was removed).

const guestPackageJson = JSON.parse(
  readFileSync(new URL("../apps/guest-web/package.json", import.meta.url), "utf8")
);
const guestApp = readFileSync(new URL("../apps/guest-web/src/App.tsx", import.meta.url), "utf8");
const guestStyles = readFileSync(new URL("../apps/guest-web/src/styles.css", import.meta.url), "utf8");
const apiClient = readFileSync(new URL("../apps/guest-web/src/api/client.ts", import.meta.url), "utf8");
const sessionCtx = readFileSync(
  new URL("../apps/guest-web/src/auth/GuestSessionContext.tsx", import.meta.url),
  "utf8"
);

const PAGE = (name) => new URL(`../apps/guest-web/src/pages/${name}`, import.meta.url);

describe("Guest Portal UI layer", () => {
  it("is a standalone guest-web workspace app", () => {
    assert.equal(guestPackageJson.name, "@hotelos/guest-web");
    assert.equal(existsSync(new URL("../apps/guest-web/src/main.tsx", import.meta.url)), true);
    assert.equal(existsSync(new URL("../apps/guest-web/src/auth/GuestSessionContext.tsx", import.meta.url)), true);
  });

  it("implements the four guest self-service pages", () => {
    for (const page of [
      "SignInPage.tsx",
      "StayOverviewPage.tsx",
      "PreCheckInPage.tsx",
      "ServiceRequestPage.tsx"
    ]) {
      assert.equal(existsSync(PAGE(page)), true, `${page} should exist`);
    }
  });

  it("uses the warm guest-facing design tokens (not the admin Aurora)", () => {
    // Sprint 37b cream + gold palette
    assert.match(guestStyles, /#fdfbf7/i);
    assert.match(guestStyles, /#b08a3e/i);
  });

  it("calls the real guest-portal API with stub fallback", () => {
    assert.match(apiClient, /\/guest-portal\/sign-in/);
    assert.match(apiClient, /\/guest-portal\/reservation/);
    assert.match(apiClient, /\/guest-portal\/pre-check-in/);
    assert.match(apiClient, /\/guest-portal\/service-request/);
    // honours the env base + falls back to stubs offline
    assert.match(apiClient, /VITE_GUEST_API_BASE/);
  });

  it("auto-detects the magic-link token on load (Sprint 45)", () => {
    assert.match(guestApp + apiClient, /token/);
    assert.match(guestApp, /replaceState|URLSearchParams|location\.search/);
  });

  it("persists the guest session across reloads", () => {
    assert.match(sessionCtx, /localStorage/);
  });

  it("keeps the legal data-retention disclosure visible", () => {
    const preCheckIn = readFileSync(PAGE("PreCheckInPage.tsx"), "utf8");
    assert.match(preCheckIn, /933\/2021|retention|retención/i);
  });
});
