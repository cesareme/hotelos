// Unit tests · Tanda L7 · lote L7-02 — estancia y salida del portal del huésped
// (modules/guest-portal/guest-stay.service.ts) con dependencias inyectadas:
// etapa por fechas locales y estado, folio honesto, datos del hotel desde la
// FAQ (mismas claves que el bot), vista sin PII de acompañantes, peticiones de
// salida (ServiceRequest front_office + evento GuestCheckoutRequested, 409
// STAY_CLOSED). Sin base de datos ni red. Desde apps/api:
//   node --import tsx --test src/modules/guest-portal/__tests__/guest-stay.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, NotFoundError } from "../../../lib/http-error.js";
import type { ReservationFolioBalance } from "../../folio/folio.service.js";
import type { GuestReservationView } from "../guest-portal.service.js";
import type { VerifiedGuestSession } from "../guest-portal-auth.service.js";
import { GUEST_STAY_REQUEST_KINDS_BY_STAGE, GUEST_STAY_STAGES } from "@hotelos/shared";
import { HTTP_URL_PATTERN, StayPaymentLinkSchema } from "../guest-portal.routes.js";
import {
  STAY_REQUEST_DEPARTMENT,
  STAY_REQUEST_EVENT,
  allowedStayRequestKinds,
  createGuestStayPaymentLink,
  createGuestStayRequest,
  faqLookup,
  folioDtoFrom,
  formatPropertyAddress,
  getGuestStayView,
  localDateIn,
  stageOf,
  stayInfoFrom,
  ticketNumberFor,
  type GuestStayDeps
} from "../guest-stay.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de la estancia");
}) as typeof fetch;

const SESSION: VerifiedGuestSession = { reservationId: "res_l7", propertyId: "prop_l7", guestId: "guest_titular", purpose: "sign_in" };

const RESERVATION: GuestReservationView = {
  reservationId: "res_l7",
  reservationCode: "L7-0001",
  propertyId: "prop_l7",
  propertyName: "Hotel L7 (prueba)",
  propertyTimezone: "Europe/Madrid",
  status: "confirmed",
  arrivalDate: "2026-10-02",
  departureDate: "2026-10-04",
  roomType: "Doble",
  assignedRoomNumber: "101",
  eta: null,
  primaryGuest: { firstName: "Ana", surname1Initial: "G." },
  guestCount: 2,
  balanceDue: 200,
  currency: "EUR"
};

const FOLIO = {
  folio: { id: "folio_l7", currency: "EUR" },
  lines: [{ description: "Alojamiento DBL · 2 noches", quantity: 2, total: 200, postedAt: "2026-09-20T10:00:00.000Z" }],
  payments: [{ amount: 50, method: "card", methodCode: "card_present", status: "captured", createdAt: "2026-09-20T11:00:00.000Z" }],
  chargesTotal: 200,
  paymentsTotal: 50,
  refundsTotal: 0,
  balanceDue: 150,
  reservationBalanceDue: 150,
  folios: []
} as unknown as ReservationFolioBalance;

function fakeDeps(overrides: Partial<GuestStayDeps> = {}): { deps: Partial<GuestStayDeps>; state: { requests: Array<Record<string, unknown>>; events: Array<{ eventType: string; payload: Record<string, unknown>; entityType: string }> } } {
  const state = { requests: [] as Array<Record<string, unknown>>, events: [] as Array<{ eventType: string; payload: Record<string, unknown>; entityType: string }> };
  const deps: Partial<GuestStayDeps> = {
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    loadReservation: async () => RESERVATION,
    loadCheckIn: async () => null,
    loadKeyIssued: async () => false,
    loadFolio: async () => FOLIO,
    loadInvoices: async () => [{ id: "inv_1", number: "FAC-2026-000001", issuedAt: "2026-09-19T00:00:00.000Z", total: 121, currency: "EUR" }],
    loadFaq: async () => ({ wifiName: "HotelL7", wifiPassword: "verano", breakfastHours: "07:30-10:30", checkOutTime: "12:00", receptionPhone: "+34 981 000 000" }),
    loadAddress: async () => "Calle Real 1, 15001 A Coruña",
    loadRequests: async () => [],
    loadSurvey: async () => ({ invited: false, answered: false }),
    // Alojada y hoy (2026-09-20 en Madrid) dentro de la estancia → in_house: admite las cuatro peticiones.
    loadReservationHeader: async () => ({ id: "res_l7", code: "L7-0001", propertyId: "prop_l7", status: "checked_in", arrivalDate: "2026-09-19", departureDate: "2026-09-22", timezone: "Europe/Madrid" }),
    organizationIdForProperty: async () => "org_l7",
    createServiceRequest: async (data) => {
      state.requests.push(data);
      return { id: `srq_${String(state.requests.length).padStart(8, "0")}abcdefgh`, createdAt: new Date("2026-09-20T12:00:00.000Z") };
    },
    recordEvent: (input) => {
      state.events.push({ eventType: input.eventType, payload: input.payload, entityType: input.entityType });
    },
    ...overrides
  };
  return { deps, state };
}

describe("L7-02 · stageOf: etapa por estado y fecha local", () => {
  const stay = { status: "confirmed", arrivalDate: "2026-10-02", departureDate: "2026-10-04" };
  it("confirmada: pre_arrival antes de la llegada, arrival_day entre llegada y salida, post_stay tras la salida", () => {
    assert.equal(stageOf(stay, "2026-09-20"), "pre_arrival");
    assert.equal(stageOf(stay, "2026-10-01"), "pre_arrival");
    assert.equal(stageOf(stay, "2026-10-02"), "arrival_day");
    assert.equal(stageOf(stay, "2026-10-03"), "arrival_day", "sin check-in sigue esperando la llegada");
    assert.equal(stageOf(stay, "2026-10-04"), "post_stay");
    assert.equal(stageOf(stay, "2026-11-01"), "post_stay");
  });
  it("alojada: in_house hasta la víspera de la salida, departure_day el día de salida (o después)", () => {
    const inHouse = { ...stay, status: "checked_in" };
    assert.equal(stageOf(inHouse, "2026-10-02"), "in_house");
    assert.equal(stageOf(inHouse, "2026-10-03"), "in_house");
    assert.equal(stageOf(inHouse, "2026-10-04"), "departure_day");
    assert.equal(stageOf(inHouse, "2026-10-05"), "departure_day", "salida vencida sin check-out sigue siendo día de salida");
  });
  it("checked_out → post_stay; cancelled / no_show → cancelled, sea cual sea la fecha", () => {
    assert.equal(stageOf({ ...stay, status: "checked_out" }, "2026-09-01"), "post_stay");
    assert.equal(stageOf({ ...stay, status: "cancelled" }, "2026-10-03"), "cancelled");
    assert.equal(stageOf({ ...stay, status: "no_show" }, "2026-10-03"), "cancelled");
  });
  it("acepta fechas ISO completas (toma YYYY-MM-DD)", () => {
    assert.equal(stageOf({ status: "confirmed", arrivalDate: "2026-10-02T00:00:00.000Z", departureDate: "2026-10-04T00:00:00.000Z" }, "2026-10-02"), "arrival_day");
  });
});

describe("L7-02 · localDateIn: fecha local de la propiedad", () => {
  it("22:30 UTC del 2 de octubre es ya 3 de octubre en Europe/Madrid y sigue siendo 2 en UTC", () => {
    const now = new Date("2026-10-02T22:30:00.000Z");
    assert.equal(localDateIn(now, "Europe/Madrid"), "2026-10-03");
    assert.equal(localDateIn(now, "UTC"), "2026-10-02");
    assert.equal(localDateIn(now, null), "2026-10-02", "sin zona → UTC");
  });
  it("una zona inválida no rompe: cae en la fecha UTC", () => {
    assert.equal(localDateIn(new Date("2026-10-02T22:30:00.000Z"), "Marte/Olympus"), "2026-10-02");
  });
});

describe("L7-02 · folioDtoFrom: saldo real, nunca un 0 literal", () => {
  it("sin folio → no_folio con listas vacías", () => {
    assert.deepEqual(folioDtoFrom(null), { status: "no_folio", balanceDue: 0, currency: null, charges: [], payments: [] });
  });
  it("con saldo → balance_due con cargos y pagos proyectados (methodCode manda sobre method)", () => {
    const dto = folioDtoFrom(FOLIO);
    assert.equal(dto.status, "balance_due");
    assert.equal(dto.balanceDue, 150);
    assert.equal(dto.currency, "EUR");
    assert.deepEqual(dto.charges, [{ description: "Alojamiento DBL · 2 noches", quantity: 2, total: 200, postedAt: "2026-09-20T10:00:00.000Z" }]);
    assert.deepEqual(dto.payments, [{ amount: 50, method: "card_present", status: "captured", createdAt: "2026-09-20T11:00:00.000Z" }]);
  });
  it("saldo ≤ 0,005 → settled", () => {
    assert.equal(folioDtoFrom({ ...FOLIO, balanceDue: 0 }).status, "settled");
    assert.equal(folioDtoFrom({ ...FOLIO, balanceDue: 0.004 }).status, "settled");
    assert.equal(folioDtoFrom({ ...FOLIO, balanceDue: 0.01 }).status, "balance_due");
  });
});

describe("L7-02 · info del hotel desde la FAQ (mismas claves que el bot)", () => {
  it("objeto plano: wifi, desayuno, hora de salida y teléfono; dirección aparte", () => {
    const info = stayInfoFrom({ wifiName: "HotelL7", wifiPassword: "verano", breakfastHours: "07:30-10:30", checkOutTime: "12:00", receptionPhone: "+34 981 000 000" }, "Calle Real 1");
    assert.deepEqual(info, { wifiName: "HotelL7", wifiPassword: "verano", breakfastHours: "07:30-10:30", checkOutTime: "12:00", receptionPhone: "+34 981 000 000", address: "Calle Real 1" });
  });
  it("objeto anidado y claves alternativas (wifi.name, breakfast.hours, checkout.time, reception.phone)", () => {
    const info = stayInfoFrom({ wifi: { name: "Red", password: "clave" }, breakfast: { hours: "08-11" }, checkout: { time: "11:00" }, reception: { phone: "981" } }, null);
    assert.deepEqual(info, { wifiName: "Red", wifiPassword: "clave", breakfastHours: "08-11", checkOutTime: "11:00", receptionPhone: "981", address: null });
  });
  it("lista de pares pregunta/respuesta: wifi y desayuno; lo que no está es null (nada se inventa)", () => {
    const info = stayInfoFrom([{ question: "¿Cuál es la contraseña del wifi?", answer: "secreta" }, { question: "Horario de desayuno", answer: "7 a 10" }], null);
    assert.equal(info.wifiPassword, "secreta");
    assert.equal(info.wifiName, null);
    assert.equal(info.breakfastHours, "7 a 10");
    assert.equal(info.checkOutTime, null);
    assert.equal(info.receptionPhone, null);
  });
  it("sin FAQ todo es null; faqLookup ignora listas y valores vacíos", () => {
    assert.deepEqual(stayInfoFrom(undefined, null), { wifiName: null, wifiPassword: null, breakfastHours: null, checkOutTime: null, receptionPhone: null, address: null });
    assert.equal(faqLookup(["12:00"], ["checkOutTime"]), "");
    assert.equal(faqLookup({ checkOutTime: "   " }, ["checkOutTime"]), "");
    assert.equal(faqLookup({ checkout: 12 }, ["checkOutTime", "checkout"]), "12", "los números se admiten como texto");
  });
  it("formatPropertyAddress compone calle, CP + municipio y provincia; null sin datos", () => {
    assert.equal(formatPropertyAddress({ address: "Calle Real 1", postalCode: "15001", municipality: "A Coruña", province: "A Coruña" }), "Calle Real 1, 15001 A Coruña, A Coruña");
    assert.equal(formatPropertyAddress({ address: null, postalCode: null, municipality: "Vigo", province: null }), "Vigo");
    assert.equal(formatPropertyAddress({ address: null, postalCode: null, municipality: null, province: null }), null);
    assert.equal(formatPropertyAddress(null), null);
  });
});

describe("L7-02 · getGuestStayView con dependencias inyectadas", () => {
  it("compone la vista: etapa con el reloj inyectado, folio, facturas, info, peticiones y encuesta; sin PII de acompañantes", async () => {
    const { deps } = fakeDeps();
    const view = await getGuestStayView({ token: "tok", session: SESSION }, deps);
    assert.equal(view.stage, "pre_arrival");
    assert.equal(view.today, "2026-09-20");
    assert.equal(view.reservation.reservationCode, "L7-0001");
    assert.deepEqual(view.reservation.primaryGuest, { firstName: "Ana", surname1Initial: "G." });
    assert.equal(view.checkIn, null);
    assert.equal(view.folio.status, "balance_due");
    assert.equal(view.folio.balanceDue, 150);
    assert.equal(view.invoices.length, 1);
    assert.equal(view.invoices[0]!.number, "FAC-2026-000001");
    assert.equal(view.info.wifiName, "HotelL7");
    assert.equal(view.info.checkOutTime, "12:00");
    assert.equal(view.info.address, "Calle Real 1, 15001 A Coruña");
    assert.deepEqual(view.requests, []);
    assert.deepEqual(view.survey, { invited: false, answered: false });
    const raw = JSON.stringify(view);
    for (const key of ["guestId", "bookerEmail", "surname1\"", "documentNumber", "email"]) assert.equal(raw.includes(key), false, `${key} no viaja en la vista`);
  });

  it("la etapa se calcula con la fecha LOCAL de la propiedad: 22:30 UTC de la víspera ya es el día de llegada en Madrid", async () => {
    const { deps } = fakeDeps({ now: () => new Date("2026-10-01T22:30:00.000Z") });
    const view = await getGuestStayView({ token: "tok", session: SESSION }, deps);
    assert.equal(view.today, "2026-10-02");
    assert.equal(view.stage, "arrival_day");
    const utc = fakeDeps({ now: () => new Date("2026-10-01T22:30:00.000Z"), loadReservation: async () => ({ ...RESERVATION, propertyTimezone: "UTC" }) });
    assert.equal((await getGuestStayView({ token: "tok", session: SESSION }, utc.deps)).stage, "pre_arrival");
  });

  it("alojada con sesión de check-in y llave activa → in_house, checkIn { status, keyIssued: true }", async () => {
    const { deps } = fakeDeps({
      now: () => new Date("2026-10-02T15:00:00.000Z"),
      loadReservation: async () => ({ ...RESERVATION, status: "checked_in" }),
      loadCheckIn: async () => ({ status: "checked_in" }),
      loadKeyIssued: async () => true,
      loadFolio: async () => null,
      loadRequests: async () => [{ id: "srq_1", kind: "late_checkout", status: "open", createdAt: "2026-10-02T14:00:00.000Z" }]
    });
    const view = await getGuestStayView({ token: "tok", session: SESSION }, deps);
    assert.equal(view.stage, "in_house");
    assert.deepEqual(view.checkIn, { status: "checked_in", keyIssued: true });
    assert.equal(view.folio.status, "no_folio");
    assert.equal(view.requests[0]!.kind, "late_checkout");
  });

  it("los cargadores reciben la reserva y la propiedad de la SESIÓN (nunca del cliente)", async () => {
    const seen: string[] = [];
    const { deps } = fakeDeps({
      loadInvoices: async (reservationId, propertyId) => {
        seen.push(`${reservationId}|${propertyId}`);
        return [];
      },
      loadFaq: async (propertyId) => {
        seen.push(`faq:${propertyId}`);
        return {};
      }
    });
    await getGuestStayView({ token: "tok", session: SESSION }, deps);
    assert.deepEqual(seen.sort(), ["faq:prop_l7", "res_l7|prop_l7"]);
  });
});

describe("L7-02 · createGuestStayRequest: ServiceRequest front_office + GuestCheckoutRequested", () => {
  it("crea la petición con requestType = kind y emite el evento con nota y hora preferida; 201 { id, ticketNumber SRQ-<8>, kind, status open }", async () => {
    const { deps, state } = fakeDeps();
    const result = await createGuestStayRequest({ session: SESSION, body: { kind: "late_checkout", note: "Vuelo a las 18:00", preferredTime: "14:00" }, correlationId: "corr_1" }, deps);
    assert.equal(result.kind, "late_checkout");
    assert.equal(result.status, "open");
    assert.equal(result.ticketNumber, ticketNumberFor(result.id));
    assert.match(result.ticketNumber, /^SRQ-[A-Z0-9]{8}$/);
    assert.deepEqual(state.requests, [{ propertyId: "prop_l7", reservationId: "res_l7", guestId: "guest_titular", requestType: "late_checkout" }]);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]!.eventType, STAY_REQUEST_EVENT);
    assert.equal(state.events[0]!.entityType, "service_request");
    assert.deepEqual(state.events[0]!.payload, { reservationId: "res_l7", reservationCode: "L7-0001", ticketNumber: result.ticketNumber, kind: "late_checkout", note: "Vuelo a las 18:00", preferredTime: "14:00" });
    assert.equal(STAY_REQUEST_DEPARTMENT, "front_office");
  });

  it("sin nota ni hora el evento lleva null; el guestId de la sesión puede ser null", async () => {
    const { deps, state } = fakeDeps();
    await createGuestStayRequest({ session: { ...SESSION, guestId: null }, body: { kind: "luggage" }, correlationId: "corr_2" }, deps);
    assert.equal(state.requests[0]!.guestId, null);
    assert.equal(state.events[0]!.payload.note, null);
    assert.equal(state.events[0]!.payload.preferredTime, null);
  });

  it("reserva cancelled / no_show → 409 STAY_CLOSED sin escribir nada; reserva inexistente → 404", async () => {
    for (const status of ["cancelled", "no_show"]) {
      const { deps, state } = fakeDeps({ loadReservationHeader: async () => ({ id: "res_l7", code: "L7-0001", propertyId: "prop_l7", status, arrivalDate: "2026-09-19", departureDate: "2026-09-22", timezone: "Europe/Madrid" }) });
      await assert.rejects(
        createGuestStayRequest({ session: SESSION, body: { kind: "express_checkout" }, correlationId: "corr_3" }, deps),
        (error: unknown) => error instanceof ConflictError && (error.details as { code: string }).code === "STAY_CLOSED"
      );
      assert.equal(state.requests.length, 0);
      assert.equal(state.events.length, 0);
    }
    const missing = fakeDeps({ loadReservationHeader: async () => null });
    await assert.rejects(createGuestStayRequest({ session: SESSION, body: { kind: "express_checkout" }, correlationId: "corr_4" }, missing.deps), NotFoundError);
  });
});

describe("corrector L7-REV-02 / REV-L7-04 · peticiones por etapa (mismas listas que el portal)", () => {
  const header = (status: string, arrivalDate: string, departureDate: string) => async () => ({ id: "res_l7", code: "L7-0001", propertyId: "prop_l7", status, arrivalDate, departureDate, timezone: "Europe/Madrid" });

  it("allowedStayRequestKinds es exactamente GUEST_STAY_REQUEST_KINDS_BY_STAGE para las seis etapas", () => {
    for (const stage of GUEST_STAY_STAGES) assert.deepEqual([...allowedStayRequestKinds(stage)], [...GUEST_STAY_REQUEST_KINDS_BY_STAGE[stage]], stage);
    assert.deepEqual([...allowedStayRequestKinds("post_stay")], ["invoice_email"]);
    assert.deepEqual([...allowedStayRequestKinds("pre_arrival")], ["late_checkout", "luggage"]);
    assert.deepEqual([...allowedStayRequestKinds("cancelled")], []);
  });

  it("ya salida (checked_out): salida exprés / tardía / consigna → 409 STAY_CLOSED { status: checked_out, kind } sin escribir; la factura por correo → 201", async () => {
    for (const kind of ["express_checkout", "late_checkout", "luggage"] as const) {
      const { deps, state } = fakeDeps({ loadReservationHeader: header("checked_out", "2026-09-15", "2026-09-18") });
      await assert.rejects(
        createGuestStayRequest({ session: SESSION, body: { kind }, correlationId: "corr_co" }, deps),
        (error: unknown) => error instanceof ConflictError && (error.details as { code: string; status: string; kind: string }).code === "STAY_CLOSED" && (error.details as { status: string }).status === "checked_out" && (error.details as { kind: string }).kind === kind
      );
      assert.equal(state.requests.length, 0, kind);
      assert.equal(state.events.length, 0, kind);
    }
    const { deps, state } = fakeDeps({ loadReservationHeader: header("checked_out", "2026-09-15", "2026-09-18") });
    const result = await createGuestStayRequest({ session: SESSION, body: { kind: "invoice_email" }, correlationId: "corr_inv" }, deps);
    assert.equal(result.kind, "invoice_email");
    assert.equal(state.requests.length, 1);
  });

  it("antes de llegar (pre_arrival): salida exprés → 409 STAY_REQUEST_NOT_ALLOWED { stage, kind, allowed }; salida tardía → 201", async () => {
    const { deps, state } = fakeDeps({ loadReservationHeader: header("confirmed", "2026-10-02", "2026-10-04") });
    await assert.rejects(
      createGuestStayRequest({ session: SESSION, body: { kind: "express_checkout" }, correlationId: "corr_pre" }, deps),
      (error: unknown) => {
        const details = (error as ConflictError).details as { code: string; stage: string; kind: string; allowed: string[] };
        return error instanceof ConflictError && details.code === "STAY_REQUEST_NOT_ALLOWED" && details.stage === "pre_arrival" && details.kind === "express_checkout" && details.allowed.join() === "late_checkout,luggage";
      }
    );
    assert.equal(state.requests.length, 0);
    await createGuestStayRequest({ session: SESSION, body: { kind: "late_checkout", preferredTime: "13:00" }, correlationId: "corr_pre2" }, deps);
    assert.equal(state.requests.length, 1);
  });

  it("la etapa se calcula con la fecha LOCAL de la propiedad: 22:30 UTC de la víspera de la salida ya es día de salida en Madrid (sigue admitiendo salida exprés)", async () => {
    const { deps, state } = fakeDeps({ now: () => new Date("2026-09-21T22:30:00.000Z"), loadReservationHeader: header("checked_in", "2026-09-19", "2026-09-22") });
    await createGuestStayRequest({ session: SESSION, body: { kind: "express_checkout" }, correlationId: "corr_dep" }, deps);
    assert.equal(state.requests[0]!.requestType, "express_checkout");
  });
});

describe("corrector L7-REV-03 · enlace de pago honesto con la cuenta vacía", () => {
  const EMPTY_FOLIO = { ...(FOLIO as unknown as Record<string, unknown>), lines: [], payments: [], chargesTotal: 0, paymentsTotal: 0, balanceDue: 0, reservationBalanceDue: 0 } as unknown as ReservationFolioBalance;
  const SETTLED_FOLIO = { ...(FOLIO as unknown as Record<string, unknown>), payments: [{ amount: 200, method: "card", methodCode: "card_present", status: "captured", createdAt: "2026-09-20T11:00:00.000Z" }], paymentsTotal: 200, balanceDue: 0, reservationBalanceDue: 0 } as unknown as ReservationFolioBalance;

  it("folio sin líneas → { status: no_charges, paymentStatus: none }: nunca «pagado» sobre una cuenta vacía", async () => {
    const result = await createGuestStayPaymentLink({ session: SESSION, body: {}, correlationId: "corr_pl" }, { loadFolio: async () => EMPTY_FOLIO });
    assert.deepEqual(result, { statusCode: 200, body: { status: "no_charges", paymentStatus: "none" } });
  });

  it("con cargos y saldo 0 → settled/paid; sin folio → no_folio/none", async () => {
    assert.deepEqual((await createGuestStayPaymentLink({ session: SESSION, body: {}, correlationId: "corr_pl2" }, { loadFolio: async () => SETTLED_FOLIO })).body, { status: "settled", paymentStatus: "paid" });
    assert.deepEqual((await createGuestStayPaymentLink({ session: SESSION, body: {}, correlationId: "corr_pl3" }, { loadFolio: async () => null })).body, { status: "no_folio", paymentStatus: "none" });
  });
});

describe("corrector REV-L7-08 · returnUrl del enlace de pago solo http(s)", () => {
  it("StayPaymentLinkSchema rechaza javascript: / data: y admite https", () => {
    assert.equal(StayPaymentLinkSchema.safeParse({ returnUrl: "javascript:alert(1)" }).success, false);
    assert.equal(StayPaymentLinkSchema.safeParse({ returnUrl: "data:text/html;base64,PHNjcmlwdD4=" }).success, false);
    assert.equal(StayPaymentLinkSchema.safeParse({ returnUrl: "ftp://psp.test/x" }).success, false);
    assert.equal(StayPaymentLinkSchema.safeParse({ returnUrl: "https://huesped.example.test/estancia" }).success, true);
    assert.equal(StayPaymentLinkSchema.safeParse({ returnUrl: "http://127.0.0.1:5237/" }).success, true);
    assert.equal(StayPaymentLinkSchema.safeParse({}).success, true);
    assert.equal(HTTP_URL_PATTERN.test("HTTPS://x.test"), true);
    assert.equal(HTTP_URL_PATTERN.test("javascript:x"), false);
  });
});
