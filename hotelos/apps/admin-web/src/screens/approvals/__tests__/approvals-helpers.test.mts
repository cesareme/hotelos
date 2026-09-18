import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPROVAL_KINDS, APPROVAL_KIND_PERMISSION, APPROVAL_STATUSES, type ApprovalRequestDto } from "@hotelos/shared";

/** The shape `apiRequest` throws (ApiError of services/api-client.ts), built without loading the client (import.meta.env). */
function apiError(message: string, status: number, details?: unknown): Error & { status: number; details?: unknown } {
  return Object.assign(new Error(message), { status, details });
}
import {
  APPROVAL_KIND_LABELS_ES,
  APPROVAL_STATUS_LABELS_ES,
  KIND_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  THRESHOLD_TIER_LABELS_ES,
  approvalErrorMessage,
  approvingKeyOf,
  decisionFor,
  filterApprovals,
  hasApprovalKeys,
  isExpired,
  pendingForViewer,
  secondApproverNote
} from "../approvals-helpers.ts";

function request(overrides: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  return {
    id: "ap1",
    kind: "refund",
    status: "pending",
    entityType: "payment",
    entityId: "pay1",
    propertyId: "p1",
    amount: "120.00",
    currency: "EUR",
    reasonCode: "guest_complaint",
    reasonText: null,
    requestedByUserId: "maker",
    requestedAt: "2026-09-18T08:00:00.000Z",
    decidedByUserId: null,
    decidedAt: null,
    secondApproverUserId: null,
    expiresAt: "2026-09-25T08:00:00.000Z",
    thresholdTier: "T2",
    requiresSecondApproval: false,
    ...overrides
  };
}

describe("approvals-helpers · labels", () => {
  it("names every kind, status and tier in Spanish", () => {
    for (const kind of APPROVAL_KINDS) assert.ok(APPROVAL_KIND_LABELS_ES[kind].length > 2, kind);
    for (const status of APPROVAL_STATUSES) assert.ok(APPROVAL_STATUS_LABELS_ES[status].length > 2, status);
    assert.equal(KIND_FILTER_OPTIONS.length, APPROVAL_KINDS.length);
    assert.equal(STATUS_FILTER_OPTIONS.length, APPROVAL_STATUSES.length);
    assert.match(THRESHOLD_TIER_LABELS_ES.ABOVE_T4, /dirección general/);
    for (const kind of APPROVAL_KINDS) assert.equal(approvingKeyOf(kind), APPROVAL_KIND_PERMISSION[kind]);
  });
});

describe("approvals-helpers · who decides what (dynamic SoD)", () => {
  const checker = { userId: "checker", grantedPermissions: ["payments.refund_approve", "analytics.read"], isPlatformAdmin: false };

  it("the requester never decides their own request (409 APPROVAL_SELF_DECISION explained)", () => {
    const own = decisionFor(request(), { ...checker, userId: "maker" });
    assert.equal(own.canApprove, false);
    assert.equal(own.canReject, false);
    assert.equal(own.own, true);
    assert.match(own.reason ?? "", /Nadie aprueba lo que ha solicitado/);
  });

  it("a holder of the kind's *_approve key decides a pending request; without the key only the reason is shown", () => {
    const yes = decisionFor(request(), checker);
    assert.deepEqual(yes, { canApprove: true, canReject: true, own: false, reason: null });
    const no = decisionFor(request({ kind: "supplier_bill" }), checker);
    assert.equal(no.canApprove, false);
    assert.match(no.reason ?? "", /payables\.approve/);
    const decided = decisionFor(request({ status: "approved" }), checker);
    assert.equal(decided.canApprove, false);
    assert.match(decided.reason ?? "", /ya no admite decisión/);
    assert.equal(decisionFor(request({ kind: "capex" }), { userId: "p", grantedPermissions: [], isPlatformAdmin: true }).canApprove, true);
  });

  it("the second signature above T4 must come from another person", () => {
    const first = request({ requiresSecondApproval: true, thresholdTier: "ABOVE_T4", decidedByUserId: "checker" });
    assert.equal(decisionFor(first, checker).canApprove, false);
    assert.match(decisionFor(first, checker).reason ?? "", /segunda debe darla otra persona/);
    assert.equal(decisionFor(first, { ...checker, userId: "gm" }).canApprove, true);
    assert.match(secondApproverNote(first) ?? "", /falta la segunda/);
    assert.match(secondApproverNote(request({ requiresSecondApproval: true })) ?? "", /dos aprobaciones/);
    assert.match(secondApproverNote(request({ requiresSecondApproval: true, secondApproverUserId: "gm" })) ?? "", /registrada/);
    assert.equal(secondApproverNote(request()), null);
  });

  it("hasApprovalKeys paints the Mi día card only for approvers; pendingForViewer counts what the viewer may decide", () => {
    assert.ok(hasApprovalKeys(["payments.refund_approve"]));
    assert.ok(hasApprovalKeys(["asset.capex.approve"]));
    assert.ok(hasApprovalKeys(["purchase_orders.approve"]));
    assert.ok(!hasApprovalKeys(["payments.refund_request", "folio.adjust"]));
    assert.ok(!hasApprovalKeys(null));
    const rows = [request({ id: "a" }), request({ id: "b", requestedByUserId: "checker" }), request({ id: "c", kind: "payroll" }), request({ id: "d", status: "approved" })];
    assert.deepEqual(pendingForViewer(rows, checker).map((row) => row.id), ["a"]);
  });
});

describe("approvals-helpers · filters, expiry and errors", () => {
  it("filters by status and kind, and detects an expired pending request", () => {
    const rows = [request({ id: "a" }), request({ id: "b", kind: "discount" }), request({ id: "c", status: "rejected" })];
    assert.deepEqual(filterApprovals(rows, { status: "pending", kind: "" }).map((row) => row.id), ["a", "b"]);
    assert.deepEqual(filterApprovals(rows, { status: "", kind: "discount" }).map((row) => row.id), ["b"]);
    assert.ok(isExpired(request({ expiresAt: "2026-09-10T00:00:00.000Z" }), new Date("2026-09-18T00:00:00.000Z")));
    assert.ok(!isExpired(request(), new Date("2026-09-18T00:00:00.000Z")));
    assert.ok(isExpired(request({ status: "expired" })));
    assert.ok(!isExpired(request({ status: "approved", expiresAt: "2000-01-01T00:00:00.000Z" })));
  });

  it("translates the details.code of a failed decision", () => {
    assert.equal(approvalErrorMessage(apiError("x", 409, { code: "APPROVAL_SELF_DECISION" })), "Nadie aprueba lo que ha solicitado.");
    assert.equal(approvalErrorMessage(apiError("x", 409, { code: "APPROVAL_EXPIRED" })), "La aprobación ha caducado.");
    assert.equal(approvalErrorMessage(apiError("x", 409, { code: "APPROVAL_ALREADY_DECIDED" })), "La solicitud ya está decidida.");
    assert.equal(approvalErrorMessage(apiError("x", 403, { code: "RBAC_LEVEL_EXCEEDED" })), "No puedes asignar un rol de nivel superior al tuyo.");
    assert.equal(approvalErrorMessage(apiError("Prohibido", 403)), "No tienes permiso para decidir esta solicitud.");
    assert.equal(approvalErrorMessage(new Error("caída")), "caída");
    assert.equal(approvalErrorMessage(undefined), "No se ha podido registrar la decisión.");
  });
});
