// Unit tests · corrector L3 ronda 1 (DS-01 / DS-02 / DS-03 / FC-1): the pure
// guards of the cancellation lifecycle — no database.
//   · `reservationNotActiveError`: a cancelled / no_show / in-house reservation
//     answers 409 RESERVATION_NOT_ACTIVE (a repeated POST never stacks a penalty);
//   · `penaltyWaiverBand`: a waived penalty follows the discount bands of §4.7
//     (T1 = amount ≤ discount.T1 AND ≤ discountPctT1 of the stay; T2 ≤
//     discountPctT2; above = explicit approval) with Faranda's defaults
//     (50 € / 10 %, 300 € / 25 %);
//   · `penaltyLineType` and the legacy fee routes' expected statuses.
// Run from apps/api with
//   node --import tsx --test src/modules/cancellation-policy/__tests__/reservation-lifecycle-guards.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THRESHOLDS, THRESHOLD_ACTIONS, type ThresholdAction } from "@hotelos/shared";
import { ConflictError } from "../../../lib/http-error.js";
import { penaltyLineType } from "../cancellation-policy.service.js";
import { LIFECYCLE_ACTIVE_STATUSES, penaltyWaiverBand, reservationNotActiveError } from "../reservation-lifecycle.service.js";

const limits = { T1: DEFAULT_THRESHOLDS.T1, T2: DEFAULT_THRESHOLDS.T2, T3: DEFAULT_THRESHOLDS.T3, T4: DEFAULT_THRESHOLDS.T4 };
const perAction = Object.fromEntries(THRESHOLD_ACTIONS.map((action) => [action, { ...limits }])) as Record<ThresholdAction, typeof limits>;
const thresholds = { perAction, discountPctT1: DEFAULT_THRESHOLDS.discountPctT1, discountPctT2: DEFAULT_THRESHOLDS.discountPctT2 };

describe("corrector L3 · guarda de estado (DS-01 / FC-1)", () => {
  it("solo draft y confirmed admiten cancelar / no-show", () => {
    assert.deepEqual([...LIFECYCLE_ACTIVE_STATUSES], ["draft", "confirmed"]);
  });

  it("una reserva cancelada o no_show responde 409 RESERVATION_NOT_ACTIVE y explica que la penalización ya se aplicó", () => {
    for (const status of ["cancelled", "no_show"]) {
      const error = reservationNotActiveError({ code: "RES-00042", status }, "cancellation");
      assert.ok(error instanceof ConflictError);
      assert.equal(error.statusCode, 409);
      assert.equal((error.details as { code?: string }).code, "RESERVATION_NOT_ACTIVE");
      assert.equal((error.details as { status?: string }).status, status);
      assert.match(error.message, /RES-00042/);
      assert.match(error.message, /no se puede cancelar/);
      assert.match(error.message, /ya se aplicó o se renunció/);
    }
    const noShow = reservationNotActiveError({ code: "RES-00043", status: "cancelled" }, "no_show");
    assert.match(noShow.message, /no se puede marcar como no-show/);
  });

  it("una reserva en casa responde 409 sin hablar de penalización", () => {
    const error = reservationNotActiveError({ code: "RES-00044", status: "checked_in" }, "cancellation");
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /pendiente o confirmada/);
    assert.doesNotMatch(error.message, /ya se aplicó/);
  });
});

describe("corrector L3 · renuncia a la penalización por tramos (DS-02)", () => {
  it("T1 exige importe ≤ 50 € Y ≤ 10 % de la estancia (clave + motivo bastan)", () => {
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 20, stayTotal: 300, thresholds }), { band: "T1", pct: 6.67 });
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 50, stayTotal: 500, thresholds }), { band: "T1", pct: 10 });
  });

  it("primera noche de dos (50 % de la estancia) o 100 % de una NREF → por encima de T2: solo aprobación explícita, sin PIN", () => {
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 150, stayTotal: 300, thresholds }), { band: "above", pct: 50 });
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 1480, stayTotal: 1480, thresholds }), { band: "above", pct: 100 });
  });

  it("importe > 50 € pero ≤ 25 % de la estancia → T2 (override, aprobación o PIN de supervisor)", () => {
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 100, stayTotal: 1000, thresholds }), { band: "T2", pct: 10 });
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 250, stayTotal: 1000, thresholds }), { band: "T2", pct: 25 });
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 260, stayTotal: 1000, thresholds }), { band: "above", pct: 26 });
  });

  it("importe pequeño pero > 10 % de la estancia → T2 (la banda porcentual manda como en el descuento de reserva)", () => {
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 30, stayTotal: 200, thresholds }), { band: "T2", pct: 15 });
  });

  it("estancia sin importe → 100 %: nunca T1; umbrales de la organización respetados", () => {
    assert.equal(penaltyWaiverBand({ waivedAmount: 10, stayTotal: 0, thresholds }).band, "above");
    const wide = { ...thresholds, discountPctT1: 60, discountPctT2: 80, perAction: { ...perAction, discount: { ...limits, T1: 200 } } };
    assert.deepEqual(penaltyWaiverBand({ waivedAmount: 150, stayTotal: 300, thresholds: wide }), { band: "T1", pct: 50 });
    assert.equal(penaltyWaiverBand({ waivedAmount: 0, stayTotal: 300, thresholds }).band, "T1");
  });
});

describe("corrector L3 · rutas heredadas de penalización (DS-03)", () => {
  it("penaltyLineType: cancelación → cancellation_fee; no-show → no_show_fee", () => {
    assert.equal(penaltyLineType("cancellation"), "cancellation_fee");
    assert.equal(penaltyLineType("no_show"), "no_show_fee");
  });
});
