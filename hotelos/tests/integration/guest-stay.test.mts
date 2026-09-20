/**
 * Tanda L7 · lote L7-02 «API del huésped: estancia, folio, facturas, peticiones
 * de salida, pago honesto» (scratchpad/L7/recon-delta.md §19.1-19.6) —
 * integración sobre Postgres real con una organización AISLADA
 * (helpers/l2-tenant.mts, como guest-portal.test.mts) y STRICT_ENV (auth real,
 * RBAC_STRICT=true).
 *
 * Qué fija:
 *   · GET /guest-portal/stay con x-guest-token → 200 GuestStayView: etapa por
 *     fecha local, reserva (solo titular: nombre + inicial; nunca el acompañante),
 *     folio REAL (balance_due 200,00), facturas emitidas de la reserva, datos del
 *     hotel desde PropertyAiSetting.configurationJson.faq + dirección, peticiones,
 *     encuesta; sin token o token inválido → 401 GUEST_SESSION_INVALID;
 *   · GET /guest-portal/invoices/:id/pdf → application/pdf de la factura PROPIA
 *     (cabecera o ?token= en GET); factura de otra reserva, borrador o id
 *     desconocido → 404; sin token → 401;
 *   · POST /guest-portal/stay/requests → 201 { id, ticketNumber SRQ-<8>, kind,
 *     status open }; fila service_requests (requestType = kind, front_office) y
 *     aparece en GET /reservations/:id/activity (personal) con copy en español;
 *     400 VALIDATION_ERROR (kind desconocido, clave extra, hora inválida); 409
 *     STAY_CLOSED con la reserva cancelada;
 *   · POST /guest-portal/stay/payment-link sin PSP → 200 at_reception y CERO
 *     pagos ni intents escritos;
 *   · legado 19.6: GET /guest-portal/session/:token (personal) verifica el token:
 *     401 si no vale, { token: "[redacted]", status, reservationId } si vale;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/guest-stay.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST";
type Reply = { status: number; body: any; raw: string; headers: Record<string, unknown>; rawPayload: Buffer };

const RUN = `gs${newRunId()}`;
const ARRIVAL = "2026-10-02";
const DEPARTURE = "2026-10-04";

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let reception: Session;

const reservationCode = `L7-GS-${RUN}`;
const bookerEmail = `titular.${RUN}@l7.test`;
let reservationId = "";
let primaryGuestId = "";
let folioId = "";
let ownInvoiceId = "";
let draftInvoiceId = "";
let foreignInvoiceId = "";
let token = "";
/** Reserva con folio principal SIN líneas (corrector L7-REV-03) y su sesión. */
let emptyReservationId = "";
let emptyToken = "";
const emptyCode = `L7-GS-E-${RUN}`;

async function call(method: Method, url: string, options: { payload?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: options.headers ?? {},
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body, headers: res.headers as Record<string, unknown>, rawPayload: res.rawPayload };
}

async function createInvoice(input: { id: string; propertyId: string; reservationId: string; number: string | null; status: "issued" | "draft" }): Promise<string> {
  const invoice = await prisma.invoice.create({
    data: {
      id: input.id,
      propertyId: input.propertyId,
      legalEntityId: A.legalEntityId,
      reservationId: input.reservationId,
      invoiceNumber: input.number,
      invoiceType: "F1",
      customerType: "individual",
      customerName: "Titular de prueba",
      status: input.status,
      issuedAt: input.status === "issued" ? new Date("2026-09-19T10:00:00.000Z") : null,
      seriesCode: input.status === "issued" ? "FAC" : null,
      total: "110.00",
      taxTotal: "10.00",
      currencyCode: "EUR"
    },
    select: { id: true }
  });
  await prisma.invoiceLine.create({
    data: { invoiceId: invoice.id, description: "Alojamiento · 1 noche", quantity: 1, unitPrice: "100.00", taxCode: "ES_IVA_10", taxRate: "10.00", total: "110.00", taxCategory: "accommodation", taxCalificacion: "S1", taxFigure: "IVA" }
  });
  return invoice.id;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  app = await buildApiServer();
  await app.ready();
  reception = await loginOrThrow(app, A.users.receptionist.email, A.password);

  // Titular (con apellido) + acompañante (cuyos datos NUNCA deben salir por el portal).
  const primary = await prisma.guest.create({
    data: { id: `guest_${RUN}_titular`, organizationId: A.organizationId, firstName: "Ana", surname1: "Gamma", email: bookerEmail, nationality: "ES" },
    select: { id: true }
  });
  const companion = await prisma.guest.create({
    data: { id: `guest_${RUN}_acomp`, organizationId: A.organizationId, firstName: "Luis", surname1: "Delta", email: `acomp.${RUN}@l7.test`, nationality: "ES" },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: reservationCode,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`),
      adults: 2,
      roomTypeId: A.roomTypeA,
      assignedRoomId: A.roomsA[0]!,
      totalAmount: "200.00",
      currency: "EUR",
      bookerName: "Ana Gamma",
      bookerEmail
    },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: primaryGuestId, isPrimary: true } });
  await prisma.reservationGuest.create({ data: { reservationId, guestId: companion.id, isPrimary: false } });

  // Folio con saldo (200,00): enlace de pago sin PSP → at_reception.
  const folio = await prisma.folio.create({ data: { reservationId, guestId: primaryGuestId, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } });
  folioId = folio.id;
  await prisma.folioLine.create({ data: { folioId, type: "room", description: "Alojamiento DBL · 2 noches", quantity: 2, unitPrice: "100.00", taxCode: "ES_IVA_10", taxCategory: "accommodation", total: "200.00", postedBy: `test-${RUN}` } });

  // Datos del hotel: FAQ del bot (PropertyAiSetting) + dirección postal de la propiedad.
  await prisma.propertyAiSetting.create({
    data: { propertyId: A.propertyA, configurationJson: { faq: { wifiName: `Wifi-${RUN}`, wifiPassword: "verano2026", breakfastHours: "07:30-10:30", checkOutTime: "12:00", receptionPhone: "+34 981 000 000" } } }
  });
  await prisma.property.update({ where: { id: A.propertyA }, data: { address: "Calle Real 1", postalCode: "15001", municipality: "A Coruña", province: "A Coruña" } });

  // Facturas: una emitida de la reserva (descargable), un borrador (no) y una de otra reserva en B (404).
  ownInvoiceId = await createInvoice({ id: `inv_${RUN}_own`, propertyId: A.propertyA, reservationId, number: `FAC-L7-${RUN}`, status: "issued" });
  draftInvoiceId = await createInvoice({ id: `inv_${RUN}_draft`, propertyId: A.propertyA, reservationId, number: null, status: "draft" });
  const foreign = await prisma.reservation.create({
    data: { propertyId: A.propertyB, code: `L7-GS-B-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`), departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`), adults: 1, roomTypeId: A.roomTypeB, totalAmount: "100.00", currency: "EUR" },
    select: { id: true }
  });
  foreignInvoiceId = await createInvoice({ id: `inv_${RUN}_foreign`, propertyId: A.propertyB, reservationId: foreign.id, number: `FAC-L7B-${RUN}`, status: "issued" });

  // Reserva alojada con folio principal vacío (el alojamiento se carga en el cierre del día).
  const empty = await prisma.reservation.create({
    data: { propertyId: A.propertyA, code: emptyCode, channel: "direct", status: "checked_in", arrivalDate: new Date("2026-09-19T00:00:00.000Z"), departureDate: new Date("2026-09-22T00:00:00.000Z"), adults: 1, roomTypeId: A.roomTypeA, assignedRoomId: A.roomsA[1]!, totalAmount: "0.00", currency: "EUR", bookerName: "Ana Gamma", bookerEmail },
    select: { id: true }
  });
  emptyReservationId = empty.id;
  await prisma.reservationGuest.create({ data: { reservationId: emptyReservationId, guestId: primaryGuestId, isPrimary: true } });
  await prisma.folio.create({ data: { reservationId: emptyReservationId, guestId: primaryGuestId, status: "open", currency: "EUR", label: "guest", isPrimary: true } });
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("L7-02 · sesión del portal", () => {
  it("POST /guest-portal/sign-in con propertyId → token; GET /guest-portal/stay sin token o con token inválido → 401 GUEST_SESSION_INVALID", async () => {
    const signIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode, email: bookerEmail, propertyId: A.propertyA } });
    assert.equal(signIn.status, 200, signIn.raw.slice(0, 300));
    assert.equal(signIn.body.ok, true);
    assert.equal(typeof signIn.body.token, "string");
    token = signIn.body.token;

    const noToken = await call("GET", "/guest-portal/stay");
    assert.equal(noToken.status, 401, noToken.raw.slice(0, 300));
    assert.equal(noToken.body.details?.code, "GUEST_SESSION_INVALID");
    const bad = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": `tok_${RUN}_invalido` } });
    assert.equal(bad.status, 401, bad.raw.slice(0, 300));
    assert.equal(bad.body.details?.code, "GUEST_SESSION_INVALID");
    assert.match(String(bad.body.message), /Sesión del portal/);
  });
});

describe("L7-02 · GET /guest-portal/stay", () => {
  it("200 GuestStayView: etapa pre_arrival, reserva sin PII de acompañantes, folio real, factura emitida, info desde la FAQ, sin peticiones ni encuesta", async () => {
    const view = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": token } });
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    const body = view.body;
    assert.equal(body.stage, "pre_arrival", `hoy ${body.today} < ${ARRIVAL}`);
    assert.match(String(body.today), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.reservation.reservationId, reservationId);
    assert.equal(body.reservation.reservationCode, reservationCode);
    assert.equal(body.reservation.propertyId, A.propertyA);
    assert.equal(body.reservation.propertyTimezone, "Europe/Madrid");
    assert.deepEqual(body.reservation.primaryGuest, { firstName: "Ana", surname1Initial: "G." });
    assert.equal(body.reservation.guestCount, 2);
    assert.equal(body.checkIn, null, "sin sesión de check-in");
    assert.equal(body.folio.status, "balance_due");
    assert.equal(body.folio.balanceDue, 200);
    assert.equal(body.folio.currency, "EUR");
    assert.equal(body.folio.charges.length, 1);
    assert.equal(body.folio.charges[0].total, 200);
    assert.deepEqual(body.folio.payments, []);
    assert.equal(body.invoices.length, 1, "solo la factura emitida (el borrador no)");
    assert.equal(body.invoices[0].id, ownInvoiceId);
    assert.equal(body.invoices[0].number, `FAC-L7-${RUN}`);
    assert.equal(body.invoices[0].total, 110);
    assert.equal(body.invoices[0].currency, "EUR");
    assert.deepEqual(body.info, { wifiName: `Wifi-${RUN}`, wifiPassword: "verano2026", breakfastHours: "07:30-10:30", checkOutTime: "12:00", receptionPhone: "+34 981 000 000", address: "Calle Real 1, 15001 A Coruña, A Coruña" });
    assert.deepEqual(body.requests, []);
    assert.deepEqual(body.survey, { invited: false, answered: false });
    assert.doesNotMatch(view.raw, /Gamma|Luis|Delta|acomp\./, "sin PII del acompañante ni apellido completo del titular");
    for (const key of ["guestId", "bookerEmail", "assignedRoomId", "tokenHash"]) assert.equal(view.raw.includes(`"${key}"`), false, `${key} no se expone`);
  });

  it("alojada → in_house con checkIn { status, keyIssued } (sesión de check-in y llave activa de la reserva)", async () => {
    await prisma.reservation.update({ where: { id: reservationId }, data: { status: "checked_in" } });
    const checkIn = await prisma.checkInSession.create({
      data: { organizationId: A.organizationId, propertyId: A.propertyA, reservationId, status: "checked_in", channel: "email" },
      select: { id: true }
    });
    const key = await prisma.guestPortalAction.create({
      data: { id: `mkey_${RUN}`, propertyId: A.propertyA, reservationId, guestId: primaryGuestId, actionType: "mobile_key", status: "active", payloadJson: { serialNumber: RUN } },
      select: { id: true }
    });
    try {
      const view = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": token } });
      assert.equal(view.status, 200, view.raw.slice(0, 300));
      assert.equal(view.body.stage, "in_house");
      assert.deepEqual(view.body.checkIn, { status: "checked_in", keyIssued: true });
    } finally {
      await prisma.guestPortalAction.delete({ where: { id: key.id } });
      await prisma.checkInSession.delete({ where: { id: checkIn.id } });
      await prisma.reservation.update({ where: { id: reservationId }, data: { status: "confirmed" } });
    }
  });
});

describe("L7-02 · GET /guest-portal/invoices/:id/pdf", () => {
  it("factura propia → application/pdf (cabecera x-guest-token y ?token= en GET); Content-Disposition inline / attachment", async () => {
    const pdf = await call("GET", `/guest-portal/invoices/${ownInvoiceId}/pdf`, { headers: { "x-guest-token": token } });
    assert.equal(pdf.status, 200, pdf.raw.slice(0, 300));
    assert.match(String(pdf.headers["content-type"]), /^application\/pdf/);
    assert.match(String(pdf.headers["content-disposition"]), /^inline; filename="FAC-L7-/);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(Number(pdf.headers["content-length"]), pdf.rawPayload.length);

    const byQuery = await call("GET", `/guest-portal/invoices/${ownInvoiceId}/pdf?token=${encodeURIComponent(token)}&download=1`);
    assert.equal(byQuery.status, 200, byQuery.raw.slice(0, 300));
    assert.match(String(byQuery.headers["content-disposition"]), /^attachment; /);
    assert.equal(byQuery.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("factura de otra reserva, borrador de la propia o id desconocido → 404 opaco; sin token → 401", async () => {
    for (const id of [foreignInvoiceId, draftInvoiceId, `inv_${RUN}_nope`]) {
      const res = await call("GET", `/guest-portal/invoices/${id}/pdf`, { headers: { "x-guest-token": token } });
      assert.equal(res.status, 404, `${id}: ${res.raw.slice(0, 200)}`);
      assert.match(String(res.body?.message), /Factura no encontrada/);
    }
    const noToken = await call("GET", `/guest-portal/invoices/${ownInvoiceId}/pdf`);
    assert.equal(noToken.status, 401, noToken.raw.slice(0, 300));
  });
});

describe("L7-02 · POST /guest-portal/stay/requests", () => {
  it("201 { id, ticketNumber SRQ-<8>, kind, status open }; fila service_requests front_office y en GET /reservations/:id/activity (personal, copy en español); luego aparece en la vista", async () => {
    const res = await call("POST", "/guest-portal/stay/requests", { headers: { "x-guest-token": token }, payload: { kind: "late_checkout", note: "Vuelo a las 18:00", preferredTime: "14:00" } });
    assert.equal(res.status, 201, res.raw.slice(0, 300));
    assert.equal(res.body.kind, "late_checkout");
    assert.equal(res.body.status, "open");
    assert.match(String(res.body.ticketNumber), /^SRQ-[A-Z0-9]{8}$/);
    const row = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.reservationId, reservationId);
    assert.equal(row.guestId, primaryGuestId);
    assert.equal(row.requestType, "late_checkout");
    assert.equal(row.status, "open");
    assert.equal(row.assignedDepartment, "front_office");

    const activity = await call("GET", `/reservations/${reservationId}/activity`, { headers: reception.headers });
    assert.equal(activity.status, 200, activity.raw.slice(0, 300));
    const item = (activity.body.items as Array<{ id: string; kind: string; title: string; department: string; open: boolean }>).find((entry) => entry.id === res.body.id);
    assert.ok(item, "la petición aparece en el feed de recepción");
    assert.equal(item!.kind, "service_request");
    assert.equal(item!.title, "Salida tardía");
    assert.equal(item!.department, "Recepción");
    assert.equal(item!.open, true);
    assert.equal(activity.body.counts.serviceRequests, 1);

    const view = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": token } });
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.requests.map((entry: { id: string; kind: string; status: string }) => [entry.id, entry.kind, entry.status]), [[res.body.id, "late_checkout", "open"]]);
  });

  it("400 VALIDATION_ERROR: kind desconocido, clave extra, hora que no es HH:MM, nota > 500; sin token → 401 y nada escrito", async () => {
    const before = await prisma.serviceRequest.count({ where: { reservationId } });
    for (const payload of [{ kind: "spa" }, { kind: "luggage", extra: 1 }, { kind: "luggage", preferredTime: "25:00" }, { kind: "luggage", note: "x".repeat(501) }, {}]) {
      const res = await call("POST", "/guest-portal/stay/requests", { headers: { "x-guest-token": token }, payload });
      assert.equal(res.status, 400, `${JSON.stringify(payload).slice(0, 60)}: ${res.raw.slice(0, 200)}`);
      assert.equal(res.body.details?.code, "VALIDATION_ERROR");
    }
    const noToken = await call("POST", "/guest-portal/stay/requests", { payload: { kind: "luggage" } });
    assert.equal(noToken.status, 401, noToken.raw.slice(0, 300));
    const byQuery = await call("POST", `/guest-portal/stay/requests?token=${encodeURIComponent(token)}`, { payload: { kind: "luggage" } });
    assert.equal(byQuery.status, 401, "las escrituras no admiten el token en la query");
    assert.equal(await prisma.serviceRequest.count({ where: { reservationId } }), before, "nada nuevo escrito");
  });

  it("reserva cancelada → 409 STAY_CLOSED sin escribir (también la ruta clásica /service-request, corrector REV-L7-05); la vista responde stage cancelled", async () => {
    await prisma.reservation.update({ where: { id: reservationId }, data: { status: "cancelled" } });
    try {
      const before = await prisma.serviceRequest.count({ where: { reservationId } });
      const res = await call("POST", "/guest-portal/stay/requests", { headers: { "x-guest-token": token }, payload: { kind: "express_checkout" } });
      assert.equal(res.status, 409, res.raw.slice(0, 300));
      assert.equal(res.body.details?.code, "STAY_CLOSED");
      const classic = await call("POST", "/guest-portal/service-request", { headers: { "x-guest-token": token }, payload: { category: "housekeeping", description: "toallas" } });
      assert.equal(classic.status, 409, classic.raw.slice(0, 300));
      assert.equal(classic.body.details?.code, "STAY_CLOSED");
      assert.equal(await prisma.serviceRequest.count({ where: { reservationId } }), before);
      const view = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": token } });
      assert.equal(view.body.stage, "cancelled");
    } finally {
      await prisma.reservation.update({ where: { id: reservationId }, data: { status: "confirmed" } });
    }
  });

  it("corrector L7-REV-02: antes de llegar la salida exprés → 409 STAY_REQUEST_NOT_ALLOWED { stage: pre_arrival, kind }; ya salida (checked_out) → express/late/luggage 409 STAY_CLOSED { status: checked_out } y solo invoice_email → 201", async () => {
    const before = await prisma.serviceRequest.count({ where: { reservationId } });
    const early = await call("POST", "/guest-portal/stay/requests", { headers: { "x-guest-token": token }, payload: { kind: "express_checkout" } });
    assert.equal(early.status, 409, early.raw.slice(0, 300));
    assert.equal(early.body.details?.code, "STAY_REQUEST_NOT_ALLOWED");
    assert.equal(early.body.details?.stage, "pre_arrival");
    assert.equal(early.body.details?.kind, "express_checkout");
    assert.deepEqual(early.body.details?.allowed, ["late_checkout", "luggage"]);
    await prisma.reservation.update({ where: { id: reservationId }, data: { status: "checked_out" } });
    try {
      for (const kind of ["express_checkout", "late_checkout", "luggage"]) {
        const res = await call("POST", "/guest-portal/stay/requests", { headers: { "x-guest-token": token }, payload: { kind } });
        assert.equal(res.status, 409, `${kind}: ${res.raw.slice(0, 300)}`);
        assert.equal(res.body.details?.code, "STAY_CLOSED");
        assert.equal(res.body.details?.status, "checked_out");
        assert.equal(res.body.details?.kind, kind);
      }
      assert.equal(await prisma.serviceRequest.count({ where: { reservationId } }), before, "nada escrito");
      const invoice = await call("POST", "/guest-portal/stay/requests", { headers: { "x-guest-token": token }, payload: { kind: "invoice_email" } });
      assert.equal(invoice.status, 201, invoice.raw.slice(0, 300));
      assert.equal(invoice.body.kind, "invoice_email");
      assert.equal(await prisma.serviceRequest.count({ where: { reservationId } }), before + 1);
    } finally {
      await prisma.reservation.update({ where: { id: reservationId }, data: { status: "confirmed" } });
    }
  });
});

describe("L7-02 · POST /guest-portal/stay/payment-link (honesto)", () => {
  it("sin PSP → 200 { status: at_reception, reason: PSP_NOT_CONFIGURED }; ni pagos ni intents escritos; el saldo sigue en 200,00", async () => {
    const res = await call("POST", "/guest-portal/stay/payment-link", { headers: { "x-guest-token": token }, payload: {} });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.equal(res.body.status, "at_reception");
    assert.equal(res.body.paymentStatus, "at_reception");
    assert.equal(res.body.reason, "PSP_NOT_CONFIGURED");
    assert.equal(res.body.details?.code, "PSP_NOT_CONFIGURED");
    assert.equal(await prisma.payment.count({ where: { folioId } }), 0, "nunca se registra un pago");
    assert.equal(await prisma.paymentIntent.count({ where: { folioId } }), 0, "sin PSP no hay intent");
    const view = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": token } });
    assert.equal(view.body.folio.balanceDue, 200);
    assert.equal(view.body.folio.status, "balance_due");
  });

  it("cuerpo con clave desconocida → 400; returnUrl javascript:/data: → 400 (corrector REV-L7-08); sin token → 401", async () => {
    const bad = await call("POST", "/guest-portal/stay/payment-link", { headers: { "x-guest-token": token }, payload: { amount: 1 } });
    assert.equal(bad.status, 400, bad.raw.slice(0, 300));
    assert.equal(bad.body.details?.code, "VALIDATION_ERROR");
    for (const returnUrl of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4="]) {
      const evil = await call("POST", "/guest-portal/stay/payment-link", { headers: { "x-guest-token": token }, payload: { returnUrl } });
      assert.equal(evil.status, 400, `${returnUrl}: ${evil.raw.slice(0, 300)}`);
      assert.equal(evil.body.details?.code, "VALIDATION_ERROR");
    }
    const noToken = await call("POST", "/guest-portal/stay/payment-link", { payload: {} });
    assert.equal(noToken.status, 401, noToken.raw.slice(0, 300));
  });

  it("corrector L7-REV-03: folio principal SIN líneas → { status: no_charges, paymentStatus: none } (nunca «pagado»); la vista lo muestra como settled con 0 cargos", async () => {
    const signIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode: emptyCode, email: bookerEmail, propertyId: A.propertyA } });
    assert.equal(signIn.status, 200, signIn.raw.slice(0, 300));
    emptyToken = signIn.body.token as string;
    const view = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": emptyToken } });
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    assert.equal(view.body.folio.charges.length, 0);
    const res = await call("POST", "/guest-portal/stay/payment-link", { headers: { "x-guest-token": emptyToken }, payload: {} });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.deepEqual(res.body, { status: "no_charges", paymentStatus: "none" });
    assert.equal(await prisma.payment.count({ where: { folio: { reservationId: emptyReservationId } } }), 0);
  });
});

describe("corrector L7-REV-09 · `?token=` solo en el PDF de la factura", () => {
  it("GET /guest-portal/stay?token= y GET /guest-portal/survey?token= → 401 (el token solo viaja en la cabecera); el PDF sigue admitiéndolo", async () => {
    const stay = await call("GET", `/guest-portal/stay?token=${encodeURIComponent(token)}`);
    assert.equal(stay.status, 401, stay.raw.slice(0, 300));
    assert.equal(stay.body.details?.code, "GUEST_SESSION_INVALID");
    const survey = await call("GET", `/guest-portal/survey?token=${encodeURIComponent(token)}`);
    assert.equal(survey.status, 401, survey.raw.slice(0, 300));
    const pdf = await call("GET", `/guest-portal/invoices/${ownInvoiceId}/pdf?token=${encodeURIComponent(token)}`);
    assert.equal(pdf.status, 200, pdf.raw.slice(0, 100));
    assert.equal(String(pdf.headers["content-type"]).startsWith("application/pdf"), true);
  });
});

describe("L7-02 · legado verificado (19.6)", () => {
  it("GET /guest-portal/session/:token (sesión de personal): token inválido → 401; válido → { token: [redacted], status: active, reservationId }", async () => {
    const bad = await call("GET", `/guest-portal/session/tok_${RUN}_invalido`, { headers: reception.headers });
    assert.equal(bad.status, 401, bad.raw.slice(0, 300));
    assert.equal(bad.body.details?.code, "GUEST_SESSION_INVALID");
    const ok = await call("GET", `/guest-portal/session/${token}`, { headers: reception.headers });
    assert.equal(ok.status, 200, ok.raw.slice(0, 300));
    assert.deepEqual(ok.body, { token: "[redacted]", status: "active", reservationId });
    assert.equal(ok.raw.includes(token), false, "el token nunca vuelve en claro");
  });
});
