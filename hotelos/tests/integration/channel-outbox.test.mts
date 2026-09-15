/**
 * Channel outbox · integration (REAL HTTP via app.inject, Postgres required).
 *
 * Exercises the rate grid v2 publish path end to end on the demo property
 * (prop_123 / org_123) against the sandbox channels seeded by
 * `channels:seed-sandbox` (booking_com / expedia / channex, one mapped
 * product DBL × BAR each) plus a temporary `stub` channel created here
 * (airbnb, routed through the Channex simulator; carries a known
 * webhookSecret):
 *   bulk-update with publish → queued per channel → sync-status → drain →
 *   confirmed (the simulator confirms) → sync-status confirmed; retry of a
 *   confirmed delivery → 409; atomic claim (two concurrent claims take
 *   disjoint rows); a `sending` row is never superseded nor flipped back by a
 *   newer publish — the new value queues behind it and the obsolete row is
 *   retired as `superseded` by the drain (CSC-04); enqueue with a journal or
 *   a channel of ANOTHER property → 404 and the foreign journal untouched
 *   (CSC-01); an unknown list cursor → 400, never a silent empty page;
 *   webhook with a wrong secret → 401, right secret → 202, HMAC over the
 *   ORIGINAL bytes → 202 and over a re-serialised body → 401.
 * Cierre 2026-09-15 (window 2027-06-16..30, BAR rate days created here):
 *   · /properties/:id/channels/sync-status with a foreign channel → 400
 *     UNKNOWN_IDS (api-live-contract#5); deliveries?cursor=nope → 400 (#10);
 *   · POST /channel-manager/_sandbox/:provider is public (api-live-contract#2);
 *   · webhook: malformed body + bad signature → 401 (no 400 oracle), valid
 *     HMAC over the same bytes → 202, > 1 MiB → 413 «Payload Too Large»
 *     (outbox-drain#6);
 *   · scoped enqueue (roomTypeIds / ratePlanIds / kinds) and the journal
 *     pushStatus lifecycle queued → pushed → superseded, draft when nothing
 *     was queued (outbox-drain#5, cierre contract 1/2);
 *   · publishing back a CONFIRMED value retires the queued intermediate row
 *     and the cell reads confirmed (outbox-drain#1);
 *   · a revert leaves the cell `stale` until it is re-published (browser-ux#7);
 *   · drain candidates in UTC (a retry due in 5 min is not taken) and a stale
 *     `sending` row overtaken by a later confirmed delivery is retired
 *     (outbox-drain#2/#3);
 *   · retention purge of old `superseded` rows, at most hourly (CSC-05);
 *   · DELETE /channel-manager/channels/:id → 409 while pending, then archived,
 *     hidden from the property list and revived by POST (browser-ux#13).
 *
 * Race to know about: the scheduler leader (:3000 on the Mac) drains the same
 * database every 15 s. Assertions after a publish therefore accept
 * queued | sending | confirmed, and the "confirmed" checks poll briefly. The
 * claim and CSC-04 cases need rows the leader must NOT take: right after the
 * publish they are parked as `timeout` with a retry far in the future (not a
 * candidate for the real clock) and claimed with a clock past that retry —
 * see `parkOutOfLeaderReach`.
 *
 * Everything the suite writes is removed in `after` (deliveries of the
 * window created after the suite started, sync jobs, external reservations
 * of the stub channel, the stub channel + its mapping, journals, the BAR
 * cells restored from a snapshot, the fixtures created in prop_canary).
 * Sandbox channels are only created (and removed) when the seed is missing.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/channel-outbox.test.mts"
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The seeded sandbox credentials are AES-GCM encrypted with the repo's
// ENCRYPTION_KEY: load ../../.env first (existing variables are never
// overridden) so the suite decrypts what the seed wrote; the fallbacks below
// only apply on a machine without a .env (then the seed is missing too).
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Honest: no .env → the defaults below (a fresh CI database).
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { claimChannelDeliveries, resetDrainBuckets } = await import("../../apps/api/src/modules/channel-manager/drain.service.js");
const { applyMarkup } = await import("../../apps/api/src/modules/channel-manager/delivery.core.js");
const { readChannelEnv } = await import("../../apps/api/src/modules/channel-manager/env.partial.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const PROPERTY_ID = "prop_123";
const FROM = "2026-11-16";
const TO = "2026-11-18";
const DATES = ["2026-11-16", "2026-11-17", "2026-11-18"];
const MARK = "[channel-outbox test]";
const WEBHOOK_SECRET = "outbox-test-secret-2026";
const SANDBOX_PROVIDERS = ["booking_com", "expedia", "channex"] as const;
const STUB_PROVIDER = "airbnb";
// Cross-property fixtures: the seed's second property of the SAME organisation
// (the tenancy hook only sees body.propertyId; the ids inside must be refused).
const FOREIGN_PROPERTY_ID = "prop_canary";
const FOREIGN_PROVIDER = "outbox-foreign";
/** Retry instant of a parked row: never due for the real clock during the run. */
const PARKED_RETRY_AT = new Date("2036-01-01T00:00:00Z");
/** Clock the suite's own claims run with: past PARKED_RETRY_AT, so only they see the parked rows as due. */
const PARKED_CLAIM_CLOCK = new Date("2036-01-01T00:01:00Z");
// Cierre window assigned to the tests lote (rate-grid-v2.test.mts uses 2027-06-01..15). Empty at
// baseline: the BAR × DBL rate days the cases need are created in `before` and removed in `after`.
const JUNE_FROM = "2027-06-16";
const JUNE_TO = "2027-06-30";
const JUNE_PRICE = 100;
const J = (day: number): string => `2027-06-${String(day).padStart(2, "0")}`;
const JUNE_DAYS = [16, 17, 18, 19, 20, 21, 22, 23, 24];
/** Provider of the channel the archive/revive case creates (stub, Channex-routed like airbnb). */
const REVIVE_PROVIDER = "vrbo";
const dayUtc = (date: string): Date => new Date(`${date}T00:00:00Z`);
const isoOf = (d: Date): string => d.toISOString().slice(0, 10);
const windowFilter = (from: string, to: string) => ({ gte: dayUtc(from), lte: dayUtc(to) });
type Window = { from: string; to: string };
const NOV: Window = { from: FROM, to: TO };
const JUNE: Window = { from: JUNE_FROM, to: JUNE_TO };

type ChannelRow = { id: string; providerCode: string; mode: string; status: string; mappedProducts: number; readyToPush: boolean; markupPercent: number };
type Grid = { roomTypes: Array<{ id: string; code: string }>; ratePlans: Array<{ id: string; code: string }>; cells: Array<{ ratePlanId: string; roomTypeId: string; date: string; basePrice: number | null }> };
type SyncStatus = { channels: ChannelRow[]; cells: Array<{ ratePlanId: string; roomTypeId: string; date: string; byChannel: Record<string, { status: string }> }>; summary: Record<string, Record<string, number>> };
type DeliveryDTO = { id: string; channelId: string; kind: string; date: string; status: string; attempts: number; journalId: string | null; payload: { amount?: number } | null };
type ErrorBody = { statusCode: number; message: string; details?: { code?: string; [k: string]: unknown } };
type JournalState = { status: string; pushStatus: string; pushedTo: string[] };
type DrainSummaryDTO = { candidates: number; processed: number; retiredObsolete: number; purgedSuperseded: number | null; failed: unknown[] };

async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com",
      password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo",
      deviceId: "integration-tests-channel-outbox"
    }
  });
  return res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("channel outbox (app.inject, prop_123)", () => {
  let app: ApiApp;
  let headers: Headers = {};
  const startedAt = new Date();
  let barPlanId = "";
  let roomTypeId = "";
  const sandbox = new Map<string, ChannelRow>();
  const createdSandboxIds: string[] = [];
  let stubChannelId = "";
  let stubCreated = false;
  let stubMarkupPercent = 0;
  const journalIds = new Set<string>();
  let snapshot: Array<{ ratePlanId: string; roomTypeId: string; date: Date; price: unknown; source: string; manuallyOverridden: boolean; updatedBy: string | null; minPrice: unknown; maxPrice: unknown }> = [];
  let publishedPrice = 0;
  let confirmedDeliveryId = "";
  let foreign: { channelId: string; journalId: string } | null = null;
  let juneBaselineIds: string[] = [];
  const juneRateDayIds: string[] = [];
  let juneRestrictionBaseline = 0;
  let juneInventoryBaseline = 0;
  /** Channels the cierre cases create besides the stub (archive/revive); removed in `after`. */
  const extraChannelIds: string[] = [];

  const allChannelIds = (): string[] => [...[...sandbox.values()].map((c) => c.id), ...(stubChannelId ? [stubChannelId] : [])];

  async function listDeliveries(extra = "", win: Window = NOV): Promise<DeliveryDTO[]> {
    const res = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${PROPERTY_ID}&from=${win.from}&to=${win.to}&kind=rates&limit=500${extra}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return (JSON.parse(res.body) as { items: DeliveryDTO[] }).items;
  }

  /** Publish `price` on the given dates to `channelIds`; returns the journal id and the queued map. */
  async function publish(dates: string[], price: number, channelIds: string[], label: string): Promise<{ journalId: string; queued: Record<string, number>; warnings: string[] }> {
    const res = await app.inject({
      method: "POST",
      url: `/properties/${PROPERTY_ID}/rate-grid/bulk-update`,
      headers,
      payload: { cells: dates.map((date) => ({ ratePlanId: barPlanId, roomTypeId, date, price })), reason: `${MARK} ${label} ${price}`, publish: { channelIds, kinds: ["rates"] } }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { journalId: string; queued?: Record<string, number>; warnings?: string[] };
    journalIds.add(body.journalId);
    assert.ok(body.queued, `queued missing: ${res.body}`);
    return { journalId: body.journalId, queued: body.queued, warnings: body.warnings ?? [] };
  }

  /**
   * Takes the fresh `queued` rows of a journal on one channel out of the
   * leader's reach: `timeout` with a retry in 2036 is not a candidate for the
   * real clock, while a claim run with PARKED_CLAIM_CLOCK sees them as due.
   * Returns the parked ids (fails loudly when the leader was faster — the
   * window is one round-trip, so that would be a real regression of the
   * claim, not a flake to retry).
   */
  async function parkOutOfLeaderReach(journalId: string, channelId: string, expected: number): Promise<string[]> {
    const rows = await prisma.channelDelivery.findMany({ where: { journalId, channelId, status: "queued" }, select: { id: true } });
    const parked = await prisma.channelDelivery.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: "queued" }, data: { status: "timeout", nextRetryAt: PARKED_RETRY_AT } });
    assert.equal(parked.count, expected, `expected ${expected} fresh queued rows to park for journal ${journalId} on ${channelId}, parked ${parked.count} (${rows.length} found)`);
    return rows.map((r) => r.id);
  }

  async function pollUntil(predicate: (rows: DeliveryDTO[]) => boolean, extra = "", attempts = 30, win: Window = NOV): Promise<DeliveryDTO[]> {
    let rows: DeliveryDTO[] = [];
    for (let i = 0; i < attempts; i++) {
      rows = await listDeliveries(extra, win);
      if (predicate(rows)) break;
      await sleep(1000);
    }
    return rows;
  }

  /** status / pushStatus / pushedTo of an entry AS THE WIRE EXPOSES THEM (normalised to the contract union). */
  async function journalState(journalId: string): Promise<JournalState> {
    const res = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-journal/${journalId}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const entry = JSON.parse(res.body) as JournalState;
    return { status: entry.status, pushStatus: entry.pushStatus, pushedTo: [...entry.pushedTo].sort() };
  }

  /** Scoped drain of one channel (never the unscoped pass: that one also purges). */
  async function drainChannel(channelId: string): Promise<DrainSummaryDTO> {
    const res = await app.inject({ method: "POST", url: "/channel-manager/deliveries/drain", headers, payload: { channelId } });
    assert.equal(res.statusCode, 200, res.body);
    const summary = JSON.parse(res.body) as DrainSummaryDTO;
    assert.deepEqual(summary.failed, [], res.body);
    return summary;
  }

  /** Rows of one journal until `predicate` holds (the leader may be the one confirming them). */
  async function pollJournalRows(journalId: string, predicate: (rows: Array<{ id: string; status: string; attempts: number }>) => boolean, attempts = 30): Promise<Array<{ id: string; status: string; attempts: number }>> {
    let rows: Array<{ id: string; status: string; attempts: number }> = [];
    for (let i = 0; i < attempts; i++) {
      rows = await prisma.channelDelivery.findMany({ where: { journalId }, select: { id: true, status: true, attempts: true } });
      if (predicate(rows)) break;
      await sleep(1000);
    }
    return rows;
  }

  async function gridPrice(date: string): Promise<number | null> {
    const res = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-grid?from=${date}&to=${date}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const cells = (JSON.parse(res.body) as Grid).cells;
    assert.equal(cells.length, 1, res.body);
    return cells[0]!.basePrice;
  }

  /** State of the BAR cell of `date` on `channelId` as GET …/rate-grid/sync-status paints it, plus the summary. */
  async function syncState(date: string, channelId: string): Promise<{ status: string; summary: SyncStatus["summary"] }> {
    const res = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-grid/sync-status?from=${date}&to=${date}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const status = JSON.parse(res.body) as SyncStatus;
    const cell = status.cells.find((c) => c.ratePlanId === barPlanId && c.roomTypeId === roomTypeId && c.date === date);
    return { status: cell?.byChannel[channelId]?.status ?? "never", summary: status.summary };
  }

  async function pollSync(date: string, channelId: string, wanted: string, attempts = 30): Promise<string> {
    let status = "";
    for (let i = 0; i < attempts; i++) {
      status = (await syncState(date, channelId)).status;
      if (status === wanted) break;
      await sleep(1000);
    }
    return status;
  }

  /** A synthetic outbox row of the stub channel (payload copied from a confirmed one); the hand-written timestamps go through raw SQL in UTC. */
  async function insertStubRow(input: { date: string; status: string; label: string; amount: number; attempts?: number; createdAt?: Date }): Promise<string> {
    const template = await prisma.channelDelivery.findFirst({ where: { channelId: stubChannelId, kind: "rates", status: "confirmed" }, select: { payloadJson: true } });
    assert.ok(template, "a confirmed stub delivery is needed as payload template");
    const payload = { ...(template.payloadJson as Record<string, unknown>), amount: input.amount };
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const row = await prisma.channelDelivery.create({
      data: {
        propertyId: PROPERTY_ID,
        channelId: stubChannelId,
        kind: "rates",
        roomTypeId,
        ratePlanId: barPlanId,
        date: dayUtc(input.date),
        payloadJson: payload,
        payloadHash: `${MARK} ${input.label} ${stamp}`,
        idempotencyKey: `outbox-close-${input.label}-${stamp}`,
        status: input.status,
        attempts: input.attempts ?? 0,
        ...(input.createdAt ? { createdAt: input.createdAt } : {})
      },
      select: { id: true }
    });
    return row.id;
  }

  const rowState = (id: string) => prisma.channelDelivery.findUnique({ where: { id }, select: { status: true, attempts: true } });

  async function removeForeignFixtures(): Promise<void> {
    await prisma.rateChangeJournal.deleteMany({ where: { propertyId: FOREIGN_PROPERTY_ID, reason: { contains: MARK } } });
    // No delivery may ever be written for the foreign channel (the 404 comes first); a crashed run of a
    // buggy build could have left some, so they go before the channel row.
    const foreignChannels = await prisma.channel.findMany({ where: { propertyId: FOREIGN_PROPERTY_ID, providerCode: FOREIGN_PROVIDER }, select: { id: true } });
    if (foreignChannels.length > 0) await prisma.channelDelivery.deleteMany({ where: { channelId: { in: foreignChannels.map((c) => c.id) } } });
    await prisma.channel.deleteMany({ where: { propertyId: FOREIGN_PROPERTY_ID, providerCode: FOREIGN_PROVIDER } });
  }

  before(async () => {
    app = await buildApiServer();
    await app.ready();
    const session = await loginDemo(app);
    assert.ok(session, "demo login (reception@example.com / hotelos-demo) is required: the outbox routes are high/critical");
    headers = { authorization: `Bearer ${session.token}` };

    const grid = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}`, headers });
    assert.equal(grid.statusCode, 200, grid.body);
    const g = JSON.parse(grid.body) as Grid;
    const bar = g.ratePlans.find((p) => p.code === "BAR");
    assert.ok(bar, "prop_123 must have a BAR plan (db:seed:commercial)");
    barPlanId = bar.id;
    const priced = g.cells.find((c) => c.ratePlanId === barPlanId && typeof c.basePrice === "number");
    assert.ok(priced, "expected BAR rate_days in the window");
    roomTypeId = priced.roomTypeId;
    snapshot = await prisma.rateDay.findMany({
      where: { propertyId: PROPERTY_ID, ratePlanId: barPlanId, roomTypeId, date: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T00:00:00Z`) } }
    });
    // Cierre window: BAR × DBL at 100 € on the days the cases use (a baseline row of a day is kept as it is).
    const juneExisting = await prisma.rateDay.findMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) }, select: { id: true, ratePlanId: true, roomTypeId: true, date: true } });
    juneBaselineIds = juneExisting.map((r) => r.id);
    juneRestrictionBaseline = await prisma.restrictionDay.count({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
    juneInventoryBaseline = await prisma.inventoryDay.count({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
    for (const day of JUNE_DAYS) {
      if (juneExisting.some((r) => r.ratePlanId === barPlanId && r.roomTypeId === roomTypeId && isoOf(r.date) === J(day))) continue;
      const row = await prisma.rateDay.create({ data: { propertyId: PROPERTY_ID, ratePlanId: barPlanId, roomTypeId, date: dayUtc(J(day)), price: JUNE_PRICE, currency: "EUR", source: "manual" }, select: { id: true } });
      juneRateDayIds.push(row.id);
    }

    // Sandbox channels: reuse the seed, create through the API only when missing.
    const list = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/channels`, headers });
    assert.equal(list.statusCode, 200, list.body);
    const channels = (JSON.parse(list.body) as { channels: ChannelRow[] }).channels;
    for (const provider of SANDBOX_PROVIDERS) {
      let row = channels.find((c) => c.providerCode === provider);
      if (!row) {
        const created = await app.inject({
          method: "POST",
          url: "/channel-manager/channels",
          headers,
          payload: { propertyId: PROPERTY_ID, providerCode: provider, name: `${MARK} ${provider}`, mode: "sandbox", status: "active", credentials: { apiKey: "sandbox", hotelId: "SBX-TEST", webhookSecret: WEBHOOK_SECRET } }
        });
        assert.equal(created.statusCode, 200, created.body);
        const id = (JSON.parse(created.body) as { id: string }).id;
        createdSandboxIds.push(id);
        const mapping = await app.inject({ method: "POST", url: `/channel-manager/channels/${id}/product-mappings`, headers, payload: { roomTypeId, ratePlanId: barPlanId, externalRoomCode: `T-${provider}`, externalRateCode: "RP-BAR" } });
        assert.equal(mapping.statusCode, 200, mapping.body);
        row = { id, providerCode: provider, mode: "sandbox", status: "active", mappedProducts: 1, readyToPush: true, markupPercent: 0 };
      }
      sandbox.set(provider, row);
    }

    // Stub channel with a known webhook secret (airbnb is routed through the Channex simulator).
    const existingStub = channels.find((c) => c.providerCode === STUB_PROVIDER);
    if (existingStub) {
      stubChannelId = existingStub.id;
      stubMarkupPercent = existingStub.markupPercent ?? 0;
      const creds = await app.inject({ method: "PATCH", url: `/channel-manager/channels/${stubChannelId}/credentials`, headers, payload: { credentials: { webhookSecret: WEBHOOK_SECRET }, merge: true } });
      assert.equal(creds.statusCode, 200, creds.body);
    } else {
      const created = await app.inject({
        method: "POST",
        url: "/channel-manager/channels",
        headers,
        payload: { propertyId: PROPERTY_ID, providerCode: STUB_PROVIDER, name: `${MARK} Airbnb stub`, mode: "stub", status: "active", credentials: { webhookSecret: WEBHOOK_SECRET } }
      });
      assert.equal(created.statusCode, 200, created.body);
      stubChannelId = (JSON.parse(created.body) as { id: string }).id;
      stubCreated = true;
    }
    const mapping = await app.inject({ method: "POST", url: `/channel-manager/channels/${stubChannelId}/product-mappings`, headers, payload: { roomTypeId, ratePlanId: barPlanId, externalRoomCode: "AB-DBL", externalRateCode: "RP-BAR" } });
    assert.equal(mapping.statusCode, 200, mapping.body);

    // Foreign fixtures (another property of the same organisation).
    if (await prisma.property.findUnique({ where: { id: FOREIGN_PROPERTY_ID }, select: { id: true } })) {
      await removeForeignFixtures(); // leftovers of a crashed run
      const [channel, journal] = await Promise.all([
        prisma.channel.create({ data: { propertyId: FOREIGN_PROPERTY_ID, providerCode: FOREIGN_PROVIDER, name: `${MARK} canal ajeno`, channelType: "ota", status: "active", mode: "stub" }, select: { id: true } }),
        prisma.rateChangeJournal.create({ data: { propertyId: FOREIGN_PROPERTY_ID, userId: "usr_123", changesCount: 0, changesJson: {}, reason: `${MARK} journal ajeno` }, select: { id: true } })
      ]);
      foreign = { channelId: channel.id, journalId: journal.id };
    }
  });

  after(async () => {
    try {
      const channelIds = [...allChannelIds(), ...extraChannelIds];
      if (channelIds.length > 0) {
        // Scoped by the suite's own windows: rate-grid-v2.test.mts publishes to the same sandbox channels in parallel
        // (a plain `createdAt >= startedAt` used to delete its deliveries too).
        await prisma.channelDelivery.deleteMany({ where: { propertyId: PROPERTY_ID, channelId: { in: channelIds }, createdAt: { gte: startedAt }, date: windowFilter(FROM, TO) } });
        await prisma.channelSyncJob.deleteMany({ where: { propertyId: PROPERTY_ID, channelId: { in: channelIds }, startedAt: { gte: startedAt } } });
      }
      // Cierre window: every delivery there is the suite's (some carry hand-written timestamps, so by date, not by createdAt).
      await prisma.channelDelivery.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
      for (const id of extraChannelIds) {
        await prisma.channelDelivery.deleteMany({ where: { channelId: id } });
        await prisma.channelProductMapping.deleteMany({ where: { channelId: id } });
        await prisma.channel.deleteMany({ where: { id, propertyId: PROPERTY_ID } });
      }
      // Rate days of the window: the fixtures, plus any row a parallel suite's derived plan materialised from them.
      await prisma.rateDay.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO), id: { notIn: juneBaselineIds } } });
      if (juneRestrictionBaseline === 0) await prisma.restrictionDay.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
      if (juneInventoryBaseline === 0) await prisma.inventoryDay.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
      if (stubChannelId) {
        await prisma.externalReservation.deleteMany({ where: { propertyId: PROPERTY_ID, channelId: stubChannelId } });
        await prisma.channelProductMapping.deleteMany({ where: { channelId: stubChannelId, roomTypeId, ratePlanId: barPlanId } });
        if (stubCreated) await prisma.channel.deleteMany({ where: { id: stubChannelId, propertyId: PROPERTY_ID } });
      }
      for (const id of createdSandboxIds) {
        await prisma.channelProductMapping.deleteMany({ where: { channelId: id } });
        await prisma.channel.deleteMany({ where: { id, propertyId: PROPERTY_ID } });
      }
      for (const row of snapshot) {
        await prisma.rateDay.update({
          where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: PROPERTY_ID, ratePlanId: row.ratePlanId, roomTypeId: row.roomTypeId, date: row.date } },
          data: { price: row.price as never, source: row.source, manuallyOverridden: row.manuallyOverridden, updatedBy: row.updatedBy, minPrice: row.minPrice as never, maxPrice: row.maxPrice as never }
        });
      }
      if (journalIds.size > 0) await prisma.rateChangeJournal.deleteMany({ where: { propertyId: PROPERTY_ID, id: { in: [...journalIds] } } });
      await prisma.rateChangeJournal.deleteMany({ where: { propertyId: PROPERTY_ID, reason: { contains: MARK } } });
      await removeForeignFixtures();
    } finally {
      if (app) await app.close();
      await prisma.$disconnect();
    }
  });

  it("the sandbox channels are ready to push (active, mapped, credentials)", async () => {
    const res = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/channels`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const channels = (JSON.parse(res.body) as { channels: ChannelRow[] }).channels;
    for (const provider of SANDBOX_PROVIDERS) {
      const row = channels.find((c) => c.providerCode === provider)!;
      assert.ok(row, `channel ${provider} missing`);
      assert.equal(row.mode, "sandbox");
      assert.equal(row.readyToPush, true, `${provider}: ${JSON.stringify(row)}`);
    }
    const stub = channels.find((c) => c.id === stubChannelId)!;
    assert.equal(stub.mode, "stub");
    assert.equal(stub.readyToPush, true, JSON.stringify(stub));
    stubMarkupPercent = stub.markupPercent ?? 0;
  });

  it("bulk-update with publish to the 4 channels queues 3 rate deliveries per channel and sync-status shows them", async () => {
    publishedPrice = Math.round((120 + Math.random() * 60) * 100) / 100;
    const res = await app.inject({
      method: "POST",
      url: `/properties/${PROPERTY_ID}/rate-grid/bulk-update`,
      headers,
      payload: {
        ops: [{ scope: { from: FROM, to: TO, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, price: { mode: "set", value: publishedPrice } }],
        reason: `${MARK} publish ${publishedPrice}`,
        publish: { channelIds: allChannelIds(), kinds: ["rates"] }
      }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { journalId: string; updated: number; queued?: Record<string, number>; warnings?: string[] };
    journalIds.add(body.journalId);
    assert.equal(body.updated, 3);
    assert.ok(body.queued, `queued missing: ${res.body}`);
    for (const id of allChannelIds()) assert.equal(body.queued[id], 3, `channel ${id}: ${JSON.stringify(body.queued)} ${JSON.stringify(body.warnings)}`);

    const sync = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-grid/sync-status?from=${FROM}&to=${TO}`, headers });
    assert.equal(sync.statusCode, 200, sync.body);
    const status = JSON.parse(sync.body) as SyncStatus;
    const inFlight = new Set(["queued", "sending", "confirmed"]);
    for (const id of allChannelIds()) {
      const bucket = status.summary[id] ?? {};
      const total = Object.entries(bucket).filter(([k]) => inFlight.has(k)).reduce((a, [, v]) => a + v, 0);
      assert.equal(total, 3, `channel ${id} summary: ${JSON.stringify(bucket)}`);
    }
    for (const date of DATES) {
      const cell = status.cells.find((c) => c.ratePlanId === barPlanId && c.roomTypeId === roomTypeId && c.date === date);
      assert.ok(cell, `sync cell ${date} missing`);
      for (const id of allChannelIds()) assert.ok(inFlight.has(cell.byChannel[id]?.status ?? "never"), `${date}/${id}: ${JSON.stringify(cell.byChannel[id])}`);
    }
    const journal = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-journal/${body.journalId}`, headers });
    const entry = JSON.parse(journal.body) as { status: string; pushedTo: string[] };
    assert.equal(entry.status, "published");
    for (const id of allChannelIds()) assert.ok(entry.pushedTo.includes(id), `pushedTo lacks ${id}`);
  });

  it("drain confirms every delivery (simulator + stub) and sync-status turns confirmed; attempts stay at 1", async () => {
    const drain = await app.inject({ method: "POST", url: "/channel-manager/deliveries/drain", headers, payload: {} });
    assert.equal(drain.statusCode, 200, drain.body);
    const summary = JSON.parse(drain.body) as { runs?: Array<{ processed: number; byStatus: Record<string, number>; failed: unknown[] }> } & { processed?: number };
    const runs = summary.runs ?? [summary as { processed: number; byStatus: Record<string, number>; failed: unknown[] }];
    for (const run of runs) assert.deepEqual(run.failed, [], JSON.stringify(run));

    const items = (await pollUntil((rows) => {
      const ours = rows.filter((d) => allChannelIds().includes(d.channelId) && DATES.includes(d.date));
      return ours.length >= 12 && ours.every((d) => d.status === "confirmed");
    })).filter((d) => allChannelIds().includes(d.channelId) && DATES.includes(d.date));
    assert.equal(items.length, 12, `expected 12 rate deliveries, got ${items.length}: ${JSON.stringify(items.map((d) => [d.channelId, d.date, d.status]))}`);
    for (const d of items) {
      assert.equal(d.status, "confirmed", JSON.stringify(d));
      assert.equal(d.attempts, 1, `double send detected: ${JSON.stringify(d)}`);
    }
    confirmedDeliveryId = items.find((d) => d.channelId === stubChannelId)!.id;

    const sync = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-grid/sync-status?from=${FROM}&to=${TO}`, headers });
    const status = JSON.parse(sync.body) as SyncStatus;
    for (const id of allChannelIds()) assert.equal(status.summary[id]?.confirmed, 3, `channel ${id}: ${JSON.stringify(status.summary[id])}`);

    const journalId = items[0]!.journalId;
    assert.ok(journalId);
    const journal = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-journal/${journalId}`, headers });
    assert.equal((JSON.parse(journal.body) as { pushStatus: string }).pushStatus, "pushed");

    const detail = await app.inject({ method: "GET", url: `/channel-manager/deliveries/${confirmedDeliveryId}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal((JSON.parse(detail.body) as DeliveryDTO).status, "confirmed");
  });

  it("retry of a confirmed delivery → 409 DELIVERY_NOT_RETRYABLE", async () => {
    assert.ok(confirmedDeliveryId);
    const res = await app.inject({ method: "POST", url: `/channel-manager/deliveries/${confirmedDeliveryId}/retry`, headers });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((JSON.parse(res.body) as { details?: { code?: string } }).details?.code, "DELIVERY_NOT_RETRYABLE");
  });

  it("two concurrent claims take disjoint rows and a third never re-takes them (multi-instance drain safety, independent of the leader)", async () => {
    const price = Math.round((200 + Math.random() * 50) * 100) / 100;
    const { journalId, queued } = await publish(DATES, price, [stubChannelId], "claim");
    assert.equal(queued[stubChannelId], 3, JSON.stringify(queued));
    // Only the rows of THIS publish (the previous confirmed ones were not superseded: confirmed is final).
    const ours = new Set(await parkOutOfLeaderReach(journalId, stubChannelId, 3));

    const [a, b] = await Promise.all([
      claimChannelDeliveries({ channelId: stubChannelId, limit: 2, now: PARKED_CLAIM_CLOCK }),
      claimChannelDeliveries({ channelId: stubChannelId, limit: 2, now: PARKED_CLAIM_CLOCK })
    ]);
    const idsA = a.map((d) => d.id);
    const idsB = b.map((d) => d.id);
    // Other rows of the stub channel (leftovers, other suites) may be candidates too: the invariant is
    // disjointness, every claimed row is `sending`, and the parked rows are taken by the three claims in total.
    assert.equal(idsA.filter((id) => idsB.includes(id)).length, 0, `overlap: ${JSON.stringify({ idsA, idsB })}`);
    const claimed = [...idsA, ...idsB];
    assert.ok(claimed.length >= 1, `nothing claimed with the parked clock: ${JSON.stringify({ idsA, idsB })}`);
    const claimedRows = await prisma.channelDelivery.findMany({ where: { id: { in: claimed } }, select: { id: true, status: true } });
    assert.equal(claimedRows.length, claimed.length);
    for (const r of claimedRows) assert.equal(r.status, "sending", JSON.stringify(r));
    // A third claim never re-takes a freshly claimed row (it is `sending`, not stale) but does take the rest.
    const c = await claimChannelDeliveries({ channelId: stubChannelId, limit: 10, now: PARKED_CLAIM_CLOCK });
    const idsC = c.map((d) => d.id);
    assert.equal(idsC.filter((id) => claimed.includes(id)).length, 0, "third claim re-took a claimed row");
    const everything = new Set([...claimed, ...idsC]);
    for (const id of ours) assert.ok(everything.has(id), `parked row ${id} was never claimed: ${JSON.stringify({ idsA, idsB, idsC })}`);
    // A claim after that never returns a row already taken (it is `sending`, not stale).
    const fourth = await claimChannelDeliveries({ channelId: stubChannelId, limit: 10, now: PARKED_CLAIM_CLOCK });
    assert.equal(fourth.filter((d) => everything.has(d.id)).length, 0, "a later claim re-took a row already in flight");

    // Hand the claimed rows back to the queue (test scaffolding: no API releases a fresh `sending` row) and let the drain finish them.
    await prisma.channelDelivery.updateMany({ where: { id: { in: [...everything] }, status: "sending" }, data: { status: "queued" } });
    const drain = await app.inject({ method: "POST", url: "/channel-manager/deliveries/drain", headers, payload: { channelId: stubChannelId } });
    assert.equal(drain.statusCode, 200, drain.body);
    const rows = (await pollUntil((all) => {
      const mine = all.filter((d) => ours.has(d.id));
      return mine.length === 3 && mine.every((d) => d.status === "confirmed");
    }, `&channelId=${stubChannelId}`)).filter((d) => ours.has(d.id));
    assert.equal(rows.length, 3);
    for (const d of rows) {
      assert.equal(d.status, "confirmed", JSON.stringify(d));
      assert.equal(d.attempts, 1, `double send detected: ${JSON.stringify(d)}`);
    }
  });

  it("a `sending` delivery is neither superseded nor flipped back by a newer publish: the new value queues behind it and the obsolete row is retired (CSC-04)", async () => {
    const date = DATES[0]!;
    const p3 = Math.round((300 + Math.random() * 20) * 100) / 100;
    const p4 = p3 + 1;
    const first = await publish([date], p3, [stubChannelId], "en vuelo");
    assert.equal(first.queued[stubChannelId], 1, JSON.stringify(first));
    const [r3] = await parkOutOfLeaderReach(first.journalId, stubChannelId, 1);
    const claimed = await claimChannelDeliveries({ channelId: stubChannelId, limit: 50, now: PARKED_CLAIM_CLOCK });
    assert.ok(claimed.some((d) => d.id === r3), `the parked row must be claimable with the parked clock: ${JSON.stringify(claimed.map((d) => d.id))}`);
    assert.equal((await prisma.channelDelivery.findUnique({ where: { id: r3 }, select: { status: true } }))?.status, "sending");

    // A newer value for the same cell while the previous one is in flight.
    const second = await publish([date], p4, [stubChannelId], "detrás del envío");
    assert.equal(second.queued[stubChannelId], 1, JSON.stringify(second));
    const inFlight = await prisma.channelDelivery.findUnique({ where: { id: r3 }, select: { status: true } });
    assert.equal(inFlight?.status, "sending", "a row in flight must not be superseded (its outcome must land)");
    const newer = (await listDeliveries(`&channelId=${stubChannelId}`)).filter((d) => d.date === date && d.journalId === second.journalId);
    assert.equal(newer.length, 1, JSON.stringify(newer));
    const r4 = newer[0]!;
    assert.notEqual(r4.id, r3);
    assert.ok(["queued", "sending", "confirmed"].includes(r4.status), JSON.stringify(r4));
    assert.equal(r4.payload?.amount, applyMarkup(p4, stubMarkupPercent), JSON.stringify(r4.payload));
    // A manual retry of a row in flight is refused (400): the drain owns it.
    const retry = await app.inject({ method: "POST", url: `/channel-manager/deliveries/${r3}/retry`, headers });
    assert.equal(retry.statusCode, 400, retry.body);

    // Hand the in-flight row back (scaffolding: the worker "died") and drain: an obsolete row a later
    // delivery of the cell overtook must be RETIRED as superseded, never re-sent after the current value.
    await prisma.channelDelivery.updateMany({ where: { id: { in: [r3, ...claimed.map((d) => d.id)] }, status: "sending" }, data: { status: "queued" } });
    const drain = await app.inject({ method: "POST", url: "/channel-manager/deliveries/drain", headers, payload: { channelId: stubChannelId } });
    assert.equal(drain.statusCode, 200, drain.body);
    const rows = await pollUntil((all) => {
      const old = all.find((d) => d.id === r3);
      const fresh = all.find((d) => d.id === r4.id);
      return old?.status === "superseded" && fresh?.status === "confirmed";
    }, `&channelId=${stubChannelId}`);
    const old = rows.find((d) => d.id === r3);
    const fresh = rows.find((d) => d.id === r4.id);
    assert.equal(old?.status, "superseded", `obsolete row: ${JSON.stringify(old)}`);
    assert.equal(fresh?.status, "confirmed", `current row: ${JSON.stringify(fresh)}`);
    assert.equal(fresh?.attempts, 1, JSON.stringify(fresh));
    // The retired row answers 409 on retry (superseded is final); the journal of the obsolete value is not "pushed".
    const retired = await app.inject({ method: "POST", url: `/channel-manager/deliveries/${r3}/retry`, headers });
    assert.equal(retired.statusCode, 409, retired.body);
    assert.equal((JSON.parse(retired.body) as ErrorBody).details?.code, "DELIVERY_NOT_RETRYABLE");
  });

  it("enqueue with a journal or a channel of ANOTHER property → 404 and nothing stamped (CSC-01); listing by a foreign channel → 404", async () => {
    assert.ok(foreign, `${FOREIGN_PROPERTY_ID} (seed) is required for the cross-property cases`);
    const enqueueForeignJournal = await app.inject({
      method: "POST",
      url: "/channel-manager/deliveries/enqueue",
      headers,
      payload: { propertyId: PROPERTY_ID, from: FROM, to: FROM, channelIds: [stubChannelId], kinds: ["rates"], journalId: foreign.journalId }
    });
    assert.equal(enqueueForeignJournal.statusCode, 404, enqueueForeignJournal.body);
    const foreignJournal = await prisma.rateChangeJournal.findUnique({ where: { id: foreign.journalId }, select: { status: true, pushStatus: true, pushedTo: true } });
    assert.deepEqual(foreignJournal, { status: "draft", pushStatus: "draft", pushedTo: [] }, "a refused enqueue must not stamp the foreign journal");
    assert.equal(await prisma.channelDelivery.count({ where: { journalId: foreign.journalId } }), 0, "a refused enqueue must not create deliveries");
    const unknownJournal = await app.inject({
      method: "POST",
      url: "/channel-manager/deliveries/enqueue",
      headers,
      payload: { propertyId: PROPERTY_ID, from: FROM, to: FROM, channelIds: [stubChannelId], kinds: ["rates"], journalId: "jrn_does_not_exist" }
    });
    assert.equal(unknownJournal.statusCode, 404, unknownJournal.body);

    const enqueueForeignChannel = await app.inject({
      method: "POST",
      url: "/channel-manager/deliveries/enqueue",
      headers,
      payload: { propertyId: PROPERTY_ID, from: FROM, to: FROM, channelIds: [foreign.channelId], kinds: ["rates"] }
    });
    assert.equal(enqueueForeignChannel.statusCode, 404, enqueueForeignChannel.body);
    assert.equal(await prisma.channelDelivery.count({ where: { channelId: foreign.channelId } }), 0);
    // Mixed: one own channel + one foreign channel is refused as a whole (no partial enqueue).
    const before = await prisma.channelDelivery.count({ where: { channelId: stubChannelId } });
    const mixed = await app.inject({
      method: "POST",
      url: "/channel-manager/deliveries/enqueue",
      headers,
      payload: { propertyId: PROPERTY_ID, from: FROM, to: FROM, channelIds: [stubChannelId, foreign.channelId], kinds: ["rates"] }
    });
    assert.equal(mixed.statusCode, 404, mixed.body);
    assert.equal(await prisma.channelDelivery.count({ where: { channelId: stubChannelId } }), before, "a refused enqueue must not touch the own channel either");

    const list = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${PROPERTY_ID}&channelId=${foreign.channelId}`, headers });
    assert.equal(list.statusCode, 404, list.body);
  });

  it("deliveries list: an unknown cursor or a non-positive limit → 400 (never a 500, never a silent empty page); a real cursor pages", async () => {
    const garbage = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${PROPERTY_ID}&cursor=garbage`, headers });
    assert.equal(garbage.statusCode, 400, garbage.body);
    assert.match((JSON.parse(garbage.body) as ErrorBody).message, /cursor/i);
    const zero = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${PROPERTY_ID}&limit=0`, headers });
    assert.equal(zero.statusCode, 400, zero.body);

    const first = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${PROPERTY_ID}&channelId=${stubChannelId}&limit=1`, headers });
    assert.equal(first.statusCode, 200, first.body);
    const page1 = JSON.parse(first.body) as { items: DeliveryDTO[]; nextCursor: string | null };
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextCursor, "the stub channel carries several deliveries by now");
    const second = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${PROPERTY_ID}&channelId=${stubChannelId}&limit=1&cursor=${page1.nextCursor}`, headers });
    assert.equal(second.statusCode, 200, second.body);
    const page2 = JSON.parse(second.body) as { items: DeliveryDTO[] };
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0]!.id, page1.items[0]!.id);
  });

  it("webhook: wrong secret → 401, right secret → 202 and triggers a pull; HMAC over the original bytes", async () => {
    const url = `/channel-manager/webhooks/${STUB_PROVIDER}/${stubChannelId}`;
    const wrong = await app.inject({ method: "POST", url, headers: { "x-anfitorio-webhook-secret": "nope", "content-type": "application/json" }, payload: { event: "ping" } });
    assert.equal(wrong.statusCode, 401, wrong.body);

    const unknown = await app.inject({ method: "POST", url: `/channel-manager/webhooks/${STUB_PROVIDER}/ch_does_not_exist`, headers: { "x-anfitorio-webhook-secret": WEBHOOK_SECRET, "content-type": "application/json" }, payload: { event: "ping" } });
    assert.equal(unknown.statusCode, 401, unknown.body);

    const ok = await app.inject({ method: "POST", url, headers: { "x-anfitorio-webhook-secret": WEBHOOK_SECRET, "content-type": "application/json" }, payload: { event: "reservation.created" } });
    assert.equal(ok.statusCode, 202, ok.body);
    const accepted = JSON.parse(ok.body) as { accepted: boolean; ok: boolean; imported: number };
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.ok, true, "stub pull must succeed");
    assert.equal(typeof accepted.imported, "number");

    // HMAC: the signature is computed over the raw bytes (spacing preserved), not over JSON.stringify(parsed).
    const raw = '{"event": "reservation.created",   "id": 42}';
    const rawSignature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex")}`;
    const signed = await app.inject({ method: "POST", url, headers: { "x-anfitorio-signature": rawSignature, "content-type": "application/json" }, payload: raw });
    assert.equal(signed.statusCode, 202, signed.body);
    const canonical = JSON.stringify(JSON.parse(raw));
    assert.notEqual(canonical, raw);
    const canonicalSignature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(canonical, "utf8").digest("hex")}`;
    const mismatched = await app.inject({ method: "POST", url, headers: { "x-anfitorio-signature": canonicalSignature, "content-type": "application/json" }, payload: raw });
    assert.equal(mismatched.statusCode, 401, `a signature over the re-serialised body must not verify: ${mismatched.body}`);
  });

  it("webhook without a session is public but a missing secret header is refused", async () => {
    const res = await app.inject({ method: "POST", url: `/channel-manager/webhooks/${STUB_PROVIDER}/${stubChannelId}`, headers: { "content-type": "application/json" }, payload: { event: "ping" } });
    assert.equal(res.statusCode, 401, res.body);
  });

  // ---------------------------------------------------------------- cierre 2026-09-15 · window 2027-06-16..30

  it("GET /properties/:id/channels/sync-status with a channel of another property → 400 UNKNOWN_IDS (only the foreign id listed), an own channel → 200 (api-live-contract#5); deliveries?cursor=nope&limit=1 → 400 (api-live-contract#10)", async () => {
    assert.ok(foreign, `${FOREIGN_PROPERTY_ID} (seed) is required for the cross-property cases`);
    const syncUrl = (channelIds: string) => `/properties/${PROPERTY_ID}/channels/sync-status?from=${JUNE_FROM}&to=${JUNE_TO}&channelIds=${channelIds}`;
    const bad = await app.inject({ method: "GET", url: syncUrl(foreign.channelId), headers });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.deepEqual((JSON.parse(bad.body) as ErrorBody).details, { code: "UNKNOWN_IDS", channelIds: [foreign.channelId] });
    const mixed = await app.inject({ method: "GET", url: syncUrl(`${stubChannelId},${foreign.channelId}`), headers });
    assert.equal(mixed.statusCode, 400, mixed.body);
    assert.deepEqual((JSON.parse(mixed.body) as ErrorBody).details?.channelIds, [foreign.channelId], "only the foreign id is listed");
    const own = await app.inject({ method: "GET", url: syncUrl(stubChannelId), headers });
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual((JSON.parse(own.body) as SyncStatus).channels.map((c) => c.id), [stubChannelId]);

    const cursor = await app.inject({ method: "GET", url: `/channel-manager/deliveries?propertyId=${PROPERTY_ID}&cursor=nope&limit=1`, headers });
    assert.equal(cursor.statusCode, 400, cursor.body);
    assert.match((JSON.parse(cursor.body) as ErrorBody).message, /cursor de paginación/);
  });

  it("POST /channel-manager/_sandbox/:provider is public: a Channex restrictions body without a session → 200 + X-Anfitorio-Simulator; an unknown provider → 400 (api-live-contract#2)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/channel-manager/_sandbox/channex?endpoint=restrictions",
      headers: { "content-type": "application/json" },
      payload: { values: [{ property_id: "p", rate_plan_id: "r", date: J(16), rate: 10 }] }
    });
    assert.equal(res.statusCode, 200, res.body);
    const simulator = JSON.parse(String(res.headers["x-anfitorio-simulator"])) as { accepted: number; rejected: number };
    assert.deepEqual({ accepted: simulator.accepted, rejected: simulator.rejected }, { accepted: 1, rejected: 0 });
    assert.match(String(res.headers["content-type"]), /application\/json/);
    const unknown = await app.inject({ method: "POST", url: "/channel-manager/_sandbox/foo", headers: { "content-type": "application/json" }, payload: {} });
    assert.equal(unknown.statusCode, 400, unknown.body);
    assert.match((JSON.parse(unknown.body) as ErrorBody).message, /Simulador desconocido/);
  });

  it("webhook: a malformed body with a bad signature → 401 (never a 400 oracle), the same bytes with a valid HMAC → 202; a body over 1 MiB → 413 labelled «Payload Too Large» (outbox-drain#6)", async () => {
    const url = `/channel-manager/webhooks/${STUB_PROVIDER}/${stubChannelId}`;
    const raw = "{not json";
    const bad = await app.inject({ method: "POST", url, headers: { "x-anfitorio-signature": "sha256=0000", "content-type": "application/json" }, payload: raw });
    assert.equal(bad.statusCode, 401, bad.body);
    const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex")}`;
    const good = await app.inject({ method: "POST", url, headers: { "x-anfitorio-signature": signature, "content-type": "application/json" }, payload: raw });
    assert.equal(good.statusCode, 202, `a non-JSON body with a valid signature is a hint to pull, never a 400: ${good.body}`);
    assert.equal((JSON.parse(good.body) as { accepted: boolean }).accepted, true);
    // Size is refused while reading the stream, before any parser and before authentication.
    const big = await app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: "x".repeat(1_100_000) });
    assert.equal(big.statusCode, 413, big.body.slice(0, 200));
    const label = JSON.parse(big.body) as { statusCode: number; error: string };
    assert.deepEqual({ statusCode: label.statusCode, error: label.error }, { statusCode: 413, error: "Payload Too Large" });
  });

  it("scoped enqueue queues only the requested room type × plan × kind; journal.pushStatus reads queued at enqueue, pushed after the drain, superseded when a later publish replaces every row, and stays draft when nothing was queued (outbox-drain#5, cierre contract 1/2)", async () => {
    const dates = [J(16), J(17), J(18)];
    // (a) a draft entry of our own, then the outbox route with the scope filters.
    const draft = await app.inject({
      method: "POST",
      url: `/properties/${PROPERTY_ID}/rate-grid/bulk-update`,
      headers,
      payload: { cells: dates.map((date) => ({ ratePlanId: barPlanId, roomTypeId, date, price: JUNE_PRICE + 5 })), reason: `${MARK} borrador para encolar acotado` }
    });
    assert.equal(draft.statusCode, 200, draft.body);
    const j1 = (JSON.parse(draft.body) as { journalId: string }).journalId;
    journalIds.add(j1);
    assert.deepEqual(await journalState(j1), { status: "draft", pushStatus: "draft", pushedTo: [] });
    const enqueue = await app.inject({
      method: "POST",
      url: "/channel-manager/deliveries/enqueue",
      headers,
      payload: { propertyId: PROPERTY_ID, from: J(16), to: J(18), channelIds: [stubChannelId], roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId], kinds: ["rates"], journalId: j1 }
    });
    assert.equal(enqueue.statusCode, 200, enqueue.body);
    const queuedMap = JSON.parse(enqueue.body) as { queued: number; byChannel: Record<string, { queued: number }> };
    assert.equal(queuedMap.queued, 3, enqueue.body);
    assert.equal(queuedMap.byChannel[stubChannelId]?.queued, 3, enqueue.body);
    const rows = await prisma.channelDelivery.findMany({ where: { journalId: j1 }, select: { channelId: true, kind: true, roomTypeId: true, ratePlanId: true, date: true, status: true } });
    assert.equal(rows.length, 3, `only the scoped products: ${JSON.stringify(rows)}`);
    for (const r of rows) {
      assert.deepEqual({ channelId: r.channelId, kind: r.kind, roomTypeId: r.roomTypeId, ratePlanId: r.ratePlanId }, { channelId: stubChannelId, kind: "rates", roomTypeId, ratePlanId: barPlanId });
      assert.ok(dates.includes(isoOf(r.date)), isoOf(r.date));
    }
    // (b) `queued` is stamped at enqueue (already `pushed` if the leader drained in between: a 15 s race, tolerated).
    const stamped = await journalState(j1);
    assert.equal(stamped.status, "published");
    assert.deepEqual(stamped.pushedTo, [stubChannelId]);
    if (rows.every((r) => r.status === "queued")) assert.equal(stamped.pushStatus, "queued", JSON.stringify(stamped));
    else assert.ok(["queued", "pushed"].includes(stamped.pushStatus), JSON.stringify(stamped));
    await drainChannel(stubChannelId);
    const confirmed = await pollJournalRows(j1, (all) => all.length === 3 && all.every((r) => r.status === "confirmed"));
    assert.ok(confirmed.every((r) => r.status === "confirmed"), JSON.stringify(confirmed));
    assert.equal((await journalState(j1)).pushStatus, "pushed");

    // (c) superseded: a queued publish replaced by a newer one before reaching the channel.
    const mid = await publish([J(19)], JUNE_PRICE + 30, [stubChannelId], "sustituido");
    assert.equal(mid.queued[stubChannelId], 1, JSON.stringify(mid));
    await parkOutOfLeaderReach(mid.journalId, stubChannelId, 1);
    assert.equal((await journalState(mid.journalId)).pushStatus, "queued");
    const next = await publish([J(19)], JUNE_PRICE + 31, [stubChannelId], "sustituye");
    assert.equal(next.queued[stubChannelId], 1, JSON.stringify(next));
    const midRows = await prisma.channelDelivery.findMany({ where: { journalId: mid.journalId }, select: { status: true } });
    assert.deepEqual(midRows.map((r) => r.status), ["superseded"], "the parked intermediate row is replaced");
    assert.equal((await journalState(mid.journalId)).pushStatus, "superseded", "every row of the entry was replaced");
    await drainChannel(stubChannelId);
    await pollJournalRows(next.journalId, (all) => all.length === 1 && all[0]!.status === "confirmed");
    assert.equal((await journalState(next.journalId)).pushStatus, "pushed");
    assert.equal((await journalState(mid.journalId)).pushStatus, "superseded", "a replaced entry never becomes pushed");

    // (d) a publish that queues nothing (same value already on the channel) leaves its entry draft.
    const same = await publish([J(19)], JUNE_PRICE + 31, [stubChannelId], "mismo valor");
    assert.equal(same.queued[stubChannelId], 0, JSON.stringify(same));
    assert.deepEqual(await journalState(same.journalId), { status: "draft", pushStatus: "draft", pushedTo: [] }, "nothing was sent: no `published`/`queued` stamp");
  });

  it("publishing back the CONFIRMED value while an intermediate one is still queued retires the intermediate row, queues nothing new and the cell reads confirmed, not stale (outbox-drain#1)", async () => {
    const date = J(17);
    const confirmedPrice = JUNE_PRICE + 5; // confirmed by the previous case
    assert.equal(await gridPrice(date), confirmedPrice);
    assert.equal((await syncState(date, stubChannelId)).status, "confirmed");
    const mid = await publish([date], confirmedPrice + 25, [stubChannelId], "intermedio");
    const [midId] = await parkOutOfLeaderReach(mid.journalId, stubChannelId, 1);
    const back = await publish([date], confirmedPrice, [stubChannelId], "vuelta al confirmado");
    assert.equal(back.queued[stubChannelId], 0, `the channel already holds this value: ${JSON.stringify(back)}`);
    assert.equal((await rowState(midId!))?.status, "superseded", "the intermediate value must never reach the channel");
    assert.equal((await journalState(mid.journalId)).pushStatus, "superseded");
    assert.equal((await journalState(back.journalId)).pushStatus, "draft");
    assert.equal((await syncState(date, stubChannelId)).status, "confirmed", "the live delivery is the confirmed one and it matches the grid");
    assert.equal(await gridPrice(date), confirmedPrice);
  });

  it("after the revert of a published entry the cell reads `stale` (the channel keeps the reverted value) and summary counts it; re-publishing queues it and confirms it again (browser-ux#7)", async () => {
    const date = J(18);
    const before = await gridPrice(date);
    const j = await publish([date], JUNE_PRICE + 40, [stubChannelId], "a revertir");
    await drainChannel(stubChannelId);
    await pollJournalRows(j.journalId, (all) => all.length === 1 && all[0]!.status === "confirmed");
    assert.equal((await syncState(date, stubChannelId)).status, "confirmed");

    const revert = await app.inject({ method: "POST", url: `/properties/${PROPERTY_ID}/rate-journal/${j.journalId}/revert`, headers, payload: {} });
    assert.equal(revert.statusCode, 200, revert.body);
    const inverseId = (JSON.parse(revert.body) as { journalId: string }).journalId;
    journalIds.add(inverseId);
    assert.equal(await gridPrice(date), before);
    const stale = await syncState(date, stubChannelId);
    assert.equal(stale.status, "stale", `the channel still holds ${JUNE_PRICE + 40}: ${JSON.stringify(stale)}`);
    assert.ok((stale.summary[stubChannelId]?.stale ?? 0) >= 1, JSON.stringify(stale.summary));
    // The channel-manager route paints the same state.
    const cm = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/channels/sync-status?from=${date}&to=${date}&channelIds=${stubChannelId}`, headers });
    assert.equal(cm.statusCode, 200, cm.body);
    const cmCell = (JSON.parse(cm.body) as SyncStatus).cells.find((c) => c.ratePlanId === barPlanId && c.date === date);
    assert.equal(cmCell?.byChannel[stubChannelId]?.status, "stale", cm.body);

    // Re-publishing the reverted value (the editor's «Enviar a canales») re-queues the older confirmed row.
    const push = await app.inject({
      method: "POST",
      url: `/properties/${PROPERTY_ID}/rate-grid/push`,
      headers,
      payload: { from: date, to: date, channelIds: [stubChannelId], roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId], kinds: ["rates"], journalId: inverseId }
    });
    assert.equal(push.statusCode, 200, push.body);
    assert.equal((JSON.parse(push.body) as { queued: number }).queued, 1, push.body);
    assert.ok(["queued", "sending", "confirmed"].includes((await syncState(date, stubChannelId)).status));
    await drainChannel(stubChannelId);
    assert.equal(await pollSync(date, stubChannelId, "confirmed"), "confirmed");
    assert.equal((await journalState(inverseId)).pushStatus, "pushed");
  });

  it("drain candidates in UTC: a `timeout` row due in 5 minutes is not taken, a due one is; a stale `sending` row a later confirmed delivery overtook is retired as superseded (outbox-drain#2/#3)", async () => {
    // (g) the retry instant is compared as UTC wall clock (it used to look due 2 h early through the session TimeZone).
    const later = await insertStubRow({ date: J(20), status: "timeout", label: "timeout-later", amount: 120, attempts: 1 });
    await prisma.$executeRaw`UPDATE channel_deliveries SET next_retry_at = (now() at time zone 'utc') + interval '5 minutes' WHERE id = ${later}`;
    await drainChannel(stubChannelId);
    assert.deepEqual(await rowState(later), { status: "timeout", attempts: 1 }, "a retry due in 5 minutes must not be claimed");
    await prisma.$executeRaw`UPDATE channel_deliveries SET next_retry_at = (now() at time zone 'utc') - interval '1 minute' WHERE id = ${later}`;
    await drainChannel(stubChannelId);
    let sent = await rowState(later);
    for (let i = 0; i < 20 && sent?.status !== "confirmed"; i++) {
      await sleep(1000);
      sent = await rowState(later);
    }
    assert.deepEqual(sent, { status: "confirmed", attempts: 2 }, "a due retry is claimed and confirmed by the stub");

    // (h) a worker died with the row `sending` 11 minutes ago, but a newer delivery of the cell was confirmed meanwhile.
    const now = Date.now();
    const stuck = await insertStubRow({ date: J(21), status: "sending", label: "sending-stale", amount: 121, attempts: 1, createdAt: new Date(now - 20 * 60_000) });
    await prisma.$executeRaw`UPDATE channel_deliveries SET updated_at = (now() at time zone 'utc') - interval '11 minutes' WHERE id = ${stuck}`;
    const newer = await insertStubRow({ date: J(21), status: "confirmed", label: "confirmed-newer", amount: 122, attempts: 1, createdAt: new Date(now - 60_000) });
    const summary = await drainChannel(stubChannelId);
    assert.equal((await rowState(stuck))?.status, "superseded", "an obsolete payload must never be re-sent after the current one");
    assert.ok(summary.retiredObsolete >= 1, `retiredObsolete expected in the summary (the leader :3000 may have retired it first, a 15 s race): ${JSON.stringify(summary)}`);
    assert.deepEqual(await rowState(newer), { status: "confirmed", attempts: 1 });
  });

  it("retention: an unscoped drain purges `superseded` rows older than CHANNEL_DELIVERY_RETENTION_DAYS, keeps recent ones and runs at most once per hour per process (CSC-05)", async () => {
    const retentionDays = readChannelEnv().deliveryRetentionDays;
    const old = await insertStubRow({ date: J(22), status: "superseded", label: "superseded-old", amount: 130 });
    await prisma.$executeRaw`UPDATE channel_deliveries SET updated_at = (now() at time zone 'utc') - make_interval(days => ${retentionDays + 10}::int) WHERE id = ${old}`;
    const recent = await insertStubRow({ date: J(22), status: "superseded", label: "superseded-recent", amount: 131 });
    resetDrainBuckets(); // the earlier unscoped drain of this process already purged once this hour
    const first = await app.inject({ method: "POST", url: "/channel-manager/deliveries/drain", headers, payload: {} });
    assert.equal(first.statusCode, 200, first.body);
    const purged = (JSON.parse(first.body) as DrainSummaryDTO).purgedSuperseded;
    assert.equal(typeof purged, "number", `the unscoped pass must run the purge: ${first.body.slice(0, 300)}`);
    assert.equal(await prisma.channelDelivery.findUnique({ where: { id: old } }), null, "a superseded row beyond the retention window is deleted");
    assert.equal((await rowState(recent))?.status, "superseded", "a recent superseded row stays (the planner may re-queue it)");
    const second = await app.inject({ method: "POST", url: "/channel-manager/deliveries/drain", headers, payload: {} });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((JSON.parse(second.body) as DrainSummaryDTO).purgedSuperseded, null, "at most one purge per hour per process");
  });

  it("DELETE /channel-manager/channels/:id: 409 CHANNEL_HAS_PENDING_DELIVERIES while rows are pending; then 200 archived, hidden from the property's channel list, and POST of the same providerCode revives it (browser-ux#13)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/channel-manager/channels",
      headers,
      payload: { propertyId: PROPERTY_ID, providerCode: REVIVE_PROVIDER, name: `${MARK} canal a archivar`, mode: "stub", status: "active", credentials: { webhookSecret: WEBHOOK_SECRET } }
    });
    assert.equal(created.statusCode, 200, created.body);
    const channelId = (JSON.parse(created.body) as { id: string }).id;
    extraChannelIds.push(channelId);
    const mapping = await app.inject({ method: "POST", url: `/channel-manager/channels/${channelId}/product-mappings`, headers, payload: { roomTypeId, ratePlanId: barPlanId, externalRoomCode: "VR-DBL", externalRateCode: "RP-BAR-DBL" } });
    assert.equal(mapping.statusCode, 200, mapping.body);
    const enqueue = await app.inject({
      method: "POST",
      url: "/channel-manager/deliveries/enqueue",
      headers,
      payload: { propertyId: PROPERTY_ID, from: J(23), to: J(23), channelIds: [channelId], roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId], kinds: ["rates"] }
    });
    assert.equal(enqueue.statusCode, 200, enqueue.body);
    assert.equal((JSON.parse(enqueue.body) as { queued: number }).queued, 1, enqueue.body);
    const pending = await prisma.channelDelivery.findMany({ where: { channelId }, select: { id: true } });
    assert.equal(pending.length, 1);
    // Parked out of the leader's reach (`timeout` with a far retry is still pending for the archive).
    const parked = await prisma.channelDelivery.updateMany({ where: { id: pending[0]!.id, status: "queued" }, data: { status: "timeout", nextRetryAt: PARKED_RETRY_AT } });
    assert.equal(parked.count, 1, "the leader :3000 drained the row before it could be parked (a 15 s race)");

    const refused = await app.inject({ method: "DELETE", url: `/channel-manager/channels/${channelId}`, headers });
    assert.equal(refused.statusCode, 409, refused.body);
    const refusedBody = JSON.parse(refused.body) as ErrorBody;
    assert.equal(refusedBody.details?.code, "CHANNEL_HAS_PENDING_DELIVERIES");
    assert.equal(refusedBody.details?.pending, 1);
    assert.equal((await prisma.channel.findUnique({ where: { id: channelId }, select: { status: true } }))?.status, "active", "a refused archive changes nothing");

    // Nothing pending any more (the value was replaced) → archived, history kept.
    await prisma.channelDelivery.update({ where: { id: pending[0]!.id }, data: { status: "superseded", nextRetryAt: null } });
    const archived = await app.inject({ method: "DELETE", url: `/channel-manager/channels/${channelId}`, headers });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.deepEqual(JSON.parse(archived.body), { id: channelId, providerCode: REVIVE_PROVIDER, status: "archived", keptDeliveries: 1 });
    assert.equal(await prisma.channelDelivery.count({ where: { channelId } }), 1, "logical delete: the deliveries stay as history");
    const list = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/channels`, headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(!(JSON.parse(list.body) as { channels: ChannelRow[] }).channels.some((c) => c.id === channelId), "an archived channel leaves the editor list");
    const grid = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-grid?from=${J(23)}&to=${J(23)}&roomTypeIds=${roomTypeId}`, headers });
    assert.ok(!(JSON.parse(grid.body) as { channels: ChannelRow[] }).channels.some((c) => c.id === channelId), "nor the grid");
    const detail = await app.inject({ method: "GET", url: `/channel-manager/channels/${channelId}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal((JSON.parse(detail.body) as ChannelRow).status, "archived");
    const again = await app.inject({ method: "DELETE", url: `/channel-manager/channels/${channelId}`, headers });
    assert.equal(again.statusCode, 200, `archiving twice is idempotent: ${again.body}`);

    // The same provider again revives the archived row (unique (propertyId, providerCode)), history attached.
    const revived = await app.inject({
      method: "POST",
      url: "/channel-manager/channels",
      headers,
      payload: { propertyId: PROPERTY_ID, providerCode: REVIVE_PROVIDER, name: `${MARK} canal revivido`, mode: "stub", status: "active", credentials: { webhookSecret: WEBHOOK_SECRET } }
    });
    assert.equal(revived.statusCode, 200, revived.body);
    const revivedBody = JSON.parse(revived.body) as ChannelRow & { name: string };
    assert.equal(revivedBody.id, channelId, "the archived row is revived, not duplicated");
    assert.equal(revivedBody.status, "active");
    assert.equal(revivedBody.name, `${MARK} canal revivido`);
    const listed = await app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/channels`, headers });
    assert.ok((JSON.parse(listed.body) as { channels: ChannelRow[] }).channels.some((c) => c.id === channelId), "back in the editor list");
    assert.equal(await prisma.channelDelivery.count({ where: { channelId } }), 1, "the history is still attached");
  });
});
