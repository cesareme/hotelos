// Tanda L7 · lote L7-06 — estancia y salida del portal (stay/stay.ts), módulo
// puro: etapa → acción, opciones de salida por etapa, folio real formateado,
// pago honesto, etiquetas de peticiones y datos del hotel sin inventar.
// Tanda L7 · lote L7-08: encuesta post-estancia (estado honesto, validación y
// cuerpo del envío; «Responder la encuesta» primaria con invitación y secundaria sin ella).
// node --import ../api/node_modules/tsx/dist/loader.mjs --test "src/**/__tests__/*.test.mts"

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COPY, t } from "../../checkin/wizard.ts";
import {
  STAGE_HINT_KEY,
  STAGE_LABEL_KEY,
  STAGE_TONE,
  STAY_REQUEST_KINDS,
  STAY_REQUEST_KINDS_BY_STAGE,
  STAY_STAGES,
  NPS_SCORES,
  SCALE_VALUES,
  SURVEY_MAX_ANSWERS,
  SURVEY_QUESTION_TYPES,
  SURVEY_STATUS_KEY,
  SURVEY_TEXT_MAX,
  balanceSummary,
  buildStayRequest,
  buildSurveySubmission,
  canOfferPayment,
  checkOutCopy,
  checkOutOptions,
  folioActionKey,
  stageHintKey,
  stayHappened,
  deriveStage,
  extraQuestions,
  folioStatusKey,
  formatDay,
  formatDayLong,
  formatFolio,
  formatMoney,
  infoRows,
  invoiceFilename,
  invoiceLabel,
  isNpsScore,
  isStayStage,
  paymentOutcome,
  paymentRedirectOf,
  preCheckInRelevant,
  primaryAction,
  requestKindLabel,
  requestNeedsTime,
  requestStatusView,
  reservationStatusLabel,
  scoreQuestion,
  stageOf,
  stayActions,
  surveyErrorKey,
  surveyHasErrors,
  surveyStatus,
  telHref,
  validateSurvey,
  type StayFolio,
  type StayInfo,
  type StayPaymentLinkResponse,
  type StayView,
  type SurveyQuestion,
  type SurveyView
} from "../stay.ts";

const reservation = (status: string, arrivalDate: string, departureDate: string) => ({ status, arrivalDate, departureDate });

/** Intl separa importe y símbolo con un espacio duro (U+00A0 / U+202F): se normaliza para comparar. */
const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, " ");

const EMPTY_FOLIO: StayFolio = { status: "no_folio", balanceDue: 0, currency: null, charges: [], payments: [] };

const FOLIO_DUE: StayFolio = {
  status: "balance_due",
  balanceDue: 186,
  currency: "EUR",
  charges: [
    { description: "Alojamiento", quantity: 2, total: 240, postedAt: "2026-09-19T22:00:00.000Z" },
    { description: "Desayuno", quantity: 2, total: 36, postedAt: "2026-09-20T08:00:00.000Z" }
  ],
  payments: [
    { amount: 90, method: "card", status: "captured", createdAt: "2026-09-19T22:30:00.000Z" },
    { amount: 50, method: "payment_link", status: "pending", createdAt: "2026-09-20T09:00:00.000Z" }
  ]
};

function view(stage: string, overrides: Partial<StayView> = {}): StayView {
  return {
    stage: stage as StayView["stage"],
    today: "2026-09-20",
    reservation: {
      reservationId: "res_1",
      reservationCode: "CHK-10",
      propertyId: "prop_chk",
      propertyName: "Hotel CHK (prueba)",
      propertyTimezone: "Europe/Madrid",
      status: "checked_in",
      arrivalDate: "2026-09-19",
      departureDate: "2026-09-22",
      roomType: "Superior",
      assignedRoomNumber: "305",
      eta: null,
      primaryGuest: { firstName: "Prueba", surname1Initial: "P." },
      guestCount: 1,
      balanceDue: 186,
      currency: "EUR"
    },
    checkIn: null,
    folio: FOLIO_DUE,
    invoices: [],
    info: { wifiName: null, wifiPassword: null, breakfastHours: null, checkOutTime: null, receptionPhone: null, address: null },
    requests: [],
    survey: { invited: false, answered: false },
    ...overrides
  };
}

// ── Etapa ─────────────────────────────────────────────────────────────────────

describe("stay · etapa", () => {
  it("las seis etapas y su copy es/en (etiqueta, aviso y tono)", () => {
    assert.deepEqual([...STAY_STAGES], ["pre_arrival", "arrival_day", "in_house", "departure_day", "post_stay", "cancelled"]);
    for (const stage of STAY_STAGES) {
      assert.ok(isStayStage(stage));
      for (const lang of ["es", "en"] as const) {
        assert.ok(t(lang, STAGE_LABEL_KEY[stage]).length > 0, `${stage} etiqueta ${lang}`);
        assert.ok(t(lang, STAGE_HINT_KEY[stage]).length > 0, `${stage} aviso ${lang}`);
      }
      assert.ok(["ok", "warn", "info", "error"].includes(STAGE_TONE[stage]));
    }
    assert.equal(isStayStage("checked_in"), false);
    assert.equal(isStayStage(undefined), false);
  });

  it("deriveStage sigue la regla del API (fecha local + estado): misma tabla que guest-stay.service.ts", () => {
    assert.equal(deriveStage(reservation("confirmed", "2026-09-22", "2026-09-24"), "2026-09-20"), "pre_arrival");
    assert.equal(deriveStage(reservation("confirmed", "2026-09-20", "2026-09-22"), "2026-09-20"), "arrival_day");
    assert.equal(deriveStage(reservation("confirmed", "2026-09-20", "2026-09-22"), "2026-09-21"), "arrival_day");
    assert.equal(deriveStage(reservation("checked_in", "2026-09-19", "2026-09-22"), "2026-09-20"), "in_house");
    assert.equal(deriveStage(reservation("checked_in", "2026-09-19", "2026-09-22"), "2026-09-22"), "departure_day");
    assert.equal(deriveStage(reservation("checked_in", "2026-09-19", "2026-09-22"), "2026-09-25"), "departure_day");
    assert.equal(deriveStage(reservation("checked_out", "2026-08-21", "2026-08-23"), "2026-09-20"), "post_stay");
    assert.equal(deriveStage(reservation("confirmed", "2026-09-10", "2026-09-12"), "2026-09-20"), "post_stay");
    assert.equal(deriveStage(reservation("cancelled", "2026-09-22", "2026-09-24"), "2026-09-20"), "cancelled");
    assert.equal(deriveStage(reservation("no_show", "2026-09-19", "2026-09-22"), "2026-09-20"), "cancelled");
    // Fechas-hora ISO también valen (se comparan los 10 primeros caracteres).
    assert.equal(deriveStage(reservation("confirmed", "2026-09-22T00:00:00.000Z", "2026-09-24T00:00:00.000Z"), "2026-09-20"), "pre_arrival");
  });

  it("stageOf confía en la etapa del API y solo deriva cuando falta o no es válida", () => {
    assert.equal(stageOf(view("departure_day")), "departure_day");
    assert.equal(stageOf(view("desconocida")), "in_house");
    assert.equal(stageOf(view("", { reservation: { ...view("").reservation, status: "checked_out" } })), "post_stay");
  });

  it("reservationStatusLabel traduce los estados conocidos y deja pasar los demás", () => {
    assert.equal(reservationStatusLabel("confirmed", "es"), "Confirmada");
    assert.equal(reservationStatusLabel("checked_in", "en"), "Checked in");
    assert.equal(reservationStatusLabel("no_show", "es"), "No presentado");
    assert.equal(reservationStatusLabel("otro", "es"), "otro");
  });
});

// ── CTA por etapa ─────────────────────────────────────────────────────────────

describe("stay · acción principal por etapa (brief L7-06)", () => {
  const survey = { invited: false, answered: false };

  it("pre-llegada: «Pre-check-in» (clásico sin sesión CHK; asistente empezar/continuar/revisar con sesión)", () => {
    assert.deepEqual(primaryAction("pre_arrival", null), { destination: "precheckin", labelKey: "preCheckInBlock", hintKey: "preCheckInHint" });
    assert.equal(primaryAction("pre_arrival", { status: "invited", keyIssued: false })?.labelKey, "startPreCheckIn");
    assert.equal(primaryAction("pre_arrival", { status: "invited", keyIssued: false })?.destination, "checkin");
    assert.equal(primaryAction("pre_arrival", { status: "in_progress", keyIssued: false })?.labelKey, "continuePreCheckIn");
    assert.equal(primaryAction("pre_arrival", { status: "ready_for_arrival", keyIssued: false })?.labelKey, "reviewPreCheckIn");
    // Sesión cerrada (recepción la tiene / caducada): sin acción del huésped.
    assert.equal(primaryAction("pre_arrival", { status: "handed_off", keyIssued: false }), null);
    assert.equal(primaryAction("pre_arrival", { status: "expired", keyIssued: false }), null);
    assert.equal(stayActions("pre_arrival", null, survey).secondary?.destination, "service");
  });

  it("llegada: «Llegar» con el pre-check-in cerrado; continuar si sigue abierto; clásico sin sesión", () => {
    assert.deepEqual(primaryAction("arrival_day", { status: "ready_for_arrival", keyIssued: false }), { destination: "checkin", labelKey: "ctaArrive", hintKey: "ctaArriveHint" });
    assert.equal(primaryAction("arrival_day", { status: "arrived", keyIssued: false })?.labelKey, "ctaArrive");
    assert.equal(primaryAction("arrival_day", { status: "in_progress", keyIssued: false })?.labelKey, "continuePreCheckIn");
    assert.equal(primaryAction("arrival_day", null)?.destination, "precheckin");
    assert.equal(t("es", "ctaArrive"), "Llegar");
  });

  it("en casa: «Servicios» principal y «Salida y cuenta» secundaria", () => {
    const actions = stayActions("in_house", { status: "checked_in", keyIssued: true }, survey);
    assert.equal(actions.primary?.destination, "service");
    assert.equal(actions.primary?.labelKey, "requestService");
    assert.equal(actions.secondary?.destination, "checkout");
    assert.equal(t("es", actions.secondary!.labelKey), "Salida y cuenta");
  });

  it("salida: «Salida exprés» principal (destino salida) y servicios secundaria", () => {
    const actions = stayActions("departure_day", { status: "checked_in", keyIssued: true }, survey);
    assert.deepEqual(actions.primary, { destination: "checkout", labelKey: "ctaExpressCheckOut", hintKey: "ctaExpressCheckOutHint" });
    assert.equal(t("es", "ctaExpressCheckOut"), "Salida exprés");
    assert.equal(actions.secondary?.destination, "service");
  });

  it("post-estancia: «Encuesta» principal con página de encuesta (L7-08), invitación y sin respuesta; si no, facturas", () => {
    assert.equal(primaryAction("post_stay", null, { invited: true, answered: false }, { surveyEnabled: true })?.destination, "survey");
    assert.equal(t("es", primaryAction("post_stay", null, { invited: true, answered: false }, { surveyEnabled: true })!.labelKey), "Responder la encuesta");
    // Sin página de encuesta en el portal no se ofrece un botón que no lleva a ningún sitio.
    assert.equal(primaryAction("post_stay", null, { invited: true, answered: false })?.destination, "checkout");
    assert.equal(stayActions("post_stay", null, { invited: true, answered: false }).secondary, null);
    assert.equal(primaryAction("post_stay", null, { invited: true, answered: true }, { surveyEnabled: true })?.destination, "checkout");
    assert.equal(primaryAction("post_stay", null, { invited: false, answered: false }, { surveyEnabled: true })?.destination, "checkout");
    assert.equal(stayActions("post_stay", null, { invited: true, answered: false }, { surveyEnabled: true }).secondary?.labelKey, "ctaInvoices");
  });

  it("post-estancia sin invitación (L7-08): la encuesta sigue disponible como acción secundaria mientras no haya respuesta", () => {
    const notInvited = stayActions("post_stay", null, { invited: false, answered: false }, { surveyEnabled: true });
    assert.equal(notInvited.primary?.destination, "checkout");
    assert.equal(notInvited.secondary?.destination, "survey");
    // Respondida: ni principal ni secundaria (no se pide dos veces).
    assert.equal(stayActions("post_stay", null, { invited: false, answered: true }, { surveyEnabled: true }).secondary, null);
    assert.equal(stayActions("post_stay", null, { invited: true, answered: true }, { surveyEnabled: true }).secondary, null);
  });

  it("cancelada: sin acciones", () => {
    assert.deepEqual(stayActions("cancelled", { status: "cancelled", keyIssued: false }, survey), { primary: null, secondary: null });
    assert.equal(primaryAction("cancelled", null), null);
  });

  it("corrector REV-L7-02: post-estancia sin estancia real (stayed: false) → facturas y nunca la encuesta; el aviso no da las gracias", () => {
    const missed = stayActions("post_stay", null, { invited: true, answered: false }, { surveyEnabled: true, stayed: false });
    assert.equal(missed.primary?.destination, "checkout");
    assert.equal(missed.secondary, null);
    assert.equal(stayHappened("confirmed"), false);
    assert.equal(stayHappened("checked_in"), true);
    assert.equal(stayHappened("checked_out"), true);
    assert.equal(stageHintKey("post_stay", "confirmed"), "stagePostStayMissedHint");
    assert.equal(stageHintKey("post_stay", "checked_out"), "stagePostStayHint");
    assert.equal(stageHintKey("in_house", "checked_in"), "stageInHouseHint");
    assert.equal(t("es", "stagePostStayMissedHint"), "La fecha de salida ya pasó sin registrar tu llegada. Si no es correcto, pregunta en recepción.");
    assert.match(t("en", "stagePostStayMissedHint"), /without a recorded arrival/);
  });

  it("corrector REV-L7-03: botón del folio por etapa (cancelada sin botón; tras la salida «Cuenta y facturas») y cabecera propia de la salida cancelada", () => {
    assert.equal(folioActionKey("cancelled"), null);
    assert.equal(folioActionKey("post_stay"), "ctaInvoices");
    for (const stage of ["pre_arrival", "arrival_day", "in_house", "departure_day"] as const) assert.equal(folioActionKey(stage), "ctaCheckOut", stage);
    assert.deepEqual(checkOutCopy("cancelled"), { eyebrowKey: "checkOutEyebrow", titleKey: "checkOutCancelledTitle", subtitleKey: "checkOutCancelledSubtitle" });
    assert.deepEqual(checkOutCopy("post_stay"), { eyebrowKey: "checkOutEyebrow", titleKey: "checkOutTitle", subtitleKey: "checkOutPostStaySubtitle" });
    assert.deepEqual(checkOutCopy("in_house"), { eyebrowKey: "checkOutEyebrow", titleKey: "checkOutTitle", subtitleKey: "checkOutSubtitle" });
    assert.deepEqual(checkOutCopy(null), { eyebrowKey: "checkOutEyebrow", titleKey: "checkOutTitle", subtitleKey: "checkOutSubtitle" });
    assert.equal(t("es", "checkOutCancelledTitle"), "Reserva cancelada");
    assert.match(t("es", "checkOutCancelledSubtitle"), /cargos de cancelación/);
    assert.equal(t("en", "checkOutCancelledTitle"), "Booking cancelled");
    assert.match(t("es", "paymentCancelledAtReception"), /recepción/);
  });

  it("el pre-check-in solo tiene sentido antes de llegar y el día de llegada", () => {
    assert.equal(preCheckInRelevant("pre_arrival"), true);
    assert.equal(preCheckInRelevant("arrival_day"), true);
    for (const stage of ["in_house", "departure_day", "post_stay", "cancelled"] as const) assert.equal(preCheckInRelevant(stage), false);
  });
});

// ── Peticiones de salida ──────────────────────────────────────────────────────

describe("stay · peticiones de salida (19.4)", () => {
  it("las cuatro clases wire y qué ofrece cada etapa (espejo exacto de GUEST_STAY_REQUEST_KINDS_BY_STAGE: el API rechaza el resto)", () => {
    assert.deepEqual([...STAY_REQUEST_KINDS], ["express_checkout", "late_checkout", "invoice_email", "luggage"]);
    for (const stage of STAY_STAGES) assert.deepEqual(checkOutOptions(stage), [...STAY_REQUEST_KINDS_BY_STAGE[stage]], stage);
    assert.deepEqual(checkOutOptions("pre_arrival"), ["late_checkout", "luggage"]);
    assert.deepEqual(checkOutOptions("arrival_day"), ["late_checkout", "luggage"]);
    assert.deepEqual(checkOutOptions("in_house"), ["express_checkout", "late_checkout", "invoice_email", "luggage"]);
    assert.deepEqual(checkOutOptions("departure_day"), ["express_checkout", "late_checkout", "invoice_email", "luggage"]);
    assert.deepEqual(checkOutOptions("post_stay"), ["invoice_email"]);
    assert.deepEqual(checkOutOptions("cancelled"), []);
    for (const kind of STAY_REQUEST_KINDS) {
      for (const lang of ["es", "en"] as const) assert.notEqual(requestKindLabel(kind, lang), t(lang, "kindOther"), `${kind} tiene etiqueta ${lang}`);
    }
  });

  it("buildStayRequest: cuerpo estricto sin claves vacías; la hora solo en salida tardía y solo si es HH:MM", () => {
    assert.deepEqual(buildStayRequest("express_checkout", "  ", ""), { kind: "express_checkout" });
    assert.deepEqual(buildStayRequest("late_checkout", " Hasta las 14 ", "14:00"), { kind: "late_checkout", note: "Hasta las 14", preferredTime: "14:00" });
    assert.deepEqual(buildStayRequest("late_checkout", "", "25:00"), { kind: "late_checkout" });
    assert.deepEqual(buildStayRequest("luggage", "", "14:00"), { kind: "luggage" });
    assert.equal(buildStayRequest("invoice_email", "x".repeat(600), "").note?.length, 500);
    assert.equal(requestNeedsTime("late_checkout"), true);
    assert.equal(requestNeedsTime("express_checkout"), false);
  });

  it("etiquetas de clase y estado de las peticiones (salida, clásicas del portal y desconocidas)", () => {
    assert.equal(requestKindLabel("express_checkout", "es"), "Salida exprés");
    assert.equal(requestKindLabel("late_checkout", "en"), "Late check-out");
    assert.equal(requestKindLabel("housekeeping", "es"), "Limpieza");
    assert.equal(requestKindLabel("algo_nuevo", "es"), "Petición");
    assert.deepEqual(requestStatusView("open", "es"), { label: "Abierta", tone: "warn" });
    assert.deepEqual(requestStatusView("in_progress", "en"), { label: "In progress", tone: "info" });
    assert.deepEqual(requestStatusView("resolved", "es"), { label: "Resuelta", tone: "ok" });
    assert.deepEqual(requestStatusView("cancelled", "es"), { label: "Cancelada", tone: "error" });
    assert.deepEqual(requestStatusView("raro", "es"), { label: "raro", tone: "info" });
  });
});

// ── Folio ─────────────────────────────────────────────────────────────────────

describe("stay · folio real (formato)", () => {
  it("formatMoney y fechas por idioma (moneda de respaldo EUR; fechas locales en la zona del hotel)", () => {
    assert.equal(plain(formatMoney(186, "EUR", "es")), "186,00 €");
    assert.equal(formatMoney(186, "EUR", "en"), "€186.00");
    assert.equal(plain(formatMoney(12.5, null, "es")), "12,50 €");
    assert.equal(formatMoney(5, "XXX_NO", "es"), "XXX_NO 5.00");
    assert.match(formatDay("2026-09-22", "es"), /22 sept 2026/);
    assert.match(formatDay("2026-09-22", "en"), /22 Sept 2026/);
    // 22:00Z del 19 es el 20 en Madrid: la fecha se pinta en la zona de la propiedad.
    assert.match(formatDay("2026-09-19T22:30:00.000Z", "es", "Europe/Madrid"), /20 sept 2026/);
    assert.equal(formatDay("", "es"), "");
    assert.equal(formatDay("no-es-fecha", "es"), "");
    assert.equal(formatDayLong("2026-09-22", "es"), "22 de septiembre");
    assert.equal(formatDayLong("2026-09-22", "en"), "22 September");
  });

  it("folioStatusKey: sin líneas nunca es «todo pagado»; con saldo → pendiente; con líneas y sin saldo → sin saldo", () => {
    assert.equal(folioStatusKey(EMPTY_FOLIO), "folioNoCharges");
    assert.equal(folioStatusKey({ status: "settled", charges: [] }), "folioNoCharges");
    assert.equal(folioStatusKey({ status: "settled", charges: FOLIO_DUE.charges }), "folioSettled");
    assert.equal(folioStatusKey(FOLIO_DUE), "folioBalanceDue");
  });

  it("formatFolio: cargos, pagos (solo los cobrados suman), totales y saldo REAL del API", () => {
    const folio = formatFolio(FOLIO_DUE, "es", "EUR", "Europe/Madrid");
    assert.equal(folio.status, "balance_due");
    assert.equal(folio.messageKey, "folioBalanceDue");
    assert.equal(plain(folio.balance), "186,00 €");
    assert.equal(folio.balanceDue, 186);
    assert.equal(folio.charges.length, 2);
    assert.deepEqual({ ...folio.charges[0], total: plain(folio.charges[0]!.total) }, { description: "Alojamiento", quantity: 2, total: "240,00 €", date: folio.charges[0]!.date });
    assert.match(folio.charges[0]!.date, /20 sept 2026/);
    assert.equal(plain(folio.totalCharges), "276,00 €");
    assert.equal(plain(folio.totalPaid), "90,00 €", "el pago pendiente del enlace no cuenta como pagado");
    assert.deepEqual(folio.payments.map((row) => [row.method, row.status, plain(row.amount)]), [["Tarjeta", "Cobrado", "90,00 €"], ["Enlace de pago", "Pendiente", "50,00 €"]]);
    assert.equal(plain(t("es", folio.messageKey, { amount: folio.balance })), "Pendiente de pago: 186,00 €");
    // Folio sin moneda → moneda de la reserva.
    assert.equal(formatFolio(EMPTY_FOLIO, "en", "GBP").balance, "£0.00");
    assert.equal(formatFolio(EMPTY_FOLIO, "en", "GBP").messageKey, "folioNoCharges");
    // Todos los PaymentMethod del API tienen etiqueta (nunca el código crudo).
    const methods = formatFolio({ ...FOLIO_DUE, payments: ["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"].map((method) => ({ amount: 1, method, status: "captured", createdAt: "2026-09-20T09:00:00.000Z" })) }, "es").payments.map((row) => row.method);
    assert.deepEqual(methods, ["Efectivo", "Tarjeta", "Tarjeta", "Transferencia", "Enlace de pago", "Otro medio"]);
  });

  it("balanceSummary: «Sin cargos todavía» sin folio o sin líneas; si no, el saldo formateado", () => {
    assert.equal(balanceSummary(EMPTY_FOLIO, "es"), "Sin cargos todavía");
    assert.equal(balanceSummary({ status: "settled", balanceDue: 0, currency: "EUR", charges: [] }, "en"), "No charges yet");
    assert.equal(plain(balanceSummary(FOLIO_DUE, "es")), "186,00 €");
    assert.equal(plain(balanceSummary({ ...FOLIO_DUE, status: "settled", balanceDue: 0 }, "es")), "0,00 €");
  });
});

// ── Pago honesto ──────────────────────────────────────────────────────────────

describe("stay · pago honesto (19.5 · D3)", () => {
  const LINK_GET: StayPaymentLinkResponse = { status: "link_sent", paymentStatus: "link_sent", link: { redirect: { method: "GET", url: "https://psp.sandbox.test/pay/abc" }, idempotent: false } };
  const LINK_POST: StayPaymentLinkResponse = { status: "link_sent", paymentStatus: "link_sent", link: { redirect: { method: "POST", url: "https://psp.sandbox.test/form", fields: { Ds_MerchantParameters: "x", Ds_Signature: "y" } }, idempotent: true } };

  it("«Pagar ahora» (redirect) solo con link_sent y URL http(s) real", () => {
    assert.deepEqual(paymentRedirectOf(LINK_GET), { method: "GET", url: "https://psp.sandbox.test/pay/abc" });
    assert.deepEqual(paymentRedirectOf(LINK_POST), { method: "POST", url: "https://psp.sandbox.test/form", fields: { Ds_MerchantParameters: "x", Ds_Signature: "y" } });
    assert.equal(paymentRedirectOf({ status: "at_reception", paymentStatus: "at_reception", reason: "PSP_NOT_CONFIGURED" }), null);
    assert.equal(paymentRedirectOf({ status: "settled", paymentStatus: "paid" }), null);
    assert.equal(paymentRedirectOf({ status: "link_sent", paymentStatus: "link_sent", link: { redirect: { method: "GET", url: "javascript:alert(1)" }, idempotent: false } }), null);
    assert.equal(paymentRedirectOf({ status: "link_sent", paymentStatus: "link_sent", link: { redirect: { method: "GET", url: "" }, idempotent: false } }), null);
  });

  it("paymentOutcome: sin PSP «se cobra en recepción»; folio vacío «sin cargos todavía» (nunca «todo pagado»); settled con cargos «todo pagado»", () => {
    assert.deepEqual(paymentOutcome({ status: "at_reception", paymentStatus: "at_reception", reason: "PSP_NOT_CONFIGURED" }, FOLIO_DUE), { kind: "at_reception", messageKey: "paymentAtReceptionStay", redirect: null });
    assert.deepEqual(paymentOutcome({ status: "no_folio", paymentStatus: "none" }, EMPTY_FOLIO), { kind: "nothing_due", messageKey: "paymentNoChargesYet", redirect: null });
    // Corrector L7-REV-03: el API ya distingue el folio sin líneas (`no_charges` / `none`).
    assert.deepEqual(paymentOutcome({ status: "no_charges", paymentStatus: "none" }, EMPTY_FOLIO), { kind: "nothing_due", messageKey: "paymentNoChargesYet", redirect: null });
    assert.deepEqual(paymentOutcome({ status: "settled", paymentStatus: "paid" }, EMPTY_FOLIO), { kind: "nothing_due", messageKey: "paymentNoChargesYet", redirect: null });
    assert.deepEqual(paymentOutcome({ status: "settled", paymentStatus: "paid" }, FOLIO_DUE), { kind: "settled", messageKey: "paymentSettled", redirect: null });
    const link = paymentOutcome(LINK_GET, FOLIO_DUE);
    assert.equal(link.kind, "link");
    assert.equal(link.messageKey, "paymentLinkReady");
    assert.deepEqual(link.redirect, { method: "GET", url: "https://psp.sandbox.test/pay/abc" });
    // Un link_sent sin URL utilizable degrada a «en recepción», no a un botón roto.
    assert.equal(paymentOutcome({ status: "link_sent", paymentStatus: "link_sent", link: { redirect: { method: "GET", url: "" }, idempotent: false } }, FOLIO_DUE).kind, "at_reception");
    assert.equal(t("es", "paymentAtReceptionStay"), "El saldo pendiente se cobra en recepción; no tienes que hacer nada más ahora.");
  });

  it("solo se ofrece «Quiero pagar ahora» con saldo real pendiente, y nunca con la reserva cancelada (REV-L7-03 · D3)", () => {
    assert.equal(canOfferPayment(FOLIO_DUE), true);
    assert.equal(canOfferPayment(FOLIO_DUE, "in_house"), true);
    assert.equal(canOfferPayment(FOLIO_DUE, "cancelled"), false, "los cargos de cancelación se gestionan en recepción");
    assert.equal(canOfferPayment(EMPTY_FOLIO), false);
    assert.equal(canOfferPayment({ status: "settled", balanceDue: 0 }), false);
    assert.equal(canOfferPayment({ status: "balance_due", balanceDue: 0 }), false);
  });
});

// ── Datos del hotel y facturas ────────────────────────────────────────────────

describe("stay · datos del hotel (solo lo que el API da) y facturas", () => {
  const INFO_FULL: StayInfo = { wifiName: "CHK-Guest", wifiPassword: "clave123", breakfastHours: "07:30–10:30", checkOutTime: "12:00", receptionPhone: "+34 981 000 000", address: "Rúa do Check-in 2, 15001 A Coruña" };

  it("infoRows deja fuera lo no configurado (null o vacío) y conserva el orden", () => {
    assert.deepEqual(infoRows({ wifiName: null, wifiPassword: null, breakfastHours: null, checkOutTime: null, receptionPhone: null, address: null }), []);
    assert.deepEqual(infoRows({ ...INFO_FULL, wifiPassword: "  ", receptionPhone: null }).map((row) => row.key), ["wifiName", "breakfastHours", "checkOutTime", "address"]);
    const rows = infoRows(INFO_FULL);
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map((row) => row.kind), ["text", "secret", "text", "text", "phone", "text"]);
    for (const row of rows) for (const lang of ["es", "en"] as const) assert.ok(t(lang, row.labelKey).length > 0);
  });

  it("telHref solo con un teléfono de verdad (dígitos, +, separadores); texto libre → sin enlace", () => {
    assert.equal(telHref("+34 981 000 000"), "tel:+34981000000");
    assert.equal(telHref("(981) 00-00-00"), "tel:981000000");
    assert.equal(telHref("Pregunta en el mostrador"), null);
    assert.equal(telHref("ext. 12"), null);
    assert.equal(telHref(null), null);
  });

  it("etiqueta y nombre de fichero de la factura (Content-Disposition o respaldo por id, sin rutas)", () => {
    assert.equal(invoiceLabel({ number: "FAC-2026-000012" }, "es"), "Factura FAC-2026-000012");
    assert.equal(invoiceLabel({ number: null }, "en"), "Invoice");
    assert.equal(invoiceFilename('inline; filename="FAC-2026-000012.pdf"', "inv_1"), "FAC-2026-000012.pdf");
    assert.equal(invoiceFilename("attachment; filename=FAC-1.pdf", "inv_1"), "FAC-1.pdf");
    assert.equal(invoiceFilename('inline; filename="../evil.pdf"', "inv_1"), "factura-inv_1.pdf");
    assert.equal(invoiceFilename('inline; filename="nota.txt"', "inv_1"), "factura-inv_1.pdf");
    assert.equal(invoiceFilename(null, "inv_9"), "factura-inv_9.pdf");
  });
});

// ── Copy ──────────────────────────────────────────────────────────────────────

describe("stay · copy L7-06 en es y en", () => {
  it("todas las claves nuevas existen en las dos tablas y el español es el idioma por defecto", () => {
    const keys = [
      "demoNoApi", "stayLoadError", "stagePreArrival", "stageArrivalDay", "stageInHouse", "stageDepartureDay", "stagePostStay", "stageCancelled",
      "ctaArrive", "ctaCheckOut", "ctaExpressCheckOut", "ctaInvoices", "ctaSurvey", "infoLabel", "checkOutTitle", "folioTitle", "folioNoCharges", "folioSettled", "folioBalanceDue",
      "getPaymentLink", "paymentAtReceptionStay", "paymentNoChargesYet", "checkOutRequestsTitle", "kindExpressCheckout", "kindLateCheckout", "kindInvoiceEmail", "kindLuggage",
      "sendToReception", "requestsTitle", "reqStatusOpen", "invoicesTitle", "invoicesEmpty", "invoiceDownload", "infoTitle", "infoWifi", "infoEmpty", "surveyInvited", "surveyAnswered",
      // L7-08 · página de encuesta.
      "surveyEyebrow", "surveyPageTitle", "surveyPageSubtitle", "surveyLoading", "surveyLoadError", "surveyNpsLegend", "surveyScaleLegend", "surveyScoreOption", "surveyScoreChosen",
      "surveyScoreRequired", "surveyAnswerRequired", "surveyAnswerTooLong", "surveyCommentPlaceholder", "surveySubmit", "surveySubmitting", "surveySendError", "surveyThanksTitle",
      "surveyThanksBody", "surveyAlreadyAnswered", "surveyAnsweredOn", "surveyNotYet", "surveyClosed", "surveySessionExpired", "surveySignIn"
    ] as const;
    for (const key of keys) {
      assert.ok((COPY.es as Record<string, string>)[key]?.trim(), `${key} en es`);
      assert.ok((COPY.en as Record<string, string>)[key]?.trim(), `${key} en en`);
    }
    assert.deepEqual(Object.keys(COPY.en).sort(), Object.keys(COPY.es).sort());
    assert.equal(t("es", "ctaCheckOut"), "Salida y cuenta");
    assert.equal(t("en", "ctaCheckOut"), "Check-out & bill");
  });
});

// ---------------------------------------------------------------------------
// Tanda L7 · L7-08 · encuesta post-estancia (19.7)
// ---------------------------------------------------------------------------

const DEFAULT_QUESTIONS: SurveyQuestion[] = [
  { key: "nps", type: "nps", label: "¿Recomendarías el hotel a un amigo o familiar? (0 = nada probable · 10 = seguro)", required: true },
  { key: "comment", type: "text", label: "¿Qué podríamos mejorar?", required: false }
];

const surveyView = (overrides: Partial<SurveyView> = {}): SurveyView => ({
  survey: { id: "survey_1", name: "Encuesta post-estancia", questions: DEFAULT_QUESTIONS },
  answered: false,
  answeredAt: null,
  available: true,
  stage: "post_stay",
  reservationStatus: "checked_out",
  reservation: { reservationId: "res_1", reservationCode: "CHK-10", propertyId: "prop_chk", propertyName: "Hotel CHK (prueba)" },
  sessionPurpose: "survey",
  ...overrides
});

describe("stay · encuesta post-estancia (L7-08)", () => {
  it("tipos y constantes espejo del contrato: nps · text · scale, NPS 0-10, escala 1-5, texto ≤ 2000, ≤ 20 respuestas", () => {
    assert.deepEqual([...SURVEY_QUESTION_TYPES], ["nps", "text", "scale"]);
    assert.deepEqual([...NPS_SCORES], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual([...SCALE_VALUES], [1, 2, 3, 4, 5]);
    assert.equal(SURVEY_TEXT_MAX, 2000);
    assert.equal(SURVEY_MAX_ANSWERS, 20);
    for (const value of [0, 10, 7]) assert.equal(isNpsScore(value), true);
    for (const value of [-1, 11, 7.5, "7", null, undefined, Number.NaN]) assert.equal(isNpsScore(value), false, String(value));
  });

  it("surveyStatus: formulario solo si el API la declara disponible; respondida; antes de la salida «todavía no»; cancelada «sin encuesta»", () => {
    assert.equal(surveyStatus(surveyView()), "form");
    assert.equal(surveyStatus(surveyView({ answered: true, answeredAt: "2026-09-21T10:00:00.000Z", available: false })), "answered");
    assert.equal(surveyStatus(surveyView({ available: false, stage: "in_house" })), "not_yet");
    assert.equal(surveyStatus(surveyView({ available: false, stage: "pre_arrival" })), "not_yet");
    assert.equal(surveyStatus(surveyView({ available: false, stage: "cancelled" })), "closed");
    // Corrector REV-L7-02: confirmada con la salida pasada (nunca se alojó) → «sin encuesta», no «todavía no».
    assert.equal(surveyStatus(surveyView({ available: false, stage: "post_stay", reservationStatus: "confirmed" })), "closed");
    assert.equal(surveyStatus(surveyView({ available: false, stage: "post_stay", reservationStatus: "checked_out" })), "not_yet");
    // Respondida manda sobre todo lo demás (una respuesta por reserva).
    assert.equal(surveyStatus(surveyView({ answered: true, available: true })), "answered");
    assert.equal(t("es", SURVEY_STATUS_KEY.answered), "Ya has respondido a esta encuesta. ¡Gracias!");
    assert.equal(t("en", SURVEY_STATUS_KEY.not_yet), "The survey opens once your stay is over.");
    assert.equal(t("es", SURVEY_STATUS_KEY.closed), "Esta reserva no tiene encuesta.");
  });

  it("scoreQuestion / extraQuestions: la primera nps es el score; el resto conserva su orden; sin nps el score sigue siendo obligatorio", () => {
    assert.equal(scoreQuestion(DEFAULT_QUESTIONS)?.key, "nps");
    assert.deepEqual(extraQuestions(DEFAULT_QUESTIONS).map((question) => question.key), ["comment"]);
    const custom: SurveyQuestion[] = [
      { key: "limpieza", type: "scale", label: "Limpieza", required: true },
      { key: "q_rec", type: "nps", label: "¿Nos recomendarías?", required: true },
      { key: "q_extra", type: "nps", label: "¿Repetirías?", required: false },
      { key: "texto", type: "text", label: "Comentarios", required: false }
    ];
    assert.equal(scoreQuestion(custom)?.key, "q_rec");
    assert.deepEqual(extraQuestions(custom).map((question) => question.key), ["limpieza", "q_extra", "texto"]);
    const onlyText: SurveyQuestion[] = [{ key: "texto", type: "text", label: "Comentarios", required: true }];
    assert.equal(scoreQuestion(onlyText), null);
    assert.deepEqual(extraQuestions(onlyText), onlyText);
    assert.equal(validateSurvey(onlyText, { score: null, answers: { texto: "hola" } }).score, "surveyScoreRequired");
  });

  it("validateSurvey: score 0-10 obligatorio; obligatorias con texto; texto ≤ 2000; escala y nps extra dentro de rango; opcionales vacías pasan", () => {
    const none = validateSurvey(DEFAULT_QUESTIONS, { score: null, answers: {} });
    assert.equal(none.score, "surveyScoreRequired");
    assert.deepEqual(none.answers, {});
    assert.equal(surveyHasErrors(none), true);
    const ok = validateSurvey(DEFAULT_QUESTIONS, { score: 9, answers: { comment: "  " } });
    assert.deepEqual(ok, { score: null, answers: {} });
    assert.equal(surveyHasErrors(ok), false);
    const long = validateSurvey(DEFAULT_QUESTIONS, { score: 9, answers: { comment: "x".repeat(SURVEY_TEXT_MAX + 1) } });
    assert.equal(long.answers.comment, "surveyAnswerTooLong");
    assert.equal(validateSurvey(DEFAULT_QUESTIONS, { score: 9, answers: { comment: "x".repeat(SURVEY_TEXT_MAX) } }).answers.comment, undefined);
    const custom: SurveyQuestion[] = [
      { key: "nps", type: "nps", label: "NPS", required: true },
      { key: "limpieza", type: "scale", label: "Limpieza", required: true },
      { key: "repite", type: "nps", label: "¿Repetirías?", required: false },
      { key: "texto", type: "text", label: "Comentarios", required: true }
    ];
    const missing = validateSurvey(custom, { score: 3, answers: { limpieza: "", texto: "" } });
    assert.deepEqual(missing.answers, { limpieza: "surveyAnswerRequired", texto: "surveyAnswerRequired" });
    assert.deepEqual(validateSurvey(custom, { score: 3, answers: { limpieza: "6", repite: "11", texto: "ok" } }).answers, { limpieza: "surveyAnswerRequired", repite: "surveyAnswerRequired" });
    assert.deepEqual(validateSurvey(custom, { score: 3, answers: { limpieza: "5", repite: "10", texto: "ok" } }).answers, {});
    assert.equal(validateSurvey(custom, { score: 11, answers: { limpieza: "5", texto: "ok" } }).score, "surveyScoreRequired");
  });

  it("buildSurveySubmission: score + solo respuestas con valor (texto recortado, escalas como número), sin `answers` vacío, ≤ 20 claves", () => {
    assert.deepEqual(buildSurveySubmission(DEFAULT_QUESTIONS, { score: 8, answers: { comment: "  Muy bien  " } }), { score: 8, answers: { comment: "Muy bien" } });
    assert.deepEqual(buildSurveySubmission(DEFAULT_QUESTIONS, { score: 8, answers: { comment: "   " } }), { score: 8 });
    assert.deepEqual(buildSurveySubmission(DEFAULT_QUESTIONS, { score: 0, answers: {} }), { score: 0 });
    const custom: SurveyQuestion[] = [
      { key: "nps", type: "nps", label: "NPS", required: true },
      { key: "limpieza", type: "scale", label: "Limpieza", required: true },
      { key: "texto", type: "text", label: "Comentarios", required: false }
    ];
    const body = buildSurveySubmission(custom, { score: 10, answers: { limpieza: "4", texto: "x".repeat(SURVEY_TEXT_MAX + 5), nps: "ignorado" } });
    assert.equal(body.score, 10);
    assert.equal(body.answers?.limpieza, 4);
    assert.equal((body.answers?.texto as string).length, SURVEY_TEXT_MAX);
    assert.equal("nps" in (body.answers ?? {}), false, "la pregunta del score no se duplica en answers");
    // Nunca más de 20 claves (SURVEY_ANSWER_MAX_KEYS del API).
    const many: SurveyQuestion[] = [{ key: "nps", type: "nps", label: "NPS", required: true }, ...Array.from({ length: 25 }, (_, i) => ({ key: `q${i}`, type: "text" as const, label: `Q${i}`, required: false }))];
    const answers = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`q${i}`, "ok"]));
    assert.equal(Object.keys(buildSurveySubmission(many, { score: 5, answers }).answers ?? {}).length, SURVEY_MAX_ANSWERS);
  });

  it("surveyErrorKey traduce los códigos del API y cae al error genérico de envío", () => {
    assert.equal(surveyErrorKey("SURVEY_ALREADY_ANSWERED"), "surveyAlreadyAnswered");
    assert.equal(surveyErrorKey("SURVEY_NOT_AVAILABLE"), "surveyNotYet");
    assert.equal(surveyErrorKey("GUEST_SESSION_INVALID"), "surveySessionExpired");
    assert.equal(surveyErrorKey("VALIDATION_ERROR"), "surveySendError");
    assert.equal(surveyErrorKey(null), "surveySendError");
    assert.match(t("es", "surveySessionExpired"), /código de reserva/);
    assert.match(t("en", "surveySessionExpired"), /booking code/);
  });
});
