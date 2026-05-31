import { RevenueScaffold } from "./RevenueScaffold";

export function RevenueRecommendationsScreen() {
  return (
    <RevenueScaffold
      eyebrow="Recommendations"
      title="Explainable pricing actions"
      summary="Every recommendation shows current value, recommended value, expected impact, confidence, risk, data sources and confirmation state."
      metrics={[
        { label: "Pending", value: "2", detail: "Need review" },
        { label: "Expected lift", value: "EUR 960", detail: "Room revenue" },
        { label: "Profit lift", value: "EUR 710", detail: "After costs" }
      ]}
      cards={[
        { title: "Rate increase: Double Standard", status: "high risk", body: "2026-06-12 Flexible BAR current EUR 138, recommended EUR 154. Reasons: occupancy above 85%, pickup above pace, competitors 9% higher, 6 rooms remaining.", actions: ["Approve", "Reject", "Simulate", "Apply"] },
        { title: "Restriction: 2-night minimum", status: "confirmation", body: "Saturday forecast 94% and Friday forecast 61%. Suggested minimum stay improves Friday pickup and total stay revenue." }
      ]}
    />
  );
}
