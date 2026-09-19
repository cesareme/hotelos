// Unit tests · Tanda T8 · lote T8-B — normalización de notas, hash de
// contenido y referencia externa (review-normalize.ts). Sin base de datos,
// sin red. Todos los datos son ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/review-normalize.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RatingNormalizationError,
  contentHash,
  externalReferenceFor,
  minimizeAuthorName,
  normalizeRating,
  normalizeRatingOrNull,
  round1,
  round2,
  scaleFor,
  score5ToScore10
} from "../review-normalize.js";

describe("normalizeRating · tabla de escalas 1-5 / 1-10 / 1-6", () => {
  const table: Array<[number, number, number, number]> = [
    [4, 5, 8, 4],
    [4.5, 5, 9, 4.5],
    [5, 5, 10, 5],
    [1, 5, 2, 1],
    [3.5, 5, 7, 3.5],
    [7, 10, 7, 3.5],
    [8.7, 10, 8.7, 4.35],
    [10, 10, 10, 5],
    [1, 10, 1, 0.5],
    [6, 6, 10, 5],
    [5, 6, 8.3, 4.15],
    [1, 6, 1.7, 0.85],
    [0, 5, 0, 0],
    [85, 100, 8.5, 4.25]
  ];
  for (const [rating, scaleMax, score10, score5] of table) {
    it(`${rating} sobre ${scaleMax} → score10 ${score10} · score5 ${score5}`, () => {
      const out = normalizeRating({ rating, scaleMax });
      assert.equal(out.score10, score10);
      assert.equal(out.score5, score5);
      assert.equal(out.ratingRaw, rating);
      assert.equal(out.ratingScaleMax, scaleMax);
    });
  }

  it("admite 10,00 en score10 y lo deja en 5,00 para GuestReview.rating", () => {
    const out = normalizeRating({ rating: 10, scaleMax: 10 });
    assert.equal(out.score10, 10);
    assert.equal(out.score5, 5);
  });
});

describe("normalizeRating · bordes y errores tipados", () => {
  it("rechaza nota por encima de la escala", () => {
    assert.throws(() => normalizeRating({ rating: 5.5, scaleMax: 5 }), (error: unknown) => error instanceof RatingNormalizationError && error.code === "RATING_OUT_OF_RANGE");
  });
  it("rechaza nota negativa", () => {
    assert.throws(() => normalizeRating({ rating: -1, scaleMax: 5 }), (error: unknown) => error instanceof RatingNormalizationError && error.code === "RATING_OUT_OF_RANGE");
  });
  it("rechaza NaN", () => {
    assert.throws(() => normalizeRating({ rating: Number.NaN, scaleMax: 5 }), (error: unknown) => error instanceof RatingNormalizationError && error.code === "RATING_NOT_A_NUMBER");
  });
  it("rechaza escala 0, negativa o infinita", () => {
    for (const scaleMax of [0, -5, Number.POSITIVE_INFINITY]) {
      assert.throws(() => normalizeRating({ rating: 3, scaleMax }), (error: unknown) => error instanceof RatingNormalizationError && error.code === "RATING_SCALE_INVALID");
    }
  });
  it("normalizeRatingOrNull devuelve null en vez de lanzar", () => {
    assert.equal(normalizeRatingOrNull({ rating: 6, scaleMax: 5 }), null);
    assert.equal(normalizeRatingOrNull({ rating: null, scaleMax: 5 }), null);
    assert.equal(normalizeRatingOrNull({ rating: 4, scaleMax: undefined }), null);
    assert.equal(normalizeRatingOrNull({ rating: 4, scaleMax: 5 })?.score10, 8);
  });
  it("los mensajes de error están en español", () => {
    try {
      normalizeRating({ rating: 12, scaleMax: 10 });
      assert.fail("debía lanzar");
    } catch (error) {
      assert.ok(error instanceof RatingNormalizationError);
      assert.match(error.message, /fuera del rango 0-10/);
    }
  });
});

describe("redondeo y escalas por proveedor", () => {
  it("round1/round2 son half-up estables", () => {
    assert.equal(round1(8.35), 8.4);
    assert.equal(round1(2.675), 2.7);
    assert.equal(round2(2.675), 2.68);
    assert.equal(round2(4.145), 4.15);
  });
  it("scaleFor lee REVIEW_PROVIDER_SCALES y acepta el sufijo _demo", () => {
    assert.equal(scaleFor("google"), 5);
    assert.equal(scaleFor("booking"), 10);
    assert.equal(scaleFor("holidaycheck"), 6);
    assert.equal(scaleFor("tripadvisor"), 5);
    assert.equal(scaleFor("google_demo"), 5);
    assert.equal(scaleFor("csv"), null);
    assert.equal(scaleFor("email"), null);
    assert.equal(scaleFor("desconocido"), null);
  });
  it("score5ToScore10 convierte filas antiguas", () => {
    assert.equal(score5ToScore10(4.5), 9);
    assert.equal(score5ToScore10(5), 10);
    assert.equal(score5ToScore10(null), null);
    assert.equal(score5ToScore10(7), 10);
  });
});

describe("contentHash y externalReferenceFor", () => {
  const base = { source: "google", externalId: "rev-001", title: "Muy bien", body: "Todo correcto y limpio.", ratingRaw: 5 };

  it("devuelve 40 caracteres hexadecimales y es determinista", () => {
    const a = contentHash(base);
    const b = contentHash({ ...base });
    assert.match(a, /^[0-9a-f]{40}$/);
    assert.equal(a, b);
  });
  it("ignora mayúsculas y espacios repetidos en título y cuerpo", () => {
    const a = contentHash(base);
    const b = contentHash({ ...base, title: "  MUY   bien ", body: "todo correcto   y limpio." });
    assert.equal(a, b);
  });
  it("cambia si cambia el cuerpo, la nota o la fuente", () => {
    const a = contentHash(base);
    assert.notEqual(a, contentHash({ ...base, body: "Todo correcto." }));
    assert.notEqual(a, contentHash({ ...base, ratingRaw: 4 }));
    assert.notEqual(a, contentHash({ ...base, source: "booking" }));
  });
  it("sin id usa autor + fecha como identidad", () => {
    const withAuthor = { source: "csv", authorDisplayName: "Huésped A.", receivedAt: "2026-09-01T10:00:00Z", title: "Bien", body: "Ok" };
    const same = contentHash({ ...withAuthor, receivedAt: new Date("2026-09-01T10:00:00Z") });
    assert.equal(contentHash(withAuthor), same);
    assert.notEqual(contentHash(withAuthor), contentHash({ ...withAuthor, authorDisplayName: "Huésped B." }));
  });
  it("externalReferenceFor devuelve el id del portal o h:<hash>", () => {
    assert.equal(externalReferenceFor(base), "rev-001");
    const derived = externalReferenceFor({ source: "csv", receivedAt: "2026-09-01", title: "Bien", body: "Ok" });
    assert.match(derived, /^h:[0-9a-f]{40}$/);
    assert.equal(derived.length, 42);
  });
});

describe("minimizeAuthorName", () => {
  it("conserva nombre e inicial del apellido", () => {
    assert.equal(minimizeAuthorName("Ana García López"), "Ana G.");
    assert.equal(minimizeAuthorName("Luis de la Fuente"), "Luis F.");
    assert.equal(minimizeAuthorName("Huésped Ficticio"), "Huésped F.");
  });
  it("BD-09: un pseudónimo con número («Viajero 12», «Guest 4») se conserva entero; un apellido con dígitos sueltos no", () => {
    assert.equal(minimizeAuthorName("Viajero 12"), "Viajero 12");
    assert.equal(minimizeAuthorName("Guest 4"), "Guest 4");
    assert.equal(minimizeAuthorName("Traveler_7"), "Traveler 7");
    assert.equal(minimizeAuthorName("Ana García 2"), "Ana G.");
  });
  it("una sola palabra se conserva; vacío → undefined", () => {
    assert.equal(minimizeAuthorName("Huésped"), "Huésped");
    assert.equal(minimizeAuthorName("   "), undefined);
    assert.equal(minimizeAuthorName(null), undefined);
  });
});
