import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CLOSE_BANNER_TITLES,
  CLOSE_REVIEW_ONLY_TEXT,
  OPEN_QUEUE_LABEL,
  REOPEN_REASON_CODES,
  blockerLabel,
  canForceClose,
  closeActionFor,
  labelledAmounts,
  latestRunToReview,
  paymentMethodLabel,
  preflightOverrideSummary,
  reopenReasonLabel,
  reportSummary,
  revenueTypeLabel,
  reviewCalloutTitle,
  reviewedToast,
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

// ---------------------------------------------------------------- Tanda UX-2 · D8 (F-D3): honest close, review of the last run

describe("Cierre del día · UX-2 D8 · closeActionFor (the run key decides, never canClose alone)", () => {
  const withRun = (key: string) => key === "night_audit.run";
  const withoutRun = (key: string) => key !== "night_audit.run";

  it("green preflight + night_audit.run → run; green WITHOUT the key → review-only (dirección)", () => {
    assert.equal(closeActionFor({ canClose: true }, withRun), "run");
    assert.equal(closeActionFor({ canClose: true }, withoutRun), "review-only");
  });

  it("blockers + night_audit.run → force; blockers WITHOUT the key → blocked", () => {
    assert.equal(closeActionFor({ canClose: false }, withRun), "force");
    assert.equal(closeActionFor({ canClose: false }, withoutRun), "blocked");
  });

  it("no preflight yet counts as not closable; a demo session without a permission list keeps the button", () => {
    assert.equal(closeActionFor(null, withoutRun), "blocked");
    assert.equal(closeActionFor(undefined, () => true), "force");
    assert.equal(closeActionFor({ canClose: true }, () => true), "run", "sessionCan answers true without a permission list (the API decides)");
  });

  it("titles and texts are Spanish and say who closes (P7)", () => {
    assert.equal(CLOSE_BANNER_TITLES.run, "Puedes cerrar el día");
    assert.equal(CLOSE_BANNER_TITLES["review-only"], "Comprobaciones en verde");
    assert.equal(CLOSE_BANNER_TITLES.blocked, CLOSE_BANNER_TITLES.force);
    assert.equal(CLOSE_REVIEW_ONLY_TEXT, "Las comprobaciones están en verde; el cierre lo ejecuta recepción o auditoría nocturna y tú lo revisas cuando esté hecho.");
    assert.equal(OPEN_QUEUE_LABEL, "Abrir cola operativa");
  });
});

describe("Cierre del día · UX-2 D8 · latestRunToReview and the copy of the review callout", () => {
  const reviewer = (key: string) => key === "night_audit.review";
  const runner = (key: string) => key === "night_audit.run";
  const run = (overrides: Partial<{ id: string; status: "completed" | "failed" | "reopened" | "in_progress"; reviewedByUserId: string | null; businessDate: string; completedAt?: string }> = {}) => ({
    id: "run_1",
    status: "completed" as const,
    reviewedByUserId: null,
    businessDate: "2026-09-18",
    completedAt: "2026-09-19T06:00:00.000Z",
    ...overrides
  });

  it("picks the newest business date whatever the order of the list, only while it awaits its review", () => {
    const older = run({ id: "old", businessDate: "2026-09-17", completedAt: "2026-09-18T06:00:00.000Z" });
    const newest = run({ id: "new" });
    assert.equal(latestRunToReview([older, newest], reviewer)?.id, "new");
    assert.equal(latestRunToReview([newest, older], reviewer)?.id, "new");
    assert.equal(latestRunToReview([older, run({ id: "new", reviewedByUserId: "usr_1" })], reviewer), null, "the newest is reviewed: no callout even if an older one is not (the drawer keeps it)");
    assert.equal(latestRunToReview([], reviewer), null);
  });

  it("failed / in-progress runs and sessions without night_audit.review get no callout; a reopened day does", () => {
    assert.equal(latestRunToReview([run({ status: "failed" })], reviewer), null);
    assert.equal(latestRunToReview([run({ status: "in_progress", completedAt: undefined })], reviewer), null);
    assert.equal(latestRunToReview([run()], runner), null, "recepción runs, it does not review");
    assert.equal(latestRunToReview([run({ status: "reopened" })], reviewer)?.id, "run_1");
  });

  it("on a tie of business date the latest completion wins (a day reopened and closed again)", () => {
    const first = run({ id: "first", completedAt: "2026-09-19T06:00:00.000Z" });
    const again = run({ id: "again", completedAt: "2026-09-19T10:30:00.000Z" });
    assert.equal(latestRunToReview([first, again], reviewer)?.id, "again");
  });

  it("«Cierre del 18/09/2026 hecho a las 08:00» (Madrid) · toast «Cierre del 18/09/2026 marcado como revisado»", () => {
    assert.equal(reviewCalloutTitle(run()), "Cierre del 18/09/2026 hecho a las 08:00");
    assert.equal(reviewCalloutTitle(run({ status: "reopened" })), "Día del 18/09/2026 reabierto, pendiente de revisión");
    assert.equal(reviewCalloutTitle(run({ completedAt: undefined })), "Cierre del 18/09/2026 hecho a las —");
    assert.equal(reviewedToast(run()), "Cierre del 18/09/2026 marcado como revisado");
  });
});

// ---------------------------------------------------------------- source contract (NightAuditScreen.tsx)

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const SCREEN = stripComments(readFileSync(new URL("../NightAuditScreen.tsx", import.meta.url), "utf8"));

/** Source of the close banner: from its `closeActionFor` use to the end of the callout. */
function bannerRegion(source: string): string {
  const start = source.indexOf("title={CLOSE_BANNER_TITLES[closeAction]}");
  assert.ok(start >= 0, "the banner title comes from closeActionFor");
  const end = source.indexOf("</CocoaCallout>", start);
  assert.ok(end > start, "the banner closes");
  return source.slice(start, end);
}

describe("NightAuditScreen · no «Cerrar día» without the run key (P7), one review callout with one primary (P1/P2)", () => {
  const banner = bannerRegion(SCREEN);

  it("«Cerrar día» is painted ONLY in the `run` branch; the disabled placeholder is gone", () => {
    assert.equal((SCREEN.match(/>\s*Cerrar día\s*</g) ?? []).length, 1, "one «Cerrar día» button in the screen");
    assert.match(banner, /closeAction === "run" \? \(\s*<CocoaButton variant="filled" tone="accent" disabled=\{busy\} loading=\{busy\} onClick=\{\(\) => void runAudit\(\)\}/);
    assert.doesNotMatch(SCREEN, /disabled title="Resuelve los bloqueos primero"/);
    assert.doesNotMatch(SCREEN, /canClose \? \(\s*<CocoaButton/);
    assert.match(SCREEN, /const closeAction = closeActionFor\(preflight, sessionCan\);/);
  });

  it("forced close keeps its key; blocked without the key offers the operational queue; review-only has no button and says who closes", () => {
    assert.match(banner, /closeAction === "force" \? \([\s\S]*?Cerrar de todos modos/);
    assert.match(banner, /closeAction === "blocked" \? \([\s\S]*?navigateTo\("FrontDeskDashboard"\)[\s\S]*?\{OPEN_QUEUE_LABEL\}/);
    assert.match(banner, /\) : undefined\s*\}/, "review-only paints no action");
    assert.match(banner, /closeAction === "review-only" \? CLOSE_REVIEW_ONLY_TEXT : preflight\.blockingMessage/);
  });

  it("the last unreviewed run gets a callout above the history with ONE filled «Marcar como revisado» (⌥V) that opens the review dialog", () => {
    assert.match(SCREEN, /const runToReview = latestRunToReview\(runs, sessionCan\);/);
    const start = SCREEN.indexOf("{runToReview ? (");
    const end = SCREEN.indexOf('<CocoaSection title="Historial de cierres"', start);
    assert.ok(start >= 0 && end > start, "the review callout sits before the history section");
    const callout = SCREEN.slice(start, end);
    assert.match(callout, /title=\{reviewCalloutTitle\(runToReview\)\}/);
    assert.equal((callout.match(/variant="filled"/g) ?? []).length, 1);
    assert.match(callout, /variant="filled" tone="accent" size="small" accessKey="V" disabled=\{actionBusy\} onClick=\{\(\) => setReviewTarget\(runToReview\)\}/);
    assert.match(callout, />\s*Marcar como revisado\s*</);
    assert.match(callout, /variant="plain" tone="neutral" size="small" onClick=\{\(\) => setSelectedRunId\(runToReview\.id\)\}/, "the report stays one plain click away");
  });

  it("the review dialog is the existing one: opened by target, Enter confirms, the toast names the day, the drawer button shares it", () => {
    assert.match(SCREEN, /open=\{reviewTarget !== null\}/);
    assert.match(SCREEN, /title="Marcar el cierre como revisado"/);
    assert.match(SCREEN, /confirmLabel="Marcar como revisado"\s*busy=\{actionBusy\}\s*submitOnEnter\s*onConfirm=\{reviewRun\}/);
    assert.doesNotMatch(SCREEN, /initialFocus=\{\(\) => document\.getElementById\(reviewNoteId\)\}/, "focus lands on Confirm so Enter confirms (the note is optional)");
    assert.match(SCREEN, /showToast\(reviewedToast\(updated\), \{ variant: "success" \}\)/);
    assert.match(SCREEN, /onClick=\{\(\) => setReviewTarget\(shownRun\)\}/);
    assert.match(SCREEN, /actionErrorMessage\(err, "No se pudo marcar el cierre como revisado\."\)/, "the 409 of the separation of duties keeps the API copy");
    assert.doesNotMatch(SCREEN, /reviewOpen/);
  });

  it("⌘K: «Marcar el cierre como revisado» only with a run to review; «Abrir cola operativa» only when blocked", () => {
    assert.match(SCREEN, /\.\.\.\(runToReview \? \[\{ id: "night-audit-review", label: "Marcar el cierre como revisado", shortcut: "⌥V"/);
    assert.match(SCREEN, /\.\.\.\(closeAction === "blocked" \? \[\{ id: "night-audit-open-queue", label: OPEN_QUEUE_LABEL, run: \(\) => navigateTo\("FrontDeskDashboard"\)/);
  });

  it("Cocoa 22: no new inline style (4 pre-existing), one live region of its own, no English labels", () => {
    assert.ok((SCREEN.match(/\bstyle=\{/g) ?? []).length <= 4);
    assert.equal((SCREEN.match(/role="status"/g) ?? []).length, 1);
    assert.doesNotMatch(SCREEN, />\s*(Close day|Mark as reviewed|Reopen)\s*</);
  });
});
