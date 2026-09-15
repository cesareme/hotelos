// Lote «cierre:admin-web» (2026-09-15): helpers puros del cierre del editor de
// tarifas — sello de concurrencia optimista (`expected`), re-base del borrador
// tras un conflicto, estado «stale» («Pendiente de reenvío»), estados de
// publicación nuevos del journal, etiquetas «Origen» / «Precio derivado
// (automático)» y los textos en español de los códigos 4xx nuevos. Sin React.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateGridCell } from "@hotelos/shared";
import { draftReducer, initialDraftStore, isNoopEntry } from "../draft-store.ts";
import {
  RATE_GRID_ERROR_CODES,
  SYNC_STATUS_META,
  aggregateSyncStatus,
  describeSync,
  deliveryStatusLabel,
  expectedFromSnapshot,
  journalFieldLabel,
  journalStatusLabel,
  journalValueLabel,
  rateGridErrorMessage,
  snapshotBefore
} from "../helpers.ts";
import type { CellBeforeSnapshot, DraftEntry } from "../types.ts";

const cell: RateGridCell = {
  ratePlanId: "bar",
  roomTypeId: "dbl",
  date: "2027-05-03",
  basePrice: 96.5,
  effectivePrice: 96.5,
  currency: "EUR",
  restrictions: {},
  source: "manual",
  lastModifiedAt: "2026-09-15T10:00:00.123Z"
};

function entry(key: string, before: CellBeforeSnapshot, price: number): DraftEntry {
  const [ratePlanId, roomTypeId, date] = key.split("|");
  return { key, patch: { ratePlanId, roomTypeId, date, price }, before, origin: "cell", at: "2026-09-15T10:05:00.000Z", reason: null };
}

describe("cierre · concurrencia optimista: expected desde el snapshot de carga", () => {
  it("snapshotBefore conserva lastModifiedAt (null cuando la celda no existe)", () => {
    assert.equal(snapshotBefore(cell).lastModifiedAt, "2026-09-15T10:00:00.123Z");
    assert.equal(snapshotBefore(undefined).lastModifiedAt, null);
  });
  it("expected lleva price + lastModifiedAt tal como se cargaron", () => {
    assert.deepEqual(expectedFromSnapshot(snapshotBefore(cell)), { price: 96.5, lastModifiedAt: "2026-09-15T10:00:00.123Z" });
  });
  it("una celda sin tarifa envía price: null (es un valor esperado, no una omisión)", () => {
    assert.deepEqual(expectedFromSnapshot(snapshotBefore(undefined)), { price: null, lastModifiedAt: null });
  });
  it("un borrador antiguo sin lastModifiedAt solo compara el precio", () => {
    const legacy: CellBeforeSnapshot = { basePrice: 80, effectivePrice: 80, restrictions: {}, source: "manual" };
    assert.deepEqual(expectedFromSnapshot(legacy), { price: 80 });
    assert.equal(expectedFromSnapshot(null), undefined);
  });
});

describe("cierre · rebase del borrador tras un conflicto", () => {
  const stale: CellBeforeSnapshot = { basePrice: 90, effectivePrice: 90, restrictions: {}, source: "manual", lastModifiedAt: "2026-09-15T09:00:00.000Z" };
  const fresh: CellBeforeSnapshot = { basePrice: 92, effectivePrice: 92, restrictions: {}, source: "manual", lastModifiedAt: "2026-09-15T10:00:00.000Z" };
  it("sustituye before por el valor actual del servidor y conserva el parche", () => {
    let store = initialDraftStore();
    store = draftReducer(store, { type: "cell", patch: entry("bar|dbl|2027-05-03", stale, 99).patch, before: stale, now: "2026-09-15T10:05:00.000Z" });
    store = draftReducer(store, { type: "rebase", snapshots: new Map([["bar|dbl|2027-05-03", fresh]]), now: "2026-09-15T10:06:00.000Z" });
    const rebased = store.present.patches.get("bar|dbl|2027-05-03");
    assert.ok(rebased);
    assert.equal(rebased.before.basePrice, 92);
    assert.equal(rebased.before.lastModifiedAt, "2026-09-15T10:00:00.000Z");
    assert.equal(rebased.patch.price, 99);
    assert.deepEqual(expectedFromSnapshot(rebased.before), { price: 92, lastModifiedAt: "2026-09-15T10:00:00.000Z" });
  });
  it("poda la entrada cuando el servidor ya tiene el valor del borrador", () => {
    let store = initialDraftStore();
    store = draftReducer(store, { type: "cell", patch: entry("bar|dbl|2027-05-03", stale, 92).patch, before: stale });
    assert.equal(store.present.patches.size, 1);
    store = draftReducer(store, { type: "rebase", snapshots: new Map([["bar|dbl|2027-05-03", fresh]]) });
    assert.equal(store.present.patches.size, 0);
    assert.equal(isNoopEntry(entry("bar|dbl|2027-05-03", fresh, 92)), true);
  });
  it("ignora claves que no están en el borrador y no toca las demás entradas", () => {
    let store = initialDraftStore();
    store = draftReducer(store, { type: "cell", patch: entry("bar|dbl|2027-05-03", stale, 99).patch, before: stale });
    const before = store;
    store = draftReducer(store, { type: "rebase", snapshots: new Map([["bar|sup|2027-05-03", fresh]]) });
    assert.equal(store, before);
    assert.equal(draftReducer(store, { type: "rebase", snapshots: new Map() }), store);
  });
});

describe("cierre · estado «stale» = Pendiente de reenvío", () => {
  it("meta, leyenda y descripción en español", () => {
    assert.equal(SYNC_STATUS_META.stale.label, "Pendiente de reenvío");
    assert.equal(SYNC_STATUS_META.stale.tone, "stale");
    assert.equal(describeSync("Booking.com", { status: "stale" }), "Booking.com: pendiente de reenvío (el canal conserva el valor anterior)");
    assert.match(describeSync("Booking.com", { status: "stale", at: "2026-09-15T10:42:00.000Z" }), /^Booking\.com: pendiente de reenvío \(el canal conserva el valor anterior, confirmado a las \d{2}:\d{2}\)$/);
    assert.equal(deliveryStatusLabel("stale"), "pendiente de reenvío");
  });
  it("gana a confirmado pero cede ante una entrega en vuelo o rechazada", () => {
    assert.equal(aggregateSyncStatus({ a: { status: "confirmed" }, b: { status: "stale" } }), "stale");
    assert.equal(aggregateSyncStatus({ a: { status: "queued" }, b: { status: "stale" } }), "queued");
    assert.equal(aggregateSyncStatus({ a: { status: "rejected" }, b: { status: "stale" } }), "rejected");
    assert.equal(aggregateSyncStatus({ a: { status: "never" }, b: { status: "stale" } }), "stale");
  });
});

describe("cierre · pushStatus queued / superseded en el historial", () => {
  it("etiquetas nuevas sin tocar las existentes", () => {
    assert.deepEqual(journalStatusLabel({ status: "published", pushStatus: "queued" }), { label: "… en cola de envío", tone: "accent" });
    assert.deepEqual(journalStatusLabel({ status: "published", pushStatus: "superseded" }), { label: "sustituido por un envío posterior", tone: "muted" });
    assert.equal(journalStatusLabel({ status: "published", pushStatus: "pushed" }).label, "✓ publicado");
    assert.equal(journalStatusLabel({ status: "reverted", pushStatus: "queued" }).label, "revertido");
  });
});

describe("cierre · campos del journal: Origen y Precio derivado (automático)", () => {
  it("etiquetas de campo", () => {
    assert.equal(journalFieldLabel("source"), "Origen");
    assert.equal(journalFieldLabel("derivedPrice"), "Precio derivado (automático)");
    assert.equal(journalFieldLabel("price"), "Precio");
    assert.equal(journalFieldLabel("minLos"), "Estancia mínima");
    assert.equal(journalFieldLabel("whatever"), "whatever");
  });
  it("valores: origen en español, precio derivado como dinero", () => {
    assert.equal(journalValueLabel("source", "manual"), "manual");
    assert.equal(journalValueLabel("source", "derived"), "derivado");
    assert.equal(journalValueLabel("source", "import"), "importado");
    assert.equal(journalValueLabel("source", "rms"), "RMS");
    assert.equal(journalValueLabel("source", null), "—");
    assert.equal(journalValueLabel("derivedPrice", 86.4), "86,40 €");
    assert.equal(journalValueLabel("derivedPrice", null), "sin tarifa");
    assert.equal(journalValueLabel("cta", true), "sí");
  });
});

describe("cierre · códigos 4xx nuevos con texto en español", () => {
  it("RATE_GRID_BUSY siempre pide reintentar en unos segundos (sin duplicarlo)", () => {
    const api = "La parrilla de esta propiedad está siendo modificada por otra petición: reintenta en unos segundos.";
    assert.equal(rateGridErrorMessage(RATE_GRID_ERROR_CODES.RATE_GRID_BUSY, api), api);
    assert.equal(rateGridErrorMessage(RATE_GRID_ERROR_CODES.RATE_GRID_BUSY, ""), "La parrilla de esta propiedad está siendo modificada por otra petición. Reintenta en unos segundos.");
  });
  it("códigos 400 con guía y detalles", () => {
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.NO_CELLS, ""), /ninguna celda/);
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.TOO_MANY_CELLS, "Demasiadas celdas (6000 > 5000)."), /^Demasiadas celdas \(6000 > 5000\)\. Reduce el rango/);
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.INACTIVE_RATE_PLANS, "", { ratePlanIds: ["nr"] }), /Planes: nr\. Reactívalos/);
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.DERIVATION_CHAIN, ""), /un nivel de derivación/);
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.DERIVATION_YIELDS_ZERO, ""), /0 €/);
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.UNKNOWN_IDS, "", { roomTypeIds: ["x", "y"] }), /\(x, y\) Recarga la parrilla/);
  });
  it("409 de canal y de revert", () => {
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.CHANNEL_HAS_PENDING_DELIVERIES, "El canal tiene entregas pendientes de envío.", { pending: 3 }), /\(3 entregas pendientes\) Espera al drenaje/);
    assert.match(rateGridErrorMessage(RATE_GRID_ERROR_CODES.JOURNAL_STALE, ""), /fuerza la reversión/);
  });
  it("un código desconocido devuelve el mensaje del API tal cual", () => {
    assert.equal(rateGridErrorMessage("SOMETHING_ELSE", "Texto del API."), "Texto del API.");
    assert.equal(rateGridErrorMessage(undefined, "Texto del API."), "Texto del API.");
  });
});
