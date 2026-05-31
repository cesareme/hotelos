import { ScreenScaffold } from "./ScreenScaffold";

export function ForecastSettingsScreen() {
  return (
    <ScreenScaffold
      eyebrow="Forecasting"
      title="Forecast Settings"
      summary="Configure forecast signals, dimensions, confidence thresholds, model versions, pickup windows and accuracy monitoring."
      cards={[
        { title: "Signals", status: "ok", body: "Historical reservations, OTB, pickup, cancellations, channel costs, events and competitor rates feed forecasts." },
        { title: "Confidence", metric: "82%", status: "ok", body: "Confidence decreases with missing history, sync issues, manual overrides or competitor data gaps." },
        { title: "Accuracy", metric: "MAE 4.8", status: "warn", body: "Forecast accuracy is visible for the configured comparison period." }
      ]}
    />
  );
}
