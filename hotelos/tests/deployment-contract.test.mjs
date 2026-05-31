import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("Deployment readiness contract", () => {
  it("has scripts for env validation and backup restore rehearsal", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(packageJson.scripts["validate:env"], "node scripts/validate-env.mjs");
    assert.equal(packageJson.scripts["backup:check"], "node scripts/backup-restore-check.mjs");
  });

  it("checks every required environment variable from the deployment spec", () => {
    const validator = readFileSync(new URL("../scripts/validate-env.mjs", import.meta.url), "utf8");
    for (const variable of [
      "DATABASE_URL",
      "REDIS_URL",
      "JWT_SECRET",
      "ENCRYPTION_KEY",
      "OBJECT_STORAGE_BUCKET",
      "AI_PROVIDER_API_KEY",
      "SES_HOSPEDAJES_CLIENT_SECRET",
      "APP_PUBLIC_API_URL",
      "SENTRY_DSN"
    ]) {
      assert.match(validator, new RegExp(variable));
    }
  });

  it("has conventional GitHub Actions CI with Docker image builds", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    assert.match(workflow, /npm run validate:env/);
    assert.match(workflow, /npm run test/);
    assert.match(workflow, /npm run smoke:demo/);
    assert.match(workflow, /Dockerfile\.api/);
    assert.match(workflow, /Dockerfile\.ai-gateway/);
    assert.match(workflow, /Dockerfile\.worker/);
  });
});
