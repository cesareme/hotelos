import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESERVATION_SEARCH_MAX_LENGTH,
  RESERVATION_SEARCH_PAGE_SIZE,
  buildReservationSearchQuery,
  mergeReservationPages,
  normalizeReservationSearch,
  pickSearchSelection,
  reservationHolderLabel,
  reservationResultLabel,
  searchResultsSummary
} from "../billingSearch.ts";

// Tanda L3 · lote F1: el Centro de facturación busca reservas con
// `GET /properties/:id/reservations?q=…&limit=25&sort=arrival_desc` y pagina
// con `nextCursor`. Módulo puro: sin React ni red.

const formatDate = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

describe("billingSearch · normalización del texto", () => {
  it("recorta, colapsa espacios y respeta el máximo del API (q max 100)", () => {
    assert.equal(normalizeReservationSearch("  García   Pérez "), "García Pérez");
    assert.equal(normalizeReservationSearch("\tRES-00012\n"), "RES-00012");
    assert.equal(normalizeReservationSearch(""), "");
    assert.equal(normalizeReservationSearch(null), "");
    assert.equal(normalizeReservationSearch(undefined), "");
    const long = "a".repeat(RESERVATION_SEARCH_MAX_LENGTH + 40);
    assert.equal(normalizeReservationSearch(long).length, RESERVATION_SEARCH_MAX_LENGTH);
  });
});

describe("billingSearch · construcción de la query", () => {
  it("sin texto no envía q (el API rechaza q vacía) y fija tamaño y orden", () => {
    assert.deepEqual(buildReservationSearchQuery(""), { limit: RESERVATION_SEARCH_PAGE_SIZE, sort: "arrival_desc" });
    assert.deepEqual(buildReservationSearchQuery("   "), { limit: 25, sort: "arrival_desc" });
    assert.equal(RESERVATION_SEARCH_PAGE_SIZE, 25);
  });

  it("con texto envía q normalizada y, al pedir más, el cursor", () => {
    assert.deepEqual(buildReservationSearchQuery(" garcía "), { q: "garcía", limit: 25, sort: "arrival_desc" });
    assert.deepEqual(buildReservationSearchQuery("RES-0001", { cursor: "eyJ" }), { q: "RES-0001", limit: 25, sort: "arrival_desc", cursor: "eyJ" });
    assert.deepEqual(buildReservationSearchQuery("x", { cursor: null }), { q: "x", limit: 25, sort: "arrival_desc" });
  });

  it("admite un tamaño de página propio pero nunca cero ni negativo", () => {
    assert.equal(buildReservationSearchQuery("", { limit: 50 }).limit, 50);
    assert.equal(buildReservationSearchQuery("", { limit: 0 }).limit, 25);
    assert.equal(buildReservationSearchQuery("", { limit: -3 }).limit, 25);
    assert.equal(buildReservationSearchQuery("", { limit: 10.7 }).limit, 10);
  });
});

describe("billingSearch · fusión de páginas", () => {
  it("añade la página nueva conservando el orden y sin repetir ids", () => {
    const current = [{ id: "a" }, { id: "b" }];
    const merged = mergeReservationPages(current, [{ id: "b" }, { id: "c" }, { id: "a" }, { id: "d" }]);
    assert.deepEqual(merged.map((row) => row.id), ["a", "b", "c", "d"]);
    // never mutates the input
    assert.deepEqual(current.map((row) => row.id), ["a", "b"]);
  });

  it("una página vacía deja la lista igual", () => {
    assert.deepEqual(mergeReservationPages([{ id: "a" }], []).map((row) => row.id), ["a"]);
    assert.deepEqual(mergeReservationPages([], [{ id: "z" }]).map((row) => row.id), ["z"]);
  });
});

describe("billingSearch · etiqueta del resultado", () => {
  it("código · titular · llegada; el titular cae a empresa, agencia o «Huésped»", () => {
    assert.equal(reservationResultLabel({ id: "1", code: "RES-00012", arrivalDate: "2026-09-12", bookerName: "García", status: "confirmed" }, formatDate), "RES-00012 · García · 12/09");
    assert.equal(reservationHolderLabel({ bookerName: "  ", companyName: "Faranda SL" }), "Faranda SL");
    assert.equal(reservationHolderLabel({ travelAgentName: "Viajes Sol" }), "Viajes Sol");
    assert.equal(reservationHolderLabel({}), "Huésped");
  });

  it("marca las estancias cerradas (cancelada, no-show, salida) y no las abiertas", () => {
    assert.equal(reservationResultLabel({ id: "1", code: "RES-1", arrivalDate: "2026-09-12", status: "cancelled" }, formatDate), "RES-1 · Huésped · 12/09 · cancelada");
    assert.equal(reservationResultLabel({ id: "1", code: "RES-1", arrivalDate: "2026-09-12", status: "no_show" }, formatDate), "RES-1 · Huésped · 12/09 · no-show");
    assert.equal(reservationResultLabel({ id: "1", code: "RES-1", arrivalDate: "2026-09-12", status: "checked_out" }, formatDate), "RES-1 · Huésped · 12/09 · salida");
    assert.equal(reservationResultLabel({ id: "1", code: "RES-1", arrivalDate: "2026-09-12", status: "checked_in" }, formatDate), "RES-1 · Huésped · 12/09");
  });
});

describe("billingSearch · selección y resumen", () => {
  it("mantiene la selección si sigue en la página; si no, la primera fila; sin filas, vacío", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    assert.equal(pickSearchSelection(rows, "b"), "b");
    assert.equal(pickSearchSelection(rows, "zz"), "a");
    assert.equal(pickSearchSelection(rows, ""), "a");
    assert.equal(pickSearchSelection([], "a"), "");
  });

  it("describe los resultados en español con el texto buscado y si hay más páginas", () => {
    assert.equal(searchResultsSummary({ shown: 0, total: 0, hasMore: false, q: " garcía " }), "Sin reservas para «garcía».");
    assert.equal(searchResultsSummary({ shown: 0, total: 0, hasMore: false, q: "" }), "No hay reservas en la propiedad.");
    assert.equal(searchResultsSummary({ shown: 1, total: 1, hasMore: false, q: "RES-1" }), "1 reserva para «RES-1».");
    assert.equal(searchResultsSummary({ shown: 25, total: 110, hasMore: true, q: "" }), "110 reservas · llegadas más recientes (25 cargadas) · hay más resultados.");
    assert.equal(searchResultsSummary({ shown: 3, total: 3, hasMore: false, q: "pérez" }), "3 reservas para «pérez».");
    // an inconsistent total (lower than what is shown) never shrinks the count
    assert.equal(searchResultsSummary({ shown: 4, total: 2, hasMore: false, q: "" }), "4 reservas · llegadas más recientes.");
    assert.equal(searchResultsSummary({ shown: 4, total: null, hasMore: true, q: "" }), "4 reservas · llegadas más recientes · hay más resultados.");
  });
});
