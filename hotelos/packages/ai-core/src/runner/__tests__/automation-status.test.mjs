// Tablas de normalización del nivel de automatización (4 vocabularios) y del
// vocabulario de estado de ai_tool_calls.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { AUTOMATION_LEVELS, SAFE_AUTOMATION_LEVEL, isAutomationLevel, normalizeAutomationLevel, toGateLevel } from "../automation.ts";
import { TOOL_CALL_STATUSES, isAwaiting, isSuccess, isTerminalFailure, isToolCallStatus } from "../status.ts";
import { LEGACY_TOOL_NAME_ALIASES, canonicalToolName, isLegacyToolName, legacyToolNameOf } from "../tool-names.ts";

test("normalizeAutomationLevel: tabla de los cuatro vocabularios", () => {
  const table = [
    // registro / property-ai
    ["off", "off"],
    ["suggest", "suggest"],
    ["suggest_and_confirm", "suggest_and_confirm"],
    ["autonomous", "autonomous"],
    // gate de gobernanza
    ["manual", "off"],
    ["confirm", "suggest_and_confirm"],
    // semilla
    ["auto", "autonomous"],
    ["assisted", "suggest"],
    ["manual_confirm", "suggest_and_confirm"],
    // demo-store
    ["manual_only", "off"],
    ["recommend_only", "suggest"],
    ["approve_required", "suggest_and_confirm"],
    ["auto_apply_low_risk", "autonomous"],
    ["auto_apply_all", "autonomous"],
    // tolerancia de formato
    [" Suggest-And-Confirm ", "suggest_and_confirm"],
    ["AUTONOMOUS", "autonomous"]
  ];
  for (const [raw, expected] of table) {
    assert.equal(normalizeAutomationLevel(raw), expected, `«${raw}» → ${expected}`);
  }
});

test("normalizeAutomationLevel: vacío, null y valores desconocidos caen al nivel seguro (nunca a autónomo)", () => {
  assert.equal(SAFE_AUTOMATION_LEVEL, "suggest_and_confirm");
  for (const raw of [null, undefined, "", "   ", "nonsense", "yolo_mode"]) {
    assert.equal(normalizeAutomationLevel(raw), "suggest_and_confirm");
  }
  assert.equal(normalizeAutomationLevel("nonsense", "off"), "off", "el fallback es configurable");
  assert.deepEqual([...AUTOMATION_LEVELS], ["off", "suggest", "suggest_and_confirm", "autonomous"]);
  assert.equal(isAutomationLevel("suggest"), true);
  assert.equal(isAutomationLevel("confirm"), false);
});

test("toGateLevel: manual | suggest | confirm | autonomous (governance.service.ts:163)", () => {
  assert.deepEqual(AUTOMATION_LEVELS.map(toGateLevel), ["manual", "suggest", "confirm", "autonomous"]);
});

test("isSuccess / isAwaiting / isTerminalFailure sobre los 7 estados", () => {
  assert.deepEqual([...TOOL_CALL_STATUSES], ["succeeded", "failed", "pending", "awaiting_confirmation", "rejected", "completed", "skipped"]);
  assert.deepEqual(TOOL_CALL_STATUSES.filter(isSuccess), ["succeeded", "completed"]);
  assert.deepEqual(TOOL_CALL_STATUSES.filter(isAwaiting), ["pending", "awaiting_confirmation"]);
  assert.deepEqual(TOOL_CALL_STATUSES.filter(isTerminalFailure), ["failed", "rejected"]);
  assert.equal(isSuccess("skipped"), false);
  assert.equal(isAwaiting("rejected"), false);
  assert.equal(isSuccess(null), false);
  assert.equal(isToolCallStatus("completed"), true);
  assert.equal(isToolCallStatus("running"), false);
});

test("alias legados de nombre de herramienta", () => {
  assert.deepEqual(LEGACY_TOOL_NAME_ALIASES, { scan_id_document: "extractGuestIdentityFieldsTemporary", guest_message_reply: "answerGuestQuestion", onboarding_mapping_suggest: "suggestRoomTypeMapping" });
  assert.equal(canonicalToolName("scan_id_document"), "extractGuestIdentityFieldsTemporary");
  assert.equal(canonicalToolName(" guest_message_reply "), "answerGuestQuestion");
  assert.equal(canonicalToolName("assignRoom"), "assignRoom");
  assert.equal(isLegacyToolName("onboarding_mapping_suggest"), true);
  assert.equal(isLegacyToolName("assignRoom"), false);
  assert.equal(legacyToolNameOf("answerGuestQuestion"), "guest_message_reply");
  assert.equal(legacyToolNameOf("assignRoom"), null);
});
