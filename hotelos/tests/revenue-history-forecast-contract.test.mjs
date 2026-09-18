import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const repo = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");
const exists = (path) => existsSync(new URL(path, repo));

const schema = read("packages/database/prisma/schema.prisma");
const sharedTypes = read("packages/shared/src/types.ts");
const permissions = read("packages/shared/src/permissions.ts");
const manifest = read("packages/product/src/modules/module-manifest.ts");
const mobileNavigation = read("packages/product/src/navigation/mobile-navigation.ts");
const moduleRoutes = read("apps/mobile/src/navigation/ModuleRoutes.tsx");
const demoStore = read("apps/api/src/lib/demo-store.ts");
const advancedService = read("apps/api/src/modules/advanced/advanced-modules.service.ts");
const server = read("apps/api/src/server.ts");
const routePermissions = read("apps/api/src/security/route-permissions.ts");
const worker = read("apps/worker/src/index.ts");
// Tanda L2 (L2-07 · worker honesto): the catalogue is the four pg-boss queues of scheduler.ts.
const workerScheduler = read("apps/worker/src/scheduler.ts");
// Tanda L2 (L2-03): the History & Forecast board is served by modules/revenue/hf-board.service.ts.
const hfBoardService = read("apps/api/src/modules/revenue/hf-board.service.ts");
const toolNames = read("packages/ai-tools/src/tool-names.ts");
const aiRegistry = read("packages/ai-tools/src/registry.ts");
const uiIndex = read("packages/ui/src/index.ts");
const demoHtml = read("demo/public/index.html");
const demoStyles = read("demo/public/styles.css");

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Revenue Visual Analytics History & Forecast", () => {
  it("adds permissions, module routes and AI tools for history-forecast analytics", () => {
    for (const permission of [
      "revenue.history_forecast.read",
      "revenue.history_forecast.export",
      "revenue.history_forecast.configure",
      "revenue.history_forecast.saved_views.manage",
      "revenue.forecast_confidence.read",
      "revenue.comparison.read",
      "revenue.visual_alerts.read",
      "revenue.scheduled_reports.manage"
    ]) {
      assert.match(sharedTypes, new RegExp(escaped(permission)));
      assert.match(permissions, new RegExp(escaped(permission)));
      assert.match(demoStore, new RegExp(escaped(permission)));
    }
    for (const marker of [
      "RevenueHistoryForecast",
      "RevenueVisualDashboard",
      "RevenueHistoryForecastDashboard",
      "RevenueHistoryForecastReport",
      "RevenueForecastExplorer",
      "RevenueComparisonDashboard",
      "RevenueExportCenter"
    ]) {
      assert.match(manifest + mobileNavigation + moduleRoutes, new RegExp(marker));
    }
    for (const tool of [
      "explainHistoryForecast",
      "compareRevenuePeriods",
      "explainForecastConfidence",
      "createOwnerRevenueReport",
      "detectHistoryForecastRisks"
    ]) {
      assert.match(toolNames, new RegExp(tool));
      assert.match(aiRegistry, new RegExp(tool));
    }
    assert.match(aiRegistry, /"revenue\.history_forecast\.read"/);
    assert.match(aiRegistry, /"revenue\.history_forecast\.export", "medium", true/);
  });

  it("declares snapshot and saved view tables without replacing revenue models", () => {
    // Tanda L2 (L2-01): RevenueReportView (saved views, memory-only, 0 rows) was
    // retired by migration 20260918130000_persistencia_l2.
    for (const model of ["RevenueDailySnapshot", "RevenueForecastSnapshot"]) {
      assert.match(schema, new RegExp(`model ${model}`));
    }
    for (const field of [
      "snapshotDate",
      "forecastDate",
      "totalOcc",
      "arrivalRooms",
      "deductIndividualRooms",
      "nonDeductGroupRooms",
      "occupancyPercent",
      "confidenceLowJson",
      "confidenceHighJson",
      "driversJson"
    ]) {
      assert.match(schema, new RegExp(field));
    }
    assert.match(schema, /@@map\("revenue_daily_snapshots"\)/);
    assert.match(schema, /@@map\("revenue_forecast_snapshots"\)/);
  });

  it("implements the aggregation package with date validation, split logic and weighted totals", () => {
    const aggregator = read("packages/revenue/src/historyForecastAggregator.ts");
    for (const marker of [
      "HistoryForecastAggregationInput",
      "HistoryForecastAggregationOutput",
      "differenceInCalendarDays",
      "History & Forecast requires a period longer than one day.",
      "History & Forecast supports periods lower than 12 months.",
      "2-45 days",
      "resolveHistoryForecastGranularity",
      "splitHistoryForecastByBusinessDate",
      "calculateWeightedSubtotal",
      "do not average daily percentages blindly",
      "averageRate: ratio(roomRevenue, totalOcc)",
      "revpar: ratio(roomRevenue, availableRooms)",
      "trevpar: ratio(totalRevenue, availableRooms)",
      "goppar",
      "Forecast confidence"
    ]) {
      assert.match(aggregator, new RegExp(escaped(marker)));
    }
    assert.equal(exists("packages/revenue/package.json"), true);
    assert.match(read("tsconfig.base.json"), /@hotelos\/revenue/);
  });

  it("exposes protected /revenue/history-forecast endpoints and audited exports", () => {
    for (const route of [
      "/revenue/properties/:propertyId/history-forecast",
      "/revenue/properties/:propertyId/history-forecast/charts",
      "/revenue/properties/:propertyId/history-forecast/kpis",
      "/revenue/properties/:propertyId/history-forecast/export"
    ]) {
      assert.match(server, new RegExp(escaped(route)));
      assert.match(routePermissions, new RegExp(escaped(route)));
    }
    // Tanda L2 (L2-03, corrector): the in-memory getHistoryForecastReport /
    // Charts / Kpis / export were retired; the four GET routes serve the real
    // board (getHistoryForecastBoard over revenue_daily_snapshots +
    // reservations) and the export goes through the Export Center generator.
    // `revenue_report_views` was dropped by 20260918130000_persistencia_l2.
    for (const marker of ["getHistoryForecastBoard", "parseBoardWindow", "writeDailySnapshot", "revenueDailySnapshot", "revenueForecast"]) {
      assert.match(hfBoardService, new RegExp(escaped(marker)));
    }
    assert.match(server, /getHistoryForecastBoard\(params\.propertyId, boardWindow\(request\)\)/);
    assert.match(advancedService, /RevenueHistoryForecastExported/);
    assert.doesNotMatch(advancedService, /getHistoryForecastReport|getHistoryForecastCharts|getHistoryForecastKpis/);
    assert.match(routePermissions, /"revenue\.history_forecast\.read"/);
    assert.match(routePermissions, /"revenue\.history_forecast\.export"/);
  });

  it("creates chart abstractions and revenue UI components", () => {
    for (const file of [
      "RevenueLineChart.tsx",
      "RevenueAreaChart.tsx",
      "RevenueBarChart.tsx",
      "RevenueComposedChart.tsx",
      "ForecastBandChart.tsx",
      "MetricSparkline.tsx",
      "ChannelMixChart.tsx",
      "OccupancyHeatmap.tsx"
    ]) {
      assert.equal(exists(`packages/ui/src/charts/${file}`), true);
    }
    for (const file of [
      "RevenueKpiCard.tsx",
      "RevenueKpiGrid.tsx",
      "HistoryForecastChart.tsx",
      "ForecastBandChart.tsx",
      "RevenueComposedChart.tsx",
      "OccupancyAdrChart.tsx",
      "RevparTreVparGopparChart.tsx",
      "ArrivalsDeparturesChart.tsx",
      "IndividualGroupMixChart.tsx",
      "ChannelMixChart.tsx",
      "RevenueHeatmap.tsx",
      "ForecastConfidenceBadge.tsx",
      "ForecastBoundaryMarker.tsx",
      "RevenueAlertCard.tsx",
      "RevenueReportTable.tsx",
      "RevenueFilterBar.tsx",
      "RevenuePeriodSelector.tsx",
      "RevenueGranularitySelector.tsx",
      "RevenueExportButton.tsx",
      "RevenueSavedViewSelector.tsx"
    ]) {
      assert.equal(exists(`packages/ui/src/components/revenue/${file}`), true);
    }
    assert.match(read("packages/ui/src/charts/chartPrimitive.tsx"), /hotelOSTokens/);
    assert.match(read("packages/ui/src/components/revenue/revenuePrimitives.tsx"), /hotelOSTokens/);
    assert.match(uiIndex, /components\/revenue\/index/);
    // The chart components are re-exported individually from the package
    // root (rather than via a single ./charts/index barrel) so that the
    // duplicate names with ./components/revenue/* can be disambiguated.
    assert.match(uiIndex, /\.\/charts\/(chartPrimitive|RevenueLineChart|RevenueAreaChart|RevenueBarChart|MetricSparkline|OccupancyHeatmap)/);
  });

  it("adds mobile, tablet and admin screens for visual-first analytics", () => {
    for (const path of [
      "apps/mobile/src/screens/revenue/RevenueHistoryForecastScreen.tsx",
      "apps/mobile/src/screens/revenue/RevenueVisualDashboardScreen.tsx",
      "apps/mobile/src/screens/revenue/RevenueKPIDetailScreen.tsx",
      "apps/mobile/src/screens/revenue/RevenueForecastGraphScreen.tsx",
      "apps/mobile/src/screens/revenue/RevenueReportTableScreen.tsx",
      "apps/mobile/src/screens/revenue/RevenueTabletCommandCenter.tsx",
      "apps/admin-web/src/screens/revenue/RevenueHistoryForecastDashboard.tsx",
      "apps/admin-web/src/screens/revenue/RevenueHistoryForecastReport.tsx",
      "apps/admin-web/src/screens/revenue/RevenueForecastExplorer.tsx",
      "apps/admin-web/src/screens/revenue/RevenueComparisonDashboard.tsx",
      "apps/admin-web/src/screens/revenue/RevenueExportCenter.tsx"
    ]) {
      assert.equal(exists(path), true);
    }
    const adminFiles = readdirSync(new URL("../apps/admin-web/src/screens/revenue", import.meta.url)).join("\n");
    assert.match(adminFiles, /RevenueHistoryForecastDashboard/);
    assert.match(read("apps/admin-web/src/App.tsx"), /RevenueHistoryForecastDashboard/);
    // Sidebar label is "Histórico y previsión" (Spanish) but the screen key
    // RevenueHistoryForecastDashboard is what the test really cares about.
    // Tanda 5 · L1b: the sidebar renders nav-tree.generated.json (labels live there).
    assert.match(read("apps/admin-web/src/navigation/Sidebar.tsx") + read("apps/admin-web/src/navigation/nav-tree.generated.json"), /Histórico y previsión|History and Forecast/);
    assert.match(read("apps/mobile/src/screens/revenue/RevenueHistoryForecastScreen.tsx"), /Chart selector tabs|Overview|RevenueReportTable|ForecastBoundaryMarker/);
  });

  it("adds visual browser demo, classic table structure, worker jobs and documentation markers", () => {
    for (const marker of [
      "History & Forecast",
      "Main History vs Forecast graph",
      "Revenue graph",
      "Occupancy + ADR chart",
      "RevPAR / TRevPAR / GOPPAR graph",
      "Arrivals/departures graph",
      "Individual vs group graph",
      "Channel mix chart",
      "Forecast confidence chart",
      "Occupancy heatmap",
      "History subtotal",
      "Forecast subtotal",
      "Date",
      "Total Occ.",
      "Arr. Rooms",
      "Comp. Rooms",
      "House Use",
      "Deduct Indiv.",
      "Non-Ded. Indiv.",
      "Deduct Group",
      "Non-Ded. Group",
      "Occ. %",
      "Total Revenue",
      "Average Rate",
      "Dep. Rooms",
      "Day Use Rooms",
      "No Show Rooms",
      "OOO Rooms",
      "Adl. & Chl."
    ]) {
      assert.match(demoHtml, new RegExp(escaped(marker)));
    }
    for (const style of ["revenue-chart-grid", "mock-chart", "revenue-report-table", "forecast-boundary"]) {
      assert.match(demoStyles, new RegExp(style));
    }
    // Tanda L2 (L2-07 · worker honesto): the scaffolded history/forecast job
    // names were retired from the worker; the daily snapshot is written by the
    // API scheduler (hf-board.service.ts · writeYesterdayDailySnapshotsForAllProperties)
    // and the worker catalogue is the four real pg-boss queues.
    assert.match(hfBoardService, /export async function writeYesterdayDailySnapshotsForAllProperties/);
    assert.match(server, /writeYesterdayDailySnapshotsForAllProperties/);
    for (const queue of ["notifications.scheduled", "notifications.retry", "notifications.sending-sweep", "webhooks.deliver"]) {
      assert.match(workerScheduler, new RegExp(`"${escaped(queue)}"`));
    }
    assert.doesNotMatch(worker + workerScheduler, /generateRevenueDailySnapshots|generateScheduledHistoryForecastReports/);
  });
});
