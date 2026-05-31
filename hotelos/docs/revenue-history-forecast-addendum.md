# Revenue Visual Analytics + History & Forecast

This addendum extends `revenue_profit_engine`, `channel_manager`, `hotel_intelligence_platform` and `owner_mode` without changing the existing HotelOS architecture.

## Scope

- Visual History & Forecast dashboard for periods longer than one day and lower than twelve months.
- Business-date split: history is `date <= businessDate`, forecast is `date > businessDate`.
- KPI cards, History vs Forecast chart, revenue chart, occupancy + ADR chart, RevPAR/TRevPAR/GOPPAR chart, arrivals/departures chart, individual/group mix, channel mix, forecast confidence and occupancy heatmap.
- Detailed report table matching the classic History and Forecast layout with History, History subtotal, Forecast, Forecast subtotal and Total rows.
- PDF, CSV, XLSX and JSON export contract with audit event `RevenueHistoryForecastExported`.

## Data

New incremental models:

- `RevenueDailySnapshot`
- `RevenueForecastSnapshot`
- `RevenueReportView`

The aggregation logic lives in `packages/revenue/src/historyForecastAggregator.ts`.

Totals use weighted formulas:

- `ADR = roomRevenue / soldRooms`
- `Occupancy = occupiedRooms / availableRooms`
- `RevPAR = roomRevenue / availableRooms`
- `TRevPAR = totalRevenue / availableRooms`
- `GOPPAR = grossOperatingProfit / availableRooms`

Daily percentages are never averaged blindly for period totals.

## API

- `GET /revenue/properties/:propertyId/history-forecast`
- `GET /revenue/properties/:propertyId/history-forecast/charts`
- `GET /revenue/properties/:propertyId/history-forecast/kpis`
- `POST /revenue/properties/:propertyId/history-forecast/export`

All routes are permission-protected through `route-permissions.ts`.

## Permissions

- `revenue.history_forecast.read`
- `revenue.history_forecast.export`
- `revenue.history_forecast.configure`
- `revenue.history_forecast.saved_views.manage`
- `revenue.forecast_confidence.read`
- `revenue.comparison.read`
- `revenue.visual_alerts.read`
- `revenue.scheduled_reports.manage`

## UI

Chart abstractions live in `packages/ui/src/charts`. Revenue components live in `packages/ui/src/components/revenue`.

Mobile screens:

- `RevenueHistoryForecastScreen`
- `RevenueVisualDashboardScreen`
- `RevenueKPIDetailScreen`
- `RevenueForecastGraphScreen`
- `RevenueReportTableScreen`
- `RevenueTabletCommandCenter`

Admin screens:

- `RevenueHistoryForecastDashboard`
- `RevenueHistoryForecastReport`
- `RevenueForecastExplorer`
- `RevenueComparisonDashboard`
- `RevenueExportCenter`

## AI Rules

AI can explain and compare the report using real data from `/revenue/properties/:propertyId/history-forecast`.
AI must not invent KPIs, and owner-report exports require confirmation because they create audited output.
