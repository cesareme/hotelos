import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Tanda UX-2 · D5 (docs/design/UX-DIRECCION-FEEL.md §1 P1/P4, F-D8): the AI review
// row carries only «Aprobar» (tinted, one click) and «Rechazar»; «Asignar a mí» /
// «Escalar» live in the drawer footer; toasts name the item type. Corrector
// UX2-REV-04: «Aprobar» is a DEFERRED COMMIT (row → «Aprobada» + CocoaUndoBar;
// the POST leaves on expiry, unmount or beforeunload; «Deshacer» cancels it —
// the API has no reopen route). Source contract + the pure toast helper; the
// controller itself is unit-tested in ai-review-deferred.test.mts.
// Merge with Tanda L6b (L6b-09): the label of the primary comes from
// `approveLabel(item)` — «Aprobar» (ACTIONS.approve) for every review-only item,
// «Aprobar y ejecutar» for an `ai_tool_call` item, which goes to POST
// /ai/tool-calls/:id/confirm instead of the deferred commit.
// The module reaches services/api-client → `import.meta.env` (Vite): same hook
// as reservation-primary-action.test.mts.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { actionToast, approveLabel } = await import("../AiHumanReviewQueueScreen.tsx");
const { ACTIONS } = await import("../../../content/actions.ts");
const { AI_TOOL_CALL_ACTION_LABELS } = await import("../ai-review-labels.ts");

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const RAW = readFileSync(new URL("../AiHumanReviewQueueScreen.tsx", import.meta.url), "utf8");
const SCREEN = stripComments(RAW);

function region(source: string, from: string, until: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `region start: ${from}`);
  const end = source.indexOf(until, start + from.length);
  assert.ok(end > start, `region end: ${until}`);
  return source.slice(start, end);
}

describe("actionToast · names the decision and the type of the item", () => {
  it("«Aprobada: Recomendación de tarifa» · «Rechazada: …» · «Escalada: …» · «Asignada: …»", () => {
    assert.equal(actionToast("approve-x", { reviewType: "rate_recommendation" }), "Aprobada: Recomendación de tarifa");
    assert.equal(actionToast("reject-x", { reviewType: "invoice_issue" }), "Rechazada: Incidencia de factura");
    assert.equal(actionToast("escalate-x", { reviewType: "review_response" }), "Escalada: Respuesta a una reseña");
    assert.equal(actionToast("assign-x", { reviewType: "email_reservation" }), "Asignada: Reserva por correo electrónico");
    assert.equal(actionToast("other", { reviewType: "channel_overbooking" }), "Hecho: Channel overbooking");
  });
});

describe("approveLabel · «Aprobar» for the queue, «Aprobar y ejecutar» for an ai_tool_call item (UX-2 P1 × L6b-09)", () => {
  it("falls back to ACTIONS.approve and names the execution only for the runner's items", () => {
    assert.equal(ACTIONS.approve, "Aprobar");
    assert.equal(approveLabel({ relatedEntityType: "rate_plan", relatedEntityId: "rp_1" }), ACTIONS.approve);
    assert.equal(approveLabel({}), ACTIONS.approve);
    assert.equal(approveLabel({ relatedEntityType: "ai_tool_call", relatedEntityId: "" }), ACTIONS.approve, "without a row id nothing executes");
    assert.equal(approveLabel({ relatedEntityType: "ai_tool_call", relatedEntityId: "cmu_tool_call_1" }), AI_TOOL_CALL_ACTION_LABELS.approve);
    assert.equal(AI_TOOL_CALL_ACTION_LABELS.approve, "Aprobar y ejecutar");
  });

  it("an ai_tool_call item is decided through the confirm route, never through the deferred commit or the queue's approve/reject", () => {
    assert.match(SCREEN, /const approve = \(item: ReviewItem, withNotes: boolean\) => \{\s*if \(isAiToolCallReview\(item\)\) return decideToolCall\(item, "approve"\);/);
    assert.match(SCREEN, /isAiToolCallReview\(item\) \? decideToolCall\(item, "reject"\) : runAction\(`\/ai-operations\/review\/\$\{item\.id\}\/reject`/);
    assert.match(SCREEN, /await confirmToolCall\(toolCallId, decision, /);
  });
});

describe("AiHumanReviewQueueScreen · row = «Aprobar» (tinted) + «Rechazar», always visible (P1)", () => {
  const row = region(SCREEN, "rowActions={(item) => {", "\n        }}");

  it("exactly two buttons per pending row; the primary is the only tinted one and schedules the approval on one click", () => {
    assert.equal((row.match(/<CocoaButton/g) ?? []).length, 2);
    assert.equal((row.match(/variant="tinted"/g) ?? []).length, 1);
    assert.equal((row.match(/variant="filled"/g) ?? []).length, 0);
    assert.match(row, /variant="tinted" tone="accent" size="small" loading=\{isRunning\("approve", item\.id\)\}[^\n]*onClick=\{\(\) => void approve\(item, false\)\}/);
    // L6b-09: the label is `approveLabel(item)` = ACTIONS.approve unless the item is an `ai_tool_call` («Aprobar y ejecutar»).
    assert.match(row, /\{approveLabel\(item\)\}/);
    assert.doesNotMatch(row, /approveLabel\(selected\)/);
    assert.match(row, /\{ACTIONS\.reject\}/);
    assert.match(row, /if \(decided\) return null;/);
    assert.match(SCREEN, /rowActionsVisible="always"/);
  });

  it("«Asignar» and «Escalar» left the row for the drawer footer", () => {
    assert.doesNotMatch(row, /ACTIONS\.assign\b|ACTIONS\.assignToMe|ACTIONS\.escalate/);
    const footer = region(SCREEN, "<CocoaDrawer", "\n      >");
    assert.match(footer, /\{ACTIONS\.assignToMe\}/);
    assert.match(footer, /\{ACTIONS\.escalate\}/);
    assert.match(footer, /\{ACTIONS\.reject\}/);
    assert.match(footer, /\{approveLabel\(selected\)\}/);
    assert.equal((footer.match(/variant="filled"/g) ?? []).length, 1);
    const decisionForm = region(SCREEN, '<CocoaFormSection title="Decisión"', "</CocoaFormSection>");
    assert.doesNotMatch(decisionForm, /actions=\{/);
  });

  it("deferred commit (UX2-REV-04): «Aprobar» schedules, the row reads «Aprobada», the undo bar is the announcement", () => {
    // RAW: the header comment cites the `/ai-operations/review/*` routes and the stripper reads that `/*` as a block comment.
    assert.match(RAW, /import \{ DEFERRED_APPROVAL_NOTE, createDeferredCommit, type DeferredApproval, type DeferredCommitReason \} from "\.\/ai-review-deferred";/);
    assert.match(SCREEN, /const approve = \(item: ReviewItem, withNotes: boolean\) => \{[\s\S]*?return deferredCommit\.schedule\(item, withNotes && notes \? \{ notes \} : \{\}\);\s*\};/);
    assert.doesNotMatch(SCREEN, /runAction\(`\/ai-operations\/review\/\$\{item\.id\}\/approve`/, "the approve POST never goes through runAction (immediate)");
    // The only approve POST lives in the deferred `post`, with keepalive when the screen is leaving.
    assert.equal((SCREEN.match(/\/ai-operations\/review\/\$\{item\.id\}\/approve/g) ?? []).length, 1);
    assert.match(SCREEN, /await apiRequest\(`\/ai-operations\/review\/\$\{item\.id\}\/approve`, \{ method: "POST", body, keepalive: reason === "unload" \|\| reason === "unmount" \}\);/);
    // Row view: the pending approval reads «Aprobada» (local mapping, nothing in the cache) so rowActions returns null for it.
    assert.match(SCREEN, /rawItems\.map\(\(item\) => \(item\.id === deferred\.item\.id \? \{ \.\.\.item, status: "approved" as ReviewStatus \} : item\)\)/);
    // Undo bar: memoised entry (a new object would restart the countdown every render), undo cancels, dismiss/expiry sends.
    assert.match(SCREEN, /const undoEntry = useMemo<CocoaUndoEntry \| null>\(/);
    assert.match(SCREEN, /note: DEFERRED_APPROVAL_NOTE/);
    assert.match(SCREEN, /<CocoaUndoBar\s+entry=\{undoEntry\}\s+onUndo=\{\(\) => \{\s*deferredCommit\.undo\(\);\s*\}\}\s+onDismiss=\{\(\) => void deferredCommit\.expire\(\)\}\s*\/>/);
    // Flush on unmount and on beforeunload: a pending approval is never lost.
    assert.match(SCREEN, /window\.addEventListener\("beforeunload", onBeforeUnload\);/);
    assert.match(SCREEN, /void deferredCommit\.flush\("unload"\);/);
    assert.match(SCREEN, /void deferredCommit\.flush\("unmount"\);/);
    // One live region of its own: the feedback callout is static (CocoaLiveRegion announces it) and the bar is the change's status.
    assert.equal((SCREEN.match(/role="status"/g) ?? []).length, 0);
    assert.equal((SCREEN.match(/<CocoaLiveRegion/g) ?? []).length, 1);
    assert.match(SCREEN, /showToast\(actionToast\(key, item\), \{ variant: "success" \}\)/);
    assert.match(SCREEN, /showToast\(actionToast\(`approve-\$\{item\.id\}`, item\), \{ variant: "success" \}\)/);
    assert.doesNotMatch(SCREEN, /"Revisión aprobada"|"Revisión rechazada"/);
  });

  it("⌘K approves the selected pending proposal; Cocoa 22 budget of inline styles unchanged (10)", () => {
    assert.match(SCREEN, /"Aprobar la propuesta seleccionada"/);
    assert.equal((RAW.match(/\bstyle=\{/g) ?? []).length, 10);
  });
});
