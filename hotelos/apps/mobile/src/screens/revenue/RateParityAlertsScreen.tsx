import { RevenueScaffold } from "./RevenueScaffold";

export function RateParityAlertsScreen() {
  return (
    <RevenueScaffold
      eyebrow="Parity Monitor"
      title="Rate parity alerts"
      summary="Detect OTA undercutting, direct booking gaps, tax/fee mismatch, currency mismatch and package mismatch."
      metrics={[
        { label: "Open alerts", value: "1", detail: "Critical" },
        { label: "Direct rate", value: "EUR 154", detail: "Official website" },
        { label: "OTA rate", value: "EUR 140", detail: "Booking.com mock" }
      ]}
      cards={[
        { title: "Booking.com cheaper than direct", status: "critical", body: "OTA cheaper by EUR 14 on 2026-06-12. Suggested action: check channel mapping and direct rate plan." }
      ]}
    />
  );
}
