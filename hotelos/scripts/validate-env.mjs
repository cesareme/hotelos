import { readFileSync } from "node:fs";

/**
 * Environment contract check (CI job `validate-env`, `pnpm validate:env`).
 *
 *   node scripts/validate-env.mjs [path] [--production]
 *
 * 1. Presence — the variables required for the file's role are declared:
 *    - app role (default; `.env.example`, a local `.env`): the app variables
 *      listed in APP_REQUIRED.
 *    - production role (`--production`, a path containing "production", or
 *      NODE_ENV=production inside the file): the values the production compose
 *      cannot default (PRODUCTION_REQUIRED); everything else is assembled or
 *      defaulted by deploy/docker-compose.production.yml. For a real (non
 *      `.example`) production file those values must also be non-empty.
 * 2. Security policy (audit 2026-09-13 · AUTH-03 / AUTH-04):
 *    - boolean flags, when present, must be exactly "true" or "false";
 *    - production + HOTELOS_ALLOW_DEMO_AUTH=true fails — the API refuses to
 *      boot with it (apps/api/src/lib/auth-context.ts) — unless
 *      HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true, which is accepted with a
 *      loud warning (public demo box with no real tenant data only);
 *    - production + RBAC_STRICT=false fails: strict RBAC is the production
 *      default and "false" re-opens the fail-open GET routes;
 *    - production + AUTH_EXPOSE_RESET_TOKEN=true fails (test-only flag).
 */

const APP_REQUIRED = [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "ENCRYPTION_KEY",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ACCESS_KEY",
  "OBJECT_STORAGE_SECRET_KEY",
  "AI_PROVIDER_API_KEY",
  "OCR_PROVIDER_API_KEY",
  "SPEECH_PROVIDER_API_KEY",
  "PAYMENT_PROVIDER_SECRET",
  "WHATSAPP_PROVIDER_TOKEN",
  "EMAIL_PROVIDER_KEY",
  "SES_HOSPEDAJES_CLIENT_ID",
  "SES_HOSPEDAJES_CLIENT_SECRET",
  "APP_PUBLIC_API_URL",
  "SENTRY_DSN"
];

// REQUIRED (no default) in deploy/docker-compose.production.yml.
const PRODUCTION_REQUIRED = ["DOMAIN", "PUBLIC_API_URL", "POSTGRES_PASSWORD", "JWT_SECRET", "ENCRYPTION_KEY"];

const BOOLEAN_FLAGS = [
  "HOTELOS_ALLOW_DEMO_AUTH",
  "HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE",
  "RBAC_STRICT",
  "AUTH_EXPOSE_RESET_TOKEN"
];

const args = process.argv.slice(2);
const forceProduction = args.includes("--production");
const envPath = args.find((arg) => !arg.startsWith("--")) ?? ".env.example";

function parseEnvFile(content) {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

const values = parseEnvFile(readFileSync(envPath, "utf8"));
const isExample = envPath.endsWith(".example");
const isProduction = forceProduction || /production/i.test(envPath) || values.get("NODE_ENV") === "production";
const role = isProduction ? "production" : "app";
const errors = [];
const warnings = [];

// 1. Presence.
const required = isProduction ? PRODUCTION_REQUIRED : APP_REQUIRED;
const missing = required.filter((key) => !values.has(key));
if (missing.length > 0) {
  errors.push(`Missing required variables (${role} role): ${missing.join(", ")}`);
}
if (isProduction && !isExample) {
  const empty = required.filter((key) => values.has(key) && values.get(key) === "");
  if (empty.length > 0) {
    errors.push(`Required variables are empty: ${empty.join(", ")}`);
  }
}

// 2. Boolean flag domain.
for (const flag of BOOLEAN_FLAGS) {
  if (values.has(flag) && !["true", "false"].includes(values.get(flag))) {
    errors.push(`${flag} must be exactly "true" or "false" (got "${values.get(flag)}")`);
  }
}

// 3. Production security policy.
if (isProduction) {
  if (values.get("HOTELOS_ALLOW_DEMO_AUTH") === "true") {
    if (values.get("HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE") === "true") {
      warnings.push(
        "DANGER: HOTELOS_ALLOW_DEMO_AUTH=true in production with HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true — " +
          "every request without a token receives the demo super-user. Acceptable only on a public demo box " +
          "with no real tenant data."
      );
    } else {
      errors.push(
        "HOTELOS_ALLOW_DEMO_AUTH=true is forbidden in production: the API refuses to boot with it " +
          "(apps/api/src/lib/auth-context.ts, AUTH-04). Remove it. Only a public demo with no real data may " +
          "force it with HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true."
      );
    }
  }
  if (values.get("RBAC_STRICT") === "false") {
    errors.push(
      "RBAC_STRICT=false is not allowed in production: it re-opens GET routes missing from the permission " +
        "manifest (AUTH-03). Remove the line (strict is the production default) or set RBAC_STRICT=true."
    );
  }
  if (values.get("AUTH_EXPOSE_RESET_TOKEN") === "true") {
    errors.push("AUTH_EXPOSE_RESET_TOKEN=true returns password-reset tokens over HTTP; test-only flag, remove it from production.");
  }
}

for (const warning of warnings) {
  console.warn(`WARNING: ${warning}`);
}
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`ERROR: ${error}`);
  }
  console.error(`Environment contract FAILED for ${envPath} (${role} role): ${errors.length} error(s).`);
  process.exit(1);
}

console.log(`Environment contract ok: ${required.length} required variables present in ${envPath} (${role} role).`);
