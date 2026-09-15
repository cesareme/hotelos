// Contract test (Tanda 3 · CF-05): every HTTP call from the admin-web screens
// and services must go through `apiRequest` in services/api-client.ts so it
// carries the session JWT, the tenant context and the shared 401 handling.
//
// Allowed exceptions (public, unauthenticated endpoints):
//   - services/api-client.ts itself (owns the single `fetch` wrapper + demo login)
//   - screens/auth/* (login, forgot/reset password, accept-invite — no session yet)
//
// Any other `fetch(` (also `window.fetch(` / `globalThis.fetch(`) in
// apps/admin-web/src/screens or apps/admin-web/src/services fails this test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const adminWebSrc = fileURLToPath(new URL("../apps/admin-web/src/", import.meta.url));
const SCANNED_DIRS = ["screens", "services"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Matches a bare `fetch(`, `window.fetch(` or `globalThis.fetch(` call. The
// leading `\b` keeps identifiers such as `refetch(` or `prefetch(` out.
const RAW_FETCH = /\b(?:window\.|globalThis\.)?fetch\s*\(/;

function isAllowed(relPath) {
  const posix = relPath.split(sep).join("/");
  return posix === "services/api-client.ts" || posix.startsWith("screens/auth/");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
      continue;
    }
    const dot = entry.lastIndexOf(".");
    if (dot >= 0 && SOURCE_EXTENSIONS.has(entry.slice(dot))) out.push(full);
  }
  return out;
}

function findRawFetchLines(source) {
  const hits = [];
  source.split("\n").forEach((line, index) => {
    if (RAW_FETCH.test(line)) hits.push(`${index + 1}: ${line.trim()}`);
  });
  return hits;
}

describe("admin-web HTTP calls go through api-client", () => {
  const files = SCANNED_DIRS.flatMap((dir) => walk(join(adminWebSrc, dir)));

  it("scans a non-trivial set of screen and service files", () => {
    assert.ok(files.length > 50, `expected to scan >50 files, scanned ${files.length}`);
  });

  it("keeps the fetch wrapper in services/api-client.ts", () => {
    const apiClient = readFileSync(join(adminWebSrc, "services", "api-client.ts"), "utf8");
    assert.match(apiClient, /export async function apiRequest</);
    assert.match(apiClient, RAW_FETCH);
  });

  it("has no raw fetch( outside api-client.ts and screens/auth/*", () => {
    const offenders = [];
    for (const file of files) {
      const rel = relative(adminWebSrc, file);
      if (isAllowed(rel)) continue;
      const hits = findRawFetchLines(readFileSync(file, "utf8"));
      if (hits.length > 0) offenders.push(`${rel.split(sep).join("/")}\n    ${hits.join("\n    ")}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `Raw fetch( found — use apiRequest from services/api-client.ts instead:\n  ${offenders.join("\n  ")}`
    );
  });

  it("does not let the migrated CF-05 files reintroduce a local API base", () => {
    for (const rel of [
      "services/backofficeApi.ts",
      "screens/operations/FrontDeskActionQueue.tsx",
      "screens/operations/HousekeepingMobileScreen.tsx",
      "screens/operations/NightAuditScreen.tsx"
    ]) {
      const source = readFileSync(join(adminWebSrc, rel), "utf8");
      assert.doesNotMatch(source, /VITE_API_URL/, `${rel} must not read VITE_API_URL directly`);
      assert.match(source, /from "(\.\.\/)*(\.\/)?(services\/)?api-client"/, `${rel} must import api-client`);
    }
  });
});
