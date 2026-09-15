/**
 * Rate grid v2 · integration (REAL HTTP via app.inject, Postgres required).
 *
 * Exercises the canonical rate-manager backend end to end on the demo
 * property (prop_123 / org_123): grid read, bulk-update with ops + journal,
 * idempotent retry (clientRequestId), derived plan materialisation + write
 * conflict (409 when every cell conflicts), ops applied before cells,
 * availability through the "*" sentinel, channel price override → 400,
 * recommendations/apply in cell form, revert (also after a publish), the 400
 * for an impossible calendar day, and (fix:tests, 2026-09-15) the cases the
 * concurrency/tenancy audit found uncovered:
 *   · sync-status on a window WITHOUT deliveries → `cells: []`, `summary: {}`
 *     (the old assertion only checked Array.isArray on the window the publish
 *     test had just filled);
 *   · ids of ANOTHER property in cells / ops / publish / push / query → 400
 *     UNKNOWN_IDS (or 400 NO_CELLS for an op that expands to nothing), a
 *     foreign channel → 404, a foreign journal → 404 and untouched;
 *   · journal cursor: garbage / repeated → 400, real pagination round-trip;
 *   · restriction precedence over HTTP ("*" < plan < plan+channel, flags
 *     OR-ed) and deletion of a RestrictionDay row that ends up empty;
 *   · two CONCURRENT bulk-updates on the same cell: both succeed and the
 *     journals chain (`before` of the later = `after` of the earlier);
 *   · a revert that would overwrite a LATER edit → 409 JOURNAL_STALE, nothing
 *     written; `force: true` reverts anyway (CSC-02);
 *   · `respectManualOverrides: false` overwrites a manual child cell and the
 *     revert of that entry restores the override (CSC-03);
 *   · a derivation that yields 0 € never materialises (no fake 0) and is
 *     reported as a conflict (CSC-07);
 *   · bulk-update without a session → 401 exactly (never 403);
 * and (cierre:tests, 2026-09-15, window 2027-06-01..15) the contract of the
 * closing lotes:
 *   · ops + cells on the SAME cell → ONE journal item (before = original,
 *     after = final) and the revert restores the ORIGINAL (api-live-contract#1);
 *   · `cells[].expected.price` → 409 ALL_CELLS_CONFLICT «la celda cambió desde
 *     que se cargó» / 200 with `conflicts[]` (browser-ux#3);
 *   · two CONCURRENT retries with the same clientRequestId → one entry
 *     (unique (propertyId, clientRequestId), CSC-09); a repeated request WITH
 *     publish enqueues nothing again and warns «petición repetida» (docs#16);
 *   · ops expanding to more than 5.000 patches → 400 TOO_MANY_CELLS (CSC-10);
 *   · revertToDerived / convertToManual on a base plan → 409 (api-live-contract#3);
 *   · publishing one cell queues ONE delivery per channel (browser-ux#8) and
 *     the kinds follow the fields (stopSell on "*" → availability +
 *     restrictions; explicit `publish.kinds` wins);
 *   · the revert entry reads «Reversión: <motivo>[ — <texto>]» and links the
 *     reverted entry through `revertsJournalId` (browser-ux#17/#18);
 *   · recommendations: foreign roomTypeIds → 400 UNKNOWN_IDS
 *     (api-live-contract#6); apply after the bulk-update persists
 *     currentPrice / suggestedPrice / journalId, refuses a foreign journalId
 *     (400 UNKNOWN_IDS) and validates in Spanish (cierre contract 3);
 *   · rate plans: DERIVATION_CHAIN / DERIVATION_YIELDS_ZERO (CSC-13, CSC-07);
 *     a soft-deleted derived plan → 400 INACTIVE_RATE_PLANS on a direct write
 *     while the revert of an entry that wrote it still works (CSC-18).
 *
 * Everything the suite writes is removed in `after` (journals, deliveries of
 * those journals, recommendations, the BAR-NR plan and its rows, inventory and
 * restriction rows of the window, the fixtures created in prop_canary, the
 * RateDay rows restored field by field from a snapshot; the June window is put
 * back to its baseline, empty at the time of writing).
 *
 * Windows (prop_123, DBL × BAR has a RateDay every day of Nov 2026):
 *   FROM..TO (10..12) → the original cases; 13 concurrency; 14 stale revert;
 *   15 manual-override + derived-0; 24..26 → a window nobody publishes to.
 *   channel-outbox.test.mts (runs in parallel) uses 16..18.
 *   Cierre window 2027-06-01..15 (empty at baseline: the BAR × DBL rate days
 *   the cases need are created by `ensureJuneFixtures`, one day per case);
 *   channel-outbox.test.mts uses 2027-06-16..30.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/rate-grid-v2.test.mts"
 * (../../.env is loaded first so the seeded sandbox credentials decrypt, see below).
 *
 * Mounting: while server.ts still declares the legacy /properties/:id/rate-grid
 * routes, the v2 routes are mounted under a test prefix (with their manifest
 * entries pushed for the RBAC hook); once the integrator wires
 * `registerRateGridRoutes(app)` the suite detects the v2-only sync-status
 * route and uses the bare paths.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The seeded sandbox channels carry AES-GCM credentials encrypted with the
// repo's ENCRYPTION_KEY: load ../../.env first (existing variables are never
// overridden) so the publish cases see them `readyToPush` — with the fallback
// key below they read «faltan credenciales» and nothing is queued. Same rule as
// channel-outbox.test.mts; the defaults only apply on a machine without a .env.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Honest: no .env → the defaults below (a fresh CI database, no seeded credentials).
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerRateGridRoutes } = await import("../../apps/api/src/modules/rate-manager/rate-grid.routes.js");
const { rateGridRoutePermissions } = await import("../../apps/api/src/modules/rate-manager/route-permissions.partial.js");
const { applyDerivation } = await import("../../apps/api/src/modules/rate-manager/derivation.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const PROPERTY_ID = "prop_123";
const FROM = "2026-11-10";
const TO = "2026-11-12";
const DATES = ["2026-11-10", "2026-11-11", "2026-11-12"];
// One calendar day per concurrency/revert/derivation case so they never touch FROM..TO.
const DAY_CONCURRENT = "2026-11-13";
const DAY_STALE_REVERT = "2026-11-14";
const DAY_OVERRIDE = "2026-11-15";
// The RateDay snapshot (restored field by field in `after`) covers every day the suite writes.
const SNAPSHOT_FROM = FROM;
const SNAPSHOT_TO = DAY_OVERRIDE;
// A window no suite publishes to: sync-status must answer an EMPTY map there.
const QUIET_FROM = "2026-11-24";
const QUIET_TO = "2026-11-26";
// Cierre window (assigned to the tests lote): one calendar day per case, 100 € BAR fixture.
const JUNE_FROM = "2027-06-01";
const JUNE_TO = "2027-06-15";
const JUNE_PRICE = 100;
const J = (day: number): string => `2027-06-${String(day).padStart(2, "0")}`;
const dayUtc = (date: string): Date => new Date(`${date}T00:00:00Z`);
const isoOf = (d: Date): string => d.toISOString().slice(0, 10);
/** Temporary plans of the derivation cases (removed in `after` even after a crash). */
const TEMP_PLAN_PREFIX = "RGV2C-";
const MARK = "[rate-grid-v2 test]";
const BAR_NR_DERIVATION = { mode: "percent", value: -10, roundTo: 0.99 } as const;
// Cross-property fixtures live in the seed's second property of the SAME
// organisation (the confused-deputy case the global tenancy hook cannot see:
// the path property is fine, the ids inside the body are not).
const FOREIGN_PROPERTY_ID = "prop_canary";
const FOREIGN_CODE = "RGV2-FOREIGN";
const FOREIGN_PROVIDER = "rgv2-foreign";

let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com",
      password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo",
      deviceId: "integration-tests-rate-grid"
    }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

type Cell = {
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  basePrice: number | null;
  effectivePrice: number | null;
  source: string;
  derivedFrom: unknown;
  restrictions: Record<string, unknown>;
  inventory?: { available: number } | null;
  channelId?: string | null;
};
type Grid = { currency: string; roomTypes: Array<{ id: string; code: string; rooms: number }>; ratePlans: Array<{ id: string; code: string; derivation: unknown }>; channels: Array<{ id: string; providerCode: string; readyToPush: boolean }>; cells: Cell[] };
type BulkResponse = {
  journalId: string;
  updated: number;
  derivedUpdated: number;
  skippedManual: number;
  conflicts: Array<{ ratePlanId: string; roomTypeId: string; date: string; reason: string }>;
  skipped?: Array<{ ratePlanId: string; roomTypeId: string; date: string; reason: string }>;
  warnings?: string[];
  queued?: Record<string, number>;
  changesCount?: number;
};
type JournalItem = { ratePlanId: string; roomTypeId: string; date: string; channelId: string | null; field: string; before: unknown; after: unknown };
type JournalEntry = { id: string; timestamp: string; status: string; pushStatus: string; pushedTo: string[]; reason: string | null; changesCount: number; revertedByJournalId: string | null; revertsJournalId?: string | null; items: JournalItem[] };
type ApplyResponse = { applied: number; rejected: number; recorded: number; journalId: string | null; patches: Array<{ ratePlanId: string; roomTypeId: string; date: string; price?: number; expected?: { price?: number | null } }>; skipped: Array<{ reason: string }>; recommendationIds: string[] };
type DeliveryRow = { channelId: string; kind: string; roomTypeId: string; ratePlanId: string; date: Date; status: string; payloadJson: unknown };
type ErrorBody = { statusCode: number; message: string; details?: { code?: string; [k: string]: unknown } };
type ForeignFixtures = { ratePlanId: string; roomTypeId: string; channelId: string; journalId: string };
type RestrictionRow = { id: string; roomTypeId: string; ratePlanId: string; channelId: string; date: Date; minStay: number | null; maxStay: number | null; minStayThrough: number | null; closedToArrival: boolean; closedToDeparture: boolean; closed: boolean; stopSell: boolean; minAdvanceDays: number | null; maxAdvanceDays: number | null; restrictionSource: string; updatedBy: string | null };

const SANDBOX_PROVIDERS = ["booking_com", "expedia", "channex"];
const windowFilter = (from: string, to: string) => ({ gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) });
const restrictionKeyOf = (r: { roomTypeId: string; ratePlanId: string; channelId: string; date: Date }): string => `${r.roomTypeId}|${r.ratePlanId}|${r.channelId}|${r.date.toISOString().slice(0, 10)}`;

describe("rate grid v2 (app.inject, prop_123)", () => {
  let app: ApiApp;
  let prefix = "";
  let headers: Headers = {};
  let snapshot: Array<{ ratePlanId: string; roomTypeId: string; date: Date; price: unknown; source: string; manuallyOverridden: boolean; updatedBy: string | null; minPrice: unknown; maxPrice: unknown }> = [];
  let restrictionSnapshot: RestrictionRow[] = [];
  const journalIds = new Set<string>();
  let barPlanId = "";
  let roomTypeId = "";
  let nrPlanId: string | null = null;
  let firstJournalId = "";
  /** A seeded sandbox channel of prop_123 (never the stub the channel-outbox suite creates and deletes in parallel). */
  let sandboxChannelId = "";
  let publishedChannelId: string | null = null;
  let foreign: ForeignFixtures | null = null;
  const recommendationIds: string[] = [];
  let juneBaseline: Array<{ id: string; ratePlanId: string; roomTypeId: string; date: Date; price: unknown; source: string; manuallyOverridden: boolean; updatedBy: string | null; minPrice: unknown; maxPrice: unknown }> = [];
  let juneRestrictionBaseline = 0;
  let juneInventoryBaseline = 0;
  let juneReady = false;
  const url = (path: string): string => `${prefix}${path}`;

  async function getGrid(from: string, to: string, extra = ""): Promise<Grid> {
    const res = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${from}&to=${to}&roomTypeIds=${roomTypeId}${extra}`), headers });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as Grid;
  }

  /** One cell (plan × the suite's room type × day), optionally as a channel sees it. */
  async function getCell(date: string, ratePlanId = barPlanId, channelId?: string): Promise<Cell> {
    const grid = await getGrid(date, date, `&ratePlanIds=${ratePlanId}${channelId ? `&channelId=${channelId}` : ""}`);
    assert.equal(grid.cells.length, 1, JSON.stringify(grid.cells));
    return grid.cells[0]!;
  }

  async function bulk(payload: Record<string, unknown>): Promise<{ status: number; body: BulkResponse & ErrorBody; raw: string }> {
    const res = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`), headers, payload });
    const body = JSON.parse(res.body) as BulkResponse & ErrorBody;
    if (res.statusCode === 200) journalIds.add(body.journalId);
    return { status: res.statusCode, body, raw: res.body };
  }

  /** bulk-update that must succeed; returns the journal id. */
  async function write(payload: Record<string, unknown>): Promise<BulkResponse> {
    const res = await bulk(payload);
    assert.equal(res.status, 200, res.raw);
    return res.body;
  }

  async function revert(journalId: string, body?: Record<string, unknown>): Promise<{ status: number; body: BulkResponse & ErrorBody; raw: string }> {
    const res = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-journal/${journalId}/revert`), headers, ...(body ? { payload: body } : {}) });
    const parsed = JSON.parse(res.body) as BulkResponse & ErrorBody;
    if (res.statusCode === 200) journalIds.add(parsed.journalId);
    return { status: res.statusCode, body: parsed, raw: res.body };
  }

  async function revertOk(journalId: string, body?: Record<string, unknown>): Promise<BulkResponse> {
    const res = await revert(journalId, body);
    assert.equal(res.status, 200, res.raw);
    return res.body;
  }

  async function journalEntry(journalId: string): Promise<JournalEntry> {
    const res = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${journalId}`), headers });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as JournalEntry;
  }

  /** BAR × DBL rate days of the cierre window (100 €), created once the grid case discovered the ids; a baseline row of a day is kept as it is. */
  async function ensureJuneFixtures(): Promise<void> {
    if (juneReady) return;
    assert.ok(barPlanId && roomTypeId, "the grid case discovers the BAR plan and the room type first");
    for (let day = 1; day <= 14; day++) {
      const date = J(day);
      if (juneBaseline.some((r) => r.ratePlanId === barPlanId && r.roomTypeId === roomTypeId && isoOf(r.date) === date)) continue;
      await prisma.rateDay.create({ data: { propertyId: PROPERTY_ID, ratePlanId: barPlanId, roomTypeId, date: dayUtc(date), price: JUNE_PRICE, currency: "EUR", source: "manual" } });
    }
    juneReady = true;
  }

  /** The three seeded sandbox channels of prop_123 (booking_com / expedia / channex), all ready to push. */
  async function sandboxChannelIds(): Promise<string[]> {
    const grid = await getGrid(JUNE_FROM, JUNE_FROM);
    const ids = grid.channels.filter((c) => SANDBOX_PROVIDERS.includes(c.providerCode) && c.readyToPush).map((c) => c.id);
    assert.equal(ids.length, SANDBOX_PROVIDERS.length, `the seeded sandbox channels must be ready to push: ${JSON.stringify(grid.channels)}`);
    return ids;
  }

  const journalsWithReason = (reason: string): Promise<number> => prisma.rateChangeJournal.count({ where: { propertyId: PROPERTY_ID, reason } });
  const deliveriesOf = (journalId: string): Promise<DeliveryRow[]> =>
    prisma.channelDelivery.findMany({ where: { journalId }, select: { channelId: true, kind: true, roomTypeId: true, ratePlanId: true, date: true, status: true, payloadJson: true }, orderBy: [{ channelId: "asc" }, { kind: "asc" }] });

  async function removeForeignFixtures(): Promise<void> {
    await prisma.rateChangeJournal.deleteMany({ where: { propertyId: FOREIGN_PROPERTY_ID, reason: { contains: MARK } } });
    await prisma.channel.deleteMany({ where: { propertyId: FOREIGN_PROPERTY_ID, providerCode: FOREIGN_PROVIDER } });
    await prisma.roomType.deleteMany({ where: { propertyId: FOREIGN_PROPERTY_ID, code: FOREIGN_CODE } });
    await prisma.ratePlan.deleteMany({ where: { propertyId: FOREIGN_PROPERTY_ID, code: FOREIGN_CODE } });
  }

  /** Rows of another property that every body/query must refuse (created here, removed in `after`). */
  async function createForeignFixtures(): Promise<ForeignFixtures | null> {
    const property = await prisma.property.findUnique({ where: { id: FOREIGN_PROPERTY_ID }, select: { id: true } });
    if (!property) return null;
    await removeForeignFixtures(); // leftovers of a crashed run
    const [ratePlan, roomType, channel, journal] = await Promise.all([
      prisma.ratePlan.create({ data: { propertyId: FOREIGN_PROPERTY_ID, code: FOREIGN_CODE, name: `${MARK} plan ajeno`, ratePlanType: "bar" }, select: { id: true } }),
      prisma.roomType.create({ data: { propertyId: FOREIGN_PROPERTY_ID, code: FOREIGN_CODE, name: `${MARK} tipo ajeno`, maxOccupancy: 2, baseCapacity: 2 }, select: { id: true } }),
      prisma.channel.create({ data: { propertyId: FOREIGN_PROPERTY_ID, providerCode: FOREIGN_PROVIDER, name: `${MARK} canal ajeno`, channelType: "ota", status: "active", mode: "stub" }, select: { id: true } }),
      prisma.rateChangeJournal.create({ data: { propertyId: FOREIGN_PROPERTY_ID, userId: "usr_123", changesCount: 0, changesJson: {}, reason: `${MARK} journal ajeno` }, select: { id: true } })
    ]);
    return { ratePlanId: ratePlan.id, roomTypeId: roomType.id, channelId: channel.id, journalId: journal.id };
  }

  before(async () => {
    app = await buildApiServer();
    const wired = app.hasRoute({ method: "GET", url: "/properties/:propertyId/rate-grid/sync-status" });
    if (!wired) {
      prefix = "/__rate-grid-v2";
      routePermissionManifest.push(...rateGridRoutePermissions.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
      await app.register(async (sub) => registerRateGridRoutes(sub), { prefix });
    }
    await app.ready();
    const session = await loginDemo(app);
    headers = session ? { authorization: `Bearer ${session.token}` } : {};
    snapshot = await prisma.rateDay.findMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(SNAPSHOT_FROM, SNAPSHOT_TO) } });
    restrictionSnapshot = (await prisma.restrictionDay.findMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(SNAPSHOT_FROM, SNAPSHOT_TO) } })) as RestrictionRow[];
    foreign = await createForeignFixtures();
    juneBaseline = await prisma.rateDay.findMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
    juneRestrictionBaseline = await prisma.restrictionDay.count({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
    juneInventoryBaseline = await prisma.inventoryDay.count({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
  });

  after(async () => {
    try {
      // Restore the BAR cells field by field (the revert tests already restore the price; this covers a failed run).
      for (const row of snapshot) {
        await prisma.rateDay.update({
          where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: PROPERTY_ID, ratePlanId: row.ratePlanId, roomTypeId: row.roomTypeId, date: row.date } },
          data: {
            price: row.price as never,
            source: row.source,
            manuallyOverridden: row.manuallyOverridden,
            updatedBy: row.updatedBy,
            minPrice: row.minPrice as never,
            maxPrice: row.maxPrice as never
          }
        });
      }
      // Cierre window: the deliveries and the rows the cases wrote are the suite's; the rate days go back to the baseline.
      await prisma.channelDelivery.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
      await prisma.rateDay.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO), id: { notIn: juneBaseline.map((r) => r.id) } } });
      for (const row of juneBaseline) {
        const { id: _id, ...columns } = row;
        await prisma.rateDay.upsert({
          where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: PROPERTY_ID, ratePlanId: row.ratePlanId, roomTypeId: row.roomTypeId, date: row.date } },
          create: { propertyId: PROPERTY_ID, currency: "EUR", ...columns, price: row.price as never, minPrice: row.minPrice as never, maxPrice: row.maxPrice as never },
          update: { ...columns, price: row.price as never, minPrice: row.minPrice as never, maxPrice: row.maxPrice as never }
        });
      }
      if (juneRestrictionBaseline === 0) await prisma.restrictionDay.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
      if (juneInventoryBaseline === 0) await prisma.inventoryDay.deleteMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(JUNE_FROM, JUNE_TO) } });
      await prisma.ratePlan.deleteMany({ where: { propertyId: PROPERTY_ID, code: { startsWith: TEMP_PLAN_PREFIX } } });
      if (nrPlanId) {
        await prisma.rateDay.deleteMany({ where: { propertyId: PROPERTY_ID, ratePlanId: nrPlanId } });
        await prisma.restrictionDay.deleteMany({ where: { propertyId: PROPERTY_ID, ratePlanId: nrPlanId } });
        await prisma.ratePlan.deleteMany({ where: { id: nrPlanId, propertyId: PROPERTY_ID } });
      }
      await prisma.inventoryDay.deleteMany({ where: { propertyId: PROPERTY_ID, roomTypeId, date: windowFilter(SNAPSHOT_FROM, SNAPSHOT_TO) } });
      // Restriction rows: drop what the suite created, put back what existed (column by column).
      const kept = new Map(restrictionSnapshot.map((r) => [restrictionKeyOf(r), r]));
      const current = await prisma.restrictionDay.findMany({ where: { propertyId: PROPERTY_ID, date: windowFilter(SNAPSHOT_FROM, SNAPSHOT_TO) }, select: { id: true, roomTypeId: true, ratePlanId: true, channelId: true, date: true } });
      for (const row of current) if (!kept.has(restrictionKeyOf(row))) await prisma.restrictionDay.delete({ where: { id: row.id } });
      for (const row of restrictionSnapshot) {
        const { id: _id, ...columns } = row;
        await prisma.restrictionDay.upsert({
          where: { propertyId_roomTypeId_ratePlanId_channelId_date: { propertyId: PROPERTY_ID, roomTypeId: row.roomTypeId, ratePlanId: row.ratePlanId, channelId: row.channelId, date: row.date } },
          create: { propertyId: PROPERTY_ID, ...columns },
          update: columns
        });
      }
      if (recommendationIds.length > 0) await prisma.revenueRecommendation.deleteMany({ where: { propertyId: PROPERTY_ID, id: { in: recommendationIds } } });
      if (journalIds.size > 0) {
        await prisma.channelDelivery.deleteMany({ where: { propertyId: PROPERTY_ID, journalId: { in: [...journalIds] } } });
        await prisma.rateChangeJournal.deleteMany({ where: { propertyId: PROPERTY_ID, id: { in: [...journalIds] } } });
      }
      // Journals the suite created but never captured (a failed assertion mid-request) — reverts quote the original reason.
      await prisma.rateChangeJournal.deleteMany({ where: { propertyId: PROPERTY_ID, reason: { contains: MARK } } });
      await removeForeignFixtures();
    } finally {
      if (app) await app.close();
      await prisma.$disconnect();
    }
  });

  it("GET rate-grid with from=2026-13-99 → 400", async () => {
    const res = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=2026-13-99&to=2026-12-01`), headers });
    assert.equal(res.statusCode, 400, res.body);
  });

  it("GET rate-grid returns one cell per (plan, type, day) with numeric basePrice where rate_days exist", async () => {
    const res = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}`), headers });
    assert.equal(res.statusCode, 200, res.body);
    const grid = JSON.parse(res.body) as Grid;
    assert.equal(grid.currency, "EUR");
    assert.ok(Array.isArray(grid.channels));
    const bar = grid.ratePlans.find((p) => p.code === "BAR");
    assert.ok(bar, "prop_123 must have a BAR plan (db:seed:commercial)");
    barPlanId = bar.id;
    assert.deepEqual(bar.derivation, { mode: "none", value: 0 });
    assert.equal(grid.cells.length, grid.roomTypes.length * grid.ratePlans.length * DATES.length);
    const barCells = grid.cells.filter((c) => c.ratePlanId === barPlanId);
    const priced = barCells.filter((c) => typeof c.basePrice === "number");
    assert.ok(priced.length > 0, "expected rate_days for BAR in the window");
    roomTypeId = priced[0]!.roomTypeId;
    for (const cell of priced) {
      assert.equal(cell.effectivePrice, cell.basePrice);
      assert.equal(typeof cell.restrictions, "object");
      assert.equal(cell.source, "manual");
    }
    // Stable order: room type, plan, date.
    assert.deepEqual(barCells.filter((c) => c.roomTypeId === roomTypeId).map((c) => c.date), DATES);
    sandboxChannelId = grid.channels.find((c) => SANDBOX_PROVIDERS.includes(c.providerCode))?.id ?? "";
    assert.ok(sandboxChannelId, "prop_123 must have a seeded sandbox channel (channels:seed-sandbox)");
  });

  it("bulk-update: op percent +10 % on 3 days × 1 type → journal with before/after and cells change", async () => {
    assert.ok(headers.authorization, "demo login (reception@example.com) required for a critical route");
    const before = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    const beforeCells = (JSON.parse(before.body) as Grid).cells;
    const clientRequestId = `rgv2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const res = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: {
        ops: [{ scope: { from: FROM, to: TO, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, price: { mode: "percent", value: 10 } }],
        reason: `${MARK} +10 % evento`,
        clientRequestId
      }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { journalId: string; updated: number; derivedUpdated: number; skippedManual: number; conflicts: unknown[] };
    journalIds.add(body.journalId);
    firstJournalId = body.journalId;
    assert.equal(body.updated, 3);
    assert.equal(body.conflicts.length, 0);

    const journal = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}`), headers });
    assert.equal(journal.statusCode, 200, journal.body);
    const entry = JSON.parse(journal.body) as { status: string; reason: string; changesCount: number; userEmail: string | null; items: Array<{ field: string; before: unknown; after: unknown; date: string }> };
    assert.equal(entry.status, "draft");
    assert.equal(entry.changesCount, 3);
    assert.equal(entry.items.length, 3);
    for (const item of entry.items) {
      assert.equal(item.field, "price");
      const prev = beforeCells.find((c) => c.date === item.date)!.basePrice as number;
      assert.equal(item.before, prev);
      assert.equal(item.after, Math.round(prev * 1.1 * 100) / 100);
    }

    const after = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    const afterCells = (JSON.parse(after.body) as Grid).cells;
    for (const cell of afterCells) {
      const prev = beforeCells.find((c) => c.date === cell.date)!.basePrice as number;
      assert.equal(cell.basePrice, Math.round(prev * 1.1 * 100) / 100);
    }

    // Idempotent retry: same clientRequestId → same journal, prices not compounded.
    const retry = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: {
        ops: [{ scope: { from: FROM, to: TO, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, price: { mode: "percent", value: 10 } }],
        reason: `${MARK} +10 % evento`,
        clientRequestId
      }
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((JSON.parse(retry.body) as { journalId: string }).journalId, body.journalId);
    const again = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    assert.deepEqual((JSON.parse(again.body) as Grid).cells.map((c) => c.basePrice), afterCells.map((c) => c.basePrice));

    const list = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?limit=5`), headers });
    assert.equal(list.statusCode, 200, list.body);
    const page = JSON.parse(list.body) as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.ok(page.items.some((i) => i.id === body.journalId));
  });

  it("derived plan BAR-NR (BAR −10 %, roundTo 0.99) materialises and rejects a direct write", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/properties/${PROPERTY_ID}/rate-plans`,
      headers,
      payload: { code: "BAR-NR", name: `${MARK} No reembolsable`, ratePlanType: "derived", parentRatePlanId: barPlanId, derivationJson: BAR_NR_DERIVATION }
    });
    assert.equal(create.statusCode, 200, create.body);
    const plan = JSON.parse(create.body) as { id: string; derivation: unknown };
    nrPlanId = plan.id;
    assert.deepEqual(plan.derivation, BAR_NR_DERIVATION);

    // A "derived" plan without parent (and vice versa) is a 400.
    const badPlan = await app.inject({ method: "POST", url: `/properties/${PROPERTY_ID}/rate-plans`, headers, payload: { code: "BAD-NR", name: "x", ratePlanType: "derived" } });
    assert.equal(badPlan.statusCode, 400, badPlan.body);

    const rederive = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-plans/${nrPlanId}/rederive?from=${FROM}&to=${TO}`), headers });
    assert.equal(rederive.statusCode, 200, rederive.body);
    const red = JSON.parse(rederive.body) as { journalId: string; derivedUpdated: number };
    journalIds.add(red.journalId);
    assert.ok(red.derivedUpdated >= 3, `expected ≥3 materialised cells, got ${red.derivedUpdated}`);

    const grid = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}&roomTypeIds=${roomTypeId}`), headers });
    const cells = (JSON.parse(grid.body) as Grid).cells;
    const bar = cells.filter((c) => c.ratePlanId === barPlanId);
    const nr = cells.filter((c) => c.ratePlanId === nrPlanId);
    assert.equal(nr.length, 3);
    for (const cell of nr) {
      const parent = bar.find((c) => c.date === cell.date)!;
      assert.equal(cell.source, "derived");
      assert.ok(cell.derivedFrom);
      assert.equal(cell.basePrice, applyDerivation(parent.basePrice as number, BAR_NR_DERIVATION));
      assert.ok(String(cell.basePrice).endsWith(".99"), `psychological rounding expected, got ${cell.basePrice}`);
    }

    const direct = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: { cells: [{ ratePlanId: nrPlanId, roomTypeId, date: FROM, price: 1 }], reason: `${MARK} escritura directa en derivado` }
    });
    // Every patch conflicts → 409 ALL_CELLS_CONFLICT, nothing written, no journal entry.
    assert.equal(direct.statusCode, 409, direct.body);
    const directBody = JSON.parse(direct.body) as { details: { code: string; conflicts: Array<{ ratePlanId: string; reason: string }> } };
    assert.equal(directBody.details.code, "ALL_CELLS_CONFLICT");
    assert.equal(directBody.details.conflicts.length, 1);
    assert.equal(directBody.details.conflicts[0]!.ratePlanId, nrPlanId);
    assert.match(directBody.details.conflicts[0]!.reason, /convertToManual/);
    // Partial conflict (one derived cell + one valid BAR cell with its current price) stays a 200 with conflicts[].
    const partial = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: { cells: [{ ratePlanId: nrPlanId, roomTypeId, date: FROM, price: 1 }, { ratePlanId: barPlanId, roomTypeId, date: TO, price: bar.find((c) => c.date === TO)!.basePrice }], reason: `${MARK} conflicto parcial` }
    });
    assert.equal(partial.statusCode, 200, partial.body);
    const partialBody = JSON.parse(partial.body) as { journalId: string; conflicts: unknown[] };
    journalIds.add(partialBody.journalId);
    assert.equal(partialBody.conflicts.length, 1);
    const unchanged = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${FROM}&roomTypeIds=${roomTypeId}&ratePlanIds=${nrPlanId}`), headers });
    assert.equal((JSON.parse(unchanged.body) as Grid).cells[0]!.basePrice, nr[0]!.basePrice);

    // Parent edit re-materialises the child (derivedUpdated) — and the child follows.
    const parentEdit = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: { cells: [{ ratePlanId: barPlanId, roomTypeId, date: FROM, price: 200 }], reason: `${MARK} padre a 200` }
    });
    assert.equal(parentEdit.statusCode, 200, parentEdit.body);
    const pe = JSON.parse(parentEdit.body) as { journalId: string; updated: number; derivedUpdated: number };
    journalIds.add(pe.journalId);
    assert.equal(pe.updated, 1);
    assert.equal(pe.derivedUpdated, 1);
    const child = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${FROM}&roomTypeIds=${roomTypeId}&ratePlanIds=${nrPlanId}`), headers });
    assert.equal((JSON.parse(child.body) as Grid).cells[0]!.basePrice, 179.99);
    // Undo the parent edit through the journal so the next test starts from the +10 % state.
    const undo = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-journal/${pe.journalId}/revert`), headers });
    assert.equal(undo.statusCode, 200, undo.body);
    journalIds.add((JSON.parse(undo.body) as { journalId: string }).journalId);
  });

  it("revert of the +10 % journal restores the original prices and marks the entry reverted", async () => {
    const original = snapshot.filter((r) => r.ratePlanId === barPlanId && r.roomTypeId === roomTypeId);
    const res = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-journal/${firstJournalId}/revert`), headers });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { journalId: string; updated: number };
    journalIds.add(body.journalId);
    assert.equal(body.updated, 3);

    const grid = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    for (const cell of (JSON.parse(grid.body) as Grid).cells) {
      const row = original.find((r) => r.date.toISOString().slice(0, 10) === cell.date)!;
      assert.equal(cell.basePrice, Number(row.price));
    }
    const entry = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${firstJournalId}`), headers });
    const parsed = JSON.parse(entry.body) as { status: string; revertedByJournalId: string | null };
    assert.equal(parsed.status, "reverted");
    assert.equal(parsed.revertedByJournalId, body.journalId);
    const inverse = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}`), headers });
    assert.equal((JSON.parse(inverse.body) as { status: string }).status, "published");

    // Second revert of the same entry → 409.
    const twice = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-journal/${firstJournalId}/revert`), headers });
    assert.equal(twice.statusCode, 409, twice.body);
  });

  it("ops are applied before cells: a manual cell edit wins over a bulk op on the same cell", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: {
        ops: [{ scope: { from: FROM, to: TO, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, price: { mode: "set", value: 100 } }],
        cells: [{ ratePlanId: barPlanId, roomTypeId, date: FROM, price: 123 }],
        reason: `${MARK} op set 100 + celda 123`
      }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { journalId: string; updated: number; conflicts: unknown[] };
    journalIds.add(body.journalId);
    assert.equal(body.conflicts.length, 0);
    const grid = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${TO}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    const byDate = new Map((JSON.parse(grid.body) as Grid).cells.map((c) => [c.date, c.basePrice]));
    assert.equal(byDate.get(FROM), 123);
    assert.equal(byDate.get("2026-11-11"), 100);
    assert.equal(byDate.get(TO), 100);
    // The journal keeps one price item per cell with the FINAL value (123 on FROM).
    const entry = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}`), headers });
    const items = (JSON.parse(entry.body) as { items: Array<{ field: string; date: string; after: unknown }> }).items.filter((i) => i.field === "price" && i.date === FROM);
    assert.equal(items[items.length - 1]!.after, 123);
    const undo = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}/revert`), headers });
    assert.equal(undo.statusCode, 200, undo.body);
    journalIds.add((JSON.parse(undo.body) as { journalId: string }).journalId);
  });

  it('availability through the "*" sentinel writes InventoryDay and reverts to none', async () => {
    const res = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: { cells: [{ ratePlanId: "*", roomTypeId, date: FROM, available: 5 }], reason: `${MARK} disponibles 5` }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { journalId: string; updated: number; changesCount: number };
    journalIds.add(body.journalId);
    assert.equal(body.updated, 1);
    assert.equal(body.changesCount, 1);
    const grid = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${FROM}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    assert.equal((JSON.parse(grid.body) as Grid).cells[0]!.inventory?.available, 5);
    const entry = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}`), headers });
    const item = (JSON.parse(entry.body) as { items: Array<{ ratePlanId: string; field: string; before: unknown; after: unknown }> }).items[0]!;
    assert.deepEqual({ ratePlanId: item.ratePlanId, field: item.field, before: item.before, after: item.after }, { ratePlanId: "*", field: "available", before: null, after: 5 });
    // "*" never carries a price.
    const bad = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`), headers, payload: { cells: [{ ratePlanId: "*", roomTypeId, date: FROM, price: 90 }], reason: `${MARK} precio en *` } });
    assert.equal(bad.statusCode, 400, bad.body);
    const undo = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}/revert`), headers });
    assert.equal(undo.statusCode, 200, undo.body);
    journalIds.add((JSON.parse(undo.body) as { journalId: string }).journalId);
    const after = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${FROM}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    assert.equal((JSON.parse(after.body) as Grid).cells[0]!.inventory ?? null, null);
  });

  it("a channel price override answers 400 (channel prices come from the markup)", async () => {
    const list = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${FROM}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    const channel = (JSON.parse(list.body) as Grid).channels[0];
    const channelId = channel?.id ?? "ch_any";
    const cell = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`), headers, payload: { cells: [{ ratePlanId: barPlanId, roomTypeId, date: FROM, channelId, price: 150 }], reason: `${MARK} override canal` } });
    assert.equal(cell.statusCode, 400, cell.body);
    assert.match((JSON.parse(cell.body) as { message: string }).message, /markup del canal/);
    const op = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`), headers, payload: { ops: [{ scope: { from: FROM, to: FROM, channelIds: [channelId] }, price: { mode: "set", value: 150 } }], reason: `${MARK} override canal op` } });
    assert.equal(op.statusCode, 400, op.body);
    assert.match((JSON.parse(op.body) as { message: string }).message, /markup del canal/);
  });

  it("recommendations/apply in cell form persists applied/rejected per cell and returns patches only for accept/adjust", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/properties/${PROPERTY_ID}/rate-grid/recommendations/apply`,
      headers,
      payload: {
        from: FROM,
        to: TO,
        ratePlanId: barPlanId,
        reason: `${MARK} decisiones por celda`,
        cells: [
          { roomTypeId, date: FROM, suggestedPrice: 140, appliedPrice: 150, action: "adjust", reason: "evento" },
          { roomTypeId, date: "2026-11-11", suggestedPrice: 140, action: "reject", reason: "no convence" },
          { roomTypeId, date: TO, suggestedPrice: 140, action: "accept" }
        ]
      }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { applied: number; rejected: number; recorded: number; patches: Array<{ ratePlanId: string; roomTypeId: string; date: string; price?: number }>; skipped: unknown[]; recommendationIds: string[] };
    recommendationIds.push(...body.recommendationIds);
    assert.equal(body.applied, 2);
    assert.equal(body.rejected, 1);
    assert.equal(body.recorded, 3);
    assert.equal(body.recommendationIds.length, 3);
    assert.deepEqual(body.patches.map((p) => p.date), [FROM, TO]);
    assert.equal(body.patches[0]!.price, 150);
    assert.equal(typeof body.patches[1]!.price, "number");
    assert.ok(body.patches.every((p) => p.ratePlanId === barPlanId && p.roomTypeId === roomTypeId));
    const rows = await prisma.revenueRecommendation.findMany({ where: { id: { in: body.recommendationIds } }, select: { status: true, targetDate: true, approvedBy: true, rejectedBy: true } });
    const byDate = new Map(rows.map((r) => [r.targetDate.toISOString().slice(0, 10), r]));
    assert.equal(byDate.get(FROM)?.status, "applied");
    assert.equal(byDate.get("2026-11-11")?.status, "rejected");
    assert.ok(byDate.get("2026-11-11")?.rejectedBy);
    assert.equal(byDate.get(TO)?.status, "applied");
    // adjust without appliedPrice, and cells mixed with dates, are 400s.
    const bad = await app.inject({ method: "POST", url: `/properties/${PROPERTY_ID}/rate-grid/recommendations/apply`, headers, payload: { from: FROM, to: TO, ratePlanId: barPlanId, cells: [{ roomTypeId, date: FROM, action: "adjust" }] } });
    assert.equal(bad.statusCode, 400, bad.body);
    const mixed = await app.inject({ method: "POST", url: `/properties/${PROPERTY_ID}/rate-grid/recommendations/apply`, headers, payload: { from: FROM, to: TO, ratePlanId: barPlanId, dates: [FROM], cells: [{ roomTypeId, date: FROM, action: "reject" }] } });
    assert.equal(mixed.statusCode, 400, mixed.body);
  });

  it("revert after a publish restores the price and marks the published entry reverted", async () => {
    const list = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${TO}&to=${TO}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    const grid = JSON.parse(list.body) as Grid;
    const before = grid.cells[0]!.basePrice;
    // Prefer a seeded sandbox channel (the channel-outbox suite runs in parallel with its own stub channel).
    const channel = grid.channels.find((c) => c.readyToPush && SANDBOX_PROVIDERS.includes(c.providerCode)) ?? grid.channels.find((c) => c.readyToPush);
    const res = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      headers,
      payload: {
        cells: [{ ratePlanId: barPlanId, roomTypeId, date: TO, price: 177 }],
        reason: `${MARK} publicar y revertir`,
        ...(channel ? { publish: { channelIds: [channel.id], kinds: ["rates"] } } : {})
      }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { journalId: string; queued?: Record<string, number> };
    journalIds.add(body.journalId);
    if (channel) assert.equal(body.queued?.[channel.id], 1, res.body);
    publishedChannelId = channel?.id ?? null;
    const entry = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}`), headers });
    assert.equal((JSON.parse(entry.body) as { status: string }).status, channel ? "published" : "draft");
    const revert = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}/revert`), headers });
    assert.equal(revert.statusCode, 200, revert.body);
    journalIds.add((JSON.parse(revert.body) as { journalId: string }).journalId);
    const after = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${TO}&to=${TO}&roomTypeIds=${roomTypeId}&ratePlanIds=${barPlanId}`), headers });
    assert.equal((JSON.parse(after.body) as Grid).cells[0]!.basePrice, before);
    const reverted = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${body.journalId}`), headers });
    assert.equal((JSON.parse(reverted.body) as { status: string }).status, "reverted");
  });

  it("sync-status: a window without deliveries answers the channel catalogue with an EMPTY map; the published cell shows its channel state", async () => {
    type SyncStatus = { from: string; to: string; channels: Array<{ id: string; providerCode: string; readyToPush: boolean }>; cells: Array<{ ratePlanId: string; roomTypeId: string; date: string; byChannel: Record<string, { status: string }> }>; summary: Record<string, Record<string, number>> };
    // Nobody publishes to QUIET_FROM..QUIET_TO: the map must be empty, not merely "an array".
    const quiet = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid/sync-status?from=${QUIET_FROM}&to=${QUIET_TO}`), headers });
    assert.equal(quiet.statusCode, 200, quiet.body);
    const empty = JSON.parse(quiet.body) as SyncStatus;
    assert.equal(empty.from, QUIET_FROM);
    assert.equal(empty.to, QUIET_TO);
    assert.deepEqual(empty.cells, [], `deliveries found in the quiet window ${QUIET_FROM}..${QUIET_TO}: ${quiet.body}`);
    assert.deepEqual(empty.summary, {});
    const catalogue = await getGrid(QUIET_FROM, QUIET_FROM);
    assert.deepEqual(empty.channels.map((c) => c.id).sort(), catalogue.channels.map((c) => c.id).sort(), "sync-status lists the same channels as the grid");
    assert.ok(empty.channels.some((c) => c.id === sandboxChannelId));
    for (const c of empty.channels) assert.equal(typeof c.readyToPush, "boolean");

    // The publish of the previous test left a delivery on TO: that cell carries the channel state (the leader may have drained it already).
    if (!publishedChannelId) return;
    const res = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid/sync-status?from=${FROM}&to=${TO}`), headers });
    assert.equal(res.statusCode, 200, res.body);
    const status = JSON.parse(res.body) as SyncStatus;
    const cell = status.cells.find((c) => c.ratePlanId === barPlanId && c.roomTypeId === roomTypeId && c.date === TO);
    assert.ok(cell, `published cell ${TO} missing from sync-status: ${res.body}`);
    assert.ok(["queued", "sending", "confirmed"].includes(cell.byChannel[publishedChannelId]?.status ?? "never"), JSON.stringify(cell.byChannel));
    const bucket = status.summary[publishedChannelId] ?? {};
    assert.ok(Object.values(bucket).reduce((a, b) => a + b, 0) >= 1, JSON.stringify(status.summary));
    // Filtering by channel keeps only that channel's states.
    const filtered = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid/sync-status?from=${FROM}&to=${TO}&channelIds=${publishedChannelId}`), headers });
    assert.equal(filtered.statusCode, 200, filtered.body);
    const only = JSON.parse(filtered.body) as SyncStatus;
    assert.deepEqual(only.channels.map((c) => c.id), [publishedChannelId]);
    for (const c of only.cells) assert.deepEqual(Object.keys(c.byChannel), [publishedChannelId]);
  });

  it("bulk-update without a session → 401 exactly (critical route: the demo fallback never reaches it, without the flag the auth hook refuses first)", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/rate-grid/bulk-update`),
      payload: { cells: [{ ratePlanId: barPlanId, roomTypeId, date: FROM, price: 1 }], reason: `${MARK} sin sesión` }
    });
    assert.equal(res.statusCode, 401, res.body);
    const unchanged = await getCell(FROM);
    assert.notEqual(unchanged.basePrice, 1);
  });

  // ---------------------------------------------------------------- tenancy of ids inside bodies and queries

  it("ids of another property in cells / ops / publish / push / queries → 400 UNKNOWN_IDS (or 404 for a foreign channel or journal), nothing written", async () => {
    assert.ok(foreign, `${FOREIGN_PROPERTY_ID} (seed) is required for the cross-property cases`);
    const original = await getCell(FROM);

    // cells: plan + room type of the other property → both listed in details.
    const cells = await bulk({ cells: [{ ratePlanId: foreign.ratePlanId, roomTypeId: foreign.roomTypeId, date: FROM, price: 1 }], reason: `${MARK} ids ajenos en cells` });
    assert.equal(cells.status, 400, cells.raw);
    assert.equal(cells.body.details?.code, "UNKNOWN_IDS", cells.raw);
    assert.ok((cells.body.details?.ratePlanIds as string[]).includes(foreign.ratePlanId), cells.raw);
    assert.ok((cells.body.details?.roomTypeIds as string[]).includes(foreign.roomTypeId), cells.raw);

    // cells: a foreign channel on a restriction patch (the one place a cell may carry a channel).
    const channelCell = await bulk({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: FROM, channelId: foreign.channelId, restrictions: { minLos: 2 } }], reason: `${MARK} canal ajeno en cells` });
    assert.equal(channelCell.status, 400, channelCell.raw);
    assert.equal(channelCell.body.details?.code, "UNKNOWN_IDS", channelCell.raw);
    assert.ok((channelCell.body.details?.channelIds as string[]).includes(foreign.channelId), channelCell.raw);

    // publish: a foreign channel is refused BEFORE the cells are written (no journal, price untouched).
    const publishReason = `${MARK} publish canal ajeno`;
    const publish = await bulk({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: FROM, price: 999 }], reason: publishReason, publish: { channelIds: [foreign.channelId], kinds: ["rates"] } });
    assert.equal(publish.status, 400, publish.raw);
    assert.equal(publish.body.details?.code, "UNKNOWN_IDS", publish.raw);
    assert.deepEqual(publish.body.details?.channelIds, [foreign.channelId]);
    assert.equal((await getCell(FROM)).basePrice, original.basePrice, "a refused publish must not write the cells");
    assert.equal(await prisma.rateChangeJournal.count({ where: { propertyId: PROPERTY_ID, reason: publishReason } }), 0, "a refused publish must not leave a journal entry");

    // ops: unknown ids in a scope are warnings, but an op that expands to NOTHING is a 400 (no empty journal entry).
    const ops = await bulk({ ops: [{ scope: { from: FROM, to: FROM, roomTypeIds: [roomTypeId], ratePlanIds: [foreign.ratePlanId] }, price: { mode: "set", value: 999 } }], reason: `${MARK} plan ajeno en ops` });
    assert.equal(ops.status, 400, ops.raw);
    assert.equal(ops.body.details?.code, "NO_CELLS", ops.raw);
    assert.ok((ops.body.details?.warnings as string[] | undefined)?.some((w) => w.includes(foreign!.ratePlanId)), `the warnings must name the unknown plan: ${ops.raw}`);
    assert.equal((await getCell(FROM)).basePrice, original.basePrice);

    // push: foreign channel → 400 UNKNOWN_IDS; own channel + foreign journal → 404 and the foreign journal stays untouched.
    const pushChannel = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-grid/push`), headers, payload: { from: FROM, to: FROM, channelIds: [foreign.channelId], kinds: ["rates"] } });
    assert.equal(pushChannel.statusCode, 400, pushChannel.body);
    assert.equal((JSON.parse(pushChannel.body) as ErrorBody).details?.code, "UNKNOWN_IDS");
    const pushJournal = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/rate-grid/push`), headers, payload: { from: FROM, to: FROM, channelIds: [sandboxChannelId], kinds: ["rates"], journalId: foreign.journalId } });
    assert.equal(pushJournal.statusCode, 404, pushJournal.body);
    const foreignJournal = await prisma.rateChangeJournal.findUnique({ where: { id: foreign.journalId }, select: { status: true, pushStatus: true, pushedTo: true } });
    assert.deepEqual(foreignJournal, { status: "draft", pushStatus: "draft", pushedTo: [] }, "a refused push must not stamp the foreign journal");
    assert.equal(await prisma.channelDelivery.count({ where: { journalId: foreign.journalId } }), 0);

    // queries: a foreign channel is a 404 on the grid and a 400 UNKNOWN_IDS on sync-status; foreign plan/type filters are 400.
    const gridChannel = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${FROM}&channelId=${foreign.channelId}`), headers });
    assert.equal(gridChannel.statusCode, 404, gridChannel.body);
    const gridPlan = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid?from=${FROM}&to=${FROM}&ratePlanIds=${foreign.ratePlanId}&roomTypeIds=${foreign.roomTypeId}`), headers });
    assert.equal(gridPlan.statusCode, 400, gridPlan.body);
    const gridPlanBody = JSON.parse(gridPlan.body) as ErrorBody;
    assert.equal(gridPlanBody.details?.code, "UNKNOWN_IDS");
    assert.deepEqual(gridPlanBody.details?.ratePlanIds, [foreign.ratePlanId]);
    assert.deepEqual(gridPlanBody.details?.roomTypeIds, [foreign.roomTypeId]);
    const sync = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-grid/sync-status?from=${FROM}&to=${FROM}&channelIds=${foreign.channelId}`), headers });
    assert.equal(sync.statusCode, 400, sync.body);
    assert.equal((JSON.parse(sync.body) as ErrorBody).details?.code, "UNKNOWN_IDS");

    // journal: a foreign entry is invisible under this property (read and revert) and stays as it was.
    const read = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal/${foreign.journalId}`), headers });
    assert.equal(read.statusCode, 404, read.body);
    const revertForeign = await revert(foreign.journalId);
    assert.equal(revertForeign.status, 404, revertForeign.raw);
    assert.equal((await prisma.rateChangeJournal.findUnique({ where: { id: foreign.journalId }, select: { status: true } }))?.status, "draft");
  });

  it("rate-journal cursor: garbage or repeated → 400 (typed, Spanish), a real cursor pages without repeating rows", async () => {
    const garbage = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?cursor=garbage`), headers });
    assert.equal(garbage.statusCode, 400, garbage.body);
    assert.match((JSON.parse(garbage.body) as ErrorBody).message, /cursor de paginación/);
    // A base64url cursor with the right shape but a non-date key must be a 400 too, never a Prisma 500.
    const badKey = Buffer.from(JSON.stringify({ k: "not-a-date", id: "x" }), "utf8").toString("base64url");
    const shaped = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?cursor=${badKey}`), headers });
    assert.equal(shaped.statusCode, 400, shaped.body);
    // The exact cursor of the audit (CSC-08: it used to be a Prisma 500).
    const audited = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?cursor=eyJrIjoiZ2FyYmFnZSIsImlkIjoieCJ9`), headers });
    assert.equal(audited.statusCode, 400, audited.body);
    assert.match((JSON.parse(audited.body) as ErrorBody).message, /cursor de paginación/);
    const repeated = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?cursor=a&cursor=b`), headers });
    assert.equal(repeated.statusCode, 400, repeated.body);
    const zero = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?limit=0`), headers });
    assert.equal(zero.statusCode, 400, zero.body);

    const first = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?limit=1`), headers });
    assert.equal(first.statusCode, 200, first.body);
    const page1 = JSON.parse(first.body) as { items: Array<{ id: string; timestamp: string }>; nextCursor: string | null };
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextCursor, "the suite has written several entries: a second page must exist");
    const second = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`), headers });
    assert.equal(second.statusCode, 200, second.body);
    const page2 = JSON.parse(second.body) as { items: Array<{ id: string; timestamp: string }> };
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0]!.id, page1.items[0]!.id);
    assert.ok(page2.items[0]!.timestamp <= page1.items[0]!.timestamp, "newest first");
  });

  // ---------------------------------------------------------------- restrictions over HTTP

  it('restriction precedence over HTTP: "*" < plan < plan+channel for numbers, flags OR-ed; a row left empty is deleted', async () => {
    const restrictionRows = () => prisma.restrictionDay.count({ where: { propertyId: PROPERTY_ID, roomTypeId, date: windowFilter(FROM, FROM) } });
    const baseline = await restrictionRows();
    const layered = await write({
      cells: [
        { ratePlanId: "*", roomTypeId, date: FROM, restrictions: { minLos: 2, cta: true } },
        { ratePlanId: barPlanId, roomTypeId, date: FROM, restrictions: { minLos: 3 } },
        { ratePlanId: barPlanId, roomTypeId, date: FROM, channelId: sandboxChannelId, restrictions: { minLos: 4, ctd: true } }
      ],
      reason: `${MARK} capas de restricciones`
    });
    assert.equal(layered.updated, 3, JSON.stringify(layered));
    assert.equal(layered.changesCount, 5, JSON.stringify(layered));
    assert.equal(await restrictionRows(), baseline + 3);
    // Base view: the plan row wins over "*" for minLos, the "*" flag still applies.
    assert.deepEqual((await getCell(FROM)).restrictions, { minLos: 3, cta: true });
    // Channel view: plan+channel wins for minLos; flags from every layer are OR-ed.
    const viaChannel = await getCell(FROM, barPlanId, sandboxChannelId);
    assert.equal(viaChannel.channelId, sandboxChannelId);
    assert.deepEqual(viaChannel.restrictions, { minLos: 4, cta: true, ctd: true });
    // The journal keeps the channel on the channel-level items only.
    const entry = await journalEntry(layered.journalId);
    assert.deepEqual(entry.items.filter((i) => i.channelId === sandboxChannelId).map((i) => i.field).sort(), ["ctd", "minLos"]);
    assert.deepEqual(entry.items.filter((i) => i.ratePlanId === "*").map((i) => [i.field, i.before, i.after]).sort(), [["cta", null, true], ["minLos", null, 2]]);

    // Clearing the only value of the plan row empties it → the row is deleted, and minLos falls through to "*".
    const cleared = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: FROM, restrictions: { minLos: null } }], reason: `${MARK} vaciar fila del plan` });
    assert.equal(cleared.changesCount, 1, JSON.stringify(cleared));
    assert.equal(await restrictionRows(), baseline + 2, "an empty RestrictionDay row must be deleted, not kept with nulls");
    assert.deepEqual((await getCell(FROM)).restrictions, { minLos: 2, cta: true });

    // Reverting recreates the plan row, then reverting the first entry leaves no trace.
    await revertOk(cleared.journalId);
    assert.deepEqual((await getCell(FROM)).restrictions, { minLos: 3, cta: true });
    assert.equal(await restrictionRows(), baseline + 3);
    await revertOk(layered.journalId);
    assert.equal(await restrictionRows(), baseline);
    assert.deepEqual((await getCell(FROM)).restrictions, {});
    assert.deepEqual((await getCell(FROM, barPlanId, sandboxChannelId)).restrictions, {});
  });

  // ---------------------------------------------------------------- concurrency and revert safety

  it("two concurrent bulk-updates on the same cell both succeed and the journals chain (the later `before` is the earlier `after`)", async () => {
    const original = (await getCell(DAY_CONCURRENT)).basePrice;
    assert.equal(typeof original, "number");
    const [a, b] = await Promise.all([
      bulk({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_CONCURRENT, price: 131 }], reason: `${MARK} concurrente A` }),
      bulk({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_CONCURRENT, price: 132 }], reason: `${MARK} concurrente B` })
    ]);
    assert.equal(a.status, 200, a.raw);
    assert.equal(b.status, 200, b.raw);
    assert.notEqual(a.body.journalId, b.body.journalId);
    const final = (await getCell(DAY_CONCURRENT)).basePrice;
    assert.ok(final === 131 || final === 132, `final price ${final}`);

    const priceItem = (entry: JournalEntry) => {
      const items = entry.items.filter((i) => i.field === "price" && i.ratePlanId === barPlanId && i.date === DAY_CONCURRENT);
      assert.equal(items.length, 1, JSON.stringify(entry.items));
      return items[0]!;
    };
    const entries = [await journalEntry(a.body.journalId), await journalEntry(b.body.journalId)].sort((x, y) => x.timestamp.localeCompare(y.timestamp) || x.id.localeCompare(y.id));
    const [earlier, later] = entries as [JournalEntry, JournalEntry];
    assert.equal(priceItem(earlier).before, original);
    assert.equal(priceItem(later).after, final, "the journal written last holds the price the grid shows");
    // Serialised writes: the second one read the first one's result, so a revert chain restores every step.
    assert.equal(priceItem(later).before, priceItem(earlier).after, "lost update: the later journal recorded a stale `before`");

    await revertOk(later.id);
    assert.equal((await getCell(DAY_CONCURRENT)).basePrice, priceItem(earlier).after);
    await revertOk(earlier.id);
    assert.equal((await getCell(DAY_CONCURRENT)).basePrice, original);
  });

  it("a revert that would overwrite a LATER edit → 409 JOURNAL_STALE and nothing written; force: true reverts anyway (CSC-02)", async () => {
    const original = (await getCell(DAY_STALE_REVERT)).basePrice;
    assert.equal(typeof original, "number");
    const j1 = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_STALE_REVERT, price: 150 }], reason: `${MARK} J1 150` });
    const j2 = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_STALE_REVERT, price: 160 }], reason: `${MARK} J2 160` });
    assert.equal((await getCell(DAY_STALE_REVERT)).basePrice, 160);

    const stale = await revert(j1.journalId);
    assert.equal(stale.status, 409, `reverting J1 must not silently overwrite J2: ${stale.raw}`);
    assert.equal(stale.body.details?.code, "JOURNAL_STALE", stale.raw);
    const staleCells = stale.body.details?.cells as Array<{ ratePlanId: string; roomTypeId: string; date: string; fields?: Array<{ field: string; expected: unknown; actual: unknown }> }> | undefined;
    assert.ok(staleCells?.some((c) => c.ratePlanId === barPlanId && c.roomTypeId === roomTypeId && c.date === DAY_STALE_REVERT), stale.raw);
    // JournalStaleDialog renders «el asiento dejó X, ahora hay Y» from fields[{ field, expected, actual }].
    const staleFields = staleCells?.find((c) => c.date === DAY_STALE_REVERT)?.fields;
    assert.ok(staleFields?.some((f) => f.field === "price" && Number(f.expected) === 150 && Number(f.actual) === 160), `details.cells[].fields must carry {field, expected, actual}: ${stale.raw}`);
    assert.equal((await getCell(DAY_STALE_REVERT)).basePrice, 160, "a refused revert must leave the later value in place");
    assert.equal((await journalEntry(j1.journalId)).status, "draft", "a refused revert must not mark the entry reverted");
    // The inverse entry links the reverted one through changesJson.revertsJournalId (the wording no longer carries the id).
    assert.equal(await prisma.rateChangeJournal.count({ where: { propertyId: PROPERTY_ID, changesJson: { path: ["revertsJournalId"], equals: j1.journalId } } }), 0, "a refused revert must not leave an inverse entry");

    // Reverting in order (newest first) is always accepted.
    await revertOk(j2.journalId);
    assert.equal((await getCell(DAY_STALE_REVERT)).basePrice, 150);
    await revertOk(j1.journalId);
    assert.equal((await getCell(DAY_STALE_REVERT)).basePrice, original);

    // force: the caller accepts overwriting the later edit; the inverse entry journals the actual current value.
    const j3 = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_STALE_REVERT, price: 130 }], reason: `${MARK} J3 130` });
    const j4 = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_STALE_REVERT, price: 140 }], reason: `${MARK} J4 140` });
    const forced = await revert(j3.journalId, { force: true });
    assert.equal(forced.status, 200, forced.raw);
    assert.equal((await getCell(DAY_STALE_REVERT)).basePrice, original);
    assert.equal((await journalEntry(j3.journalId)).status, "reverted");
    const inverse = await journalEntry(forced.body.journalId);
    const item = inverse.items.find((i) => i.field === "price" && i.ratePlanId === barPlanId);
    assert.deepEqual({ before: item?.before, after: item?.after }, { before: 140, after: original });
    assert.equal((await journalEntry(j4.journalId)).status, "draft", "the overwritten later entry stays as it was (its revert would now be stale)");
  });

  it("respectManualOverrides: false overwrites a manual child cell (journaled as a user change) and reverting that entry restores the override (CSC-03)", async () => {
    assert.ok(nrPlanId, "BAR-NR (derived) is created by the derived-plan case");
    const nr = nrPlanId;
    const original = (await getCell(DAY_OVERRIDE)).basePrice as number;
    assert.equal(typeof original, "number");

    // A: parent 120 → child materialised 107.99 (derived).
    const jA = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_OVERRIDE, price: 120 }], reason: `${MARK} padre 120` });
    assert.equal(jA.derivedUpdated, 1, JSON.stringify(jA));
    let child = await getCell(DAY_OVERRIDE, nr);
    assert.equal(child.basePrice, applyDerivation(120, BAR_NR_DERIVATION));
    assert.equal(child.source, "derived");

    // B: the user breaks the derivation on that cell (99, manual).
    const jB = await write({ cells: [{ ratePlanId: nr, roomTypeId, date: DAY_OVERRIDE, price: 99, convertToManual: true }], reason: `${MARK} hijo manual 99` });
    assert.equal(jB.updated, 1, JSON.stringify(jB));
    child = await getCell(DAY_OVERRIDE, nr);
    assert.deepEqual({ basePrice: child.basePrice, source: child.source, derivedFrom: child.derivedFrom }, { basePrice: 99, source: "manual", derivedFrom: null });

    // C0: a plain op on the parent respects the override (skippedManual).
    const jC0 = await write({ ops: [{ scope: { from: DAY_OVERRIDE, to: DAY_OVERRIDE, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, price: { mode: "set", value: 125 } }], reason: `${MARK} padre 125 respetando` });
    assert.equal(jC0.skippedManual, 1, JSON.stringify(jC0));
    assert.equal(jC0.derivedUpdated, 0, JSON.stringify(jC0));
    child = await getCell(DAY_OVERRIDE, nr);
    assert.deepEqual({ basePrice: child.basePrice, source: child.source }, { basePrice: 99, source: "manual" });

    // C: respectManualOverrides: false → the child is re-derived from 130 and loses its override.
    const jC = await write({ ops: [{ scope: { from: DAY_OVERRIDE, to: DAY_OVERRIDE, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, price: { mode: "set", value: 130 }, respectManualOverrides: false }], reason: `${MARK} padre 130 pisando` });
    assert.equal(jC.skippedManual, 0, JSON.stringify(jC));
    assert.equal(jC.derivedUpdated, 1, JSON.stringify(jC));
    child = await getCell(DAY_OVERRIDE, nr);
    assert.deepEqual({ basePrice: child.basePrice, source: child.source }, { basePrice: applyDerivation(130, BAR_NR_DERIVATION), source: "derived" });
    // Overwriting a manual cell is a user decision: journaled as price + source (not as an automatic derivedPrice).
    const entry = await journalEntry(jC.journalId);
    const childItems = entry.items.filter((i) => i.ratePlanId === nr).map((i) => [i.field, i.before, i.after]).sort();
    assert.deepEqual(childItems, [["price", 99, applyDerivation(130, BAR_NR_DERIVATION)], ["source", "manual", "derived"]], JSON.stringify(entry.items));

    // D: reverting C brings the parent AND the manual override back.
    await revertOk(jC.journalId);
    assert.equal((await getCell(DAY_OVERRIDE)).basePrice, 125);
    child = await getCell(DAY_OVERRIDE, nr);
    assert.deepEqual({ basePrice: child.basePrice, source: child.source, derivedFrom: child.derivedFrom }, { basePrice: 99, source: "manual", derivedFrom: null }, "the revert must restore the override respectManualOverrides:false wiped");

    // Unwind the rest in order: C0, B (back to derived), A (parent back to the original, child follows).
    await revertOk(jC0.journalId);
    assert.equal((await getCell(DAY_OVERRIDE)).basePrice, 120);
    await revertOk(jB.journalId);
    child = await getCell(DAY_OVERRIDE, nr);
    assert.deepEqual({ basePrice: child.basePrice, source: child.source }, { basePrice: applyDerivation(120, BAR_NR_DERIVATION), source: "derived" });
    await revertOk(jA.journalId);
    assert.equal((await getCell(DAY_OVERRIDE)).basePrice, original);
    child = await getCell(DAY_OVERRIDE, nr);
    assert.equal(child.basePrice, applyDerivation(original, BAR_NR_DERIVATION));
  });

  it("a derivation that yields 0 € never materialises a child rate (no fake 0) and is reported as a conflict (CSC-07)", async () => {
    assert.ok(nrPlanId, "BAR-NR (derived) is created by the derived-plan case");
    const nr = nrPlanId;
    const original = (await getCell(DAY_OVERRIDE)).basePrice as number;
    assert.ok(typeof original === "number" && original > 0);
    assert.equal(applyDerivation(0.4, BAR_NR_DERIVATION), 0, "the fixture relies on 0.4 € −10 % rounding to 0 with roundTo 0.99");

    const res = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: DAY_OVERRIDE, price: 0.4 }], reason: `${MARK} padre 0.4 → hijo 0` });
    assert.equal((await getCell(DAY_OVERRIDE)).basePrice, 0.4);
    const child = await getCell(DAY_OVERRIDE, nr);
    assert.notEqual(child.basePrice, 0, "a derived 0 € must never become a RateDay");
    assert.equal(child.basePrice, null, `the child cell must have no rate: ${JSON.stringify(child)}`);
    assert.ok(res.conflicts.some((c) => c.ratePlanId === nr && c.date === DAY_OVERRIDE), `the response must say why the child was not materialised: ${JSON.stringify(res)}`);
    assert.equal(await prisma.rateDay.count({ where: { propertyId: PROPERTY_ID, ratePlanId: nr, roomTypeId, date: windowFilter(DAY_OVERRIDE, DAY_OVERRIDE), price: 0 } }), 0);

    // Reverting the parent re-materialises the child from the restored price.
    await revertOk(res.journalId);
    assert.equal((await getCell(DAY_OVERRIDE)).basePrice, original);
    assert.equal((await getCell(DAY_OVERRIDE, nr)).basePrice, applyDerivation(original, BAR_NR_DERIVATION));
  });

  // ---------------------------------------------------------------- cierre 2026-09-15 · window 2027-06-01..15

  it("ops + cells on the SAME cell journal ONE price item (before = original, after = final) and the revert restores the ORIGINAL, never the intermediate value (api-live-contract#1)", async () => {
    await ensureJuneFixtures();
    const date = J(1);
    const original = (await getCell(date)).basePrice as number;
    assert.equal(typeof original, "number");
    // The op sets an intermediate value the cell edit then overrides: before the coalescing the revert restored 105.
    const res = await write({
      ops: [{ scope: { from: date, to: date, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, price: { mode: "set", value: 105 } }],
      cells: [{ ratePlanId: barPlanId, roomTypeId, date, price: 111 }],
      reason: `${MARK} op set 105 + celda 111 (misma celda)`
    });
    assert.equal(res.conflicts.length, 0, JSON.stringify(res));
    assert.equal((await getCell(date)).basePrice, 111);
    const entry = await journalEntry(res.journalId);
    const priceItems = entry.items.filter((i) => i.field === "price" && i.ratePlanId === barPlanId && i.date === date);
    assert.equal(priceItems.length, 1, `one price item per (cell, field) expected: ${JSON.stringify(entry.items)}`);
    assert.deepEqual({ before: priceItems[0]!.before, after: priceItems[0]!.after }, { before: original, after: 111 });
    assert.equal(entry.changesCount, entry.items.length, "changesCount counts the coalesced items");
    await revertOk(res.journalId);
    assert.equal((await getCell(date)).basePrice, original, "the revert must restore the ORIGINAL price, not the op's intermediate 105");
    assert.equal((await journalEntry(res.journalId)).status, "reverted");
  });

  it("cells[].expected.price: a stale expectation → 409 ALL_CELLS_CONFLICT «la celda cambió desde que se cargó» and nothing written; the right one → 200; mixed → 200 with one conflict (browser-ux#3)", async () => {
    await ensureJuneFixtures();
    const [dateA, dateB] = [J(2), J(3)];
    const current = (await getCell(dateA)).basePrice as number;
    assert.equal(typeof current, "number");
    const staleReason = `${MARK} expected obsoleto`;
    const stale = await bulk({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: dateA, price: 150, expected: { price: current + 1 } }], reason: staleReason });
    assert.equal(stale.status, 409, stale.raw);
    assert.equal(stale.body.details?.code, "ALL_CELLS_CONFLICT", stale.raw);
    const conflicts = stale.body.details?.conflicts as Array<{ date: string; reason: string }>;
    assert.equal(conflicts.length, 1, stale.raw);
    assert.match(conflicts[0]!.reason, /la celda cambió desde que se cargó/);
    assert.equal((await getCell(dateA)).basePrice, current, "a stale patch must not write");
    assert.equal(await journalsWithReason(staleReason), 0, "a 409 must not leave an entry");

    const ok = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: dateA, price: 150, expected: { price: current } }], reason: `${MARK} expected correcto` });
    assert.equal(ok.conflicts.length, 0, JSON.stringify(ok));
    assert.equal((await getCell(dateA)).basePrice, 150);

    // Mixed: dateA now holds 150 (an expectation of `current` is stale), dateB is as loaded → 200 with one conflict, one cell written.
    const priceB = (await getCell(dateB)).basePrice as number;
    const mixed = await write({
      cells: [
        { ratePlanId: barPlanId, roomTypeId, date: dateA, price: 160, expected: { price: current } },
        { ratePlanId: barPlanId, roomTypeId, date: dateB, price: priceB + 1, expected: { price: priceB } }
      ],
      reason: `${MARK} expected mixto`
    });
    assert.equal(mixed.conflicts.length, 1, JSON.stringify(mixed));
    assert.equal(mixed.conflicts[0]!.date, dateA);
    assert.match(mixed.conflicts[0]!.reason, /la celda cambió desde que se cargó/);
    assert.equal((await getCell(dateA)).basePrice, 150, "the stale cell keeps its value");
    assert.equal((await getCell(dateB)).basePrice, priceB + 1, "the cell whose expectation held is written");
    await revertOk(mixed.journalId);
    await revertOk(ok.journalId);
    assert.equal((await getCell(dateA)).basePrice, current);
    assert.equal((await getCell(dateB)).basePrice, priceB);
  });

  it("two CONCURRENT bulk-updates with the same clientRequestId → the same journalId and ONE entry (advisory lock + unique (propertyId, clientRequestId), CSC-09)", async () => {
    await ensureJuneFixtures();
    const date = J(3);
    const original = (await getCell(date)).basePrice;
    const clientRequestId = `rgv2-cc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const reason = `${MARK} clientRequestId concurrente`;
    const body = { cells: [{ ratePlanId: barPlanId, roomTypeId, date, price: 120 }], reason, clientRequestId };
    const [a, b] = await Promise.all([bulk(body), bulk(body)]);
    assert.equal(a.status, 200, a.raw);
    assert.equal(b.status, 200, b.raw);
    assert.equal(a.body.journalId, b.body.journalId, "both retries must answer the same entry");
    assert.equal(await journalsWithReason(reason), 1, "exactly one entry for the two retries");
    assert.equal(await prisma.rateChangeJournal.count({ where: { propertyId: PROPERTY_ID, clientRequestId } }), 1);
    assert.equal((await getCell(date)).basePrice, 120);
    for (const r of [a, b]) assert.ok(!("replayed" in r.body), `the engine flag never reaches the wire: ${r.raw}`);
    await revertOk(a.body.journalId);
    assert.equal((await getCell(date)).basePrice, original);
  });

  it("ops that expand to more than 5.000 patches → 400 TOO_MANY_CELLS with the count, nothing written (CSC-10)", async () => {
    const reason = `${MARK} demasiadas celdas`;
    const far = windowFilter("2031-01-01", "2044-12-31");
    const restrictionsBefore = await prisma.restrictionDay.count({ where: { propertyId: PROPERTY_ID, roomTypeId, date: far } });
    // 14 one-year scopes on distinct years (each ≤ 366 days, the scope cap): 14 × 365/366 restriction patches — restrictions need no base rate.
    const ops = Array.from({ length: 14 }, (_, i) => ({ scope: { from: `${2031 + i}-01-01`, to: `${2031 + i}-12-31`, roomTypeIds: [roomTypeId], ratePlanIds: [barPlanId] }, restrictions: { minLos: 1 } }));
    const res = await bulk({ ops, reason });
    assert.equal(res.status, 400, res.raw);
    assert.equal(res.body.details?.code, "TOO_MANY_CELLS", res.raw);
    assert.ok((res.body.details?.count as number) > 5000, res.raw);
    assert.equal(res.body.details?.max, 5000, res.raw);
    assert.equal(await journalsWithReason(reason), 0, "a refused request must not leave an entry");
    assert.equal(await prisma.restrictionDay.count({ where: { propertyId: PROPERTY_ID, roomTypeId, date: far } }), restrictionsBefore, "a refused request must not write restrictions");
  });

  it("revertToDerived / convertToManual (without a price) on a BASE plan → 409 ALL_CELLS_CONFLICT, no entry, the row untouched (api-live-contract#3)", async () => {
    await ensureJuneFixtures();
    const date = J(12);
    const where = { propertyId_ratePlanId_roomTypeId_date: { propertyId: PROPERTY_ID, ratePlanId: barPlanId, roomTypeId, date: dayUtc(date) } };
    const readRow = async () => {
      const row = await prisma.rateDay.findUnique({ where, select: { price: true, manuallyOverridden: true, updatedAt: true, updatedBy: true, source: true } });
      assert.ok(row, `fixture ${date} missing`);
      return { ...row, price: Number(row.price), updatedAt: row.updatedAt.toISOString() };
    };
    const before = await readRow();
    for (const [flag, reason] of [
      ["revertToDerived", `${MARK} revertToDerived en BAR`],
      ["convertToManual", `${MARK} convertToManual en BAR`]
    ] as const) {
      const res = await bulk({ cells: [{ ratePlanId: barPlanId, roomTypeId, date, [flag]: true }], reason });
      assert.equal(res.status, 409, res.raw);
      assert.equal(res.body.details?.code, "ALL_CELLS_CONFLICT", res.raw);
      assert.match((res.body.details?.conflicts as Array<{ reason: string }>)[0]!.reason, /no es un plan derivado/);
      assert.equal(await journalsWithReason(reason), 0, "a 409 must not leave an (empty) entry");
    }
    assert.deepEqual(await readRow(), before, "the override flag / updatedAt must not move");
  });

  it("a repeated clientRequestId WITH publish answers the stored response, enqueues NOTHING again (deliveries and pushedTo unchanged) and warns «petición repetida» (docs-runbook#16)", async () => {
    await ensureJuneFixtures();
    const date = J(4);
    const channelIds = await sandboxChannelIds();
    const clientRequestId = `rgv2-replay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = { cells: [{ ratePlanId: barPlanId, roomTypeId, date, price: 105 }], reason: `${MARK} replay con publish`, clientRequestId, publish: { channelIds, kinds: ["rates"] } };
    const first = await write(body);
    assert.ok(first.queued, JSON.stringify(first));
    for (const id of channelIds) assert.equal(first.queued[id], 1, JSON.stringify(first));
    const idsBefore = (await deliveriesOf(first.journalId)).map((r) => `${r.channelId}|${r.kind}|${isoOf(r.date)}`).sort();
    assert.equal(idsBefore.length, channelIds.length, JSON.stringify(idsBefore));
    const journalBefore = await prisma.rateChangeJournal.findUnique({ where: { id: first.journalId }, select: { pushedTo: true, status: true } });

    const replay = await write(body);
    assert.equal(replay.journalId, first.journalId);
    assert.equal(replay.queued, undefined, `the stored response carries no queued map: ${JSON.stringify(replay)}`);
    assert.ok(replay.warnings?.some((w) => /petición repetida/.test(w)), JSON.stringify(replay.warnings));
    assert.ok(!("replayed" in replay), "the engine flag never reaches the wire");
    const idsAfter = (await deliveriesOf(first.journalId)).map((r) => `${r.channelId}|${r.kind}|${isoOf(r.date)}`).sort();
    assert.deepEqual(idsAfter, idsBefore, "a replay must not enqueue again");
    assert.equal(await prisma.channelDelivery.count({ where: { propertyId: PROPERTY_ID, date: dayUtc(date) } }), idsBefore.length, "no other delivery on that day either");
    const journalAfter = await prisma.rateChangeJournal.findUnique({ where: { id: first.journalId }, select: { pushedTo: true, status: true } });
    assert.deepEqual({ ...journalAfter, pushedTo: [...(journalAfter?.pushedTo ?? [])].sort() }, { ...journalBefore, pushedTo: [...(journalBefore?.pushedTo ?? [])].sort() });
    assert.equal(await prisma.rateChangeJournal.count({ where: { propertyId: PROPERTY_ID, clientRequestId } }), 1);
    assert.equal((await getCell(date)).basePrice, 105, "the replay applies nothing (and compounds nothing)");
    await revertOk(first.journalId);
  });

  it("publishing ONE cell to the 3 sandbox channels queues exactly 3 deliveries (one per channel, kind rates, that date only); the revert entry reads «Reversión: <motivo>» and links the reverted one through revertsJournalId (browser-ux#8, #17)", async () => {
    await ensureJuneFixtures();
    const date = J(5);
    const channelIds = await sandboxChannelIds();
    const reason = `${MARK} una celda a tres canales`;
    // kinds omitted on purpose: derived from the fields (a price → rates).
    const res = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date, price: 106 }], reason, publish: { channelIds } });
    for (const id of channelIds) assert.equal(res.queued?.[id], 1, JSON.stringify(res));
    const rows = await deliveriesOf(res.journalId);
    assert.equal(rows.length, 3, `one delivery per channel expected: ${JSON.stringify(rows)}`);
    assert.deepEqual(rows.map((r) => r.channelId).sort(), [...channelIds].sort());
    for (const r of rows) {
      assert.equal(r.kind, "rates", JSON.stringify(r));
      assert.equal(isoOf(r.date), date, "only the edited day travels");
      assert.equal(r.roomTypeId, roomTypeId);
      assert.equal(r.ratePlanId, barPlanId);
    }
    const entry = await journalEntry(res.journalId);
    assert.equal(entry.status, "published");
    // `queued` at enqueue; `pushed` already if the scheduler leader (:3000, every 15 s) drained it first.
    assert.ok(["queued", "pushed"].includes(entry.pushStatus), entry.pushStatus);
    assert.deepEqual([...entry.pushedTo].sort(), [...channelIds].sort());

    const inverse = await revertOk(res.journalId);
    const inv = await journalEntry(inverse.journalId);
    assert.equal(inv.reason, `Reversión: ${reason}`);
    assert.ok(!inv.reason?.includes(res.journalId), "the id no longer travels in the wording");
    assert.equal(inv.revertsJournalId, res.journalId);
    assert.equal(inv.status, "published");
    const orig = await journalEntry(res.journalId);
    assert.equal(orig.status, "reverted");
    assert.equal(orig.revertedByJournalId, inverse.journalId);
    assert.equal(orig.revertsJournalId ?? null, null, "the original entry reverts nothing");
    // The listing exposes the link too.
    const list = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/rate-journal?limit=20`), headers });
    assert.equal(list.statusCode, 200, list.body);
    const listed = (JSON.parse(list.body) as { items: JournalEntry[] }).items.find((i) => i.id === inverse.journalId);
    assert.equal(listed?.revertsJournalId, res.journalId, "the list must carry revertsJournalId");
    assert.ok(["draft", "queued", "pushed", "partial", "failed", "superseded"].includes(listed?.pushStatus ?? ""), listed?.pushStatus);
    assert.equal((await getCell(date)).basePrice, JUNE_PRICE);

    // A revert body reason is appended after an em dash; the link is the stored one (changesJson.revertsJournalId).
    const date6 = J(6);
    const reason6 = `${MARK} con motivo de reversión`;
    const j6 = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: date6, price: 107 }], reason: reason6 });
    const inv6 = await revertOk(j6.journalId, { reason: "prueba manual" });
    assert.equal((await journalEntry(inv6.journalId)).reason, `Reversión: ${reason6} — prueba manual`);
    const stored = await prisma.rateChangeJournal.findUnique({ where: { id: inv6.journalId }, select: { changesJson: true } });
    assert.equal((stored?.changesJson as { revertsJournalId?: string } | null)?.revertsJournalId, j6.journalId);
    assert.equal((await getCell(date6)).basePrice, JUNE_PRICE);
  });

  it("publish kinds follow the fields: a room-level stopSell queues availability (count 0) + restrictions and no rates; publish.kinds: ['rates'] queues rates only (cierre contract 2)", async () => {
    await ensureJuneFixtures();
    const channelIds = await sandboxChannelIds();
    const date = J(7);
    const res = await write({ cells: [{ ratePlanId: "*", roomTypeId, date, restrictions: { stopSell: true } }], reason: `${MARK} stopSell room-level publicado`, publish: { channelIds } });
    const rows = await deliveriesOf(res.journalId);
    assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), ["availability", "restrictions"], JSON.stringify(rows));
    for (const r of rows) assert.equal(isoOf(r.date), date);
    for (const id of channelIds) {
      const ofChannel = rows.filter((r) => r.channelId === id);
      assert.equal(ofChannel.length, 2, `availability + restrictions per channel: ${JSON.stringify(ofChannel)}`);
      const availability = ofChannel.find((r) => r.kind === "availability")!;
      assert.equal(availability.ratePlanId, "*");
      assert.equal((availability.payloadJson as { count?: number }).count, 0, "a stop-sold night is sent as 0 available");
      const restriction = ofChannel.find((r) => r.kind === "restrictions")!;
      assert.equal(restriction.ratePlanId, barPlanId, "restrictions travel per mapped product");
      assert.equal((restriction.payloadJson as { stopSell?: boolean }).stopSell, true);
    }
    assert.equal(res.queued?.[channelIds[0]!], 2, JSON.stringify(res.queued));

    // Explicit kinds win over the derived ones: a price + a stopSell with kinds ["rates"] → rates only.
    const date8 = J(8);
    const res2 = await write({
      cells: [
        { ratePlanId: "*", roomTypeId, date: date8, restrictions: { stopSell: true } },
        { ratePlanId: barPlanId, roomTypeId, date: date8, price: 108 }
      ],
      reason: `${MARK} kinds explícitos rates`,
      publish: { channelIds, kinds: ["rates"] }
    });
    const rows2 = await deliveriesOf(res2.journalId);
    assert.equal(rows2.length, 3, JSON.stringify(rows2));
    for (const r of rows2) assert.equal(r.kind, "rates", JSON.stringify(r));

    await revertOk(res2.journalId);
    await revertOk(res.journalId);
    assert.deepEqual((await getCell(date)).restrictions, {});
    assert.deepEqual((await getCell(date8)).restrictions, {});
    assert.equal((await getCell(date8)).basePrice, JUNE_PRICE);
  });

  it("recommendations: foreign roomTypeIds → 400 UNKNOWN_IDS listing only the foreign id (api-live-contract#6); apply after the bulk-update persists currentPrice / suggestedPrice / journalId, refuses a foreign journalId and validates in Spanish (cierre contract 3)", async () => {
    assert.ok(foreign, `${FOREIGN_PROPERTY_ID} (seed) is required for the cross-property cases`);
    await ensureJuneFixtures();
    const [from, to] = [J(9), J(11)];
    const recs = (extra: string) => app.inject({ method: "GET", url: `/properties/${PROPERTY_ID}/rate-grid/recommendations?from=${from}&to=${to}&roomTypeIds=${extra}`, headers });
    const foreignOnly = await recs(foreign.roomTypeId);
    assert.equal(foreignOnly.statusCode, 400, foreignOnly.body);
    assert.deepEqual((JSON.parse(foreignOnly.body) as ErrorBody).details, { code: "UNKNOWN_IDS", roomTypeIds: [foreign.roomTypeId] });
    const mixedIds = await recs(`${roomTypeId},${foreign.roomTypeId}`);
    assert.equal(mixedIds.statusCode, 400, mixedIds.body);
    assert.deepEqual((JSON.parse(mixedIds.body) as ErrorBody).details?.roomTypeIds, [foreign.roomTypeId], "only the foreign id is listed");
    const ownOnly = await recs(roomTypeId);
    assert.equal(ownOnly.statusCode, 200, ownOnly.body);

    const applyUrl = `/properties/${PROPERTY_ID}/rate-grid/recommendations/apply`;
    const rowsBefore = await prisma.revenueRecommendation.count({ where: { propertyId: PROPERTY_ID } });
    const foreignCell = await app.inject({ method: "POST", url: applyUrl, headers, payload: { from, to, ratePlanId: barPlanId, cells: [{ roomTypeId: foreign.roomTypeId, date: from, action: "reject" }] } });
    assert.equal(foreignCell.statusCode, 400, foreignCell.body);
    assert.equal((JSON.parse(foreignCell.body) as ErrorBody).details?.code, "UNKNOWN_IDS");
    assert.equal(await prisma.revenueRecommendation.count({ where: { propertyId: PROPERTY_ID } }), rowsBefore, "a refused apply persists nothing");

    // Contract 3: the editor writes first (bulk-update), then records the decision with the journal and what the user saw.
    const shown = (await getCell(from)).basePrice as number;
    const j = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date: from, price: 150 }], reason: `${MARK} recomendación ajustada a 150` });
    const apply = await app.inject({
      method: "POST",
      url: applyUrl,
      headers,
      payload: { from, to, ratePlanId: barPlanId, journalId: j.journalId, reason: `${MARK} traza de la recomendación`, cells: [{ roomTypeId, date: from, action: "adjust", currentPrice: shown, suggestedPrice: 140, appliedPrice: 150 }] }
    });
    assert.equal(apply.statusCode, 200, apply.body);
    const applied = JSON.parse(apply.body) as ApplyResponse;
    recommendationIds.push(...applied.recommendationIds);
    assert.deepEqual({ applied: applied.applied, rejected: applied.rejected, recorded: applied.recorded, journalId: applied.journalId, skipped: applied.skipped }, { applied: 1, rejected: 0, recorded: 1, journalId: j.journalId, skipped: [] });
    assert.deepEqual(applied.patches[0], { ratePlanId: barPlanId, roomTypeId, date: from, price: 150, expected: { price: shown } }, "the patch carries expected.price = what the user saw");
    const row = await prisma.revenueRecommendation.findUnique({ where: { id: applied.recommendationIds[0]! }, select: { status: true, currentValueJson: true, recommendedValueJson: true, reasonJson: true, ratePlanId: true } });
    assert.ok(row);
    assert.equal(row.status, "applied");
    assert.equal(row.ratePlanId, barPlanId);
    const current = row.currentValueJson as { price?: number; priceSource?: string; enginePrice?: number | null; barSource?: string };
    assert.equal(current.price, shown, "currentValueJson.price is the baseline the user saw, not the recalculation after the write");
    assert.equal(current.priceSource, "client");
    assert.equal(current.barSource, "rate_grid");
    assert.ok(current.enginePrice === null || typeof current.enginePrice === "number", JSON.stringify(current));
    const recommended = row.recommendedValueJson as { shownPrice?: number | null; appliedPrice?: number | null; decision?: string };
    assert.deepEqual({ shownPrice: recommended.shownPrice, appliedPrice: recommended.appliedPrice, decision: recommended.decision }, { shownPrice: 140, appliedPrice: 150, decision: "adjust" });
    assert.equal((row.reasonJson as { journalId?: string | null }).journalId, j.journalId);

    // A journal of another property → 400 UNKNOWN_IDS with the id, nothing persisted.
    const rowsMid = await prisma.revenueRecommendation.count({ where: { propertyId: PROPERTY_ID } });
    const foreignJournal = await app.inject({ method: "POST", url: applyUrl, headers, payload: { from, to, ratePlanId: barPlanId, journalId: foreign.journalId, cells: [{ roomTypeId, date: J(10), action: "accept", appliedPrice: 120 }] } });
    assert.equal(foreignJournal.statusCode, 400, foreignJournal.body);
    assert.deepEqual((JSON.parse(foreignJournal.body) as ErrorBody).details, { code: "UNKNOWN_IDS", journalIds: [foreign.journalId] });
    assert.equal(await prisma.revenueRecommendation.count({ where: { propertyId: PROPERTY_ID } }), rowsMid);

    // Validation in Spanish, with the field path.
    const zero = await app.inject({ method: "POST", url: applyUrl, headers, payload: { from, to, ratePlanId: barPlanId, cells: [{ roomTypeId, date: J(10), action: "accept", currentPrice: 0, appliedPrice: 120 }] } });
    assert.equal(zero.statusCode, 400, zero.body);
    assert.equal((JSON.parse(zero.body) as ErrorBody).message, "cuerpo inválido: cells.0.currentPrice: debe ser mayor que 0");
    const config = await app.inject({ method: "PUT", url: `/properties/${PROPERTY_ID}/rate-grid/recommendations/config`, headers, payload: { minDeltaPct: 51 } });
    assert.equal(config.statusCode, 400, config.body);
    assert.equal((JSON.parse(config.body) as ErrorBody).message, "cuerpo inválido: minDeltaPct: debe ser menor o igual que 50");

    await revertOk(j.journalId);
    assert.equal((await getCell(from)).basePrice, shown);
  });

  it("rate plans: a plan with active derived children cannot become derived (400 DERIVATION_CHAIN) and a rule yielding 0 € on the parent's minimum is refused (400 DERIVATION_YIELDS_ZERO) (CSC-13, CSC-07)", async () => {
    assert.ok(nrPlanId, "BAR-NR (derived, active) is created by the derived-plan case");
    const zero = await app.inject({
      method: "POST",
      url: `/properties/${PROPERTY_ID}/rate-plans`,
      headers,
      payload: { code: `${TEMP_PLAN_PREFIX}ZERO`, name: `${MARK} regla a 0 €`, ratePlanType: "derived", parentRatePlanId: barPlanId, derivationJson: { mode: "amount", value: -200 } }
    });
    assert.equal(zero.statusCode, 400, zero.body);
    const zeroBody = JSON.parse(zero.body) as ErrorBody;
    assert.equal(zeroBody.details?.code, "DERIVATION_YIELDS_ZERO", zero.body);
    assert.equal(typeof zeroBody.details?.parentMinPrice, "number", zero.body);
    assert.equal(await prisma.ratePlan.count({ where: { propertyId: PROPERTY_ID, code: `${TEMP_PLAN_PREFIX}ZERO` } }), 0, "a refused plan must not be created");
    // −100 % is refused by the schema itself, in Spanish.
    const full = await app.inject({ method: "POST", url: `/properties/${PROPERTY_ID}/rate-plans`, headers, payload: { code: `${TEMP_PLAN_PREFIX}FULL`, name: "x", ratePlanType: "derived", parentRatePlanId: barPlanId, derivationJson: { mode: "percent", value: -100 } } });
    assert.equal(full.statusCode, 400, full.body);
    assert.doesNotMatch((JSON.parse(full.body) as ErrorBody).message, /Number must|Required|Invalid/);

    // No chains: BAR feeds BAR-NR, so BAR itself cannot derive from another base plan.
    const base = await app.inject({ method: "POST", url: `/properties/${PROPERTY_ID}/rate-plans`, headers, payload: { code: `${TEMP_PLAN_PREFIX}BASE`, name: `${MARK} plan base temporal`, ratePlanType: "bar" } });
    assert.equal(base.statusCode, 200, base.body);
    const baseId = (JSON.parse(base.body) as { id: string }).id;
    try {
      const chain = await app.inject({ method: "PATCH", url: `/rate-plans/${barPlanId}`, headers, payload: { ratePlanType: "derived", parentRatePlanId: baseId, derivationJson: { mode: "percent", value: -5 } } });
      assert.equal(chain.statusCode, 400, chain.body);
      const chainBody = JSON.parse(chain.body) as ErrorBody;
      assert.equal(chainBody.details?.code, "DERIVATION_CHAIN", chain.body);
      assert.ok((chainBody.details?.children as string[]).includes("BAR-NR"), chain.body);
      const bar = await prisma.ratePlan.findUnique({ where: { id: barPlanId }, select: { ratePlanType: true, parentRatePlanId: true } });
      assert.deepEqual(bar, { ratePlanType: "bar", parentRatePlanId: null }, "a refused PATCH leaves BAR as it was");
    } finally {
      await prisma.ratePlan.deleteMany({ where: { id: baseId, propertyId: PROPERTY_ID } });
    }
  });

  it("DELETE /rate-plans/:derived (soft delete) → a direct write on it is 400 INACTIVE_RATE_PLANS while the revert of an entry that wrote it still works (CSC-18)", async () => {
    assert.ok(nrPlanId, "BAR-NR (derived) is created by the derived-plan case");
    const nr = nrPlanId;
    await ensureJuneFixtures();
    const date = J(13);
    const childRow = () => prisma.rateDay.findUnique({ where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: PROPERTY_ID, ratePlanId: nr, roomTypeId, date: dayUtc(date) } }, select: { price: true, source: true } });
    // The parent write materialises the child; the user then breaks the derivation on that cell.
    const jParent = await write({ cells: [{ ratePlanId: barPlanId, roomTypeId, date, price: 110 }], reason: `${MARK} padre 110 antes de desactivar` });
    assert.equal(jParent.derivedUpdated, 1, JSON.stringify(jParent));
    const jChild = await write({ cells: [{ ratePlanId: nr, roomTypeId, date, price: 99, convertToManual: true }], reason: `${MARK} hijo manual antes de desactivar` });
    assert.equal(jChild.updated, 1, JSON.stringify(jChild));
    assert.deepEqual({ price: Number((await childRow())?.price), source: (await childRow())?.source }, { price: 99, source: "manual" });

    const del = await app.inject({ method: "DELETE", url: `/rate-plans/${nr}`, headers });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal((await prisma.ratePlan.findUnique({ where: { id: nr }, select: { active: true } }))?.active, false, "DELETE is a soft delete");
    const grid = await getGrid(date, date);
    assert.ok(!grid.ratePlans.some((p) => p.id === nr), "the grid no longer lists the inactive plan");

    const direct = await bulk({ cells: [{ ratePlanId: nr, roomTypeId, date, price: 50 }], reason: `${MARK} escritura en plan inactivo` });
    assert.equal(direct.status, 400, direct.raw);
    assert.equal(direct.body.details?.code, "INACTIVE_RATE_PLANS", direct.raw);
    assert.deepEqual(direct.body.details?.ratePlanIds, [nr]);
    assert.match(direct.body.message, /reactívalos/);
    assert.equal(Number((await childRow())?.price), 99, "a refused write leaves the cell as it was");

    // The entry that wrote the (now inactive) plan is still revertible: the override goes back to the derived value.
    const undo = await revert(jChild.journalId);
    assert.equal(undo.status, 200, undo.raw);
    const restored = await childRow();
    assert.deepEqual({ price: Number(restored?.price), source: restored?.source }, { price: applyDerivation(110, BAR_NR_DERIVATION), source: "derived" });
    assert.equal((await journalEntry(jChild.journalId)).status, "reverted");
    await revertOk(jParent.journalId);
    assert.equal((await getCell(date)).basePrice, JUNE_PRICE);
  });
});
