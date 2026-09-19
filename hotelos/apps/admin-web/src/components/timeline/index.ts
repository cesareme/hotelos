// Live Timeline · barrel de los componentes (Tanda TL · lote TL-5).
//
// La pantalla screens/timeline/LiveTimeline.tsx importa de aquí (y solo de
// aquí) los nueve componentes de presentación de los lotes TL-2/TL-3/TL-4 y
// el copy puro de los diálogos. Las piezas internas de la parrilla
// (TimelineRow, TimelineBar, TimelineHeader, TimelineAvailabilityRow,
// TimelineQuickCard, TimelineDragLayer, useTimelineDrag, timeline-presentation)
// no se reexportan: las compone TimelineGrid.

export * from "./TimelineGrid";
export * from "./TimelineDateSelector";
export * from "./TimelineFilterBar";
export * from "./TimelineLegend";
export * from "./TimelineGapAlert";
export * from "./TimelineUndoBar";
export * from "./TimelineInspector";
export * from "./TimelineActionDialog";
export * from "./TimelineCreateDialog";
export { dialogCopy, type DialogCopy, type DialogCopyContext } from "./timeline-dialog-copy";
