import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const checkInFlowDir = new URL("../apps/mobile/src/screens/ai/checkin/", import.meta.url);
const tokensJson = readFileSync(new URL("../design-tokens/hotelos.tokens.json", import.meta.url), "utf8");
const tokensTs = readFileSync(new URL("../packages/ui/src/tokens/index.ts", import.meta.url), "utf8");
const uiIndex = readFileSync(new URL("../packages/ui/src/index.ts", import.meta.url), "utf8");
const sharedComponents = readFileSync(new URL("../packages/ui/src/components/shared.tsx", import.meta.url), "utf8");
const hotelTabs = readFileSync(new URL("../apps/mobile/src/navigation/HotelOSTabs.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../apps/mobile/App.tsx", import.meta.url), "utf8");
const todayScreen = readFileSync(new URL("../apps/mobile/src/screens/today/TodayDashboardScreen.tsx", import.meta.url), "utf8");
const aiScreen = readFileSync(new URL("../apps/mobile/src/screens/AICommandCenterScreen.tsx", import.meta.url), "utf8");
const mobilePlanningScreen = readFileSync(new URL("../apps/mobile/src/screens/rooms/MobilePlanningScreen.tsx", import.meta.url), "utf8");
const tabletPlanningScreen = readFileSync(new URL("../apps/mobile/src/screens/rooms/TabletPlanningScreen.tsx", import.meta.url), "utf8");
const roomDetailBottomSheet = readFileSync(new URL("../apps/mobile/src/screens/rooms/RoomDetailBottomSheet.tsx", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("../demo/public/index.html", import.meta.url), "utf8");
const demoCss = readFileSync(new URL("../demo/public/styles.css", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/front_ui_implementation_addendum.md", import.meta.url), "utf8");
const figmaStructure = readFileSync(new URL("../figma/figma_file_structure.md", import.meta.url), "utf8");
const checkInFlowData = readFileSync(new URL("checkInFlowData.ts", checkInFlowDir), "utf8");

describe("HotelOS Aurora frontend UI layer", () => {
  it("adds code and Figma-ready design tokens", () => {
    for (const marker of ["HotelOS Aurora Design System", "nightBlue", "deepIndigo", "electricBlue", "violet", "motion", "breakpoints"]) {
      assert.match(tokensJson + tokensTs, new RegExp(marker));
    }
    assert.match(uiIndex, /tokens\/index/);
  });

  it("exports the required Aurora component set", () => {
    for (const component of [
      "HotelCard",
      "MetricCard",
      "StatusChip",
      "RoomOperationalCard",
      "ConfirmationSheet",
      "CommandDock",
      "ComplianceAlertCard",
      "SkeletonCard",
      "EmptyState",
      "ErrorState",
      "PermissionGate",
      "ModuleGate",
      "RiskBadge",
      "ConfidenceMeter"
    ]) {
      assert.equal(existsSync(new URL(`../packages/ui/src/components/${component}.tsx`, import.meta.url)), true);
      assert.match(sharedComponents + uiIndex, new RegExp(component));
    }
  });

  it("uses Aurora navigation and flagship mobile screens", () => {
    for (const label of ["Hoy", "Timeline", "IA", "Operaciones", "Mas"]) {
      assert.match(hotelTabs, new RegExp(label));
    }
    assert.match(app, /HotelOSTabs/);
    assert.match(todayScreen, /AI daily briefing|Action queue|Rooms readiness/);
    assert.match(aiScreen, /CommandDock/);
    assert.match(aiScreen, /CHECK_IN_GUEST/);
    assert.match(aiScreen, /RiskBadge/);
    assert.match(aiScreen, /ConfidenceMeter/);
  });

  it("upgrades rooms and planning surfaces for mobile and tablet", () => {
    assert.match(mobilePlanningScreen, /RoomOperationalCard/);
    assert.match(mobilePlanningScreen, /Compliance pending/);
    assert.match(mobilePlanningScreen, /RoomDetailBottomSheet/);
    assert.match(roomDetailBottomSheet, /ConfirmationCard/);
    assert.match(roomDetailBottomSheet, /Room block requires confirmation/);
    assert.match(tabletPlanningScreen, /Rooms x dates/);
    assert.match(tabletPlanningScreen, /RateGridCell/);
    assert.match(demoHtml + demoCss, /room-operational-list/);
  });

  it("adds the flagship voice check-in screen sequence", () => {
    let screenSource = "";
    for (const screen of [
      "VoiceCommandScreen",
      "DocumentScanScreen",
      "OcrReviewScreen",
      "ReservationMatchScreen",
      "RoomValidationScreen",
      "CheckInConfirmationScreen",
      "GuestSignatureScreen",
      "CheckInSuccessScreen"
    ]) {
      const file = readFileSync(new URL(`${screen}.tsx`, checkInFlowDir), "utf8");
      screenSource += file;
      assert.equal(existsSync(new URL(`${screen}.tsx`, checkInFlowDir)), true);
      assert.match(file, new RegExp(screen));
      assert.match(file, /CheckInFlowScaffold/);
    }

    for (const marker of ["ID_IMAGE_DISCARDED", "imageStored: false", "imageDiscarded: true", "SES.HOSPEDAJES", "checkInSteps"]) {
      assert.match(checkInFlowData + aiScreen + demoHtml + screenSource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("updates the browser demo and handoff docs for Aurora", () => {
    assert.match(demoHtml, /AI Command Dock/);
    assert.match(demoHtml, /AI command interpretation/);
    assert.match(demoHtml, /Voice check-in screens/);
    assert.match(demoCss, /flow-storyboard/);
    assert.match(demoCss, /--primary-dark: #0b1026/);
    assert.match(demoCss, /--violet: #7c3aed/);
    assert.match(demoCss, /--command-shadow/);
    assert.match(docs, /HotelOS Aurora/);
    assert.match(figmaStructure, /00 - Foundations/);
    assert.match(figmaStructure, /07 - Dev Handoff/);
  });
});
