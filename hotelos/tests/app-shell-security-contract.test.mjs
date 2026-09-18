import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("App shell and security contract", () => {
  it("exposes auth, device, MFA, property, notification, and settings routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    for (const route of [
      "/auth/login",
      "/auth/register-device",
      "/auth/sessions",
      "/auth/sessions/:id/revoke",
      "/auth/mfa/challenge",
      "/auth/mfa/verify",
      "/users/me/properties",
      "/properties",
      "/notifications",
      "/notifications/:id/read",
      "/settings/security"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });

  it("persists sessions, devices, MFA challenges and notifications in Prisma; users and properties stay as hydrated demo mirrors", () => {
    // Tanda L2 (L2-08): the in-memory demoStore legs (sessions, devices,
    // mfaChallenges, notifications) were retired — auth.service reads and
    // writes the Prisma models directly; the demo store only keeps the mirrors
    // hydrated at boot (users, properties).
    const service = readFileSync(new URL("../apps/api/src/modules/auth/auth.service.ts", import.meta.url), "utf8");
    for (const delegate of ["prisma.session", "prisma.device", "prisma.mfaChallenge", "prisma.notification"]) {
      assert.match(service, new RegExp(delegate.replace(".", "\\.") + "\\."), `${delegate} must be read/written by auth.service.ts`);
    }
    const store = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
    for (const key of ["users", "properties"]) {
      assert.match(store, new RegExp(`\\n  ${key}: `));
    }
    for (const retired of ["sessions", "devices", "mfaChallenges", "notifications"]) {
      assert.doesNotMatch(store, new RegExp(`\\n  ${retired}: `), `demoStore.${retired} was retired in L2-08`);
    }
  });

  it("keeps app-shell security tables in the database schema", () => {
    const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
    for (const table of ["devices", "sessions", "mfa_challenges", "notifications"]) {
      assert.match(schema, new RegExp(`@@map\\("${table}"\\)`));
    }
  });

  it("audits login, device registration, session revocation, and MFA verification", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/auth/auth.service.ts", import.meta.url), "utf8");
    for (const action of ["AUTH_LOGIN", "DEVICE_REGISTERED", "SESSION_REVOKED", "MFA_CHALLENGE_CREATED", "MFA_CHALLENGE_VERIFIED"]) {
      assert.match(service, new RegExp(action));
    }
  });

  it("includes the required app shell screens in mobile navigation", () => {
    const app = readFileSync(new URL("../apps/mobile/App.tsx", import.meta.url), "utf8");
    for (const screen of [
      "LoginScreen",
      "PropertySelectorScreen",
      "NotificationsScreen",
      "SettingsScreen",
      "DashboardScreen",
      "AICommandCenterScreen"
    ]) {
      assert.match(app, new RegExp(screen));
    }
  });
});
