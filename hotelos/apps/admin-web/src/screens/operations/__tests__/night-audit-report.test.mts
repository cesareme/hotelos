import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REOPEN_REASON_CODES,
  blockerLabel,
  canForceClose,
  labelledAmounts,
  paymentMethodLabel,
  preflightOverrideSummary,
  reopenReasonLabel,
  reportSummary,
  revenueTypeLabel,
  roomChargeOutcomeTone,
  runActionsFor,
  runReviewState,
  runReviewTone,
  runStatusLabel,
  runStatusTone,
  settledFoliosSummary,
  stepLabel,
  stepStatusLabel,
  stepTone,
  stepsNeedingAttention,
  unchargedReservations
} from "../night-audit-report.ts";

// Tanda 6 · lote 6-E: the persisted report of a run (NightAuditReportWire) is
// painted from these helpers; the fixture mirrors what
// apps/api/src/modules/night-audit/night-audit.service.ts writes in
// `stepResultsJson.report` (payments_summary replaced reconcile_payments).
const REPORT = {
  businessDate: "2026-09-13",
  nextBusinessDate: "2026-09-14",
  timeZone: "Europe/Madrid",
  inHouseReservations: 3,
  roomCharges: {
    posted: 2,
    alreadyPosted: 0,
    withoutRate: 1,
    withoutFolio: 0,
    totalPosted: "190.00",
    items: [
      { reservationId: "r1", reservationCode: "RES-00001", folioId: "f1", outcome: "posted" as const, amount: "95.00", priceSource: "rate_plan" as const },
      { reservationId: "r2", reservationCode: "RES-00002", folioId: "f2", outcome: "posted" as const, amount: "95.00", priceSource: "lowest_published" as const },
      { reservationId: "r3", reservationCode: "RES-00003", folioId: "f3", outcome: "no_rate" as const, amount: null, priceSource: "none" as const, detail: "Reserva sin tarifa." }
    ]
  },
  noShows: { processed: 1, totalCharged: "75.00" },
  revenue: { total: "265.00", lines: 3, byType: { room: "190.00", no_show_fee: "75.00" } },
  payments: { total: "120.00", count: 2, byMethod: { cash: "20.00", card_terminal: "100.00" } },
  cashClosures: [{ outletId: "*", status: "open" as const, difference: null }],
  warnings: ["Reserva RES-00003 sin tarifa para la noche del 13/09/2026: no se ha cargado el alojamiento.", "1 cierre(s) de caja del 13/09/2026 siguen abiertos."]
};

describe("Cierre del día · informe de la corrida", () => {
  it("labels the steps of the service in Spanish, the renamed payments step included", () => {
    assert.equal(stepLabel("payments_summary"), "Resumen de cobros");
    assert.equal(stepLabel("reconcile_payments"), "Resumen de cobros");
    assert.equal(stepLabel("post_room_charges"), "Cargos de alojamiento");
    assert.equal(stepLabel("advance_business_date"), "Avance de la fecha de negocio");
    assert.equal(stepLabel("brand_new_step"), "brand new step");
    assert.equal(stepStatusLabel("warning"), "Con avisos");
    assert.equal(stepTone("ok"), "success");
    assert.equal(stepTone("warning"), "warning");
    assert.equal(stepTone("failed"), "danger");
    assert.equal(stepTone("skipped"), "neutral");
  });

  it("labels run statuses, the wire enum and the legacy values alike", () => {
    assert.equal(runStatusLabel("completed"), "Completado");
    assert.equal(runStatusLabel("in_progress"), "En curso");
    assert.equal(runStatusLabel("running"), "En curso");
    assert.equal(runStatusLabel("not_started"), "Pendiente");
    assert.equal(runStatusLabel("failed"), "Fallido");
    assert.equal(runStatusTone("completed"), "success");
    assert.equal(runStatusTone("failed"), "danger");
    assert.equal(runStatusTone("in_progress"), "info");
  });

  it("summarises the report for the KPI strip without inventing figures", () => {
    assert.deepEqual(reportSummary(REPORT), {
      posted: 2,
      totalPosted: "190.00",
      withoutRate: 1,
      revenueTotal: "265.00",
      revenueLines: 3,
      paymentsTotal: "120.00",
      paymentsCount: 2,
      noShows: 1,
      noShowsCharged: "75.00",
      warnings: 2
    });
  });

  it("lists the reservations the run could not charge and the steps with warnings", () => {
    assert.deepEqual(
      unchargedReservations(REPORT).map((i) => i.reservationCode),
      ["RES-00003"]
    );
    assert.deepEqual(unchargedReservations(null), []);
    assert.equal(roomChargeOutcomeTone("no_rate"), "warning");
    assert.equal(roomChargeOutcomeTone("posted"), "success");
    const steps = [
      { step: "validate_open_folios", status: "ok" as const },
      { step: "post_room_charges", status: "warning" as const, detail: "1 reservas sin tarifa" },
      { step: "process_no_shows", status: "skipped" as const }
    ];
    assert.deepEqual(
      stepsNeedingAttention(steps).map((s) => s.step),
      ["post_room_charges"]
    );
  });

  it("Tanda L5 (L5-D): the settled-folios step, the reopened status and the forced close are labelled", () => {
    assert.equal(stepLabel("close_settled_folios"), "Folios liquidados");
    assert.equal(runStatusLabel("reopened"), "Reabierto");
    assert.equal(runStatusTone("reopened"), "warning");
    assert.equal(settledFoliosSummary(REPORT), null, "a report persisted before the step has no figures");
    assert.deepEqual(settledFoliosSummary({ settledFolios: { closed: 42, pendingInvoice: 3, withBalance: 9, totalWithBalance: "445.00" } }), {
      closed: 42,
      pendingInvoice: 3,
      withBalance: 9,
      totalWithBalance: "445.00",
      leftOpen: 12
    });
    assert.equal(preflightOverrideSummary(REPORT), null, "a plain close has no override");
    assert.deepEqual(
      preflightOverrideSummary({ preflightOverride: { reasonText: "Reserva histórica sin resolver", blockers: [{ id: "unresolved_no_shows", title: "No-shows sin resolver", count: 2, detail: "2 reservas pasadas siguen confirmadas sin estancia." }] } }),
      { reasonText: "Reserva histórica sin resolver", blockers: [{ id: "unresolved_no_shows", title: "No-shows sin resolver", count: 2, detail: "2 reservas pasadas siguen confirmadas sin estancia." }] }
    );
    assert.equal(blockerLabel({ count: 2, title: "No-shows sin resolver" }), "2 · No-shows sin resolver");
    assert.equal(blockerLabel({ count: null, title: "Facturas pendientes" }), "— · Facturas pendientes");
  });

  it("Tanda L5 (L5-D): review state, T8a actions by permission and the reopen reason catalogue", () => {
    assert.equal(runReviewState({ status: "completed", reviewedByUserId: null, reopenedByUserId: null }), "pending_review");
    assert.equal(runReviewState({ status: "completed", reviewedByUserId: "usr_1", reopenedByUserId: null }), "reviewed");
    assert.equal(runReviewState({ status: "reopened", reviewedByUserId: null, reopenedByUserId: "usr_2" }), "reopened");
    assert.equal(runReviewState({ status: "reopened", reviewedByUserId: "usr_1", reopenedByUserId: "usr_2" }), "reviewed", "corrections of a reopened day reviewed");
    assert.equal(runReviewState({ status: "completed", reviewedByUserId: null, reopenedByUserId: "usr_2" }), "pending_review", "a reopened day closed again needs a fresh review");
    assert.equal(runReviewState({ status: "failed", reviewedByUserId: null, reopenedByUserId: null }), "not_applicable");
    assert.equal(runReviewTone("reviewed"), "success");
    assert.equal(runReviewTone("pending_review"), "info");
    assert.equal(runReviewTone("reopened"), "warning");

    const all = () => true;
    const none = () => false;
    assert.deepEqual(runActionsFor({ status: "completed", reviewedByUserId: null }, all), { review: true, reopen: true });
    assert.deepEqual(runActionsFor({ status: "completed", reviewedByUserId: "usr_1" }, all), { review: false, reopen: true }, "an already reviewed run is not reviewed twice");
    assert.deepEqual(runActionsFor({ status: "reopened", reviewedByUserId: null }, all), { review: true, reopen: false }, "a reopened day is reviewed (its corrections), never reopened twice");
    assert.deepEqual(runActionsFor({ status: "reopened", reviewedByUserId: "usr_1" }, all), { review: false, reopen: false });
    assert.deepEqual(runActionsFor({ status: "failed", reviewedByUserId: null }, all), { review: false, reopen: false }, "a failed run is neither reviewed nor reopened");
    assert.deepEqual(runActionsFor({ status: "completed", reviewedByUserId: null }, none), { review: false, reopen: false });
    assert.deepEqual(runActionsFor({ status: "completed", reviewedByUserId: null }, (key) => key === "night_audit.review"), { review: true, reopen: false });
    assert.equal(canForceClose(all), true);
    assert.equal(canForceClose(none), false);

    assert.deepEqual([...REOPEN_REASON_CODES], ["missing_charge", "wrong_charge", "no_show_error", "payment_correction", "audit_finding", "other"]);
    assert.equal(reopenReasonLabel("missing_charge"), "Cargo no contabilizado");
    assert.equal(reopenReasonLabel("other"), "Otro motivo (indicar en el texto)");
    assert.equal(reopenReasonLabel("unknown_code"), "unknown_code");
    assert.equal(reopenReasonLabel(null), "—");
  });

  it("labels amounts by method and by type, largest first", () => {
    assert.deepEqual(labelledAmounts(REPORT.payments.byMethod, paymentMethodLabel), [
      { key: "card_terminal", label: "Tarjeta (datáfono)", amount: "100.00" },
      { key: "cash", label: "Efectivo", amount: "20.00" }
    ]);
    assert.deepEqual(labelledAmounts(REPORT.revenue.byType, revenueTypeLabel), [
      { key: "room", label: "Alojamiento", amount: "190.00" },
      { key: "no_show_fee", label: "Penalización por no presentarse", amount: "75.00" }
    ]);
    assert.deepEqual(labelledAmounts(undefined, revenueTypeLabel), []);
    assert.equal(revenueTypeLabel("unknown_kind"), "unknown_kind");
    assert.equal(paymentMethodLabel("card"), "Tarjeta (datáfono)");
  });
});
