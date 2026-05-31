import { ScreenScaffold } from "./ScreenScaffold";

export function ChannelManagerSettingsScreen() {
  return (
    <ScreenScaffold
      eyebrow="Channel Manager"
      title="Channel Manager Settings"
      summary="Manage pooled inventory, channel connections, ARI sync, reservation imports, webhook handling, idempotency and retry safety."
      cards={[
        { title: "Connected channels", metric: "3", status: "ok", body: "Direct, Booking.com mock and Expedia mock are visible with status and costs." },
        { title: "Pooled inventory", status: "ok", body: "Availability is centralized and pushed to channels instead of manually split by channel." },
        { title: "Sync safety", status: "warn", body: "No disabled channel, incomplete mapping or stale rate is pushed." }
      ]}
    />
  );
}
