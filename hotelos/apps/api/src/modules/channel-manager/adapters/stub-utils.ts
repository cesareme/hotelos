// Deterministic helpers used by every stub adapter so tests are reproducible.
//
// Two design choices worth knowing:
//   * Latency is sampled from a seeded PRNG, not Math.random, so identical
//     (channelId, operation) pairs produce identical timings within a run.
//   * `testCredentials` returns `ok: false` when `credentialsJson` is null or
//     contains the magic value `apiKey: "INVALID"`. This lets us exercise the
//     red path in tests without spinning up real OTA accounts.

import type { ExternalReservationDTO } from "../adapter.types.js";

// Deterministic 32-bit hash (djb2). Returns a non-negative integer.
export function seedHash(...parts: Array<string | number>): number {
  let h = 5381;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
  }
  return h >>> 0;
}

// LCG that produces a pseudo-random number in [0, 1) from a seed.
export function seededRandom(seed: number): number {
  const a = 1664525;
  const c = 1013904223;
  const m = 2 ** 32;
  const next = (a * seed + c) % m;
  return next / m;
}

export function simulateLatency(seed: number): Promise<number> {
  const ms = 50 + Math.floor(seededRandom(seed) * 150); // 50-199ms
  return new Promise((resolve) => setTimeout(() => resolve(ms), ms));
}

export function isInvalidCredentials(credentials: Record<string, unknown> | null): boolean {
  if (credentials === null) return true;
  const apiKey = credentials.apiKey;
  if (typeof apiKey === "string" && apiKey === "INVALID") return true;
  return false;
}

// Builds 0-3 deterministic fake reservations keyed on (channelId, since.toISOString()).
export function buildStubReservations(
  channelId: string,
  since: Date,
  providerCode: string
): ExternalReservationDTO[] {
  const seed = seedHash(channelId, since.toISOString(), providerCode);
  const count = seed % 4; // 0..3
  const list: ExternalReservationDTO[] = [];
  for (let i = 0; i < count; i++) {
    const nightsSeed = seedHash(seed, i, "nights");
    const nights = 1 + (nightsSeed % 5);
    const arrival = new Date(since.getTime() + (seedHash(seed, i, "arrival") % 30) * 24 * 60 * 60 * 1000);
    const departure = new Date(arrival.getTime() + nights * 24 * 60 * 60 * 1000);
    const guestSeed = seedHash(seed, i, "guest");
    list.push({
      externalReference: `${providerCode}-${seed.toString(16)}-${i}`,
      status: "confirmed",
      payloadJson: {
        provider: providerCode,
        channelId,
        guestName: `Stub Guest ${guestSeed % 1000}`,
        arrivalDate: arrival.toISOString().slice(0, 10),
        departureDate: departure.toISOString().slice(0, 10),
        nights,
        totalAmount: 80 + (seedHash(seed, i, "amount") % 220),
        currency: "EUR"
      }
    });
  }
  return list;
}

export function buildStubCompetitorRates(
  channelId: string,
  dateRange: { from: string; to: string },
  providerCode: string
): { date: string; competitorHotel: string; price: number; currency: string }[] {
  const start = new Date(dateRange.from);
  const end = new Date(dateRange.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const rates: { date: string; competitorHotel: string; price: number; currency: string }[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayKey = d.toISOString().slice(0, 10);
    const seed = seedHash(channelId, dayKey, providerCode);
    // Around 100 EUR baseline with deterministic +/-30% variance.
    const variance = (seed % 60) - 30;
    rates.push({
      date: dayKey,
      competitorHotel: `Competitor (${providerCode})`,
      price: Math.round((100 + variance) * 100) / 100,
      currency: "EUR"
    });
  }
  return rates;
}
