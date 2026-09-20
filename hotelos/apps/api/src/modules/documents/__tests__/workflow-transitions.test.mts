// Unit tests · Tanda T9 · lote T9-08 — máquina de estados (§6.1): enumera
// TODAS las celdas de TRANSITIONS, comprueba que cualquier otro par (estado,
// acción) lanza 409 DOCUMENT_STATUS_TRANSITION { from, action } y las guardas
// de banderas (DOCUMENT_BLOCKED, DOCUMENT_LEGAL_HOLD). Sin Postgres, sin red.
// Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/workflow-transitions.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INCOMING_DOCUMENT_STATUSES, type IncomingDocumentStatus } from "@hotelos/shared";
import { HttpError } from "../../../lib/http-error.js";
import {
  ADMIN_FLAG_ACTIONS,
  approveActionOf,
  assertPurgeAllowed,
  assertTransition,
  assertWorkflowAllowed,
  DOCUMENT_WORKFLOW_ACTIONS,
  listTransitions,
  rejectActionOf,
  TRANSITIONS,
  transitionFor,
  type DocumentWorkflowAction
} from "../workflow.service.js";

/** Tabla §6.1 literal (la fuente del test, independiente de la implementación). */
const EXPECTED: Array<[IncomingDocumentStatus, DocumentWorkflowAction, IncomingDocumentStatus]> = [
  ["captured", "send_to_office", "sent_to_office"],
  ["captured", "archive", "archived"],
  ["captured", "split", "captured"],
  ["captured", "merge", "captured"],
  ["sent_to_office", "assign", "in_review"],
  ["sent_to_office", "review", "in_review"],
  ["in_review", "assign", "in_review"], // adición documentada [S]: reasignación sin salir del estado
  ["in_review", "review", "in_review"],
  ["in_review", "approve:create_supplier_bill", "approved"],
  ["in_review", "approve:create_expense", "posted"],
  ["in_review", "approve:create_goods_receipt", "posted"],
  ["in_review", "approve:create_task", "archived"],
  ["in_review", "approve:archive", "archived"],
  ["in_review", "reject:return_to_centre", "returned_to_centre"],
  ["in_review", "reject", "rejected"],
  ["in_review", "split", "in_review"],
  ["in_review", "merge", "in_review"],
  ["approved", "bill_posted", "posted"],
  ["approved", "bill_cancelled", "in_review"],
  ["returned_to_centre", "recapture", "captured"],
  ["returned_to_centre", "archive", "rejected"],
  ["posted", "block", "posted"],
  ["posted", "unblock", "posted"],
  ["posted", "purge", "posted"],
  ["archived", "block", "archived"],
  ["archived", "unblock", "archived"],
  ["archived", "purge", "archived"],
  ["rejected", "block", "rejected"],
  ["rejected", "unblock", "rejected"],
  ["rejected", "purge", "rejected"]
];

function codeOf(error: unknown): string | undefined {
  return error instanceof HttpError ? (error.details as { code?: string } | undefined)?.code : undefined;
}

describe("TRANSITIONS · tabla §6.1", () => {
  it("cubre los 8 estados del catálogo y solo ellos", () => {
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...INCOMING_DOCUMENT_STATUSES].sort());
  });

  it("contiene exactamente las celdas esperadas (ni una más ni una menos)", () => {
    const actual = listTransitions().map(({ from, action, to }) => `${from} --${action}--> ${to}`).sort();
    const expected = EXPECTED.map(([from, action, to]) => `${from} --${action}--> ${to}`).sort();
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, 30);
  });

  it("cada celda esperada resuelve con transitionFor y assertTransition", () => {
    for (const [from, action, to] of EXPECTED) {
      assert.equal(transitionFor(from, action), to, `${from} + ${action}`);
      assert.equal(assertTransition(from, action), to, `${from} + ${action}`);
    }
  });

  it("cualquier otro par (estado, acción) → 409 DOCUMENT_STATUS_TRANSITION con details { from, action }", () => {
    const allowed = new Set(EXPECTED.map(([from, action]) => `${from}|${action}`));
    let checked = 0;
    for (const from of INCOMING_DOCUMENT_STATUSES) {
      for (const action of DOCUMENT_WORKFLOW_ACTIONS) {
        if (allowed.has(`${from}|${action}`)) continue;
        checked += 1;
        assert.equal(transitionFor(from, action), null, `${from} + ${action} debería ser null`);
        assert.throws(
          () => assertTransition(from, action),
          (error: unknown) => {
            assert.ok(error instanceof HttpError, `HttpError esperado para ${from} + ${action}`);
            assert.equal(error.statusCode, 409);
            assert.equal(codeOf(error), "DOCUMENT_STATUS_TRANSITION");
            assert.deepEqual(error.details, { code: "DOCUMENT_STATUS_TRANSITION", from, action });
            return true;
          }
        );
      }
    }
    assert.equal(checked, INCOMING_DOCUMENT_STATUSES.length * DOCUMENT_WORKFLOW_ACTIONS.length - EXPECTED.length);
  });

  it("los estados finales solo admiten las banderas §7.5 (block / unblock / purge), que no cambian el status", () => {
    for (const status of ["posted", "archived", "rejected"] as const) {
      const actions = Object.keys(TRANSITIONS[status]).sort();
      assert.deepEqual(actions, [...ADMIN_FLAG_ACTIONS].sort());
      for (const action of ADMIN_FLAG_ACTIONS) assert.equal(TRANSITIONS[status][action], status);
    }
  });

  it("approveActionOf / rejectActionOf construyen las claves de la tabla", () => {
    assert.equal(approveActionOf("create_supplier_bill"), "approve:create_supplier_bill");
    assert.equal(approveActionOf("archive"), "approve:archive");
    assert.equal(rejectActionOf(true), "reject:return_to_centre");
    assert.equal(rejectActionOf(false), "reject");
    assert.equal(assertTransition("in_review", approveActionOf("create_task")), "archived");
    assert.equal(assertTransition("in_review", rejectActionOf(true)), "returned_to_centre");
  });
});

describe("banderas §7.5", () => {
  const base = { status: "in_review" as IncomingDocumentStatus, blockedAt: null, deletedAt: null, legalHold: false };

  it("bloqueado → 409 DOCUMENT_BLOCKED salvo unblock / purge; purgado → 404 opaco", () => {
    const blocked = { ...base, status: "posted" as const, blockedAt: new Date("2026-09-19T00:00:00.000Z") };
    assert.throws(() => assertWorkflowAllowed(blocked, "review"), (error: unknown) => codeOf(error) === "DOCUMENT_BLOCKED" && (error as HttpError).statusCode === 409);
    assert.doesNotThrow(() => assertWorkflowAllowed(blocked, "unblock"));
    assert.doesNotThrow(() => assertWorkflowAllowed(blocked, "purge"));
    assert.doesNotThrow(() => assertWorkflowAllowed(base, "review"));
    const purged = { ...base, deletedAt: new Date() };
    assert.throws(() => assertWorkflowAllowed(purged, "review"), (error: unknown) => codeOf(error) === "DOCUMENT_NOT_FOUND" && (error as HttpError).statusCode === 404);
  });

  it("purge exige blockedAt y sin legalHold: 409 DOCUMENT_LEGAL_HOLD / 409 DOCUMENT_STATUS_TRANSITION (not_blocked)", () => {
    const held = { ...base, status: "archived" as const, blockedAt: new Date(), legalHold: true };
    assert.throws(() => assertPurgeAllowed(held), (error: unknown) => codeOf(error) === "DOCUMENT_LEGAL_HOLD");
    const notBlocked = { ...base, status: "archived" as const };
    assert.throws(
      () => assertPurgeAllowed(notBlocked),
      (error: unknown) => codeOf(error) === "DOCUMENT_STATUS_TRANSITION" && (error as HttpError).details !== undefined && ((error as HttpError).details as { reason?: string }).reason === "not_blocked"
    );
    assert.doesNotThrow(() => assertPurgeAllowed({ ...base, status: "archived" as const, blockedAt: new Date() }));
    // Bloqueado pero en un estado que no admite purge (in_review) → 409 de la tabla.
    assert.throws(() => assertPurgeAllowed({ ...base, blockedAt: new Date() }), (error: unknown) => codeOf(error) === "DOCUMENT_STATUS_TRANSITION");
  });
});
