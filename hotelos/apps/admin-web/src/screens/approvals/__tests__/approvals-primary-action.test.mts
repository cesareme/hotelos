import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ApprovalRequestDto } from "@hotelos/shared";
import {
  approvalKindNoun,
  approvalReference,
  decisionDialogTitle,
  decisionToast,
  pendingCardLabel,
  pendingCardParts,
  pendingCardTotal,
  primaryDecisionFor
} from "../approvals-helpers.ts";

// Tanda UX-2 · D5 (docs/design/UX-DIRECCION-FEEL.md §1 P1/P2/P4, F-D7): one
// primary «Aprobar» per row, nominal dialog with the amount, Enter confirms
// when the note is optional, ↑↓ move the selection, Enter opens the detail.
// Pure helpers first; then a source contract over ApprovalsScreen.tsx.

/** Intl es-ES separates «€» with U+00A0/U+202F; compare with a plain space. */
const plain = (text: string) => text.replace(/[  ]/g, " ");

function request(overrides: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  return {
    id: "ap_k3m9q2",
    kind: "refund",
    status: "pending",
    entityType: "payment",
    entityId: "pay1",
    propertyId: "p1",
    amount: "60.00",
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

const NOW = new Date("2026-09-20T10:00:00.000Z");
const checker = { userId: "checker", grantedPermissions: ["payments.refund_approve"], isPlatformAdmin: false };

describe("primaryDecisionFor · the one action of a row (P1)", () => {
  it("«Aprobar» for a pending request the viewer may decide", () => {
    assert.equal(primaryDecisionFor(request(), checker, NOW), "approve");
  });

  it("nothing on own, decided, expired or keyless rows (the drawer keeps the reason)", () => {
    assert.equal(primaryDecisionFor(request(), { ...checker, userId: "maker" }, NOW), null);
    assert.equal(primaryDecisionFor(request({ status: "approved" }), checker, NOW), null);
    assert.equal(primaryDecisionFor(request({ status: "rejected" }), checker, NOW), null);
    assert.equal(primaryDecisionFor(request({ expiresAt: "2026-09-19T08:00:00.000Z" }), checker, NOW), null);
    assert.equal(primaryDecisionFor(request({ kind: "supplier_bill" }), checker, NOW), null);
    assert.equal(primaryDecisionFor(request({ requiresSecondApproval: true, decidedByUserId: "checker" }), checker, NOW), null);
  });

  it("the platform admin approves anything pending; the key is read in the hotel of the request (FX-09)", () => {
    assert.equal(primaryDecisionFor(request({ kind: "capex", amount: "900.00" }), { userId: "p", grantedPermissions: [], isPlatformAdmin: true }, NOW), "approve");
    const byProperty = { ...checker, grantedPermissions: [], permissionsByProperty: { p1: ["payments.refund_approve"], p2: [] } };
    assert.equal(primaryDecisionFor(request({ propertyId: "p1" }), byProperty, NOW), "approve");
    assert.equal(primaryDecisionFor(request({ propertyId: "p2" }), byProperty, NOW), null);
  });
});

describe("decisionDialogTitle · nominal, with the amount (P4)", () => {
  it("«Aprobar reembolso de 60,00 €» / «Rechazar ajuste de folio de 25,00 €»; never a question", () => {
    assert.equal(plain(decisionDialogTitle("approve", request())), "Aprobar reembolso de 60,00 €");
    assert.equal(plain(decisionDialogTitle("reject", request({ kind: "folio_adjust", amount: "25.00" }))), "Rechazar ajuste de folio de 25,00 €");
    assert.doesNotMatch(decisionDialogTitle("approve", request()), /[¿?]/);
  });

  it("kinds without amount drop the «de …»; an acronym keeps its case", () => {
    assert.equal(decisionDialogTitle("approve", request({ kind: "day_reopen", amount: null })), "Aprobar reapertura del día");
    assert.equal(plain(decisionDialogTitle("approve", request({ kind: "capex", amount: "900.00" }))), "Aprobar CAPEX de 900,00 €");
    assert.equal(approvalKindNoun("supplier_bill"), "factura de proveedor");
    assert.equal(approvalKindNoun("capex"), "CAPEX");
  });
});

describe("decisionToast · «Aprobada: reembolso 60,00 € · solicitud K3M9Q2»", () => {
  it("names the decision, the kind, the amount and a short reference (never the whole id)", () => {
    assert.equal(plain(decisionToast(request({ status: "approved" }))), "Aprobada: reembolso 60,00 € · solicitud K3M9Q2");
    assert.equal(plain(decisionToast(request({ status: "rejected", kind: "purchase_order", amount: "900.00" }))), "Rechazada: pedido de compra 900,00 € · solicitud K3M9Q2");
    assert.equal(decisionToast(request({ status: "pending", requiresSecondApproval: true, decidedByUserId: "checker" })), "Primera aprobación registrada: falta la segunda · solicitud K3M9Q2");
    assert.equal(decisionToast(request({ status: "approved", kind: "day_reopen", amount: null })), "Aprobada: reapertura del día · solicitud K3M9Q2");
    assert.equal(approvalReference("cmfz8a1b2c3d4e5f6g7h"), "5F6G7H");
    assert.doesNotMatch(decisionToast(request({ status: "approved" })), /ap_k3m9q2/);
  });
});

describe("pendingCardLabel · «Pendientes · N aprobaciones · M de la IA» (Mi día)", () => {
  it("joins the known parts, in Spanish, with the plural of «aprobación»", () => {
    assert.equal(pendingCardLabel({ approvals: 2, ai: 1 }), "Pendientes · 2 aprobaciones · 1 de la IA");
    assert.equal(pendingCardLabel({ approvals: 1, ai: null }), "Pendientes · 1 aprobación");
    assert.equal(pendingCardLabel({ approvals: null, ai: 0 }), "Pendientes · 0 de la IA");
    assert.equal(pendingCardLabel({ approvals: null, ai: null }), "Pendientes");
    assert.deepEqual(pendingCardParts({ approvals: 0, ai: 3 }), ["0 aprobaciones", "3 de la IA"]);
  });

  it("the total drives the warning tone (N + M > 0)", () => {
    assert.equal(pendingCardTotal({ approvals: 2, ai: 1 }), 3);
    assert.equal(pendingCardTotal({ approvals: null, ai: null }), 0);
    assert.equal(pendingCardTotal({ approvals: 0, ai: null }), 0);
  });
});

// ---------------------------------------------------------------- source contract (ApprovalsScreen.tsx)

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const SCREEN = stripComments(readFileSync(new URL("../ApprovalsScreen.tsx", import.meta.url), "utf8"));

/** Source between the `rowActions={(row) => {` opener and the closing `}}` of the prop. */
function rowActionsRegion(source: string): string {
  const start = source.indexOf("rowActions={(row) => {");
  assert.ok(start >= 0, "rowActions on the approvals table");
  const end = source.indexOf("\n          }}", start);
  assert.ok(end > start, "rowActions closes");
  return source.slice(start, end);
}

describe("ApprovalsScreen · one primary per row, always visible (P1)", () => {
  const region = rowActionsRegion(SCREEN);

  it("«Aprobar» is the only filled button of the row, with ⌥A on the selected (or first decidable) row", () => {
    assert.equal((region.match(/variant="filled"/g) ?? []).length, 1);
    assert.match(region, /variant="filled" tone="accent" size="small" accessKey=\{keyed \? "A" : undefined\}/);
    assert.match(region, /\{ACTIONS\.approve\}/);
    assert.match(region, /const keyed = row\.id === \(selected\?\.id \?\? firstDecidable\?\.id\)/);
  });

  it("«Rechazar» is bordered (never a second filled) and rows the viewer cannot decide carry nothing", () => {
    assert.match(region, /variant="bordered" tone="destructive" size="small"[^\n]*\{ACTIONS\.reject\}|variant="bordered" tone="destructive" size="small"/);
    assert.match(region, /const primary = primaryDecisionFor\(row, viewer\);\s*if \(primary === null\) return null;/);
    assert.match(SCREEN, /rowActionsVisible="always"/);
  });

  it("the row buttons open the decision dialog straight away (card → Aprobar → dialog = 3 clicks)", () => {
    assert.match(region, /onClick=\{\(\) => openDecision\(row, "approve"\)\}/);
    assert.match(region, /onClick=\{\(\) => openDecision\(row, "reject"\)\}/);
    assert.doesNotMatch(region, /openDetail\(/);
  });
});

describe("ApprovalsScreen · nominal dialog (P4) and keyboard (P2)", () => {
  it("title and confirm button share the nominal text; Enter confirms when the note is optional; never «¿…?»", () => {
    assert.match(SCREEN, /const dialogTitle = decision && selected \? decisionDialogTitle\(decision, selected\) : ACTIONS\.approve;/);
    assert.match(SCREEN, /title=\{dialogTitle\}/);
    assert.match(SCREEN, /confirmLabel=\{dialogTitle\}/);
    assert.match(SCREEN, /submitOnEnter=\{!noteRequired\}/);
    assert.doesNotMatch(SCREEN, /¿Aprobar|¿Rechazar/);
    assert.match(SCREEN, /showToast\(decisionToast\(updated\), \{ variant: "success" \}\)/);
  });

  it("money waits for the API: no `mutate(`/optimistic path around approve/reject", () => {
    assert.doesNotMatch(SCREEN, /\bmutate\(/);
    assert.match(SCREEN, /await approveRequest\(selected\.id/);
  });

  it("↑↓ move the selection between rows without opening the drawer; Enter/Space (row select) open the detail", () => {
    assert.match(SCREEN, /event\.key !== "ArrowDown" && event\.key !== "ArrowUp"/);
    assert.match(SCREEN, /nextRow\.focus\(\);\s*setSelectedId\(nextData\.id\);/);
    assert.match(SCREEN, /<div onKeyDown=\{moveSelection\}>/);
    assert.match(SCREEN, /onSelect=\{\(row\) => openDetail\(row\.id\)\}/);
    assert.match(SCREEN, /open=\{detailOpen && selected !== null\}/);
  });

  it("⌘K offers the decision as a page command", () => {
    assert.match(SCREEN, /"Aprobar la solicitud seleccionada"/);
    assert.match(SCREEN, /"Rechazar la solicitud seleccionada"/);
    assert.match(SCREEN, /shortcut: "⌥A"/);
  });

  it("Cocoa 22: zero inline style, Spanish labels from ACTIONS", () => {
    assert.equal((SCREEN.match(/\bstyle=\{/g) ?? []).length, 0);
    assert.doesNotMatch(SCREEN, />\s*Approve\s*<|>\s*Reject\s*</);
  });
});
