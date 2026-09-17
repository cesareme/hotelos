// Cocoa 22 · barrel of the primitives (COCOA-22.md §8).
//
// Screens import from "../../components/cocoa" and nothing else: no `.bo-*`,
// no raw <button>/<table>/<input>, no literal colours (tests/cocoa-22-contract).

export * from "./cocoa-tones";
export * from "./cocoa-viewport";
export * from "./cocoa-overlay";
export * from "./cocoa-page-commands";
export * from "./cocoa-chart-math";

export * from "./CocoaButton";
export * from "./CocoaCard";
export * from "./CocoaPageHeader";
export * from "./CocoaPage";
export * from "./CocoaGrid";
export * from "./CocoaKpi";
export * from "./CocoaSection";
export * from "./CocoaBadge";
export * from "./CocoaCallout";
export * from "./CocoaKbd";
export * from "./CocoaLiveRegion";
export * from "./CocoaState";
export * from "./CocoaStat";
export * from "./CocoaField";
export * from "./CocoaInput";
export * from "./CocoaSelect";
export * from "./CocoaSwitch";
export * from "./CocoaDatePicker";
export * from "./CocoaStepper";
export * from "./CocoaFileInput";
export * from "./CocoaSearchInput";
export * from "./CocoaSegmentedControl";
export * from "./CocoaTable";
export * from "./CocoaScrollArea";
export * from "./CocoaToolbar";
export * from "./CocoaPopover";
export * from "./CocoaSheet";
export * from "./CocoaDrawer";
export * from "./CocoaDialog";
export * from "./CocoaToast";
export * from "./CocoaActionBar";
export * from "./CocoaChart";
export * from "./CocoaSplitView";
export * from "./CocoaSidebar";
export * from "./CocoaRouteTabs";

// Sibling kit that Cocoa 22 keeps as-is (§8): the degraded helpers.
export { DegradedValue, DegradedNote, DegradedCard, DegradedBanner, isDegraded, DEGRADED_HINT, type DegradedLabel, type DegradedList } from "../cocoa-extras/DegradedValue";
