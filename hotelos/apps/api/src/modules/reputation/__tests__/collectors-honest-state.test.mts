// Unit tests · Tanda T8 · lote T8-B — estado honesto de los colectores
// (collectors/*): sin credenciales cada colector responde `unavailable`,
// `pending` o `connected` de forma honesta y fetchSince NUNCA llama a un
// fetch real (fetchImpl espía). Sin base de datos, sin red. Datos ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/collectors-honest-state.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSourceConfig, type ReviewProvider } from "../reputation-types.js";
import {
  BOOKING_UNAVAILABLE_REASON,
  EMAIL_NO_INPUT_REASON,
  EMAIL_NO_MAILBOX_REASON,
  EXPEDIA_UNAVAILABLE_REASON,
  GOOGLE_MAX_PAGES,
  GOOGLE_MORE_PAGES_REASON,
  GOOGLE_NOT_AUTHORIZED_REASON,
  GOOGLE_NO_CLIENT_REASON,
  GOOGLE_NO_FETCH_REASON,
  GOOGLE_OAUTH_SCOPE,
  REVIEW_COLLECTORS,
  buildAuthorizeUrl,
  collectorFor,
  describeSourceState,
  normalizeBookingReview,
  normalizeGoogleReview,
  type CollectorSource,
  type FetchLike,
  type FetchLikeInit
} from "../collectors/index.js";

const NOW = new Date("2026-09-19T12:00:00Z");
const SINCE = new Date("2026-09-16T12:00:00Z");

type SpyCall = { url: string; init?: FetchLikeInit };

function spyFetch(responder?: (call: SpyCall) => unknown): { fetchImpl: FetchLike; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: SpyCall = { url, ...(init ? { init } : {}) };
    calls.push(call);
    const body = responder ? responder(call) : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

function sourceFor(provider: ReviewProvider, overrides: Partial<CollectorSource> = {}): CollectorSource {
  return { propertyId: "prop_ficticia", sourceId: `src_${provider}`, provider, config: readSourceConfig({}, provider), ...overrides };
}

describe("cada colector sin credenciales: estado honesto y sin red", () => {
  const expected: Record<string, { status: string; reason?: string }> = {
    google: { status: "unavailable", reason: GOOGLE_NO_CLIENT_REASON },
    booking: { status: "unavailable", reason: BOOKING_UNAVAILABLE_REASON },
    expedia: { status: "unavailable", reason: EXPEDIA_UNAVAILABLE_REASON },
    email: { status: "pending", reason: EMAIL_NO_MAILBOX_REASON },
    csv: { status: "connected" },
    demo: { status: "connected" }
  };
  for (const collector of REVIEW_COLLECTORS) {
    it(`${collector.provider} (${collector.mode}) → ${expected[collector.provider]?.status}`, async () => {
      const source = sourceFor(collector.provider);
      const state = collector.describeState(source);
      assert.equal(state.status, expected[collector.provider]?.status);
      if (expected[collector.provider]?.reason) assert.equal(state.reason, expected[collector.provider]?.reason);
      const spy = spyFetch();
      const result = await collector.fetchSince({ source, since: SINCE, ctx: { fetchImpl: spy.fetchImpl, now: NOW } });
      assert.deepEqual(result.items, []);
      assert.equal(spy.calls.length, 0, "fetchSince no debe hacer red sin credenciales");
      assert.ok(["unavailable", "pending", "connected", "degraded"].includes(result.status));
      if (result.status !== "connected") assert.ok(result.error, "estado no conectado con motivo");
    });
  }
  it("los 6 colectores base cubren las 6 vías y declaran capacidades", () => {
    assert.deepEqual(
      REVIEW_COLLECTORS.map((collector) => `${collector.provider}:${collector.mode}`),
      ["google:api", "booking:api", "expedia:api", "email:email", "csv:csv", "demo:demo"]
    );
    for (const collector of REVIEW_COLLECTORS) {
      assert.deepEqual(Object.keys(collector.capabilities).sort(), ["categories", "fetch", "fullText", "reply"]);
    }
  });
  it("el texto de los estados no expone credenciales ni menciona lecturas de entorno", () => {
    for (const collector of REVIEW_COLLECTORS) {
      const reason = collector.describeState(sourceFor(collector.provider)).reason ?? "";
      assert.doesNotMatch(reason, /token|secret|password/i);
    }
  });
});

describe("google-business-profile", () => {
  it("con id de cliente pero sin token → pending (autorizar OAuth), sin red", async () => {
    const source = sourceFor("google", { options: { googleClientId: "cliente-ficticio.apps" } });
    const collector = collectorFor("google", "api");
    assert.ok(collector);
    assert.deepEqual(collector.describeState(source), { status: "pending", reason: GOOGLE_NOT_AUTHORIZED_REASON });
    const spy = spyFetch();
    const result = await collector.fetchSince({ source, since: SINCE, ctx: { fetchImpl: spy.fetchImpl, now: NOW } });
    assert.equal(result.status, "pending");
    assert.equal(spy.calls.length, 0);
  });
  it("conectado pero sin fetchImpl → degraded, nunca fetch global", async () => {
    const source = sourceFor("google", {
      options: { googleClientId: "cliente-ficticio.apps" },
      credentials: { accessToken: "token-ficticio" },
      config: readSourceConfig({ externalLocationId: "accounts/1/locations/2" }, "google")
    });
    const collector = collectorFor("google", "api");
    assert.ok(collector);
    assert.equal(collector.describeState(source).status, "connected");
    const result = await collector.fetchSince({ source, since: SINCE, ctx: { now: NOW } });
    assert.equal(result.status, "degraded");
    assert.equal(result.error, GOOGLE_NO_FETCH_REASON);
  });
  it("con token y fetchImpl inyectado llama a reviews.list con Bearer y normaliza", async () => {
    const source = sourceFor("google", {
      options: { googleClientId: "cliente-ficticio.apps" },
      credentials: { accessToken: "token-ficticio" },
      config: readSourceConfig({ externalLocationId: "accounts/1/locations/2" }, "google")
    });
    const spy = spyFetch(() => ({
      reviews: [
        { reviewId: "g-1", reviewer: { displayName: "Huésped Ficticio" }, starRating: "FOUR", comment: "Buen hotel", createTime: "2026-09-18T10:00:00Z", updateTime: "2026-09-18T10:00:00Z" },
        { reviewId: "g-old", reviewer: { isAnonymous: true }, starRating: "ONE", comment: "Antigua", createTime: "2026-01-01T10:00:00Z", updateTime: "2026-01-01T10:00:00Z" }
      ]
    }));
    const collector = collectorFor("google", "api");
    assert.ok(collector);
    const result = await collector.fetchSince({ source, since: SINCE, ctx: { fetchImpl: spy.fetchImpl, now: NOW } });
    assert.equal(spy.calls.length, 1);
    assert.match(spy.calls[0]!.url, /^https:\/\/mybusiness\.googleapis\.com\/v4\/accounts\/1\/locations\/2\/reviews\?/);
    assert.match(spy.calls[0]!.url, /orderBy=updateTime\+desc/);
    assert.equal(spy.calls[0]!.init?.headers?.Authorization, "Bearer token-ficticio");
    assert.equal(result.status, "connected");
    assert.equal(result.items.length, 1, "la anterior a `since` corta la paginación");
    assert.equal(result.items[0]?.externalId, "g-1");
    assert.equal(result.items[0]?.ratingRaw, 4);
    assert.equal(result.items[0]?.ratingScaleMax, 5);
    assert.equal(result.items[0]?.authorDisplayName, "Huésped F.");
    assert.equal(result.items[0]?.replyCapability, true);
    assert.ok(result.cursor && !("accessToken" in result.cursor));
  });
  it("BD-10: al alcanzar GOOGLE_MAX_PAGES con páginas pendientes devuelve degraded (lectura parcial) con nextPageToken en el cursor; la siguiente vuelta retoma desde ese token; un token rechazado (400) reinicia desde la primera página", async () => {
    const base = { options: { googleClientId: "cliente-ficticio.apps" }, credentials: { accessToken: "token-ficticio" } };
    const page = (n: number, next?: string) => ({
      reviews: [{ reviewId: `g-${n}`, reviewer: { isAnonymous: true }, starRating: "FIVE", comment: `Página ${n}`, createTime: "2026-09-18T10:00:00Z", updateTime: "2026-09-18T10:00:00Z" }],
      ...(next ? { nextPageToken: next } : {})
    });
    // 1) Más páginas que el tope: parcial honesto con el token de continuación.
    let calls = 0;
    const endless = spyFetch(() => page(++calls, `tok-${calls}`));
    const first = await collectorFor("google", "api")!.fetchSince({ source: sourceFor("google", { ...base, config: readSourceConfig({ externalLocationId: "accounts/1/locations/2" }, "google") }), since: SINCE, ctx: { fetchImpl: endless.fetchImpl, now: NOW } });
    assert.equal(endless.calls.length, GOOGLE_MAX_PAGES);
    assert.equal(first.status, "degraded");
    assert.equal(first.error, GOOGLE_MORE_PAGES_REASON);
    assert.equal(first.items.length, GOOGLE_MAX_PAGES);
    assert.equal(first.cursor?.nextPageToken, `tok-${GOOGLE_MAX_PAGES}`);
    // 2) La vuelta siguiente parte del token guardado en config.cursor y, al acabar, el cursor ya no lleva token.
    const resumed = spyFetch((call) => (call.url.includes("pageToken=tok-10") ? page(11) : page(99)));
    const second = await collectorFor("google", "api")!.fetchSince({ source: sourceFor("google", { ...base, config: readSourceConfig({ externalLocationId: "accounts/1/locations/2", cursor: { nextPageToken: "tok-10" } }, "google") }), since: SINCE, ctx: { fetchImpl: resumed.fetchImpl, now: NOW } });
    assert.equal(resumed.calls.length, 1);
    assert.match(resumed.calls[0]!.url, /pageToken=tok-10/);
    assert.equal(second.status, "connected");
    assert.equal(second.items[0]?.externalId, "g-11");
    assert.equal(second.cursor && "nextPageToken" in second.cursor, false);
    // 3) Token de continuación caducado (400): se reinicia desde la primera página en la misma vuelta.
    const rejected: FetchLike = async (url) =>
      url.includes("pageToken=")
        ? { ok: false, status: 400, json: async () => ({}), text: async () => "invalid page token" }
        : { ok: true, status: 200, json: async () => page(1), text: async () => "" };
    const restarted = await collectorFor("google", "api")!.fetchSince({ source: sourceFor("google", { ...base, config: readSourceConfig({ externalLocationId: "accounts/1/locations/2", cursor: { nextPageToken: "tok-viejo" } }, "google") }), since: SINCE, ctx: { fetchImpl: rejected, now: NOW } });
    assert.equal(restarted.status, "connected");
    assert.equal(restarted.items[0]?.externalId, "g-1");
  });
  it("401 del API → status error con motivo, sin lanzar", async () => {
    const source = sourceFor("google", {
      options: { googleClientId: "cliente-ficticio.apps" },
      credentials: { accessToken: "caducado" },
      config: readSourceConfig({ externalLocationId: "accounts/1/locations/2" }, "google")
    });
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "invalid_grant" });
    const result = await collectorFor("google", "api")!.fetchSince({ source, since: SINCE, ctx: { fetchImpl, now: NOW } });
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /401/);
  });
  it("buildAuthorizeUrl es puro y lleva scope business.manage, offline y state", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cliente-ficticio", redirectUri: "https://ejemplo.test/callback", state: "estado-1" }));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), "cliente-ficticio");
    assert.equal(url.searchParams.get("redirect_uri"), "https://ejemplo.test/callback");
    assert.equal(url.searchParams.get("scope"), GOOGLE_OAUTH_SCOPE);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("state"), "estado-1");
  });
  it("normalizeGoogleReview: anónimo sin autor; respuesta del portal", () => {
    const out = normalizeGoogleReview({ name: "accounts/1/locations/2/reviews/abc", reviewer: { isAnonymous: true, displayName: "X" }, starRating: "FIVE", reviewReply: { comment: "Gracias", updateTime: "2026-09-18T12:00:00Z" } }, NOW);
    assert.equal(out.externalId, "abc");
    assert.equal(out.authorDisplayName, undefined);
    assert.equal(out.ratingRaw, 5);
    assert.deepEqual(out.portalReply, { body: "Gracias", repliedAt: "2026-09-18T12:00:00.000Z" });
  });
});

describe("booking / expedia (stubs honestos)", () => {
  it("normalizeBookingReview mapea subpuntuaciones y positivo/negativo", () => {
    const out = normalizeBookingReview(
      {
        review_id: 555,
        created_at: "2026-09-18T08:00:00Z",
        headline: "Bien",
        positive: "Personal atento",
        negative: "Wifi lento",
        language_code: "es-ES",
        review_score: "8.5",
        scoring: { clean: 9, staff: 10, location: 8, facilities: 7, value_for_money: 6, wifi: 4 },
        reviewer: { name: "Huésped Ficticio", country_code: "es" }
      },
      NOW
    );
    assert.equal(out.externalId, "555");
    assert.equal(out.ratingRaw, 8.5);
    assert.equal(out.ratingScaleMax, 10);
    assert.equal(out.language, "es");
    assert.equal(out.authorDisplayName, "Huésped F.");
    assert.equal(out.authorCountry, "ES");
    assert.match(out.body ?? "", /Lo mejor: Personal atento/);
    assert.match(out.body ?? "", /A mejorar: Wifi lento/);
    assert.deepEqual(out.subscores, { clean: 9, comfort: null, location: 8, facilities: 7, staff: 10, value: 6, wifi: 4 });
  });
  it("con token de partner pasan a pending (cliente en T8-L5) y siguen sin red", async () => {
    for (const provider of ["booking", "expedia"] as const) {
      const collector = collectorFor(provider, "api");
      assert.ok(collector);
      const source = sourceFor(provider, { credentials: { partnerToken: "partner-ficticio" } });
      assert.equal(collector.describeState(source).status, "pending");
      const spy = spyFetch();
      const result = await collector.fetchSince({ source, since: SINCE, ctx: { fetchImpl: spy.fetchImpl, now: NOW } });
      assert.equal(spy.calls.length, 0);
      assert.deepEqual(result.items, []);
    }
  });
});

describe("email-notification", () => {
  const emails = [
    {
      messageId: "m-1",
      fromAddress: "noreply@booking.com",
      subject: "Nueva reseña de un huésped: 8,0 sobre 10",
      snippet: "Huésped A. ha dejado una reseña: «Buen hotel» https://admin.booking.com/hotel/hoteladmin/reviews.html?review_id=1",
      receivedAt: "2026-09-18T20:15:00Z"
    },
    { messageId: "m-2", fromAddress: "noreply@booking.com", subject: "Nueva reserva: 2 noches", snippet: "Confirmación de reserva", receivedAt: "2026-09-18T21:00:00Z" },
    { messageId: "m-3", fromAddress: "no-reply@e.tripadvisor.com", subject: 'New review: "Nice"', snippet: "rated 5 of 5 bubbles", receivedAt: "2026-09-01T10:00:00Z" }
  ];
  it("sin buzón → pending; con buzón y sin correos entregados → degraded; nunca red", async () => {
    const collector = collectorFor("email", "email");
    assert.ok(collector);
    const spy = spyFetch();
    const noMailbox = await collector.fetchSince({ source: sourceFor("email"), since: SINCE, ctx: { fetchImpl: spy.fetchImpl, now: NOW, emails } });
    assert.equal(noMailbox.status, "pending");
    const withMailbox = sourceFor("email", { config: readSourceConfig({ externalAccountId: "conn_ficticia" }, "email") });
    const noInput = await collector.fetchSince({ source: withMailbox, since: SINCE, ctx: { fetchImpl: spy.fetchImpl, now: NOW } });
    assert.equal(noInput.status, "degraded");
    assert.equal(noInput.error, EMAIL_NO_INPUT_REASON);
    assert.equal(spy.calls.length, 0);
  });
  it("convierte solo los correos de reseña desde `since` y descarta reservas", async () => {
    const collector = collectorFor("email", "email");
    assert.ok(collector);
    const source = sourceFor("email", { config: readSourceConfig({ externalAccountId: "conn_ficticia" }, "email") });
    const spy = spyFetch();
    const result = await collector.fetchSince({ source, since: SINCE, ctx: { fetchImpl: spy.fetchImpl, now: NOW, emails } });
    assert.equal(spy.calls.length, 0);
    assert.equal(result.status, "connected");
    assert.equal(result.items.length, 1, "la reserva se descarta y la de tripadvisor es anterior a since");
    assert.equal(result.items[0]?.portalProvider, "booking");
    assert.equal(result.items[0]?.ratingRaw, 8);
    assert.equal(result.items[0]?.bodyComplete, false);
  });
  it("un colector `tripadvisor` en modo email ignora los correos de booking", async () => {
    const collector = collectorFor("tripadvisor", "email");
    assert.ok(collector);
    assert.equal(collector.provider, "tripadvisor");
    const source = sourceFor("tripadvisor", { config: readSourceConfig({ externalAccountId: "conn_ficticia" }, "tripadvisor") });
    const result = await collector.fetchSince({ source, since: new Date("2026-08-01T00:00:00Z"), ctx: { now: NOW, emails } });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.portalProvider, "tripadvisor");
  });
});

describe("collectorFor / describeSourceState", () => {
  it("mapa proveedor × modo", () => {
    assert.equal(collectorFor("google", "api")?.provider, "google");
    assert.equal(collectorFor("google_demo", "api")?.provider, "google");
    assert.equal(collectorFor("booking", "api")?.provider, "booking");
    assert.equal(collectorFor("expedia", "api")?.provider, "expedia");
    assert.equal(collectorFor("holidaycheck", "email")?.provider, "holidaycheck");
    assert.equal(collectorFor("holidaycheck", "email"), collectorFor("holidaycheck", "email"), "instancia cacheada");
    assert.equal(collectorFor("csv", "csv")?.mode, "csv");
    assert.equal(collectorFor("google", "manual")?.mode, "csv");
    assert.equal(collectorFor("demo", "demo")?.mode, "demo");
    assert.equal(collectorFor("tripadvisor", "api"), null);
    assert.equal(collectorFor("holidaycheck", "api"), null);
    assert.equal(collectorFor("desconocido", "api"), null);
  });
  it("describeSourceState devuelve unavailable cuando no hay colector", () => {
    assert.equal(describeSourceState(sourceFor("tripadvisor"), "api").status, "unavailable");
    assert.equal(describeSourceState(sourceFor("csv"), "csv").status, "connected");
  });
});
