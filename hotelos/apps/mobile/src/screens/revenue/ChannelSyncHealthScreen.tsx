import { RevenueScaffold } from "./RevenueScaffold";

export function ChannelSyncHealthScreen() {
  return (
    <RevenueScaffold
      eyebrow="Sync Health"
      title="Distribution error inbox"
      summary="Failed ARI pushes, stale mappings, retryable errors and blocked automation are surfaced before revenue actions execute."
      metrics={[
        { label: "Failed pushes", value: "1", detail: "Expedia restrictions" },
        { label: "Pending pushes", value: "1", detail: "Saturday rates" },
        { label: "Retry queue", value: "Safe", detail: "No stale rate push" }
      ]}
      cards={[
        { title: "Credential expired", status: "critical", body: "Reconnect Expedia before pushing restrictions or auto-applying recommendations." }
      ]}
    />
  );
}
