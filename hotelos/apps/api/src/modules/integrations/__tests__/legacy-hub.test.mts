// Tanda L8 · lote 02 (hub heredado honesto): the fixture providers of the
// legacy integrations hub are marked demo/sandbox, a "test connection" is
// always simulated (no adapter in this build → never `ok`, never an
// `accepted` event) and the dashboard error counter ignores demo providers.
// Pure functions + fixtures only: no database.
// Run from apps/api with
//   node --import tsx --test src/modules/integrations/__tests__/legacy-hub.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demoStore } from "../../../lib/demo-store.js";
import { buildConnectionTestResult, countIntegrationErrors, demoIntegrationProviderIds, legacyFixturesApplyTo } from "../integrations.service.js";

const DEMO_PROVIDER_CODES = ["mock_ota", "mock_payments", "mock_messaging"];

describe("legacy hub · demo providers are declared as such", () => {
  it("every fixture provider is demo + sandbox and its name says «(demostración)»", () => {
    assert.equal(demoStore.integrationProviders.length, DEMO_PROVIDER_CODES.length);
    for (const provider of demoStore.integrationProviders) {
      assert.ok(DEMO_PROVIDER_CODES.includes(provider.code), `unexpected provider ${provider.code}`);
      assert.equal(provider.demo, true, `${provider.code} must be demo`);
      assert.equal(provider.mode, "sandbox", `${provider.code} must declare sandbox mode`);
      assert.match(provider.name, /\(demostración\)$/, `${provider.code} name must end with (demostración)`);
    }
  });

  it("demoIntegrationProviderIds() lists exactly the fixture providers", () => {
    assert.deepEqual(demoIntegrationProviderIds().sort(), demoStore.integrationProviders.map((provider) => provider.id).sort());
    assert.ok(demoIntegrationProviderIds().includes("ip_mock_payments"));
  });

  it("the seeded demo connection never synchronised: no lastSyncAt in the fixture (corrector L8 · REV-04)", () => {
    for (const connection of demoStore.integrationConnections) {
      assert.equal(connection.lastSyncAt, undefined, `${connection.id} must not invent a synchronisation`);
    }
  });

  it("legacyFixturesApplyTo: only the demo property seeds the hub fixtures; any other tenant's dashboard leaves the tables alone (corrector L8 · seguridad REV-05)", () => {
    assert.equal(legacyFixturesApplyTo(demoStore.property.id), true);
    assert.equal(legacyFixturesApplyTo("prop_uxday"), false);
    assert.equal(legacyFixturesApplyTo("prop_123", []), false, "no fixtures → nothing to persist");
    assert.equal(legacyFixturesApplyTo("prop_x", [{ propertyId: "prop_x" }]), true);
  });

  it("the seeded fixture event is not a false success (no `accepted`, no ConnectionTested)", () => {
    for (const event of demoStore.integrationEvents) {
      assert.notEqual(event.status, "accepted", `${event.id} must not be accepted`);
      assert.notEqual(event.eventType, "ConnectionTested");
    }
    const seeded = demoStore.integrationEvents.find((event) => event.connectionId === "iconn_mock_payments");
    assert.ok(seeded);
    assert.equal(seeded.eventType, "IntegrationTestSimulated");
    assert.equal(seeded.status, "simulated");
  });
});

describe("legacy hub · buildConnectionTestResult (pure)", () => {
  const payments = demoStore.integrationProviders.find((provider) => provider.code === "mock_payments")!;

  it("a demo provider answers simulated — never ok — and names the provider", () => {
    const result = buildConnectionTestResult(payments);
    assert.equal(result.status, "simulated");
    assert.equal(result.simulated, true);
    assert.match(result.message, /Prueba simulada/);
    assert.match(result.message, /proveedor de demostración/);
    assert.ok(result.message.includes(payments.name));
    assert.doesNotMatch(JSON.stringify(result), /"ok"/);
  });

  it("the persisted event is IntegrationTestSimulated with status simulated (never accepted)", () => {
    const { event } = buildConnectionTestResult(payments);
    assert.equal(event.eventType, "IntegrationTestSimulated");
    assert.equal(event.status, "simulated");
    assert.notEqual(event.status, "accepted");
    assert.notEqual(event.eventType, "IntegrationSyncStarted");
    assert.deepEqual(event.payloadJson, { test: true, simulated: true, providerCode: "mock_payments", mode: "sandbox" });
  });

  it("an unknown or non-demo provider is still simulated (no real adapter exists in this build)", () => {
    const unknown = buildConnectionTestResult(undefined);
    assert.equal(unknown.status, "simulated");
    assert.match(unknown.message, /sin adaptador real/);
    assert.equal(unknown.event.payloadJson.providerCode, null);
    assert.equal(unknown.event.payloadJson.mode, "none");

    const real = buildConnectionTestResult({ code: "stripe_real", name: "Stripe", demo: false, mode: "real" });
    assert.equal(real.status, "simulated");
    assert.equal(real.event.status, "simulated");
    assert.match(real.message, /sin adaptador real/);
  });
});

describe("legacy hub · countIntegrationErrors (pure)", () => {
  const demoProviderIds = ["ip_mock_payments"];

  it("demo connections and their failed events never count", () => {
    const count = countIntegrationErrors({
      connections: [{ id: "iconn_demo", providerId: "ip_mock_payments", status: "error" }],
      events: [
        { connectionId: "iconn_demo", status: "failed" },
        { connectionId: "iconn_demo", status: "failed" }
      ],
      demoProviderIds
    });
    assert.equal(count, 0);
  });

  it("real connections in error plus their failed events count; other connections' events do not", () => {
    const count = countIntegrationErrors({
      connections: [
        { id: "iconn_real_err", providerId: "ip_real", status: "error" },
        { id: "iconn_real_ok", providerId: "ip_real", status: "connected" },
        { id: "iconn_demo", providerId: "ip_mock_payments", status: "error" }
      ],
      events: [
        { connectionId: "iconn_real_err", status: "failed" },
        { connectionId: "iconn_real_ok", status: "failed" },
        { connectionId: "iconn_real_ok", status: "sent" },
        { connectionId: "iconn_demo", status: "failed" },
        { connectionId: "iconn_other_property", status: "failed" }
      ],
      demoProviderIds
    });
    assert.equal(count, 3);
  });

  it("no connections → 0", () => {
    assert.equal(countIntegrationErrors({ connections: [], events: [{ connectionId: "x", status: "failed" }], demoProviderIds }), 0);
  });
});
