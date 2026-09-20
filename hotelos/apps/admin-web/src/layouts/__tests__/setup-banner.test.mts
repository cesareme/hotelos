import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { setupBannerMessage, shouldShowSetupBanner } from "../setup-banner.ts";

// Corrector L5 (L5F-02): the shell banner rule (Tanda L5 · lote C) had no test.
const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const readiness = (over: Partial<Parameters<typeof shouldShowSetupBanner>[0] & object> = {}) => ({
  propertyId: "prop_x",
  status: "blocked" as const,
  blockingCount: 2,
  checks: [],
  computedAt: "2026-09-19T00:00:00.000Z",
  goLiveAt: null,
  ...over
});

describe("shouldShowSetupBanner (BackOfficeLayout · Tanda L5 lote C)", () => {
  it("shows only for a blocked property with at least one blocking check", () => {
    assert.equal(shouldShowSetupBanner(readiness(), false), true);
    assert.equal(shouldShowSetupBanner(readiness({ blockingCount: 1 }), false), true);
  });

  it("never shows «pending 0»: blocked without blockers, ready, or no readiness at all", () => {
    assert.equal(shouldShowSetupBanner(readiness({ blockingCount: 0 }), false), false);
    assert.equal(shouldShowSetupBanner(readiness({ status: "ready", blockingCount: 0 }), false), false);
    assert.equal(shouldShowSetupBanner(null, false), false);
    assert.equal(shouldShowSetupBanner(undefined, false), false);
  });

  it("a property already live (goLiveAt) never nags, whatever a later check says", () => {
    assert.equal(shouldShowSetupBanner(readiness({ goLiveAt: "2026-06-01T00:00:00.000Z" }), false), false);
    assert.equal(shouldShowSetupBanner(readiness({ goLiveAt: "2026-06-01T00:00:00.000Z", blockingCount: 5 }), false), false);
  });

  it("the session dismissal wins", () => {
    assert.equal(shouldShowSetupBanner(readiness(), true), false);
  });

  it("names the pending count in Spanish with verb and noun agreeing (FIX-1 · F9): «Falta 1 comprobación», «Faltan 3 comprobaciones»", () => {
    assert.equal(setupBannerMessage(1), "Falta 1 comprobación para poner la propiedad en marcha.");
    assert.equal(setupBannerMessage(3), "Faltan 3 comprobaciones para poner la propiedad en marcha.");
    assert.equal(setupBannerMessage(2), "Faltan 2 comprobaciones para poner la propiedad en marcha.");
  });
});

describe("BackOfficeLayout · the banner renders through the pure rule", () => {
  it("imports shouldShowSetupBanner / setupBannerMessage from layouts/setup-banner and keeps «Ver qué falta»", () => {
    const layout = src("layouts/BackOfficeLayout.tsx");
    assert.match(layout, /import \{ setupBannerMessage, shouldShowSetupBanner \} from "\.\/setup-banner";/);
    assert.match(layout, /if \(!shouldShowSetupBanner\(readiness, dismissed\)\) return null;/);
    assert.match(layout, /const message = setupBannerMessage\(pending\);/);
    assert.match(layout, /aria-label="Puesta en marcha pendiente"/);
    assert.match(layout, /Ver qué falta/);
    assert.doesNotMatch(layout, /Faltan? \$\{pending\}/, "the message text lives in setup-banner.ts only");
  });
});
