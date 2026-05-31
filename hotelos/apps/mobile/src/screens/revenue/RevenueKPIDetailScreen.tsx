import { RevenueScaffold } from "./RevenueScaffold";

export function RevenueKPIDetailScreen() {
  return (
    <RevenueScaffold
      eyebrow="KPI detail"
      title="Weighted Revenue KPIs"
      summary="ADR, occupancy, RevPAR, TRevPAR, GOPPAR and Net RevPAR use weighted formulas for the selected period."
      metrics={[
        { label: "ADR", value: "€137.52", detail: "Room revenue / sold rooms" },
        { label: "RevPAR", value: "€94.33", detail: "Room revenue / available rooms" },
        { label: "GOPPAR", value: "€54.13", detail: "Gross operating profit / available rooms" }
      ]}
      cards={[
        { title: "Not a naive average", status: "ok", body: "Period totals never average daily percentages blindly; they recalculate from summed counts and revenue." },
        { title: "Comparison", status: "ready", body: "Supports none, previous period, same period last year and custom period comparison." }
      ]}
    />
  );
}
