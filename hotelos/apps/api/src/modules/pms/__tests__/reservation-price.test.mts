// Tanda L3 · lote A («precio de reserva desde tarifa al crear»): the pure price
// decision of pms/room-charge.service (decideReservationPrice /
// quotedRatePlanIdOf) and the Spanish pricing warning of pms.service. No
// database: quotes are hand-built ReservationTotalQuote fixtures.
// From apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-price.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideReservationPrice, quotedRatePlanIdOf, type NightlyRateQuote, type ReservationTotalQuote } from "../room-charge.service.js";
import { reservationPricingWarning } from "../pms.service.js";

const night = (date: string, price: string | null, ratePlanId: string | null, source: NightlyRateQuote["source"] = price === null ? "none" : "rate_plan"): NightlyRateQuote => ({
  date,
  price,
  currency: "EUR",
  source,
  ratePlanId,
  roomTypeId: "rt_dbl",
  warning: null
});

function quoteOf(nightly: NightlyRateQuote[]): ReservationTotalQuote {
  const nightsWithoutRate = nightly.filter((n) => n.price === null).length;
  const total = nightly.reduce((sum, n) => sum + (n.price === null ? 0 : Math.round(Number(n.price) * 100)), 0);
  return {
    total: (total / 100).toFixed(2),
    currency: "EUR",
    nights: nightly.length,
    nightsWithoutRate,
    priceSource: nightsWithoutRate === 0 ? "rate_plan" : nightsWithoutRate === nightly.length ? "none" : "partial",
    nightly
  };
}

const BAR = "rp_bar";
const NR = "rp_bar_nr";
const fullQuote = quoteOf([night("2026-10-02", "100.00", BAR), night("2026-10-03", "100.00", BAR)]);
const partialQuote = quoteOf([night("2026-10-06", "100.00", BAR), night("2026-10-07", "100.00", BAR), night("2026-10-08", null, null)]);
const emptyQuote = quoteOf([night("2026-11-10", null, null), night("2026-11-11", null, null)]);

describe("decideReservationPrice · total enviado", () => {
  it("total enviado → manual, redondeado al céntimo (half-up), sin tocar la cotización", () => {
    const decision = decideReservationPrice({ requestedTotal: 184.005, quote: fullQuote, roomsCount: 1, importFlow: false });
    assert.deepEqual(decision, { totalAmount: 184.01, priceSource: "manual", quotedRatePlanId: BAR });
    assert.equal(decideReservationPrice({ requestedTotal: 0, quote: null, roomsCount: 1, importFlow: false }).priceSource, "manual", "0 € explícito sigue siendo manual");
  });
  it("total enviado en el flujo de importación → file (el importe del PMS no es una decisión del actor)", () => {
    const decision = decideReservationPrice({ requestedTotal: 250, quote: null, roomsCount: 2, importFlow: true });
    assert.deepEqual(decision, { totalAmount: 250, priceSource: "file", quotedRatePlanId: null });
  });
  it("importe negativo o no numérico → error (el esquema HTTP ya lo impide; los llamadores internos también)", () => {
    assert.throws(() => decideReservationPrice({ requestedTotal: -1, quote: fullQuote, roomsCount: 1, importFlow: false }), /Importe de reserva no válido/);
    assert.throws(() => decideReservationPrice({ requestedTotal: Number.NaN, quote: fullQuote, roomsCount: 1, importFlow: false }), /Importe de reserva no válido/);
  });
});

describe("decideReservationPrice · sin total (cotización canónica)", () => {
  it("cotización completa → rate_plan = total de una habitación × habitaciones", () => {
    assert.deepEqual(decideReservationPrice({ requestedTotal: undefined, quote: fullQuote, roomsCount: 1, importFlow: false }), { totalAmount: 200, priceSource: "rate_plan", quotedRatePlanId: BAR });
    assert.deepEqual(decideReservationPrice({ quote: fullQuote, roomsCount: 3, importFlow: false }), { totalAmount: 600, priceSource: "rate_plan", quotedRatePlanId: BAR });
  });
  it("roomsCount inválido (0, negativo, decimal) cuenta como 1 habitación", () => {
    for (const roomsCount of [0, -2, 1.5, Number.NaN]) {
      assert.equal(decideReservationPrice({ quote: fullQuote, roomsCount, importFlow: false }).totalAmount, 200, `roomsCount ${String(roomsCount)}`);
    }
  });
  it("redondeo al céntimo half-up del producto", () => {
    const odd = quoteOf([night("2026-10-02", "33.33", BAR), night("2026-10-03", "33.34", BAR)]);
    // 66,67 × 3 = 200,01 exacto; 12,345 no existe en la parrilla (2 decimales) pero el producto sí puede necesitar redondeo.
    assert.equal(decideReservationPrice({ quote: odd, roomsCount: 3, importFlow: false }).totalAmount, 200.01);
    const cents = { ...quoteOf([night("2026-10-02", "0.05", BAR)]), total: "0.005" };
    assert.equal(decideReservationPrice({ quote: cents, roomsCount: 1, importFlow: false }).totalAmount, 0.01);
  });
  it("cotización parcial → 0 € con priceSource partial; vacía → none; sin cotización → none", () => {
    assert.deepEqual(decideReservationPrice({ quote: partialQuote, roomsCount: 2, importFlow: false }), { totalAmount: 0, priceSource: "partial", quotedRatePlanId: BAR });
    assert.deepEqual(decideReservationPrice({ quote: emptyQuote, roomsCount: 1, importFlow: false }), { totalAmount: 0, priceSource: "none", quotedRatePlanId: null });
    assert.deepEqual(decideReservationPrice({ quote: null, roomsCount: 1, importFlow: false }), { totalAmount: 0, priceSource: "none", quotedRatePlanId: null });
  });
  it("quotedRatePlanId = plan de la PRIMERA noche con precio (aviso del salto BAR-NR → BAR, riesgo 16)", () => {
    const jumped = quoteOf([night("2026-10-02", "100.00", BAR), night("2026-10-03", "90.00", NR)]);
    assert.equal(quotedRatePlanIdOf(jumped), BAR);
    const lateStart = quoteOf([night("2026-10-02", null, null), night("2026-10-03", "90.00", NR, "lowest_published")]);
    assert.equal(quotedRatePlanIdOf(lateStart), NR, "la primera noche sin precio no cuenta");
    assert.equal(quotedRatePlanIdOf(null), null);
    assert.equal(quotedRatePlanIdOf(emptyQuote), null);
  });
});

describe("reservationPricingWarning (texto en español para el cliente)", () => {
  it("none / partial avisan de los 0 €; rate_plan solo avisa cuando cotizó otro plan que el pedido; manual y file nunca", () => {
    assert.match(reservationPricingWarning({ priceSource: "none", nights: 2, nightsWithoutRate: 2, requestedRatePlanId: null, quotedRatePlanId: null }) ?? "", /Sin tarifa publicada.*0 €/);
    assert.match(reservationPricingWarning({ priceSource: "partial", nights: 3, nightsWithoutRate: 1, requestedRatePlanId: null, quotedRatePlanId: BAR }) ?? "", /1 de 3 noches.*0 €/);
    assert.equal(reservationPricingWarning({ priceSource: "rate_plan", nights: 2, nightsWithoutRate: 0, requestedRatePlanId: BAR, quotedRatePlanId: BAR }), null);
    assert.equal(reservationPricingWarning({ priceSource: "rate_plan", nights: 2, nightsWithoutRate: 0, requestedRatePlanId: null, quotedRatePlanId: BAR }), null, "sin plan pedido no hay salto");
    assert.match(reservationPricingWarning({ priceSource: "rate_plan", nights: 2, nightsWithoutRate: 0, requestedRatePlanId: NR, quotedRatePlanId: BAR }) ?? "", /otro plan/);
    assert.equal(reservationPricingWarning({ priceSource: "manual", nights: 2, nightsWithoutRate: 0, requestedRatePlanId: NR, quotedRatePlanId: BAR }), null);
    assert.equal(reservationPricingWarning({ priceSource: "file", nights: 2, nightsWithoutRate: 2, requestedRatePlanId: null, quotedRatePlanId: null }), null);
  });
});
