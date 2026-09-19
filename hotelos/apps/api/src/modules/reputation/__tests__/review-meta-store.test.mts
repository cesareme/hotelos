// Unit tests · Tanda T8 · lote T8-C — persistencia sobre las tablas existentes
// (review-meta.store.ts): upsert idempotente (crea / actualiza / unchanged),
// patchReviewMeta, ring buffer de ejecuciones (≤ 20) y purga por retención de
// cada fuente. T8-L0b fase 1: doble escritura en columnas (score10, status,
// contentHash…), fila en review_source_runs y carrera del create cerrada por
// P2002. Stub de prisma en memoria: sin base de datos, sin red. Datos
// ficticios. Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/review-meta-store.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedReview } from "../collectors/types.js";
import { RUN_HISTORY_LIMIT, readReviewMeta, readSourceConfig, type ReviewSourceRunSummary } from "../reputation-types.js";
import {
  decimalToNumber,
  getReviewMeta,
  listSourceConfigs,
  patchReviewMeta,
  purgeExpiredBodies,
  saveSourceRun,
  scoreOfRow,
  upsertReviewFromNormalized,
  type ReputationDb
} from "../review-meta.store.js";

const NOW = new Date("2026-09-19T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

// ---------------------------------------------------------------------------
// Stub mínimo de prisma (findFirst / findMany / create / update) en memoria
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
    if ("gt" in c && !(value !== null && value !== undefined && compare(value, c.gt) > 0)) return false;
    if ("lte" in c && !(value !== null && value !== undefined && compare(value, c.lte) <= 0)) return false;
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

export type StubDb = { db: ReputationDb; tables: Tables; calls: string[] };

function createStubDb(seed: Partial<Tables> = {}): StubDb {
  const tables: Tables = { guestReview: [], reviewSource: [], reviewSourceRun: [], reviewCategoryMention: [], qualityCase: [], module: [], propertyModule: [], inboundEmail: [], property: [], ...structuredClone(seed) };
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
    // T8-L0b fase 1: el store inserta la ejecución con `db.reviewSourceRun?.create`.
    reviewSourceRun: delegate("reviewSourceRun"),
    // La purga deja `snippet` a null en las menciones materializadas (`db.reviewCategoryMention?.updateMany`).
    reviewCategoryMention: {
      updateMany: async (args: { where: Row; data: Row }) => {
        calls.push("reviewCategoryMention.updateMany");
        const rows = tables.reviewCategoryMention!.filter((row) => matches(row, args.where));
        for (const row of rows) Object.assign(row, structuredClone(args.data));
        return { count: rows.length };
      }
    },
    qualityCase: delegate("qualityCase"),
    module: delegate("module"),
    propertyModule: delegate("propertyModule"),
    inboundEmail: delegate("inboundEmail"),
    property: delegate("property"),
    $queryRaw: async () => [{ daily: null, runs: null, mentions: null }]
  } as unknown as ReputationDb;
  return { db, tables, calls };
}

function fixture(overrides: Partial<NormalizedReview> = {}): NormalizedReview {
  return {
    externalId: "rev-ficticia-001",
    receivedAt: "2026-09-15T10:00:00Z",
    ratingRaw: 1.5,
    ratingScaleMax: 5,
    title: "Decepcionante",
    body: "La habitación estaba sucia y el personal no ayudó con el problema.",
    bodyComplete: true,
    language: "es",
    authorDisplayName: "Huésped Ficticio Uno",
    replyCapability: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------

describe("upsertReviewFromNormalized", () => {
  it("crea la fila con rating sobre 5, sentimiento, referencia, hash y meta v1 (status new, SLA 48 h por negativa)", async () => {
    const { db, tables } = createStubDb();
    const out = await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "google", sourceId: "src_g", sourceMode: "api", item: fixture(), now: NOW });
    assert.equal(out.outcome, "created");
    assert.equal(out.externalReference, "rev-ficticia-001");
    assert.match(out.contentHash, /^[0-9a-f]{40}$/);
    assert.equal(out.score10, 3);
    assert.equal(tables.guestReview!.length, 1);
    const row = tables.guestReview![0]!;
    assert.equal(row.propertyId, "prop_a");
    assert.equal(row.source, "google");
    assert.equal(row.rating, 1.5);
    assert.equal(row.sentiment, "negative");
    assert.equal(row.language, "es");
    assert.equal(row.responseBody, null);
    assert.equal(row.respondedAt, null);
    const meta = readReviewMeta(row.topicsJson);
    assert.equal(meta.status, "new");
    assert.equal(meta.score10, 3);
    assert.equal(meta.ratingRaw, 1.5);
    assert.equal(meta.ratingScaleMax, 5);
    assert.equal(meta.sourceId, "src_g");
    assert.equal(meta.sourceMode, "api");
    assert.equal(meta.authorDisplayName, "Huésped F.");
    assert.equal(meta.slaTargetAt, "2026-09-17T10:00:00.000Z");
    assert.equal(meta.analysis.status, "pending");
    assert.equal(meta.contentHash, out.contentHash);
    assert.equal(scoreOfRow(row as never), 3);
    // T8-L0b fase 1: las columnas nuevas reflejan la meta.
    assert.equal(row.score10, 3);
    assert.equal(row.ratingScaleMax, 5);
    assert.equal(row.sourceId, "src_g");
    assert.equal(row.sourceMode, "api");
    assert.equal(row.authorDisplayName, "Huésped F.");
    assert.equal(row.contentHash, out.contentHash);
    assert.equal(row.status, "new");
    assert.equal(toTime(row.slaTargetAt), Date.parse("2026-09-17T10:00:00.000Z"));
    assert.equal(row.replyCapability, false);
    assert.equal(row.analysisStatus, "pending");
    assert.equal(row.analysisSource, "none");
    assert.equal(row.responseSource, null);
    assert.equal(row.externalReference, "rev-ficticia-001");
  });

  it("la misma reseña otra vez → unchanged sin escribir; con el cuerpo cambiado → updated y análisis pendiente", async () => {
    const { db, tables, calls } = createStubDb();
    await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "google", sourceMode: "api", item: fixture(), now: NOW });
    const again = await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "google", sourceMode: "api", item: fixture(), now: NOW });
    assert.equal(again.outcome, "unchanged");
    assert.equal(tables.guestReview!.length, 1);
    assert.equal(calls.filter((call) => call === "guestReview.update").length, 0);

    const edited = await upsertReviewFromNormalized({
      db,
      propertyId: "prop_a",
      source: "google",
      sourceMode: "api",
      item: fixture({ body: "La habitación estaba sucia, aunque al final lo arreglaron.", ratingRaw: 3 }),
      now: NOW
    });
    assert.equal(edited.outcome, "updated");
    assert.equal(tables.guestReview!.length, 1);
    const row = tables.guestReview![0]!;
    assert.equal(row.body, "La habitación estaba sucia, aunque al final lo arreglaron.");
    assert.equal(row.rating, 3);
    assert.equal(row.sentiment, "neutral");
    const meta = readReviewMeta(row.topicsJson);
    assert.equal(meta.contentHash, edited.contentHash);
    assert.notEqual(meta.contentHash, again.contentHash);
    assert.equal(meta.analysis.status, "pending");
    assert.equal(meta.analysis.note, "content_changed");
    assert.equal(meta.score10, 6);
    assert.equal(row.score10, 6);
    assert.equal(row.contentHash, edited.contentHash);
    assert.equal(row.analysisStatus, "pending");
  });

  it("si el create lanza P2002 (otro escritor creó la referencia entre findFirst y create) relee la fila y sigue por update sin lanzar", async () => {
    const { db, tables, calls } = createStubDb();
    const original = db.guestReview.create.bind(db.guestReview);
    let raced = false;
    // Primer create: simula al escritor concurrente (misma referencia, contenido anterior) y falla con P2002.
    (db.guestReview as unknown as { create: typeof original }).create = async (args) => {
      if (!raced) {
        raced = true;
        await original({ data: { ...args.data, body: "Contenido anterior escrito por el otro proceso.", topicsJson: { v: 1, contentHash: "otro-hash", status: "new", analysis: { status: "done", source: "dictionary" }, categories: [] } } });
        throw Object.assign(new Error("Unique constraint failed on the fields: (`property_id`,`source`,`external_reference`)"), { code: "P2002" });
      }
      return original(args);
    };
    const out = await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "google", sourceMode: "api", item: fixture(), now: NOW });
    assert.equal(out.outcome, "updated");
    assert.equal(tables.guestReview!.length, 1);
    const row = tables.guestReview![0]!;
    assert.equal(row.id, out.id);
    assert.equal(row.body, fixture().body);
    assert.equal(readReviewMeta(row.topicsJson).contentHash, out.contentHash);
    assert.equal(row.contentHash, out.contentHash);
    assert.deepEqual(calls.filter((call) => call.startsWith("guestReview.")), ["guestReview.findFirst", "guestReview.create", "guestReview.findFirst", "guestReview.update"]);
    // Cualquier otro error del create se propaga tal cual.
    (db.guestReview as unknown as { create: typeof original }).create = async () => {
      throw Object.assign(new Error("conexión perdida"), { code: "P1001" });
    };
    await assert.rejects(upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "google", sourceMode: "api", item: fixture({ externalId: "rev-ficticia-009" }), now: NOW }), /conexión perdida/);
  });

  it("sin id del portal la referencia es h:<hash>; una respuesta ya publicada en el portal llega como responded", async () => {
    const { db, tables } = createStubDb();
    const out = await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "csv", sourceMode: "csv", item: fixture({ externalId: undefined }), now: NOW });
    assert.match(out.externalReference, /^h:[0-9a-f]{40}$/);

    const replied = await upsertReviewFromNormalized({
      db,
      propertyId: "prop_a",
      source: "google",
      sourceMode: "api",
      item: fixture({ externalId: "rev-ficticia-002", ratingRaw: 5, portalReply: { body: "Gracias por su visita.", repliedAt: "2026-09-16T09:00:00Z" } }),
      now: NOW
    });
    assert.equal(replied.meta.status, "responded");
    assert.deepEqual(replied.meta.response, { source: "api" });
    const row = tables.guestReview!.find((entry) => entry.externalReference === "rev-ficticia-002")!;
    assert.equal(row.responseBody, "Gracias por su visita.");
    assert.equal(toTime(row.respondedAt), Date.parse("2026-09-16T09:00:00Z"));
    assert.equal(row.status, "responded");
    assert.equal(row.responseSource, "api");
  });

  it("una referencia forzada (email:<messageId>) manda sobre la derivada", async () => {
    const { db } = createStubDb();
    const out = await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "tripadvisor", sourceMode: "email", item: fixture(), now: NOW, externalReference: "email:msg-1" });
    assert.equal(out.externalReference, "email:msg-1");
  });
});

describe("patchReviewMeta y lectores", () => {
  it("fusiona el parche sobre la meta actual y escribe columnas opcionales; undefined retira una clave", async () => {
    const { db, tables } = createStubDb();
    const created = await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "google", sourceMode: "api", item: fixture(), now: NOW });
    const patched = await patchReviewMeta({ db, id: created.id, patch: { status: "assigned", assignedUserId: "usr_1" }, columns: { sentiment: "neutral" } });
    assert.equal(patched.meta.status, "assigned");
    assert.equal(patched.meta.assignedUserId, "usr_1");
    assert.equal(patched.meta.contentHash, created.contentHash);
    assert.equal(tables.guestReview![0]!.sentiment, "neutral");
    // T8-L0b fase 1: las columnas equivalentes a las claves del parche acompañan a topicsJson.
    assert.equal(tables.guestReview![0]!.status, "assigned");
    assert.equal(tables.guestReview![0]!.assignedUserId, "usr_1");
    const cleared = await patchReviewMeta({ db, id: created.id, patch: (current) => ({ status: current.status, assignedUserId: undefined }) });
    assert.equal(cleared.meta.assignedUserId, undefined);
    assert.equal(cleared.meta.status, "assigned");
    assert.equal(tables.guestReview![0]!.assignedUserId, null);
    await assert.rejects(patchReviewMeta({ db, id: "no-existe", patch: {} }), /no encontrada/);
  });

  it("borrador, análisis, respuesta y purga del parche se materializan en columnas; una clave ausente no toca su columna", async () => {
    const { db, tables } = createStubDb();
    const created = await upsertReviewFromNormalized({ db, propertyId: "prop_a", source: "google", sourceMode: "api", item: fixture(), now: NOW });
    await patchReviewMeta({
      db,
      id: created.id,
      patch: {
        status: "drafted",
        draft: { body: "Gracias por su opinión.", source: "rules", draftedAt: NOW },
        categories: [{ category: "limpieza", sentiment: -1, confidence: 0.9, snippet: "estaba sucia", source: "dictionary" }],
        analysis: { status: "done", source: "dictionary", analyzedAt: NOW, summary: "Negativo: limpieza" }
      }
    });
    const row = () => tables.guestReview![0]!;
    assert.equal(row().status, "drafted");
    assert.equal(row().draftBody, "Gracias por su opinión.");
    assert.equal(row().draftSource, "rules");
    assert.equal(row().draftModel, null);
    assert.equal(toTime(row().draftedAt), NOW.getTime());
    assert.equal(row().analysisStatus, "done");
    assert.equal(row().analysisSource, "dictionary");
    assert.equal(toTime(row().analyzedAt), NOW.getTime());
    assert.equal(row().summary, "Negativo: limpieza");
    assert.equal(row().responseSource, null, "sin `response` en el parche la columna no se toca");
    await patchReviewMeta({ db, id: created.id, patch: { status: "responded", draft: null, response: { source: "manual" } }, columns: { respondedAt: NOW, responseBody: "Publicada." } });
    assert.equal(row().status, "responded");
    assert.equal(row().draftBody, null);
    assert.equal(row().draftedAt, null);
    assert.equal(row().responseSource, "manual");
    assert.equal(row().responseExternalState, null);
    assert.equal(row().summary, "Negativo: limpieza", "el análisis no venía en el parche: su columna se conserva");
    await patchReviewMeta({ db, id: created.id, patch: { bodyPurgedAt: NOW } });
    assert.equal(toTime(row().bodyPurgedAt), NOW.getTime());
  });

  it("getReviewMeta tolera JSON vacío y decimalToNumber acepta número, cadena y Decimal", () => {
    assert.equal(getReviewMeta({ topicsJson: {} } as never).status, "new");
    assert.equal(decimalToNumber(4.5), 4.5);
    assert.equal(decimalToNumber("3.25"), 3.25);
    assert.equal(decimalToNumber({ toNumber: () => 2.5 }), 2.5);
    assert.equal(decimalToNumber(null), null);
    assert.equal(scoreOfRow({ rating: 4.5, topicsJson: {} } as never), 9);
  });
});

describe("saveSourceRun · ring buffer", () => {
  const run = (n: number, status: ReviewSourceRunSummary["status"] = "completed", error?: string): ReviewSourceRunSummary => ({
    id: `run_${n}`,
    trigger: "scheduler",
    status,
    startedAt: new Date(NOW.getTime() + n * 60_000).toISOString(),
    finishedAt: new Date(NOW.getTime() + n * 60_000 + 1_000).toISOString(),
    fetched: n,
    created: 0,
    updated: 0,
    unchanged: 0,
    purged: 0,
    ...(error ? { error } : {}),
    correlationId: `corr_${n}`
  });

  it("conserva como máximo RUN_HISTORY_LIMIT (20) ejecuciones, la más reciente primero, y actualiza lastRunAt/lastSuccessAt", async () => {
    const { db, tables } = createStubDb({ reviewSource: [{ id: "src_1", propertyId: "prop_a", provider: "csv", status: "connected", configJson: {}, createdAt: NOW }] });
    for (let n = 1; n <= 25; n += 1) await saveSourceRun({ db, sourceId: "src_1", run: run(n) });
    const config = readSourceConfig(tables.reviewSource![0]!.configJson, "csv");
    assert.equal(config.runs.length, RUN_HISTORY_LIMIT);
    assert.equal(config.runs[0]!.id, "run_25");
    assert.equal(config.runs[19]!.id, "run_6");
    assert.equal(config.lastRunAt, run(25).finishedAt);
    assert.equal(config.lastSuccessAt, run(25).finishedAt);
    assert.equal(config.lastError, undefined);
    // T8-L0b fase 1: cada ejecución se inserta en review_source_runs (historial completo) y la fuente refleja las columnas.
    assert.equal(tables.reviewSourceRun!.length, 25);
    const last = tables.reviewSourceRun!.find((entry) => entry.id === "run_25")!;
    assert.equal(last.sourceId, "src_1");
    assert.equal(last.propertyId, "prop_a");
    assert.equal(last.provider, "csv");
    assert.equal(last.trigger, "scheduler");
    assert.equal(last.status, "completed");
    assert.equal(last.fetched, 25);
    assert.equal(last.correlationId, "corr_25");
    assert.equal(toTime(last.startedAt), Date.parse(run(25).startedAt));
    const source = tables.reviewSource![0]!;
    assert.equal(toTime(source.lastRunAt), Date.parse(run(25).finishedAt));
    assert.equal(toTime(source.lastSuccessAt), Date.parse(run(25).finishedAt));
    assert.equal(source.lastError, null);
    assert.equal(source.mode, "csv");
    assert.equal(source.retentionDays, 730);
    assert.equal(source.weight, 1);
  });

  it("una ejecución fallida deja la fuente en error con lastError; la siguiente correcta la limpia", async () => {
    const { db, tables } = createStubDb({ reviewSource: [{ id: "src_1", propertyId: "prop_a", provider: "google", status: "connected", configJson: {}, createdAt: NOW }] });
    await saveSourceRun({ db, sourceId: "src_1", run: run(1, "failed", "token caducado") });
    assert.equal(tables.reviewSource![0]!.status, "error");
    assert.equal(readSourceConfig(tables.reviewSource![0]!.configJson, "google").lastError, "token caducado");
    assert.equal(tables.reviewSource![0]!.lastError, "token caducado");
    assert.equal(tables.reviewSourceRun![0]!.lastError, "token caducado");
    assert.equal(tables.reviewSourceRun![0]!.status, "failed");
    await saveSourceRun({ db, sourceId: "src_1", run: run(2), status: "connected", cursor: { pageToken: "abc", accessToken: "nunca" } });
    assert.equal(tables.reviewSource![0]!.status, "connected");
    const config = readSourceConfig(tables.reviewSource![0]!.configJson, "google");
    assert.equal(config.lastError, undefined);
    assert.deepEqual(config.cursor, { pageToken: "abc" });
    assert.equal(tables.reviewSource![0]!.lastError, null);
    assert.deepEqual(tables.reviewSource![0]!.cursorJson, { pageToken: "abc" });
    const skipped = await saveSourceRun({ db, sourceId: "src_1", run: run(3, "skipped", "sin credenciales"), status: "unavailable" });
    assert.equal(skipped.row.status, "unavailable");
    assert.equal(skipped.config.lastError, "sin credenciales");
    const listed = await listSourceConfigs({ db, propertyId: "prop_a" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.status, "unavailable");
  });
});

describe("purgeExpiredBodies · retención por fuente", () => {
  it("Google purga a los 30 días, csv a los 730 por defecto o a los retentionDays de su fuente; conserva nota, categorías, referencia y hash; idempotente", async () => {
    const { db, tables, calls } = createStubDb({
      reviewSource: [
        { id: "src_g", propertyId: "prop_a", provider: "google", status: "connected", configJson: {}, createdAt: NOW },
        { id: "src_c", propertyId: "prop_a", provider: "csv", status: "connected", configJson: {}, createdAt: NOW },
        { id: "src_c10", propertyId: "prop_a", provider: "csv", status: "connected", configJson: { retentionDays: 10 }, createdAt: NOW }
      ]
    });
    const seed = async (externalId: string, source: string, sourceId: string, ageDays: number) =>
      upsertReviewFromNormalized({
        db,
        propertyId: "prop_a",
        source,
        sourceId,
        sourceMode: source === "google" ? "api" : "csv",
        item: fixture({ externalId, receivedAt: daysAgo(ageDays).toISOString(), ratingRaw: 4, authorDisplayName: "Huésped Ficticio Dos" }),
        now: NOW
      });
    const google40 = await seed("g-40", "google", "src_g", 40);
    const csv40 = await seed("c-40", "csv", "src_c", 40);
    const csv800 = await seed("c-800", "csv", "src_c", 800);
    const csv10 = await seed("c10-40", "csv", "src_c10", 40);
    const google5 = await seed("g-5", "google", "src_g", 5);
    await patchReviewMeta({ db, id: google40.id, patch: { categories: [{ category: "limpieza", sentiment: -1, confidence: 0.8, snippet: "estaba sucia", source: "dictionary" }], analysis: { status: "done", source: "dictionary", summary: "Negativo: limpieza" } } });
    // Menciones materializadas (fase 1) con fragmento literal: la purga debe vaciarlo solo en las reseñas purgadas.
    tables.reviewCategoryMention!.push(
      { id: "m_1", reviewId: google40.id, propertyId: "prop_a", category: "limpieza", snippet: "estaba sucia" },
      { id: "m_2", reviewId: google5.id, propertyId: "prop_a", category: "limpieza", snippet: "todo impecable" }
    );

    const first = await purgeExpiredBodies({ db, propertyId: "prop_a", now: NOW });
    assert.equal(first.purged, 3);
    assert.equal(calls.filter((call) => call === "reviewCategoryMention.updateMany").length, 3, "un updateMany por reseña purgada");
    assert.equal(tables.reviewCategoryMention!.find((row) => row.id === "m_1")!.snippet, null, "snippet purgado con el cuerpo");
    assert.equal(tables.reviewCategoryMention!.find((row) => row.id === "m_2")!.snippet, "todo impecable", "reseña vigente: snippet intacto");
    const byId = (id: string) => tables.guestReview!.find((row) => row.id === id)!;
    for (const id of [google40.id, csv800.id, csv10.id]) {
      const row = byId(id);
      assert.equal(row.body, null, id);
      assert.equal(row.title, null, id);
      assert.equal(row.responseBody, null, id);
      const meta = readReviewMeta(row.topicsJson);
      assert.equal(typeof meta.bodyPurgedAt, "string", id);
      assert.equal(meta.authorDisplayName, undefined, id);
      assert.equal(meta.score10, 8, id);
      assert.equal(meta.contentHash.length, 40, id);
      assert.equal(row.externalReference, byId(id).externalReference);
      assert.equal(toTime(row.bodyPurgedAt), NOW.getTime(), id);
      assert.equal(row.authorDisplayName, null, id);
    }
    const purgedMeta = readReviewMeta(byId(google40.id).topicsJson);
    assert.equal(purgedMeta.categories.length, 1);
    assert.equal(purgedMeta.categories[0]!.category, "limpieza");
    assert.equal(purgedMeta.categories[0]!.snippet, undefined);
    assert.equal(purgedMeta.analysis.summary, undefined);
    assert.equal(purgedMeta.analysis.status, "done");
    for (const id of [csv40.id, google5.id]) {
      assert.notEqual(byId(id).body, null, id);
      assert.equal(readReviewMeta(byId(id).topicsJson).bodyPurgedAt, undefined, id);
    }

    const updatesBefore = calls.filter((call) => call === "guestReview.update").length;
    const second = await purgeExpiredBodies({ db, propertyId: "prop_a", now: NOW });
    assert.equal(second.purged, 0);
    assert.equal(calls.filter((call) => call === "guestReview.update").length, updatesBefore);
  });
});
