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

  it("stores sessions, devices, MFA challenges, notifications, users, and properties in shared state", () => {
    const store = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
    for (const key of ["sessions", "devices", "mfaChallenges", "notifications", "users", "properties"]) {
      assert.match(store, new RegExp(key));
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
