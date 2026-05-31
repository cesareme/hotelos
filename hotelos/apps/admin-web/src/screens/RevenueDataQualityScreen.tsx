import { ScreenScaffold } from "./ScreenScaffold";

export function RevenueDataQualityScreen() {
  return (
    <ScreenScaffold
      eyebrow="Data quality"
      title="Revenue Data Quality"
      summary="Recommendations are blocked if critical rate, inventory, mapping, cost, competitor or historical booking data is incomplete."
      cards={[
        { title: "Ready checks", status: "ok", body: "Rate plans, rate days, inventory days and competitor set are seeded." },
        { title: "Warning", status: "warn", body: "Expedia has a failed restriction sync and must be repaired before automation." },
        { title: "Critical blockers", metric: "0", status: "ok", body: "No blocking data-quality gaps in the demo property." }
      ]}
    />
  );
}
