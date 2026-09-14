// Unit tests for the SES.HOSPEDAJES cancellation → baja pure core (Tanda 3 close · ses-cancel):
//   * selectGuestRegisterRecordsForSesBaja — which partes get a baja when a
//     reservation is cancelled / no-shows, why the others are skipped, and the
//     order-aware rule for a parte re-registered after an accepted baja;
//   * groupSesHistoryByRecord — the history each parte is judged on;
//   * guestRegisterStatusForSesOutcome — parte status mirrored per outcome and
//     TipoComunicacion (accepted baja → annulled, accepted alta → accepted);
//   * deriveGuestRegisterStatusFromSesHistory — reconciliation from history.
// Pure-core only: no database, no env. Run from apps/api with
//   node --import tsx --test src/modules/compliance/__tests__/ses-cancellation.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupSesHistoryByRecord, selectGuestRegisterRecordsForSesBaja, type SesBajaCandidate } from "../compliance.service.js";
import {
  deriveGuestRegisterStatusFromSesHistory,
  guestRegisterStatusForSesOutcome,
  SES_BAJA_BLOCKING_STATUSES,
  SES_BAJA_DONE_STATUSES,
  SES_BAJA_PENDING_STATUSES,
  SES_BAJA_TYPE,
  type SesHistoryEntry
} from "../ses-submission.service.js";

const entry = (submissionType: string, status: SesHistoryEntry["status"]): SesHistoryEntry => ({ submissionType, status });
const candidate = (recordId: string, ...submissions: SesHistoryEntry[]): SesBajaCandidate => ({ recordId, submissions });

// ───────────────────────────────────────────── selection of partes to revoke

describe("selectGuestRegisterRecordsForSesBaja", () => {
  it("queues a baja for a parte whose alta the MIR accepted", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_alta", entry("alta", "accepted"))]);
    assert.deepEqual(plan, { queue: ["grr_alta"], skipped: [] });
  });

  it("queues a baja when the last accepted comunicación is a modificación", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_mod", entry("alta", "accepted"), entry("modificacion", "accepted"))]);
    assert.deepEqual(plan.queue, ["grr_mod"]);
  });

  it("skips partes the MIR never accepted (no history, in-flight, rejected or failed alta)", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([
      candidate("grr_none"),
      candidate("grr_queued", entry("alta", "queued")),
      candidate("grr_sent", entry("alta", "sent")),
      candidate("grr_rejected", entry("alta", "rejected")),
      candidate("grr_failed", entry("alta", "failed"))
    ]);
    assert.deepEqual(plan.queue, []);
    assert.deepEqual(
      plan.skipped.map((s) => s.reason),
      ["not_communicated", "not_communicated", "not_communicated", "not_communicated", "not_communicated"]
    );
  });

  it("skips a parte whose baja was already accepted (nothing left to revoke)", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_done", entry("alta", "accepted"), entry("baja", "accepted"))]);
    assert.deepEqual(plan, { queue: [], skipped: [{ recordId: "grr_done", reason: "baja_accepted" }] });
  });

  it("skips a parte whose baja is queued, sent, retrying or failed (the row is retried, never duplicated)", () => {
    for (const status of ["queued", "sent", "retrying", "failed"] as const) {
      const plan = selectGuestRegisterRecordsForSesBaja([candidate(`grr_${status}`, entry("alta", "accepted"), entry("baja", status))]);
      assert.deepEqual(plan, { queue: [], skipped: [{ recordId: `grr_${status}`, reason: "baja_pending" }] }, status);
    }
  });

  it("queues a new baja when the only previous baja was rejected by the MIR", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_retry", entry("alta", "accepted"), entry("baja", "rejected"))]);
    assert.deepEqual(plan.queue, ["grr_retry"]);
  });

  it("is idempotent: once the baja is queued a second cancellation queues nothing", () => {
    const first = selectGuestRegisterRecordsForSesBaja([candidate("grr_a", entry("alta", "accepted"))]);
    assert.deepEqual(first.queue, ["grr_a"]);
    const second = selectGuestRegisterRecordsForSesBaja([candidate("grr_a", entry("alta", "accepted"), entry("baja", "queued"))]);
    assert.deepEqual(second.queue, []);
    assert.deepEqual(second.skipped, [{ recordId: "grr_a", reason: "baja_pending" }]);
  });

  it("decides per parte: a reservation with several partes revokes only the communicated ones without a baja", () => {
    // Mirrors RES-00084 in the local demo: two partes, one already revoked.
    const plan = selectGuestRegisterRecordsForSesBaja([
      candidate("grr_c47ef1f2", entry("alta", "accepted"), entry("modificacion", "accepted")),
      candidate("grr_ddf743a7", entry("alta", "accepted"), entry("alta", "accepted"), entry("modificacion", "accepted"), entry("baja", "accepted")),
      candidate("grr_missing_data")
    ]);
    assert.deepEqual(plan.queue, ["grr_c47ef1f2"]);
    assert.deepEqual(plan.skipped, [
      { recordId: "grr_ddf743a7", reason: "baja_accepted" },
      { recordId: "grr_missing_data", reason: "not_communicated" }
    ]);
  });

  it("does not treat an accepted baja as a registration", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_only_baja", entry("baja", "accepted"))]);
    assert.deepEqual(plan.skipped, [{ recordId: "grr_only_baja", reason: "not_communicated" }]);
  });

  it("keeps the blocking statuses in sync with the pipeline (only rejected leaves room for a new baja)", () => {
    assert.equal(SES_BAJA_TYPE, "baja");
    assert.deepEqual([...SES_BAJA_BLOCKING_STATUSES].sort(), ["accepted", "annulled", "failed", "queued", "retrying", "sent"]);
    assert.ok(!SES_BAJA_BLOCKING_STATUSES.includes("rejected"));
    // done + pending partition the blocking set (no status in both, none missing).
    assert.deepEqual([...SES_BAJA_DONE_STATUSES].sort(), ["accepted", "annulled"]);
    assert.deepEqual([...SES_BAJA_PENDING_STATUSES].sort(), ["failed", "queued", "retrying", "sent"]);
    assert.deepEqual([...SES_BAJA_DONE_STATUSES, ...SES_BAJA_PENDING_STATUSES].sort(), [...SES_BAJA_BLOCKING_STATUSES].sort());
  });
});

// ───────────────────────────────────────────── re-registration after a baja (order matters)

describe("selectGuestRegisterRecordsForSesBaja · re-registration", () => {
  it("queues a baja again when an alta was accepted AFTER an accepted baja (manual annulment, then re-registered)", () => {
    // RES-00084 shape once the annulled guest checks in again: the MIR holds the new alta.
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_again", entry("alta", "accepted"), entry("baja", "accepted"), entry("alta", "accepted"))]);
    assert.deepEqual(plan, { queue: ["grr_again"], skipped: [] });
  });

  it("skips when the re-registration was revoked too", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([
      candidate("grr_twice", entry("alta", "accepted"), entry("baja", "accepted"), entry("alta", "accepted"), entry("baja", "accepted"))
    ]);
    assert.deepEqual(plan, { queue: [], skipped: [{ recordId: "grr_twice", reason: "baja_accepted" }] });
  });

  it("does not count a rejected re-registration: the accepted baja still stands", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_rej", entry("alta", "accepted"), entry("baja", "accepted"), entry("alta", "rejected"))]);
    assert.deepEqual(plan.skipped, [{ recordId: "grr_rej", reason: "baja_accepted" }]);
  });

  it("agrees with the reconciliation mapping on who the MIR holds", () => {
    const registered: SesHistoryEntry[] = [entry("alta", "accepted"), entry("baja", "accepted"), entry("alta", "accepted")];
    const revoked: SesHistoryEntry[] = [entry("alta", "accepted"), entry("baja", "accepted")];
    assert.equal(deriveGuestRegisterStatusFromSesHistory(registered), "accepted");
    assert.deepEqual(selectGuestRegisterRecordsForSesBaja([candidate("r", ...registered)]).queue, ["r"]);
    assert.equal(deriveGuestRegisterStatusFromSesHistory(revoked), "annulled");
    assert.deepEqual(selectGuestRegisterRecordsForSesBaja([candidate("v", ...revoked)]).queue, []);
  });

  it("keeps an in-flight or failed baja blocking even when a later modificación was accepted (the row is retried, never duplicated)", () => {
    for (const status of ["queued", "sent", "retrying", "failed"] as const) {
      const plan = selectGuestRegisterRecordsForSesBaja([candidate(`grr_${status}`, entry("alta", "accepted"), entry("baja", status), entry("modificacion", "accepted"))]);
      assert.deepEqual(plan.skipped, [{ recordId: `grr_${status}`, reason: "baja_pending" }], status);
    }
  });

  it("ignores an earlier rejected baja regardless of position", () => {
    const plan = selectGuestRegisterRecordsForSesBaja([candidate("grr_r", entry("alta", "accepted"), entry("baja", "rejected"), entry("modificacion", "accepted"))]);
    assert.deepEqual(plan.queue, ["grr_r"]);
  });
});

// ───────────────────────────────────────────── history grouping

describe("groupSesHistoryByRecord", () => {
  it("keeps the input order per parte and lists partes without history with an empty array", () => {
    const rows = [
      { guestRegisterRecordId: "b", submissionType: "alta", status: "accepted" as const },
      { guestRegisterRecordId: "a", submissionType: "alta", status: "accepted" as const },
      { guestRegisterRecordId: "b", submissionType: "baja", status: "queued" as const }
    ];
    const grouped = groupSesHistoryByRecord(["a", "b", "c"], rows);
    assert.deepEqual([...grouped.keys()], ["a", "b", "c"]);
    assert.deepEqual(grouped.get("a"), [entry("alta", "accepted")]);
    assert.deepEqual(grouped.get("b"), [entry("alta", "accepted"), entry("baja", "queued")]);
    assert.deepEqual(grouped.get("c"), []);
  });

  it("drops rows of partes that are not listed (another reservation's history never leaks in)", () => {
    const grouped = groupSesHistoryByRecord(["a"], [{ guestRegisterRecordId: "z", submissionType: "alta", status: "accepted" }]);
    assert.deepEqual([...grouped.entries()], [["a", []]]);
  });

  it("feeds the selection so a mixed reservation revokes exactly the partes the MIR holds", () => {
    const grouped = groupSesHistoryByRecord(
      ["held", "revoked", "never"],
      [
        { guestRegisterRecordId: "held", submissionType: "alta", status: "accepted" },
        { guestRegisterRecordId: "revoked", submissionType: "alta", status: "accepted" },
        { guestRegisterRecordId: "revoked", submissionType: "baja", status: "accepted" }
      ]
    );
    const plan = selectGuestRegisterRecordsForSesBaja([...grouped].map(([recordId, submissions]) => ({ recordId, submissions })));
    assert.deepEqual(plan.queue, ["held"]);
    assert.deepEqual(plan.skipped, [
      { recordId: "revoked", reason: "baja_accepted" },
      { recordId: "never", reason: "not_communicated" }
    ]);
  });
});

// ───────────────────────────────────────────── outcome → parte status

describe("guestRegisterStatusForSesOutcome", () => {
  it("leaves the parte annulled after an accepted baja, accepted after an accepted alta or modificación", () => {
    assert.equal(guestRegisterStatusForSesOutcome(entry("baja", "accepted")), "annulled");
    assert.equal(guestRegisterStatusForSesOutcome(entry("alta", "accepted")), "accepted");
    assert.equal(guestRegisterStatusForSesOutcome(entry("modificacion", "accepted")), "accepted");
  });

  it("maps the other outcomes regardless of the TipoComunicacion", () => {
    for (const type of ["alta", "modificacion", "baja"]) {
      assert.equal(guestRegisterStatusForSesOutcome(entry(type, "rejected")), "rejected", type);
      assert.equal(guestRegisterStatusForSesOutcome(entry(type, "failed")), "failed", type);
      assert.equal(guestRegisterStatusForSesOutcome(entry(type, "annulled")), "annulled", type);
      assert.equal(guestRegisterStatusForSesOutcome(entry(type, "queued")), "queued", type);
      assert.equal(guestRegisterStatusForSesOutcome(entry(type, "sent")), "submitted", type);
      assert.equal(guestRegisterStatusForSesOutcome(entry(type, "retrying")), "submitted", type);
    }
  });
});

// ───────────────────────────────────────────── reconciliation from history

describe("deriveGuestRegisterStatusFromSesHistory", () => {
  it("returns null without history (nothing to reconcile)", () => {
    assert.equal(deriveGuestRegisterStatusFromSesHistory([]), null);
  });

  it("annuls a parte whose alta was accepted and later revoked by an accepted baja", () => {
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "accepted"), entry("modificacion", "accepted"), entry("baja", "accepted")]), "annulled");
  });

  it("keeps the parte accepted when the baja was rejected or failed (the MIR still holds the guest)", () => {
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "accepted"), entry("baja", "rejected")]), "accepted");
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "accepted"), entry("baja", "failed")]), "accepted");
  });

  it("lets an in-flight comunicación own the parte until the MIR answers", () => {
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "accepted"), entry("baja", "queued")]), "queued");
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "accepted"), entry("baja", "sent")]), "submitted");
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "accepted"), entry("baja", "accepted"), entry("alta", "retrying")]), "submitted");
  });

  it("takes the newest outcome when nothing was ever accepted", () => {
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "rejected")]), "rejected");
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "rejected"), entry("alta", "failed")]), "failed");
  });

  it("registers the guest again when an alta is accepted after a baja", () => {
    assert.equal(deriveGuestRegisterStatusFromSesHistory([entry("alta", "accepted"), entry("baja", "accepted"), entry("alta", "accepted")]), "accepted");
  });
});
