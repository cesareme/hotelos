// CocoaRateGrid v2 — public surface of the rate grid component family.
//
// The screen (lot front-screen) imports everything from here. Wire types
// come from `@hotelos/shared`; the UI contract lives in `./types`.

export { CocoaRateGrid } from "./CocoaRateGrid";
export { CocoaRateGridCell, type CocoaRateGridCellProps, type CellCommitMode, type CellRowKind } from "./CocoaRateGridCell";
export { GridRowView, type GridRowViewProps } from "./CocoaRateGridRows";
export { RateGridHeader } from "./RateGridHeader";
export { RateGridDemandStrip } from "./RateGridDemandStrip";
export { QuickEditPopover, buildRestrictionsPatch } from "./QuickEditPopover";
export { BulkEditSheet } from "./BulkEditSheet";
export { ReviewPublishDrawer } from "./ReviewPublishDrawer";
export { SyncStatusPanel, toSyncMatrixCells, keyToLabel } from "./SyncStatusPanel";
export { HistoryDrawer, HistoryList, historySummary, journalBadgeText } from "./HistoryDrawer";
export { RecommendationPopover } from "./RecommendationPopover";
export { RateGridStatusBar } from "./RateGridStatusBar";
export { RateGridSidePanel, RateGridPopover, TriStateChip, NumericTriChip, WeekdayPicker, Tabs, Field, nextTriState, type AnchorRect } from "./shared-ui";
export { useRateGridDraft, type UseRateGridDraftOptions, type UseRateGridDraftResult } from "./useRateGridDraft";

export * from "./types";
export * from "./helpers";
export * from "./expressions";
export * from "./rate-grid-utils";
export * from "./draft-store";
