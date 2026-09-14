import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Rate-limit wiring contract (AUTH-05, audit 2026-09-14).
 *
 * Static, no-DB regression guard for the root cause found in the audit:
 * @fastify/rate-limit attaches its limiter per route through an `onRoute`
 * hook, so the plugin must have LOADED before the first inline route is
 * declared. `app.register(...)` without `await` inside a sync builder defers
 * the plugin body to app.ready()/listen() — after every route exists — and
 * silently leaves the whole API unlimited (no 429, no x-ratelimit-* headers).
 *
 * The behavioural check (11th login → 429, /health carries the headers) lives
 * in tests/integration/api-integration.test.mts; this file only pins the
 * structure so a refactor cannot reintroduce the lazy registration.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const server = read("../apps/api/src/server.ts");
const integration = read("./integration/api-integration.test.mts");

// Whole-line `//` comments are blanked so a commented-out register or a
// prose mention of the pattern does not satisfy the assertions.
const code = server
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");

describe("AUTH-05 · rate limit is registered before the first inline route", () => {
  it("buildApiServer is async and awaits cors + rate-limit", () => {
    assert.match(code, /export async function buildApiServer\(\)/, "buildApiServer must be async");
    assert.match(code, /await app\.register\(fastifyCors/, "cors must be awaited");
    assert.match(code, /await app\.register\(fastifyRateLimit/, "rate-limit must be awaited");
    assert.doesNotMatch(code, /(^|[^t]\s)app\.register\(fastifyRateLimit/m, "rate-limit must not be registered without await");
  });

  it("the awaited rate-limit registration precedes the first inline route", () => {
    const rateLimitAt = code.indexOf("await app.register(fastifyRateLimit");
    const firstRouteAt = code.search(/app\.(get|post|patch|put|delete)\(\s*["'`]/);
    assert.ok(rateLimitAt >= 0, "rate-limit registration not found");
    assert.ok(firstRouteAt >= 0, "no inline route found");
    assert.ok(rateLimitAt < firstRouteAt, `rate-limit (${rateLimitAt}) must come before the first route (${firstRouteAt})`);
  });

  it("keyGenerator buckets authenticated users by id and public traffic by IP", () => {
    const start = code.indexOf("keyGenerator:");
    assert.ok(start >= 0, "keyGenerator missing");
    const body = code.slice(start, start + 1500);
    assert.match(body, /userContext/, "keyGenerator must key authenticated requests by user");
    assert.match(body, /req\.ip/, "keyGenerator must fall back to the client IP");
  });

  it("the global limiter keeps its baseline and login keeps its hard limit", () => {
    const registration = code.slice(code.indexOf("await app.register(fastifyRateLimit"));
    assert.match(registration.slice(0, 600), /global:\s*true/);
    assert.match(registration.slice(0, 600), /max:\s*Number\(process\.env\.RATE_LIMIT_MAX \?\? 600\)/);
    assert.match(code, /app\.post\("\/auth\/login",\s*\{\s*config:\s*\{\s*rateLimit:\s*\{\s*max:\s*10/);
  });

  it("every caller awaits buildApiServer (start() and the integration suite)", () => {
    assert.match(code, /const app = await buildApiServer\(\);/, "start() must await buildApiServer");
    assert.doesNotMatch(code, /const app = buildApiServer\(\);/, "sync call to buildApiServer left in server.ts");
    assert.match(integration, /await buildApiServer\(\)/, "integration tests must await buildApiServer");
    assert.doesNotMatch(integration, /assert\.throws\(\(\) => buildApiServer\(\)/, "boot-policy test must use assert.rejects");
    assert.match(integration, /assert\.rejects\(\(\) => buildApiServer\(\)/);
  });
});
