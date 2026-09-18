/**
 * Tanda L2 · L2-08 · tests de integración mínimos por módulo — COMERCIAL
 * (sales, guests, messaging, guest-portal, marketplace, webhooks, advanced).
 * app.inject sobre Postgres real con dos organizaciones AISLADAS
 * (helpers/l2-tenant.mts): A escribe y lee; B (otra organización) nunca ve
 * nada. STRICT_ENV: auth real, sin unión de permisos de demo, RBAC_STRICT=true.
 *
 * Tres casos por módulo (criterio §4 del plan · fila L2 «tests por módulo»):
 *   (1) crear o leer con ámbito (fila en Prisma con organizationId / propertyId de A);
 *   (2) 403 sin clave (mensaje en español del gate o de requirePermissions,
 *       nunca el 403 de «ruta no registrada en el manifiesto»);
 *   (3) 404 opaco en propiedad ajena (recepción de A sobre el hotel B; usuario
 *       de la organización B sobre el hotel A o sobre una entidad de A).
 *
 * Usuarios (plantillas T8a): owner (lectura de organización), manager
 * (Dirección de hotel en A: escrituras comerciales), receptionist (solo A),
 * accountant, systems (plantilla admin: developer.manage_webhooks, sin
 * guests.read ni crm.read), auditor (única plantilla sin ai.tool.execute) y,
 * en B, owner / manager / receptionist / systems. El detalle del motor
 * genérico (advanced) está en l2-motor-generico.test.mts (L2-03): aquí solo
 * humo de lectura con `items`.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-modulos-comercial.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `c${newRunId()}`;
const OPAQUE_404 = "Propiedad no encontrada.";

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
let owner: Session;
let manager: Session;
let reception: Session;
let accountant: Session;
let systems: Session;
let auditor: Session;
let ownerB: Session;
let managerB: Session;
let receptionB: Session;
let systemsB: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown; propertyId?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), ...(options.propertyId ? { "x-property-id": options.propertyId } : {}), ...(options.headers ?? {}) },
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

function expect404(reply: Reply, message = OPAQUE_404): void {
  assert.equal(reply.status, 404, reply.raw.slice(0, 300));
  assert.equal(reply.body?.message, message);
}

/** 403 en español del gate o de requirePermissions, con la clave que falta; nunca el de «ruta sin manifiesto». */
function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
  assert.doesNotMatch(message, /manifiesto/, "no es el 403 de ruta sin entrada en el manifiesto");
}

async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId?: string }): Promise<{ id: string; email: string }> {
  const id = `usr_l2_${spec.local}_${tenant.run}`;
  const email = `${spec.local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L2 ${spec.local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[spec.templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: { userId: id, roleId, scopeType: spec.propertyId ? "property" : "organization", propertyId: spec.propertyId ?? null, organizationId: tenant.organizationId, reason: `l2-08 ${spec.local}` }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  const managerUser = await addTenantUser(A, { local: "manager", templateKey: "manager", propertyId: A.propertyA });
  const auditorUser = await addTenantUser(A, { local: "auditor", templateKey: "auditor" });
  const managerUserB = await addTenantUser(B, { local: "manager", templateKey: "manager", propertyId: B.propertyA });
  await enableModules(A.propertyA, ["workforce_labor", "guest_data_crm_loyalty"]);
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l2-08-com-owner");
    manager = await loginOrThrow(app, managerUser.email, A.password, "l2-08-com-manager");
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l2-08-com-reception");
    accountant = await loginOrThrow(app, A.users.accountant.email, A.password, "l2-08-com-accountant");
    systems = await loginOrThrow(app, A.users.systems.email, A.password, "l2-08-com-systems");
    auditor = await loginOrThrow(app, auditorUser.email, A.password, "l2-08-com-auditor");
    ownerB = await loginOrThrow(app, B.users.owner.email, B.password, "l2-08-com-owner-b");
    managerB = await loginOrThrow(app, managerUserB.email, B.password, "l2-08-com-manager-b");
    receptionB = await loginOrThrow(app, B.users.receptionist.email, B.password, "l2-08-com-reception-b");
    systemsB = await loginOrThrow(app, B.users.systems.email, B.password, "l2-08-com-systems-b");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
    if (B) await cleanupTenant(B.organizationId);
  } finally {
    await app?.close();
  }
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
});

// ---------------------------------------------------------------------------
// sales
// ---------------------------------------------------------------------------

describe("L2-08 · sales: cuentas y oportunidades con ámbito", () => {
  let accountId = "";
  let opportunityId = "";

  it("(1) POST /sales/accounts (organización) y POST /sales/opportunities (x-property-id A) persisten con organizationId / propertyId de A", async () => {
    const account = await call("POST", "/sales/accounts", manager, { propertyId: A.propertyA, payload: { name: `Viajes L2 ${RUN}`, accountType: "corporate" } });
    assert.equal(account.status, 200, account.raw.slice(0, 300));
    accountId = account.body.id;
    const accountRow = await prisma.salesAccount.findUnique({ where: { id: accountId } });
    assert.equal(accountRow?.organizationId, A.organizationId);

    const opportunity = await call("POST", "/sales/opportunities", manager, { propertyId: A.propertyA, payload: { name: `Congreso L2 ${RUN}`, accountId, estimatedValue: 12000, stage: "prospect" } });
    assert.equal(opportunity.status, 200, opportunity.raw.slice(0, 300));
    opportunityId = opportunity.body.id;
    const opportunityRow = await prisma.salesOpportunity.findUnique({ where: { id: opportunityId } });
    assert.equal(opportunityRow?.propertyId, A.propertyA);
    assert.equal(opportunityRow?.accountId, accountId);

    const accounts = await call("GET", "/sales/accounts", owner, { propertyId: A.propertyA });
    assert.equal(accounts.status, 200, accounts.raw.slice(0, 300));
    assert.ok(accounts.body.some((row: { id: string }) => row.id === accountId));
    const opportunities = await call("GET", "/sales/opportunities", owner, { propertyId: A.propertyA });
    assert.equal(opportunities.status, 200, opportunities.raw.slice(0, 300));
    assert.ok(opportunities.body.some((row: { id: string }) => row.id === opportunityId));
  });

  it("(2) 403 sin clave: recepción no crea cuentas ni oportunidades (sales.pipeline.manage); contabilidad no lee el pipeline (sales.pipeline.read)", async () => {
    expect403(await call("POST", "/sales/accounts", reception, { propertyId: A.propertyA, payload: { name: "X" } }), "sales.pipeline.manage");
    expect403(await call("POST", "/sales/opportunities", reception, { propertyId: A.propertyA, payload: { name: "X" } }), "sales.pipeline.manage");
    expect403(await call("GET", "/sales/opportunities", accountant, { propertyId: A.propertyA }), "sales.pipeline.read");
    assert.equal(await prisma.salesAccount.count({ where: { organizationId: A.organizationId } }), 1);
  });

  it("(3) 404 opaco: recepción de A con x-property-id B, organización B sobre el hotel A y sobre la oportunidad por id; B no ve las cuentas de A", async () => {
    expect404(await call("GET", "/sales/opportunities", reception, { propertyId: A.propertyB }));
    expect404(await call("GET", "/sales/opportunities", ownerB, { propertyId: A.propertyA }));
    expect404(await call("PATCH", `/sales/opportunities/${opportunityId}`, managerB, { propertyId: B.propertyA, payload: { stage: "won" } }), "Oportunidad no encontrada.");
    const accountsB = await call("GET", "/sales/accounts", ownerB, { propertyId: B.propertyA });
    assert.equal(accountsB.status, 200);
    assert.ok(!accountsB.body.some((row: { id: string }) => row.id === accountId), "la organización B no ve las cuentas de A");
    assert.equal((await prisma.salesOpportunity.findUnique({ where: { id: opportunityId } }))?.stage, "prospect", "B no modifica la oportunidad");
  });
});

// ---------------------------------------------------------------------------
// guests
// ---------------------------------------------------------------------------

describe("L2-08 · guests: perfiles de huésped con ámbito de organización", () => {
  let guestId = "";

  it("(1) POST /guests (recepción, x-property-id A) persiste el huésped con organizationId de A y GET /guests lo lista", async () => {
    const created = await call("POST", "/guests", reception, { propertyId: A.propertyA, payload: { firstName: "Lucía", surname1: `L2 ${RUN}`, email: `lucia.${RUN}@example.com` } });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    guestId = created.body.id;
    const row = await prisma.guest.findUnique({ where: { id: guestId } });
    assert.ok(row, "el huésped existe en Prisma");
    assert.equal(row.organizationId, A.organizationId);

    const list = await call("GET", `/guests?search=${encodeURIComponent(RUN)}`, reception, { propertyId: A.propertyA });
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(list.body.some((item: { id: string }) => item.id === guestId));
    const detail = await call("GET", `/guests/${guestId}`, owner, { propertyId: A.propertyA });
    assert.equal(detail.status, 200, detail.raw.slice(0, 300));
    assert.equal(detail.body.guest?.id ?? detail.body.id, guestId, detail.raw.slice(0, 200));
  });

  it("(2) 403 sin clave: sistemas (plantilla admin) no lee huéspedes (guests.read) y contabilidad no los crea (guests.manage)", async () => {
    expect403(await call("GET", "/guests", systems, { propertyId: A.propertyA }), "guests.read");
    expect403(await call("POST", "/guests", accountant, { propertyId: A.propertyA, payload: { firstName: "Intruso" } }), "guests.manage");
  });

  it("(3) 404 opaco: recepción de A con x-property-id B; organización B sobre el huésped de A por id y sin verlo en la lista", async () => {
    expect404(await call("GET", "/guests", reception, { propertyId: A.propertyB }));
    expect404(await call("GET", `/guests/${guestId}`, ownerB, { propertyId: B.propertyA }), "Huésped no encontrado.");
    expect404(await call("PATCH", `/guests/${guestId}`, receptionB, { propertyId: B.propertyA, payload: { firstName: "Cambiado" } }), "Huésped no encontrado.");
    const listB = await call("GET", `/guests?search=${encodeURIComponent(RUN)}`, ownerB, { propertyId: B.propertyA });
    assert.equal(listB.status, 200);
    assert.equal(listB.body.length, 0, "la organización B no ve los huéspedes de A");
    assert.equal((await prisma.guest.findUnique({ where: { id: guestId } }))?.firstName, "Lucía");
  });
});

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

describe("L2-08 · messaging: conversaciones y mensajes con ámbito", () => {
  let conversationId = "";

  it("(1) GET /properties/:id/conversations lista la conversación de A y POST /conversations/:id/messages persiste el mensaje", async () => {
    const conversation = await prisma.conversation.create({ data: { propertyId: A.propertyA, channel: "whatsapp", status: "open" }, select: { id: true } });
    conversationId = conversation.id;
    const list = await call("GET", `/properties/${A.propertyA}/conversations`, reception);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(list.body.some((item: { id: string }) => item.id === conversationId));

    const sent = await call("POST", `/conversations/${conversationId}/messages`, reception, { payload: { body: `Bienvenida ${RUN}`, senderType: "staff", language: "es" } });
    assert.equal(sent.status, 200, sent.raw.slice(0, 300));
    const row = await prisma.message.findUnique({ where: { id: sent.body.id } });
    assert.ok(row, "el mensaje existe en Prisma");
    assert.equal(row.conversationId, conversationId);
    assert.equal(row.senderType, "staff");

    const messages = await call("GET", `/conversations/${conversationId}/messages`, reception);
    assert.equal(messages.status, 200, messages.raw.slice(0, 300));
    assert.ok(messages.body.some((item: { id: string }) => item.id === sent.body.id));
  });

  it("(2) 403 sin clave: la plantilla auditor (sin ai.tool.execute) no lee conversaciones ni envía mensajes", async () => {
    expect403(await call("GET", `/properties/${A.propertyA}/conversations`, auditor), "ai.tool.execute");
    expect403(await call("POST", `/conversations/${conversationId}/messages`, auditor, { payload: { body: "Intruso" } }), "ai.tool.execute");
    assert.equal(await prisma.message.count({ where: { conversationId } }), 1);
  });

  it("(3) 404 opaco: recepción de A sobre B, organización B sobre A y sobre la conversación de A por id", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/conversations`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/conversations`, ownerB));
    expect404(await call("POST", `/conversations/${conversationId}/messages`, receptionB, { payload: { body: "Intruso" } }), "Conversación no encontrada.");
    expect404(await call("GET", `/conversations/${conversationId}/messages`, receptionB), "Conversación no encontrada.");
    assert.equal(await prisma.message.count({ where: { conversationId } }), 1, "la organización B no escribe");
  });
});

// ---------------------------------------------------------------------------
// guest-portal (rutas públicas: el token del huésped es la autenticación)
// ---------------------------------------------------------------------------

describe("L2-08 · guest-portal: inicio de sesión público con ámbito de propiedad", () => {
  const reservationCode = `GP-${RUN}`;
  const bookerEmail = `huesped.${RUN}@example.com`;
  let token = "";

  it("(1) POST /guest-portal/sign-in con (código, email, propertyId A) crea la sesión en A y GET /guest-portal/reservation la devuelve", async () => {
    await prisma.reservation.create({
      data: { propertyId: A.propertyA, code: reservationCode, channel: "direct", status: "confirmed", arrivalDate: new Date("2026-10-02T00:00:00.000Z"), departureDate: new Date("2026-10-04T00:00:00.000Z"), roomTypeId: A.roomTypeA, bookerName: "Huésped L2", bookerEmail }
    });
    const signIn = await call("POST", "/guest-portal/sign-in", null, { payload: { reservationCode, email: bookerEmail, propertyId: A.propertyA } });
    assert.equal(signIn.status, 200, signIn.raw.slice(0, 300));
    assert.equal(signIn.body.ok, true);
    assert.equal(typeof signIn.body.token, "string", "sin proveedor de email el token viaja en la respuesta");
    token = signIn.body.token;
    const sessions = await prisma.guestPortalSession.findMany({ where: { reservationId: signIn.body.reservationId } });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.propertyId, A.propertyA);

    const view = await call("GET", `/guest-portal/reservation?token=${token}`, null);
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    assert.equal(view.body.reservationCode, reservationCode);
  });

  it("(2) 4xx tipado: token inválido → 401 en la reserva y en el folio; sin credenciales el inicio de sesión responde ok:false sin revelar nada", async () => {
    const view = await call("GET", "/guest-portal/reservation?token=tok_l2_invalido", null);
    assert.equal(view.status, 401, view.raw.slice(0, 300));
    assert.ok(typeof view.body.message === "string" && view.body.message.length > 0);
    // Sin token de personal ni token de huésped válido la ruta responde 401 tipado
    // (el fallback demo está apagado en STRICT_ENV; con sesión de huésped inválida
    // el handler contesta «Sesión del portal del huésped no válida o caducada.»).
    const folio = await call("GET", "/guest-portal/session/tok_l2_invalido/folio", null);
    assert.equal(folio.status, 401, folio.raw.slice(0, 300));
    assert.match(String(folio.body.message), /Sesión del portal del huésped no válida o caducada\.|Authentication required\./);
    const folioAsStaff = await call("GET", "/guest-portal/session/tok_l2_invalido/folio", reception);
    assert.equal(folioAsStaff.status, 401, folioAsStaff.raw.slice(0, 300));
    assert.equal(folioAsStaff.body.message, "Sesión del portal del huésped no válida o caducada.");
    const empty = await call("POST", "/guest-portal/sign-in", null, { payload: { reservationCode: "", email: "", propertyId: A.propertyA } });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { ok: false });
  });

  it("(3) propiedad ajena: el código de A con propertyId B (o sin propertyId) no abre sesión y no crea filas en B", async () => {
    const foreign = await call("POST", "/guest-portal/sign-in", null, { payload: { reservationCode, email: bookerEmail, propertyId: A.propertyB } });
    assert.equal(foreign.status, 200, foreign.raw.slice(0, 300));
    assert.deepEqual(foreign.body, { ok: false }, "misma respuesta que un código desconocido (anti-enumeración)");
    const noProperty = await call("POST", "/guest-portal/sign-in", null, { payload: { reservationCode, email: bookerEmail } });
    assert.deepEqual(noProperty.body, { ok: false });
    assert.equal(await prisma.guestPortalSession.count({ where: { propertyId: A.propertyB } }), 0);
    assert.equal(await prisma.guestPortalSession.count({ where: { propertyId: A.propertyA } }), 1, "solo la sesión legítima");
  });
});

// ---------------------------------------------------------------------------
// marketplace
// ---------------------------------------------------------------------------

describe("L2-08 · marketplace: catálogo e instalaciones con ámbito", () => {
  it("(1) GET /marketplace/listings y GET /marketplace/installations responden `items` a un usuario autenticado; las instalaciones se filtran por organización", async () => {
    const listings = await call("GET", "/marketplace/listings", owner);
    assert.equal(listings.status, 200, listings.raw.slice(0, 300));
    assert.ok(Array.isArray(listings.body.items));
    const installations = await call("GET", `/marketplace/installations?propertyId=${A.propertyA}`, owner);
    assert.equal(installations.status, 200, installations.raw.slice(0, 300));
    assert.deepEqual(installations.body.items, [], "la organización recién creada no tiene instalaciones");
    assert.equal(await prisma.appInstallation.count({ where: { organizationId: A.organizationId } }), 0);
  });

  it("(2) 403 sin clave: recepción y owner no publican listados (developer.manage_webhooks)", async () => {
    const payload = { appId: `app_l2_${RUN}`, category: "operations", tagline: "X", description: "X" };
    expect403(await call("POST", "/marketplace/listings", reception, { payload }), "developer.manage_webhooks");
    expect403(await call("POST", "/marketplace/listings", owner, { payload }), "developer.manage_webhooks");
    assert.equal(await prisma.marketplaceListing.count({ where: { appId: payload.appId } }), 0);
  });

  it("(3) 404 opaco: instalar con propertyId ajeno (recepción de A → B; organización B → A) y listado inexistente", async () => {
    expect404(await call("POST", `/marketplace/listings/app_l2_missing_${RUN}/install`, reception, { payload: { propertyId: A.propertyB, grantedScopes: [] } }));
    expect404(await call("POST", `/marketplace/listings/app_l2_missing_${RUN}/install`, ownerB, { payload: { propertyId: A.propertyA, grantedScopes: [] } }));
    expect404(await call("GET", `/marketplace/installations?propertyId=${A.propertyA}`, ownerB));
    const missing = await call("GET", `/marketplace/listings/app_l2_missing_${RUN}`, owner);
    assert.equal(missing.status, 404, missing.raw.slice(0, 300));
    assert.equal(await prisma.appInstallation.count({ where: { organizationId: { in: [A.organizationId, B.organizationId] } } }), 0);
  });
});

// ---------------------------------------------------------------------------
// webhooks
// ---------------------------------------------------------------------------

describe("L2-08 · webhooks: suscripciones con ámbito", () => {
  let subscriptionId = "";

  it("(1) POST /webhooks/subscriptions (sistemas, developer.manage_webhooks) persiste la suscripción en A; event-types, GET, PATCH, test y DELETE", async () => {
    const eventTypes = await call("GET", "/webhooks/event-types", owner);
    assert.equal(eventTypes.status, 200, eventTypes.raw.slice(0, 300));
    assert.ok(eventTypes.body.items.includes("reservation.created"));

    const created = await call("POST", "/webhooks/subscriptions", systems, { payload: { propertyId: A.propertyA, eventTypes: ["reservation.created"], targetUrl: "http://127.0.0.1:9/hook-l2" } });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    subscriptionId = created.body.id;
    assert.equal(typeof created.body.secret, "string", "el secreto viaja UNA vez, al crear");
    const row = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
    assert.equal(row?.propertyId, A.propertyA);
    assert.deepEqual(row?.eventTypes, ["reservation.created"]);

    const list = await call("GET", `/webhooks/subscriptions?propertyId=${A.propertyA}`, systems);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    const listed = list.body.items.find((item: { id: string }) => item.id === subscriptionId);
    assert.ok(listed, "la suscripción aparece en la lista de A");
    assert.equal(listed.secret, undefined, "la lista nunca devuelve el secreto en claro");
    assert.match(String(listed.secretMasked), /^whsec_…/);

    const patched = await call("PATCH", `/webhooks/subscriptions/${subscriptionId}`, systems, { payload: { active: false } });
    assert.equal(patched.status, 200, patched.raw.slice(0, 300));
    assert.equal((await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } }))?.active, false);

    const tested = await call("POST", `/webhooks/subscriptions/${subscriptionId}/test`, systems, { payload: {} });
    assert.equal(tested.status, 200, tested.raw.slice(0, 300));
    assert.equal(tested.body.delivered, false, "el puerto 9 de loopback no escucha: entrega fallida, sin 500");
  });

  it("(2) 403 sin clave: recepción no lista ni crea suscripciones y el owner tampoco (developer.manage_webhooks)", async () => {
    expect403(await call("GET", "/webhooks/subscriptions", reception), "developer.manage_webhooks");
    expect403(await call("POST", "/webhooks/subscriptions", owner, { payload: { propertyId: A.propertyA, eventTypes: ["guest.created"], targetUrl: "https://example.invalid/x" } }), "developer.manage_webhooks");
    expect403(await call("DELETE", `/webhooks/subscriptions/${subscriptionId}`, reception), "developer.manage_webhooks");
    assert.equal(await prisma.webhookSubscription.count({ where: { id: subscriptionId } }), 1);
  });

  it("(3) 404 opaco: sistemas de B sobre la suscripción de A (PATCH, test, DELETE) y recepción de A con propertyId B; después sistemas de A la borra", async () => {
    expect404(await call("PATCH", `/webhooks/subscriptions/${subscriptionId}`, systemsB, { payload: { active: true } }), "Suscripción de webhook no encontrada.");
    expect404(await call("POST", `/webhooks/subscriptions/${subscriptionId}/test`, systemsB, { payload: {} }), "Suscripción de webhook no encontrada.");
    expect404(await call("DELETE", `/webhooks/subscriptions/${subscriptionId}`, systemsB), "Suscripción de webhook no encontrada.");
    expect404(await call("GET", `/webhooks/subscriptions?propertyId=${A.propertyB}`, reception));
    assert.equal((await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } }))?.active, false, "B no modifica ni borra");

    const deleted = await call("DELETE", `/webhooks/subscriptions/${subscriptionId}`, systems);
    assert.equal(deleted.status, 200, deleted.raw.slice(0, 300));
    assert.equal(await prisma.webhookSubscription.count({ where: { id: subscriptionId } }), 0);
  });
});

// ---------------------------------------------------------------------------
// advanced (humo de lectura del motor genérico; detalle en l2-motor-generico.test.mts)
// ---------------------------------------------------------------------------

describe("L2-08 · advanced: humo de lectura del motor genérico con ámbito", () => {
  it("(1) GET /workforce/properties/:id/schedule y GET /crm/segments responden `items` (paginación con total) con los módulos activados en A", async () => {
    const schedule = await call("GET", `/workforce/properties/${A.propertyA}/schedule`, owner);
    assert.equal(schedule.status, 200, schedule.raw.slice(0, 300));
    assert.ok(Array.isArray(schedule.body.items));
    assert.equal(typeof schedule.body.total, "number");
    assert.equal(schedule.body.propertyId, A.propertyA);
    const segments = await call("GET", "/crm/segments", owner, { propertyId: A.propertyA });
    assert.equal(segments.status, 200, segments.raw.slice(0, 300));
    assert.ok(Array.isArray(segments.body.items));
    assert.equal(segments.body.propertyId, A.propertyA);
  });

  it("(2) 403 sin clave: recepción no lee el cuadrante (workforce.read) y sistemas no lee segmentos (crm.read)", async () => {
    expect403(await call("GET", `/workforce/properties/${A.propertyA}/schedule`, reception), "workforce.read");
    expect403(await call("GET", "/crm/segments", systems, { propertyId: A.propertyA }), "crm.read");
  });

  it("(3) 404 opaco: recepción de A sobre B y organización B sobre A (parámetro y cabecera)", async () => {
    expect404(await call("GET", `/workforce/properties/${A.propertyB}/schedule`, reception));
    expect404(await call("GET", `/workforce/properties/${A.propertyA}/schedule`, ownerB));
    expect404(await call("GET", "/crm/segments", ownerB, { propertyId: A.propertyA }));
  });
});
