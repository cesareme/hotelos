// Unit tests · puerta de preflight del cierre del día (Tanda L5 · L5-D).
// Pure module: no Prisma, no clock. Run from apps/api with
//   node --import tsx --test src/modules/night-audit/__tests__/night-audit-gate.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestError } from "../../../lib/http-error.js";
import {
  FORCE_REASON_MIN_LENGTH,
  FORCE_REASON_REQUIRED_MESSAGE,
  blockedRunMessage,
  decideRunGate,
  preflightBlockers,
  summarizeBlockers
} from "../night-audit-gate.js";

const NO_SHOWS = { id: "unresolved_no_shows", title: "No-shows sin resolver", status: "blocker", count: 2, detail: "2 reservas pasadas siguen confirmadas sin estancia." };
const FOLIOS = { id: "open_folios_with_balance", title: "Folios abiertos con saldo", status: "blocker", count: 13, detail: "13 folios con 764,75 € sin cobrar." };
const ARRIVALS_WARNING = { id: "arrivals_pending", title: "Llegadas pendientes", status: "warning", count: 2, detail: "2 reservas confirmadas sin check-in." };
const INVOICES_FAILED = { id: "invoices_pending", title: "Facturas pendientes", status: "blocker", count: null, detail: "No se pudo comprobar las facturas pendientes: timeout" };

const CLEAN = { canClose: true, checks: [ARRIVALS_WARNING, { ...NO_SHOWS, status: "ok", count: 0 }] };
const BLOCKED = { canClose: false, blockingMessage: "No puedes cerrar todavía: 2 no-shows sin resolver, 13 folios abiertos con saldo.", checks: [ARRIVALS_WARNING, NO_SHOWS, FOLIOS] };

describe("decideRunGate", () => {
  it("allow: no blocker (a warning never blocks); force with nothing to force is still a plain allow", () => {
    assert.deepEqual(decideRunGate(CLEAN, {}), { kind: "allow" });
    assert.deepEqual(decideRunGate(CLEAN, { force: true, reasonText: "motivo suficientemente largo" }), { kind: "allow" });
    assert.deepEqual(decideRunGate(CLEAN, { force: true }), { kind: "allow" }, "nothing to override → no reason needed");
  });

  it("blocked: the blocker checks, in checklist order, with the 409 message", () => {
    const decision = decideRunGate(BLOCKED, {});
    assert.equal(decision.kind, "blocked");
    if (decision.kind !== "blocked") return;
    assert.deepEqual(decision.blockers, [
      { id: "unresolved_no_shows", title: "No-shows sin resolver", count: 2, detail: NO_SHOWS.detail },
      { id: "open_folios_with_balance", title: "Folios abiertos con saldo", count: 13, detail: FOLIOS.detail }
    ]);
    assert.equal(decision.blockingMessage, "No se puede ejecutar el cierre: 2 no-shows sin resolver, 13 folios abiertos con saldo. Resuelve los bloqueos o fuerza el cierre indicando el motivo.");
    assert.equal(decideRunGate(BLOCKED, { force: false, reasonText: "motivo suficientemente largo" }).kind, "blocked", "a reason without force forces nothing");
  });

  it("forced: force + reason (trimmed) keeps the blockers for the audit and the report", () => {
    const decision = decideRunGate(BLOCKED, { force: true, reasonText: "  Reserva histórica sin resolver; cierre acordado con dirección.  " });
    assert.deepEqual(decision, {
      kind: "forced",
      blockers: preflightBlockers(BLOCKED),
      reasonText: "Reserva histórica sin resolver; cierre acordado con dirección."
    });
  });

  it("force without a reason (or shorter than the minimum) → 400 «Indica el motivo para cerrar con bloqueos.»", () => {
    for (const body of [{ force: true }, { force: true, reasonText: "" }, { force: true, reasonText: "   " }, { force: true, reasonText: "x".repeat(FORCE_REASON_MIN_LENGTH - 1) }]) {
      assert.throws(
        () => decideRunGate(BLOCKED, body),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestError, `BadRequestError for ${JSON.stringify(body)}`);
          assert.equal(error.statusCode, 400);
          assert.equal(error.message, FORCE_REASON_REQUIRED_MESSAGE);
          return true;
        }
      );
    }
    assert.equal(decideRunGate(BLOCKED, { force: true, reasonText: "x".repeat(FORCE_REASON_MIN_LENGTH) }).kind, "forced");
  });

  it("fails closed when canClose is false without a blocker check (inconsistent preflight)", () => {
    const decision = decideRunGate({ canClose: false, blockingMessage: "No puedes cerrar todavía: —.", checks: [ARRIVALS_WARNING] }, {});
    assert.equal(decision.kind, "blocked");
    if (decision.kind !== "blocked") return;
    assert.deepEqual(decision.blockers, []);
    assert.equal(decision.blockingMessage, "No se puede ejecutar el cierre: No puedes cerrar todavía: —.");
  });
});

describe("blocker texts", () => {
  it("summarises by lowercase title; a failed count shows «—»", () => {
    assert.equal(summarizeBlockers([NO_SHOWS, FOLIOS]), "2 no-shows sin resolver, 13 folios abiertos con saldo");
    assert.equal(summarizeBlockers([INVOICES_FAILED]), "— facturas pendientes");
    assert.equal(blockedRunMessage([INVOICES_FAILED]), "No se puede ejecutar el cierre: — facturas pendientes. Resuelve los bloqueos o fuerza el cierre indicando el motivo.");
  });

  it("preflightBlockers keeps only the blocker checks, projected to { id, title, count, detail }", () => {
    assert.deepEqual(preflightBlockers({ checks: [ARRIVALS_WARNING, INVOICES_FAILED] }), [{ id: "invoices_pending", title: "Facturas pendientes", count: null, detail: INVOICES_FAILED.detail }]);
    assert.deepEqual(preflightBlockers({ checks: [] }), []);
  });
});
