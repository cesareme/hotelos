// Sandbox-mode coverage for the Booking adapter (Sprint 44).
//
// We assert the THREE-mode resolution (stub / sandbox / real) and that sandbox
// mode does a REAL HTTP round-trip — with the XML body and against the loopback
// sandbox URL — but WITHOUT performing OAuth. We inject a fake global fetch so
// the test never touches the network and can capture the outgoing request.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ChannelContext } from "../../adapter.types.js";
import { bookingAdapter } from "../booking.adapter.js";
import { clearTokenCache } from "../booking/oauth.js";
import { resolveAdapterMode } from "../../readiness.service.js";

const RATE_ITEMS = [
  { date: "2026-06-01", ratePlanId: "RP-BAR", amount: 129.5, currency: "EUR" },
  { date: "2026-06-02", ratePlanId: "RP-BAR", amount: 139, currency: "EUR" }
];

function channel(creds: Record<string, unknown> | null): ChannelContext {
  return { id: "channel-booking", propertyId: "prop-1", providerCode: "booking", credentialsJson: creds };
}

const realFetch = globalThis.fetch;

type Captured = { url: string; init: RequestInit | undefined };

function installFakeFetch(captured: Captured[], jsonBody: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response(JSON.stringify(jsonBody), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
}

beforeEach(() => {
  delete process.env.BOOKING_ADAPTER_MODE;
  delete process.env.BOOKING_SANDBOX_URL;
  clearTokenCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BOOKING_ADAPTER_MODE;
  delete process.env.BOOKING_SANDBOX_URL;
  clearTokenCache();
});

describe("booking adapter — three-mode resolution", () => {
  it("defaults to stub and resolves real/sandbox by env", () => {
    assert.equal(resolveAdapterMode("booking"), "stub");
    process.env.BOOKING_ADAPTER_MODE = "sandbox";
    assert.equal(resolveAdapterMode("booking"), "sandbox");
    process.env.BOOKING_ADAPTER_MODE = "real";
    assert.equal(resolveAdapterMode("booking"), "real");
    process.env.BOOKING_ADAPTER_MODE = "anything-else";
    assert.equal(resolveAdapterMode("booking"), "stub");
  });

  it("stub mode still returns ok in-process with no network call", async () => {
    const captured: Captured[] = [];
    installFakeFetch(captured, {});
    const r = await bookingAdapter.pushRates({ channel: channel({ client_id: "x", client_secret: "y" }), items: RATE_ITEMS });
    assert.equal(r.ok, true);
    assert.equal(r.pushed, RATE_ITEMS.length);
    assert.deepEqual(r.raw, { stub: true, provider: "booking" });
    assert.equal(captured.length, 0, "stub mode must not hit the network");
  });
});

describe("booking adapter — sandbox mode round-trip", () => {
  it("POSTs the XML body to the loopback sandbox URL without OAuth", async () => {
    process.env.BOOKING_ADAPTER_MODE = "sandbox";
    const captured: Captured[] = [];
    installFakeFetch(captured, { status: "ok", confirmations: [{ accepted: true }] });

    // Note: NO valid credentials — sandbox must not need them.
    const r = await bookingAdapter.pushRates({ channel: channel(null), items: RATE_ITEMS });

    assert.equal(r.ok, true);
    assert.equal(r.pushed, RATE_ITEMS.length);
    const raw = r.raw as Record<string, unknown>;
    assert.equal(raw.mode, "sandbox");

    // Exactly one HTTP call: the push. (No OAuth token exchange.)
    assert.equal(captured.length, 1);
    const call = captured[0]!;
    assert.match(call.url, /\/channel-manager\/_sandbox\/booking$/);
    assert.equal(call.init?.method, "POST");
    assert.match(String(call.init?.body), /<rate /, "sandbox push must carry the XML body");
    const headers = call.init?.headers as Record<string, string> | undefined;
    assert.match(headers?.Authorization ?? "", /Bearer /);
  });

  it("respects BOOKING_SANDBOX_URL override", async () => {
    process.env.BOOKING_ADAPTER_MODE = "sandbox";
    process.env.BOOKING_SANDBOX_URL = "http://127.0.0.1:9999";
    const captured: Captured[] = [];
    installFakeFetch(captured, { status: "ok", confirmations: [] });

    await bookingAdapter.pushAvailability({
      channel: channel(null),
      items: [{ date: "2026-06-01", roomTypeId: "ROOM-1", count: 3 }]
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.url, "http://127.0.0.1:9999/channel-manager/_sandbox/booking");
  });

  it("testCredentials in sandbox mode confirms via a real round-trip", async () => {
    process.env.BOOKING_ADAPTER_MODE = "sandbox";
    const captured: Captured[] = [];
    installFakeFetch(captured, { status: "ok", confirmations: [] });

    const r = await bookingAdapter.testCredentials({ channel: channel(null) });
    assert.equal(r.ok, true);
    assert.equal(r.metadata?.mode, "sandbox");
    assert.equal(captured.length, 1);
    assert.match(captured[0]!.url, /\/channel-manager\/_sandbox\/booking$/);
  });
});
