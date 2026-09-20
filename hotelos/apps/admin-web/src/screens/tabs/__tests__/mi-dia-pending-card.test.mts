import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda UX-2 · D5 (docs/design/UX-DIRECCION-FEEL.md F-D8): the header card of
// Mi día reads «Pendientes · N aprobaciones · M de la IA» — N from GET /approvals
// (what the viewer may decide), M from GET /ai-operations/review/stats through
// useApiData (30 s cache, only with `ai_governance.read`) — with a warning
// badge above zero, opens the approvals inbox and, with a second button «IA»,
// the AI review queue. Source contract over MiDiaTabs.tsx (the label itself is
// pure: approvals-primary-action.test.mts covers `pendingCardLabel`).

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const RAW = readFileSync(new URL("../hoy/MiDiaTabs.tsx", import.meta.url), "utf8");
const SOURCE = stripComments(RAW);

describe("MiDiaTabs · «Pendientes · N aprobaciones · M de la IA»", () => {
  it("counts the AI items through useApiData with a 30 s cache, only with ai_governance.read", () => {
    assert.match(SOURCE, /const AI_REVIEW_READ_KEY = "ai_governance\.read";/);
    assert.match(SOURCE, /const aiReader = \(gate\.grantedPermissions \?\? \[\]\)\.includes\(AI_REVIEW_READ_KEY\);/);
    assert.match(SOURCE, /useApiData<ReviewStatsLite>\(aiReader \? "\/ai-operations\/review\/stats" : null, \{\s*query: \{ organizationId: getActiveOrganizationId\(\) \},\s*staleTime: 30000,\s*enabled: aiReader\s*\}\)/);
    assert.doesNotMatch(SOURCE, /pollIntervalMs/);
  });

  it("paints one card with the shared label helper and a warning badge above zero", () => {
    assert.match(SOURCE, /import \{ hasApprovalKeys, pendingCardLabel, pendingCardParts, pendingCardTotal, pendingForViewer, viewerFromProfile \} from "\.\.\/\.\.\/approvals\/approvals-helpers";/);
    assert.match(SOURCE, /const counts = \{ approvals: approver \? count : null, ai: aiReader && aiStats \? aiStats\.pending : null \};/);
    assert.match(SOURCE, /aria-label=\{pendingCardLabel\(counts\)\}/);
    assert.match(SOURCE, /<CocoaBadge tone=\{total > 0 \? "warning" : "neutral"\} size="small" uppercase=\{false\}>\s*\{parts\.join\(" · "\)\}/);
    assert.match(SOURCE, /if \(!approver && !aiReader\) return null;/);
  });

  it("the card opens the approvals inbox; the second button «IA» opens the AI review queue (only for readers)", () => {
    assert.match(SOURCE, /onClick=\{\(\) => navigateTo\("ApprovalsInbox"\)\}/);
    assert.match(SOURCE, /\{aiReader \? \(\s*<CocoaButton[^\n]*onClick=\{\(\) => navigateTo\("AiHumanReviewQueueScreen"\)\}[^\n]*aria-label="Pendientes de la IA"/);
    assert.equal((SOURCE.match(/navigateTo\(/g) ?? []).length, 2);
  });

  it("Cocoa 22: zero inline style; the landing comment tells the truth (direccion → Dirección)", () => {
    assert.equal((RAW.match(/\bstyle=\{/g) ?? []).length, 0);
    assert.match(RAW, /direccion \(and revenue\/finanzas\/comercial\) on Dirección/);
    assert.doesNotMatch(RAW, /Pendientes de aprobación\n/);
  });
});
