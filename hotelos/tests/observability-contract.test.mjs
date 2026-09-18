import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../packages/config/src/observability.ts", import.meta.url), "utf8");
const configIndex = readFileSync(new URL("../packages/config/src/index.ts", import.meta.url), "utf8");
const apiServer = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
const deploymentDoc = readFileSync(new URL("../docs/deployment.md", import.meta.url), "utf8");

describe("Observability contract", () => {
  it("defines shared service names, headers, and telemetry targets", () => {
    assert.match(config, /OBSERVABILITY_HEADERS/);
    assert.match(config, /x-correlation-id/);
    assert.match(config, /hotelos-api/);
    assert.match(config, /hotelos-worker/);
    assert.match(config, /opentelemetry/);
    assert.match(config, /sentry/);
    assert.match(config, /prometheus/);
    assert.match(configIndex, /observability\.js/);
  });

  it("echoes correlation headers from the API", () => {
    assert.match(apiServer, /app\.addHook\("onRequest"/);
    assert.match(apiServer, /OBSERVABILITY_HEADERS\.correlationId/);
    assert.match(apiServer, /reply\.header\(OBSERVABILITY_HEADERS\.correlationId/);
  });

  it("uses structured health responses on every backend service", () => {
    assert.match(apiServer, /buildHealthResponse/);
    assert.match(apiServer, /SERVICE_NAMES\.api/);
    assert.match(worker, /getWorkerHealth/);
    assert.match(worker, /SERVICE_NAMES\.worker/);
  });

  it("documents the operational release gate", () => {
    assert.match(deploymentDoc, /x-correlation-id/);
    assert.match(deploymentDoc, /telemetry targets/);
    assert.match(deploymentDoc, /API and worker/);
  });
});
