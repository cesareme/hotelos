import { RevenueScaffold } from "./RevenueScaffold";

export function ChannelManagerDashboardScreen() {
  return (
    <RevenueScaffold
      eyebrow="Channel Manager"
      title="Pooled inventory and ARI sync"
      summary="Manage connected channels, mappings, sync jobs, reservation imports, commissions, payment costs and channel profitability."
      metrics={[
        { label: "Booking.com", value: "Synced", detail: "Rates accepted" },
        { label: "Expedia", value: "Error", detail: "Credential expired" },
        { label: "Direct", value: "Open", detail: "Never auto close" }
      ]}
      cards={[
        { title: "Mapping health", status: "visible", body: "Internal room type and rate plan mappings are validated before ARI sync to avoid discrepancies and overbooking." },
        { title: "External reservations", status: "idempotent", body: "OTA imports use external reservation IDs and idempotency keys so retries do not duplicate reservations." }
      ]}
    />
  );
}
