import { ScreenScaffold } from "./ScreenScaffold";

export function RevenueSettingsScreen() {
  return (
    <ScreenScaffold
      eyebrow="Revenue & Profit Engine"
      title="Revenue Settings"
      summary="Configure currency, forecast horizon, pricing horizon, targets, channel costs, commission rules, payment costs and profit-aware constraints."
      cards={[
        { title: "Forecast and pricing horizon", metric: "365 days", status: "ok", body: "Forecasting, pricing and scenario settings are scoped per property." },
        { title: "Profit-aware metrics", metric: "Net RevPAR + GOPPAR", status: "ok", body: "Dashboard optimizes for net revenue and contribution profit, not only gross room revenue." },
        { title: "Approval thresholds", status: "warn", body: "High-impact rate, restriction and channel closeout changes require manager or owner confirmation." }
      ]}
    />
  );
}
