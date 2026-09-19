// Unit tests for the environment contract (Tanda 4 · DATA-04 / AUTH-08).
// Run: cd apps/api && node --import tsx --test src/lib/__tests__/env.test.mts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  __resetEnvReportForTests,
  ENV_CONTRACT,
  assertEnv,
  evaluateWhen,
  normalizeOrigin,
  resolveCorsOrigins,
  validateEnv
} from "../env.js";
// Lista viva de variables retiradas (JS sin tipos: el test no pasa por tsc).
// @ts-expect-error módulo JS sin declaración de tipos
import { RETIRED_KEYS } from "../../../../../scripts/validate-env.mjs";

const VALID_KEY = Buffer.alloc(32, 9).toString("base64");
const PROD_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://hotelos:secret@db:5432/hotelos",
  JWT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  ENCRYPTION_KEY: VALID_KEY,
  APP_BASE_URL: "https://app.example.com",
  TRUST_PROXY: "1"
};
const DEV_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://hotelos:hotelos@localhost:5432/hotelos",
  JWT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef"
};

const prod = (extra: NodeJS.ProcessEnv = {}) => validateEnv({ ...PROD_BASE, ...extra }, { production: true });
const dev = (extra: NodeJS.ProcessEnv = {}) => validateEnv({ ...DEV_BASE, ...extra }, { production: false });
const joined = (list: string[]) => list.join("\n");

describe("ENV_CONTRACT shape", () => {
  it("documents every variable with a section, a format and Spanish user-facing docs", () => {
    for (const [name, spec] of Object.entries(ENV_CONTRACT)) {
      assert.ok(spec.section, `${name} sin sección`);
      assert.ok(spec.format, `${name} sin formato`);
      assert.ok(spec.doc.length > 10, `${name} sin doc`);
      if (spec.format === "enum") assert.ok(spec.values && spec.values.length > 0, `${name} enum sin values`);
      if (spec.default !== undefined && spec.format === "enum") assert.ok(spec.values!.includes(spec.default), `${name} default fuera del enum`);
    }
  });

  it("evaluates the `when` grammar against effective values (defaults included)", () => {
    assert.equal(evaluateWhen("VERIFACTU_MODE!=sandbox", {}), false, "unset → default sandbox");
    assert.equal(evaluateWhen("VERIFACTU_MODE!=sandbox", { VERIFACTU_MODE: "preproduction" }), true);
    assert.equal(evaluateWhen("TBAI_MODE=production", { TBAI_MODE: "production" }), true);
    assert.equal(evaluateWhen("EMAIL_PROVIDER", { EMAIL_PROVIDER: "change-me" }), false, "placeholder counts as absent");
    assert.equal(evaluateWhen("EMAIL_PROVIDER", { EMAIL_PROVIDER: "postmark" }), true);
    assert.equal(evaluateWhen("VERIFACTU_MODE!=sandbox && !VERIFACTU_CERT_PATH", { VERIFACTU_MODE: "production", VERIFACTU_CERT_PATH: "/x.pem" }), false);
    assert.equal(evaluateWhen("AI_PROVIDER!=none", {}), false);
  });
});

describe("validateEnv · production policy", () => {
  it("accepts a minimal valid production environment", () => {
    const report = prod();
    assert.deepEqual(report.errors, []);
  });

  it("requires DATABASE_URL and JWT_SECRET (≥32 chars, not change-me) everywhere", () => {
    assert.match(joined(prod({ DATABASE_URL: undefined }).errors), /Falta DATABASE_URL \(obligatoria\)/);
    assert.match(joined(prod({ DATABASE_URL: "mysql://x" }).errors), /DATABASE_URL debe empezar por postgresql:\/\//);
    assert.match(joined(prod({ JWT_SECRET: "change-me" }).errors), /Falta JWT_SECRET .*placeholder.*openssl rand -base64 48/);
    assert.match(joined(prod({ JWT_SECRET: "short" }).errors), /JWT_SECRET debe tener al menos 32 caracteres/);
    assert.match(joined(dev({ JWT_SECRET: undefined }).errors), /Falta JWT_SECRET/, "required always → error in dev too");
  });

  it("requires a 32-byte base64 encryption key in production, accepts HOTELOS_FIELD_KEY instead, only warns in dev", () => {
    assert.match(joined(prod({ ENCRYPTION_KEY: undefined }).errors), /Falta ENCRYPTION_KEY \(obligatoria con NODE_ENV=production\)/);
    assert.match(joined(prod({ ENCRYPTION_KEY: "ci-encryption-key-32-chars-min-aaaa" }).errors), /ENCRYPTION_KEY debe ser base64 que decodifique a exactamente 32 bytes/);
    assert.deepEqual(prod({ ENCRYPTION_KEY: undefined, HOTELOS_FIELD_KEY: VALID_KEY }).errors, []);
    const report = dev();
    assert.deepEqual(report.errors, []);
    assert.match(joined(report.warnings), /PII de huéspedes se guarda EN CLARO/);
  });

  it("rejects NODE_ENV values the code does not understand", () => {
    const report = validateEnv({ ...PROD_BASE, NODE_ENV: "prod" }, { production: false });
    assert.match(joined(report.errors), /NODE_ENV debe ser uno de: development \| test \| production/);
    assert.match(joined(report.errors), /RBAC estricto/);
  });

  it("forbids the demo auth flag in production unless the unsafe override is set (then a loud warning)", () => {
    const refused = prod({ HOTELOS_ALLOW_DEMO_AUTH: "true" });
    assert.match(joined(refused.errors), /HOTELOS_ALLOW_DEMO_AUTH no puede estar activo en producción/);
    const overridden = prod({ HOTELOS_ALLOW_DEMO_AUTH: "true", HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE: "true" });
    assert.deepEqual(overridden.errors, []);
    assert.match(joined(overridden.warnings), /PELIGRO/);
    assert.deepEqual(dev({ HOTELOS_ALLOW_DEMO_AUTH: "true" }).errors, [], "allowed in development");
  });

  it("forbids RBAC_STRICT=false and the test-only flags in production, tolerates them in development", () => {
    const flags = { RBAC_STRICT: "false", AUTH_EXPOSE_RESET_TOKEN: "true", ADMIN_EXPOSE_TEMP_PASSWORD: "true", TENANT_BOOTSTRAP_SKIP: "true", GUEST_PORTAL_RETURN_TOKEN: "true" };
    const errors = joined(prod(flags).errors);
    for (const name of Object.keys(flags)) assert.match(errors, new RegExp(`${name}=(true|false) está prohibido en producción`));
    assert.deepEqual(dev(flags).errors, []);
  });

  it("validates booleans strictly (true|false only) and integer ranges", () => {
    assert.match(joined(prod({ RUN_SCHEDULERS: "1" }).errors), /RUN_SCHEDULERS debe ser exactamente "true" o "false"/);
    assert.match(joined(prod({ RATE_LIMIT_MAX: "abc" }).errors), /RATE_LIMIT_MAX debe ser un entero/);
    assert.match(joined(prod({ RATE_LIMIT_MAX: "0" }).errors), /RATE_LIMIT_MAX debe ser ≥ 1/);
    assert.match(joined(prod({ SES_SCHEDULER_INTERVAL_MS: "5000" }).errors), /SES_SCHEDULER_INTERVAL_MS debe ser ≥ 10000/);
    assert.match(joined(prod({ VERIFACTU_MAX_ATTEMPTS: "500" }).errors), /VERIFACTU_MAX_ATTEMPTS debe ser ≤ 100/);
    assert.deepEqual(prod({ RATE_LIMIT_MAX: "1200", MAILBOX_POLL_INTERVAL_MS: "60000" }).errors, []);
  });

  it("flags blank values whose readers would keep the empty string (PORT= → port 0, interval 0)", () => {
    const report = prod({ PORT: "", SES_SCHEDULER_INTERVAL_MS: "", GUEST_WEB_BASE_URL: "", SENTRY_DSN: "", EMAIL_PROVIDER: "" });
    const errors = joined(report.errors);
    assert.match(errors, /PORT está definida pero vacía/);
    assert.match(errors, /SES_SCHEDULER_INTERVAL_MS está definida pero vacía/);
    assert.match(errors, /GUEST_WEB_BASE_URL está definida pero vacía/);
    assert.doesNotMatch(errors, /SENTRY_DSN/, "readers of SENTRY_DSN handle ''");
    assert.doesNotMatch(errors, /EMAIL_PROVIDER/, "EMAIL_PROVIDER='' means simulated/disabled by design");
  });

  it("warns about TRUST_PROXY≠1, missing Sentry/CORS/email and the dev wallet team id in production", () => {
    const report = prod({ TRUST_PROXY: "0" });
    const warnings = joined(report.warnings);
    assert.match(warnings, /TRUST_PROXY=0: en producción se espera 1/);
    assert.match(warnings, /SENTRY_DSN vacío/);
    assert.match(warnings, /Sin CORS_ALLOWED_ORIGINS/);
    assert.match(warnings, /invitaciones y el reset de contraseña quedan en modo 'disabled'/);
    assert.match(warnings, /APPLE_WALLET_TEAM_ID sigue con el valor de desarrollo/);
    assert.deepEqual(report.errors, []);
  });

  it("treats placeholder values as absent and warns about them", () => {
    const report = prod({ AI_PROVIDER_API_KEY: "change-me", SES_HOSPEDAJES_CLIENT_ID: "your-key-here" });
    assert.deepEqual(report.errors, []);
    assert.match(joined(report.warnings), /AI_PROVIDER_API_KEY tiene un valor de ejemplo \("change-me"\)/);
  });
});

describe("validateEnv · URLs, CORS and email", () => {
  it("requires APP_BASE_URL in production as an https origin without trailing slash or path", () => {
    assert.match(joined(prod({ APP_BASE_URL: undefined }).errors), /Falta APP_BASE_URL \(obligatoria con NODE_ENV=production\)/);
    assert.match(joined(prod({ APP_BASE_URL: "http://app.example.com" }).errors), /APP_BASE_URL debe ser https en producción/);
    assert.match(joined(prod({ APP_BASE_URL: "https://app.example.com/" }).errors), /APP_BASE_URL no debe terminar en barra/);
    assert.match(joined(prod({ APP_BASE_URL: "https://app.example.com/admin" }).errors), /APP_BASE_URL debe ser solo un origen/);
    assert.match(joined(prod({ APP_BASE_URL: "not a url" }).errors), /APP_BASE_URL debe ser una URL válida/);
    assert.match(joined(dev({ APP_BASE_URL: undefined }).warnings), /Falta APP_BASE_URL/, "advisory outside production");
    assert.deepEqual(dev({ APP_BASE_URL: "http://localhost:5173" }).errors, []);
  });

  it("validates CORS_ALLOWED_ORIGINS entries and flags PILOT_PUBLIC_ORIGIN as deprecated", () => {
    assert.match(joined(prod({ CORS_ALLOWED_ORIGINS: "https://a.example.com, ftp://x" }).errors), /CORS_ALLOWED_ORIGINS debe ser una lista/);
    assert.match(joined(prod({ CORS_ALLOWED_ORIGINS: "https://a.example.com/app" }).errors), /CORS_ALLOWED_ORIGINS/);
    const ok = prod({ CORS_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com:8443", PILOT_PUBLIC_ORIGIN: "https://old.example.com" });
    assert.deepEqual(ok.errors, []);
    assert.match(joined(ok.warnings), /PILOT_PUBLIC_ORIGIN está obsoleta/);
  });

  it("requires the email trio together and validates the provider enum", () => {
    const partial = prod({ EMAIL_PROVIDER: "postmark" });
    assert.match(joined(partial.errors), /Falta EMAIL_PROVIDER_KEY \(obligatoria cuando EMAIL_PROVIDER\)/);
    assert.match(joined(partial.errors), /Falta EMAIL_FROM/);
    assert.match(joined(prod({ EMAIL_PROVIDER: "mailgun", EMAIL_PROVIDER_KEY: "k", EMAIL_FROM: "a@b.co" }).errors), /EMAIL_PROVIDER debe ser uno de: postmark \| sendgrid/);
    assert.match(joined(prod({ EMAIL_PROVIDER_KEY: "k" }).errors), /EMAIL_PROVIDER_KEY\/EMAIL_FROM sin EMAIL_PROVIDER/);
    assert.match(joined(prod({ EMAIL_PROVIDER: "sendgrid", EMAIL_PROVIDER_KEY: "k", EMAIL_FROM: "not-an-email" }).errors), /EMAIL_FROM no tiene el formato esperado/);
    assert.deepEqual(prod({ EMAIL_PROVIDER: "sendgrid", EMAIL_PROVIDER_KEY: "SG.x", EMAIL_FROM: "no-reply@hotel.es" }).errors, []);
  });

  it("warns when an AI key is set without a provider", () => {
    assert.match(joined(prod({ AI_PROVIDER_API_KEY: "sk-real" }).warnings), /AI_PROVIDER_API_KEY está definida pero AI_PROVIDER=none/);
    assert.match(joined(prod({ AI_PROVIDER: "anthropic" }).errors), /Falta AI_PROVIDER_API_KEY \(obligatoria cuando AI_PROVIDER!=none\)/);
  });

  it("requires the USD→EUR rate with anthropic and bounds the AI limits (Tanda L6a)", () => {
    assert.match(joined(prod({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-real" }).errors), /Falta AI_USD_EUR_RATE \(obligatoria cuando AI_PROVIDER=anthropic\)/);
    assert.deepEqual(prod({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-real", AI_USD_EUR_RATE: "0.92" }).errors, []);
    assert.deepEqual(prod({ AI_PROVIDER: "none" }).errors, [], "sin proveedor el tipo de cambio es opcional");
    // Corrección L6a (WT-02): formato decimal con punto; la coma y el texto se rechazan en vez de degradar en silencio.
    assert.match(joined(prod({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-real", AI_USD_EUR_RATE: "0,92" }).errors), /AI_USD_EUR_RATE debe ser un número con punto decimal/);
    assert.match(joined(prod({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-real", AI_USD_EUR_RATE: "0" }).errors), /AI_USD_EUR_RATE debe ser ≥ 0.01/);
    assert.match(joined(prod({ AI_MONTHLY_BUDGET_EUR_DEFAULT: "abc" }).errors), /AI_MONTHLY_BUDGET_EUR_DEFAULT debe ser un número con punto decimal/);
    assert.deepEqual(prod({ AI_MONTHLY_BUDGET_EUR_DEFAULT: "12.5" }).errors, []);
    assert.equal(ENV_CONTRACT.AI_USD_EUR_RATE!.format, "decimal");
    assert.equal(ENV_CONTRACT.AI_MONTHLY_BUDGET_EUR_DEFAULT!.format, "decimal");
    // Corrección L6a (WT-03): openai se admite por compatibilidad pero avisa (el runtime lo trata como none).
    assert.match(joined(prod({ AI_PROVIDER: "openai", AI_PROVIDER_API_KEY: "sk-real" }).warnings), /AI_PROVIDER=openai está retirado/);
    assert.match(joined(prod({ AI_RATE_LIMIT_PER_MINUTE: "0" }).errors), /AI_RATE_LIMIT_PER_MINUTE debe ser ≥ 1/);
    assert.match(joined(prod({ AI_RATE_LIMIT_PER_MINUTE: "20000" }).errors), /AI_RATE_LIMIT_PER_MINUTE debe ser ≤ 10000/);
    assert.match(joined(prod({ AI_DOCUMENT_TIMEOUT_MS: "500" }).errors), /AI_DOCUMENT_TIMEOUT_MS debe ser ≥ 1000/);
    assert.match(joined(prod({ AI_DOCUMENT_TIMEOUT_MS: "900000" }).errors), /AI_DOCUMENT_TIMEOUT_MS debe ser ≤ 600000/);
    assert.equal(ENV_CONTRACT.AI_MODEL_CLASSIFY!.default, "claude-haiku-4-5-20251001");
    assert.equal(ENV_CONTRACT.AI_MODEL_INSIGHTS!.default, "claude-opus-5");
    // Las cinco variables del gateway retirado (Tanda L6a) viven en RETIRED_KEYS de
    // scripts/validate-env.mjs (única lista) y no deben volver al contrato.
    const retiredInL6a = RETIRED_KEYS.filter((name: string) => name.startsWith("AI_") || name.endsWith("_PROVIDER_API_KEY") || name === "API_BASE_URL");
    assert.equal(retiredInL6a.length, 5, retiredInL6a.join(","));
    for (const retired of RETIRED_KEYS) {
      assert.equal(retired in ENV_CONTRACT, false, `${retired} retirada y no debe volver al contrato`);
    }
  });
});

describe("validateEnv · fiscal modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "anfitorio-env-test-"));
  const certPath = join(dir, "cert.p12");
  writeFileSync(certPath, Buffer.from([0x30, 0x82, 0x01, 0x00]));
  const software = {
    VERIFACTU_SOFTWARE_NAME: "Anfitorio Software SL",
    VERIFACTU_SOFTWARE_NIF: "B12345674",
    VERIFACTU_INSTALL_NUMBER: "INST-0001"
  };

  it("VeriFactu outside sandbox needs the SistemaInformatico block and an mTLS certificate (errors in production, warnings in dev)", () => {
    const missing = prod({ VERIFACTU_MODE: "preproduction" });
    const errors = joined(missing.errors);
    assert.match(errors, /Falta VERIFACTU_SOFTWARE_NAME \(obligatoria cuando VERIFACTU_MODE!=sandbox\)/);
    assert.match(errors, /Falta VERIFACTU_SOFTWARE_NIF/);
    assert.match(errors, /Falta VERIFACTU_INSTALL_NUMBER/);
    assert.match(errors, /Falta VERIFACTU_CERT_P12/);
    assert.match(errors, /falta el certificado mTLS/);
    const devReport = dev({ VERIFACTU_MODE: "preproduction" });
    assert.match(joined(devReport.warnings), /falta el certificado mTLS/);
    assert.match(joined(devReport.errors), /Falta VERIFACTU_SOFTWARE_NIF/, "conditional requirements are errors everywhere");
  });

  it("VeriFactu validates the NIF checksum and accepts a complete configuration", () => {
    assert.match(joined(prod({ VERIFACTU_MODE: "production", ...software, VERIFACTU_SOFTWARE_NIF: "B12345670", VERIFACTU_CERT_P12: certPath, VERIFACTU_CERT_P12_PASSPHRASE: "x" }).errors), /VERIFACTU_SOFTWARE_NIF no es un NIF\/CIF español válido/);
    const ok = prod({ VERIFACTU_MODE: "production", ...software, VERIFACTU_CERT_P12: certPath, VERIFACTU_CERT_P12_PASSPHRASE: "x" });
    assert.deepEqual(ok.errors, []);
    const missingFile = prod({ VERIFACTU_MODE: "production", ...software, VERIFACTU_CERT_P12: join(dir, "nope.p12") });
    assert.match(joined(missingFile.errors), /VERIFACTU_CERT_P12: el fichero no existe o no es legible/);
    assert.deepEqual(prod({ VERIFACTU_MODE: "sandbox" }).errors, [], "sandbox needs nothing");
  });

  it("SES / TBAI / IGIC conditional requirements and the TBAI enum without preproduction", () => {
    const ses = joined(prod({ SES_HOSPEDAJES_MODE: "production" }).errors);
    for (const name of ["SES_HOSPEDAJES_CERT_PATH", "SES_HOSPEDAJES_CERT_PASSPHRASE", "SES_HOSPEDAJES_CLIENT_ID", "SES_HOSPEDAJES_CLIENT_SECRET"]) {
      assert.match(ses, new RegExp(`Falta ${name} \\(obligatoria cuando SES_HOSPEDAJES_MODE!=sandbox\\)`));
    }
    assert.match(joined(prod({ TBAI_MODE: "preproduction" }).errors), /TBAI_MODE debe ser uno de: sandbox \| production/);
    const tbai = joined(prod({ TBAI_MODE: "production" }).errors);
    for (const name of ["TBAI_CERT_PATH", "TBAI_CERT_PASSPHRASE", "TBAI_LICENSE_KEY"]) assert.match(tbai, new RegExp(`Falta ${name} \\(obligatoria cuando TBAI_MODE=production\\)`));
    assert.match(joined(prod({ TBAI_MODE: "production", TBAI_CERT_PATH: certPath, TBAI_CERT_PASSPHRASE: "x", TBAI_LICENSE_KEY: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" }).errors), /TBAI_LICENSE_KEY supera los 20 caracteres/);
    const igic = joined(prod({ IGIC_MODE: "preproduction" }).errors);
    assert.match(igic, /Falta IGIC_CERT_PATH \(obligatoria cuando IGIC_MODE!=sandbox\)/);
    assert.match(igic, /Falta IGIC_CERT_PASSPHRASE/);
    assert.deepEqual(prod({ IGIC_MODE: "production", IGIC_CERT_PATH: certPath, IGIC_CERT_PASSPHRASE: "x" }).errors, []);
  });
});

describe("assertEnv", () => {
  const originalWarn = console.warn;
  afterEach(() => {
    console.warn = originalWarn;
    __resetEnvReportForTests();
  });

  it("throws in production with every error listed", () => {
    assert.throws(
      () => assertEnv({ ...PROD_BASE, JWT_SECRET: "change-me", RBAC_STRICT: "false" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Configuración de entorno inválida \(NODE_ENV=production\), 2 error\(es\)/);
        assert.match(error.message, /Falta JWT_SECRET/);
        assert.match(error.message, /RBAC_STRICT=false está prohibido/);
        return true;
      }
    );
  });

  it("only warns outside production, and only once per identical report", () => {
    const calls: string[] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    const env = { ...DEV_BASE, RATE_LIMIT_MAX: "abc" };
    assert.doesNotThrow(() => assertEnv(env));
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /\[env\] 1 error\(es\) de configuración \(development; en producción impedirían el arranque\)/);
    assert.match(calls[0]!, /RATE_LIMIT_MAX debe ser un entero/);
    assert.match(calls[0]!, /aviso\(s\) de configuración/);
    assertEnv(env);
    assert.equal(calls.length, 1, "same report is not printed twice");
    assertEnv({ ...env, RATE_LIMIT_MAX: "600" });
    assert.equal(calls.length, 2, "a different report is printed");
  });

  it("stays silent when everything is fine", () => {
    const calls: string[] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    assertEnv({ ...DEV_BASE, ENCRYPTION_KEY: VALID_KEY, APP_BASE_URL: "http://localhost:5173" });
    assert.deepEqual(calls, []);
  });
});

describe("resolveCorsOrigins", () => {
  it("normalises, deduplicates and merges the deprecated alias", () => {
    const resolved = resolveCorsOrigins({
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: " HTTPS://App.Example.com/ , https://app.example.com, http://localhost:5173, not-an-origin, https://x.example.com/path ",
      PILOT_PUBLIC_ORIGIN: "https://Old.Example.com"
    });
    assert.deepEqual(resolved.allowed, ["https://app.example.com", "http://localhost:5173", "https://old.example.com"]);
    assert.equal(resolved.devFallback, false);
    assert.equal(resolved.lanFallback, false);
    assert.equal(resolved.deprecatedAliasUsed, true);
  });

  it("enables the localhost fallback outside production and the LAN fallback only with CORS_ALLOW_LAN=true", () => {
    assert.deepEqual(resolveCorsOrigins({ NODE_ENV: "development" }), { allowed: [], devFallback: true, lanFallback: false, deprecatedAliasUsed: false });
    assert.equal(resolveCorsOrigins({ NODE_ENV: "development", CORS_ALLOW_LAN: "true" }).lanFallback, true);
    assert.equal(resolveCorsOrigins({ NODE_ENV: "production", CORS_ALLOW_LAN: "true" }).lanFallback, false);
    assert.equal(resolveCorsOrigins({}).devFallback, true, "no NODE_ENV → not production");
  });

  it("normalizeOrigin rejects paths, wildcards and non-http schemes", () => {
    assert.equal(normalizeOrigin("https://A.example.com:8443/"), "https://a.example.com:8443");
    assert.equal(normalizeOrigin("https://a.example.com/x"), null);
    assert.equal(normalizeOrigin("*"), null);
    assert.equal(normalizeOrigin("ws://a.example.com"), null);
  });
});
