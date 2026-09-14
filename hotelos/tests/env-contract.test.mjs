import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectCensus, loadContract as loadTsContract } from "../scripts/env-census.mjs";
import { parseEnvFile, validateValues, loadContract as loadJsonContract, RETIRED_KEYS } from "../scripts/validate-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const contract = loadJsonContract();

function runValidator(args) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "validate-env.mjs"), ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("Environment contract (Tanda 4 · DATA-04)", () => {
  it("every variable the code reads is documented in scripts/env-contract.json", () => {
    const census = collectCensus();
    const undocumented = [...census.keys()].filter((name) => !(name in contract)).sort();
    assert.deepEqual(
      undocumented,
      [],
      `variables leídas por el código sin documentar en apps/api/src/lib/env.ts (ENV_CONTRACT): ${undocumented
        .map((name) => `${name} ← ${[...census.get(name)].join(", ")}`)
        .join("; ")}. Añádelas y ejecuta: node scripts/env-census.mjs --write`
    );
  });

  it("scripts/env-contract.json is generated from ENV_CONTRACT (no manual drift)", () => {
    const fromTs = loadTsContract();
    const stripReadBy = Object.fromEntries(Object.entries(contract).map(([name, spec]) => [name, { ...spec, readBy: undefined }]));
    const normalized = JSON.parse(JSON.stringify(stripReadBy));
    assert.deepEqual(normalized, JSON.parse(JSON.stringify(fromTs)), "scripts/env-contract.json desactualizado: ejecuta node scripts/env-census.mjs --write");
    const census = collectCensus();
    for (const [name, spec] of Object.entries(contract)) {
      assert.deepEqual(spec.readBy, [...(census.get(name) ?? [])].sort(), `readBy de ${name} desactualizado (node scripts/env-census.mjs --write)`);
    }
  });

  it("the contract covers the audit's core rules", () => {
    assert.equal(contract.DATABASE_URL.required, "always");
    assert.equal(contract.DATABASE_URL.format, "postgres-url");
    assert.equal(contract.JWT_SECRET.required, "always");
    assert.equal(contract.JWT_SECRET.minLength, 32);
    assert.equal(contract.ENCRYPTION_KEY.required, "production");
    assert.equal(contract.ENCRYPTION_KEY.format, "base64-32");
    assert.deepEqual(contract.NODE_ENV.values, ["development", "test", "production"]);
    assert.equal(contract.HOTELOS_ALLOW_DEMO_AUTH.productionForbidden, "true");
    assert.equal(contract.RBAC_STRICT.productionForbidden, "false");
    for (const flag of ["AUTH_EXPOSE_RESET_TOKEN", "ADMIN_EXPOSE_TEMP_PASSWORD", "TENANT_BOOTSTRAP_SKIP", "GUEST_PORTAL_RETURN_TOKEN"]) {
      assert.equal(contract[flag].productionForbidden, "true", flag);
    }
    assert.equal(contract.TRUST_PROXY.productionWarnUnless, "1");
    assert.equal(contract.RATE_LIMIT_MAX.format, "int");
    for (const interval of ["SES_SCHEDULER_INTERVAL_MS", "VERIFACTU_SCHEDULER_INTERVAL_MS", "MAILBOX_POLL_INTERVAL_MS"]) {
      assert.equal(contract[interval].min, 10_000, interval);
    }
    assert.deepEqual(contract.EMAIL_PROVIDER.values, ["postmark", "sendgrid"]);
    assert.deepEqual(contract.EMAIL_PROVIDER_KEY.required, { when: "EMAIL_PROVIDER" });
    assert.equal(contract.APP_BASE_URL.origin, true);
    assert.equal(contract.APP_BASE_URL.httpsInProduction, true);
    assert.deepEqual(contract.VERIFACTU_SOFTWARE_NIF.required, { when: "VERIFACTU_MODE!=sandbox" });
    assert.equal(contract.VERIFACTU_SOFTWARE_NIF.format, "nif");
    assert.deepEqual(contract.SES_HOSPEDAJES_CERT_PATH.required, { when: "SES_HOSPEDAJES_MODE!=sandbox" });
    assert.deepEqual(contract.TBAI_MODE.values, ["sandbox", "production"]);
    assert.deepEqual(contract.IGIC_CERT_PATH.required, { when: "IGIC_MODE!=sandbox" });
    assert.equal(contract.CORS_ALLOWED_ORIGINS.format, "origin-list");
    assert.ok(contract.PILOT_PUBLIC_ORIGIN.tags.includes("deprecated"));
    // Retired variables must not creep back in.
    for (const name of RETIRED_KEYS) assert.ok(!(name in contract), `${name} está retirada y no debe volver al contrato`);
  });

  it(".env.example declares every contract key and deploy/.env.production.example every non-dev-only key", () => {
    const dev = parseEnvFile(read(".env.example"));
    const prod = parseEnvFile(read("deploy/.env.production.example"));
    for (const [name, spec] of Object.entries(contract)) {
      assert.ok(dev.declared.has(name), `.env.example no declara ${name}`);
      if (!spec.tags?.includes("dev-only")) assert.ok(prod.declared.has(name), `deploy/.env.production.example no declara ${name}`);
    }
    for (const name of RETIRED_KEYS) {
      assert.ok(!dev.declared.has(name) && !prod.declared.has(name), `${name} está retirada y sigue en un example`);
    }
    // No shipped secret placeholders: secrets are empty and carry a "generar:" hint.
    for (const file of [dev, prod]) {
      for (const [key, value] of file.values) assert.notEqual(value, "change-me", `${key}=change-me en un example`);
    }
    assert.match(read(".env.example"), /generar: openssl rand -base64 48/);
    assert.match(read("deploy/.env.production.example"), /# ---- Solo compose/);
    for (const key of ["DOMAIN", "PUBLIC_API_URL", "POSTGRES_PASSWORD"]) assert.ok(prod.declared.has(key), `production example sin ${key}`);
  });

  it("both example files pass validate-env with their role", () => {
    const dev = runValidator([".env.example", "--role", "app"]);
    assert.equal(dev.status, 0, `${dev.stdout}\n${dev.stderr}`);
    const prod = runValidator(["deploy/.env.production.example", "--role", "production-compose"]);
    assert.equal(prod.status, 0, `${prod.stdout}\n${prod.stderr}`);
    const inferred = runValidator(["deploy/.env.production.example", "--json"]);
    assert.equal(JSON.parse(inferred.stdout).role, "production-compose");
  });

  it("validate-env rejects the forbidden production flags and bad formats, and exits 2 on a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anfitorio-env-"));
    const base = [
      "NODE_ENV=production",
      "DATABASE_URL=postgresql://u:p@db:5432/app",
      "JWT_SECRET=0123456789abcdef0123456789abcdef0123456789",
      `ENCRYPTION_KEY=${Buffer.alloc(32, 7).toString("base64")}`,
      "APP_BASE_URL=https://app.example.com",
      "TRUST_PROXY=1"
    ];
    const write = (name, lines) => {
      const path = join(dir, name);
      writeFileSync(path, lines.join("\n") + "\n");
      return path;
    };
    const okFile = write("ok.env", base);
    const ok = runValidator([okFile, "--role", "production-native", "--json"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    const demo = runValidator([write("demo.env", [...base, "HOTELOS_ALLOW_DEMO_AUTH=true"]), "--role", "production-native", "--json"]);
    assert.equal(demo.status, 1);
    assert.match(JSON.parse(demo.stdout).errors.join("\n"), /HOTELOS_ALLOW_DEMO_AUTH no puede estar activo en producción/);

    const override = runValidator(
      [write("override.env", [...base, "HOTELOS_ALLOW_DEMO_AUTH=true", "HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true"]), "--role", "production-native", "--json"]
    );
    assert.equal(override.status, 0);
    assert.match(JSON.parse(override.stdout).warnings.join("\n"), /PELIGRO/);

    const flags = runValidator(
      [write("flags.env", [...base, "RBAC_STRICT=false", "AUTH_EXPOSE_RESET_TOKEN=true", "RATE_LIMIT_MAX=abc", "SES_SCHEDULER_INTERVAL_MS=5000", "PORT=", "JWT_SECRET=change-me"]), "--role", "production-native", "--json"]
    );
    assert.equal(flags.status, 1);
    const errors = JSON.parse(flags.stdout).errors.join("\n");
    assert.match(errors, /RBAC_STRICT=false/);
    assert.match(errors, /AUTH_EXPOSE_RESET_TOKEN=true/);
    assert.match(errors, /RATE_LIMIT_MAX debe ser un entero/);
    assert.match(errors, /SES_SCHEDULER_INTERVAL_MS debe ser ≥ 10000/);
    assert.match(errors, /PORT está definida pero vacía/);
    assert.match(errors, /Falta JWT_SECRET .*placeholder/);

    const fiscal = runValidator([write("fiscal.env", [...base, "VERIFACTU_MODE=preproduction", "TBAI_MODE=preproduction"]), "--role", "production-native", "--json"]);
    assert.equal(fiscal.status, 1);
    const fiscalErrors = JSON.parse(fiscal.stdout).errors.join("\n");
    assert.match(fiscalErrors, /Falta VERIFACTU_SOFTWARE_NIF/);
    assert.match(fiscalErrors, /Falta VERIFACTU_INSTALL_NUMBER/);
    assert.match(fiscalErrors, /Falta VERIFACTU_CERT_P12/);
    assert.match(fiscalErrors, /TBAI_MODE debe ser uno de: sandbox \| production/);

    const compose = runValidator([write("compose.env", [...base, "OBJECT_STORAGE_BUCKET=x"]), "--role", "production-compose", "--json"]);
    const composeReport = JSON.parse(compose.stdout);
    assert.equal(compose.status, 1, "compose role requires DOMAIN/PUBLIC_API_URL/POSTGRES_PASSWORD");
    assert.match(composeReport.errors.join("\n"), /Falta DOMAIN/);
    assert.match(composeReport.warnings.join("\n"), /OBJECT_STORAGE_BUCKET ya no la lee ningún código/);

    const missing = runValidator([join(dir, "nope.env")]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /No existe el fichero/);
  });

  it("validateValues treats placeholders as absent and honours conditional requirements", () => {
    const { values, declared } = parseEnvFile(["EMAIL_PROVIDER=postmark", "EMAIL_PROVIDER_KEY=change-me", "DATABASE_URL=postgresql://x", "JWT_SECRET=0123456789abcdef0123456789abcdef"].join("\n"));
    const report = validateValues(values, declared, contract, { role: "app", isExample: false });
    assert.match(report.errors.join("\n"), /Falta EMAIL_PROVIDER_KEY \(obligatoria cuando EMAIL_PROVIDER\)/);
    assert.match(report.errors.join("\n"), /Falta EMAIL_FROM/);
    assert.match(report.warnings.join("\n"), /PII de huéspedes se guarda EN CLARO/);
  });

  it("the production compose feeds api and worker from env_file and mounts the certificates read-only", () => {
    const compose = read("deploy/docker-compose.production.yml");
    const apiBlock = compose.slice(compose.indexOf("\n  api:"), compose.indexOf("\n  worker:"));
    const workerBlock = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  admin-web:"));
    for (const block of [apiBlock, workerBlock]) {
      assert.match(block, /env_file:\s*\n\s*- \.\/\.env\.production/);
      assert.match(block, /\.\/certs:\/certs:ro/);
      assert.match(block, /NODE_ENV: production/);
      assert.match(block, /DATABASE_URL: postgresql:\/\/\$\{POSTGRES_USER:-hotelos\}/);
      // Secrets and fiscal settings travel through env_file, never through interpolation.
      assert.doesNotMatch(block, /JWT_SECRET:/);
      assert.doesNotMatch(block, /ENCRYPTION_KEY:/);
      assert.doesNotMatch(block, /OBJECT_STORAGE/);
      assert.doesNotMatch(block, /HOTELOS_ALLOW_DEMO_AUTH:/);
    }
    assert.match(apiBlock, /TRUST_PROXY: "1"/);
    assert.match(apiBlock, /HOST: 0\.0\.0\.0/);
    assert.match(workerBlock, /RUN_SCHEDULERS: "false"/);
  });

  it("the worker .env loader never overrides the process environment (same rule as the API)", () => {
    const worker = read("apps/worker/src/index.ts");
    assert.match(worker, /if \(process\.env\[key\] === undefined\) process\.env\[key\] = value;/);
    assert.doesNotMatch(worker, /^\s*process\.env\[key\] = value;\s*$/m);
    const api = read("apps/api/src/server.ts");
    assert.match(api, /if \(process\.env\[key\] === undefined\) process\.env\[key\] = value;/);
  });
});
