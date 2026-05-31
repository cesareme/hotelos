export const HOTEL_OS_ACCENT = "#4f46e5";

export * from "./tokens/index.js";
export * from "./tokens/hotelos-flow.tokens.js";
// Note: ChannelMixChart, ForecastBandChart, RevenueComposedChart live in BOTH
// ./charts and ./components/revenue. The canonical versions used by the app are
// the revenue/ ones — re-export the rest of ./charts/* explicitly here to avoid
// the ambiguous-export TS error.
export type { ChartPoint, ChartSeries } from "./charts/chartPrimitive.js";
export { ChartPrimitive } from "./charts/chartPrimitive.js";
export { RevenueLineChart, revenueLineChartDefaultColor } from "./charts/RevenueLineChart.js";
export { RevenueAreaChart, revenueAreaChartForecastColor } from "./charts/RevenueAreaChart.js";
export { RevenueBarChart, revenueBarChartColor } from "./charts/RevenueBarChart.js";
export { MetricSparkline } from "./charts/MetricSparkline.js";
export { OccupancyHeatmap, occupancyHeatmapHighDemandColor } from "./charts/OccupancyHeatmap.js";
export * from "./components/shared.js";
export * from "./components/revenue/index.js";
export * from "./components/SmartTipCard.js";
export * from "./components/StatusDot.js";
export * from "./components/GlobalSearchCommand.js";
export * from "./components/CommandPalette.js";
export * from "./components/guestJourney/GuestJourneyStepper.js";
export * from "./components/HotelCard.js";
export * from "./components/MetricCard.js";
export * from "./components/StatusChip.js";
export * from "./components/RoomStatusBadge.js";
export * from "./components/ReservationCard.js";
export * from "./components/RoomCard.js";
export * from "./components/RoomOperationalCard.js";
export * from "./components/TaskCard.js";
export * from "./components/ConfirmationCard.js";
export * from "./components/ConfirmationSheet.js";
export * from "./components/ComplianceAlertCard.js";
export * from "./components/AiCommandInput.js";
export * from "./components/CommandDock.js";
export * from "./components/VoiceButton.js";
export * from "./components/CameraActionButton.js";
export * from "./components/TimelineGrid.js";
export * from "./components/timeline/index.js";
export * from "./components/panels/index.js";
export * from "./components/RateGridCell.js";
export * from "./components/IntegrationCard.js";
export * from "./components/ModuleCard.js";
export * from "./components/BottomSheet.js";
export * from "./components/ActionDrawer.js";
export * from "./components/AuditTrailPanel.js";
export * from "./components/SkeletonCard.js";
export * from "./components/EmptyState.js";
export * from "./components/ErrorState.js";
export * from "./components/PermissionGate.js";
export * from "./components/ModuleGate.js";
export * from "./components/RiskBadge.js";
export * from "./components/ConfidenceMeter.js";
