// Unit tests · Tanda T8 · lote T8-C — borrador con revisión humana
// (review-draft.service.ts): con el respaldo por reglas basta reputation.respond;
// un puerto de IA configurado (ficticio) exige además ai.tool.execute; encola
// review_response con el borrador; NUNCA escribe responseBody ni respondedAt
// (aprobar en HITL no publica); fallback a plantilla si el puerto falla o deja
// marcadores de máscara. Stub de prisma y dependencias espía: sin base de
// datos, sin red, sin proveedor de IA. Datos ficticios. Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/review-draft.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserContext } from "../../../lib/demo-store.js";
import type { ReputationAiPort } from "../reputation-ai.port.js";
import { readReviewMeta } from "../reputation-types.js";
import { REVIEW_DRAFT_REVIEW_TYPE, REVIEW_DRAFT_SUPERSEDED_REASON, REVIEW_DRAFT_TOOL_NAME, assertDraftPublishable, createReviewDraft, readDraftReviewStatus, resolveReviewDraftItem } from "../review-draft.service.js";
import type { ReputationDb } from "../review-meta.store.js";

const NOW = new Date("2026-09-19T12:00:00Z");
type Row = Record<string, unknown>;

function reviewRow(overrides: Row = {}): Row {
  return {
    id: "rev_1",
    propertyId: "prop_a",
    reservationId: null,
    guestId: null,
    source: "google",
    rating: 1.5,
    title: "Muy mal",
    body: "La habitación 432 estaba sucia; escribí a quejas@ejemplo.test y nadie respondió.",
    language: "es",
    sentiment: "negative",
    topicsJson: {
      v: 1,
      score10: 3,
      ratingRaw: 1.5,
      ratingScaleMax: 5,
      contentHash: "abc",
      sourceMode: "api",
      status: "new",
      replyCapability: true,
      categories: [{ category: "limpieza", sentiment: -1, confidence: 0.9, source: "dictionary" }],
      analysis: { status: "done", source: "dictionary" }
    },
    externalReference: "g-1",
    receivedAt: new Date("2026-09-17T10:00:00Z"),
    respondedAt: null,
    responseBody: null,
    createdAt: new Date("2026-09-17T10:05:00Z"),
    ...overrides
  };
}

function stubDb(row: Row) {
  const reviews = [row];
  const updates: Row[] = [];
  const db = {
    guestReview: {
      findFirst: async (args: { where: { id: string; propertyId?: string } }) => {
        const found = reviews.find((entry) => entry.id === args.where.id && (!args.where.propertyId || entry.propertyId === args.where.propertyId));
        return found ? structuredClone(found) : null;
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const found = reviews.find((entry) => entry.id === args.where.id)!;
        updates.push(args.data);
        Object.assign(found, structuredClone(args.data));
        return structuredClone(found);
      }
    },
    property: { findFirst: async () => ({ name: "Hotel Ficticio del Norte" }) }
  } as unknown as ReputationDb;
  return { db, reviews, updates };
}

function spyDeps(items: Record<string, { status: string }> = {}) {
  const enqueued: Row[] = [];
  const toolCalls: Row[] = [];
  const decisions: Row[] = [];
  const audits: Row[] = [];
  return {
    enqueued,
    toolCalls,
    audits,
    deps: {
      enqueue: (async (input: Row) => {
        enqueued.push(input);
        items[`hitl_${enqueued.length}`] = { status: "pending" };
        return { id: `hitl_${enqueued.length}`, organizationId: input.organizationId, reviewType: input.reviewType, payloadJson: input.payloadJson, status: "pending", createdAt: NOW.toISOString(), ageMinutes: 0, slaBreached: false };
      }) as never,
      toolCall: (async (input: Row) => {
        toolCalls.push(input);
        return {} as never;
      }) as never,
      audit: ((input: Row) => {
        audits.push(input);
        return input as never;
      }) as never,
      getItem: (async (id: string) => {
        const item = items[id];
        if (!item) throw new Error(`Review item ${id} not found.`);
        return { id, organizationId: "org_a", reviewType: "review_response", payloadJson: {}, status: item.status, createdAt: NOW.toISOString(), ageMinutes: 0, slaBreached: false };
      }) as never,
      reject: (async (input: Row) => {
        decisions.push({ decision: "rejected", ...input });
        items[input.id as string] = { status: "rejected" };
        return { id: input.id, status: "rejected" };
      }) as never,
      approve: (async (input: Row) => {
        decisions.push({ decision: "approved", ...input });
        items[input.id as string] = { status: "approved" };
        return { id: input.id, status: "approved" };
      }) as never
    },
    decisions
  };
}

function context(permissions: string[]): UserContext {
  return { organizationId: "org_a", propertyId: "prop_a", userId: "usr_gm", fullName: "Directora Ficticia", deviceId: "test", permissions: permissions as never, isPlatformAdmin: false };
}

const fakeAi = (overrides: Partial<ReputationAiPort> = {}): ReputationAiPort => ({
  describe: () => ({ configured: true, provider: "ficticio", model: "modelo-x" }),
  analyzeReview: async () => ({ language: "es", sentiment: "negative", categories: [], source: "llm" }),
  draftResponse: async () => ({ body: "Gracias por su opinión. Lamentamos lo ocurrido y le invitamos a escribirnos.\n\nDirección de Hotel Ficticio del Norte", source: "ai", model: "modelo-x", language: "es" }),
  ...overrides
});

describe("createReviewDraft · respaldo por reglas", () => {
  it("con reputation.respond (sin ai.tool.execute) genera plantilla, la guarda en meta.draft, pasa a drafted y encola review_response", async () => {
    const { db, reviews, updates } = stubDb(reviewRow());
    const spy = spyDeps();
    const out = await createReviewDraft({ db, context: context(["reputation.respond"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_1", now: NOW, deps: spy.deps });
    assert.equal(out.source, "rules");
    assert.equal(out.provider, "none");
    assert.equal(out.requiresHumanReview, true);
    assert.equal(out.reviewItemId, "hitl_1");
    assert.equal(out.language, "es");
    assert.match(out.draft, /Dirección de Hotel Ficticio del Norte/);
    assert.doesNotMatch(out.draft, /432|quejas@ejemplo\.test|\[ROOM_\d\]|\[EMAIL_\d\]/);

    assert.equal(spy.enqueued.length, 1);
    assert.equal(spy.enqueued[0]!.reviewType, REVIEW_DRAFT_REVIEW_TYPE);
    assert.equal(spy.enqueued[0]!.relatedEntityType, "guest_review");
    assert.equal(spy.enqueued[0]!.relatedEntityId, "rev_1");
    assert.equal(spy.enqueued[0]!.organizationId, "org_a");
    assert.equal(spy.enqueued[0]!.actorUserId, "usr_gm");
    assert.equal((spy.enqueued[0]!.payloadJson as Row).source, "rules");
    assert.equal((spy.enqueued[0]!.payloadJson as Row).sourceName, "Google");

    const meta = readReviewMeta(reviews[0]!.topicsJson);
    assert.equal(meta.status, "drafted");
    assert.equal(meta.draft?.source, "rules");
    assert.equal(meta.draft?.reviewItemId, "hitl_1");
    assert.equal(meta.draft?.draftedAt, NOW.toISOString());
    assert.equal(meta.draft?.body, out.draft);

    assert.equal(spy.toolCalls.length, 1);
    assert.equal(spy.toolCalls[0]!.toolName, REVIEW_DRAFT_TOOL_NAME);
    assert.equal(spy.toolCalls[0]!.status, "completed");
    assert.equal(spy.toolCalls[0]!.requiredConfirmation, true);
    assert.equal(spy.toolCalls[0]!.automationLevel, "suggest_and_confirm");
    assert.equal(spy.audits.length, 1);
    assert.equal(spy.audits[0]!.action, "ReviewResponseDrafted");
    assert.equal(spy.audits[0]!.actorType, "user");

    // Aprobar en HITL nunca publica: este servicio no toca responseBody ni respondedAt.
    for (const data of updates) {
      assert.equal("responseBody" in data, false);
      assert.equal("respondedAt" in data, false);
    }
    assert.equal(reviews[0]!.responseBody, null);
    assert.equal(reviews[0]!.respondedAt, null);
  });

  it("sin reputation.respond → PermissionDeniedError sin encolar nada", async () => {
    const { db } = stubDb(reviewRow());
    const spy = spyDeps();
    await assert.rejects(createReviewDraft({ db, context: context(["reputation.read"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_1", deps: spy.deps }), (error: Error) => error.name === "PermissionDeniedError");
    assert.equal(spy.enqueued.length, 0);
  });

  it("404 opaco si la reseña no es de la propiedad; 409 INVALID_TRANSITION si ya está respondida", async () => {
    const { db } = stubDb(reviewRow());
    const spy = spyDeps();
    await assert.rejects(createReviewDraft({ db, context: context(["reputation.respond"]), reviewId: "rev_1", propertyId: "prop_b", correlationId: "corr_1", deps: spy.deps }), /Reseña no encontrada/);
    const responded = stubDb(reviewRow({ topicsJson: { ...(reviewRow().topicsJson as Row), status: "responded" }, responseBody: "Gracias", respondedAt: NOW }));
    await assert.rejects(
      createReviewDraft({ db: responded.db, context: context(["reputation.respond"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_1", deps: spy.deps }),
      (error: Error & { details?: { code?: string } }) => error.details?.code === "INVALID_TRANSITION"
    );
    assert.equal(spy.enqueued.length, 0);
  });
});

describe("createReviewDraft · circuito HITL cerrado (corrección HP-01)", () => {
  it("un segundo borrador rechaza el ítem pendiente anterior como sustituido antes de encolar el nuevo (un solo pendiente por reseña)", async () => {
    const { db, reviews } = stubDb(reviewRow());
    const spy = spyDeps();
    const first = await createReviewDraft({ db, context: context(["reputation.respond"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_1", now: NOW, deps: spy.deps });
    assert.equal(first.reviewItemId, "hitl_1");
    assert.equal(spy.decisions.length, 0);
    const second = await createReviewDraft({ db, context: context(["reputation.respond"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_2", now: NOW, deps: spy.deps });
    assert.equal(second.reviewItemId, "hitl_2");
    assert.equal(spy.decisions.length, 1);
    assert.equal(spy.decisions[0]!.decision, "rejected");
    assert.equal(spy.decisions[0]!.id, "hitl_1");
    assert.equal(spy.decisions[0]!.reason, REVIEW_DRAFT_SUPERSEDED_REASON);
    assert.equal((spy.decisions[0]!.context as Row).userId, "usr_gm");
    assert.equal(readReviewMeta(reviews[0]!.topicsJson).draft?.reviewItemId, "hitl_2");
    // Un ítem ya decidido no se vuelve a tocar.
    const third = await createReviewDraft({ db, context: context(["reputation.respond"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_3", now: NOW, deps: spy.deps });
    assert.equal(third.reviewItemId, "hitl_3");
    assert.equal(spy.decisions.length, 2);
  });

  it("resolveReviewDraftItem aprueba el ítem pendiente al publicar (actor de sistema si no hay persona) y devuelve null sin ítem o si el servicio falla", async () => {
    const spy = spyDeps({ hitl_9: { status: "pending" } });
    const status = await resolveReviewDraftItem({ meta: { draft: { body: "x", source: "rules", draftedAt: NOW.toISOString(), reviewItemId: "hitl_9" } }, reviewId: "rev_1", organizationId: "org_a", propertyId: "prop_a", decision: "approved", notes: "Publicada", deps: spy.deps });
    assert.equal(status, "approved");
    assert.equal((spy.decisions[0]!.context as Row).userId, "system:reputation");
    assert.equal(await resolveReviewDraftItem({ meta: { draft: { body: "x", source: "rules", draftedAt: NOW.toISOString() } }, reviewId: "rev_1", organizationId: "org_a", propertyId: "prop_a", decision: "approved", deps: spy.deps }), null);
    assert.equal(await resolveReviewDraftItem({ meta: { draft: { body: "x", source: "rules", draftedAt: NOW.toISOString(), reviewItemId: "hitl_missing" } }, reviewId: "rev_1", organizationId: "org_a", propertyId: "prop_a", decision: "approved", deps: spy.deps }), null);
  });

  it("readDraftReviewStatus lee el estado vivo del ítem; assertDraftPublishable bloquea publicar el texto de un borrador rechazado (409) y deja pasar un texto editado", async () => {
    const draftBody = "Gracias por su opinión. Lamentamos lo ocurrido.";
    const row = reviewRow({ topicsJson: { ...(reviewRow().topicsJson as Row), status: "drafted", draft: { body: draftBody, source: "rules", draftedAt: NOW.toISOString(), reviewItemId: "hitl_r" } } });
    const { db } = stubDb(row);
    const withItems = { ...db, aiHumanReviewItem: { findFirst: async (args: { where: { id: string } }) => (args.where.id === "hitl_r" ? { status: "rejected" } : null) } } as unknown as ReputationDb;
    assert.equal(await readDraftReviewStatus({ db: withItems, meta: readReviewMeta(row.topicsJson) }), "rejected");
    assert.equal(await readDraftReviewStatus({ db, meta: readReviewMeta(row.topicsJson) }), null, "sin aiHumanReviewItem en el cliente → null (stub)");
    await assert.rejects(assertDraftPublishable({ db: withItems, reviewId: "rev_1", responseBody: `  ${draftBody.toUpperCase()} ` }), (error: Error & { details?: { code?: string } }) => error.details?.code === "REVIEW_DRAFT_REJECTED");
    await assertDraftPublishable({ db: withItems, reviewId: "rev_1", responseBody: `${draftBody} Le esperamos de nuevo.` });
    await assertDraftPublishable({ db: withItems, reviewId: "rev_missing", responseBody: draftBody });
  });
});

describe("createReviewDraft · puerto de IA configurado (ficticio)", () => {
  it("exige ai.tool.execute además de reputation.respond", async () => {
    const { db } = stubDb(reviewRow());
    const spy = spyDeps();
    await assert.rejects(
      createReviewDraft({ db, context: context(["reputation.respond"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_1", ai: fakeAi(), deps: spy.deps }),
      (error: Error & { missing?: string[] }) => error.name === "PermissionDeniedError" && (error.missing ?? []).includes("ai.tool.execute")
    );
    assert.equal(spy.enqueued.length, 0);
  });

  it("con ambas claves el borrador es de IA: source ai, modelo, auditoría con actorType ai; el texto enviado al puerto va enmascarado", async () => {
    const { db, reviews } = stubDb(reviewRow());
    const spy = spyDeps();
    let received: { body?: string; title?: string } | null = null;
    const ai = fakeAi({
      draftResponse: async (input) => {
        received = { ...(input.body ? { body: input.body } : {}), ...(input.title ? { title: input.title } : {}) };
        return { body: "Gracias por su opinión.\n\nDirección de Hotel Ficticio del Norte", source: "ai", model: "modelo-x", language: "es" };
      }
    });
    const out = await createReviewDraft({ db, context: context(["reputation.respond", "ai.tool.execute"]), reviewId: "rev_1", propertyId: "prop_a", correlationId: "corr_2", ai, deps: spy.deps, tone: "cercano", language: "es" });
    assert.equal(out.source, "ai");
    assert.equal(out.provider, "ficticio");
    assert.equal(out.model, "modelo-x");
    assert.ok(received);
    assert.match(received!.body!, /\[ROOM_1\]/);
    assert.match(received!.body!, /\[EMAIL_1\]/);
    assert.doesNotMatch(received!.body!, /quejas@ejemplo\.test/);
    assert.equal(spy.audits[0]!.actorType, "ai");
    assert.equal(spy.toolCalls[0]!.model, "modelo-x");
    assert.deepEqual(spy.toolCalls[0]!.inputJson, { reviewId: "rev_1", tone: "cercano", language: "es" });
    assert.equal(readReviewMeta(reviews[0]!.topicsJson).draft?.source, "ai");
    assert.equal(reviews[0]!.responseBody, null);
  });

  it("si el puerto falla o devuelve un marcador de máscara, cae a la plantilla (source rules) y la telemetría queda failed", async () => {
    const failing = stubDb(reviewRow());
    const spyA = spyDeps();
    const outA = await createReviewDraft({
      db: failing.db,
      context: context(["reputation.respond", "ai.tool.execute"]),
      reviewId: "rev_1",
      propertyId: "prop_a",
      correlationId: "corr_3",
      ai: fakeAi({
        draftResponse: async () => {
          throw new Error("proveedor caído");
        }
      }),
      deps: spyA.deps
    });
    assert.equal(outA.source, "rules");
    assert.equal(spyA.toolCalls[0]!.status, "failed");
    assert.equal(spyA.toolCalls[0]!.errorMessage, "proveedor caído");
    assert.equal(spyA.audits[0]!.actorType, "user");

    const leaking = stubDb(reviewRow());
    const spyB = spyDeps();
    const outB = await createReviewDraft({
      db: leaking.db,
      context: context(["reputation.respond", "ai.tool.execute"]),
      reviewId: "rev_1",
      propertyId: "prop_a",
      correlationId: "corr_4",
      ai: fakeAi({ draftResponse: async () => ({ body: "Sentimos lo de la habitación [ROOM_1].", source: "ai", language: "es" }) }),
      deps: spyB.deps
    });
    assert.equal(outB.source, "rules");
    assert.doesNotMatch(outB.draft, /\[ROOM_\d\]/);
    assert.equal(spyB.toolCalls[0]!.errorMessage, "mask_placeholder_in_draft");
  });
});
