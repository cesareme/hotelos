/**
 * Finanzas · fix facturación-cobros (t6#5, t6#14, t6#15) — integration of
 * the payments tenancy + return page + strict bodies (REAL HTTP via
 * app.inject, Postgres required). Writes ONLY in two throw-away organisations
 * created and destroyed by this file (A = the caller, an «owner» user who is
 * NOT a platform admin; B = the foreign tenant). Neither org_123 nor Faranda
 * is touched. The demo user reception@example.com is deliberately not used:
 * it is «Local Super Admin» (admin.tenants.manage = platform admin) and the
 * tenant guard re-points platform admins to the row's organisation by design.
 *
 * Cases:
 *   1. t6#5  GET /payment-intents/:id of another organisation → opaque 404
 *            (same status + body as an unknown id); own intent → 200.
 *   2. t6#15 GET /payments/return/:intentId without a valid token → neutral
 *            page (no amount, identical for existing / unknown ids, no
 *            existence oracle); tampered / expired token → neutral; valid
 *            token → the amount of the captured payment.
 *   3. t6#15 The return / cancel URLs handed to the PSP by
 *            POST /folios/:id/payment-links carry a valid token for the
 *            intent (fake PSP adapter, nothing leaves the box), and landing
 *            on that very URL renders the intent state.
 *   4. t6#14 POST /folios/:id/lines and POST /folios/:id/invoice with an
 *            unknown key → 400 «Campo no admitido…» (nothing is created).
 *
 * Run: cd apps/api && node --import tsx --test ../../tests/integration/payments-tenancy.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
process.env.HOTELOS_ALLOW_DEMO_AUTH ??= "true";
// The fake PSP below must be the one selected: no forced provider.
delete process.env.PAYMENTS_PSP_PROVIDER;

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerPaymentsRoutes } = await import("../../apps/api/src/modules/payments/payments.routes.js");
const { paymentsRoutePermissions } = await import("../../apps/api/src/modules/payments/route-permissions.partial.js");
const { setPspRegistry } = await import("../../apps/api/src/modules/payments/psp/index.js");
const { RETURN_TOKEN_QUERY_PARAM, signReturnToken, verifyReturnToken } = await import("../../apps/api/src/modules/payments/return-token.js");
const { PAYMENT_INTENT_NOT_FOUND } = await import("../../apps/api/src/modules/payments/payments.service.js");
const { STRICT_BODY_MESSAGE } = await import("../../apps/api/src/schemas/folios.schemas.js");
const { provisionDefaultTemplateRoles } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { prisma, hashPassword } = await import("@hotelos/database");
type PspAdapter = import("../../apps/api/src/modules/payments/psp/psp.types.js").PspAdapter;
type PspPaymentLinkInput = import("../../apps/api/src/modules/payments/psp/psp.types.js").PspPaymentLinkInput;

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const MARK = `PTT-${RUN.toUpperCase()}`;
const PASS = "Ptt-integration-Passw0rd-2026!";

type Tenant = { orgId: string; propId: string; ownerEmail: string };

/** Organisation + property + the default template roles + one «owner» user (org permissions, not a platform admin). */
async function createTenant(tag: string): Promise<Tenant> {
  const orgId = `pttorg_${tag}_${RUN}`;
  const propId = `pttprop_${tag}_${RUN}`;
  await prisma.organization.create({ data: { id: orgId, name: `Tenencia pagos ${tag} ${RUN}`, legalName: `Tenencia pagos ${tag} ${RUN} SL`, taxId: "B12345674" } });
  await prisma.property.create({ data: { id: propId, organizationId: orgId, name: `Hotel ${tag} ${RUN}`, timezone: "Europe/Madrid" } });
  const roles = await provisionDefaultTemplateRoles(orgId);
  const owner = roles.find((role) => role.templateKey === "owner");
  assert.ok(owner, "the owner template role must be provisioned");
  const ownerEmail = `ptt-owner-${tag}-${RUN}@example.com`;
  const user = await prisma.user.create({ data: { organizationId: orgId, email: ownerEmail, fullName: `Owner ${tag} ${RUN}`, status: "active", passwordHash: hashPassword(PASS) } });
  await prisma.userPropertyRole.create({ data: { userId: user.id, propertyId: propId, roleId: owner.id } });
  return { orgId, propId, ownerEmail };
}

async function destroyTenant(t: Tenant): Promise<void> {
  const reservationIds = (await prisma.reservation.findMany({ where: { propertyId: t.propId }, select: { id: true } })).map((r) => r.id);
  const folioIds = reservationIds.length ? (await prisma.folio.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } })).map((f) => f.id) : [];
  if (folioIds.length) {
    await prisma.paymentIntent.deleteMany({ where: { folioId: { in: folioIds } } });
    await prisma.payment.deleteMany({ where: { folioId: { in: folioIds } } });
    await prisma.folioLine.deleteMany({ where: { folioId: { in: folioIds } } });
    await prisma.folio.deleteMany({ where: { id: { in: folioIds } } });
  }
  await prisma.paymentIntent.deleteMany({ where: { propertyId: t.propId } });
  if (reservationIds.length) await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
  const userIds = (await prisma.user.findMany({ where: { organizationId: t.orgId }, select: { id: true } })).map((u) => u.id);
  if (userIds.length) await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userPropertyRole.deleteMany({ where: { propertyId: t.propId } });
  const roleIds = (await prisma.role.findMany({ where: { organizationId: t.orgId }, select: { id: true } })).map((r) => r.id);
  if (roleIds.length) await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
  // Generic sweep of anything else hanging from the tenant (audit rows, events…), then the tenant itself.
  const cols = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `select table_name, column_name from information_schema.columns where table_schema='public' and column_name in ('organization_id','property_id') and table_name not in ('properties','organizations') order by table_name`
  );
  for (let pass = 0; pass < 2; pass++) {
    for (const c of cols) {
      const value = c.column_name === "organization_id" ? t.orgId : t.propId;
      await prisma.$executeRawUnsafe(`delete from "${c.table_name}" where "${c.column_name}" = $1`, value).catch(() => undefined);
    }
  }
  await prisma.property.deleteMany({ where: { id: t.propId } });
  await prisma.organization.deleteMany({ where: { id: t.orgId } });
  assert.equal(await prisma.organization.count({ where: { id: t.orgId } }), 0, `organisation ${t.orgId} must be gone`);
  assert.equal(await prisma.property.count({ where: { id: t.propId } }), 0, `property ${t.propId} must be gone`);
}

async function login(app: ApiApp, email: string): Promise<Headers> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASS, deviceId: "integration-tests-payments-tenancy" } });
  assert.equal(res.statusCode, 200, `login ${email}: ${res.body}`);
  return { authorization: `Bearer ${(JSON.parse(res.body) as { token: string }).token}` };
}

/** Fake PSP: configured, records the URLs it is given, never calls the network. */
function fakePsp(captured: PspPaymentLinkInput[]): PspAdapter {
  return {
    provider: "stripe",
    status: () => ({ configured: true, provider: "stripe", mode: "test", webhookSecretConfigured: true, message: "PSP de prueba (integración)." }),
    async createPaymentLink(input) {
      captured.push(input);
      return { providerReference: `cs_test_${MARK}_${captured.length}`, redirect: { method: "GET", url: `https://psp.example.test/checkout/${MARK}` }, expiresAt: null };
    },
    async capture(providerReference) {
      return { status: "pending", providerReference, capturedAt: null, error: null };
    },
    async refund(input) {
      return { status: "refunded", providerReference: `re_${input.idempotencyKey}`, error: null };
    },
    verifyWebhook() {
      return { ok: false, reason: "fake PSP: sin webhooks" };
    }
  };
}

describe("finanzas · pagos: tenencia de PaymentIntent, página de retorno firmada y cuerpos estrictos (app.inject)", () => {
  let app: ApiApp;
  let headers: Headers = {};
  const captured: PspPaymentLinkInput[] = [];
  let A: Tenant | null = null;
  let B: Tenant | null = null;
  let folioA = "";
  let intentA = "";
  let intentB = "";

  async function newFolio(propertyId: string, code: string): Promise<string> {
    const reservation = await prisma.reservation.create({
      data: { propertyId, code, channel: "direct", status: "checked_in", arrivalDate: new Date("2026-09-15T00:00:00Z"), departureDate: new Date("2026-09-17T00:00:00Z"), adults: 1, bookerName: `Prueba ${MARK}`, currency: "EUR" }
    });
    const folio = await prisma.folio.create({ data: { reservationId: reservation.id, status: "open", currency: "EUR", label: "guest", isPrimary: true } });
    return folio.id;
  }

  before(async () => {
    app = await buildApiServer();
    if (!app.hasRoute({ method: "GET", url: "/payment-intents/:id" })) {
      routePermissionManifest.push(...paymentsRoutePermissions);
      await app.register(async (sub) => {
        registerPaymentsRoutes(sub);
      });
    }
    await app.ready();
    A = await createTenant("a");
    B = await createTenant("b");
    headers = await login(app, A.ownerEmail);

    const folioB = await newFolio(B.propId, `${MARK}-B`);
    intentB = (await prisma.paymentIntent.create({ data: { propertyId: B.propId, folioId: folioB, amount: "50.00", currency: "EUR", status: "captured", provider: "stripe", providerReference: `cs_test_${MARK}_B` } })).id;
    folioA = await newFolio(A.propId, `${MARK}-A`);
    intentA = (await prisma.paymentIntent.create({ data: { propertyId: A.propId, folioId: folioA, amount: "12.34", currency: "EUR", status: "captured", provider: "stripe", providerReference: `cs_test_${MARK}_A` } })).id;
    setPspRegistry({ stripe: () => fakePsp(captured), redsys: () => fakePsp(captured) });
  });

  after(async () => {
    setPspRegistry(null);
    if (A) await destroyTenant(A);
    if (B) await destroyTenant(B);
    await app.close();
  });

  it("1 · t6#5 · GET /payment-intents/:id of another organisation is the same opaque 404 as an unknown id; the own intent answers 200", async () => {
    const foreign = await app.inject({ method: "GET", url: `/payment-intents/${intentB}`, headers });
    const unknown = await app.inject({ method: "GET", url: `/payment-intents/pi_${MARK.toLowerCase()}_missing`, headers });
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(unknown.statusCode, 404, unknown.body);
    const opaque = (body: string): Record<string, unknown> => {
      const { correlationId, ...rest } = JSON.parse(body) as Record<string, unknown>;
      void correlationId;
      return rest;
    };
    const foreignBody = opaque(foreign.body);
    assert.equal(foreignBody.message, PAYMENT_INTENT_NOT_FOUND);
    assert.deepEqual(foreignBody, opaque(unknown.body), "foreign and unknown ids must be indistinguishable (no existence oracle)");
    assert.ok(!foreign.body.includes(B!.propId) && !foreign.body.includes("50"), `the foreign row must not leak: ${foreign.body}`);

    const own = await app.inject({ method: "GET", url: `/payment-intents/${intentA}`, headers });
    assert.equal(own.statusCode, 200, own.body);
    const ownBody = JSON.parse(own.body) as { kind: string; intent: { id: string; propertyId: string; folioId: string | null; amount: number; status: string } };
    assert.equal(ownBody.kind, "payment_intent");
    assert.equal(ownBody.intent.id, intentA);
    assert.equal(ownBody.intent.propertyId, A!.propId);
    assert.equal(ownBody.intent.folioId, folioA);
    assert.equal(ownBody.intent.amount, 12.34);
    assert.equal(ownBody.intent.status, "captured");
    // (No anonymous probe here: with HOTELOS_ALLOW_DEMO_AUTH=true a token-less
    // request on a low-risk route gets the demo fallback context — usr_123, a
    // platform admin — by the documented demo policy, not by this guard.)
  });

  it("2 · t6#15 · the public return page is neutral without a valid token and shows the amount only with one", async () => {
    const neutral = await app.inject({ method: "GET", url: `/payments/return/${intentA}` });
    assert.equal(neutral.statusCode, 200);
    assert.match(String(neutral.headers["content-type"]), /text\/html/);
    assert.equal(neutral.headers["cache-control"], "private, no-store");
    assert.ok(neutral.body.includes("Respuesta de la pasarela recibida"), neutral.body);
    assert.ok(!neutral.body.includes("12,34") && !neutral.body.includes("12.34") && !neutral.body.includes("Pago recibido"), `amount leaked without token: ${neutral.body}`);

    const unknownNeutral = await app.inject({ method: "GET", url: `/payments/return/pi_${MARK.toLowerCase()}_missing?resultado=ok` });
    assert.equal(unknownNeutral.statusCode, 200);
    assert.equal(unknownNeutral.body, neutral.body, "existing and unknown intents render the same page without a token (no oracle)");

    const foreignNeutral = await app.inject({ method: "GET", url: `/payments/return/${intentB}?resultado=ok` });
    assert.equal(foreignNeutral.body, neutral.body);
    assert.ok(!foreignNeutral.body.includes("50,00"), foreignNeutral.body);

    const valid = signReturnToken(intentA);
    assert.ok(valid, "JWT_SECRET must be set so a return token can be signed");
    const tampered = `${valid.split(".")[0]}.${(valid.endsWith("A") ? "B" : "A") + valid.split(".")[1]!.slice(1)}`;
    const withTampered = await app.inject({ method: "GET", url: `/payments/return/${intentA}?resultado=ok&${RETURN_TOKEN_QUERY_PARAM}=${encodeURIComponent(tampered)}` });
    assert.equal(withTampered.body, neutral.body, "a tampered token renders the neutral page");
    const otherIntentToken = signReturnToken(intentB)!;
    const withOthers = await app.inject({ method: "GET", url: `/payments/return/${intentA}?${RETURN_TOKEN_QUERY_PARAM}=${encodeURIComponent(otherIntentToken)}` });
    assert.equal(withOthers.body, neutral.body, "a token of another intent renders the neutral page");
    const expired = signReturnToken(intentA, { now: Date.now() - 8 * 24 * 60 * 60 * 1000 })!;
    assert.equal(verifyReturnToken(intentA, expired).ok, false);
    const withExpired = await app.inject({ method: "GET", url: `/payments/return/${intentA}?${RETURN_TOKEN_QUERY_PARAM}=${encodeURIComponent(expired)}` });
    assert.equal(withExpired.body, neutral.body, "an expired token renders the neutral page");

    const ok = await app.inject({ method: "GET", url: `/payments/return/${intentA}?resultado=ok&${RETURN_TOKEN_QUERY_PARAM}=${encodeURIComponent(valid)}` });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.body.includes("Pago recibido") && ok.body.includes("12,34 EUR"), `the legitimate landing shows the captured amount: ${ok.body}`);
  });

  it("3 · t6#15 · the URLs handed to the PSP carry a valid token for the intent and land on the intent state", async () => {
    const link = await app.inject({ method: "POST", url: `/folios/${folioA}/payment-links`, headers, payload: { amount: 5, clientRequestId: `${MARK}-link` } });
    assert.equal(link.statusCode, 202, link.body);
    const body = JSON.parse(link.body) as { kind: string; intent: { id: string; status: string; provider: string | null }; idempotent: boolean };
    assert.equal(body.kind, "payment_intent");
    assert.equal(body.intent.status, "requires_action");
    assert.equal(body.intent.provider, "stripe");
    assert.equal(captured.length, 1, "the fake PSP received exactly one createPaymentLink");
    const given = captured[0]!;
    for (const [label, raw, resultado] of [["returnUrl", given.returnUrl, "ok"], ["cancelUrl", given.cancelUrl, "ko"]] as const) {
      const url = new URL(raw);
      assert.equal(url.pathname, `/payments/return/${body.intent.id}`, `${label}: ${raw}`);
      assert.equal(url.searchParams.get("resultado"), resultado, `${label}: ${raw}`);
      const token = url.searchParams.get(RETURN_TOKEN_QUERY_PARAM);
      assert.ok(token, `${label} must carry the return token: ${raw}`);
      assert.equal(verifyReturnToken(body.intent.id, token).ok, true, `${label}: token must verify for the intent`);
      assert.equal(verifyReturnToken(intentA, token).ok, false, `${label}: token must not verify for another intent`);
    }
    assert.ok(given.notifyUrl.endsWith("/payments/webhooks/stripe"), given.notifyUrl);

    const landing = new URL(given.returnUrl);
    const page = await app.inject({ method: "GET", url: `${landing.pathname}${landing.search}` });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes("Pago en proceso"), `requires_action intent → «Pago en proceso»: ${page.body}`);
    const cancel = new URL(given.cancelUrl);
    const cancelled = await app.inject({ method: "GET", url: `${cancel.pathname}${cancel.search}` });
    assert.ok(cancelled.body.includes("Pago no completado"), `resultado=ko with a valid token → «Pago no completado»: ${cancelled.body}`);
    const bare = await app.inject({ method: "GET", url: landing.pathname });
    assert.ok(bare.body.includes("Respuesta de la pasarela recibida") && !bare.body.includes("Pago en proceso"), `the same URL without its token is neutral: ${bare.body}`);

    // Replay of the same clientRequestId → the same intent, no second PSP call.
    const replay = await app.inject({ method: "POST", url: `/folios/${folioA}/payment-links`, headers, payload: { amount: 5, clientRequestId: `${MARK}-link` } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((JSON.parse(replay.body) as { intent: { id: string } }).intent.id, body.intent.id);
    assert.equal(captured.length, 1);
  });

  it("4 · t6#14 · POST /folios/:id/lines and POST /folios/:id/invoice refuse unknown keys with 400 and create nothing", async () => {
    const linesBefore = await prisma.folioLine.count({ where: { folioId: folioA } });
    const invoicesBefore = await prisma.invoice.count({ where: { folioId: folioA } });
    const line = await app.inject({ method: "POST", url: `/folios/${folioA}/lines`, headers, payload: { type: "minibar", description: "Agua", quantity: 1, unitPrice: 2, foo: 1 } });
    assert.equal(line.statusCode, 400, line.body);
    assert.ok(line.body.includes(STRICT_BODY_MESSAGE), line.body);
    const draft = await app.inject({ method: "POST", url: `/folios/${folioA}/invoice`, headers, payload: { customerType: "guest", customerName: "X", foo: 1 } });
    assert.equal(draft.statusCode, 400, draft.body);
    assert.ok(draft.body.includes(STRICT_BODY_MESSAGE), draft.body);
    const nestedDraft = await app.inject({ method: "POST", url: `/folios/${folioA}/invoice`, headers, payload: { customerType: "guest", lines: [{ description: "x", amount: 1, discount: 5 }] } });
    assert.equal(nestedDraft.statusCode, 400, nestedDraft.body);
    assert.equal(await prisma.folioLine.count({ where: { folioId: folioA } }), linesBefore, "no folio line was created");
    assert.equal(await prisma.invoice.count({ where: { folioId: folioA } }), invoicesBefore, "no invoice draft was created");
  });
});
