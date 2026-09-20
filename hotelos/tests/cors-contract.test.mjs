import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/**
 * CORS + env-boot contract (AUTH-08 / DATA-04, Tanda 4 · lote rutas-cors).
 *
 * Static, no-DB pins for the server wiring that replaced the reflected-LAN
 * CORS (any http://192.168.x.x:* origin got Access-Control-Allow-Origin AND
 * Access-Control-Allow-Credentials: true — CWE-942) and the single exact
 * PILOT_PUBLIC_ORIGIN, plus the env contract gate at the top of
 * buildApiServer. The behaviour (which Origin gets which headers, /health
 * carrying env.ok/warnings) is exercised by
 * tests/integration/api-integration.test.mts with app.inject; this file only
 * guarantees a refactor cannot bring the old callback back.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const server = read("../apps/api/src/server.ts");
const integration = read("./integration/api-integration.test.mts");

// Whole-line `//` comments are blanked (line count preserved) so a prose
// mention — e.g. this very design being documented next to the code — cannot
// satisfy or violate an assertion about code.
const code = server
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");

/** Source between two anchors of `code` (both must exist, in order). */
function between(startAnchor, endAnchor) {
  const start = code.indexOf(startAnchor);
  assert.ok(start >= 0, `${startAnchor} not found in server.ts`);
  const end = code.indexOf(endAnchor, start);
  assert.ok(end > start, `${endAnchor} not found after ${startAnchor}`);
  return code.slice(start, end);
}

const OLD_REFLECTION_REGEX = "^http:\\/\\/(localhost|127\\.0\\.0\\.1|192\\.168\\.\\d+\\.\\d+)(:\\d+)?$";

describe("AUTH-08 · CORS is an allow-list resolved by lib/env.ts (no reflected LAN, no credentials)", () => {
  it("imports the env contract and builds the decision on resolveCorsOrigins()", () => {
    assert.match(
      code,
      /import \{ assertEnv, resolveCorsOrigins, validateEnv \} from "\.\/lib\/env\.js";/,
      "server.ts must take assertEnv/resolveCorsOrigins/validateEnv from lib/env.ts (lote env-typecheck)"
    );
    const corsBlock = between("const DEV_CORS_ORIGIN", "await app.register(fastifyRateLimit");
    assert.match(corsBlock, /resolveCorsOrigins\(\)/, "the allow-list must come from resolveCorsOrigins()");
    assert.match(corsBlock, /await app\.register\(fastifyCors, \{/, "cors must still be awaited (AUTH-05)");
  });

  it("no longer reflects any http://192.168.x.x origin nor compares against PILOT_PUBLIC_ORIGIN by hand", () => {
    assert.ok(!code.includes(OLD_REFLECTION_REGEX), "the old reflection regex is back in server.ts");
    assert.doesNotMatch(code, /const allowed = process\.env\.PILOT_PUBLIC_ORIGIN;/, "PILOT_PUBLIC_ORIGIN is an alias folded in by resolveCorsOrigins, not read by the callback");
    assert.doesNotMatch(code, /origin === allowed/, "exact single-origin comparison must be gone");
  });

  it("keeps the dev fallback (localhost / 127.0.0.1 / 192.168.x.x, http or https, optional port) closed in production", () => {
    const corsBlock = between("const DEV_CORS_ORIGIN", "await app.register(fastifyRateLimit");
    assert.match(
      corsBlock,
      /const DEV_CORS_ORIGIN = \/\^https\?:\\\/\\\/\(localhost\|127\\\.0\\\.0\\\.1\|192\\\.168\\\.\\d\{1,3\}\\\.\\d\{1,3\}\)\(:\\d\{1,5\}\)\?\$\/;/,
      "DEV_CORS_ORIGIN must match http(s)://localhost|127.0.0.1|192.168.x.x with an optional port and nothing else"
    );
    // The fallback is the contract's devFallback AND-ed with NODE_ENV: even if
    // lib/env.ts ever reports devFallback=true for another reason, production
    // never opens localhost/LAN origins.
    assert.match(corsBlock, /devFallback: resolved\.devFallback && nodeEnv !== "production"/);
    assert.match(corsBlock, /if \(policy\.devFallback && DEV_CORS_ORIGIN\.test\(normalized\)\) return true;/);
    // Allow-list first, exact and case-insensitive.
    assert.match(corsBlock, /const normalized = origin\.trim\(\)\.toLowerCase\(\);\s*if \(policy\.allowed\.has\(normalized\)\) return true;/);
  });

  it("answers `true` without an Origin header and refuses everything else with a warn logged once per origin (bounded set)", () => {
    const corsBlock = between("const DEV_CORS_ORIGIN", "await app.register(fastifyRateLimit");
    assert.match(corsBlock, /origin: \(origin, cb\) => \{\s*if \(!origin\) return cb\(null, true\);\s*cb\(null, isCorsOriginAllowed\(origin\)\);\s*\}/);
    assert.match(corsBlock, /const corsRejectedOrigins = new Set<string>\(\);/);
    assert.match(corsBlock, /const MAX_LOGGED_CORS_REJECTIONS = 500;/, "the once-per-origin set must be bounded (Origin is attacker-controlled)");
    assert.match(corsBlock, /if \(!corsRejectedOrigins\.has\(normalized\) && corsRejectedOrigins\.size < MAX_LOGGED_CORS_REJECTIONS\) \{\s*corsRejectedOrigins\.add\(normalized\);\s*app\.log\.warn\(/);
    assert.match(corsBlock, /\[cors\] origen no permitido/, "the refusal must be logged in Spanish with the variable to fix");
    assert.match(corsBlock, /return false;\s*\};/, "an unknown origin resolves to false (no ACAO), never to an error");
  });

  it("sends credentials: false (Bearer auth, no cookies) and exposes the pagination/correlation/rate-limit headers", () => {
    const registration = between("await app.register(fastifyCors, {", "await app.register(fastifyRateLimit");
    assert.match(registration, /credentials: false/);
    assert.doesNotMatch(code, /credentials: true/, "Access-Control-Allow-Credentials must never be reflected again");
    assert.match(registration, /methods: \["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"\]/);
    // Tanda 8a (L1/L4): el front envía `x-property-id` (services/api-client.ts, ACTIVE_PROPERTY_HEADER) para las rutas sin
    // :propertyId; sin listarla en allowedHeaders el preflight del navegador (:5173 → :3000) rechazaría toda petición.
    // Tanda CHK (corrector REV3-04): el portal del huésped y el kiosco autentican por cabecera desde otro origen en dev.
    assert.match(registration, /allowedHeaders: \["Content-Type", "Authorization", "x-correlation-id", "x-property-id", "x-guest-token", "x-kiosk-token"\]/);
    assert.match(registration, /exposedHeaders: \["x-correlation-id", "X-Total-Count", "X-Next-Cursor", "x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"\]/);
    assert.match(registration, /maxAge: 600/);
    // The design is documented next to the code (why credentials are off and
    // under which condition they may come back).
    assert.match(server, /`credentials: false` on purpose/);
    assert.match(server, /Authorization: Bearer/);
  });

  it("re-resolves the policy only when NODE_ENV / CORS_ALLOWED_ORIGINS / PILOT_PUBLIC_ORIGIN change (testable with withEnv, cheap in steady state)", () => {
    const corsBlock = between("const DEV_CORS_ORIGIN", "await app.register(fastifyRateLimit");
    assert.match(corsBlock, /const key = `\$\{nodeEnv\}\|\$\{process\.env\.CORS_ALLOWED_ORIGINS \?\? ""\}\|\$\{process\.env\.PILOT_PUBLIC_ORIGIN \?\? ""\}`;/);
    assert.match(corsBlock, /if \(!corsPolicyCache \|\| corsPolicyCache\.key !== key\) \{\s*const resolved = resolveCorsOrigins\(\);/);
    // Boot log so ops can read the effective list (and the same-origin-only
    // situation in production) without grepping the env.
    assert.match(corsBlock, /\[cors\] sin CORS_ALLOWED_ORIGINS: solo peticiones same-origin/);
    assert.match(corsBlock, /\[cors\] política cargada/);
  });

  it("is exercised end-to-end by the integration suite (allowed / refused origins, preflight, production fallback closed)", () => {
    assert.match(integration, /access-control-allow-origin/);
    assert.match(integration, /access-control-allow-credentials/);
    assert.match(integration, /CORS_ALLOWED_ORIGINS/);
    assert.match(integration, /access-control-request-method/);
  });
});

describe("Tanda CHK (corrector SEC-6) · el token del portal del huésped no llega a los logs de peticiones", () => {
  it("Fastify se construye con un serializador de `req` que pasa la URL por redactTokenInUrl", () => {
    assert.match(code, /const app = Fastify\(\{\s*logger: \{\s*serializers: \{\s*req: \(request\) => \(\{[\s\S]*?url: redactTokenInUrl\(request\.url\)/);
    assert.doesNotMatch(code, /Fastify\(\{ logger: true \}\)/, "logger: true serializaría req.url con ?token=<64 hex> en claro");
  });

  it("redactTokenInUrl sustituye cualquier token= de la query y deja el resto de la URL", () => {
    const fn = /export function redactTokenInUrl\(url: string \| undefined\): string \| undefined \{([\s\S]*?)\n\}/.exec(code);
    assert.ok(fn, "redactTokenInUrl exportada en server.ts");
    // Se evalúa el cuerpo tal cual está en el fichero (función pura, sin imports).
    const redact = new Function("url", fn[1].replace(/^\s*if \(typeof url !== "string"\) return url;/m, 'if (typeof url !== "string") return url;'));
    assert.equal(redact("/guest-portal/check-in?token=" + "a".repeat(64) + "&property=prop_1"), "/guest-portal/check-in?token=<redacted>&property=prop_1");
    assert.equal(redact("/guest-portal/check-in?property=p&token=abc#x"), "/guest-portal/check-in?property=p&token=<redacted>#x");
    assert.equal(redact("/reservations/res_1/check-in"), "/reservations/res_1/check-in");
    assert.equal(redact(undefined), undefined);
  });
});

describe("DATA-04 · env contract gate at boot and on /health", () => {
  it("calls assertEnv() first thing in buildApiServer — before Sentry and before registerAuthContext", () => {
    const build = between("export async function buildApiServer() {", "registerAuthContext(app);");
    const assertAt = build.indexOf("assertEnv();");
    assert.ok(assertAt >= 0, "assertEnv() missing from buildApiServer");
    const sentryAt = build.indexOf("void initSentry();");
    assert.ok(sentryAt > assertAt, "assertEnv() must run before initSentry()");
    const corsAt = build.indexOf("await app.register(fastifyCors");
    assert.ok(corsAt > assertAt, "assertEnv() must run before the CORS registration (resolveCorsOrigins reads the same contract)");
    // Exactly one call: the gate is not repeated per request.
    assert.equal(code.split("assertEnv();").length - 1, 1, "assertEnv() must be called exactly once");
  });

  it("does not install process handlers or exit on its own inside buildApiServer (tests boot it with app.inject)", () => {
    // buildApiServer ends right before the module-level `import { fileURLToPath }`
    // of the entry guard (whose fail-closed tenant bootstrap does exit(1) — on
    // the listen path only, which is fine).
    const build = between("export async function buildApiServer() {", 'import { fileURLToPath } from "node:url";');
    assert.match(build, /return app;\s*\}\s*$/, "buildApiServer body not isolated (end anchor drifted)");
    assert.doesNotMatch(build, /process\.exit\(/, "buildApiServer must let assertEnv's Error propagate (start()'s top-level await exits 1)");
    assert.doesNotMatch(build, /process\.on\("unhandledRejection"|process\.on\("uncaughtException"/);
  });

  it("exposes env: { ok, warnings } on GET /health (counts only, inside checks and at the top level)", () => {
    const health = between('app.get("/health"', 'app.get("/metrics"');
    assert.match(health, /warnings\?: number;/, "SubCheck must carry the warnings count");
    assert.match(health, /const envReport = validateEnv\(process\.env, \{ production: process\.env\.NODE_ENV === "production" \}\);/);
    assert.match(health, /const envCheck = \{ ok: envReport\.errors\.length === 0, warnings: envReport\.warnings\.length \};/);
    assert.match(health, /checks\.env = \{\s*\.\.\.envCheck,/);
    assert.match(health, /env: envCheck,/, "top-level `env` (contract C) must be the same object as checks.env");
    // Never the messages: /health is public and they name variables + formats.
    assert.doesNotMatch(health, /envReport\.errors\b(?!\.length)/, "error texts must not be returned by /health");
    assert.doesNotMatch(health, /envReport\.warnings\b(?!\.length)/, "warning texts must not be returned by /health");
    assert.match(health, /const allOk = Object\.values\(checks\)\.every\(\(check\) => check\.ok\);/, "checks.env.ok must take part in status healthy/degraded");
  });
});
