// Unit tests · Tanda T8 · lote T8-C — tick de sincronización
// (reputation-sync.service.ts) con un stub de prisma en memoria: dos ticks con
// el mismo colector → el segundo crea 0; una fuente `unavailable` no llama a
// fetchImpl y queda en skipped; el error de una fuente no impide las demás;
// la alerta abre UN caso y no lo duplica; el análisis lleva etiqueta honesta
// `dictionary`; el modo email lee InboundEmail sin modificarlo. Sin base de
// datos, sin red. Datos ficticios. Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-sync-idempotency.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOKING_UNAVAILABLE_REASON, collectorFor as registryCollectorFor, type FetchLike, type NormalizedReview, type ReviewCollector } from "../collectors/index.js";
import { DEFAULT_SOURCE_CAPABILITIES, readReviewMeta, readSourceConfig } from "../reputation-types.js";
import { collectFromInboundEmails, runReputationSync, sinceFor, sourceCodeFor } from "../reputation-sync.service.js";
import type { ReputationDb } from "../review-meta.store.js";

const NOW = new Date("2026-09-19T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

// ---------------------------------------------------------------------------
// Stub de prisma en memoria
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  if (typeof value === "number") return value;
  return Number.NaN;
}
function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return toTime(a) === toTime(b);
  return a === b;
}
function compare(a: unknown, b: unknown): number {
  if (a instanceof Date || b instanceof Date) return toTime(a) - toTime(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}
function matches(row: Row, where: Row | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(cond as Row[]).some((entry) => matches(row, entry))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) {
      if (!eq(value, cond)) return false;
      continue;
    }
    const c = cond as Row;
    if ("in" in c && !(c.in as unknown[]).some((entry) => eq(value, entry))) return false;
    if ("not" in c && eq(value, c.not)) return false;
    if ("gte" in c && !(value !== null && value !== undefined && compare(value, c.gte) >= 0)) return false;
    if ("lt" in c && !(value !== null && value !== undefined && compare(value, c.lt) < 0)) return false;
    if ("path" in c) {
      const target = (c.path as string[]).reduce<unknown>((acc, segment) => (acc && typeof acc === "object" ? (acc as Row)[segment] : undefined), value);
      if ("equals" in c && target !== c.equals) return false;
    }
  }
  return true;
}
function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Row[];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, direction] of Object.entries(spec)) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const delta = compare(av, bv);
        if (delta !== 0) return direction === "desc" ? -delta : delta;
      }
    }
    return 0;
  });
}

type StubDb = { db: ReputationDb; tables: Tables; calls: string[] };

function createStubDb(seed: Partial<Tables> = {}): StubDb {
  const tables: Tables = { guestReview: [], reviewSource: [], qualityCase: [], module: [], propertyModule: [], inboundEmail: [], property: [], ...structuredClone(seed) };
  const calls: string[] = [];
  let seq = 0;
  const delegate = (name: string) => ({
    findFirst: async (args: { where?: Row } = {}) => {
      calls.push(`${name}.findFirst`);
      return structuredClone(tables[name]!.find((row) => matches(row, args.where)) ?? null);
    },
    findMany: async (args: { where?: Row; orderBy?: unknown; take?: number } = {}) => {
      calls.push(`${name}.findMany`);
      let rows = sortRows(tables[name]!.filter((row) => matches(row, args.where)), args.orderBy);
      if (typeof args.take === "number") rows = rows.slice(0, args.take);
      return structuredClone(rows);
    },
    create: async (args: { data: Row }) => {
      calls.push(`${name}.create`);
      seq += 1;
      const row: Row = { id: `${name}_${seq}`, createdAt: new Date(NOW.getTime() + seq), ...structuredClone(args.data) };
      tables[name]!.push(row);
      return structuredClone(row);
    },
    update: async (args: { where: { id: string }; data: Row }) => {
      calls.push(`${name}.update`);
      const row = tables[name]!.find((entry) => entry.id === args.where.id);
      if (!row) throw new Error(`${name} ${args.where.id} no existe`);
      Object.assign(row, structuredClone(args.data));
      return structuredClone(row);
    }
  });
  const db = {
    guestReview: delegate("guestReview"),
    reviewSource: delegate("reviewSource"),
    qualityCase: delegate("qualityCase"),
    module: delegate("module"),
    propertyModule: delegate("propertyModule"),
    inboundEmail: delegate("inboundEmail"),
    property: delegate("property"),
    $queryRaw: async () => [{ daily: null, runs: null, mentions: null }]
  } as unknown as ReputationDb;
  return { db, tables, calls };
}

// ---------------------------------------------------------------------------
// Fixtures ficticias y colectores falsos
// ---------------------------------------------------------------------------

const FIXTURES: NormalizedReview[] = [
  { externalId: "demo-001", receivedAt: daysAgo(3).toISOString(), ratingRaw: 4.5, ratingScaleMax: 5, title: "Estancia estupenda", body: "El personal fue amable y la habitación estaba impecable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Uno", replyCapability: false },
  { externalId: "demo-002", receivedAt: daysAgo(2).toISOString(), ratingRaw: 7, ratingScaleMax: 10, title: "Correcto", body: "Bien situado, aunque el desayuno era mejorable.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Dos", replyCapability: false },
  { externalId: "demo-003", receivedAt: daysAgo(1).toISOString(), ratingRaw: 1.5, ratingScaleMax: 5, title: "Muy mal", body: "La habitación estaba sucia y había mucho ruido por la noche.", bodyComplete: true, language: "es", authorDisplayName: "Huésped Ficticio Tres", replyCapability: false }
];

const fakeDemoCollector: ReviewCollector = {
  provider: "demo",
  mode: "demo",
  capabilities: DEFAULT_SOURCE_CAPABILITIES.demo,
  describeState: () => ({ status: "connected" }),
  fetchSince: async () => ({ items: FIXTURES, status: "connected" })
};

const throwingCsvCollector: ReviewCollector = {
  provider: "csv",
  mode: "csv",
  capabilities: DEFAULT_SOURCE_CAPABILITIES.csv,
  describeState: () => ({ status: "connected" }),
  fetchSince: async () => {
    throw new Error("fallo simulado del colector");
  }
};

function collectorWith(overrides: Record<string, ReviewCollector>) {
  return (provider: string, mode: Parameters<typeof registryCollectorFor>[1]) => overrides[provider] ?? registryCollectorFor(provider, mode);
}

function spyFetch(): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  return { fetchImpl, calls };
}

function spies() {
  const audits: Row[] = [];
  const events: Row[] = [];
  const invalidated: string[] = [];
  return {
    audits,
    events,
    invalidated,
    deps: {
      audit: ((input: Row) => {
        audits.push(input);
        return input as never;
      }) as never,
      domainEvent: ((input: Row) => {
        events.push(input);
        return input as never;
      }) as never,
      invalidateCache: (propertyId: string) => {
        invalidated.push(propertyId);
      }
    }
  };
}

function seedTenant(extraSources: Row[] = []): StubDb {
  return createStubDb({
    module: [{ id: "mod_rep", code: "reputation_quality", name: "Reputación", category: "guest", isCore: false, createdAt: NOW }],
    propertyModule: [{ id: "pm_1", propertyId: "prop_a", moduleId: "mod_rep", status: "enabled", configurationJson: { reputation: { defaultOwnerUserId: "usr_owner" } }, createdAt: NOW }],
    property: [{ id: "prop_a", organizationId: "org_a", name: "Hotel Ficticio del Norte", createdAt: NOW }],
    reviewSource: [
      { id: "src_demo", propertyId: "prop_a", provider: "demo", status: "connected", configJson: { mode: "demo" }, createdAt: daysAgo(10) },
      { id: "src_booking", propertyId: "prop_a", provider: "booking", status: "unavailable", configJson: { mode: "api" }, createdAt: daysAgo(9) },
      ...extraSources
    ]
  });
}

// ---------------------------------------------------------------------------

describe("helpers puros", () => {
  it("sinceFor: 30 días sin historial; última ejecución correcta − 2 días de solape", () => {
    assert.equal(sinceFor({}, NOW).toISOString(), daysAgo(30).toISOString());
    assert.equal(sinceFor({ lastSuccessAt: daysAgo(1).toISOString() }, NOW).toISOString(), daysAgo(3).toISOString());
  });
  it("sourceCodeFor: portal real de la reseña y sufijo _demo en fuentes demo", () => {
    assert.equal(sourceCodeFor(FIXTURES[0]!, "demo", true), "demo");
    assert.equal(sourceCodeFor({ ...FIXTURES[0]!, portalProvider: "tripadvisor" }, "email", false), "tripadvisor");
    assert.equal(sourceCodeFor(FIXTURES[0]!, "google", true), "google_demo");
  });
});

describe("runReputationSync · idempotencia", () => {
  it("dos ticks con el mismo colector: el primero crea 3 y analiza con etiqueta dictionary; el segundo crea 0 y deja 3 unchanged", async () => {
    const { db, tables } = seedTenant();
    const fetch = spyFetch();
    const spy = spies();
    const first = await runReputationSync({ db, now: NOW, trigger: "manual", fetchImpl: fetch.fetchImpl, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(first.properties, 1);
    assert.equal(first.sources, 2);
    assert.equal(first.fetched, 3);
    assert.equal(first.created, 3);
    assert.equal(first.updated, 0);
    assert.equal(first.unchanged, 0);
    assert.equal(first.analyzed, 3);
    assert.equal(first.alerts, 1);
    assert.equal(first.purged, 0);
    assert.deepEqual(first.errors, []);
    assert.equal(first.trigger, "manual");
    assert.equal(tables.guestReview!.length, 3);
    for (const row of tables.guestReview!) {
      const meta = readReviewMeta(row.topicsJson);
      assert.equal(meta.analysis.status, "done");
      assert.equal(meta.analysis.source, "dictionary");
      assert.equal(meta.analysis.note, "llm_not_configured");
      assert.equal(typeof row.sentiment, "string");
      assert.equal(meta.sourceId, "src_demo");
      assert.equal(meta.sourceMode, "demo");
      assert.equal(meta.isDemo, true);
    }
    assert.deepEqual(spy.invalidated, ["prop_a"]);
    assert.equal(first.byProperty.length, 1);
    assert.equal(first.byProperty[0]!.casesOpened, 1);
    assert.equal(first.byProperty[0]!.indexRecomputed, true);
    assert.equal(first.byProperty[0]!.runs.length, 2);
    const demoConfig = readSourceConfig(tables.reviewSource!.find((row) => row.id === "src_demo")!.configJson, "demo");
    assert.equal(demoConfig.runs.length, 1);
    assert.equal(demoConfig.runs[0]!.status, "completed");
    assert.equal(demoConfig.runs[0]!.created, 3);
    assert.equal(demoConfig.runs[0]!.trigger, "manual");
    assert.equal(typeof demoConfig.lastSuccessAt, "string");

    const second = await runReputationSync({ db, now: new Date(NOW.getTime() + 3_600_000), fetchImpl: fetch.fetchImpl, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 3);
    assert.equal(second.updated, 0);
    assert.equal(second.analyzed, 0);
    assert.equal(second.alerts, 0);
    assert.equal(tables.guestReview!.length, 3);
    assert.equal(tables.qualityCase!.length, 1);
    assert.equal(readSourceConfig(tables.reviewSource!.find((row) => row.id === "src_demo")!.configJson, "demo").runs.length, 2);
    assert.equal(fetch.calls.length, 0);
  });

  it("una fuente unavailable no llama a fetchImpl, queda en skipped con su motivo y conserva el estado", async () => {
    const { db, tables } = seedTenant();
    const fetch = spyFetch();
    const spy = spies();
    const out = await runReputationSync({ db, now: NOW, fetchImpl: fetch.fetchImpl, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.deepEqual(out.skipped, [{ sourceId: "src_booking", propertyId: "prop_a", reason: BOOKING_UNAVAILABLE_REASON }]);
    assert.equal(fetch.calls.length, 0);
    const booking = tables.reviewSource!.find((row) => row.id === "src_booking")!;
    assert.equal(booking.status, "unavailable");
    const config = readSourceConfig(booking.configJson, "booking");
    assert.equal(config.runs.length, 1);
    assert.equal(config.runs[0]!.status, "skipped");
    assert.equal(config.runs[0]!.error, BOOKING_UNAVAILABLE_REASON);
    assert.equal(config.lastError, BOOKING_UNAVAILABLE_REASON);
    assert.equal(config.lastSuccessAt, undefined);
  });

  it("el error de una fuente no impide las demás: queda en errors, la fuente pasa a error con lastError y la demo sigue creando", async () => {
    const { db, tables } = seedTenant([{ id: "src_csv", propertyId: "prop_a", provider: "csv", status: "connected", configJson: { mode: "csv" }, createdAt: daysAgo(8) }]);
    const spy = spies();
    const out = await runReputationSync({ db, now: NOW, collectorFor: collectorWith({ demo: fakeDemoCollector, csv: throwingCsvCollector }), deps: spy.deps });
    assert.deepEqual(out.errors, [{ sourceId: "src_csv", propertyId: "prop_a", message: "fallo simulado del colector" }]);
    assert.equal(out.created, 3);
    assert.equal(out.sources, 3);
    const csv = tables.reviewSource!.find((row) => row.id === "src_csv")!;
    assert.equal(csv.status, "error");
    const config = readSourceConfig(csv.configJson, "csv");
    assert.equal(config.lastError, "fallo simulado del colector");
    assert.equal(config.runs[0]!.status, "failed");
    assert.equal(out.byProperty[0]!.failed, 1);
  });
});

describe("runReputationSync · alertas", () => {
  it("score10 < 6 abre UN caso review_negative (urgent < 4, owner por defecto, SLA 48 h, ReviewReceived) y no lo duplica", async () => {
    const { db, tables } = seedTenant();
    const spy = spies();
    await runReputationSync({ db, now: NOW, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(tables.qualityCase!.length, 1);
    const qualityCase = tables.qualityCase![0]!;
    assert.equal(qualityCase.propertyId, "prop_a");
    assert.equal(qualityCase.caseType, "review_negative");
    assert.equal(qualityCase.priority, "urgent");
    assert.equal(qualityCase.status, "open");
    assert.equal(qualityCase.ownerUserId, "usr_owner");
    assert.equal(qualityCase.title, "Reseña negativa · Demo (datos ficticios) · 3/10");
    assert.match(String(qualityCase.description), /^\[reseña:guestReview_\d+\]\n/);
    assert.equal(toTime(qualityCase.slaTargetAt), NOW.getTime() + 48 * 3_600_000);
    assert.ok(["Limpieza", "Ruido"].includes(String(qualityCase.rootCause)), `rootCause = ${String(qualityCase.rootCause)}`);
    const negative = tables.guestReview!.find((row) => row.externalReference === "demo-003")!;
    const meta = readReviewMeta(negative.topicsJson);
    assert.equal(meta.qualityCaseId, qualityCase.id);
    assert.equal(meta.status, "assigned");
    assert.equal(meta.assignedUserId, "usr_owner");
    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0]!.eventType, "ReviewReceived");
    assert.equal(spy.events[0]!.entityType, "guest_review");
    assert.equal(spy.events[0]!.entityId, negative.id);
    assert.equal(spy.events[0]!.organizationId, "org_a");
    assert.equal(spy.events[0]!.actorType, "system");
    assert.deepEqual(spy.events[0]!.payload, { score10: 3, source: "demo", negative: true, qualityCaseId: qualityCase.id });
    assert.equal(spy.audits.length, 1);
    assert.equal(spy.audits[0]!.action, "ReviewReceived");
    assert.equal(spy.audits[0]!.actorType, "system");
    assert.equal(spy.audits[0]!.entityId, negative.id);

    const again = await runReputationSync({ db, now: new Date(NOW.getTime() + DAY), collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(again.alerts, 0);
    assert.equal(tables.qualityCase!.length, 1);
    assert.equal(spy.events.length, 1);
    assert.equal(spy.audits.length, 1);
  });

  it("una reseña negativa ignorada por un usuario no abre caso", async () => {
    const { db, tables } = seedTenant();
    tables.guestReview!.push({
      id: "guestReview_prev",
      propertyId: "prop_a",
      source: "demo",
      rating: 1,
      title: "Fatal",
      body: "Nada funcionaba.",
      language: "es",
      sentiment: "negative",
      topicsJson: { v: 1, score10: 2, status: "ignored", contentHash: "x", sourceMode: "demo", analysis: { status: "done", source: "dictionary" } },
      externalReference: "demo-prev",
      receivedAt: daysAgo(5),
      respondedAt: null,
      responseBody: null,
      createdAt: daysAgo(5)
    });
    const spy = spies();
    const out = await runReputationSync({ db, now: NOW, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(out.alerts, 1);
    assert.equal(tables.qualityCase!.length, 1);
    assert.notEqual(tables.qualityCase![0]!.description, undefined);
    assert.equal(readReviewMeta(tables.guestReview!.find((row) => row.id === "guestReview_prev")!.topicsJson).qualityCaseId, undefined);
  });
});

describe("runReputationSync · modo email", () => {
  const emails: Row[] = [
    {
      id: "em_1",
      connectionId: "conn_1",
      propertyId: "prop_a",
      provider: "gmail",
      messageId: "msg-ta-001",
      fromAddress: "Tripadvisor <no-reply@e.tripadvisor.com>",
      subject: 'New review from Huésped Ficticio: "Great stay"',
      snippet: "Huésped F. rated your hotel 4 of 5 bubbles. Lovely staff and a quiet room.",
      status: "ignored",
      receivedAt: daysAgo(2),
      createdAt: daysAgo(2)
    },
    {
      id: "em_2",
      connectionId: "conn_1",
      propertyId: "prop_a",
      provider: "gmail",
      messageId: "msg-bk-002",
      fromAddress: "noreply@booking.com",
      subject: "Nueva reserva: 2 noches en septiembre",
      snippet: "Confirmación de reserva.",
      status: "review",
      receivedAt: daysAgo(1),
      createdAt: daysAgo(1)
    }
  ];

  it("collectFromInboundEmails clasifica, parsea y usa email:<messageId> como referencia", () => {
    const out = collectFromInboundEmails(emails as never, "tripadvisor", daysAgo(30), NOW);
    assert.equal(out.items.length, 1);
    assert.equal(out.skipped, 1);
    assert.equal(out.items[0]!.externalReference, "email:msg-ta-001");
    assert.equal(out.items[0]!.item.portalProvider, "tripadvisor");
    assert.equal(out.items[0]!.item.bodyComplete, false);
  });

  it("el tick lee InboundEmail (ignored | review | review_notification) SIN modificarlo y crea la reseña con la referencia email:<messageId>", async () => {
    const { db, tables, calls } = seedTenant([{ id: "src_ta", propertyId: "prop_a", provider: "tripadvisor", status: "connected", configJson: { mode: "email", externalAccountId: "conn_1" }, createdAt: daysAgo(7) }]);
    tables.inboundEmail!.push(...structuredClone(emails));
    const spy = spies();
    const out = await runReputationSync({ db, now: NOW, sourceIds: ["src_ta"], collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(out.sources, 1);
    assert.equal(out.fetched, 1);
    assert.equal(out.created, 1);
    const row = tables.guestReview![0]!;
    assert.equal(row.source, "tripadvisor");
    assert.equal(row.externalReference, "email:msg-ta-001");
    assert.equal(row.rating, 4);
    const meta = readReviewMeta(row.topicsJson);
    assert.equal(meta.sourceMode, "email");
    assert.equal(meta.sourceId, "src_ta");
    assert.equal(meta.bodyComplete, false);
    assert.equal(meta.score10, 8);
    assert.equal(calls.filter((call) => call.startsWith("inboundEmail.") && call !== "inboundEmail.findMany").length, 0);
    assert.equal(tables.inboundEmail![0]!.status, "ignored");
    const config = readSourceConfig(tables.reviewSource!.find((source) => source.id === "src_ta")!.configJson, "tripadvisor");
    assert.equal(config.runs[0]!.fetched, 1);
    assert.deepEqual(config.cursor, { lastCheckedAt: NOW.toISOString(), processed: 2, skipped: 1 });
  });
});

describe("runReputationSync · lectura parcial, cupo por propiedad, lock y reconciliación (corrección ronda 1)", () => {
  const degradedGoogle: ReviewCollector = {
    provider: "google",
    mode: "api",
    capabilities: DEFAULT_SOURCE_CAPABILITIES.google,
    describeState: () => ({ status: "connected" }),
    fetchSince: async () => ({ items: [FIXTURES[0]!], status: "degraded", error: "Google Business Profile API 429: rate limited" })
  };

  it("BD-01: un fetch degradado a mitad de paginación queda `partial`: guarda lo leído, NO avanza lastSuccessAt, conserva lastError y cuenta como error del tick", async () => {
    const { db, tables } = seedTenant([{ id: "src_g", propertyId: "prop_a", provider: "google", status: "connected", configJson: { mode: "api", externalLocationId: "accounts/1/locations/2", lastSuccessAt: daysAgo(5).toISOString() }, createdAt: daysAgo(8) }]);
    const spy = spies();
    const out = await runReputationSync({ db, now: NOW, sourceIds: ["src_g"], collectorFor: collectorWith({ google: degradedGoogle }), deps: spy.deps });
    assert.equal(out.created, 1, "lo leído se guarda");
    const source = tables.reviewSource!.find((row) => row.id === "src_g")!;
    assert.equal(source.status, "degraded");
    const config = readSourceConfig(source.configJson, "google");
    assert.equal(config.runs[0]!.status, "partial");
    assert.equal(config.runs[0]!.fetched, 1);
    assert.equal(config.runs[0]!.error, "Google Business Profile API 429: rate limited");
    assert.equal(config.lastSuccessAt, daysAgo(5).toISOString(), "lastSuccessAt no avanza: la siguiente vuelta repite la ventana");
    assert.equal(config.lastError, "Google Business Profile API 429: rate limited");
    assert.equal(config.lastRunAt, config.runs[0]!.finishedAt);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0]!.sourceId, "src_g");
    assert.equal(out.byProperty[0]!.failed, 1);
  });

  it("BD-08: el cupo de análisis es por propiedad y tick (la primera no agota el de la segunda)", async () => {
    const { db, tables } = createStubDb({
      module: [{ id: "mod_rep", code: "reputation_quality", name: "Reputación", category: "guest", isCore: false, createdAt: NOW }],
      propertyModule: [
        { id: "pm_a", propertyId: "prop_a", moduleId: "mod_rep", status: "enabled", configurationJson: {}, createdAt: NOW },
        { id: "pm_b", propertyId: "prop_b", moduleId: "mod_rep", status: "enabled", configurationJson: {}, createdAt: NOW }
      ],
      property: [
        { id: "prop_a", organizationId: "org_a", name: "Hotel A", createdAt: NOW },
        { id: "prop_b", organizationId: "org_a", name: "Hotel B", createdAt: NOW }
      ],
      reviewSource: [
        { id: "src_a", propertyId: "prop_a", provider: "demo", status: "connected", configJson: { mode: "demo" }, createdAt: daysAgo(10) },
        { id: "src_b", propertyId: "prop_b", provider: "demo", status: "connected", configJson: { mode: "demo" }, createdAt: daysAgo(10) }
      ]
    });
    const spy = spies();
    const out = await runReputationSync({ db, now: NOW, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps, maxAnalysisPerTick: 2 });
    const a = out.byProperty.find((entry) => entry.propertyId === "prop_a")!;
    const b = out.byProperty.find((entry) => entry.propertyId === "prop_b")!;
    assert.equal(a.analyzed, 2);
    assert.equal(b.analyzed, 2, "la segunda propiedad tiene su propio cupo");
    assert.equal(out.analyzed, 4);
    assert.equal(tables.guestReview!.filter((row) => readReviewMeta(row.topicsJson).analysis.status === "pending").length, 2);
  });

  it("withPropertyLock: la propiedad sin lock se salta con skipReason lock y no toca sus fuentes", async () => {
    const { db, tables, calls } = seedTenant();
    const spy = spies();
    const out = await runReputationSync({
      db,
      now: NOW,
      collectorFor: collectorWith({ demo: fakeDemoCollector }),
      deps: spy.deps,
      withPropertyLock: async () => ({ locked: false as const })
    });
    assert.equal(out.byProperty[0]!.skipped, true);
    assert.equal(out.byProperty[0]!.skipReason, "lock");
    assert.deepEqual(out.skipped, [{ sourceId: "", propertyId: "prop_a", reason: "lock" }]);
    assert.equal(tables.guestReview!.length, 0);
    assert.equal(calls.filter((call) => call === "reviewSource.findMany").length, 0);
    const locked = await runReputationSync({ db, now: NOW, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps, withPropertyLock: async (_propertyId, run) => ({ locked: true as const, result: await run(), lockExpired: false }) });
    assert.equal(locked.byProperty[0]!.skipped, false);
    assert.equal(locked.created, 3);
  });

  it("T8F-02: una reseña respondida por POST …/respond (respondedAt sin meta) se reconcilia a `responded` en el tick", async () => {
    const { db, tables } = seedTenant();
    tables.guestReview!.push({
      id: "rev_out",
      propertyId: "prop_a",
      source: "google",
      rating: 2,
      title: null,
      body: "Texto ficticio",
      language: "es",
      sentiment: "negative",
      topicsJson: { v: 1, score10: 4, status: "assigned", contentHash: "h", sourceMode: "api", analysis: { status: "done", source: "dictionary" }, categories: [] },
      externalReference: "g-out",
      receivedAt: daysAgo(4),
      respondedAt: daysAgo(1),
      responseBody: "Gracias",
      createdAt: daysAgo(4)
    });
    const spy = spies();
    const out = await runReputationSync({ db, now: NOW, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(out.reconciled, 1);
    assert.equal(readReviewMeta(tables.guestReview!.find((row) => row.id === "rev_out")!.topicsJson).status, "responded");
    const again = await runReputationSync({ db, now: NOW, collectorFor: collectorWith({ demo: fakeDemoCollector }), deps: spy.deps });
    assert.equal(again.reconciled, 0, "idempotente");
  });
});

describe("runReputationSync · alcance", () => {
  it("sin fila del módulo el tick queda vacío; propertyIds acota; una propiedad sin fuentes se marca no_sources", async () => {
    const empty = createStubDb();
    const none = await runReputationSync({ db: empty.db, now: NOW });
    assert.equal(none.properties, 0);
    assert.deepEqual(none.byProperty, []);

    const { db } = seedTenant();
    const other = await runReputationSync({ db, now: NOW, propertyIds: ["prop_zzz"], collectorFor: collectorWith({ demo: fakeDemoCollector }) });
    assert.equal(other.properties, 0);

    const bare = createStubDb({
      module: [{ id: "mod_rep", code: "reputation_quality", name: "Reputación", category: "guest", isCore: false, createdAt: NOW }],
      propertyModule: [{ id: "pm_1", propertyId: "prop_a", moduleId: "mod_rep", status: "enabled", configurationJson: {}, createdAt: NOW }],
      property: [{ id: "prop_a", organizationId: "org_a", name: "Hotel Ficticio", createdAt: NOW }]
    });
    const spy = spies();
    const out = await runReputationSync({ db: bare.db, now: NOW, deps: spy.deps });
    assert.equal(out.properties, 1);
    assert.equal(out.sources, 0);
    assert.equal(out.byProperty[0]!.skipped, true);
    assert.equal(out.byProperty[0]!.skipReason, "no_sources");
    assert.deepEqual(spy.invalidated, ["prop_a"]);
  });
});
