/**
 * Tanda CHK · lote W5-A — contrato PSP con preautorización (sandbox) y
 * PaymentToken desde el check-in (docs/design/CHECKIN-AUTOMATIZADO-IA.md §1.7,
 * §2.4 «Pagos», §4a paso 7, §9 L8, D3) — integración sobre Postgres real con
 * una organización AISLADA (helpers/l2-tenant.mts). Ningún PSP real: el
 * registro se sustituye por sandboxPspRegistry (transporte en memoria,
 * respuestas deterministas) y las variables STRIPE_* / REDSYS_* /
 * PAYMENTS_PSP_PROVIDER se limpian antes de arrancar.
 *
 * Qué fija:
 *   · POST /guest-portal/check-in/payment-link (W3-A) sin PSP → { status:
 *     "at_reception", reason: PSP_NOT_CONFIGURED }, paymentStatus at_reception y
 *     ningún PaymentIntent; resolveGuestPayment sin PSP → at_reception con la
 *     primera noche (200 / 2 = 100,00);
 *   · con PAYMENTS_PSP_PROVIDER=stripe y el sandbox: authorizeGuestPayment crea
 *     el PaymentIntent propio (status authorized, provider stripe,
 *     providerReference pi_sandbox_… descifrado por la extensión de PII), reutiliza
 *     el PaymentToken guardado del titular (off-session), deja la sesión en
 *     paymentStatus authorized con paymentIntentId, y una segunda llamada es
 *     idempotente (mismo intento, sin segunda petición al proveedor);
 *   · evidencia: PaymentToken nuevo del titular (token_ref cifrado en reposo,
 *     jamás un PAN) enlazado en la sesión, y el parte del titular con
 *     paymentType card, paymentMethodIdentifier «visa ****NNNN», titular,
 *     caducidad, fecha y referencia del intento; recordPaymentEvidence repetido no
 *     duplica el token; captura y anulación por el mismo adaptador sandbox;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/payments-preauth.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

// El helper carga .env: las credenciales de PSP se retiran DESPUÉS y antes de
// importar los adaptadores (stripeConfigFromEnv / redsysConfigFromEnv leen el
// entorno en cada instancia, así que basta con limpiarlo antes de cada caso).
const { createIsolatedTenant, cleanupTenant, enableModules, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
for (const key of ["PAYMENTS_PSP_PROVIDER", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "REDSYS_MERCHANT_CODE", "REDSYS_SECRET_KEY", "REDSYS_TERMINAL", "REDSYS_MODE"]) delete process.env[key];

type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { inviteReservation } = await import("../../apps/api/src/modules/checkin/checkin-session.service.js");
const { checkInServiceContext } = await import("../../apps/api/src/modules/checkin/service-context.js");
const { getPolicy } = await import("../../apps/api/src/modules/checkin/checkin-policy.service.js");
const { authorizeGuestPayment, recordPaymentEvidence, resolveGuestPayment } = await import("../../apps/api/src/modules/checkin/checkin-payment.service.js");
const { createSpainGuestRegisterRecord } = await import("../../apps/api/src/modules/compliance/compliance.service.js");
const { findReservationFolio } = await import("../../apps/api/src/modules/folio/folio.service.js");
const { sandboxPspRegistry, setPspRegistry, resolvePspAdapter } = await import("../../apps/api/src/modules/payments/psp/index.js");
const { looksLikePan } = await import("../../apps/api/src/modules/payments/psp/psp.types.js");
const { sandboxLast4 } = await import("../../apps/api/src/modules/payments/psp/stripe.adapter.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Reply = { status: number; body: any; raw: string };
type SessionRow = NonNullable<Awaited<ReturnType<typeof prisma.checkInSession.findUnique>>>;

const RUN = `w5a${newRunId()}`;
const ARRIVAL = "2026-10-02";
const DEPARTURE = "2026-10-04";
const NOW = new Date("2026-09-20T10:00:00.000Z");
/** Huésped: rutas públicas (sin JWT); NODE_ENV≠production para que la invitación devuelva el token (entrega simulada). */
const GUEST_ENV: Record<string, string | undefined> = { ...STRICT_ENV, NODE_ENV: "development", HOTELOS_ALLOW_DEMO_AUTH: "true", PAYMENTS_PSP_PROVIDER: undefined, STRIPE_SECRET_KEY: undefined, REDSYS_MERCHANT_CODE: undefined, REDSYS_SECRET_KEY: undefined };
const STORED_TOKEN_REF = `pm_sandbox_${RUN}`;

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let reservationId = "";
let primaryGuestId = "";
let folioId = "";
let sessionId = "";
let token = "";
let primaryRecordId = "";
let storedTokenId = "";
let registry: ReturnType<typeof sandboxPspRegistry>;
let providerReference = "";
let intentId = "";

async function call(method: Method, url: string, options: { payload?: unknown; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {}): Promise<Reply> {
  const res = await withEnv(options.env ?? STRICT_ENV, () => app.inject({ method, url, headers: options.headers ?? {}, ...(options.payload !== undefined ? { payload: options.payload } : {}) }));
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

const guestCall = (method: Method, url: string, payload?: unknown) => call(method, url, { headers: { "x-guest-token": token }, ...(payload !== undefined ? { payload } : {}), env: GUEST_ENV });

async function session(): Promise<SessionRow> {
  const row = await prisma.checkInSession.findUnique({ where: { id: sessionId } });
  assert.ok(row, "la sesión de check-in existe");
  return row;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "spain_guest_register_compliance"]);
  app = await buildApiServer();
  await app.ready();

  const primary = await prisma.guest.create({
    data: {
      id: `guest_${RUN}_titular`,
      organizationId: A.organizationId,
      firstName: "Ana",
      surname1: "Gamma",
      surname2: "Delta",
      sex: "M",
      nationality: "ESP",
      dateOfBirth: new Date("1990-04-12T00:00:00.000Z"),
      documentType: "DNI",
      documentNumber: `W5A${RUN.slice(-6).toUpperCase()}1`,
      documentSupportNumber: "AAA000001",
      email: `titular.${RUN}@chk.test`,
      mobilePhone: "+34600000101",
      residenceAddress: "Rúa da Proba 1",
      residenceLocality: "A Coruña",
      residenceCountry: "ESP"
    },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: `CHK-W5A-${RUN}`,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`),
      adults: 1,
      children: 0,
      roomTypeId: A.roomTypeA,
      totalAmount: "200.00",
      currency: "EUR",
      bookerName: "Ana Gamma",
      bookerEmail: `titular.${RUN}@chk.test`
    },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: primaryGuestId, isPrimary: true } });
  const folio = await prisma.folio.create({ data: { reservationId, guestId: primaryGuestId, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } });
  folioId = folio.id;
  await prisma.folioLine.create({ data: { folioId, type: "room", description: "Alojamiento DBL · 2 noches", quantity: 2, unitPrice: "100.00", taxCode: "ES_IVA_10", taxCategory: "accommodation", total: "200.00", postedBy: `test-${RUN}` } });
  // Política: garantía de la primera noche (200 / 2 noches = 100,00).
  await prisma.propertyCheckInPolicy.create({ data: { propertyId: A.propertyA, selfCheckInEnabled: true, depositPolicy: "first_night" } });

  // Invitación con el contexto de servicio (pms.reservation.modify): entrega simulada → token en claro para el test.
  const context = await checkInServiceContext(A.propertyA, { kind: "system", job: `w5a-${RUN}` });
  const invited = await withEnv(GUEST_ENV, () => inviteReservation({ reservationId, channel: "email", context, correlationId: `corr_w5a_${RUN}` }));
  assert.equal(invited.session.status, "invited");
  assert.equal(typeof invited.token, "string", "fuera de producción y sin proveedor real la invitación devuelve el token");
  sessionId = invited.session.id;
  token = invited.token!;

  // Parte de viajeros del titular (contexto de servicio: guest_register.create) enlazado al viajero de la sesión.
  const record = await createSpainGuestRegisterRecord({
    context,
    propertyId: A.propertyA,
    reservationId,
    payload: { guestId: primaryGuestId, isPrimaryGuest: true, firstName: "Ana", surname1: "Gamma", surname2: "Delta", sex: "M", nationality: "ESP", dateOfBirth: "1990-04-12", documentType: "DNI", documentNumber: `W5A${RUN.slice(-6).toUpperCase()}1`, documentSupportNumber: "AAA000001", residenceFullAddress: "Rúa da Proba 1", residenceLocality: "A Coruña", residenceCountry: "ESP", phoneMobile: "+34600000101", email: `titular.${RUN}@chk.test`, checkinAt: `${ARRIVAL}T14:00:00.000Z`, checkoutAt: `${DEPARTURE}T11:00:00.000Z`, contractReference: `CHK-W5A-${RUN}` },
    correlationId: `corr_w5a_${RUN}`
  });
  primaryRecordId = record.id;
  await prisma.checkInGuest.updateMany({ where: { sessionId, isPrimary: true }, data: { guestRegisterRecordId: primaryRecordId } });

  // Tarjeta guardada del titular (token de Stripe Elements, nunca un PAN) para la autorización off-session.
  const stored = await prisma.paymentToken.create({ data: { organizationId: A.organizationId, guestId: primaryGuestId, provider: "stripe", tokenRef: STORED_TOKEN_REF, last4: "4242", brand: "visa", expiryMonth: 1, expiryYear: 2030, isDefault: true }, select: { id: true } });
  storedTokenId = stored.id;
});

after(async () => {
  setPspRegistry(null);
  delete process.env.PAYMENTS_PSP_PROVIDER;
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("W5-A · sin PSP", () => {
  it("payment-link del portal → { status: at_reception, reason: PSP_NOT_CONFIGURED }, paymentStatus at_reception y ningún PaymentIntent", async () => {
    setPspRegistry(null);
    assert.equal(await resolvePspAdapter(A.propertyA), null, "sin credenciales ni conexión no hay PSP");
    const res = await guestCall("POST", "/guest-portal/check-in/payment-link", {});
    assert.equal(res.status, 200, res.raw.slice(0, 400));
    assert.equal(res.body.status, "at_reception");
    assert.equal(res.body.reason, "PSP_NOT_CONFIGURED");
    assert.equal((await session()).paymentStatus, "at_reception");
    assert.equal(await prisma.paymentIntent.count({ where: { folioId } }), 0, "sin PSP no nace ningún intento de pago");
  });

  it("resolveGuestPayment sin PSP → at_reception por la primera noche (100,00), y authorizeGuestPayment no hace nada", async () => {
    setPspRegistry(null);
    const folio = await findReservationFolio(reservationId);
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const policy = await getPolicy(A.propertyA);
    assert.equal(policy.depositPolicy, "first_night");
    const resolved = await resolveGuestPayment({ session: await session(), policy, folio, reservation });
    assert.deepEqual({ mode: resolved.mode, amount: resolved.amount, currency: resolved.currency, required: resolved.required, reason: resolved.reason }, { mode: "at_reception", amount: 100, currency: "EUR", required: true, reason: "psp_not_configured" });
    assert.equal(resolved.breakdown.nights, 2);
    const outcome = await authorizeGuestPayment({ session: await session(), policy, folio, reservation, correlationId: `corr_w5a_${RUN}_noop` });
    assert.equal(outcome.status, "not_applicable");
    assert.equal(await prisma.paymentIntent.count({ where: { folioId } }), 0);
  });
});

describe("W5-A · con sandbox Stripe", () => {
  it("authorize crea el PaymentIntent (authorized, pi_sandbox_) con el token guardado del titular y deja paymentStatus authorized; la repetición es idempotente", async () => {
    registry = sandboxPspRegistry({ now: () => NOW });
    setPspRegistry(registry);
    process.env.PAYMENTS_PSP_PROVIDER = "stripe";
    const adapter = await resolvePspAdapter(A.propertyA);
    assert.ok(adapter && adapter.provider === "stripe" && /SANDBOX/.test(adapter.status().message), "el registro sandbox es el PSP resuelto");

    const folio = await findReservationFolio(reservationId);
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const policy = await getPolicy(A.propertyA);
    const resolved = await resolveGuestPayment({ session: await session(), policy, folio, reservation });
    assert.deepEqual({ mode: resolved.mode, amount: resolved.amount, provider: resolved.provider }, { mode: "authorize", amount: 100, provider: "stripe" });

    const outcome = await authorizeGuestPayment({ session: await session(), policy, folio, reservation, correlationId: `corr_w5a_${RUN}_auth`, now: NOW });
    assert.equal(outcome.status, "authorized", JSON.stringify(outcome));
    if (outcome.status !== "authorized") return;
    assert.equal(outcome.usedStoredToken, true, "el titular tiene un PaymentToken de Stripe → off-session");
    assert.equal(outcome.idempotent, false);
    assert.equal(outcome.captureWindowDays, 15, "salida 2026-10-04 desde 2026-09-20: 14 días + 1");
    assert.equal(outcome.expiresAtSource, "provider");
    assert.equal(outcome.expiresAt, new Date(NOW.getTime() + 30 * 86_400_000).toISOString(), "autorización extendida a 30 días según el proveedor");
    assert.equal(outcome.intent.status, "authorized");
    assert.equal(outcome.intent.amount, 100);
    assert.match(outcome.intent.providerReference ?? "", /^pi_sandbox_/);
    intentId = outcome.intent.id;
    providerReference = outcome.intent.providerReference!;

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    assert.equal(intent.status, "authorized");
    assert.equal(intent.provider, "stripe");
    assert.equal(intent.folioId, folioId);
    assert.equal(intent.reservationId, reservationId);
    assert.equal(Number(intent.amount), 100);
    assert.equal(intent.providerReference, providerReference, "providerReference descifrado por la extensión de PII");
    const rawIntent = await prisma.$queryRaw<Array<{ provider_reference: string | null }>>`SELECT provider_reference FROM payment_intents WHERE id = ${intentId}`;
    assert.ok(rawIntent[0]?.provider_reference && !rawIntent[0].provider_reference.startsWith("pi_"), "en reposo el providerReference va cifrado (PII_FIELDS.PaymentIntent)");

    const row = await session();
    assert.equal(row.paymentStatus, "authorized");
    assert.equal(row.paymentIntentId, intentId);
    const request = registry.stripeState.calls.find((c) => c.method === "POST" && c.path === "/payment_intents");
    assert.ok(request, "una petición de PaymentIntent al sandbox");
    assert.equal(request!.body.capture_method, "manual");
    assert.equal(request!.body["payment_method_options[card][request_extended_authorization]"], "if_available");
    assert.equal(request!.body.payment_method, STORED_TOKEN_REF);
    assert.equal(request!.body["metadata[intentId]"], intentId);
    assert.equal(await prisma.payment.count({ where: { folioId } }), 0, "una preautorización no es un cobro: sin Payment en el folio");

    const callsBefore = registry.stripeState.calls.length;
    const again = await authorizeGuestPayment({ session: await session(), policy, folio, reservation, correlationId: `corr_w5a_${RUN}_again`, now: NOW });
    assert.equal(again.status, "not_applicable", "la sesión ya está authorized: nada que pedir");
    const forced = await authorizeGuestPayment({ session: { ...(await session()), paymentStatus: "none" }, policy, folio, reservation, correlationId: `corr_w5a_${RUN}_replay`, now: NOW });
    assert.equal(forced.status, "authorized");
    assert.equal(forced.status === "authorized" && forced.idempotent, true, "mismo clientRequestId → mismo intento");
    assert.equal(forced.status === "authorized" && forced.intent.id, intentId);
    assert.equal(registry.stripeState.calls.length, callsBefore, "sin segunda petición al proveedor");
    assert.equal(await prisma.paymentIntent.count({ where: { folioId } }), 1);
  });

  it("evidencia en PaymentToken (cifrado, sin PAN) y en el parte del titular; recordPaymentEvidence repetido no duplica", async () => {
    const row = await session();
    assert.ok(row.paymentTokenId, "la autorización dejó el token enlazado en la sesión");
    assert.notEqual(row.paymentTokenId, storedTokenId, "la evidencia es el token que devolvió el proveedor, no la fila previa");
    const evidenceToken = await prisma.paymentToken.findUniqueOrThrow({ where: { id: row.paymentTokenId! } });
    assert.equal(evidenceToken.organizationId, A.organizationId);
    assert.equal(evidenceToken.guestId, primaryGuestId);
    assert.equal(evidenceToken.provider, "stripe");
    assert.equal(evidenceToken.tokenRef, STORED_TOKEN_REF, "el sandbox devuelve el mismo pm_… confirmado");
    assert.equal(evidenceToken.brand, "visa");
    assert.equal(evidenceToken.last4, sandboxLast4(STORED_TOKEN_REF));
    assert.match(evidenceToken.last4 ?? "", /^[0-9]{4}$/);
    assert.equal(evidenceToken.expiryMonth, 12);
    assert.equal(evidenceToken.expiryYear, NOW.getUTCFullYear() + 3);
    assert.equal(looksLikePan(evidenceToken.tokenRef), false);
    const rawToken = await prisma.$queryRaw<Array<{ token_ref: string; last4: string | null; brand: string | null }>>`SELECT token_ref, last4, brand FROM payment_tokens WHERE id = ${row.paymentTokenId}`;
    assert.ok(rawToken[0] && !rawToken[0].token_ref.startsWith("pm_"), "token_ref cifrado en reposo (PII_FIELDS.PaymentToken)");
    assert.doesNotMatch(JSON.stringify(rawToken[0]), /[0-9]{12,}/, "ninguna columna del token lleva 12+ dígitos seguidos");

    const record = await prisma.guestRegisterRecord.findUniqueOrThrow({ where: { id: primaryRecordId } });
    assert.equal(record.paymentType, "card");
    assert.equal(record.paymentMethodIdentifier, `visa ****${sandboxLast4(STORED_TOKEN_REF)}`);
    assert.equal(record.paymentHolder, "Ana Gamma Delta");
    assert.equal(record.paymentCardExpiryMonth, 12);
    assert.equal(record.paymentCardExpiryYear, NOW.getUTCFullYear() + 3);
    assert.ok(record.paymentDate instanceof Date);
    assert.equal(record.paymentReference, intentId, "referencia = id del intento propio, nunca la del proveedor");
    assert.equal(record.updatedBy, `guest:${sessionId}`);
    const rawRecord = await prisma.$queryRaw<Array<{ payment_method_identifier: string | null; payment_holder: string | null; payment_reference: string | null; payment_type: string | null }>>`SELECT payment_method_identifier, payment_holder, payment_reference, payment_type FROM guest_register_records WHERE id = ${primaryRecordId}`;
    assert.doesNotMatch(JSON.stringify(rawRecord[0]), /[0-9]{12,}/, "el parte no lleva PAN");

    const repeated = await recordPaymentEvidence({ session: await session(), providerReference, correlationId: `corr_w5a_${RUN}_evidence2` });
    assert.equal(repeated.recorded, true);
    assert.equal(repeated.recorded && repeated.reused, true);
    assert.equal(repeated.recorded && repeated.paymentTokenId, row.paymentTokenId);
    assert.equal(repeated.recorded && repeated.guestRegisterRecordId, primaryRecordId);
    assert.equal(await prisma.paymentToken.count({ where: { guestId: primaryGuestId, deletedAt: null } }), 2, "la tarjeta guardada previa + la evidencia; sin duplicados");

    await flushAuditQueues();
    const actions = (await prisma.auditEvent.findMany({ where: { organizationId: A.organizationId, action: { in: ["PAYMENT_AUTHORIZATION_CREATED", "PAYMENT_TOKEN_STORED", "GUEST_REGISTER_PAYMENT_RECORDED", "CheckInPaymentStatusChanged"] } }, select: { action: true, afterJson: true } })).map((event) => event.action);
    for (const expected of ["PAYMENT_AUTHORIZATION_CREATED", "PAYMENT_TOKEN_STORED", "GUEST_REGISTER_PAYMENT_RECORDED", "CheckInPaymentStatusChanged"]) assert.ok(actions.includes(expected), `auditoría ${expected}`);
    const audits = await prisma.auditEvent.findMany({ where: { organizationId: A.organizationId, action: { in: ["PAYMENT_AUTHORIZATION_CREATED", "PAYMENT_TOKEN_STORED", "GUEST_REGISTER_PAYMENT_RECORDED"] } }, select: { afterJson: true } });
    assert.doesNotMatch(JSON.stringify(audits), new RegExp(STORED_TOKEN_REF), "el token nunca va a la auditoría");
    assert.doesNotMatch(JSON.stringify(audits), /[0-9]{12,}/);
  });

  it("la autorización se captura (o se anula) por el mismo adaptador: captureAuthorization → captured", async () => {
    const adapter = await resolvePspAdapter(A.propertyA);
    assert.ok(adapter?.captureAuthorization);
    const captured = await adapter.captureAuthorization!(providerReference, "60.00");
    assert.equal(captured.status, "captured");
    assert.equal(registry.stripeState.intents.get(providerReference)!.amount_received, 6000);
    const release = await adapter.releaseAuthorization!(providerReference);
    assert.equal(release.status, "failed", "una autorización capturada ya no se anula");
  });

  it("sin token guardado la autorización queda pending con página alojada (link_sent), nunca authorized", async () => {
    const folio = await findReservationFolio(reservationId);
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const policy = await getPolicy(A.propertyA);
    const fresh = { ...(await session()), paymentStatus: "none", paymentIntentId: null };
    const outcome = await authorizeGuestPayment({ session: fresh, policy, folio, reservation, useStoredToken: false, urls: { returnUrl: "https://portal.example.test/ok" }, clientRequestId: `w5a-hosted-${RUN}`, correlationId: `corr_w5a_${RUN}_hosted`, now: NOW });
    assert.equal(outcome.status, "pending", JSON.stringify(outcome));
    if (outcome.status !== "pending") return;
    assert.equal(outcome.usedStoredToken, false);
    assert.equal(outcome.redirect?.method, "GET");
    assert.match(outcome.redirect?.url ?? "", /^https:\/\/checkout\.stripe\.com\/sandbox\/cs_sandbox_/);
    assert.equal(outcome.evidence, null, "sin autorización no hay evidencia");
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: outcome.intent.id } });
    assert.equal(intent.status, "requires_action");
    assert.equal(intent.paymentLinkUrl, outcome.redirect?.url);
    const row = await session();
    assert.equal(row.paymentStatus, "link_sent");
    assert.equal(row.paymentIntentId, outcome.intent.id);
  });
});
