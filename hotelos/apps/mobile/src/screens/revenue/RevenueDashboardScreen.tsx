import { RevenueScaffold } from "./RevenueScaffold";

export function RevenueDashboardScreen() {
  return (
    <RevenueScaffold
      eyebrow="Revenue & Profit Engine"
      title="Commercial command center"
      summary="AI briefing combines forecast, pickup, pace, channel sync health, parity alerts and profit-aware recommendations."
      metrics={[
        { label: "Occupancy forecast", value: "89%", detail: "Weekend compression" },
        { label: "ADR", value: "EUR 142", detail: "Forecast blended" },
        { label: "RevPAR", value: "EUR 126", detail: "Room revenue" },
        { label: "TRevPAR", value: "EUR 156", detail: "Total revenue" },
        { label: "GOPPAR", value: "EUR 72", detail: "Profit-aware" },
        { label: "Net RevPAR", value: "EUR 118", detail: "After channel costs" }
      ]}
      cards={[
        { title: "AI revenue briefing", status: "confidence 82%", body: "Pickup is faster than pace for 2026-06-12. Competitor median is EUR 161 and direct is under parity pressure.", actions: ["Generate recommendations", "Ask why RevPAR changed"] },
        { title: "Channel sync health", status: "attention", body: "Booking.com is synced. Expedia restrictions failed because credentials expired. Mapping health is visible before any ARI push." },
        { title: "Parity alert", status: "critical", body: "Booking.com cheaper than direct website by EUR 14 on 2026-06-12. Check mapping and direct rate plan." }
      ]}
    />
  );
}
