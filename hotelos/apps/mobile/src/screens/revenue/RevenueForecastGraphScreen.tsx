import { RevenueScaffold } from "./RevenueScaffold";

export function RevenueForecastGraphScreen() {
  return (
    <RevenueScaffold
      eyebrow="Forecast graph"
      title="Forecast Confidence"
      summary="Forecast lines show confidence bands, drivers and the business-date boundary between history and forecast."
      metrics={[
        { label: "Confidence", value: "76%", detail: "Weighted by available rooms" },
        { label: "Low confidence date", value: "29/05", detail: "Slow pickup + OOO impact" },
        { label: "Drivers", value: "3", detail: "Pace, events, channel health" }
      ]}
      cards={[
        { title: "History vs Forecast", status: "split", body: "History is solid, forecast is dashed, and the confidence band is visible around forecast points." }
      ]}
    />
  );
}
