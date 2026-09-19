// Unit tests · Tanda T8 · lote T8-B — clasificador y parser de correos de
// notificación de reseñas (review-email.parser.ts). Sin base de datos, sin
// red. Correos FICTICIOS (autores inventados, ids inventados).
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/review-email-parser.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyInboundEmail,
  classifyInboundEmailDetailed,
  extractLabeledDate,
  extractPortalUrl,
  extractRatingFromText,
  parseReviewNotification,
  scrubAuthorName,
  senderDomain
} from "../review-email.parser.js";

const NOW = new Date("2026-09-19T09:00:00Z");

const bookingReview = {
  messageId: "msg-booking-001",
  fromAddress: "Booking.com <noreply@booking.com>",
  subject: "Nueva reseña de un huésped: 8,0 sobre 10",
  snippet: "Huésped A. ha dejado una reseña sobre su estancia: «Buen hotel, personal amable» Ver la reseña: https://admin.booking.com/hotel/hoteladmin/reviews.html?review_id=12345&utm_source=mail",
  receivedAt: "2026-09-18T20:15:00Z"
};

const bookingReservation = {
  messageId: "msg-booking-002",
  fromAddress: "noreply@booking.com",
  subject: "Nueva reserva: 2 noches en septiembre",
  snippet: "Confirmación de reserva para Huésped B., llegada el 20/09.",
  receivedAt: "2026-09-18T21:00:00Z"
};

const tripadvisorReview = {
  messageId: "msg-ta-001",
  fromAddress: "Tripadvisor <no-reply@e.tripadvisor.com>",
  subject: 'New review from Huésped Ficticio: "Great stay"',
  snippet: "Huésped Ficticio rated your hotel 4 of 5 bubbles. Read the review: https://www.tripadvisor.com/ShowUserReviews-g1-d2-r3456.html?m=1",
  receivedAt: "2026-09-17T10:00:00Z"
};

describe("classifyInboundEmail", () => {
  it("booking.com con asunto de reseña → review_notification (booking)", () => {
    assert.equal(classifyInboundEmail(bookingReview), "review_notification");
    assert.equal(classifyInboundEmailDetailed(bookingReview).provider, "booking");
  });
  it("booking.com de reserva → reservation (sigue el flujo actual)", () => {
    assert.equal(classifyInboundEmail(bookingReservation), "reservation");
  });
  it("tripadvisor.com (subdominio) con «review» → tripadvisor", () => {
    const out = classifyInboundEmailDetailed(tripadvisorReview);
    assert.equal(out.kind, "review_notification");
    assert.equal(out.provider, "tripadvisor");
  });
  it("holidaycheck.de con «Bewertung» → holidaycheck", () => {
    const out = classifyInboundEmailDetailed({ fromAddress: "noreply@holidaycheck.de", subject: "Neue Bewertung für Ihr Hotel", snippet: "Ein Gast hat Ihr Hotel mit 5 von 6 Sonnen bewertet." });
    assert.equal(out.kind, "review_notification");
    assert.equal(out.provider, "holidaycheck");
  });
  it("google.com solo con referencia a Business Profile", () => {
    const yes = classifyInboundEmailDetailed({ fromAddress: "Google Business Profile <businessprofile-noreply@google.com>", subject: "Tienes una reseña nueva en tu Perfil de Empresa", snippet: "Huésped B. ha valorado tu negocio con 5 estrellas." });
    assert.equal(yes.kind, "review_notification");
    assert.equal(yes.provider, "google");
    assert.equal(classifyInboundEmail({ fromAddress: "calendar-notification@google.com", subject: "Review your week", snippet: "Your agenda" }), "ignored");
  });
  it("expedia.com con «review» → expedia; sin él → reservation", () => {
    assert.equal(classifyInboundEmailDetailed({ fromAddress: "no-reply@expedia.com", subject: "Post-stay review received: 3/5", snippet: "A guest left feedback." }).provider, "expedia");
    assert.equal(classifyInboundEmail({ fromAddress: "no-reply@expedia.com", subject: "New booking itinerary", snippet: "" }), "reservation");
  });
  it("marketing de un portal sin asunto de reseña → ignored", () => {
    assert.equal(classifyInboundEmail({ fromAddress: "news@tripadvisor.com", subject: "Descubre las mejores playas", snippet: "Ofertas" }), "ignored");
  });
  it("remitente desconocido: reserva por vocabulario o ignored", () => {
    assert.equal(classifyInboundEmail({ fromAddress: "persona@ejemplo.test", subject: "Reserva para dos noches", snippet: "" }), "reservation");
    assert.equal(classifyInboundEmail({ fromAddress: "persona@ejemplo.test", subject: "Factura de la luz", snippet: "" }), "ignored");
    assert.equal(classifyInboundEmail({ fromAddress: null, subject: null, snippet: null }), "ignored");
  });
  it("senderDomain", () => {
    assert.equal(senderDomain("Nombre <noreply@e.tripadvisor.com>"), "e.tripadvisor.com");
    assert.equal(senderDomain("sin arroba"), "");
  });
});

describe("parseReviewNotification", () => {
  it("booking: nota 8/10, título entrecomillado, extracto, URL canónica sin utm, bodyComplete false", () => {
    const review = parseReviewNotification(bookingReview, "booking", { now: NOW });
    assert.ok(review);
    assert.equal(review.ratingRaw, 8);
    assert.equal(review.ratingScaleMax, 10);
    assert.equal(review.title, "Buen hotel, personal amable");
    assert.equal(review.body, bookingReview.snippet);
    assert.equal(review.bodyComplete, false);
    assert.equal(review.portalUrl, "https://admin.booking.com/hotel/hoteladmin/reviews.html?review_id=12345");
    assert.equal(review.externalId, review.portalUrl);
    assert.equal(review.receivedAt, "2026-09-18T20:15:00.000Z");
    assert.equal(review.replyCapability, false);
    assert.equal(review.portalProvider, "booking");
    assert.equal(review.language, "es");
  });
  it("tripadvisor: 4 de 5 burbujas, autor minimizado, idioma en", () => {
    const review = parseReviewNotification(tripadvisorReview, "tripadvisor", { now: NOW });
    assert.ok(review);
    assert.equal(review.ratingRaw, 4);
    assert.equal(review.ratingScaleMax, 5);
    assert.equal(review.title, "Great stay");
    assert.equal(review.authorDisplayName, "Huésped F.");
    assert.equal(review.portalUrl, "https://www.tripadvisor.com/ShowUserReviews-g1-d2-r3456.html?m=1");
    assert.equal(review.language, "en");
  });
  it("holidaycheck: 5 de 6 soles", () => {
    const review = parseReviewNotification({ messageId: "msg-hc-1", fromAddress: "noreply@holidaycheck.de", subject: "Neue Bewertung für Ihr Hotel", snippet: "Ein Gast hat Ihr Hotel mit 5 von 6 Sonnen bewertet.", receivedAt: "2026-09-16T08:00:00Z" }, "holidaycheck", { now: NOW });
    assert.ok(review);
    assert.equal(review.ratingRaw, 5);
    assert.equal(review.ratingScaleMax, 6);
    assert.equal(review.externalId, "email:msg-hc-1");
  });
  it("google: 5 estrellas; sin fecha usa `now`", () => {
    const review = parseReviewNotification({ fromAddress: "businessprofile-noreply@google.com", subject: "Tienes una reseña nueva en tu Perfil de Empresa", snippet: "Huésped B. ha valorado tu negocio con 5 estrellas." }, "google", { now: NOW });
    assert.ok(review);
    assert.equal(review.ratingRaw, 5);
    assert.equal(review.ratingScaleMax, 5);
    assert.equal(review.receivedAt, NOW.toISOString());
    assert.equal(review.externalId, undefined);
  });
  it("devuelve null si el correo no es de reseña o es de otro portal", () => {
    assert.equal(parseReviewNotification(bookingReservation, "booking", { now: NOW }), null);
    assert.equal(parseReviewNotification(bookingReview, "tripadvisor", { now: NOW }), null);
  });
  it("un correo de reserva de booking.com NUNCA se convierte en reseña", () => {
    assert.equal(classifyInboundEmail(bookingReservation), "reservation");
    assert.equal(parseReviewNotification(bookingReservation, "booking"), null);
  });
});

describe("helpers de extracción", () => {
  it("extractRatingFromText: formatos x/y, estrellas, soles, etiqueta", () => {
    assert.deepEqual(extractRatingFromText("Puntuación 9,5 sobre 10", "booking"), { rating: 9.5, scaleMax: 10 });
    assert.deepEqual(extractRatingFromText("rated 4 of 5 bubbles", "tripadvisor"), { rating: 4, scaleMax: 5 });
    assert.deepEqual(extractRatingFromText("mit 4,5 Sonnen", "holidaycheck"), { rating: 4.5, scaleMax: 6 });
    assert.deepEqual(extractRatingFromText("3 estrellas", "google"), { rating: 3, scaleMax: 5 });
    assert.deepEqual(extractRatingFromText("Score: 7", "booking"), { rating: 7, scaleMax: 10 });
    assert.equal(extractRatingFromText("sin nota", "google"), null);
    assert.equal(extractRatingFromText("12 sobre 10", "booking"), null);
  });
  it("BD-05: una fecha nunca es una nota («del 3/10/2026», «al 5/10», «2 noches de 5»); la nota real que sigue sí se lee", () => {
    assert.equal(extractRatingFromText("Estancia del 3/10/2026 al 5/10/2026", "tripadvisor"), null);
    assert.equal(extractRatingFromText("Stay from 3/10 to 5/10", "tripadvisor"), null);
    assert.equal(extractRatingFromText("2 noches de 5 en total", "booking"), null);
    assert.equal(extractRatingFromText("Un hotel de 4 estrellas en el centro", "google"), null, "la categoría del hotel no es una nota");
    assert.deepEqual(extractRatingFromText("Un hotel de 4 estrellas. Ha valorado tu negocio con 5 estrellas.", "google"), { rating: 5, scaleMax: 5 });
    assert.deepEqual(extractRatingFromText("Estancia del 3/10/2026 al 5/10/2026. Valoración: 4/5", "tripadvisor"), { rating: 4, scaleMax: 5 });
    assert.deepEqual(extractRatingFromText("Fecha 12-09-2026 · 9/10", "booking"), { rating: 9, scaleMax: 10 });
    const parsed = parseReviewNotification({ messageId: "m-date", fromAddress: "no-reply@e.tripadvisor.com", subject: "Nueva reseña de un huésped", snippet: "Estancia del 3/10/2026 al 5/10/2026. Lee la reseña: https://www.tripadvisor.com/ShowUserReviews-r1.html", receivedAt: "2026-09-10T00:00:00Z" }, "tripadvisor", { now: NOW });
    assert.ok(parsed);
    assert.equal(parsed.ratingRaw, null);
    assert.equal(parsed.ratingScaleMax, null);
  });
  it("HP-03: el nombre completo del huésped se sustituye por la forma minimizada en título y extracto («Juan Pérez escribió» → «Juan P. escribió»)", () => {
    const review = parseReviewNotification(
      { messageId: "m-name", fromAddress: "noreply@e.tripadvisor.com", subject: "Nueva reseña de Juan Pérez: «Buena estancia»", snippet: "Juan Pérez escribió una reseña 4/5 sobre su estancia. Pérez recomienda el hotel.", receivedAt: "2026-09-10T10:00:00Z" },
      "tripadvisor",
      { now: NOW }
    );
    assert.ok(review);
    assert.equal(review.authorDisplayName, "Juan P.");
    assert.doesNotMatch(review.body ?? "", /Juan Pérez/);
    assert.match(review.body ?? "", /^Juan P\. escribió/);
    assert.match(review.body ?? "", /P\. recomienda/);
    assert.equal(review.title, "Buena estancia");
    const verbOnly = parseReviewNotification({ messageId: "m-verb", fromAddress: "noreply@e.tripadvisor.com", subject: "Nueva reseña", snippet: "Anna Schmidt Müller hat eine Bewertung mit 3/5 geschrieben.", receivedAt: "2026-09-10T10:00:00Z" }, "tripadvisor", { now: NOW });
    assert.equal(verbOnly?.authorDisplayName, "Anna S.");
    assert.doesNotMatch(verbOnly?.body ?? "", /Schmidt/);
    assert.equal(scrubAuthorName("texto sin nombre", "Juan Pérez", "Juan P."), "texto sin nombre");
    assert.equal(scrubAuthorName("Ana", undefined, undefined), "Ana");
  });
  it("BD-11: una fecha etiquetada del correo (reenvío a mano) es la fecha de la reseña; sin ella, receivedAt del correo", () => {
    assert.equal(extractLabeledDate("Fecha: 12/09/2026 · texto"), "2026-09-12T12:00:00.000Z");
    assert.equal(extractLabeledDate("Date: 2026-09-12"), "2026-09-12T12:00:00.000Z");
    assert.equal(extractLabeledDate("Publicada el 12 de septiembre de 2026"), "2026-09-12T12:00:00.000Z");
    assert.equal(extractLabeledDate("Sent: September 12, 2026"), "2026-09-12T12:00:00.000Z");
    assert.equal(extractLabeledDate("Date: 09/25/2026"), "2026-09-25T12:00:00.000Z", "mm/dd cuando el segundo número supera 12");
    assert.equal(extractLabeledDate("Fecha: 31/02/2026"), undefined, "fecha inválida");
    assert.equal(extractLabeledDate("Estancia del 3/10/2026 al 5/10/2026"), undefined, "sin etiqueta no se adivina");
    const forwarded = parseReviewNotification({ messageId: "m-fwd", fromAddress: "noreply@e.tripadvisor.com", subject: "Fwd: Nueva reseña de un huésped", snippet: "Enviado: 2 de septiembre de 2026. Huésped C. valoró su estancia con 5/5.", receivedAt: "2026-09-18T20:00:00Z" }, "tripadvisor", { now: NOW });
    assert.equal(forwarded?.receivedAt, "2026-09-02T12:00:00.000Z");
    const future = parseReviewNotification({ messageId: "m-fut", fromAddress: "noreply@e.tripadvisor.com", subject: "Nueva reseña de un huésped", snippet: "Fecha: 31/12/2027. Huésped C. valoró su estancia con 5/5.", receivedAt: "2026-09-18T20:00:00Z" }, "tripadvisor", { now: NOW });
    assert.equal(future?.receivedAt, "2026-09-18T20:00:00.000Z", "una fecha futura se ignora");
  });
  it("extractPortalUrl solo acepta el dominio del portal y limpia utm", () => {
    assert.equal(extractPortalUrl("ver https://ejemplo.test/x y https://www.tripadvisor.com/r1?utm_campaign=a&x=1#top", "tripadvisor"), "https://www.tripadvisor.com/r1?x=1");
    assert.equal(extractPortalUrl("nada", "google"), undefined);
  });
});
