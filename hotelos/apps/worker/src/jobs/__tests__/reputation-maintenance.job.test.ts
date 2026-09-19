// Test unitario de jobs/reputation-maintenance.job.ts (Tanda T8 · lote T8-F).
//
// Sin base de datos: un cliente en memoria con findMany/update que registran
// cada llamada (guestReview no tiene deleteMany ni updateMany: si el job los
// usara, fallaría; reviewCategoryMention solo expone el updateMany de la purga
// de snippets) y, para el tick de pg-boss, los métodos de prisma.workerJobRun
// sustituidos sobre el singleton como hace catalog.test.ts con findMany.
//
// Vive en src/jobs/__tests__/ porque tests/worker-integration-contract.test.mjs
// fija la lista exacta de ficheros de src/__tests__/; el script de test del
// worker ("src/**/__tests__/*.test.ts") lo ejecuta igualmente.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import {
  REPUTATION_MAINTENANCE_CRON,
  REPUTATION_MAINTENANCE_QUEUE,
  RETENTION_DAYS_DEFAULT,
  RETENTION_DAYS_GOOGLE,
  REVIEW_OPEN_STATUSES,
  REVIEW_STATUSES,
  RUN_HISTORY_LIMIT,
  registerReputationMaintenanceQueue,
  runReputationMaintenance,
  sourceRetentionDays,
  trimRunHistory,
  type ReputationMaintenanceDb,
  type ReviewUpdateData
} from "../reputation-maintenance.job.js";

type JsonRecord = Record<string, unknown>;

type SourceRecord = { id: string; propertyId: string; provider: string; configJson: JsonRecord; createdAt: Date };

type ReviewRecord = {
  id: string;
  propertyId: string;
  source: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  responseBody: string | null;
  receivedAt: Date | null;
  respondedAt: Date | null;
  topicsJson: JsonRecord;
  createdAt: Date;
  // Columnas de T8-L0b fase 1 que la purga también debe vaciar/fijar.
  authorDisplayName: string | null;
  summary: string | null;
  bodyPurgedAt: Date | null;
};

type ReviewWhere = { propertyId: string; receivedAt?: { lt: Date }; respondedAt?: null };

type Calls = {
  sourceFindMany: number;
  sourceUpdate: Array<{ where: { id: string }; data: { configJson: unknown } }>;
  reviewFindMany: ReviewWhere[];
  reviewUpdate: Array<{ where: { id: string }; data: ReviewUpdateData }>;
  mentionUpdateMany: Array<{ where: { reviewId: string }; data: { snippet: null } }>;
};

type MemoryDb = { db: ReputationMaintenanceDb; calls: Calls; sources: Map<string, SourceRecord>; reviews: Map<string, ReviewRecord> };

const NOW = new Date("2026-09-19T04:15:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let sequence = 0;

function source(overrides: Partial<SourceRecord> & { propertyId: string; provider: string }): SourceRecord {
  sequence += 1;
  return { id: overrides.id ?? `src-${sequence}`, configJson: {}, createdAt: new Date(NOW.getTime() - 1_000_000 + sequence), ...overrides };
}

function review(overrides: Partial<ReviewRecord> & { id: string; propertyId: string; source: string }): ReviewRecord {
  sequence += 1;
  return {
    rating: 4.5,
    title: "Título de prueba",
    body: "Texto de prueba de la reseña ficticia.",
    responseBody: null,
    receivedAt: daysAgo(5),
    respondedAt: null,
    topicsJson: { v: 1, score10: 9, contentHash: `hash-${overrides.id}`, status: "new", categories: [] },
    createdAt: new Date(NOW.getTime() - 1_000_000 + sequence),
    authorDisplayName: null,
    summary: null,
    bodyPurgedAt: null,
    ...overrides
  };
}

function memoryDb(sources: SourceRecord[], reviews: ReviewRecord[]): MemoryDb {
  const sourceMap = new Map(sources.map((row) => [row.id, row]));
  const reviewMap = new Map(reviews.map((row) => [row.id, row]));
  const calls: Calls = { sourceFindMany: 0, sourceUpdate: [], reviewFindMany: [], reviewUpdate: [], mentionUpdateMany: [] };
  const db: ReputationMaintenanceDb = {
    reviewSource: {
      async findMany() {
        calls.sourceFindMany += 1;
        return [...sourceMap.values()]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => ({ id: row.id, propertyId: row.propertyId, provider: row.provider, configJson: clone(row.configJson) }));
      },
      async update(args) {
        calls.sourceUpdate.push(clone(args));
        const row = sourceMap.get(args.where.id);
        if (!row) throw new Error(`fuente inexistente: ${args.where.id}`);
        row.configJson = clone(args.data.configJson) as JsonRecord;
        return row;
      }
    },
    guestReview: {
      async findMany(args) {
        calls.reviewFindMany.push(clone(args.where) as ReviewWhere);
        return [...reviewMap.values()]
          .filter((row) => row.propertyId === args.where.propertyId)
          .filter((row) => (args.where.receivedAt ? row.receivedAt !== null && row.receivedAt.getTime() < args.where.receivedAt.lt.getTime() : true))
          .filter((row) => ("respondedAt" in args.where ? row.respondedAt === null : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => ({ id: row.id, source: row.source, receivedAt: row.receivedAt, topicsJson: clone(row.topicsJson) }));
      },
      async update(args) {
        calls.reviewUpdate.push(clone(args));
        const row = reviewMap.get(args.where.id);
        if (!row) throw new Error(`reseña inexistente: ${args.where.id}`);
        if ("title" in args.data) row.title = null;
        if ("body" in args.data) row.body = null;
        if ("responseBody" in args.data) row.responseBody = null;
        if ("authorDisplayName" in args.data) row.authorDisplayName = null;
        if ("summary" in args.data) row.summary = null;
        if (args.data.bodyPurgedAt !== undefined) row.bodyPurgedAt = args.data.bodyPurgedAt;
        row.topicsJson = clone(args.data.topicsJson) as JsonRecord;
        return row;
      }
    },
    reviewCategoryMention: {
      async updateMany(args) {
        calls.mentionUpdateMany.push(clone(args));
        return { count: 0 };
      }
    }
  };
  return { db, calls, sources: sourceMap, reviews: reviewMap };
}

describe("[espejo] paridad con apps/api/src/modules/reputation/reputation-types.ts (por texto: el worker no importa el API)", () => {
  const apiTypes = readFileSync(fileURLToPath(new URL("../../../../api/src/modules/reputation/reputation-types.ts", import.meta.url)), "utf8");
  const apiConst = (name: string): string => {
    const match = apiTypes.match(new RegExp(`export const ${name} = ([^;]+);`));
    assert.ok(match, `${name} no está en reputation-types.ts del API`);
    return (match as RegExpMatchArray)[1] as string;
  };
  it("umbrales copiados (retención 730/30, historial 20) siguen siendo los del API", () => {
    assert.equal(apiConst("RETENTION_DAYS_DEFAULT"), String(RETENTION_DAYS_DEFAULT));
    assert.equal(apiConst("RETENTION_DAYS_GOOGLE"), String(RETENTION_DAYS_GOOGLE));
    assert.equal(apiConst("RUN_HISTORY_LIMIT"), String(RUN_HISTORY_LIMIT));
  });
  const apiList = (name: string): string[] => {
    const match = apiConst(name).match(/\[([^\]]*)\]/);
    assert.ok(match, `${name} no es una lista`);
    return (match as RegExpMatchArray)[1]!.split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
  };
  it("vocabularios copiados (estados de bandeja y estados abiertos) siguen siendo los del API", () => {
    assert.deepEqual(apiList("REVIEW_STATUSES"), [...REVIEW_STATUSES]);
    assert.deepEqual(apiList("REVIEW_OPEN_STATUSES"), [...REVIEW_OPEN_STATUSES]);
  });
});

describe("runReputationMaintenance · purga honesta por retención de la fuente", () => {
  it("purga solo lo vencido por fuente (google 30 · csv 730) y conserva rating, score10, categorías y contentHash", async () => {
    const google = source({ id: "src-google", propertyId: "prop-1", provider: "google" });
    const csv = source({ id: "src-csv", propertyId: "prop-1", provider: "csv", configJson: { retentionDays: 730, displayName: "Importación CSV" } });
    const memory = memoryDb(
      [google, csv],
      [
        review({
          id: "g-old",
          propertyId: "prop-1",
          source: "google",
          receivedAt: daysAgo(45),
          responseBody: "Gracias por su visita.",
          respondedAt: daysAgo(44),
          topicsJson: {
            v: 1,
            score10: 9.2,
            contentHash: "hash-g-old",
            status: "responded",
            authorDisplayName: "Huésped F.",
            authorCountry: "ES",
            categories: [{ category: "limpieza", sentiment: 1, confidence: 0.9, snippet: "muy limpio todo", source: "dictionary" }],
            analysis: { status: "done", source: "dictionary", analyzedAt: "2026-08-06T10:00:00.000Z", summary: "Resumen del texto" }
          }
        }),
        review({ id: "g-recent", propertyId: "prop-1", source: "google", receivedAt: daysAgo(10), respondedAt: daysAgo(9), topicsJson: { status: "responded" } }),
        review({ id: "g-purged", propertyId: "prop-1", source: "google", receivedAt: daysAgo(100), respondedAt: daysAgo(99), title: null, body: null, topicsJson: { status: "responded", bodyPurgedAt: "2026-07-01T04:15:00.000Z" } }),
        review({ id: "g-nodate", propertyId: "prop-1", source: "google", receivedAt: null, respondedAt: daysAgo(1), topicsJson: { status: "responded" } }),
        review({ id: "g-by-sourceid", propertyId: "prop-1", source: "google", receivedAt: daysAgo(45), respondedAt: daysAgo(44), topicsJson: { status: "responded", sourceId: "src-csv" } }),
        review({ id: "c-old45", propertyId: "prop-1", source: "csv", receivedAt: daysAgo(45), respondedAt: daysAgo(44), topicsJson: { status: "responded" } }),
        review({ id: "c-old800", propertyId: "prop-1", source: "csv", receivedAt: daysAgo(800), respondedAt: daysAgo(799), topicsJson: { status: "responded", score10: 4, contentHash: "hash-c" } }),
        review({ id: "d-old", propertyId: "prop-1", source: "google_demo", receivedAt: daysAgo(31), respondedAt: daysAgo(30), topicsJson: { status: "responded" } })
      ]
    );

    const result = await runReputationMaintenance({ db: memory.db, now: NOW });

    assert.deepEqual(result, { properties: 1, purged: 3, overdue: 0, trimmed: 0 });
    assert.deepEqual(memory.calls.reviewUpdate.map((call) => call.where.id).sort(), ["c-old800", "d-old", "g-old"]);
    for (const call of memory.calls.reviewUpdate) {
      assert.equal(call.data.title, null);
      assert.equal(call.data.body, null);
      assert.equal(call.data.responseBody, null);
      assert.equal("rating" in call.data, false, "la nota nunca se toca");
      assert.equal((call.data.topicsJson as JsonRecord).bodyPurgedAt, NOW.toISOString());
    }

    const purged = memory.reviews.get("g-old");
    assert.ok(purged);
    assert.equal(purged.title, null);
    assert.equal(purged.body, null);
    assert.equal(purged.responseBody, null);
    assert.equal(purged.authorDisplayName, null, "la columna author_display_name también se vacía");
    assert.equal(purged.summary, null, "la columna summary también se vacía");
    assert.equal(purged.bodyPurgedAt?.toISOString(), NOW.toISOString(), "body_purged_at en columna: purgeExpiredBodies del API no reescribe la fila");
    assert.equal(purged.rating, 4.5);
    assert.equal(purged.topicsJson.score10, 9.2);
    assert.equal(purged.topicsJson.contentHash, "hash-g-old");
    assert.equal(purged.topicsJson.status, "responded");
    assert.equal("authorDisplayName" in purged.topicsJson, false, "la purga retira el nombre del autor (paridad con el API)");
    assert.equal(purged.topicsJson.authorCountry, "ES", "el país se conserva (no identifica a nadie)");
    assert.deepEqual(purged.topicsJson.categories, [{ category: "limpieza", sentiment: 1, confidence: 0.9, source: "dictionary" }], "categoría conservada sin el fragmento literal");
    assert.deepEqual(purged.topicsJson.analysis, { status: "done", source: "dictionary", analyzedAt: "2026-08-06T10:00:00.000Z" }, "análisis conservado sin el resumen");

    assert.deepEqual(
      memory.calls.mentionUpdateMany.map((call) => call.where.reviewId).sort(),
      ["c-old800", "d-old", "g-old"],
      "cada reseña purgada deja snippet = null en review_category_mentions"
    );
    for (const call of memory.calls.mentionUpdateMany) assert.deepEqual(call.data, { snippet: null });
    for (const id of ["g-recent", "g-purged", "g-nodate", "g-by-sourceid", "c-old45"]) {
      const untouched = memory.reviews.get(id);
      assert.ok(untouched);
      assert.equal(memory.calls.reviewUpdate.some((call) => call.where.id === id), false, `${id} no se escribe`);
    }
    assert.equal(memory.reviews.get("g-purged")?.topicsJson.bodyPurgedAt, "2026-07-01T04:15:00.000Z", "una purga previa no se reescribe");

    // La consulta de candidatas se acota con la retención mínima de la propiedad (30 días por Google).
    const purgeQuery = memory.calls.reviewFindMany.find((where) => where.receivedAt !== undefined);
    assert.ok(purgeQuery);
    assert.equal(purgeQuery.propertyId, "prop-1");
    assert.equal(new Date(purgeQuery.receivedAt!.lt).toISOString(), daysAgo(30).toISOString());
  });

  it("una retención configurada más corta acota la consulta y purga antes; Google nunca supera 30 días", async () => {
    const memory = memoryDb(
      [
        source({ id: "src-booking", propertyId: "prop-2", provider: "booking", configJson: { retentionDays: 7 } }),
        source({ id: "src-google", propertyId: "prop-2", provider: "google", configJson: { retentionDays: 365 } })
      ],
      [
        review({ id: "b-8d", propertyId: "prop-2", source: "booking", receivedAt: daysAgo(8), respondedAt: daysAgo(7), topicsJson: { status: "responded" } }),
        review({ id: "b-6d", propertyId: "prop-2", source: "booking", receivedAt: daysAgo(6), respondedAt: daysAgo(5), topicsJson: { status: "responded" } }),
        review({ id: "g-31d", propertyId: "prop-2", source: "google", receivedAt: daysAgo(31), respondedAt: daysAgo(30), topicsJson: { status: "responded" } })
      ]
    );

    const result = await runReputationMaintenance({ db: memory.db, now: NOW });

    assert.deepEqual(result, { properties: 1, purged: 2, overdue: 0, trimmed: 0 });
    assert.deepEqual(memory.calls.reviewUpdate.map((call) => call.where.id).sort(), ["b-8d", "g-31d"]);
    const purgeQuery = memory.calls.reviewFindMany.find((where) => where.receivedAt !== undefined);
    assert.equal(new Date(purgeQuery!.receivedAt!.lt).toISOString(), daysAgo(7).toISOString());
  });
});

describe("runReputationMaintenance · plazo de respuesta", () => {
  it("marca overdue una sola vez: solo abiertas con slaTargetAt vencido y sin marcar", async () => {
    const memory = memoryDb(
      [source({ id: "src-google", propertyId: "prop-1", provider: "google" })],
      [
        review({ id: "o-new", propertyId: "prop-1", source: "google", topicsJson: { status: "new", slaTargetAt: hoursAgo(1).toISOString(), score10: 3 } }),
        review({ id: "o-assigned-future", propertyId: "prop-1", source: "google", topicsJson: { status: "assigned", slaTargetAt: new Date(NOW.getTime() + 3_600_000).toISOString() } }),
        review({ id: "o-already", propertyId: "prop-1", source: "google", topicsJson: { status: "drafted", slaTargetAt: hoursAgo(5).toISOString(), overdue: true } }),
        review({ id: "o-responded", propertyId: "prop-1", source: "google", respondedAt: hoursAgo(2), topicsJson: { status: "responded", slaTargetAt: hoursAgo(5).toISOString() } }),
        review({ id: "o-closed", propertyId: "prop-1", source: "google", topicsJson: { status: "closed", slaTargetAt: hoursAgo(5).toISOString() } }),
        review({ id: "o-no-sla", propertyId: "prop-1", source: "google", topicsJson: { status: "new" } }),
        review({ id: "o-legacy", propertyId: "prop-1", source: "google", topicsJson: {} })
      ]
    );

    const first = await runReputationMaintenance({ db: memory.db, now: NOW });
    assert.deepEqual(first, { properties: 1, purged: 0, overdue: 1, trimmed: 0 });
    assert.equal(memory.calls.reviewUpdate.length, 1);
    const [call] = memory.calls.reviewUpdate;
    assert.equal(call.where.id, "o-new");
    assert.equal("title" in call.data, false, "sin purga no se tocan los textos");
    assert.equal("body" in call.data, false);
    assert.equal("responseBody" in call.data, false);
    assert.deepEqual(call.data.topicsJson, { status: "new", slaTargetAt: hoursAgo(1).toISOString(), score10: 3, overdue: true });
    assert.equal(memory.reviews.get("o-new")?.title, "Título de prueba");

    const second = await runReputationMaintenance({ db: memory.db, now: NOW });
    assert.deepEqual(second, { properties: 1, purged: 0, overdue: 0, trimmed: 0 });
    assert.equal(memory.calls.reviewUpdate.length, 1, "idempotente: el segundo barrido no escribe nada");
  });

  it("una reseña vencida y fuera de plazo recibe un único update con ambos cambios", async () => {
    const memory = memoryDb(
      [source({ id: "src-google", propertyId: "prop-1", provider: "google" })],
      [review({ id: "both", propertyId: "prop-1", source: "google", receivedAt: daysAgo(45), topicsJson: { status: "new", slaTargetAt: daysAgo(44).toISOString(), score10: 2 } })]
    );

    const result = await runReputationMaintenance({ db: memory.db, now: NOW });

    assert.deepEqual(result, { properties: 1, purged: 1, overdue: 1, trimmed: 0 });
    assert.equal(memory.calls.reviewUpdate.length, 1);
    const [call] = memory.calls.reviewUpdate;
    assert.equal(call.data.title, null);
    const meta = call.data.topicsJson as JsonRecord;
    assert.equal(meta.overdue, true);
    assert.equal(meta.bodyPurgedAt, NOW.toISOString());
    assert.equal(meta.score10, 2);
    assert.equal(meta.status, "new");
  });
});

describe("runReputationMaintenance · historial de ejecuciones y ámbito", () => {
  it("recorta configJson.runs a 20 conservando las más recientes y el resto de claves", async () => {
    const runs = Array.from({ length: 25 }, (_, index) => ({
      id: `run-${index + 1}`,
      trigger: "scheduler",
      status: "completed",
      startedAt: new Date(NOW.getTime() - (25 - index) * DAY_MS).toISOString(),
      finishedAt: new Date(NOW.getTime() - (25 - index) * DAY_MS + 60_000).toISOString(),
      fetched: index,
      created: 0,
      updated: 0,
      unchanged: index,
      purged: 0,
      correlationId: `job-${index + 1}`
    }));
    // Desordenado a propósito: el recorte ordena por startedAt descendente.
    const shuffled = [...runs.slice(10), ...runs.slice(0, 10)];
    const memory = memoryDb(
      [
        source({ id: "src-many", propertyId: "prop-1", provider: "csv", configJson: { v: 1, displayName: "CSV", retentionDays: 730, runs: shuffled } }),
        source({ id: "src-exact", propertyId: "prop-1", provider: "google", configJson: { runs: runs.slice(0, 20) } }),
        source({ id: "src-none", propertyId: "prop-1", provider: "booking", configJson: { displayName: "Booking" } })
      ],
      []
    );

    const result = await runReputationMaintenance({ db: memory.db, now: NOW });

    assert.deepEqual(result, { properties: 1, purged: 0, overdue: 0, trimmed: 1 });
    assert.equal(memory.calls.sourceUpdate.length, 1);
    const [call] = memory.calls.sourceUpdate;
    assert.equal(call.where.id, "src-many");
    const config = call.data.configJson as JsonRecord;
    assert.equal(config.displayName, "CSV");
    assert.equal(config.retentionDays, 730);
    assert.equal(config.v, 1);
    const kept = config.runs as Array<{ id: string }>;
    assert.equal(kept.length, RUN_HISTORY_LIMIT);
    assert.deepEqual(
      kept.map((run) => run.id),
      Array.from({ length: 20 }, (_, index) => `run-${25 - index}`)
    );
    assert.equal((memory.sources.get("src-exact")?.configJson.runs as unknown[]).length, 20);
  });

  it("solo consulta reseñas de propiedades con fuentes y cuenta cada propiedad una vez", async () => {
    const memory = memoryDb(
      [
        source({ id: "src-a1", propertyId: "prop-a", provider: "google" }),
        source({ id: "src-a2", propertyId: "prop-a", provider: "csv" }),
        source({ id: "src-c", propertyId: "prop-c", provider: "booking" })
      ],
      [
        review({ id: "b-old", propertyId: "prop-b", source: "google", receivedAt: daysAgo(400), topicsJson: { status: "new", slaTargetAt: daysAgo(399).toISOString() } }),
        review({ id: "a-old", propertyId: "prop-a", source: "google", receivedAt: daysAgo(40), respondedAt: daysAgo(39), topicsJson: { status: "responded" } })
      ]
    );

    const result = await runReputationMaintenance({ db: memory.db, now: NOW });

    assert.deepEqual(result, { properties: 2, purged: 1, overdue: 0, trimmed: 0 });
    assert.equal(memory.calls.sourceFindMany, 1, "una sola lectura de fuentes");
    assert.deepEqual([...new Set(memory.calls.reviewFindMany.map((where) => where.propertyId))].sort(), ["prop-a", "prop-c"]);
    assert.equal(memory.reviews.get("b-old")?.body, "Texto de prueba de la reseña ficticia.", "sin fuente registrada no se toca");
  });

  it("sin fuentes registradas devuelve ceros y no consulta reseñas", async () => {
    const memory = memoryDb([], [review({ id: "x", propertyId: "prop-1", source: "google", receivedAt: daysAgo(400) })]);
    assert.deepEqual(await runReputationMaintenance({ db: memory.db, now: NOW }), { properties: 0, purged: 0, overdue: 0, trimmed: 0 });
    assert.equal(memory.calls.reviewFindMany.length, 0);
    assert.equal(memory.calls.reviewUpdate.length, 0);
  });
});

describe("lectores mínimos (espejo de reputation-types.ts)", () => {
  it("sourceRetentionDays: Google tope 30, resto configJson.retentionDays o 730, valores inválidos al defecto", () => {
    assert.equal(sourceRetentionDays("google", {}), RETENTION_DAYS_GOOGLE);
    assert.equal(sourceRetentionDays("google", { retentionDays: 365 }), 30);
    assert.equal(sourceRetentionDays("google", { retentionDays: 7 }), 7);
    assert.equal(sourceRetentionDays("google_demo", null), 30);
    assert.equal(sourceRetentionDays("csv", {}), RETENTION_DAYS_DEFAULT);
    assert.equal(sourceRetentionDays("csv", { retentionDays: "90" }), 90);
    assert.equal(sourceRetentionDays("csv", { retentionDays: 45.9 }), 45);
    assert.equal(sourceRetentionDays("booking", { retentionDays: 0 }), 730);
    assert.equal(sourceRetentionDays("booking", { retentionDays: "abc" }), 730);
    assert.equal(sourceRetentionDays("tripadvisor", "basura"), 730);
  });

  it("trimRunHistory: null si no hay que recortar; nunca lanza con JSON raro", () => {
    assert.equal(trimRunHistory(null), null);
    assert.equal(trimRunHistory("texto"), null);
    assert.equal(trimRunHistory({ runs: "no-es-lista" }), null);
    assert.equal(trimRunHistory({ runs: Array.from({ length: 20 }, (_, index) => ({ id: `r${index}` })) }), null);
    const trimmed = trimRunHistory({ keep: true, runs: Array.from({ length: 21 }, (_, index) => ({ id: `r${index}` })) }) as JsonRecord;
    assert.equal(trimmed.keep, true);
    assert.equal((trimmed.runs as unknown[]).length, 20);
  });
});

type FakeBoss = {
  createQueue: string[];
  work: Array<{ name: string; options: unknown }>;
  schedule: Array<{ name: string; cron: string; data: unknown; options: unknown }>;
  handler: ((jobs: Array<{ id: string; name: string; data: object; expireInSeconds: number }>) => Promise<void>) | null;
};

function fakeBoss(): { boss: Parameters<typeof registerReputationMaintenanceQueue>[0]; seen: FakeBoss } {
  const seen: FakeBoss = { createQueue: [], work: [], schedule: [], handler: null };
  const boss = {
    async createQueue(name: string) {
      seen.createQueue.push(name);
    },
    async work(name: string, options: unknown, handler: FakeBoss["handler"]) {
      seen.work.push({ name, options });
      seen.handler = handler;
      return "worker-id";
    },
    async schedule(name: string, cron: string, data: unknown, options: unknown) {
      seen.schedule.push({ name, cron, data, options });
    }
  };
  return { boss: boss as unknown as Parameters<typeof registerReputationMaintenanceQueue>[0], seen };
}

type RunRow = { id: string; status: string; jobName: string; queueName: string; correlationId: string | null; organizationId: string | null; propertyId: string | null; payloadJson: unknown; resultJson: unknown; lastError: string | null };

function spyWorkerJobRun(): { rows: Map<string, RunRow>; restore: () => void } {
  const runs = prisma.workerJobRun as unknown as Record<string, (args: never) => Promise<unknown>>;
  const original = { create: runs.create, update: runs.update };
  const rows = new Map<string, RunRow>();
  runs.create = (async (args: { data: Partial<RunRow>; select?: Record<string, boolean> }) => {
    const row: RunRow = {
      id: `run-${rows.size + 1}`,
      status: "queued",
      jobName: "",
      queueName: "",
      correlationId: null,
      organizationId: null,
      propertyId: null,
      payloadJson: null,
      resultJson: null,
      lastError: null,
      ...args.data
    };
    rows.set(row.id, row);
    return args.select ? { id: row.id } : row;
  }) as never;
  runs.update = (async (args: { where: { id: string }; data: Partial<RunRow> }) => {
    const row = rows.get(args.where.id);
    if (!row) throw new Error(`run inexistente: ${args.where.id}`);
    Object.assign(row, args.data);
    return row;
  }) as never;
  return {
    rows,
    restore: () => {
      runs.create = original.create;
      runs.update = original.update;
    }
  };
}

describe("registerReputationMaintenanceQueue", () => {
  it("registra createQueue, boss.work (batchSize 1) y boss.schedule con la cron diaria en Europe/Madrid", async () => {
    const { boss, seen } = fakeBoss();
    await registerReputationMaintenanceQueue(boss, { db: memoryDb([], []).db });

    assert.equal(REPUTATION_MAINTENANCE_QUEUE, "reputation.maintenance");
    assert.equal(REPUTATION_MAINTENANCE_CRON, "15 4 * * *");
    assert.deepEqual(seen.createQueue, ["reputation.maintenance"]);
    assert.deepEqual(seen.work, [{ name: "reputation.maintenance", options: { batchSize: 1 } }]);
    assert.deepEqual(seen.schedule, [{ name: "reputation.maintenance", cron: "15 4 * * *", data: {}, options: { tz: "Europe/Madrid" } }]);
    assert.equal(typeof seen.handler, "function");

    const custom = fakeBoss();
    await registerReputationMaintenanceQueue(custom.boss, { cron: "0 5 * * *", db: memoryDb([], []).db });
    assert.equal(custom.seen.schedule[0]?.cron, "0 5 * * *");
  });

  it("el tick pasa por withJobRun: un WorkerJobRun running → completed con las cifras del barrido", async () => {
    const memory = memoryDb(
      [source({ id: "src-google", propertyId: "prop-1", provider: "google" })],
      [review({ id: "g-old", propertyId: "prop-1", source: "google", receivedAt: daysAgo(45), respondedAt: daysAgo(44), topicsJson: { status: "responded" } })]
    );
    const { boss, seen } = fakeBoss();
    await registerReputationMaintenanceQueue(boss, { db: memory.db });
    assert.ok(seen.handler);

    const spy = spyWorkerJobRun();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await seen.handler([{ id: "job-77", name: "reputation.maintenance", data: { trigger: "test" }, expireInSeconds: 900 }]);
    } finally {
      console.log = originalLog;
      spy.restore();
    }

    assert.equal(spy.rows.size, 1);
    const [run] = [...spy.rows.values()];
    assert.equal(run.jobName, "reputation.maintenance");
    assert.equal(run.queueName, "reputation.maintenance");
    assert.equal(run.correlationId, "job-77");
    assert.deepEqual(run.payloadJson, { trigger: "test" });
    assert.equal(run.organizationId, null, "barrido global: organizationId null");
    assert.equal(run.propertyId, null, "barrido global: propertyId null");
    assert.equal(run.status, "completed");
    assert.deepEqual(run.resultJson, { properties: 1, purged: 1, overdue: 0, trimmed: 0 });
    assert.equal(run.lastError, null);
    assert.equal(memory.reviews.get("g-old")?.body, null);
    assert.deepEqual(logs, ["[reputation.maintenance] properties=1 purged=1 overdue=0 trimmed=0"]);
  });

  it("si el barrido falla, el run queda failed con lastError y el error se relanza para pg-boss", async () => {
    const broken = memoryDb([], []);
    broken.db.reviewSource.findMany = async () => {
      throw new Error("conexión perdida con la base de datos");
    };
    const { boss, seen } = fakeBoss();
    await registerReputationMaintenanceQueue(boss, { db: broken.db });
    assert.ok(seen.handler);

    const spy = spyWorkerJobRun();
    const originalError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await assert.rejects(seen.handler([{ id: "job-78", name: "reputation.maintenance", data: {}, expireInSeconds: 900 }]), /conexión perdida/);
    } finally {
      console.error = originalError;
      spy.restore();
    }

    const [run] = [...spy.rows.values()];
    assert.equal(run.status, "failed");
    assert.equal(run.lastError, "Error: conexión perdida con la base de datos");
    assert.equal(run.correlationId, "job-78");
    assert.equal(errors.length, 1);
  });
});
