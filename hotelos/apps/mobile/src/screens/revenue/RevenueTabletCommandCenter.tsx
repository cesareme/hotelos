import { RevenueScaffold } from "./RevenueScaffold";

export function RevenueTabletCommandCenter() {
  return (
    <RevenueScaffold
      eyebrow="Tablet command center"
      title="Revenue Tablet Command Center"
      summary="Left filters and KPI cards, center forecast graph, right AI insight panel, and bottom detailed table."
      metrics={[
        { label: "Layout", value: "4 zones", detail: "Filters, graph, AI, table" },
        { label: "Charts", value: "8", detail: "Overview through heatmap" },
        { label: "Actions", value: "Export", detail: "PDF, CSV, XLSX, JSON" }
      ]}
      cards={[
        { title: "AI insight panel", status: "contextual", body: "The copilot explains the selected chart using the history-forecast API and does not invent KPIs." }
      ]}
    />
  );
}
