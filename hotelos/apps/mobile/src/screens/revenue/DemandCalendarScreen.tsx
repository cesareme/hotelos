import { RevenueScaffold } from "./RevenueScaffold";

export function DemandCalendarScreen() {
  return (
    <RevenueScaffold
      eyebrow="Demand Calendar"
      title="Future demand signals"
      summary="Events, compression dates, holidays, market movement, competitor shifts and low-demand risks feed forecasting and recommendations."
      metrics={[
        { label: "High impact", value: "1", detail: "Madrid design congress" },
        { label: "Compression", value: "High", detail: "2026-06-12 to 2026-06-14" },
        { label: "Forecast confidence", value: "82%", detail: "Data quality acceptable" }
      ]}
      cards={[
        { title: "Madrid design congress", status: "high demand", body: "Expected room compression. AI recommends reviewing rate increases and length-of-stay restrictions." },
        { title: "Low demand watch", status: "info", body: "No severe low-demand dates in the seeded horizon." }
      ]}
    />
  );
}
