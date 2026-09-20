// SES.Hospedajes · the detail drawer polls with the shared pending set (Cocoa 22 · ola 11 · R3).
//
// The API treats «sent» as an open submission (apps/api/src/modules/compliance/
// ses-submission.service.ts SES_OPEN_STATUSES = queued · sent · retrying) and the
// screen paints it as a warning; the drawer used to keep its own set without
// «sent», so a submission in that state stopped polling every 8 s and `pending`
// was false. Now the screen reuses SUBMISSION_PENDING_STATUSES of fiscal-shared.
//
// Run from apps/api with
//   TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test ../admin-web/src/screens/compliance/__tests__/ses-hospedajes-pending-statuses.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBMISSION_PENDING_STATUSES } from "../../fiscal/fiscal-shared";

const here = dirname(fileURLToPath(import.meta.url));
const screen = readFileSync(join(here, "..", "SesHospedajesSettingsScreen.tsx"), "utf8");

describe("SES.Hospedajes · estados pendientes del drawer", () => {
  it("imports the shared pending set instead of keeping its own", () => {
    // Named import from fiscal-shared (siblings allowed: the corrector L8 added the simulator helpers to the same statement).
    assert.match(screen, /import \{ (?:[A-Za-z_]+, )*SUBMISSION_PENDING_STATUSES(?:, [A-Za-z_]+)* \} from "\.\.\/fiscal\/fiscal-shared";/);
    assert.match(screen, /const PENDING_STATUSES = SUBMISSION_PENDING_STATUSES;/);
    assert.doesNotMatch(screen, /const PENDING_STATUSES = new Set\(/, "the screen must not redefine the pending statuses");
  });

  it("keeps polling (pollWhile) and flags pending with that set", () => {
    assert.match(screen, /pollWhile: \(d\) => PENDING_STATUSES\.has\(/);
    assert.match(screen, /const pending = Boolean\(sub && PENDING_STATUSES\.has\(sub\.status\)\);/);
  });

  it("«sent» is pending (the API keeps it open) and the terminal states are not", () => {
    for (const open of ["queued", "sent", "submitting", "retrying", "network_error", "pending"]) {
      assert.ok(SUBMISSION_PENDING_STATUSES.has(open), `«${open}» debería seguir sondeándose`);
    }
    for (const closed of ["accepted", "accepted_with_warnings", "rejected", "failed", "abandoned", "annulled"]) {
      assert.ok(!SUBMISSION_PENDING_STATUSES.has(closed), `«${closed}» no es pendiente`);
    }
  });

  it("the screen still paints «sent» as a warning and never lets it be retried by hand", () => {
    assert.match(screen, /\["queued", "retrying", "submitting", "pending", "network_error", "sent"\]\.includes\(status\)\) return "warning";/);
    assert.match(screen, /const RETRYABLE = new Set\(\["rejected", "retrying", "network_error", "failed", "abandoned"\]\);/);
  });
});
