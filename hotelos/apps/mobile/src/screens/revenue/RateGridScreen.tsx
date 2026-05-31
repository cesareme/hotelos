import { RevenueScaffold } from "./RevenueScaffold";

export function RateGridScreen() {
  return (
    <RevenueScaffold
      eyebrow="Rate Grid"
      title="Stacked mobile rate cards"
      summary="Mobile avoids giant spreadsheets. Each date card exposes price, availability, stop sell, min stay, CTA, CTD, manual override and sync status."
      metrics={[
        { label: "2026-06-12", value: "EUR 138", detail: "6 available, synced" },
        { label: "2026-06-13", value: "EUR 154", detail: "3 available, pending sync" },
        { label: "Min stay", value: "1", detail: "AI suggests 2" }
      ]}
      cards={[
        { title: "Bulk edit protected", status: "confirmation", body: "Bulk rate and restriction updates require preview, min/max checks, manual override checks and confirmation." },
        { title: "Apply recommendation", status: "blocked if unhealthy", body: "Do not push channels if mapping is incomplete or channel sync health is unhealthy." }
      ]}
    />
  );
}
