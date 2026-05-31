import { ScreenScaffold } from "../ScreenScaffold";

export function RevenueExportCenter() {
  return (
    <ScreenScaffold
      eyebrow="Exports"
      title="Revenue Export Center"
      summary="Generate owner-ready PDF visual reports plus CSV, XLSX and JSON exports of the detailed table."
      cards={[
        { title: "PDF visual report", metric: "Charts + table", status: "ready", body: "Page 1 includes KPI cards and main charts; following pages include breakdowns and full report table." },
        { title: "Table exports", metric: "CSV / XLSX / JSON", status: "ready", body: "Exports include filters, report range and generated timestamp." },
        { title: "Audit event", status: "required", body: "Every export writes RevenueHistoryForecastExported with before/after context and correlation id." }
      ]}
    />
  );
}
