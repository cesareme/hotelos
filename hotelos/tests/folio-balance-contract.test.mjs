import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// Sprint 46 — shared folio-balance helper contract.
//
// The helper lives in apps/api and imports @hotelos/database at module load, so
// it cannot be imported directly from an uncompiled .mjs test (the repo runs
// `node --test tests/*.test.mjs` against TypeScript sources). We therefore:
//   1. statically assert the helper's public API + canonical formula exist, and
//   2. re-implement the pure reduce logic here and exercise the arithmetic
//      contracts (the part the helper guarantees) against concrete fixtures.

const helper = readFileSync(
  new URL("../apps/api/src/modules/folio/folio-balance.service.ts", import.meta.url),
  "utf8"
);
const guestPortal = readFileSync(
  new URL("../apps/api/src/modules/guest-portal/guest-portal.service.ts", import.meta.url),
  "utf8"
);
const frontDesk = readFileSync(
  new URL("../apps/api/src/modules/dashboards/front-desk.service.ts", import.meta.url),
  "utf8"
);
const propertyOverview = readFileSync(
  new URL("../apps/api/src/modules/dashboards/property-overview.service.ts", import.meta.url),
  "utf8"
);
const portfolio = readFileSync(
  new URL("../apps/api/src/modules/dashboards/portfolio.service.ts", import.meta.url),
  "utf8"
);

// --- Reference implementation mirroring folio-balance.service.ts ------------
function round2(value) {
  return Math.round(value * 100) / 100;
}

// Mirror of computeFolioBalance / computeReservationBalance reduce.
function computeBreakdown({ chargesTotal = 0, paymentsTotal = 0, refundsTotal = 0, currency = "EUR" }) {
  const c = round2(chargesTotal);
  const p = round2(paymentsTotal);
  const r = round2(refundsTotal);
  return {
    chargesTotal: c,
    paymentsTotal: p,
    refundsTotal: r,
    balanceDue: round2(c - p + r),
    currency
  };
}

// Mirror of computeBalancesForReservations reduce: build a Map<reservationId, balanceDue>.
function computeBalancesForReservations(reservationIds, perReservationTotals) {
  const result = new Map();
  for (const id of new Set(reservationIds)) result.set(id, 0);
  for (const [id, t] of Object.entries(perReservationTotals)) {
    if (!result.has(id)) continue;
    result.set(id, round2((t.chargesTotal ?? 0) - (t.paymentsTotal ?? 0) + (t.refundsTotal ?? 0)));
  }
  return result;
}

describe("Folio-balance shared helper contract (Sprint 46)", () => {
  it("exposes the documented public API", () => {
    assert.match(helper, /export\s+async\s+function\s+computeFolioBalance\s*\(\s*folioId:\s*string\s*\)/);
    assert.match(helper, /export\s+async\s+function\s+computeReservationBalance\s*\(/);
    assert.match(helper, /export\s+async\s+function\s+computeBalancesForReservations\s*\(/);
    // Breakdown shape.
    for (const field of ["chargesTotal", "paymentsTotal", "refundsTotal", "balanceDue", "currency"]) {
      assert.match(helper, new RegExp(field));
    }
  });

  it("uses the canonical formula: charges - payments + refunds", () => {
    // The helper must compute balanceDue as chargesTotal - paymentsTotal + refundsTotal.
    assert.match(helper, /chargesTotal\s*-\s*paymentsTotal\s*\+\s*refundsTotal/);
    // Payments must be captured only.
    assert.match(helper, /status:\s*"captured"/);
    // Currency must fall back to EUR.
    assert.match(helper, /DEFAULT_CURRENCY\s*=\s*"EUR"/);
  });

  it("the batched version avoids N+1 (fixed query budget)", () => {
    // One folio query, one folioLine groupBy, one payment query, one refund groupBy.
    assert.match(helper, /prisma\.folio\.findMany/);
    assert.match(helper, /prisma\.folioLine\.groupBy/);
    assert.match(helper, /prisma\.payment\.findMany/);
    assert.match(helper, /prisma\.paymentRefund\.groupBy/);
    // Reductions happen in memory via Maps, not per-folio queries.
    assert.match(helper, /folioIdsByReservation/);
    // No prisma call inside a for/forEach over reservations or folios.
    assert.doesNotMatch(helper, /for\s*\([^)]*\)\s*\{[^}]*await\s+prisma/s);
  });

  it("arithmetic: chargesTotal - paymentsTotal + refundsTotal = balanceDue", () => {
    const b = computeBreakdown({ chargesTotal: 300, paymentsTotal: 200, refundsTotal: 50 });
    assert.equal(b.chargesTotal, 300);
    assert.equal(b.paymentsTotal, 200);
    assert.equal(b.refundsTotal, 50);
    assert.equal(b.balanceDue, 150); // 300 - 200 + 50
  });

  it("empty folio -> balanceDue 0 and EUR currency", () => {
    const b = computeBreakdown({});
    assert.equal(b.chargesTotal, 0);
    assert.equal(b.paymentsTotal, 0);
    assert.equal(b.refundsTotal, 0);
    assert.equal(b.balanceDue, 0);
    assert.equal(b.currency, "EUR");
  });

  it("fully-paid folio -> balanceDue 0", () => {
    const b = computeBreakdown({ chargesTotal: 420.5, paymentsTotal: 420.5, refundsTotal: 0 });
    assert.equal(b.balanceDue, 0);
  });

  it("refund re-opens the owed amount", () => {
    // Charged 100, paid 100 (balance 0), then refunded 40 -> guest owes 40 again.
    const b = computeBreakdown({ chargesTotal: 100, paymentsTotal: 100, refundsTotal: 40 });
    assert.equal(b.balanceDue, 40);
  });

  it("batched version returns a Map keyed by reservationId, every id present", () => {
    const ids = ["res-a", "res-b", "res-c"];
    const totals = {
      "res-a": { chargesTotal: 200, paymentsTotal: 50, refundsTotal: 0 }, // 150
      "res-b": { chargesTotal: 100, paymentsTotal: 100, refundsTotal: 0 } // 0 (fully paid)
      // res-c has no folios -> defaults to 0
    };
    const map = computeBalancesForReservations(ids, totals);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 3);
    assert.equal(map.get("res-a"), 150);
    assert.equal(map.get("res-b"), 0);
    assert.equal(map.get("res-c"), 0);
  });
});

describe("Folio-balance consumers rewired (Sprint 46)", () => {
  it("guest-portal getGuestReservationView no longer hardcodes balance 0", () => {
    assert.match(guestPortal, /import\s*\{\s*computeReservationBalance\s*\}\s*from\s*"\.\.\/folio\/folio-balance\.service\.js"/);
    assert.match(guestPortal, /computeReservationBalance\(reservation\.id\)/);
    // The old hardcoded placeholder must be gone.
    assert.doesNotMatch(guestPortal, /const\s+balanceDue\s*=\s*0\s*;/);
  });

  it("dashboards use the batched helper instead of inline folio groupBy", () => {
    for (const [name, src] of [
      ["front-desk", frontDesk],
      ["property-overview", propertyOverview],
      ["portfolio", portfolio]
    ]) {
      assert.match(src, new RegExp("computeBalancesForReservations"), `${name} should call the batched helper`);
      // Inline payment groupBy for balance must be removed from the consumer.
      assert.doesNotMatch(
        src,
        /status:\s*"captured"\s*\}\s*,\s*_sum:\s*\{\s*amount/s,
        `${name} should not recompute captured payment sums inline`
      );
    }
  });
});
